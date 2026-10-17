"use client";

import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useLanguage, useMessages } from "./language";
import { Button } from "./ui/button";
import { FormDialog } from "./forms";
import { useUpdateState } from "./update-state";
import {
  classifyUpdateTask,
  shouldShowDownloadProgress,
  shouldShowUpdateProgress,
  type UpdateStatus,
} from "@/lib/system-update-state";
import {
  readAutoUpdateCheck,
  writeAutoUpdateCheck,
} from "@/lib/update-preference";

type GitHubAuth = {
  status: "opening" | "waiting";
  verificationUrl?: string;
  userCode?: string;
};

function formatBytes(value?: number) {
  if (!value || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatEta(seconds: number, messages: ReturnType<typeof useMessages>) {
  if (seconds < 60)
    return messages.updateEtaShort.replace("{seconds}", `${seconds}`);
  return messages.updateEtaFormat
    .replace("{minutes}", `${Math.floor(seconds / 60)}`)
    .replace("{seconds}", `${seconds % 60}`);
}

function errorMessage(value: string | undefined, fallback: string) {
  switch (value) {
    case "update_target_changed":
    case "update_no_longer_available":
      return "target-changed";
    case "update_not_installable":
      return "not-installable";
    case "studio_update_in_progress":
      return "task-in-progress";
    case "studio_update_needs_manual_review":
      return "task-verification-required";
    default:
      return value || fallback;
  }
}

function stageLabel(stage: string, messages: ReturnType<typeof useMessages>) {
  if (stage === "reading-release" || stage === "checking")
    return messages.updateStageReadingRelease;
  if (stage === "downloading") return messages.updateStageDownloading;
  if (stage === "verifying") return messages.updateStageVerifying;
  if (stage === "preparing-runtime") return messages.updateStageRuntime;
  if (stage === "backing-up") return messages.updateStageBackup;
  if (stage === "installing") return messages.updateStageInstalling;
  if (stage === "validating") return messages.updateStageValidating;
  if (stage === "complete") return messages.updateStageComplete;
  return stage;
}

function taskSummary(
  status: UpdateStatus | undefined,
  phase: string,
  it: ReturnType<typeof useMessages>,
) {
  if (phase === "starting") return it.updateTaskStarting;
  if (phase === "queued") return it.updateTaskQueued;
  if (phase === "reconnecting") return it.updateReconnecting;
  if (phase === "verifying") return it.updateVerifyingTask;
  if (phase === "interrupted") return it.updateInterrupted;
  if (phase === "rolling-back") return it.updateRollingBack;
  if (phase === "rollback-succeeded") return it.updateRollbackSucceeded;
  if (phase === "rollback-failed") return it.updateRollbackFailed;
  if (phase === "failed") return it.updateFailed;
  if (phase === "succeeded") return it.updateSuccess;
  if (phase === "superseded") return it.updateSuperseded;
  if (phase === "running")
    return stageLabel(status?.stage || "reading-release", it);
  return "";
}

export function SystemUpdate({
  currentVersion: fallbackVersion,
}: {
  currentVersion: string;
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const {
    currentVersion,
    info,
    check,
    task,
    ensureChecked,
    checkForUpdates,
    startUpdate: launchUpdate,
  } = useUpdateState();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [githubAuth, setGitHubAuth] = useState<GitHubAuth | null>(null);
  const [authPending, setAuthPending] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [startError, setStartError] = useState("");
  const [autoCheck, setAutoCheck] = useState(true);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setAutoCheck(readAutoUpdateCheck());
      void ensureChecked();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ensureChecked]);

  async function beginGitHubLogin() {
    if (info?.installed && !info.authRequired) {
      setGitHubAuth(null);
      setAuthError("");
      setAuthMessage(it.updateLoginSuccess);
      return;
    }
    setAuthPending(true);
    setAuthError("");
    setAuthMessage(it.updateLoginOpening);
    try {
      const response = await fetch("/api/system-update/auth", {
        method: "POST",
      });
      const result = (await response.json()) as {
        status?: string;
        verificationUrl?: string;
        userCode?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || it.updateLoginFailed);
      setGitHubAuth({
        status: result.status === "waiting" ? "waiting" : "opening",
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
      });
      await monitorGitHubLogin();
    } catch (cause) {
      setAuthMessage("");
      setAuthError(
        cause instanceof Error ? cause.message : it.updateLoginFailed,
      );
      setAuthPending(false);
    }
  }

  async function monitorGitHubLogin() {
    for (let attempt = 0; attempt < 900; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      try {
        const response = await fetch("/api/system-update/auth", {
          cache: "no-store",
        });
        const result = (await response.json()) as {
          status?: string;
          message?: string;
          verificationUrl?: string;
          userCode?: string;
          error?: string;
        };
        if (!response.ok) throw new Error(result.error || it.updateLoginFailed);
        if (result.status === "success") {
          setGitHubAuth(null);
          setAuthMessage(it.updateLoginSuccess);
          setAuthPending(false);
          await checkForUpdates();
          return;
        }
        if (result.status === "failed") {
          setGitHubAuth({
            status: "waiting",
            verificationUrl: result.verificationUrl,
            userCode: result.userCode,
          });
          setAuthMessage("");
          setAuthError(
            result.message
              ? `${it.updateLoginFailed} ${result.message}`
              : it.updateLoginFailed,
          );
          setAuthPending(false);
          return;
        }
        const waiting = result.status === "waiting";
        setGitHubAuth({
          status: waiting ? "waiting" : "opening",
          verificationUrl: result.verificationUrl,
          userCode: result.userCode,
        });
        setAuthMessage(waiting ? it.updateLoginWaiting : it.updateLoginOpening);
      } catch (cause) {
        setAuthMessage("");
        setAuthError(
          cause instanceof Error ? cause.message : it.updateLoginFailed,
        );
        setAuthPending(false);
        return;
      }
    }
    setAuthMessage("");
    setAuthError(it.updateLoginTimeout);
    setAuthPending(false);
  }

  async function copyGitHubAuth(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setAuthMessage(it.updateLoginCopied);
      setAuthError("");
    } catch {
      setAuthError(it.updateLoginCopyFailed);
    }
  }

  async function confirmUpdate() {
    setConfirmationOpen(false);
    setStartError("");
    try {
      await launchUpdate(info?.latestVersion || "");
    } catch (cause) {
      setStartError(
        errorMessage(
          cause instanceof Error ? cause.message : undefined,
          it.updateFailed,
        ),
      );
    }
  }

  async function loadDiagnostics() {
    setDiagnosticsOpen((open) => !open);
    if (diagnostics !== null) return;
    setDiagnosticsLoading(true);
    try {
      const response = await fetch("/api/system-update/status/log", {
        cache: "no-store",
      });
      const result = (await response.json()) as { log?: string };
      setDiagnostics(result.log || it.updateLogUnavailable);
    } catch {
      setDiagnostics(it.updateLogUnavailable);
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  function changeAutoCheck(enabled: boolean) {
    writeAutoUpdateCheck(enabled);
    setAutoCheck(enabled);
  }

  const version = currentVersion || fallbackVersion;
  const checkPhase = check.phase;
  const checkDescription = (() => {
    if (checkPhase === "not-checked") return it.updateNotChecked;
    if (checkPhase === "checking") return it.checkingUpdates;
    if (checkPhase === "failed")
      return check.error === "update_check_timeout"
        ? it.updateCheckTimeout
        : info?.updateAvailable
          ? it.updateCheckStale.replace("{version}", info.latestVersion || "")
          : it.updateCheckFailed;
    if (checkPhase === "up-to-date") return it.updateCurrent;
    if (checkPhase === "available")
      return it.updateAvailable.replace("{version}", info?.latestVersion || "");
    if (checkPhase === "not-installable")
      return info?.latestVersion
        ? `${it.updateNotInstallable} v${info.latestVersion}`
        : it.updateNotInstallable;
    if (checkPhase === "auth-required") return it.updateAuthRequired;
    return it.updateInstalledOnly;
  })();
  const taskStatus = task.status || task.lastTrustedStatus;
  const taskPhase = task.phase;
  const trustedProgressStatus =
    taskPhase === "reconnecting" ? task.lastTrustedStatus : task.status;
  const progressPhase = classifyUpdateTask(trustedProgressStatus);
  const showProgress =
    shouldShowUpdateProgress(taskPhase) ||
    (taskPhase === "reconnecting" && shouldShowUpdateProgress(progressPhase));
  const taskBusy = ["starting", "queued", "running", "rolling-back"].includes(
    taskPhase,
  );
  const installBlocked =
    taskBusy ||
    ["reconnecting", "verifying", "interrupted"].includes(taskPhase);
  const showRelease = Boolean(
    (info?.updateAvailable || info?.notInstallable) &&
    !["starting", "queued", "running", "reconnecting", "rolling-back"].includes(
      taskPhase,
    ),
  );
  const stages = [
    ["reading-release", it.updateStageReadingRelease],
    ["downloading", it.updateStageDownloading],
    ["verifying", it.updateStageVerifying],
    ["preparing-runtime", it.updateStageRuntime],
    ["backing-up", it.updateStageBackup],
    ["installing", it.updateStageInstalling],
    ["validating", it.updateStageValidating],
  ];
  const downloaded = trustedProgressStatus?.bytesDownloaded || 0;
  const total = trustedProgressStatus?.totalBytes || info?.downloadSize || 0;
  const progressKnown =
    total > 0 && trustedProgressStatus?.progressKnown === true;
  const percentage = progressKnown
    ? Math.min(100, Math.round((downloaded / total) * 100))
    : 0;
  const lastCheck = check.lastSuccessfulCheckAt
    ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "it-IT", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(check.lastSuccessfulCheckAt))
    : "";
  const shouldShowResult = [
    "succeeded",
    "failed",
    "rollback-succeeded",
    "rollback-failed",
  ].includes(taskPhase);
  const renderStages = (status: UpdateStatus) => (
    <ol className="update-stage-list">
      {stages.map(([stage, label]) => {
        const skipped = (status.skippedStages || []).includes(stage);
        const complete = (status.completedStages || []).includes(stage);
        const active =
          status.stage === stage ||
          (stage === "reading-release" && status.stage === "checking");
        const failed =
          status.status === "failed" && status.failedStage === stage;
        return (
          <li
            key={stage}
            className={
              failed
                ? "failed"
                : skipped
                  ? "skipped"
                  : complete
                    ? "complete"
                    : active
                      ? "active"
                      : ""
            }
          >
            {failed ? (
              <XCircle />
            ) : complete ? (
              <CheckCircle2 />
            ) : active ? (
              <LoaderCircle className="spin" />
            ) : (
              <Circle />
            )}
            <span>{label}</span>
            {skipped && <small>{it.updateStepSkipped}</small>}
          </li>
        );
      })}
    </ol>
  );

  return (
    <div className="system-update-page">
      <section className="panel padded update-overview">
        <div className="update-version-block">
          <span>{it.currentVersion}</span>
          <strong>v{version}</strong>
          <small aria-live="polite">{checkDescription}</small>
          {checkPhase === "up-to-date" && lastCheck && (
            <small>
              {it.updateCheckTime}: {lastCheck}
            </small>
          )}
        </div>
        <div className="update-primary-actions">
          <Button
            type="button"
            disabled={checkPhase === "checking"}
            onClick={() => void checkForUpdates()}
          >
            <RefreshCw
              size={17}
              className={checkPhase === "checking" ? "spin" : undefined}
            />
            {checkPhase === "checking"
              ? it.checkingUpdates
              : it.checkForUpdates}
          </Button>
          {info?.authRequired && (
            <Button
              type="button"
              variant="outline"
              disabled={authPending}
              onClick={() => void beginGitHubLogin()}
            >
              <GitBranch size={18} />
              {it.authorizeGitHub}
            </Button>
          )}
        </div>
      </section>

      {(taskPhase === "starting" ||
        taskPhase === "queued" ||
        taskPhase === "verifying") && (
        <p
          className="message update-task-compact"
          role="status"
          aria-live="polite"
        >
          {taskSummary(taskStatus, taskPhase, it)}
          {taskPhase === "verifying" && (
            <>
              <span>
                {taskStatus?.manualReview
                  ? it.updateManualReview
                  : task.message === "update_status_no_progress"
                    ? it.updateNoRecentProgress
                    : taskStatus?.message}
              </span>
              <button
                type="button"
                className="update-diagnostics-toggle"
                aria-expanded={diagnosticsOpen}
                onClick={() => void loadDiagnostics()}
              >
                {it.updateLogDetails}
              </button>
              {diagnosticsOpen && (
                <pre className="update-diagnostics">
                  {diagnosticsLoading ? it.loading : diagnostics || ""}
                </pre>
              )}
            </>
          )}
        </p>
      )}

      {taskPhase === "interrupted" && (
        <div className="message error update-task-compact" role="alert">
          <span>
            {taskStatus?.manualReview
              ? it.updateManualReview
              : it.updateInterrupted}
            {taskStatus?.stage &&
            !["starting", "queued"].includes(taskStatus.stage)
              ? ` ${it.updateCurrentStage}: ${stageLabel(taskStatus.stage, it)}`
              : ""}
          </span>
          <button
            type="button"
            className="update-diagnostics-toggle"
            aria-expanded={diagnosticsOpen}
            onClick={() => void loadDiagnostics()}
          >
            {it.updateLogDetails}
          </button>
          {diagnosticsOpen && (
            <pre className="update-diagnostics">
              {diagnosticsLoading ? it.loading : diagnostics || ""}
            </pre>
          )}
        </div>
      )}

      {taskPhase === "reconnecting" && (
        <p
          className="message update-task-compact"
          role="status"
          aria-live="polite"
        >
          {it.updateReconnecting}
        </p>
      )}

      {taskPhase === "superseded" && taskStatus && (
        <div className="message success update-task-compact" role="status">
          <span>{it.updateSuperseded}</span>
          <button
            type="button"
            className="update-diagnostics-toggle"
            aria-expanded={diagnosticsOpen}
            onClick={() => void loadDiagnostics()}
          >
            {it.updateLogDetails}
          </button>
          {diagnosticsOpen && (
            <pre className="update-diagnostics">
              {diagnosticsLoading ? it.loading : diagnostics || ""}
            </pre>
          )}
        </div>
      )}

      <div className="system-update-feedback" aria-live="polite">
        {(authMessage || authError || startError) && (
          <p
            className={`message ${authError || startError ? "error" : "success"}`}
            role={authError || startError ? "alert" : "status"}
          >
            {authMessage ||
              (startError === "target-changed"
                ? it.updateTargetChanged
                : startError === "not-installable"
                  ? it.updateNotInstallable
                  : startError === "task-in-progress"
                    ? it.updateTaskStarting
                    : startError === "task-verification-required"
                      ? it.updateManualReview
                      : startError || authError)}
          </p>
        )}
        {githubAuth?.verificationUrl && (
          <div className="github-auth-fallback panel padded">
            <span>{it.updateLoginFallback}</span>
            <div>
              <Button asChild variant="outline">
                <a
                  href={githubAuth.verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={16} />
                  {it.updateLoginOpenLink}
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void copyGitHubAuth(
                    githubAuth.userCode || githubAuth.verificationUrl || "",
                  )
                }
              >
                <Copy size={16} />
                {githubAuth.userCode || it.updateLoginCopyLink}
              </Button>
            </div>
          </div>
        )}
      </div>

      {showRelease && info?.latestVersion && (
        <section className="panel padded update-release-card">
          <div className="update-release-heading">
            <div>
              <span>{it.updateAvailableLabel}</span>
              <strong>v{info.latestVersion}</strong>
              {info.publishedAt && (
                <small>
                  {it.updatePublishedAt}:{" "}
                  {new Intl.DateTimeFormat(
                    locale === "zh" ? "zh-CN" : "it-IT",
                    {
                      dateStyle: "short",
                    },
                  ).format(new Date(info.publishedAt))}
                </small>
              )}
              {checkPhase === "failed" && (
                <small>
                  {it.updateCheckStale.replace("{version}", info.latestVersion)}
                </small>
              )}
            </div>
            {!info.notInstallable && (
              <Button
                type="button"
                disabled={
                  installBlocked ||
                  checkPhase === "checking" ||
                  info.authRequired
                }
                onClick={() => setConfirmationOpen(true)}
              >
                <Download size={17} />
                {it.updateNow}
              </Button>
            )}
          </div>
          <div className="update-release-notes">
            <strong>{it.updateReleaseNotes}</strong>
            <p>
              {info.releaseNotes || info.releaseName || it.updateNoReleaseNotes}
            </p>
          </div>
        </section>
      )}

      {showProgress && trustedProgressStatus && (
        <section className="panel padded update-progress-card">
          <div
            className="update-progress-summary"
            role="status"
            aria-live="polite"
          >
            <strong>{taskSummary(trustedProgressStatus, taskPhase, it)}</strong>
            {trustedProgressStatus.targetVersion && (
              <span>
                {it.latestVersion}: v{trustedProgressStatus.targetVersion}
              </span>
            )}
            {taskPhase === "reconnecting" && (
              <small>{it.updateReconnecting}</small>
            )}
          </div>

          {shouldShowDownloadProgress(trustedProgressStatus) && (
            <div className="download-progress">
              <div className="download-progress-heading">
                <strong>{it.updateDownloading}</strong>
                <span>
                  {progressKnown ? `${percentage}%` : it.updateIndeterminate}
                </span>
              </div>
              <div
                className={`update-progress-track${progressKnown ? "" : " indeterminate"}`}
                role="progressbar"
                aria-label={it.updateDownloading}
                aria-valuemin={progressKnown ? 0 : undefined}
                aria-valuemax={progressKnown ? 100 : undefined}
                aria-valuenow={progressKnown ? percentage : undefined}
              >
                {progressKnown && <span style={{ width: `${percentage}%` }} />}
              </div>
              <div className="download-progress-meta">
                <span>
                  {formatBytes(downloaded)}
                  {total > 0 ? ` / ${formatBytes(total)}` : ""}
                </span>
                {Boolean(trustedProgressStatus.bytesPerSecond) && (
                  <span>
                    {it.updateSpeed}:{" "}
                    {formatBytes(trustedProgressStatus.bytesPerSecond)}/s
                  </span>
                )}
                {Boolean(trustedProgressStatus.etaSeconds) && (
                  <span>
                    {it.updateEta}:{" "}
                    {formatEta(trustedProgressStatus.etaSeconds || 0, it)}
                  </span>
                )}
              </div>
            </div>
          )}

          {renderStages(trustedProgressStatus)}

          {taskPhase === "rolling-back" && (
            <div className="update-recovery active" role="status">
              <LoaderCircle className="spin" />
              <span>{it.updateRollingBack}</span>
            </div>
          )}
        </section>
      )}

      {shouldShowResult && taskStatus && (
        <section className={`panel padded update-result-card ${taskPhase}`}>
          <div className={`update-task-result ${taskPhase}`} role="status">
            {taskPhase === "succeeded" ? (
              <Check size={24} />
            ) : (
              <XCircle size={24} />
            )}
            <div>
              <strong>{taskSummary(taskStatus, taskPhase, it)}</strong>
              {taskStatus.currentVersion && (
                <small>
                  {it.currentVersion}: v{taskStatus.currentVersion}
                </small>
              )}
            </div>
          </div>
          <button
            type="button"
            className="update-diagnostics-toggle"
            aria-expanded={diagnosticsOpen}
            onClick={() => void loadDiagnostics()}
          >
            {it.updateLogDetails}
          </button>
          {diagnosticsOpen && (
            <div className="update-diagnostics">
              {taskStatus.executorConfirmed && renderStages(taskStatus)}
              {taskStatus.message && taskPhase !== "succeeded" && (
                <p>{taskStatus.message}</p>
              )}
              {taskStatus.recoveryMessage && (
                <p>{taskStatus.recoveryMessage}</p>
              )}
              {taskStatus.buildCommit && (
                <p>
                  {it.updateBuildCommit}: {taskStatus.buildCommit}
                </p>
              )}
              {taskStatus.installInstanceId && (
                <p>
                  {it.updateInstallInstance}: {taskStatus.installInstanceId}
                </p>
              )}
              <pre>{diagnosticsLoading ? it.loading : diagnostics || ""}</pre>
            </div>
          )}
        </section>
      )}

      <section className="panel padded settings-card update-preferences">
        <div className="settings-card-title">
          <h2>{it.updateSettings}</h2>
        </div>
        <div className="settings-action">
          <div>
            <strong>{it.autoCheckUpdates}</strong>
            <p>{it.autoCheckUpdatesHelp}</p>
          </div>
          <button
            type="button"
            className="motion-switch"
            role="switch"
            aria-checked={autoCheck}
            aria-label={it.autoCheckUpdates}
            onClick={() => changeAutoCheck(!autoCheck)}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </section>

      {confirmationOpen && info?.latestVersion && (
        <FormDialog
          title={it.updateConfirmTitle}
          onClose={() => setConfirmationOpen(false)}
        >
          <form
            className="dialog-form confirm-update-dialog"
            data-form-dialog-body
            onSubmit={(event) => {
              event.preventDefault();
              void confirmUpdate();
            }}
          >
            <div className="confirm-update-icon" aria-hidden="true">
              <Download size={22} />
            </div>
            <p>{it.updateConfirm.replace("{version}", info.latestVersion)}</p>
            <div className="dialog-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmationOpen(false)}
              >
                {it.cancel}
              </Button>
              <Button type="submit">
                <Download size={17} />
                {it.updateNow}
              </Button>
            </div>
          </form>
        </FormDialog>
      )}
    </div>
  );
}
