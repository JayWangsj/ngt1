import { spawn } from "node:child_process";
import { join } from "node:path";
import { resolvePostgresRuntime } from "./postgres-runtime.mjs";

const { runtime } = await resolvePostgresRuntime();
const child = spawn(join(runtime, "bin", "pg_ctl.exe"), process.argv.slice(2), {
  windowsHide: true,
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
