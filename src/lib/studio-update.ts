import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
type ProcessLauncher = (
  executable: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;
type ProcessInspector = (options: {
  updateId?: string;
  executorPid?: number;
  updaterPath?: string;
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
  const encodedInstallRoot = path.resolve(installRoot).replace(/'/g, "''");
  const script = [
    String.raw`Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class NgtUpdatePathIdentity {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetFinalPathNameByHandleW")]
  private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  public static string GetNormalizedPath(string path) {
    using (var handle = CreateFile(path, 0x80, 0x1 | 0x2 | 0x4, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var capacity = 512;
      while (true) {
        var buffer = new StringBuilder(capacity);
        var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length < buffer.Capacity) {
          var result = buffer.ToString().Replace('/', '\\');
          if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) result = @"\\" + result.Substring(8);
          else if (result.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) result = result.Substring(4);
          return result.TrimEnd('\\').ToLowerInvariant();
        }
        capacity = checked((int)length + 1);
      }
    }
  }
}
'@`,
    `$mutexRoot = [NgtUpdatePathIdentity]::GetNormalizedPath('${encodedInstallRoot}')`,
    "$sha256 = [System.Security.Cryptography.SHA256]::Create()",
    "try { $rootHash = [System.BitConverter]::ToString($sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($mutexRoot))).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }",
    '$mutex = [System.Threading.Mutex]::new($false, "Global\\NGTStudioUpdate-$rootHash")',
    "$owned = $false",
    "try {",
    "  try { $owned = $mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $owned = $true }",
    "  if (-not $owned) { throw 'Timed out waiting for the update lock.' }",
    "  [Console]::Out.WriteLine('NGT_UPDATE_MUTEX_ACQUIRED')",
    "  [Console]::Out.Flush()",
    "  [Console]::In.ReadLine() | Out-Null",
    "} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }",
  ].join("\n");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  let closed = false;
  let acquired = false;
  const closePromise = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });

  return new Promise<() => Promise<void>>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error("Timed out acquiring the update lock."));
    }, 12_000);
    const fail = (cause: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(cause);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (settled || !stdout.includes("NGT_UPDATE_MUTEX_ACQUIRED")) return;
      settled = true;
      acquired = true;
      clearTimeout(timeout);
      resolve(async () => {
        if (!acquired || closed) return;
        acquired = false;
        child.stdin?.end("\n");
        await Promise.race([
          closePromise,
          new Promise<void>((done) => setTimeout(done, 2_000)),
        ]);
        if (!closed) {
          child.kill();
          await closePromise;
        }
      });
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (cause) => {
      fail(new Error(`Unable to acquire the update lock: ${cause.message}`));
    });
    child.once("close", (code) => {
      if (!settled)
        fail(
          new Error(
            stderr.trim() ||
              `Update lock process exited with code ${code ?? "unknown"}.`,
          ),
        );
    });
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

function launchProcess(
  executable: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) {
  return spawn(executable, args, options);
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
      const legacyCreatedAt = contents.trim();
      if (Number.isFinite(Date.parse(legacyCreatedAt)))
        return {
          exists: true,
          value: { createdAt: legacyCreatedAt },
          unreadable: false,
        };
      return { exists: true, value: null, unreadable: true };
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT")
      return { exists: false, value: null, unreadable: false };
    return { exists: true, value: null, unreadable: true };
  }
}

