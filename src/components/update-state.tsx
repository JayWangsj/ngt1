"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  classifyUpdateCheck,
  classifyUpdateTask,
  isUpdateTaskMonitorable,
  type UpdateCheckPhase,
  type UpdateInfo,
  type UpdateStatus,
  type UpdateTaskPhase,
} from "@/lib/system-update-state";
import {
  readAutoUpdateCheck,
  readUpdateCheckCache,
  writeUpdateCheckCache,
} from "@/lib/update-preference";

type CheckState = {
  phase: UpdateCheckPhase;
  error?: string;
  lastCheckedAt?: string;
  lastSuccessfulCheckAt?: string;
};

type TaskState = {
  phase: UpdateTaskPhase;
  status?: UpdateStatus;
  lastTrustedStatus?: UpdateStatus;
  message?: string;
};

type UpdateStateValue = {
  currentVersion: string;
  info: UpdateInfo | null;
  check: CheckState;
  task: TaskState;
  ensureChecked: () => Promise<boolean>;
  checkForUpdates: (force?: boolean) => Promise<boolean>;
  refreshTask: () => Promise<TaskState>;
  startUpdate: (targetVersion: string) => Promise<void>;
};

const UpdateContext = createContext<UpdateStateValue | null>(null);

function toUpdateInfo(
  value: Partial<UpdateInfo> & { currentVersion?: string },
): UpdateInfo {
  return {
    installed: Boolean(value.installed),
    currentVersion: value.currentVersion || "",
    authRequired: Boolean(value.authRequired),
    updateAvailable: Boolean(value.updateAvailable),
    notInstallable: Boolean(value.notInstallable),
    latestVersion: value.latestVersion,
    releaseName: value.releaseName,
    releaseNotes: value.releaseNotes,
    publishedAt: value.publishedAt,
    downloadSize: value.downloadSize,
    installInstanceId: value.installInstanceId,
    buildCommit: value.buildCommit,
  };
}

function taskFromStatus(status: UpdateStatus): TaskState {
  const safeStatus = {
    ...status,
    message: status.message ? redactDiagnostic(status.message) : undefined,
    recoveryMessage: status.recoveryMessage
      ? redactDiagnostic(status.recoveryMessage)
      : undefined,
  };
  const phase = classifyUpdateTask(safeStatus);
  return {
    phase,
    status: safeStatus,
    lastTrustedStatus:
      safeStatus.executorAlive === true ||
      ["complete", "superseded", "failed", "interrupted"].includes(
        safeStatus.status || "",
      )
        ? safeStatus
        : undefined,
    message: safeStatus.message,
  };
}

function redactDiagnostic(value: string) {
  return value
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/(token\s*[:=]\s*)\S+/gi, "$1[redacted]");
}

