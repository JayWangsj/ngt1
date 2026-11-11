import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 as winPath } from "node:path";
import { Readable } from "node:stream";
import { emitApplicationDiagnostic } from "@/lib/app-diagnostics";
import {
  isSameOriginRequest,
  isSameOriginWriteRequest,
} from "@/lib/request-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const clientFailureTimes: number[] = [];
const memorySampleRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readMemorySampleStatus(managerRoot: string, requestId?: string) {
  const path = requestId
    ? join(
        managerRoot,
        "state",
        "runtime",
        "memory-sampling",
        "requests",
        `${requestId}.json`,
      )
    : join(managerRoot, "state", "runtime", "memory-sampling", "latest.json");
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024
    )
      return null;
    let status = JSON.parse(await readFile(path, "utf8")) as {
      requestId?: unknown;
      taskId?: unknown;
      expiresAtUtc?: unknown;
      phase?: unknown;
      reportPath?: unknown;
      reportAvailability?: unknown;
    };
    if (
      typeof status.requestId !== "string" ||
      typeof status.phase !== "string" ||
      typeof status.expiresAtUtc !== "string"
    )
      return null;
    if (requestId && typeof status.taskId === "string") {
      const latest = await readMemorySampleStatus(managerRoot);
      status =
        latest?.taskId &&
        latest.taskId === status.taskId &&
        latest.requestId !== requestId
          ? { ...latest, requestId }
          : status;
    }
    const expiresAtUtc = status.expiresAtUtc;
    if (
      typeof expiresAtUtc !== "string" ||
      Date.parse(expiresAtUtc) <= Date.now()
    )
      return null;
    if (
      typeof status.reportPath === "string" &&
      typeof status.taskId === "string" &&
      /^[0-9]{8}T[0-9]{6}Z-[0-9a-f-]{36}$/i.test(status.taskId)
    ) {
      const expectedName = `NGTManager-memory-sample-${status.taskId}.txt`;
      const report = status.reportPath;
      const parent = winPath.dirname(report);
      if (
        winPath.isAbsolute(report) &&
        winPath.basename(report) === expectedName &&
        winPath.basename(parent) === "memory-samples" &&
        winPath.basename(winPath.dirname(parent)) === "NGTManager"
      ) {
        try {
          const file = await lstat(report);
          status.reportAvailability =
            file.isFile() &&
            !file.isSymbolicLink() &&
            file.size <= 5 * 1024 * 1024
              ? "available"
              : "unavailable";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            try {
              status.reportAvailability = (await stat(parent)).isDirectory()
                ? "moved"
                : "unavailable";
            } catch {
              status.reportAvailability = "unavailable";
            }
          } else {
            status.reportAvailability = "unavailable";
          }
        }
      } else {
        status.reportAvailability = "unavailable";
      }
    }
    return status;
  } catch {
    return null;
  }
}

async function startMemorySample(executable: string, requestId: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["memory-sample-start", requestId], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error("memory_sample_start_timeout"));
    }, 15_000);
    timer.unref();
    child.stderr?.on("data", (chunk: Buffer) => {
      if (capturedBytes >= 2048) return;
      const kept = chunk.subarray(0, 2048 - capturedBytes);
      chunks.push(kept);
      capturedBytes += kept.length;
    });
    child.once("error", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error("manager_unavailable"));
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else {
        const detail = Buffer.concat(chunks, capturedBytes).toString("utf8");
        const errorCode =
          ["DOCUMENTS_NOT_WRITABLE", "DOCUMENTS_FOLDER_UNAVAILABLE"].find(
            (candidate) => detail.includes(candidate),
          ) ??
          (detail.includes("must be running")
            ? "RUNTIME_NOT_RUNNING"
            : detail.includes("healthy, non-maintenance")
              ? "RUNTIME_NOT_HEALTHY"
              : detail.toLowerCase().includes("request expired")
                ? "REQUEST_EXPIRED"
                : "MEMORY_SAMPLE_START_FAILED");
        reject(new Error(errorCode));
      }
    });
  });
}

