// Windows PostgreSQL cannot bootstrap UTF-8 clusters from a non-ASCII binary path.
// Copy only the database runtime to an ASCII temporary path; application files stay put.
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  rename,
  lstat,
  readdir,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolvePostgresRuntime } from "./postgres-runtime.mjs";

const workspace = resolve(process.env.NGT_RUNTIME_STATE ?? ".local");
const readyFile = join(workspace, "database-ready.pid");
let dataDir;
let stopping = false;
let shutdownFromManager = false;
let postgresProcess;
let controlInput = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  controlInput = `${controlInput}${chunk}`.slice(-128);
  const newline = controlInput.indexOf("\n");
  if (newline < 0) return;
  const command = controlInput.slice(0, newline).trim();
  controlInput = controlInput.slice(newline + 1);
  if (command !== "shutdown" || stopping) return;
  shutdownFromManager = true;
  stopping = true;
  void unlink(readyFile).catch(() => {});
  if (!postgresProcess) process.exit(0);
});
async function stopFromSignal() {
  if (stopping) return;
  stopping = true;
  await unlink(readyFile).catch(() => {});
  if (!postgresProcess) process.exit(0);
  try {
    await run("pg_ctl.exe", ["-D", dataDir, "-m", "fast", "stop"]);
    process.exit(0);
  } catch (error) {
    emitFailure(
      "database.postgres.stop_failed",
      "shutdown",
      safeErrorCode(error),
    );
    process.stderr.write("PostgreSQL could not be stopped cleanly.\n", () =>
      process.exit(1),
    );
  }
}
process.on("SIGINT", stopFromSignal);
process.on("SIGTERM", stopFromSignal);
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { runtime, cache } = await resolvePostgresRuntime();
const MAX_CAPTURE_BYTES = 64 * 1024;
const configuredDataRoot = process.env.NGT_DATA_ROOT?.trim();
const persistentRoot = configuredDataRoot
  ? resolve(configuredDataRoot)
  : workspace;
dataDir = configuredDataRoot
  ? join(persistentRoot, "postgres")
  : join(cache, "data");