export function UpdateStateProvider({
  initialVersion,
  children,
}: {
  initialVersion: string;
  children: ReactNode;
}) {
  const [currentVersion, setCurrentVersion] = useState(initialVersion);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [check, setCheck] = useState<CheckState>({ phase: "not-checked" });
  const [task, setTask] = useState<TaskState>({ phase: "idle" });
  const checkPromise = useRef<Promise<boolean> | null>(null);
  const requestId = useRef(0);
  const lastSuccessfulCheck = useRef(0);
  const monitorId = useRef(0);
  const monitorTimer = useRef<number | null>(null);
  const monitorController = useRef<AbortController | null>(null);
  const initializationPromise = useRef<Promise<void> | null>(null);
  const startMonitoringRef = useRef<() => void>(() => undefined);

  const checkForUpdates = useCallback(
    (force = true) => {
      if (checkPromise.current) return checkPromise.current;
      if (!force) {
        const cached = readUpdateCheckCache<UpdateInfo>(
          task.status?.installInstanceId || info?.installInstanceId,
          currentVersion,
        );
        if (cached) return Promise.resolve(true);
      }
      const id = ++requestId.current;
      setCheck((current) => ({
        ...current,
        phase: "checking",
        error: undefined,
      }));
      const request = (async () => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 30_000);
        try {
          const response = await fetch("/api/system-update", {
            cache: "no-store",
            signal: controller.signal,
          });
          const result = (await response.json()) as Partial<UpdateInfo> & {
            error?: string;
            status?: UpdateStatus;
          };
          if (!response.ok)
            throw new Error(result.error || "update_check_failed");
          const next = toUpdateInfo(result);
          const nextTask = result.status
            ? taskFromStatus({
                ...result.status,
                installInstanceId: next.installInstanceId,
                buildCommit: next.buildCommit,
              })
            : null;
          const checkedAt = new Date().toISOString();
          if (id === requestId.current) {
            setInfo((previous) =>
              next.authRequired && previous?.updateAvailable
                ? {
                    ...previous,
                    currentVersion: next.currentVersion,
                    authRequired: true,
                  }
                : next,
            );
            setCurrentVersion(next.currentVersion || initialVersion);
            if (nextTask) {
              setTask((previous) => ({
                ...nextTask,
                lastTrustedStatus:
                  nextTask.lastTrustedStatus || previous.lastTrustedStatus,
              }));
              if (isUpdateTaskMonitorable(nextTask.phase))
                startMonitoringRef.current();
            }
            lastSuccessfulCheck.current = Date.parse(checkedAt);
            writeUpdateCheckCache(next.installInstanceId, next.currentVersion, {
              checkedAt,
              info: next,
            });
            setCheck({
              phase: classifyUpdateCheck(next),
              lastCheckedAt: checkedAt,
              lastSuccessfulCheckAt: checkedAt,
            });
          }
          return true;
        } catch (cause) {
          if (id === requestId.current) {
            setCheck((current) => ({
              ...current,
              phase: "failed",
              lastCheckedAt: new Date().toISOString(),
              error: redactDiagnostic(
                cause instanceof Error && cause.name !== "AbortError"
                  ? cause.message
                  : "update_check_timeout",
              ),
            }));
          }
          return false;
        } finally {
          window.clearTimeout(timeout);
          if (id === requestId.current) checkPromise.current = null;
        }
      })();
      checkPromise.current = request;
      return request;
    },
    [
      currentVersion,
      info?.installInstanceId,
      initialVersion,
      task.status?.installInstanceId,
    ],
  );
  const checkForUpdatesRef = useRef(checkForUpdates);

  const ensureChecked = useCallback(async () => {
    await initializationPromise.current;
    if (checkPromise.current) return checkPromise.current;
    const cached = readUpdateCheckCache<UpdateInfo>(
      task.status?.installInstanceId || info?.installInstanceId,
      currentVersion,
    );
    if (cached) {
      setInfo(cached.info);
      lastSuccessfulCheck.current = Date.parse(cached.checkedAt);
      setCheck({
        phase: classifyUpdateCheck(cached.info),
        lastCheckedAt: cached.checkedAt,
        lastSuccessfulCheckAt: cached.checkedAt,
      });
      return true;
    }
    if (
      lastSuccessfulCheck.current &&
      Date.now() - lastSuccessfulCheck.current < 5 * 60_000
    )
      return true;
    return checkForUpdates(false);
  }, [
    checkForUpdates,
    currentVersion,
    info?.installInstanceId,
    task.status?.installInstanceId,
  ]);

  const stopMonitoring = useCallback(() => {
    monitorId.current += 1;
    if (monitorTimer.current !== null) {
      window.clearTimeout(monitorTimer.current);
      monitorTimer.current = null;
    }
    monitorController.current?.abort();
    monitorController.current = null;
  }, []);

  const startMonitoring = useCallback(() => {
    stopMonitoring();
    const id = monitorId.current;
    let failures = 0;
    const poll = async () => {
      if (id !== monitorId.current) return;
      const controller = new AbortController();
      monitorController.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch("/api/system-update/status", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("status_unavailable");
        const status = (await response.json()) as UpdateStatus;
        if (id !== monitorId.current) return;
        failures = 0;
        const next = taskFromStatus(status);
        const staleAfter =
          status.stage === "downloading"
            ? 120_000
            : status.stage === "backing-up"
              ? 600_000
              : status.stage === "installing"
                ? 900_000
                : status.stage === "rolling-back"
                  ? 1_200_000
                  : status.stage === "validating"
                    ? 300_000
                    : 120_000;
        const lastProgressAt = Date.parse(
          status.updatedAt || status.createdAt || "",
        );
        const noRecentProgress =
          isUpdateTaskMonitorable(next.phase) &&
          Number.isFinite(lastProgressAt) &&
          Date.now() - lastProgressAt > staleAfter;
        const visibleNext = noRecentProgress
          ? {
              ...next,
              phase: "reconnecting" as const,
              message: "update_status_no_progress",
            }
          : next;
        setTask((previous) => ({
          ...visibleNext,
          lastTrustedStatus:
            next.lastTrustedStatus || previous.lastTrustedStatus,
        }));
        if (status.currentVersion) setCurrentVersion(status.currentVersion);
        if (next.phase === "succeeded" && status.targetVersion) {
          const actualVersion = status.actualVersion || status.currentVersion;
          if (
            actualVersion?.replace(/^v/i, "") ===
            status.targetVersion.replace(/^v/i, "")
          ) {
            setInfo((current) => {
              if (
                !current ||
                current.latestVersion?.replace(/^v/i, "") !==
                  status.targetVersion?.replace(/^v/i, "")
              )
                return current;
              return {
                ...current,
                updateAvailable: false,
                notInstallable: false,
              };
            });
          }
        }
        if (!isUpdateTaskMonitorable(visibleNext.phase)) return;
      } catch {
        if (id !== monitorId.current) return;
        failures += 1;
        setTask((previous) => ({
          ...previous,
          phase: previous.lastTrustedStatus ? "reconnecting" : "verifying",
          message: "update_status_reconnecting",
        }));
      } finally {
        window.clearTimeout(timeout);
        if (monitorController.current === controller)
          monitorController.current = null;
      }
      if (id !== monitorId.current) return;
      const delay = failures
        ? Math.min(30_000, 2_000 * 2 ** Math.min(failures - 1, 4))
        : 2_000;
      monitorTimer.current = window.setTimeout(() => void poll(), delay);
    };
    monitorTimer.current = window.setTimeout(() => void poll(), 1_000);
  }, [stopMonitoring]);
  startMonitoringRef.current = startMonitoring;

  const refreshTask = useCallback(async (): Promise<TaskState> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/api/system-update/status", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("status_unavailable");
      const status = (await response.json()) as UpdateStatus;
      const next = taskFromStatus(status);
      setTask(next);
      if (status.currentVersion) setCurrentVersion(status.currentVersion);
      if (
        next.phase === "succeeded" &&
        status.targetVersion &&
        (status.actualVersion || status.currentVersion)?.replace(/^v/i, "") ===
          status.targetVersion.replace(/^v/i, "")
      ) {
        setInfo((current) => {
          if (
            !current ||
            current.latestVersion?.replace(/^v/i, "") !==
              status.targetVersion?.replace(/^v/i, "")
          )
            return current;
          return { ...current, updateAvailable: false, notInstallable: false };
        });
      }
      if (isUpdateTaskMonitorable(next.phase)) startMonitoring();
      return next;
    } catch {
      setTask((previous) => ({
        ...previous,
        phase: previous.lastTrustedStatus ? "reconnecting" : "verifying",
        message: "update_status_reconnecting",
      }));
      startMonitoring();
      return {
        phase: "verifying",
        message: "update_status_reconnecting",
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }, [startMonitoring]);
  const refreshTaskRef = useRef(refreshTask);

  useEffect(() => {
    checkForUpdatesRef.current = checkForUpdates;
    refreshTaskRef.current = refreshTask;
  }, [checkForUpdates, refreshTask]);

  const startUpdate = useCallback(
    async (targetVersion: string) => {
      setTask({ phase: "starting", message: "update_task_starting" });
      try {
        const response = await fetch("/api/system-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetVersion }),
        });
        const result = (await response.json()) as UpdateStatus & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(result.error || "update_start_failed");
        const next = taskFromStatus(result);
        setTask(next);
        startMonitoring();
      } catch (cause) {
        const error =
          cause instanceof Error ? cause.message : "update_start_failed";
        if (error === "studio_update_in_progress") await refreshTask();
        else setTask({ phase: "idle" });
        throw cause;
      }
    },
    [refreshTask, startMonitoring],
  );

  useEffect(() => {
    let cancelled = false;
    const initialization = (async () => {
      const initialTask = await refreshTaskRef.current();
      if (cancelled) return;
      const cached = readUpdateCheckCache<UpdateInfo>(
        initialTask.status?.installInstanceId,
        initialTask.status?.currentVersion || initialVersion,
      );
      if (cached) {
        setInfo(cached.info);
        lastSuccessfulCheck.current = Date.parse(cached.checkedAt);
        setCheck({
          phase: classifyUpdateCheck(cached.info),
          lastCheckedAt: cached.checkedAt,
          lastSuccessfulCheckAt: cached.checkedAt,
        });
      }
      if (readAutoUpdateCheck() && !cached)
        await checkForUpdatesRef.current(false);
    })();
    initializationPromise.current = initialization;
    return () => {
      cancelled = true;
      requestId.current += 1;
      stopMonitoring();
    };
  }, [initialVersion, stopMonitoring]);

  const value = useMemo<UpdateStateValue>(
    () => ({
      currentVersion,
      info,
      check,
      task,
      ensureChecked,
      checkForUpdates,
      refreshTask,
      startUpdate,
    }),
    [
      currentVersion,
      info,
      check,
      task,
      ensureChecked,
      checkForUpdates,
      refreshTask,
      startUpdate,
    ],
  );

  return (
    <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
  );
}

export function useUpdateState() {
  const value = useContext(UpdateContext);
  if (!value)
    throw new Error("useUpdateState must be used inside UpdateStateProvider");
  return value;
}