async function retryMemorySampleSave(executable: string, requestId: string) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(executable, ["memory-sample-retry-save", requestId], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error("memory_sample_save_timeout"));
    }, 35_000);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error("memory_sample_status_invalid"));
      } else chunks.push(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      if (!settled) reject(new Error("manager_unavailable"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error("memory_sample_save_failed"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
      } catch {
        reject(new Error("memory_sample_status_invalid"));
      }
    });
  });
}

function reportClientFailure(diagnosticId: string, eventCode: string) {
  const now = Date.now();
  while (clientFailureTimes.length > 0 && clientFailureTimes[0] < now - 60_000)
    clientFailureTimes.shift();
  if (clientFailureTimes.length >= 30) return false;
  clientFailureTimes.push(now);
  emitApplicationDiagnostic({
    diagnosticId,
    component: "backup-import",
    severity: "error",
    eventCode: "backup_import.client_failed",
    phase: eventCode === "IMPORT_FILE_READ_FAILED" ? "file-read" : "request",
    errorCode: eventCode,
  });
  return true;
}

async function runExport(executable: string, outputPath: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["diagnose-export", outputPath], {
      windowsHide: true,
      stdio: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60_000);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("manager_unavailable"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("diagnostic_export_timeout"));
      else if (code !== 0) reject(new Error("diagnostic_export_failed"));
      else resolve();
    });
  });
}

