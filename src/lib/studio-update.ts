import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appVersion } from "./version";

const repository = "JayWangsj/ngt1";
const previousRepositoryName = "JayWangsj/ngt-repair-system";

type CommandResult = { stdout: string; stderr: string };
type StudioUpdateLock = {
  updateId?: string;
  targetVersion?: string;
  createdAt?: string;
  executorPid?: number;
  executorPath?: string;
  operation?: "online-update";
};
type StudioUpdateMaintenance = {
  updateId?: string;
};
type CommandRunner = (
  executable: string,
  args: string[],
) => Promise<CommandResult>;
type ManagerCommand = (installRoot: string, args: string[]) => Promise<string>;
type UpdateMutationMutex = <T>(
  installRoot: string,
  action: () => Promise<T>,
) => Promise<T>;
type ProcessInspector = (options: {
  updateId?: string;
  executorPid?: number;
  updaterPath?: string;
  installRoot?: string;
}) => Promise<boolean | undefined>;
type AuthProcess = {
  stdin: { write: (value: string) => boolean; end: () => void };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once: {
    (event: "error", listener: (error: Error) => void): unknown;
    (event: "close", listener: (code: number | null) => void): unknown;
  };
  kill: () => boolean;
  unref: () => void;
};
type AuthProcessLauncher = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
    windowsHide: boolean;
  },
) => AuthProcess;
type CredentialStoreProbe = () => Promise<void>;

export type StudioUpdateStatus = {
  status:
    | "idle"
    | "starting"
    | "queued"
    | "running"
    | "checking"
    | "downloading"
    | "downloaded"
    | "verifying"
    | "preparing-runtime"
    | "backing-up"
    | "installing"
    | "validating"
    | "rolling-back"
    | "complete"
    | "superseded"
    | "failed"
    | "interrupted"
    | "verifying-task"
    | "unknown";
  message?: string;
  stage?: string;
  updateId?: string;
  targetVersion?: string;
  previousVersion?: string;
  currentVersion?: string;
  actualVersion?: string;
  installInstanceId?: string;
  buildCommit?: string;
  executorPid?: number;
  executorPath?: string;
  executorAlive?: boolean;
  executorConfirmed?: boolean;
  createdAt?: string;
  latestVersion?: string;
  completedStages?: string[];
  skippedStages?: string[];
  failedStage?: string;
  recoveryStatus?: "not-started" | "running" | "succeeded" | "failed";
  recoveryMessage?: string;
  manualReview?: boolean;
  previousStatus?: string;
  previousUpdateId?: string;
  manualInstallId?: string;
  operation?: "manual-install" | "online-update";
  installMode?: "first-install" | "upgrade" | "repair";
  bytesDownloaded?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  progressKnown?: boolean;
  updatedAt?: string;
};

export type StudioUpdateInfo = {
  installed: boolean;
  currentVersion: string;
  authRequired: boolean;
  updateAvailable: boolean;
  notInstallable?: boolean;
  latestVersion?: string;
  releaseUrl?: string;
  releaseName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  downloadSize?: number;
  installInstanceId?: string;
  buildCommit?: string;
  status?: StudioUpdateStatus;
};

export type GitHubLoginStatus = {
  status: "idle" | "opening" | "waiting" | "success" | "failed";
  message?: string;
  verificationUrl?: string;
  userCode?: string;
  updatedAt?: string;
};

const githubDeviceUrl = "https://github.com/login/device";
const activeGitHubLogins = new Map<string, AuthProcess>();
const authStatusWrites = new Map<string, Promise<void>>();
const processInspectionCache = new Map<
  string,
  { checkedAt: number; alive: boolean | undefined }
>();
const activeUpdateRoots = new Set<string>();
const updateMutationTails = new Map<string, Promise<void>>();
const updateChecksInFlight = new Map<string, Promise<StudioUpdateInfo>>();

async function acquireUpdateMutationMutex(installRoot: string) {
  const updaterPath = path.join(installRoot, "tools", "NGTUpdater.exe");
  if (!existsSync(updaterPath))
    throw new Error("The Rust updater is missing its lock command.");
  const readyPath = path.join(
    tmpdir(),
    `ngt-update-lock-${randomUUID()}.ready`,
  );
  const resultPath = path.join(tmpdir(), `ngt-update-lock-${randomUUID()}.txt`);
  const child = spawn(
    updaterPath,
    ["--hold-update-mutex", installRoot, readyPath, resultPath],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
  );
  let closed = false;
  let exitCode: number | null = null;
  const closePromise = new Promise<void>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      exitCode = code;
      resolve();
    });
  });

  return new Promise<() => Promise<void>>((resolve, reject) => {
    let settled = false;
    const cleanup = async () => {
      await Promise.all([
        unlink(readyPath).catch(() => undefined),
        unlink(resultPath).catch(() => undefined),
      ]);
    };
    const timeout = setTimeout(
      () => void fail(new Error("Timed out acquiring the update lock.")),
      12_000,
    );
    const fail = async (cause: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!closed) {
        child.stdin?.end();
        child.kill();
        await closePromise;
      }
      await cleanup();
      reject(cause);
    };
    const poll = async () => {
      while (!settled && !closed) {
        if (existsSync(readyPath)) {
          settled = true;
          clearTimeout(timeout);
          resolve(async () => {
            if (!closed) {
              child.stdin?.end();
              await closePromise;
            }
            await cleanup();
            if (exitCode !== 0)
              throw new Error(
                "The Rust update lock process did not exit cleanly.",
              );
          });
          return;
        }
        await new Promise((done) => setTimeout(done, 40));
      }
      if (settled) return;
      let result = "";
      try {
        result = await readFile(resultPath, "utf8");
      } catch {}
      await fail(
        new Error(
          result.startsWith("ERROR\n")
            ? result.slice(6).trim()
            : `Rust update lock exited with code ${exitCode ?? "unknown"}.`,
        ),
      );
    };
    child.once("error", (cause) => {
      void fail(
        new Error(`Unable to acquire the update lock: ${cause.message}`),
      );
    });
    void poll();
  });
}