async function writeJsonAtomically(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value), "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function inspectUpdaterProcess(
  options: Parameters<ProcessInspector>[0],
): Promise<boolean | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  if (!options.updaterPath) return Promise.resolve(false);
  const targetPath = path.resolve(options.updaterPath).toLowerCase();
  const cacheKey = [
    targetPath,
    options.executorPid || "scan",
    options.updateId || "legacy",
  ].join(":");
  const cached = processInspectionCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < 3_000)
    return Promise.resolve(cached.alive);

  const executablePath = targetPath.replace(/'/g, "''");
  const updateId = options.updateId?.match(/^[a-f\d-]{36}$/i)?.[0];
  const pid = Number.isInteger(options.executorPid) ? options.executorPid : 0;
  const script = [
    "$target = '" + executablePath + "'",
    "$expectedPid = " + pid,
    "$expectedUpdateId = '" + (updateId || "") + "'",
    "$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -eq 'NGTUpdater.exe' })",
    "if ($expectedPid -gt 0) { $processes = @($processes | Where-Object { $_.ProcessId -eq $expectedPid }) }",
    "$target = [System.IO.Path]::GetFullPath($target)",
    "$alive = $false",
    "foreach ($candidate in $processes) {",
    "  try { $candidatePath = [System.IO.Path]::GetFullPath([string]$candidate.ExecutablePath) } catch { continue }",
    "  if (-not $candidatePath.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) { continue }",
    "  if (-not $expectedUpdateId -or ([string]$candidate.CommandLine -notmatch [regex]::Escape($expectedUpdateId))) { continue }",
    "  $alive = $true",
    "  break",
    "}",
    "if ($alive) { 'true' } else { 'false' }",
  ].join("; ");

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 3_000, windowsHide: true },
      (error, stdout) => {
        const alive = error ? undefined : stdout.trim() === "true";
        processInspectionCache.set(cacheKey, { checkedAt: Date.now(), alive });
        resolve(alive);
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
    "starting-installer",
    "preparing-release",
    "verifying-backup",
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
    skippedStages: status.skippedStages,
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
      "starting-installer",
      "preparing-runtime",
    ].includes(stage || "") &&
    !(status.completedStages || []).some((completed) =>
      [
        "backing-up",
        "preparing-release",
        "verifying-backup",
        "preparing-runtime",
        "installing",
        "validating",
        "rolling-back",
      ].includes(completed),
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
  }>(path.join(root, ".local", "studio.json"));
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
  return path.join(installRoot, "update-status.json");
}

function lockPath(installRoot: string) {
  return path.join(installRoot, "update.lock");
}

function maintenancePath(installRoot: string) {
  return path.join(installRoot, ".local", "update-maintenance.json");
}

function updateLogPath(installRoot: string, updateId: string) {
  return path.join(installRoot, "logs", `update-${updateId}.log`);
}