export async function GET(request: Request) {
  if (!isSameOriginRequest(request))
    return Response.json({ error: "local_request_required" }, { status: 403 });
  const url = new URL(request.url);
  if (url.searchParams.get("mode") === "memory-sample") {
    const managerRoot = process.env.NGT_MANAGER_ROOT;
    const requestId = url.searchParams.get("requestId") ?? undefined;
    if (!managerRoot)
      return Response.json(
        { error: "manager_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    if (requestId && !memorySampleRequestIdPattern.test(requestId))
      return Response.json(
        { error: "invalid_request_id" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    const status = await readMemorySampleStatus(managerRoot, requestId);
    return Response.json(status ? { status } : { error: "sample_not_found" }, {
      status: status ? 200 : 404,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const diagnosticId = randomUUID();
  const managerRoot = process.env.NGT_MANAGER_ROOT;
  if (!managerRoot) {
    emitApplicationDiagnostic({
      diagnosticId,
      component: "application",
      severity: "error",
      eventCode: "application.request.unhandled",
      phase: "route",
      errorCode: "DIAGNOSTIC_EXPORT_UNAVAILABLE",
    });
    return Response.json(
      {
        error: "manager_unavailable",
        errorCode: "DIAGNOSTIC_EXPORT_UNAVAILABLE",
        diagnosticId,
      },
      { status: 503 },
    );
  }
  const filename = `NGTManager-diagnostics-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.txt`;
  let temporaryDirectory: string | undefined;
  let outputPath: string | undefined;
  const executable = join(managerRoot, "tools", "NGTManager.exe");
  try {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "NGTManager-diagnostics-"),
    );
    outputPath = join(temporaryDirectory, filename);
    await runExport(executable, outputPath);
    const file = await stat(/*turbopackIgnore: true*/ outputPath);
    if (!file.isFile() || file.size > 15 * 1024 * 1024)
      throw new Error("diagnostic_export_invalid");
    const stream = createReadStream(/*turbopackIgnore: true*/ outputPath);
    const cleanup = () => {
      void unlink(outputPath!)
        .catch(() => {})
        .then(() => rmdir(temporaryDirectory!).catch(() => {}));
    };
    stream.once("close", cleanup);
    stream.once("error", cleanup);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    if (outputPath) await unlink(outputPath).catch(() => {});
    if (temporaryDirectory) await rmdir(temporaryDirectory).catch(() => {});
    emitApplicationDiagnostic({
      diagnosticId,
      component: "application",
      severity: "error",
      eventCode: "application.request.unhandled",
      phase: "route",
      errorCode: "DIAGNOSTIC_EXPORT_FAILED",
    });
    return Response.json(
      {
        error: "diagnostic_export_failed",
        errorCode: "DIAGNOSTIC_EXPORT_FAILED",
        diagnosticId,
      },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  if (!isSameOriginWriteRequest(request))
    return Response.json(
      { error: "cross_origin_request_rejected" },
      { status: 403 },
    );
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 512)
    return Response.json({ error: "invalid_diagnostic" }, { status: 400 });
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json({ error: "invalid_diagnostic" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let body: unknown;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512) {
        await reader.cancel();
        return Response.json({ error: "invalid_diagnostic" }, { status: 400 });
      }
      chunks.push(value);
    }
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } catch {
    return Response.json({ error: "invalid_diagnostic" }, { status: 400 });
  } finally {
    reader.releaseLock();
  }
  if (!body || typeof body !== "object")
    return Response.json({ error: "invalid_diagnostic" }, { status: 400 });
  const value = body as {
    action?: unknown;
    requestId?: unknown;
    diagnosticId?: unknown;
    eventCode?: unknown;
  };
  if (value.action === "start-memory-sample") {
    if (
      typeof value.requestId !== "string" ||
      !memorySampleRequestIdPattern.test(value.requestId)
    )
      return Response.json(
        { error: "invalid_request_id" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    const managerRoot = process.env.NGT_MANAGER_ROOT;
    if (!managerRoot)
      return Response.json(
        { error: "manager_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    try {
      await startMemorySample(
        join(managerRoot, "tools", "NGTManager.exe"),
        value.requestId,
      );
    } catch (error) {
      const status = await readMemorySampleStatus(managerRoot, value.requestId);
      const errorCode =
        error instanceof Error &&
        [
          "DOCUMENTS_NOT_WRITABLE",
          "DOCUMENTS_FOLDER_UNAVAILABLE",
          "RUNTIME_NOT_RUNNING",
          "RUNTIME_NOT_HEALTHY",
          "REQUEST_EXPIRED",
        ].includes(error.message)
          ? error.message
          : "MEMORY_SAMPLE_START_FAILED";
      return Response.json(
        status
          ? { requestId: value.requestId, status }
          : { error: "memory_sample_start_failed", errorCode },
        {
          status: status ? 202 : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    return Response.json(
      {
        requestId: value.requestId,
        status: await readMemorySampleStatus(managerRoot, value.requestId),
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (value.action === "retry-memory-sample-save") {
    if (
      typeof value.requestId !== "string" ||
      !memorySampleRequestIdPattern.test(value.requestId)
    )
      return Response.json(
        { error: "invalid_request_id" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    const managerRoot = process.env.NGT_MANAGER_ROOT;
    if (!managerRoot)
      return Response.json(
        { error: "manager_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    try {
      const status = await retryMemorySampleSave(
        join(managerRoot, "tools", "NGTManager.exe"),
        value.requestId,
      );
      return Response.json(
        { status },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      const status = await readMemorySampleStatus(managerRoot, value.requestId);
      return Response.json(
        status ? { status } : { error: "memory_sample_save_failed" },
        {
          status: status ? 202 : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  }
  if (
    typeof value.diagnosticId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.diagnosticId,
    ) ||
    (value.eventCode !== "IMPORT_FILE_READ_FAILED" &&
      value.eventCode !== "IMPORT_REQUEST_FAILED")
  )
    return Response.json({ error: "invalid_diagnostic" }, { status: 400 });
  const accepted = reportClientFailure(value.diagnosticId, value.eventCode);
  return Response.json({ diagnosticId: value.diagnosticId, accepted });
}
