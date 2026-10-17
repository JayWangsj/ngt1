export type UpdateCheckPhase =
  | "not-checked"
  | "checking"
  | "up-to-date"
  | "available"
  | "not-installable"
  | "auth-required"
  | "not-installed"
  | "failed";

export type UpdateTaskPhase =
  | "idle"
  | "starting"
  | "queued"
  | "running"
  | "reconnecting"
  | "verifying"
  | "succeeded"
  | "superseded"
  | "failed"
  | "rolling-back"
  | "rollback-succeeded"
  | "rollback-failed"
  | "interrupted";

export type UpdateStatus = {
  status?: string;
  stage?: string;
  message?: string;
  updateId?: string;
  targetVersion?: string;
  latestVersion?: string;
  currentVersion?: string;
  previousVersion?: string;
  actualVersion?: string;
  installInstanceId?: string;
  buildCommit?: string;
  executorPid?: number;
  executorAlive?: boolean;
  executorConfirmed?: boolean;
  createdAt?: string;
  updatedAt?: string;
  completedStages?: string[];
  skippedStages?: string[];
  failedStage?: string;
  recoveryStatus?: "not-started" | "running" | "succeeded" | "failed";
  recoveryMessage?: string;
  bytesDownloaded?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  progressKnown?: boolean;
  logAvailable?: boolean;
  manualReview?: boolean;
  previousStatus?: string;
  previousUpdateId?: string;
  manualInstallId?: string;
  operation?: "manual-install";
  installMode?: "first-install" | "upgrade" | "repair";
};

export type UpdateInfo = {
  installed: boolean;
  currentVersion: string;
  authRequired: boolean;
  updateAvailable: boolean;
  notInstallable?: boolean;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  downloadSize?: number;
  installInstanceId?: string;
  buildCommit?: string;
};

export function classifyUpdateCheck(info: UpdateInfo | null): UpdateCheckPhase {
  if (!info) return "not-checked";
  if (!info.installed) return "not-installed";
  if (info.authRequired) return "auth-required";
  if (info.updateAvailable) return "available";
  if (info.notInstallable) return "not-installable";
  return "up-to-date";
}

export function classifyUpdateTask(status?: UpdateStatus): UpdateTaskPhase {
  switch (status?.status) {
    case "starting":
      return "starting";
    case "queued":
      return "queued";
    case "running":
    case "checking":
    case "downloading":
    case "downloaded":
    case "verifying":
    case "preparing-runtime":
    case "backing-up":
    case "installing":
    case "validating":
      return status.executorAlive === false ? "interrupted" : "running";
    case "rolling-back":
      return "rolling-back";
    case "complete":
      return "succeeded";
    case "superseded":
      return "superseded";
    case "failed":
      return status.recoveryStatus === "succeeded"
        ? "rollback-succeeded"
        : status.recoveryStatus === "failed"
          ? "rollback-failed"
          : "failed";
    case "interrupted":
      return "interrupted";
    case "verifying-task":
    case "unknown":
      return "verifying";
    default:
      return "idle";
  }
}

export function shouldShowUpdateProgress(phase: UpdateTaskPhase) {
  return phase === "running" || phase === "rolling-back";
}

export function shouldShowDownloadProgress(status?: UpdateStatus) {
  return status?.stage === "downloading";
}

export function isUpdateTaskMonitorable(phase: UpdateTaskPhase) {
  return [
    "starting",
    "queued",
    "running",
    "reconnecting",
    "verifying",
    "rolling-back",
  ].includes(phase);
}