const envFile = resolve(process.env.NGT_ENV_FILE ?? ".env");
const databasePort = Number(process.env.NGT_DB_PORT ?? "55432");
await mkdir(workspace, { recursive: true });
await mkdir(persistentRoot, { recursive: true });
await mkdir(cache, { recursive: true });
await writeFile(join(workspace, "database-location.txt"), dataDir);
await writeFile(join(workspace, "database-runtime-location.txt"), runtime);
let initialized = false;
async function inspectDatabaseDirectory(path) {
  let directory;
  try {
    directory = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Database path is not a regular directory.");
  try {
    const version = await lstat(join(path, "PG_VERSION"));
    if (!version.isFile() || version.isSymbolicLink())
      throw new Error(
        "Database directory is incomplete; existing data was preserved.",
      );
    return "initialized";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if ((await readdir(path)).length === 0) return "empty";
    throw new Error(
      "Database directory is incomplete; existing data was preserved.",
    );
  }
}

const databaseDirectoryState = await inspectDatabaseDirectory(dataDir);
initialized = databaseDirectoryState === "initialized";
const managerManaged = Boolean(process.env.NGT_MANAGER_ROOT);
const initOnly = process.env.NGT_DB_INIT_ONLY === "1";
const initOperationId = process.env.NGT_DB_INIT_OPERATION_ID ?? "";
let initializingDataDir;
if (initOnly) {
  if (!managerManaged || !/^[A-Za-z0-9-]{1,64}$/.test(initOperationId))
    throw new Error("Database initialization operation is invalid.");
  initializingDataDir = resolve(process.env.NGT_DB_INIT_DIRECTORY ?? "");
  const expectedInitializationDirectory = resolve(
    `${dataDir}.initializing-${initOperationId}`,
  );
  if (initializingDataDir !== expectedInitializationDirectory)
    throw new Error(
      "Database initialization directory does not match its operation.",
    );
  if (
    databaseDirectoryState !== "missing" &&
    databaseDirectoryState !== "empty"
  )
    throw new Error(
      "Database initialization cannot replace an existing database.",
    );
  const initDirectory = await lstat(initializingDataDir);
  if (!initDirectory.isDirectory() || initDirectory.isSymbolicLink())
    throw new Error(
      "Database initialization target is not a regular directory.",
    );
  if ((await readdir(initializingDataDir)).length !== 0)
    throw new Error("Database initialization target is not empty.");
} else if (managerManaged && !initialized) {
  throw new Error(
    "Database directory is missing or incomplete; existing data was preserved.",
  );
} else if (!managerManaged && databaseDirectoryState === "empty") {
  throw new Error(
    "Database directory is incomplete; existing data was preserved.",
  );
}
let secrets;
const secretsFile = join(persistentRoot, "local-secrets.json");
try {
  secrets = JSON.parse(await readFile(secretsFile, "utf8"));
  if (
    typeof secrets.password !== "string" ||
    !/^[0-9a-f]{48}$/.test(secrets.password) ||
    typeof secrets.authSecret !== "string" ||
    !/^[0-9a-f]{64}$/.test(secrets.authSecret)
  )
    throw new Error("invalid stored credentials");
} catch (error) {
  if (error.code !== "ENOENT")
    throw new Error(
      "Stored local database credentials are unreadable or invalid.",
    );
  if (initialized)
    throw new Error(
      "Database credentials are missing; existing data was preserved.",
    );
  secrets = {
    password: randomBytes(24).toString("hex"),
    authSecret: randomBytes(32).toString("hex"),
  };
  await writeFile(secretsFile, JSON.stringify(secrets), { flag: "wx" });
}
console.log(`Using PostgreSQL runtime at ${runtime}.`);
function safeErrorCode(error) {
  const code = error && typeof error.code === "string" ? error.code : "UNKNOWN";
  return /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN";
}
function emitFailure(eventCode, phase, errorCode, extra = {}) {
  process.stderr.write(
    `NGT_DIAGNOSTIC:${JSON.stringify({
      formatVersion: 1,
      diagnosticId: randomUUID(),
      component: "database",
      severity: "error",
      eventCode,
      phase,
      errorCode,
      attempts:
        Number.isInteger(extra.attempts) && extra.attempts >= 1
          ? Math.min(extra.attempts, 1000)
          : undefined,
      elapsedMs:
        Number.isInteger(extra.elapsedMs) && extra.elapsedMs >= 0
          ? Math.min(extra.elapsedMs, 600_000)
          : undefined,
      droppedDetailBytes:
        Number.isSafeInteger(extra.droppedDetailBytes) &&
        extra.droppedDetailBytes > 0
          ? Math.min(extra.droppedDetailBytes, 1_000_000_000_000)
          : undefined,
    })}\n`,
  );
}
function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(runtime, "bin", exe), args, {
      windowsHide: true,
      stdio: "pipe",
    });
    let output = "";
    let error = "";
    let outputBytes = 0;
    let errorBytes = 0;
    let capturedOutputBytes = 0;
    let capturedErrorBytes = 0;
    child.stdout.on("data", (chunk) => {
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - capturedOutputBytes);
      output += chunk.subarray(0, remaining).toString("utf8");
      capturedOutputBytes += Math.min(chunk.length, remaining);
      outputBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - capturedErrorBytes);
      error += chunk.subarray(0, remaining).toString("utf8");
      capturedErrorBytes += Math.min(chunk.length, remaining);
      errorBytes += chunk.length;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const failure = new Error(
        [`${exe} exited with code ${code}.`, output.trim(), error.trim()]
          .filter(Boolean)
          .join("\n"),
      );
      failure.code = `${exe.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_EXIT_${code ?? "UNKNOWN"}`;
      failure.droppedDetailBytes =
        Math.max(0, outputBytes - capturedOutputBytes) +
        Math.max(0, errorBytes - capturedErrorBytes);
      reject(failure);
    });
  });
}
if (!initialized) {
  initializingDataDir ??= `${dataDir}.initializing-${process.pid}`;
  const passwordFile = join(cache, "init-password");
  await writeFile(passwordFile, secrets.password);
  try {
    console.log(`Initializing PostgreSQL data at ${initializingDataDir}.`);
    try {
      await run("initdb.exe", [
        "-D",
        initializingDataDir,
        "-U",
        "ngt",
        "--auth=scram-sha-256",
        "--locale=C",
        "--encoding=UTF8",
        `--pwfile=${passwordFile}`,
      ]);
    } catch (error) {
      emitFailure(
        "database.initialization.failed",
        "initialization",
        safeErrorCode(error),
        { droppedDetailBytes: error.droppedDetailBytes },
      );
      await new Promise((resolve) =>
        process.stderr.write("PostgreSQL initialization failed.\n", resolve),
      );
      throw error;
    }
    if (initOnly) {
      await writeFile(
        join(initializingDataDir, ".ngt-install-owner"),
        initOperationId,
        { flag: "wx" },
      );
      await new Promise((resolveOutput) =>
        process.stdout.write(
          "PostgreSQL initialization completed for the install transaction.\n",
          resolveOutput,
        ),
      );
    } else {
      await rename(initializingDataDir, dataDir);
    }
  } finally {
    await unlink(passwordFile);
  }
}
if (initOnly) process.exit(0);
console.log(`Starting PostgreSQL from ${runtime}.`);
const postgres = spawn(
  join(runtime, "bin/postgres.exe"),
  ["-D", dataDir, "-h", "127.0.0.1", "-p", String(databasePort)],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
);
postgresProcess = postgres;
postgres.on("error", (error) => {
  emitFailure("database.postgres.start_failed", "spawn", safeErrorCode(error));
  process.stderr.write("PostgreSQL process could not be started.\n", () =>
    process.exit(1),
  );
});
let ready = false;
let earlyExitCode;
let postgresError = "";
let postgresErrorBytes = 0;
let postgresErrorCapturedBytes = 0;
postgres.stderr.on("data", (chunk) => {
  const remaining = Math.max(0, MAX_CAPTURE_BYTES - postgresErrorCapturedBytes);
  postgresError += chunk.subarray(0, remaining).toString("utf8");
  postgresErrorCapturedBytes += Math.min(chunk.length, remaining);
  postgresErrorBytes += chunk.length;
});
postgres.on("exit", (code, signal) => {
  if (shutdownFromManager) {
    if (code === 0) {
      process.exitCode = 0;
      return;
    }
    emitFailure(
      "database.postgres.stop_failed",
      "shutdown",
      `POSTGRES_EXIT_${code ?? "UNKNOWN"}`,
    );
    process.stderr.write("PostgreSQL did not stop cleanly.\n", () => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  if (stopping) return;
  const errorCode =
    code === 0 ? "POSTGRES_EXIT_0" : `POSTGRES_EXIT_${code ?? "UNKNOWN"}`;
  if (!ready) {
    earlyExitCode = errorCode;
    return;
  }
  emitFailure("database.postgres.exited", "runtime", errorCode, {
    droppedDetailBytes: postgresErrorBytes - postgresErrorCapturedBytes,
  });
  const details = [
    `postgres.exe exited with code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}.`,
    postgresErrorBytes > postgresErrorCapturedBytes
      ? `postgres stderr truncated; droppedBytes=${postgresErrorBytes - postgresErrorCapturedBytes}.`
      : "",
    postgresError.trim(),
  ]
    .filter(Boolean)
    .join("\n");
  process.stderr.write(`${details}\n`, () => process.exit(code || 1));
});
const connection = `postgresql://ngt:${secrets.password}@127.0.0.1:${databasePort}/`;
const readinessStarted = Date.now();
let readinessAttempts = 0;
let lastConnectionCode = "DB_READY_TIMEOUT";
for (let attempt = 0; attempt < 100; attempt++) {
  if (earlyExitCode) break;
  readinessAttempts = attempt + 1;
  const client = new Client({
    connectionString: `${connection}postgres`,
    connectionTimeoutMillis: 500,
  });
  try {
    await client.connect();
    const found = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = 'ngt'",
    );
    if (!found.rowCount) await client.query("CREATE DATABASE ngt");
    await client.end();
    ready = true;
    break;
  } catch (error) {
    lastConnectionCode = safeErrorCode(error);
    await client.end().catch(() => {});
    if (earlyExitCode || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!ready) {
  if (stopping) process.exit(0);
  const elapsedMs = Date.now() - readinessStarted;
  const errorCode =
    earlyExitCode ??
    (lastConnectionCode === "UNKNOWN"
      ? "DB_READY_TIMEOUT"
      : lastConnectionCode);
  emitFailure(
    "database.readiness.failed",
    earlyExitCode ? "early-exit" : "connection-check",
    errorCode,
    {
      attempts: readinessAttempts,
      elapsedMs,
      droppedDetailBytes: postgresErrorBytes - postgresErrorCapturedBytes,
    },
  );
  await new Promise((resolve) =>
    process.stderr.write(
      `Database readiness failed; attempts=${readinessAttempts}; elapsedMs=${elapsedMs}; errorCode=${errorCode}.\n${postgresError.trim()}\n`,
      resolve,
    ),
  );
  postgres.kill();
  throw new Error(
    `Database did not start; attempts=${readinessAttempts}; elapsedMs=${elapsedMs}; errorCode=${errorCode}.`,
  );
}
const env = (name) =>
  `DATABASE_URL="${connection}${name}?schema=public"\nAUTH_SECRET="${secrets.authSecret}"\nAUTH_URL="http://localhost:3000"\nAUTH_TRUST_HOST="true"\n`;
try {
  await mkdir(dirname(envFile), { recursive: true });
  const expectedEnv = env("ngt");
  await writeFile(envFile, expectedEnv, { flag: "wx" });
} catch (e) {
  if (e.code !== "EEXIST") throw e;
  if (configuredDataRoot && (await readFile(envFile, "utf8")) !== env("ngt"))
    throw new Error(
      "Runtime environment does not match the local database credentials.",
    );
}
await writeFile(readyFile, String(process.pid));
console.log(`Business PostgreSQL ready on 127.0.0.1:${databasePort}.`);
