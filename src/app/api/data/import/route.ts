import { randomUUID } from "node:crypto";
import { BusinessError } from "@/lib/domain";
import {
  BACKUP_FORMAT,
  BackupImportError,
  importBusinessData,
  isDatabaseUnavailableError,
} from "@/lib/data-transfer";
import { emitApplicationDiagnostic } from "@/lib/app-diagnostics";
import { isSameOriginWriteRequest } from "@/lib/request-source";
import { requireActor } from "@/lib/session";
import { assertStudioWritesAvailable } from "@/lib/studio-maintenance";

const backupSections = [
  "customers",
  "phones",
  "devices",
  "orders",
  "items",
  "payments",
  "histories",
  "prices",
  "priceOptions",
  "faults",
  "audits",
  "products",
  "inventoryMovements",
  "retailSales",
  "retailSaleItems",
  "paymentAllocations",
  "workOrderProducts",
  "workOrderFaults",
  "reworkSessions",
  "reworkItems",
  "deviceCatalogDeletions",
  "productCompatibilities",
  "quickServices",
  "retailServiceItems",
  "workOrderDevices",
  "inventoryCategories",
  "businessClock",
] as const;
const IMPORT_SIZE_LIMIT = 20 * 1024 * 1024;
export const runtime = "nodejs";

async function readBackupJson(
  request: Request,
): Promise<
  | { kind: "ok"; value: unknown }
  | { kind: "too-large" }
  | { kind: "read-failed" }
  | { kind: "invalid" }
> {
  const reader = request.body?.getReader();
  if (!reader) return { kind: "invalid" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      try {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > IMPORT_SIZE_LIMIT) {
          await reader.cancel().catch(() => {});
          return { kind: "too-large" };
        }
        chunks.push(value);
      } catch {
        return { kind: "read-failed" };
      }
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = Buffer.concat(chunks, size);
    return {
      kind: "ok",
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ),
    };
  } catch {
    return { kind: "invalid" };
  }
}

function backupMetadata(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    format?: unknown;
    version?: unknown;
    data?: unknown;
  };
  if (!candidate.data || typeof candidate.data !== "object") return undefined;
  const data = candidate.data as Record<string, unknown>;
  const recordCounts = Object.fromEntries(
    backupSections.flatMap((section) => {
      const records = data[section];
      const count =
        section === "businessClock"
          ? records && typeof records === "object"
            ? 1
            : 0
          : Array.isArray(records)
            ? records.length
            : 0;
      return Number.isSafeInteger(count) && count <= 25_000_000
        ? [[section, count]]
        : [];
    }),
  );
  return {
    backupFormat:
      candidate.format === BACKUP_FORMAT ? BACKUP_FORMAT : "unknown",
    backupVersion:
      typeof candidate.version === "number" &&
      Number.isInteger(candidate.version) &&
      candidate.version >= 1 &&
      candidate.version <= 1000
        ? candidate.version
        : undefined,
    recordCounts,
  } as const;
}

function failureResponse(
  error: BackupImportError,
  diagnosticId: string,
  metadata?: ReturnType<typeof backupMetadata>,
) {
  const status =
    error.code === "BACKUP_FILE_TOO_LARGE"
      ? 413
      : error.code === "DATABASE_UNAVAILABLE" ||
          error.code === "SYSTEM_MAINTENANCE"
        ? 503
        : error.code === "BACKUP_IMPORT_FAILED"
          ? 500
          : error.code === "BACKUP_TARGET_NOT_EMPTY" ||
              error.code === "BACKUP_REFERENCE_CONFLICT" ||
              error.code === "BACKUP_RECORD_CONFLICT"
            ? 409
            : 400;
  emitApplicationDiagnostic({
    diagnosticId,
    component: "backup-import",
    severity: "error",
    eventCode: "backup_import.failed",
    phase: error.phase,
    errorCode: error.code,
    ...metadata,
  });
  return Response.json(
    { error: error.message, errorCode: error.code, diagnosticId },
    { status },
  );
}

export async function POST(request: Request) {
  if (!isSameOriginWriteRequest(request))
    return Response.json(
      { error: "cross_origin_request_rejected" },
      { status: 403 },
    );
  const requestedDiagnosticId = request.headers.get("x-ngt-diagnostic-id");
  const diagnosticId =
    requestedDiagnosticId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      requestedDiagnosticId,
    )
      ? requestedDiagnosticId
      : randomUUID();
  let metadata: ReturnType<typeof backupMetadata> = undefined;
  try {
    try {
      await assertStudioWritesAvailable();
    } catch (error) {
      if (error instanceof BusinessError)
        return failureResponse(
          new BackupImportError(
            "SYSTEM_MAINTENANCE",
            "preflight",
            error.message,
          ),
          diagnosticId,
        );
      const unavailable = isDatabaseUnavailableError(error);
      return failureResponse(
        new BackupImportError(
          unavailable ? "DATABASE_UNAVAILABLE" : "BACKUP_IMPORT_FAILED",
          "preflight",
          unavailable
            ? "Il database locale non è disponibile. Riprova dopo aver verificato lo stato del sistema."
            : "Non è stato possibile verificare lo stato di manutenzione.",
        ),
        diagnosticId,
      );
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > IMPORT_SIZE_LIMIT)
      return failureResponse(
        new BackupImportError(
          "BACKUP_FILE_TOO_LARGE",
          "validation",
          "File troppo grande.",
        ),
        diagnosticId,
      );
    const parsed = await readBackupJson(request);
    if (parsed.kind === "too-large")
      return failureResponse(
        new BackupImportError(
          "BACKUP_FILE_TOO_LARGE",
          "validation",
          "File troppo grande.",
        ),
        diagnosticId,
      );
    if (parsed.kind === "invalid") {
      return failureResponse(
        new BackupImportError(
          "BACKUP_FILE_INVALID",
          "validation",
          "Il file di backup non contiene JSON valido.",
        ),
        diagnosticId,
      );
    }
    if (parsed.kind === "read-failed")
      return failureResponse(
        new BackupImportError(
          "BACKUP_REQUEST_READ_FAILED",
          "request",
          "Non è stato possibile leggere la richiesta di importazione.",
        ),
        diagnosticId,
      );
    const value = parsed.value;
    metadata = backupMetadata(value);
    const actor = await requireActor();
    const result = await importBusinessData(actor, value);
    return Response.json(result);
  } catch (error) {
    if (error instanceof BackupImportError)
      return failureResponse(error, diagnosticId, metadata);
    if (error instanceof BusinessError)
      return failureResponse(
        new BackupImportError(
          "BACKUP_IMPORT_FAILED",
          "preflight",
          error.message,
        ),
        diagnosticId,
        metadata,
      );
    const unavailable = isDatabaseUnavailableError(error);
    return failureResponse(
      new BackupImportError(
        unavailable ? "DATABASE_UNAVAILABLE" : "BACKUP_IMPORT_FAILED",
        "preflight",
        unavailable
          ? "Il database locale non è disponibile. Riprova dopo aver verificato lo stato del sistema."
          : "Importazione non riuscita. Nessun dato del backup è stato salvato.",
      ),
      diagnosticId,
      metadata,
    );
  }
}