function authStatusPath(installRoot: string) {
  return path.join(installRoot, "github-auth-status.json");
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
    skipMaintenanceCleanup?: boolean;
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
      path.join(studioRoot, "tools", "NGTUpdater.exe");
    const alive = await (options.inspect || inspectUpdaterProcess)({
      updateId: lockFile.value?.updateId,
      executorPid: lockFile.value?.executorPid,
      updaterPath,
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
          path.join(studioRoot, "tools", "NGTUpdater.exe"),
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
      const cleared = await withUpdateMutationMutex(installRoot, async () => {
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
        await unlink(lockPath(installRoot));
        return true;
      }).catch(() => false);
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
    if (
      maintenanceFile.exists &&
      status.updateId &&
      !options.skipMaintenanceCleanup
    ) {
      const cleared = await withUpdateMutationMutex(installRoot, async () => {
        const latestStatus = await readJsonState<StudioUpdateStatus>(
          statusPath(installRoot),
        );
        const latestLock = await readUpdateLock(lockPath(installRoot));
        const latestMarker = await readJsonState<StudioUpdateMaintenance>(
          maintenancePath(installRoot),
        );
        if (
          latestStatus.unreadable ||
          latestStatus.value?.updateId !== status.updateId ||
          latestLock.unreadable ||
          latestLock.exists ||
          latestMarker.unreadable ||
          latestMarker.value?.updateId !== status.updateId
        )
          return false;
        await unlink(maintenancePath(installRoot));
        return true;
      }).catch(() => false);
      const remainingMarker = await readJsonState<StudioUpdateMaintenance>(
        maintenancePath(installRoot),
      );
      if (!cleared || remainingMarker.exists || remainingMarker.unreadable)
        return {
          ...status,
          status: "interrupted",
          currentVersion,
          actualVersion: currentVersion,
          message:
            "The update completed, but its maintenance marker could not be safely cleared.",
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
    path.join(studioRoot, "tools", "NGTUpdater.exe");
  const alive = await (options.inspect || inspectUpdaterProcess)({
    updateId: status.updateId || lockFile.value?.updateId,
    executorPid: status.executorPid || lockFile.value?.executorPid,
    updaterPath,
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

  if (options.checkCredentialStore) {
    await options.checkCredentialStore();
  } else if (process.platform === "win32") {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(root, "scripts", "check-windows-credential-store.ps1"),
    ]);
  }

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
    launch?: ProcessLauncher;
    inspect?: ProcessInspector;
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
  const taskStatusFile = statusPath(installRoot);
  const updaterPath = path.resolve(root, "tools", "NGTUpdater.exe");
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

  const reservation = await withUpdateMutationMutex(installRoot, async () => {
    if (activeUpdateRoots.has(installRoot))
      throw new Error("studio_update_in_progress");

    const previousTask = await getStudioUpdateStatus(root, {
      inspect: options.inspect,
      skipMaintenanceCleanup: true,
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
        "starting-installer",
        "preparing-release",
        "verifying-backup",
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
      await unlink(lockFile);
    }

    const updateId = randomUUID();
    const createdAt = new Date().toISOString();
    const lock = {
      updateId,
      targetVersion,
      createdAt,
      executorPath: updaterPath,
      operation: "online-update" as const,
    };
    let lockCreated = false;
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lockHandle = await open(lockFile, "wx");
      lockCreated = true;
      await lockHandle.writeFile(JSON.stringify(lock), "utf8");
    } catch (cause) {
      if (lockCreated) await unlink(lockFile).catch(() => undefined);
      throw (cause as NodeJS.ErrnoException).code === "EEXIST"
        ? new Error("studio_update_in_progress")
        : cause;
    } finally {
      await lockHandle?.close().catch(() => undefined);
    }

    const status: StudioUpdateStatus = {
      status: "starting",
      stage: "starting",
      updateId,
      targetVersion,
      previousVersion: context.currentVersion,
      executorPath: updaterPath,
      createdAt,
      updatedAt: createdAt,
      executorConfirmed: false,
      operation: "online-update",
    };
    activeUpdateRoots.add(installRoot);
    try {
      await writeJsonAtomically(taskStatusFile, status);
    } catch (cause) {
      activeUpdateRoots.delete(installRoot);
      const createdLock = await readUpdateLock(lockFile);
      if (createdLock.value?.updateId === updateId)
        await unlink(lockFile).catch(() => undefined);
      throw cause;
    }
    return { updateId };
  });

  const { updateId } = reservation;
  try {
    const child = (options.launch || launchProcess)(
      updaterPath,
      [
        "--install-root",
        installRoot,
        "--release-root",
        root,
        "--update-id",
        updateId,
        "--target-version",
        targetVersion,
        "--repository",
        context.repository,
      ],
      { cwd: root, detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
    child.on("error", () => undefined);
    const handshake = await Promise.race([
      (async () => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const saved = await readJsonState<StudioUpdateStatus>(taskStatusFile);
          if (saved.unreadable) throw new Error("update_status_unreadable");
          if (
            saved.value?.updateId === updateId &&
            saved.value.status === "failed"
          )
            throw new Error(saved.value.message || "studio_updater_failed");
          if (
            saved.value?.updateId === updateId &&
            saved.value.executorConfirmed === true &&
            saved.value.executorPid === child.pid &&
            samePath(saved.value.executorPath, updaterPath)
          )
            return saved.value;
          if (child.exitCode !== null && child.exitCode !== undefined)
            throw new Error("updater_exited_before_handshake");
          if (child.signalCode !== null && child.signalCode !== undefined)
            throw new Error("updater_exited_before_handshake");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("updater_start_unconfirmed");
      })(),
      new Promise<never>((_resolve, reject) => {
        child.once("error", (error) =>
          reject(
            new Error("Unable to start the Rust updater: " + error.message),
          ),
        );
      }),
    ]);
    activeUpdateRoots.delete(installRoot);
    return { ...handshake, logAvailable: true };
  } catch (cause) {
    activeUpdateRoots.delete(installRoot);
    const latest = await readJsonState<StudioUpdateStatus>(taskStatusFile);
    const alive = await (options.inspect || inspectUpdaterProcess)({
      updateId,
      executorPid: latest.value?.executorPid,
      updaterPath,
    });
    if (latest.value?.updateId === updateId && latest.value.status !== "failed")
      await writeJsonAtomically(taskStatusFile, {
        ...latest.value,
        status: alive === false ? "failed" : "verifying-task",
        stage: latest.value.stage || "starting",
        failedStage: latest.value.stage || "starting",
        message:
          cause instanceof Error
            ? cause.message
            : "Unable to start the Rust updater.",
        executorAlive: alive === false ? false : alive,
        manualReview: alive !== false,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
    const currentLock = await readUpdateLock(lockFile);
    if (alive === false && currentLock.value?.updateId === updateId)
      await unlink(lockFile).catch(() => undefined);
    throw cause;
  }
}
