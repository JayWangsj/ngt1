import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitApplicationDiagnostic,
  type SafeApplicationDiagnostic,
} from "@/lib/app-diagnostics";

describe("application diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits only allowlisted, bounded diagnostic metadata", () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => {});
    emitApplicationDiagnostic({
      diagnosticId: "12345678-1234-1234-1234-123456789abc",
      component: "backup-import",
      severity: "error",
      eventCode: "backup_import.failed",
      phase: "validation",
      errorCode: "BACKUP_FILE_INVALID",
      backupFormat: "ngt-repair-data",
      backupVersion: 10,
      recordCounts: { customers: 4, payments: 2, privateNotes: 9 },
      error: "never emit arbitrary properties",
    } as SafeApplicationDiagnostic & { error: string });

    expect(write).toHaveBeenCalledOnce();
    const line = String(write.mock.calls[0][0]);
    expect(line.startsWith("NGT_DIAGNOSTIC:")).toBe(true);
    const event = JSON.parse(line.slice("NGT_DIAGNOSTIC:".length));
    expect(event).toMatchObject({
      formatVersion: 1,
      diagnosticId: "12345678-1234-1234-1234-123456789abc",
      component: "backup-import",
      eventCode: "backup_import.failed",
      errorCode: "BACKUP_FILE_INVALID",
      backupVersion: 10,
      recordCounts: { customers: 4, payments: 2 },
    });
    expect(line).not.toContain("privateNotes");
    expect(line).not.toContain("never emit arbitrary properties");
  });

  it("rejects event codes and error codes outside the safe lists", () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => {});
    emitApplicationDiagnostic({
      diagnosticId: "12345678-1234-1234-1234-123456789abc",
      component: "application",
      severity: "error",
      eventCode: "application.failed;password=secret",
      phase: "route",
      errorCode: "DATABASE_URL=secret",
    } as unknown as SafeApplicationDiagnostic);

    expect(write).not.toHaveBeenCalled();
  });
});
