export type SafeApplicationDiagnostic = {
  diagnosticId: string;
  component: "application" | "backup-import";
  severity: "warning" | "error";
  eventCode:
    | "application.request.unhandled"
    | "application.health_check.failed"
    | "backup_import.failed"
    | "backup_import.client_failed";
  phase:
    | "render"
    | "route"
    | "action"
    | "proxy"
    | "validation"
    | "preflight"
    | "transaction"
    | "database-check"
    | "work-order-read"
    | "runtime-info"
    | "file-read"
    | "request";
  errorCode: string;
  backupFormat?: "ngt-repair-data" | "unknown";
  backupVersion?: number;
  recordCounts?: Record<string, number>;
};

const safeErrorCodes = new Set([
  "NEXT_UNHANDLED_REQUEST_ERROR",
  "HEALTH_CHECK_FAILED",
  "BACKUP_FILE_INVALID",
  "BACKUP_FILE_TOO_LARGE",
  "BACKUP_REQUEST_READ_FAILED",
  "BACKUP_FORMAT_UNSUPPORTED",
  "BACKUP_REFERENCE_CONFLICT",
  "BACKUP_TARGET_NOT_EMPTY",
  "BACKUP_RECORD_CONFLICT",
  "SYSTEM_MAINTENANCE",
  "DATABASE_UNAVAILABLE",
  "BACKUP_IMPORT_FAILED",
  "DIAGNOSTIC_EXPORT_FAILED",
  "DIAGNOSTIC_EXPORT_UNAVAILABLE",
  "IMPORT_FILE_READ_FAILED",
  "IMPORT_REQUEST_FAILED",
]);

const safeEventCodes = new Set([
  "application.request.unhandled",
  "application.health_check.failed",
  "backup_import.failed",
  "backup_import.client_failed",
]);

const safePhases = new Set([
  "render",
  "route",
  "action",
  "proxy",
  "validation",
  "preflight",
  "transaction",
  "database-check",
  "work-order-read",
  "runtime-info",
  "file-read",
  "request",
]);

const backupSections = new Set([
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
]);

export function emitApplicationDiagnostic(event: SafeApplicationDiagnostic) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      event.diagnosticId,
    ) ||
    !safeErrorCodes.has(event.errorCode) ||
    !safeEventCodes.has(event.eventCode) ||
    !safePhases.has(event.phase) ||
    !["application", "backup-import"].includes(event.component) ||
    !["warning", "error"].includes(event.severity)
  )
    return;
  const recordCounts = event.recordCounts
    ? Object.fromEntries(
        Object.entries(event.recordCounts).filter(
          ([section, count]) =>
            backupSections.has(section) &&
            Number.isInteger(count) &&
            count >= 0 &&
            count <= 25_000_000,
        ),
      )
    : undefined;
  console.error(
    `NGT_DIAGNOSTIC:${JSON.stringify({
      formatVersion: 1,
      diagnosticId: event.diagnosticId,
      component: event.component,
      severity: event.severity,
      eventCode: event.eventCode,
      phase: event.phase,
      errorCode: event.errorCode,
      backupFormat:
        event.backupFormat === "ngt-repair-data" ||
        event.backupFormat === "unknown"
          ? event.backupFormat
          : undefined,
      backupVersion:
        Number.isInteger(event.backupVersion) &&
        (event.backupVersion ?? 0) >= 1 &&
        (event.backupVersion ?? 0) <= 1000
          ? event.backupVersion
          : undefined,
      recordCounts,
    })}`,
  );
}