async function withLocalUpdateMutationMutex<T>(
  installRoot: string,
  action: () => Promise<T>,
) {
  const key = path.resolve(installRoot).toLowerCase();
  const previous = updateMutationTails.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  updateMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (updateMutationTails.get(key) === tail) updateMutationTails.delete(key);
  }
}

async function withUpdateMutationMutex<T>(
  installRoot: string,
  action: () => Promise<T>,
) {
  if (process.platform !== "win32")
    return withLocalUpdateMutationMutex(installRoot, action);
  const release = await acquireUpdateMutationMutex(installRoot);
  try {
    return await action();
  } finally {
    await release();
  }
}

function runCommand(executable: string, args: string[]) {
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(
      executable,
      args,
      { timeout: 12_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          return reject(new Error(detail || error.message));
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function launchAuthProcess(
  executable: string,
  args: string[],
  options: Parameters<AuthProcessLauncher>[2],
) {
  return spawn(executable, args, options) as AuthProcess;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const contents = await readFile(filePath, "utf8");
    return JSON.parse(contents.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

async function readJsonState<T>(filePath: string) {
  try {
    const contents = await readFile(filePath, "utf8");
    return {
      exists: true,
      value: JSON.parse(contents.replace(/^\uFEFF/, "")) as T,
      unreadable: false,
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, value: null, unreadable: false };
    }
    return { exists: true, value: null, unreadable: true };
  }
}

async function readUpdateLock(filePath: string) {
  try {
    const contents = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    try {
      return {
        exists: true,
        value: JSON.parse(contents) as StudioUpdateLock,
        unreadable: false,
      };
    } catch {
      return { exists: true, value: null, unreadable: true };
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT")
      return { exists: false, value: null, unreadable: false };
    return { exists: true, value: null, unreadable: true };
  }
}

function runManagerCommand(installRoot: string, args: string[]) {
  const managerPath = path.join(installRoot, "tools", "NGTManager.exe");
  if (!existsSync(managerPath))
    return Promise.reject(new Error("The installed Rust manager is missing."));
  const resultPath = path.join(
    tmpdir(),
    `ngt-manager-command-${randomUUID()}.txt`,
  );
  return new Promise<string>((resolve, reject) => {
    execFile(
      managerPath,
      [...args, "--result-file", resultPath],
      { timeout: 120_000, windowsHide: true },
      (error) => {
        void (async () => {
          try {
            const result = await readFile(resultPath, "utf8");
            if (error || !result.startsWith("SUCCESS\n")) {
              reject(
                new Error(
                  result.startsWith("ERROR\n")
                    ? result.slice(6).trim()
                    : error?.message || "The Rust manager command failed.",
                ),
              );
              return;
            }
            resolve(result.slice(8).trim());
          } catch {
            reject(error || new Error("The Rust manager returned no result."));
          } finally {
            await unlink(resultPath).catch(() => undefined);
          }
        })();
      },
    );
  });
}

function inspectUpdaterProcess(
  options: Parameters<ProcessInspector>[0],
): Promise<boolean | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  if (!options.installRoot || !options.updateId?.match(/^[a-f\d-]{36}$/i))
    return Promise.resolve(undefined);
  const managerPath = path.join(options.installRoot, "tools", "NGTManager.exe");
  if (!existsSync(managerPath)) return Promise.resolve(undefined);
  const cacheKey = [
    path.resolve(options.installRoot).toLowerCase(),
    options.updateId,
  ].join(":");
  const cached = processInspectionCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < 3_000)
    return Promise.resolve(cached.alive);
  return new Promise((resolve) => {
    const resultPath = path.join(
      tmpdir(),
      `ngt-manager-update-process-${randomUUID()}.txt`,
    );
    execFile(
      managerPath,
      ["update-process", options.updateId!, "--result-file", resultPath],
      { timeout: 3_000, windowsHide: true },
      (error) => {
        void (async () => {
          let alive: boolean | undefined;
          try {
            const result = await readFile(resultPath, "utf8");
            if (!error && result.startsWith("SUCCESS\n")) {
              const value = JSON.parse(result.slice(8)) as { active?: unknown };
              if (typeof value.active === "boolean") alive = value.active;
            }
          } catch {
            alive = undefined;
          } finally {
            await unlink(resultPath).catch(() => undefined);
          }
          processInspectionCache.set(cacheKey, {
            checkedAt: Date.now(),
            alive,
          });
          resolve(alive);
        })();
      },
    );
  });
}

function activeTaskStatus(status?: string) {
  return [
    "starting",
    "queued",
    "running",
    "checking",
    "downloading",
    "downloaded",
    "verifying",
    "preparing-runtime",
    "backing-up",
    "installing",
    "validating",
    "rolling-back",
  ].includes(status || "");
}

function parseStatusTime(status: StudioUpdateStatus) {
  const timestamp = Date.parse(status.updatedAt || status.createdAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function statusMessage(status: StudioUpdateStatus, currentVersion: string) {
  const stage = status.stage || status.status || "unknown";
  return {
    status: "interrupted" as const,
    stage,
    previousStatus: status.status,
    updateId: status.updateId,
    targetVersion: status.targetVersion,
    latestVersion: status.latestVersion,
    currentVersion,
    previousVersion: status.previousVersion,
    actualVersion: currentVersion,
    completedStages: status.completedStages,
    failedStage: status.failedStage,
    message:
      "The update executor is no longer running. Check the update details before retrying.",
    updatedAt: status.updatedAt,
  };
}

function sameVersion(left?: string, right?: string) {
  return Boolean(
    left &&
    right &&
    left.replace(/^v/i, "").toLowerCase() ===
      right.replace(/^v/i, "").toLowerCase(),
  );
}

function validUpdateId(value?: string) {
  return Boolean(
    value && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value),
  );
}

function samePath(left?: string, right?: string) {
  if (!left || !right) return false;
  return (
    path
      .resolve(left)
      .replace(/[\\/]+$/, "")
      .toLowerCase() ===
    path
      .resolve(right)
      .replace(/[\\/]+$/, "")
      .toLowerCase()
  );
}

function safePreMutationStage(status: StudioUpdateStatus) {
  const stage = status.stage || status.failedStage || status.status;
  return (
    [
      "starting",
      "reading-release",
      "checking",
      "downloading",
      "downloaded",
      "verifying",
      "preparing-runtime",
    ].includes(stage || "") &&
    !(status.completedStages || []).some((completed) =>
      ["backing-up", "installing", "validating", "rolling-back"].includes(
        completed,
      ),
    )
  );
}

function safeToRetryUpdate(
  status: StudioUpdateStatus,
  currentVersion: string,
  activeRelease: string | undefined,
  root: string,
  maintenanceExists: boolean,
) {
  if (
    maintenanceExists ||
    !validUpdateId(status.updateId) ||
    !sameVersion(status.previousVersion, currentVersion) ||
    !samePath(activeRelease, root) ||
    status.recoveryStatus === "running" ||
    status.recoveryStatus === "failed"
  )
    return false;
  if (status.recoveryStatus === "succeeded")
    return sameVersion(status.actualVersion || currentVersion, currentVersion);
  return safePreMutationStage(status);
}

function normalizeVersion(value: string) {
  return value.replace(/^v/i, "").split("-")[0];
}

export function compareVersions(left: string, right: string) {
  const leftParts = normalizeVersion(left).split(".").map(Number);
  const rightParts = normalizeVersion(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function resolveGitHubCli(root: string) {
  const bundled = path.join(root, "runtime", "gh.exe");
  return existsSync(bundled) ? bundled : "gh";
}

function getAcceptanceReleaseApiBase() {
  if (process.env.GITHUB_ACTIONS !== "true") return undefined;
  const value = process.env.NGT_TEST_RELEASE_API_URL;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Boolean(url.port) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      return value.replace(/\/$/, "");
  } catch {
    return undefined;
  }
  return undefined;
}

async function getStudioContext(root: string) {
  const release = await readJson<{ version?: string; commit?: string }>(
    path.join(root, "studio-release.json"),
  );
  const config = await readJson<{
    installRoot?: string;
    activeRelease?: string;
    repository?: string;
  }>(
    process.env.NGT_MANAGER_ROOT
      ? path.join(process.env.NGT_MANAGER_ROOT, "state", "studio.json")
      : path.join(root, ".local", "studio.json"),
  );
  return {
    release,
    config,
    currentVersion: release?.version || appVersion,
    buildCommit: release?.commit,
    installInstanceId: createHash("sha256")
      .update(path.resolve(config?.installRoot || root).toLowerCase())
      .digest("hex")
      .slice(0, 16),
    repository:
      config?.repository === previousRepositoryName
        ? repository
        : config?.repository || repository,
  };
}

function statusPath(installRoot: string) {
  return path.join(installRoot, "state", "update-status.json");
}

function lockPath(installRoot: string) {
  return path.join(installRoot, "state", "update.lock");
}

function maintenancePath(installRoot: string) {
  return path.join(installRoot, "state", "update-maintenance.json");
}

function updateLogPath(installRoot: string, updateId: string) {
  return path.join(installRoot, "logs", `update-${updateId}.log`);
}

function authStatusPath(installRoot: string) {
  return path.join(installRoot, "state", "github-auth-status.json");
}

function writeGitHubLoginStatus(
  installRoot: string,
  status: GitHubLoginStatus,
) {
  const filePath = authStatusPath(installRoot);
  const previous = authStatusWrites.get(filePath) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({ ...status, updatedAt: new Date().toISOString() }),
        "utf8",
      );
    });
  authStatusWrites.set(filePath, next);
  void next.then(
    () => {
      if (authStatusWrites.get(filePath) === next)
        authStatusWrites.delete(filePath);
    },
    () => {
      if (authStatusWrites.get(filePath) === next)
        authStatusWrites.delete(filePath);
    },
  );
  return next;
}

function cleanGitHubOutput(value: string) {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function githubFailureMessage(output: string, fallback: string) {
  const cleaned = cleanGitHubOutput(output);
  if (!cleaned) return fallback;
  return cleaned.split("\n").filter(Boolean).slice(-3).join(" ");
}

function isGitHubAuthRequired(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /not logged in|not logged into|authentication (?:is )?required|token.{0,40}(?:expired|invalid|revoked)|(?:expired|invalid|revoked).{0,40}token|no authentication token/i.test(
    message,
  );
}

function resolveStudioRoot(root?: string) {
  return root || process.env.NGT_STUDIO_ROOT || process.cwd();
}

export async function getStudioUpdateStatus(
  root?: string,
  options: {
    inspect?: ProcessInspector;
    managerCommand?: ManagerCommand;
    mutationMutex?: UpdateMutationMutex;
    skipLockCleanup?: boolean;
  } = {},
): Promise<StudioUpdateStatus> {
  const studioRoot = resolveStudioRoot(root);
  const { config, currentVersion } = await getStudioContext(studioRoot);
  const installRoot = config?.installRoot;
  if (!installRoot) return { status: "idle" };
  const statusFile = await readJsonState<StudioUpdateStatus>(
    statusPath(installRoot),
  );
  const lockFile = await readUpdateLock(lockPath(installRoot));
  const maintenanceFile = await readJsonState<StudioUpdateMaintenance>(
    maintenancePath(installRoot),
  );
  if (lockFile.unreadable)
    return {
      status: "verifying-task",
      message:
        "The update lock cannot be read. Verify the task before retrying.",
      manualReview: true,
      currentVersion,
    };
  if (statusFile.unreadable)
    return {
      status: "verifying-task",
      message:
        "The saved update state cannot be read. Verify the task before retrying.",
      manualReview: true,
      currentVersion,
    };
  if (maintenanceFile.unreadable)
    return {
      status: "verifying-task",
      message:
        "The update maintenance state cannot be read. Verify the task before retrying.",
      manualReview: true,
      currentVersion,
    };

  const status = statusFile.value;
  if (!status) {
    if (maintenanceFile.exists)
      return {
        status: "verifying-task",
        currentVersion,
        message:
          "An update maintenance marker exists without a readable task status.",
        manualReview: true,
      };
    if (!lockFile.exists) return { status: "idle", currentVersion };
    if (lockFile.value?.updateId && activeUpdateRoots.has(installRoot))
      return {
        status: "verifying-task",
        updateId: lockFile.value.updateId,
        currentVersion,
        message: "The update executor is starting.",
      };
    const updaterPath =
      lockFile.value?.executorPath ||
      path.join(installRoot, "tools", "NGTUpdater.exe");
    const alive = await (options.inspect || inspectUpdaterProcess)({
      updateId: lockFile.value?.updateId,
      executorPid: lockFile.value?.executorPid,
      updaterPath,
      installRoot,
    });
    return alive === false
      ? {
          ...statusMessage({ status: "queued" }, currentVersion),
          manualReview: true,
          message:
            "An update lock exists without a readable task status. Verify the installed version and database before retrying.",
        }
      : {
          status: "verifying-task",
          updateId: lockFile.value?.updateId,
          currentVersion,
          executorAlive: alive,
          message: "An update lock exists without a readable task status.",
          manualReview: alive === undefined,
        };
  }

  if (
    (lockFile.exists && lockFile.value?.updateId !== status.updateId) ||
    (maintenanceFile.exists &&
      maintenanceFile.value?.updateId !== status.updateId)
  )
    return {
      ...status,
      status: "verifying-task",
      currentVersion,
      message:
        "The update lock, task status, and maintenance marker do not identify the same task.",
      manualReview: true,
    };

  if (status.status === "complete") {
    const target = status.targetVersion || status.latestVersion;
    if (!target || compareVersions(currentVersion, target) !== 0) {
      return {
        ...status,
        status: "interrupted",
        currentVersion,
        actualVersion: currentVersion,
        message: `The task reported completion, but the running version is ${currentVersion}.`,
        manualReview: true,
      };
    }
    if (!samePath(config?.activeRelease, studioRoot))
      return {
        ...status,
        status: "interrupted",
        currentVersion,
        actualVersion: currentVersion,
        message:
          "The running release does not match the active release configuration.",
        manualReview: true,
      };
    if (maintenanceFile.exists)
      return {
        ...status,
        status: "verifying-task",
        currentVersion,
        actualVersion: currentVersion,
        message:
          "The update reported completion, but the maintenance marker remains.",
        manualReview: true,
      };
    if (lockFile.exists) {
      if (options.skipLockCleanup)
        return {
          ...status,
          status: "complete",
          currentVersion,
          actualVersion: currentVersion,
        };
      const alive = await (options.inspect || inspectUpdaterProcess)({
        updateId: status.updateId,
        executorPid: lockFile.value?.executorPid,
        updaterPath:
          lockFile.value?.executorPath ||
          path.join(installRoot, "tools", "NGTUpdater.exe"),
        installRoot,
      });
      if (alive !== false)
        return {
          ...status,
          status: "verifying-task",
          currentVersion,
          executorAlive: alive,
          message:
            "The update passed validation and is releasing its task lock.",
          manualReview: alive === undefined,
        };
      const cleared = await (options.mutationMutex || withUpdateMutationMutex)(
        installRoot,
        async () => {
          const latestStatus = await readJsonState<StudioUpdateStatus>(
            statusPath(installRoot),
          );
          const latestLock = await readUpdateLock(lockPath(installRoot));
          const latestMarker = await readJsonState<StudioUpdateMaintenance>(
            maintenancePath(installRoot),
          );
          if (
            latestStatus.unreadable ||
            latestStatus.value?.status !== "complete" ||
            latestStatus.value?.updateId !== status.updateId ||
            latestLock.unreadable ||
            latestLock.value?.updateId !== status.updateId ||
            latestLock.value?.createdAt !== lockFile.value?.createdAt ||
            latestLock.value?.executorPid !== lockFile.value?.executorPid ||
            latestLock.value?.executorPath !== lockFile.value?.executorPath ||
            latestMarker.unreadable ||
            latestMarker.exists
          )
            return false;
          await (options.managerCommand || runManagerCommand)(installRoot, [
            "clear-update-lock",
            status.updateId || "",
            "complete",
          ]);
          return true;
        },
      ).catch(() => false);
      const remainingLock = await readUpdateLock(lockPath(installRoot));
      if (!cleared || remainingLock.exists || remainingLock.unreadable)
        return {
          ...status,
          status: "verifying-task",
          currentVersion,
          message:
            "The update passed validation, but its task lock could not be safely released.",
          manualReview: true,
        };
    }
    return { ...status, currentVersion, actualVersion: currentVersion };
  }

  if (status.status === "failed" && status.recoveryStatus === "succeeded") {
    if (
      !status.previousVersion ||
      !sameVersion(currentVersion, status.previousVersion) ||
      !samePath(config?.activeRelease, studioRoot) ||
      maintenanceFile.exists
    ) {
      return {
        ...status,
        recoveryStatus: "failed",
        recoveryMessage: !status.previousVersion
          ? "The previous version was not recorded, so the rollback cannot be verified."
          : maintenanceFile.exists
            ? "The update maintenance marker remains, so business writes are still blocked."
            : `The running version ${currentVersion} does not match the previous version ${status.previousVersion}.`,
        currentVersion,
        actualVersion: currentVersion,
        manualReview: true,
      };
    }
    return { ...status, currentVersion, actualVersion: currentVersion };
  }

  if (!activeTaskStatus(status.status))
    return { ...status, currentVersion, actualVersion: currentVersion };

  const now = Date.now();
  if (
    status.status === "starting" &&
    now - Date.parse(status.createdAt || status.updatedAt || "") < 10_000
  )
    return { ...status, currentVersion, executorAlive: false };
  const recentConfirmed =
    status.status !== "starting" &&
    status.updateId &&
    typeof status.executorPid === "number" &&
    status.executorConfirmed === true &&
    now - parseStatusTime(status) < 15_000;
  if (recentConfirmed)
    return { ...status, executorAlive: true, currentVersion };

  const updaterPath =
    status.executorPath ||
    lockFile.value?.executorPath ||
    path.join(installRoot, "tools", "NGTUpdater.exe");
  const alive = await (options.inspect || inspectUpdaterProcess)({
    updateId: status.updateId || lockFile.value?.updateId,
    executorPid: status.executorPid || lockFile.value?.executorPid,
    updaterPath,
    installRoot,
  });
  if (alive === false) {
    const interrupted = statusMessage(status, currentVersion);
    const safeToRetry = safeToRetryUpdate(
      interrupted,
      currentVersion,
      config?.activeRelease,
      studioRoot,
      maintenanceFile.exists,
    );
    return safeToRetry
      ? interrupted
      : {
          ...interrupted,
          manualReview: true,
          message:
            "The interrupted update may have stopped services or changed files. Verify the installed version, database, and maintenance state before retrying.",
        };
  }

  const starting = status.status === "starting" || status.status === "queued";
  if (alive === true && starting && status.updateId)
    return { ...status, executorAlive: true, currentVersion };
  if (alive === true && !starting && status.stage)
    return { ...status, executorAlive: true, currentVersion };
  if (alive === true)
    return {
      ...status,
      status: "verifying-task",
      executorAlive: true,
      currentVersion,
      previousStatus: status.status,
      message:
        "The executor is running, but has not reported a current stage yet.",
    };
  return {
    ...status,
    status: "verifying-task",
    executorAlive: alive,
    currentVersion,
    previousStatus: status.status,
    message: "The update task status is being verified.",
    manualReview: alive === undefined,
  };
}

export async function getStudioCurrentVersion(root?: string) {
  const { currentVersion } = await getStudioContext(resolveStudioRoot(root));
  return currentVersion;
}

export async function getStudioRuntimeInfo(root?: string) {
  const context = await getStudioContext(resolveStudioRoot(root));
  return {
    currentVersion: context.currentVersion,
    installInstanceId: context.installInstanceId,
    buildCommit: context.buildCommit,
    versionSource: context.release?.version
      ? "studio-release.json"
      : "package.json",
  };
}

export async function getStudioUpdateLog(root?: string) {
  const studioRoot = resolveStudioRoot(root);
  const { config } = await getStudioContext(studioRoot);
  const installRoot = config?.installRoot;
  if (!installRoot) return "";
  const status = await getStudioUpdateStatus(studioRoot);
  if (!status.updateId) return "";
  try {
    const contents = await readFile(
      updateLogPath(installRoot, status.previousUpdateId || status.updateId),
      "utf8",
    );
    return redactUpdateLog(contents.slice(-20_000));
  } catch {
    return "";
  }
}

function redactUpdateLog(contents: string) {
  return contents
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted token]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted token]")
    .replace(/(token\s*[:=]\s*)\S+/gi, "$1[redacted]");
}

export function sanitizeUpdateDiagnostic(value: string) {
  return redactUpdateLog(value);
}

export function sanitizeUpdateStatus(status: StudioUpdateStatus) {
  return {
    ...status,
    message: status.message
      ? sanitizeUpdateDiagnostic(status.message)
      : undefined,
    recoveryMessage: status.recoveryMessage
      ? sanitizeUpdateDiagnostic(status.recoveryMessage)
      : undefined,
  };
}

export async function getGitHubLoginStatus(
  root?: string,
): Promise<GitHubLoginStatus> {
  const { config } = await getStudioContext(resolveStudioRoot(root));
  if (!config?.installRoot) return { status: "idle" };
  return (
    (await readJson<GitHubLoginStatus>(authStatusPath(config.installRoot))) || {
      status: "idle",
    }
  );
}

async function performStudioUpdateCheck(
  options: {
    root?: string;
    targetVersion?: string;
    run?: CommandRunner;
    inspect?: ProcessInspector;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<StudioUpdateInfo> {
  const root = resolveStudioRoot(options.root);
  const run = options.run || runCommand;
  const fetchImpl = options.fetchImpl || fetch;
  const context = await getStudioContext(root);
  const status = await getStudioUpdateStatus(root, {
    inspect: options.inspect,
  });
  if (!context.release?.version) {
    return {
      installed: false,
      currentVersion: context.currentVersion,
      authRequired: false,
      updateAvailable: false,
      installInstanceId: context.installInstanceId,
      buildCommit: context.buildCommit,
      status,
    };
  }

  let latest: {
    tagName: string;
    name?: string;
    body?: string;
    url?: string;
    publishedAt?: string;
    assets?: { name?: string; size?: number }[];
  };
  const requestedTag = options.targetVersion
    ? "v" + options.targetVersion.replace(/^v/i, "")
    : undefined;
  const acceptanceReleaseApi = getAcceptanceReleaseApiBase();
  const useGitHubCli =
    !acceptanceReleaseApi &&
    (context.repository !== repository ||
      Boolean(
        requestedTag && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
      ));
  if (!useGitHubCli) {
    const releaseApi = acceptanceReleaseApi || "https://api.github.com";
    const releaseUrl = requestedTag
      ? releaseApi + "/repos/" + repository + "/releases/tags/" + requestedTag
      : releaseApi + "/repos/" + repository + "/releases/latest";
    const response = await fetchImpl(releaseUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "NGT-Studio-Updater",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `Unable to read the public GitHub release: HTTP ${response.status}.`,
      );
    const release = (await response.json()) as {
      tag_name: string;
      name?: string;
      body?: string;
      html_url?: string;
      published_at?: string;
      assets?: { name?: string; size?: number }[];
    };
    latest = {
      tagName: release.tag_name,
      name: release.name,
      body: release.body,
      url: release.html_url,
      publishedAt: release.published_at,
      assets: release.assets,
    };
  } else {
    const githubCli = resolveGitHubCli(root);
    try {
      await run(githubCli, [
        "auth",
        "status",
        "--hostname",
        "github.com",
        "--active",
      ]);
    } catch (cause) {
      if (!isGitHubAuthRequired(cause)) throw cause;
      return {
        installed: true,
        currentVersion: context.currentVersion,
        authRequired: true,
        updateAvailable: false,
        installInstanceId: context.installInstanceId,
        buildCommit: context.buildCommit,
        status,
      };
    }

    const releaseArguments = ["release", "view"];
    if (requestedTag) releaseArguments.push(requestedTag);
    releaseArguments.push(
      "--repo",
      context.repository,
      "--json",
      "tagName,name,body,url,publishedAt,assets",
    );
    const result = await run(githubCli, releaseArguments);
    latest = JSON.parse(result.stdout) as typeof latest;
  }
  const latestVersion = normalizeVersion(latest.tagName);
  const studioArchive = latest.assets?.find(
    (asset) => asset.name === `ngt-studio-windows-${latest.tagName}.zip`,
  );
  const studioChecksum = latest.assets?.find(
    (asset) => asset.name === `ngt-studio-windows-${latest.tagName}.zip.sha256`,
  );
  const runtimeArchive = latest.assets?.find(
    (asset) => asset.name === `ngt-studio-runtime-${latest.tagName}.zip`,
  );
  const runtimeChecksum = latest.assets?.find(
    (asset) => asset.name === `ngt-studio-runtime-${latest.tagName}.zip.sha256`,
  );
  const installer = latest.assets?.find(
    (asset) =>
      asset.name === "ngt-studio-windows-setup-" + latest.tagName + ".exe",
  );
  const installerChecksum = latest.assets?.find(
    (asset) =>
      asset.name ===
      "ngt-studio-windows-setup-" + latest.tagName + ".exe.sha256",
  );
  const isNewer = compareVersions(latestVersion, context.currentVersion) > 0;
  const installable = Boolean(
    studioArchive &&
    studioChecksum &&
    runtimeArchive &&
    runtimeChecksum &&
    installer &&
    installerChecksum,
  );
  return {
    installed: true,
    currentVersion: context.currentVersion,
    authRequired: false,
    updateAvailable: isNewer && installable,
    notInstallable: isNewer && !installable,
    latestVersion,
    releaseUrl: latest.url,
    releaseName: latest.name,
    releaseNotes: latest.body?.trim() || undefined,
    publishedAt: latest.publishedAt,
    downloadSize:
      typeof installer?.size === "number" ? installer.size : undefined,
    installInstanceId: context.installInstanceId,
    buildCommit: context.buildCommit,
    status,
  };
}

export function checkStudioUpdate(
  options: {
    root?: string;
    targetVersion?: string;
    run?: CommandRunner;
    inspect?: ProcessInspector;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<StudioUpdateInfo> {
  const root = resolveStudioRoot(options.root);
  const key = [
    path.resolve(root).toLowerCase(),
    options.targetVersion || "latest",
  ].join(":");
  const pending = updateChecksInFlight.get(key);
  if (pending) return pending;
  const request = performStudioUpdateCheck({ ...options, root }).finally(() => {
    if (updateChecksInFlight.get(key) === request)
      updateChecksInFlight.delete(key);
  });
  updateChecksInFlight.set(key, request);
  return request;
}

export async function startGitHubLogin(
  options: {
    root?: string;
    launch?: AuthProcessLauncher;
    run?: CommandRunner;
    checkCredentialStore?: CredentialStoreProbe;
    timeoutMs?: number;
  } = {},
) {
  const root = resolveStudioRoot(options.root);
  const context = await getStudioContext(root);
  if (!context.release?.version || !context.config?.installRoot) {
    throw new Error("studio_not_installed");
  }
  if (!samePath(context.config.activeRelease, root))
    throw new Error("studio_update_needs_manual_review");
  const installRoot = context.config.installRoot;
  if (activeGitHubLogins.has(root)) return getGitHubLoginStatus(root);

  const githubCli = resolveGitHubCli(root);
  if (process.env.GH_TOKEN) {
    const run = options.run || runCommand;
    await run(githubCli, [
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--active",
    ]);
    await run(githubCli, [
      "release",
      "view",
      "--repo",
      context.repository,
      "--json",
      "tagName",
    ]);
    const status = { status: "success" as const };
    await writeGitHubLoginStatus(installRoot, status);
    return status;
  }

  if (options.checkCredentialStore) await options.checkCredentialStore();

  const initialStatus: GitHubLoginStatus = {
    status: "opening",
    verificationUrl: githubDeviceUrl,
  };
  await writeGitHubLoginStatus(installRoot, initialStatus);

  const child = (options.launch || launchAuthProcess)(
    githubCli,
    [
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--web",
      "--clipboard",
      "--git-protocol",
      "https",
    ],
    {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  activeGitHubLogins.set(root, child);
  child.unref();

  let output = "";
  let finished = false;
  let userCode: string | undefined;
  const rememberOutput = (chunk: unknown) => {
    output = `${output}${String(chunk)}`.slice(-16_384);
    const nextCode = cleanGitHubOutput(output).match(
      /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/,
    )?.[0];
    if (nextCode && nextCode !== userCode) {
      userCode = nextCode;
      void writeGitHubLoginStatus(installRoot, {
        status: "waiting",
        verificationUrl: githubDeviceUrl,
        userCode,
      });
    }
  };
  child.stdout.on("data", rememberOutput);
  child.stderr.on("data", rememberOutput);

  // GitHub CLI waits for interactive confirmation before opening the browser
  // and starting device-code polling. The installed studio has no console, so
  // accept the default HTTPS credential prompt and the browser prompt here.
  child.stdin.write("\n\n");

  const finish = async (status: GitHubLoginStatus) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    activeGitHubLogins.delete(root);
    child.stdin.end();
    await writeGitHubLoginStatus(installRoot, status);
  };
  const timeout = setTimeout(
    () => {
      child.kill();
      void finish({
        status: "failed",
        message: "GitHub authorization timed out before it was completed.",
        verificationUrl: githubDeviceUrl,
        userCode,
      });
    },
    options.timeoutMs ?? 15 * 60_000,
  );
  timeout.unref();

  child.once("error", (error) => {
    void finish({
      status: "failed",
      message: error.message,
      verificationUrl: githubDeviceUrl,
      userCode,
    });
  });
  child.once("close", (code) => {
    void (async () => {
      if (code !== 0) {
        await finish({
          status: "failed",
          message: githubFailureMessage(
            output,
            `GitHub CLI exited with code ${code ?? "unknown"}.`,
          ),
          verificationUrl: githubDeviceUrl,
          userCode,
        });
        return;
      }
      try {
        const run = options.run || runCommand;
        await run(githubCli, [
          "auth",
          "status",
          "--hostname",
          "github.com",
          "--active",
        ]);
        await run(githubCli, [
          "release",
          "view",
          "--repo",
          context.repository,
          "--json",
          "tagName",
        ]);
        await finish({ status: "success" });
      } catch (cause) {
        await finish({
          status: "failed",
          message:
            cause instanceof Error
              ? `GitHub authorization completed, but the private repository is not accessible: ${cause.message}`
              : "GitHub authorization completed, but the private repository is not accessible.",
          verificationUrl: githubDeviceUrl,
          userCode,
        });
      }
    })();
  });
  return initialStatus;
}

export async function startStudioUpdate(
  options: {
    root?: string;
    inspect?: ProcessInspector;
    managerCommand?: ManagerCommand;
    mutationMutex?: UpdateMutationMutex;
    targetVersion?: string;
    fetchImpl?: typeof fetch;
    run?: CommandRunner;
  } = {},
) {
  const root = resolveStudioRoot(options.root);
  const context = await getStudioContext(root);
  const studioConfig = context.config;
  if (!context.release?.version || !studioConfig?.installRoot) {
    throw new Error("studio_not_installed");
  }
  const installRoot = studioConfig.installRoot;
  const lockFile = lockPath(installRoot);
  const updaterPath = path.resolve(installRoot, "tools", "NGTUpdater.exe");
  const managerCommand = options.managerCommand || runManagerCommand;
  if (!existsSync(updaterPath)) throw new Error("update_not_installable");
  const checked = await checkStudioUpdate({
    root,
    inspect: options.inspect,
    targetVersion: options.targetVersion,
    fetchImpl: options.fetchImpl,
    run: options.run,
  });
  const targetVersion =
    options.targetVersion?.replace(/^v/i, "") || checked.latestVersion;
  if (!targetVersion || checked.latestVersion !== targetVersion)
    throw new Error("update_target_changed");
  if (!checked.updateAvailable)
    throw new Error(
      checked.notInstallable
        ? "update_not_installable"
        : "update_no_longer_available",
    );

  const reservation = await (options.mutationMutex || withUpdateMutationMutex)(
    installRoot,
    async () => {
      if (activeUpdateRoots.has(installRoot))
        throw new Error("studio_update_in_progress");

      const previousTask = await getStudioUpdateStatus(root, {
        inspect: options.inspect,
        managerCommand,
        skipLockCleanup: true,
      });
      const maintenance = await readJsonState<StudioUpdateMaintenance>(
        maintenancePath(installRoot),
      );
      if (maintenance.unreadable || maintenance.exists)
        throw new Error("studio_update_needs_manual_review");
      if (
        previousTask.manualReview ||
        [
          "starting",
          "queued",
          "running",
          "checking",
          "downloading",
          "downloaded",
          "verifying",
          "preparing-runtime",
          "backing-up",
          "installing",
          "validating",
          "rolling-back",
          "verifying-task",
          "unknown",
        ].includes(previousTask.status)
      )
        throw new Error(
          previousTask.manualReview
            ? "studio_update_needs_manual_review"
            : "studio_update_in_progress",
        );
      if (
        ["failed", "interrupted"].includes(previousTask.status) &&
        !safeToRetryUpdate(
          previousTask,
          context.currentVersion,
          studioConfig.activeRelease,
          root,
          false,
        )
      )
        throw new Error("studio_update_needs_manual_review");
      if (
        previousTask.recoveryStatus === "failed" ||
        previousTask.recoveryStatus === "running"
      )
        throw new Error("studio_update_needs_manual_review");

      const existingLock = await readUpdateLock(lockFile);
      if (existingLock.unreadable)
        throw new Error("studio_update_needs_manual_review");
      if (existingLock.exists) {
        const lock = existingLock.value;
        const lockUpdateId = lock?.updateId;
        const completedTask =
          previousTask.status === "complete" &&
          sameVersion(
            previousTask.actualVersion || previousTask.currentVersion,
            context.currentVersion,
          );
        if (
          !validUpdateId(lockUpdateId) ||
          previousTask.updateId !== lockUpdateId ||
          (!completedTask &&
            !safeToRetryUpdate(
              previousTask,
              context.currentVersion,
              studioConfig.activeRelease,
              root,
              false,
            ))
        )
          throw new Error("studio_update_needs_manual_review");
        const createdAt = Date.parse(lock?.createdAt || "");
        const recentlyCreated =
          Number.isFinite(createdAt) && Date.now() - createdAt < 10_000;
        const alive = await (options.inspect || inspectUpdaterProcess)({
          updateId: lock?.updateId,
          executorPid: lock?.executorPid,
          updaterPath: lock?.executorPath || updaterPath,
          installRoot,
        });
        if (alive === true || alive === undefined || recentlyCreated)
          throw new Error("studio_update_in_progress");

        const latestLock = await readUpdateLock(lockFile);
        if (
          latestLock.unreadable ||
          !latestLock.exists ||
          latestLock.value?.updateId !== lockUpdateId ||
          latestLock.value?.createdAt !== lock?.createdAt ||
          latestLock.value?.executorPid !== lock?.executorPid ||
          latestLock.value?.executorPath !== lock?.executorPath
        )
          throw new Error("studio_update_in_progress");
        await managerCommand(installRoot, [
          "clear-update-lock",
          lockUpdateId || "",
          completedTask ? "complete" : "retry",
        ]);
      }

      const updateId = randomUUID();
      await managerCommand(installRoot, [
        "reserve-update",
        updateId,
        targetVersion,
      ]);
      activeUpdateRoots.add(installRoot);
      return { updateId };
    },
  );

  const { updateId } = reservation;
  try {
    const result = await managerCommand(installRoot, [
      "start-update",
      updateId,
    ]);
    const handshake = JSON.parse(result) as StudioUpdateStatus;
    if (
      handshake.updateId !== updateId ||
      handshake.executorConfirmed !== true ||
      !samePath(handshake.executorPath, updaterPath)
    )
      throw new Error(
        "The Rust manager returned an invalid updater handshake.",
      );
    return { ...handshake, logAvailable: true };
  } finally {
    activeUpdateRoots.delete(installRoot);
  }
}
