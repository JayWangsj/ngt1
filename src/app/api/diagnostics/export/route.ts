import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { emitApplicationDiagnostic } from "@/lib/app-diagnostics";
import {
  isSameOriginRequest,
  isSameOriginWriteRequest,
} from "@/lib/request-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const clientFailureTimes: number[] = [];

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
  const value = body as { diagnosticId?: unknown; eventCode?: unknown };
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
