// Windows PostgreSQL cannot bootstrap UTF-8 clusters from a non-ASCII binary path.
// Copy only the database runtime to an ASCII temporary path; application files stay put.
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  access,
  unlink,
  rename,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const packagedNative = resolve("runtime/postgres");
let native;
try {
  await access(join(packagedNative, "bin/postgres.exe"));
  native = packagedNative;
} catch {
  const embeddedRequire = createRequire(require.resolve("embedded-postgres"));
  native = resolve(
    dirname(embeddedRequire.resolve("@embedded-postgres/windows-x64")),
    "../native",
  );
}
const workspace = resolve(".local");
const readyFile = join(workspace, "database-ready.pid");
const cache = join(
  tmpdir(),
  `ngt-pg-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 10)}`,
);
const runtime = /[^\x00-\x7F]/.test(native) ? join(cache, "runtime") : native;
const configuredDataRoot = process.env.NGT_DATA_ROOT?.trim();
const persistentRoot = configuredDataRoot
  ? resolve(configuredDataRoot)
  : workspace;
if (/[^\x00-\x7F]/.test(cache))
  throw new Error(
    "Set TEMP to an ASCII-only directory for the Windows PostgreSQL runtime.",
  );
await mkdir(workspace, { recursive: true });
await mkdir(persistentRoot, { recursive: true });
let secrets;
try {
  secrets = JSON.parse(
    await readFile(join(persistentRoot, "local-secrets.json"), "utf8"),
  );
} catch {
  secrets = {
    password: randomBytes(24).toString("hex"),
    authSecret: randomBytes(32).toString("hex"),
  };
  await writeFile(
    join(persistentRoot, "local-secrets.json"),
    JSON.stringify(secrets),
  );
}
await mkdir(cache, { recursive: true });
if (runtime === native) {
  console.log(`Using packaged PostgreSQL runtime at ${runtime}.`);
} else {
  console.log(`Preparing PostgreSQL runtime at ${runtime}.`);
  try {
    await access(join(runtime, "bin/postgres.exe"));
  } catch {
    await cp(native, runtime, {
      recursive: true,
      dereference: true,
    });
  }
}
function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(runtime, "bin", exe), args, {
      windowsHide: true,
      stdio: "pipe",
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          [`${exe} exited with code ${code}.`, output.trim(), error.trim()]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}
const dataDir = configuredDataRoot
  ? join(persistentRoot, "data")
  : join(cache, "data");
await writeFile(join(workspace, "database-location.txt"), dataDir);
await writeFile(join(workspace, "database-runtime-location.txt"), runtime);
let initialized = false;
try {
  await access(join(dataDir, "PG_VERSION"));
  initialized = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!initialized) {
  try {
    await access(dataDir);
    const incompleteDataDir = `${dataDir}.incomplete-${Date.now()}`;
    await rename(dataDir, incompleteDataDir);
    console.warn(`Preserved incomplete database at ${incompleteDataDir}.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const initializingDataDir = `${dataDir}.initializing-${process.pid}`;
  const passwordFile = join(cache, "init-password");
  await writeFile(passwordFile, secrets.password);
  try {
    console.log(`Initializing PostgreSQL data at ${initializingDataDir}.`);
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
    await rename(initializingDataDir, dataDir);
  } finally {
    await unlink(passwordFile);
  }
}
console.log(`Starting PostgreSQL from ${runtime}.`);
const postgres = spawn(
  join(runtime, "bin/postgres.exe"),
  ["-D", dataDir, "-h", "127.0.0.1", "-p", "55432"],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
);
postgres.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
let ready = false;
let postgresError = "";
postgres.stderr.on("data", (chunk) => {
  postgresError += String(chunk);
});
postgres.on("exit", (code, signal) => {
  if (!ready || code) {
    const details = [
      `postgres.exe exited with code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}.`,
      postgresError.trim(),
    ]
      .filter(Boolean)
      .join("\n");
    process.stderr.write(`${details}\n`, () => process.exit(code || 1));
  }
});
const connection = `postgresql://ngt:${secrets.password}@127.0.0.1:55432/`;
for (let attempt = 0; attempt < 100; attempt++) {
  const client = new Client({ connectionString: `${connection}postgres` });
  try {
    await client.connect();
    const found = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = 'ngt'",
    );
    if (!found.rowCount) await client.query("CREATE DATABASE ngt");
    await client.end();
    ready = true;
    break;
  } catch {
    await client.end().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!ready) {
  postgres.kill();
  throw new Error("Database did not start.");
}
const env = (name) =>
  `DATABASE_URL="${connection}${name}?schema=public"\nAUTH_SECRET="${secrets.authSecret}"\nAUTH_URL="http://localhost:3000"\nAUTH_TRUST_HOST="true"\n`;
try {
  await writeFile(".env", env("ngt"), { flag: "wx" });
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}
await writeFile(readyFile, String(process.pid));
console.log("Business PostgreSQL ready on 127.0.0.1:55432.");
async function stop() {
  await unlink(readyFile).catch(() => {});
  await run("pg_ctl.exe", ["-D", dataDir, "-m", "fast", "stop"]);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
