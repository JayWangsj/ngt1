const childProcess = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const tracePath = process.env.NGT_READY_UPDATE_TRACE_FILE;
if (tracePath) {
  const originalSpawn = childProcess.spawn;
  const write = (entry) => {
    try {
      fs.appendFileSync(
        tracePath,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
        "utf8",
      );
    } catch {}
  };
  write({
    event: "hook-loaded",
    executableName: path.basename(process.execPath),
    entryPointName: process.argv[1] ? path.basename(process.argv[1]) : "",
  });

  childProcess.spawn = function tracedSpawn(command, args, options) {
    if (path.basename(String(command)).toLowerCase() !== "powershell.exe") {
      return originalSpawn.apply(this, arguments);
    }

    const argv = Array.isArray(args) ? args.map(String) : [];
    const valueAfter = (name) => {
      const index = argv.findIndex(
        (argument) => argument.toLowerCase() === name.toLowerCase(),
      );
      return index >= 0 ? argv[index + 1] || "" : "";
    };
    const scriptPath = valueAfter("-File");
    const entry = {
      event: "spawn-requested",
      scriptName: scriptPath ? path.basename(scriptPath) : "",
      updaterScriptName: valueAfter("-UpdaterScriptPath")
        ? path.basename(valueAfter("-UpdaterScriptPath"))
        : "",
      targetVersion: valueAfter("-ExpectedTargetVersion"),
      hasUpdateId: Boolean(valueAfter("-UpdateId")),
      hasStatusFile: Boolean(valueAfter("-StatusFile")),
      hasUpdateLockFile: Boolean(valueAfter("-UpdateLockFile")),
      hasLogFile: Boolean(valueAfter("-LogFile")),
      argumentCount: argv.length,
      detached: options?.detached === true,
    };
    write(entry);

    let child;
    try {
      child = originalSpawn.apply(this, arguments);
    } catch (error) {
      write({ event: "spawn-threw", errorCode: error?.code || null });
      throw error;
    }
    child.once("spawn", () => {
      write({ event: "process-created", pid: child.pid || null });
    });
    child.once("error", (error) => {
      write({ event: "process-error", errorCode: error?.code || null });
    });
    child.once("close", (code, signal) => {
      write({
        event: "process-closed",
        exitCode: code,
        signal: signal || null,
      });
    });
    return child;
  };
  syncBuiltinESMExports();
}
