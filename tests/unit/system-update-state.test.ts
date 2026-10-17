import { describe, expect, it } from "vitest";
import {
  classifyUpdateCheck,
  classifyUpdateTask,
  isUpdateTaskMonitorable,
  shouldShowDownloadProgress,
  shouldShowUpdateProgress,
} from "../../src/lib/system-update-state";

describe("system update state", () => {
  it("does not call an unchecked or failed result current", () => {
    expect(classifyUpdateCheck(null)).toBe("not-checked");
    expect(
      classifyUpdateCheck({
        installed: true,
        currentVersion: "2.0.10",
        authRequired: false,
        updateAvailable: true,
      }),
    ).toBe("available");
  });

  it("distinguishes an incomplete release from no update", () => {
    expect(
      classifyUpdateCheck({
        installed: true,
        currentVersion: "2.0.10",
        authRequired: false,
        updateAvailable: false,
        notInstallable: true,
      }),
    ).toBe("not-installable");
    expect(
      classifyUpdateCheck({
        installed: true,
        currentVersion: "2.0.10",
        authRequired: false,
        updateAvailable: false,
      }),
    ).toBe("up-to-date");
  });

  it("keeps startup and queued tasks compact until execution is confirmed", () => {
    expect(classifyUpdateTask({ status: "starting" })).toBe("starting");
    expect(classifyUpdateTask({ status: "queued" })).toBe("queued");
    expect(shouldShowUpdateProgress("starting")).toBe(false);
    expect(shouldShowUpdateProgress("queued")).toBe(false);
    expect(isUpdateTaskMonitorable("starting")).toBe(true);
  });

  it("shows execution progress only while a verified task is running", () => {
    expect(
      classifyUpdateTask({
        status: "running",
        stage: "downloading",
        executorAlive: true,
      }),
    ).toBe("running");
    expect(shouldShowUpdateProgress("running")).toBe(true);
    expect(
      classifyUpdateTask({
        status: "running",
        stage: "downloading",
        executorAlive: false,
      }),
    ).toBe("interrupted");
    expect(shouldShowUpdateProgress("interrupted")).toBe(false);
  });

  it("shows download progress from the reported stage, not task status", () => {
    expect(
      shouldShowDownloadProgress({ status: "running", stage: "downloading" }),
    ).toBe(true);
    expect(shouldShowDownloadProgress({ status: "downloading" })).toBe(false);
  });

  it("keeps rollback outcomes separate from successful updates", () => {
    expect(
      classifyUpdateTask({ status: "failed", recoveryStatus: "succeeded" }),
    ).toBe("rollback-succeeded");
    expect(
      classifyUpdateTask({ status: "failed", recoveryStatus: "failed" }),
    ).toBe("rollback-failed");
    expect(classifyUpdateTask({ status: "complete" })).toBe("succeeded");
    expect(classifyUpdateTask({ status: "superseded" })).toBe("superseded");
  });
});
