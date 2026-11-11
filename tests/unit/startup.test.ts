import { fork, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows persistent startup", () => {
  it("supervises both the database and application without machine-specific paths", async () => {
    const manager = await readFile("tools/ngt-updater/src/manager.rs", "utf8");
    expect(manager).toContain("fn start_supervised_runtime(");
    expect(manager).toContain("RuntimeJob::new()?");
    expect(manager).toMatch(/start_database\(\s*&job/);
    expect(manager).toMatch(/start_application\(\s*&application_job/);
    expect(manager).toContain("wait_for_health(&mut application");
    expect(manager).toContain("fn stop_children(");
    const databaseStop = manager.slice(
      manager.indexOf("fn stop_database_launcher("),
      manager.indexOf(
        "fn pg_ctl_status(",
        manager.indexOf("fn stop_database_launcher("),
      ),
    );
    expect(databaseStop).toContain("spawn_pg_ctl_until(");
    expect(databaseStop).toContain(
      "session_shutdown_deadline(deadline, 4_000)",
    );
    expect(databaseStop).toContain('std::ffi::OsString::from("fast")');
    expect(databaseStop).toContain('write_all(b"shutdown\\n")');
    expect(databaseStop).not.toContain("Command::new");
    const stopChildren = manager.slice(
      manager.indexOf("fn stop_children("),
      manager.indexOf(
        "struct StopOutcome",
        manager.indexOf("fn stop_children("),
      ),
    );
    expect(stopChildren.indexOf("stop_application(")).toBeLessThan(
      stopChildren.indexOf("stop_database_launcher("),
    );
    expect(stopChildren).toContain("application-stop-unconfirmed");
    expect(stopChildren).toContain("database-stop-unconfirmed");
    expect(stopChildren).toContain('run_state.source == "runtime-exit"');
    expect(stopChildren).toContain("runtime.shutdown.restart_cleanup");
    expect(manager).toContain("fn session_shutdown_deadline(");
    expect(manager).toContain("WINDOWS_SESSION_END_TICK");
    expect(manager).toContain("let mut restarts = 0;");
    expect(manager).toContain("if restarts >= 3");
    expect(manager).not.toContain("D:\\NGT");
  });

  it("keeps memory collection off the runtime control loop with one bounded worker", async () => {
    const sampling = await readFile(
      "tools/ngt-updater/src/memory_sample.rs",
      "utf8",
    );
    const diagnosticRoute = await readFile(
      "src/app/api/diagnostics/export/route.ts",
      "utf8",
    );
    const manager = await readFile("tools/ngt-updater/src/manager.rs", "utf8");
    const tick = sampling.slice(
      sampling.indexOf("pub fn tick("),
      sampling.indexOf(
        "pub fn interrupt_for_shutdown(",
        sampling.indexOf("pub fn tick("),
      ),
    );
    const interrupt = sampling.slice(
      sampling.indexOf("pub fn interrupt_for_shutdown("),
      sampling.indexOf(
        "fn start_task(",
        sampling.indexOf("pub fn interrupt_for_shutdown("),
      ),
    );
    expect(tick).not.toContain("collect_job_processes(");
    expect(tick).toContain("start_pending_sample(");
    expect(tick).toContain("if sample_ms >= SAMPLE_SECONDS * 1000");
    expect(tick).not.toContain("|| active.next_sample == PLANNED_SAMPLES");
    expect(sampling).toContain("sync_channel(MAX_PROCESSES_PER_POINT + 2)");
    expect(sampling).toContain('then_some("SAMPLE_BUDGET_EXCEEDED")');
    expect(sampling).toContain("for job in [database_job, application_job]");
    expect(sampling).toContain("IsProcessInJob(");
    expect(manager).toContain(
      "memory_sampler.tick(job.0, children.application_job.0, &config.version)",
    );
    expect(interrupt).toContain(
      "pending.cancelled.store(true, Ordering::Relaxed)",
    );
    expect(interrupt).not.toContain("append_record(");
    expect(sampling).toContain("if status.ended_reason.is_none()");
    expect(sampling).toContain("status.expires_at_utc = expiry_time();");
    expect(sampling).toContain("MAX_REPORT_BYTES.saturating_sub(12 * 1024)");
    expect(sampling).toContain("processes={} (sample IDs {})");
    expect(sampling).toContain('open(base.join("enqueue.lock"))');
    expect(sampling).toContain("current.request_id != request_id");
    expect(sampling).toContain('"RECORDING_FAILED"');
    expect(sampling).toContain(
      "metadata.file_type().is_symlink() || metadata.len() > MAX_REPORT_BYTES",
    );
    expect(diagnosticRoute).toContain(
      'if (requestId && typeof status.taskId === "string")',
    );
    expect(diagnosticRoute).toContain('"REQUEST_EXPIRED"');
    expect(
      diagnosticRoute.indexOf(
        "const expiresAtUtc = status.expiresAtUtc;",
      ),
    ).toBeGreaterThan(
      diagnosticRoute.indexOf(
        'if (requestId && typeof status.taskId === "string")',
      ),
    );
  });

  it("waits for database initialization before starting the application", async () => {
    const manager = await readFile("tools/ngt-updater/src/manager.rs", "utf8");
    const supervisor = manager.slice(
      manager.indexOf("fn start_supervised_runtime("),
      manager.indexOf(
        "fn run_supervisor(",
        manager.indexOf("fn start_supervised_runtime("),
      ),
    );
    const database = await readFile("scripts/windows-db.mjs", "utf8");
    expect(
      supervisor.indexOf("let mut database = start_database("),
    ).toBeLessThan(
      supervisor.search(/let mut application\s*=\s*match start_application\(/),
    );
    expect(manager).toContain('join("database-ready.pid")');
    expect(manager).toContain("ready_process_id == Some(database.id())");
    expect(manager).toContain("fn stop_application(");
    expect(manager).toContain('write_all(b"shutdown\\n")');
    expect(manager).toContain("&children.application_job,");
    expect(manager).toContain("return ensure_legacy_runtime_confirmed(root)");
    expect(manager).toContain("resolvePostgresRuntime");
    expect(manager).toContain("pg_controldata.exe");
    expect(manager).toContain("postgres_cluster_is_clean");
    expect(database).toContain('join(workspace, "database-ready.pid")');
    expect(database).toContain("String(process.pid)");
    expect(database).toContain('process.stdin.on("data"');
    expect(database).toContain("shutdownFromManager = true");
    expect(database).toContain("if (shutdownFromManager)");
    expect(database.indexOf('process.stdin.on("data"')).toBeLessThan(
      database.indexOf("await resolvePostgresRuntime()"),
    );
  });

  it("holds bundled Node processes until the manager releases the startup gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ngt-start-gate-"));
    const gate = join(directory, "start.gate");
    await writeFile(gate, "pending");
    const child = spawn(
      process.execPath,
      [
        "--require",
        "./scripts/runtime-start-gate.cjs",
        "-e",
        "const fs = require('node:fs'); if (fs.existsSync(process.env.TEST_GATE_PATH)) process.exit(2); process.stdout.write('released')",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NGT_RUNTIME_START_GATE: gate,
          TEST_GATE_PATH: gate,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    const completion = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(output).toBe("");
      await writeFile(gate, "ready");
      const result = await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Node startup gate timed out.")),
            5000,
          );
        }),
      ]);
      expect(result).toEqual({ code: 0, signal: null });
      expect(output).toBe("released");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([
          completion.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("relays manager shutdown to the Next server process", async () => {
    const bootstrap = await readFile("scripts/start.mjs", "utf8");
    expect(bootstrap).toContain('child.send({ type: "ngt:shutdown" })');
    expect(bootstrap).toContain(
      'stdio: ["inherit", "inherit", "inherit", "ipc"]',
    );
    const directory = await mkdtemp(join(tmpdir(), "ngt-runtime-shutdown-"));
    const fixture = join(directory, "shutdown-fixture.cjs");
    const bridge = join(process.cwd(), "scripts/next-shutdown-bridge.cjs");
    await writeFile(
      fixture,
      'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);',
    );
    const child = fork(fixture, [], {
      execArgv: ["--require", bridge],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const closed = new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.send({ type: "ngt:shutdown" });
    try {
      const code = await closed;
      expect(code).toBe(0);
    } finally {
      clearTimeout(timeout);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forwards manager shutdown over IPC to the Next process handler", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ngt-next-shutdown-"));
    const childScript = join(directory, "child.cjs");
    await writeFile(
      childScript,
      'process.on("SIGTERM", () => { process.send({ type: "closed" }); process.exit(0); });\n',
    );
    const child = fork(childScript, [], {
      cwd: process.cwd(),
      execArgv: [
        "--require",
        join(process.cwd(), "scripts/next-shutdown-bridge.cjs"),
      ],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Shutdown timed out.")),
          3000,
        );
        child.once("message", (message) => {
          clearTimeout(timeout);
          expect(message).toEqual({ type: "closed" });
          resolve();
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.send({ type: "ngt:shutdown" });
      });
    } finally {
      if (child.exitCode === null) child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("registers per-user startup directly to the Rust manager", async () => {
    const manager = await readFile("tools/ngt-updater/src/manager.rs", "utf8");
    const autostart = manager.slice(
      manager.indexOf("fn set_autostart("),
      manager.indexOf(
        "fn read_build_number(",
        manager.indexOf("fn set_autostart("),
      ),
    );
    expect(autostart).toContain(
      "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run",
    );
    expect(autostart).toContain('root.join("tools").join("NGTManager.exe")');
    expect(autostart).toContain(
      'format!("\\\"{}\\\" run", executable.display())',
    );
    expect(autostart).not.toContain("ScheduledTask");
    expect(autostart).not.toContain("wscript.exe");
  });

  it("runs real Windows release acceptance with a disposable standard user", async () => {
    const runner = await readFile(
      "scripts/run-windows-studio-acceptance-as-standard-user.ps1",
      "utf8",
    );
    const workflow = await readFile(
      ".github/workflows/windows-studio-release.yml",
      "utf8",
    );
    const acceptanceAction = await readFile(
      ".github/actions/windows-studio-acceptance/action.yml",
      "utf8",
    );
    const installerAcceptance = await readFile(
      "scripts/test-windows-studio-installer.ps1",
      "utf8",
    );
    const acceptanceCoordinator = await readFile(
      "scripts/windows-studio-acceptance-coordinator.ps1",
      "utf8",
    );
    expect(runner).toContain("New-LocalUser -Name $userName");
    expect(runner).toContain(
      '-Description "NGT release acceptance standard account"',
    );
    expect(runner).toContain("-Credential $credential -LoadUserProfile");
    expect(runner).toContain("Windows acceptance must run as a standard user");
    expect(runner).toContain("resultPath = $resultPath");
    expect(runner).toContain(
      "Set-Content -LiteralPath $request.resultPath -Value $childExitCode -Encoding ascii",
    );
    expect(runner).toContain("Get-NgtAcceptanceProcessOutcome");
    expect(runner).toContain(
      '$orchestrationOnlyParameters = @("TargetTag", "ExpectedCommitSha", "ExpectedManifestPath")',
    );
    expect(runner).toContain("$entry.Name -notin $orchestrationOnlyParameters");
    expect(acceptanceCoordinator).toContain("Get-NgtAcceptanceChildExitCode");
    expect(acceptanceCoordinator).toContain(
      "The standard-user acceptance wrote an invalid exit result.",
    );
    expect(acceptanceCoordinator).toContain("disagrees with process exit code");
    expect(runner).toContain("Remove-LocalUser -Name $userName");
    expect(workflow).toContain("./.github/actions/windows-studio-acceptance");
    expect(workflow).toContain("acceptance: online-update");
    expect(workflow).toContain("acceptance: installer");
    expect(acceptanceAction).toContain(
      "run-windows-studio-acceptance-as-standard-user.ps1 -Acceptance ${{ inputs.acceptance }}",
    );
    expect(acceptanceAction).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(acceptanceAction).toContain(
      "GH_TOKEN: ${{ inputs.acceptance == 'production-update' && github.token || '' }}",
    );
    expect(installerAcceptance).toContain(
      "[string]$health.buildCommit -ieq $env:GITHUB_SHA",
    );
    expect(installerAcceptance).toContain("verify-windows-studio-runtime.ps1");
    expect(installerAcceptance).toContain('repair "{0}"');
    expect(installerAcceptance).toContain("NGTManager repair");
    expect(installerAcceptance).not.toContain("/api/system-update");
  });

  it("ships only Node runtime scripts for application and database startup", async () => {
    const packager = await readFile(
      "scripts/build-windows-studio-package.ps1",
      "utf8",
    );
    expect(packager).toContain('"start.mjs"');
    expect(packager).toContain('"next-shutdown-bridge.cjs"');
    expect(packager).toContain('"verify-windows-studio-static-assets.mjs"');
    expect(packager).toContain('"windows-db.mjs"');
    expect(packager).toContain('"postgres-runtime.mjs"');
    expect(packager).toContain('"runtime-start-gate.cjs"');
    expect(packager).toContain('"run-pg-ctl.mjs"');
    expect(packager).not.toContain('"windows-service.ps1"');
    expect(packager).not.toContain('"windows-studio-launcher.vbs"');
    expect(packager).not.toContain('"install-windows-startup.ps1"');
    expect(packager).not.toContain('"verify-windows-studio-runtime.ps1"');
  });

  it("keeps the actual Next server alive until the manager requests graceful shutdown", async () => {
    const start = await readFile("scripts/start.mjs", "utf8");
    const bridge = await readFile("scripts/next-shutdown-bridge.cjs", "utf8");
    expect(start).toContain("fork(");
    expect(start).toContain('process.stdin.on("data"');
    expect(start).toContain('child.send({ type: "ngt:shutdown" })');
    expect(start).not.toContain('child.kill("SIGTERM")');
    expect(bridge).toContain('process.listenerCount("SIGTERM")');
    expect(bridge).toContain('process.emit("SIGTERM")');
  });

  it("provides a PowerShell 5.1 wrapper for the shared external Rust sampler", async () => {
    const script = await readFile("scripts/measure-runtime-memory.ps1", "utf8");
    const manager = await readFile("tools/ngt-updater/src/manager.rs", "utf8");
    expect(script).toContain("[uint32]$RootPid");
    expect(script).toContain("[string]$OutputRoot");
    expect(script).toContain("[uint32]$WarmupSeconds = 120");
    expect(script).toContain("[uint32]$DurationSeconds = 600");
    expect(script).toContain("[uint32]$IntervalSeconds = 2");
    expect(script).toContain("$target.CommandLine -notmatch");
    expect(script).toContain("memory-sample-external");
    expect(manager).toContain("memory_sample::run_external(");
  });

  it("keeps the isolated test preview on a fixed restart-safe port", async () => {
    const service = await readFile(
      "scripts/windows-preview-service.ps1",
      "utf8",
    );
    const installer = await readFile(
      "scripts/install-windows-preview-startup.ps1",
      "utf8",
    );
    const launcher = await readFile(
      "scripts/windows-preview-launcher.vbs",
      "utf8",
    );
    const uninstaller = await readFile(
      "scripts/uninstall-windows-preview-startup.ps1",
      "utf8",
    );
    const testDatabase = await readFile("scripts/windows-test-db.mjs", "utf8");
    const shortcutInstaller = await readFile(
      "scripts/install-windows-preview-shortcut.ps1",
      "utf8",
    );
    const desktopLauncher = await readFile(
      "scripts/windows-preview-desktop-launcher.cs",
      "utf8",
    );
    expect(service).toContain('"test.env"');
    expect(service).toContain('$env:PORT = "3236"');
    expect(service).toContain(
      'Join-Path $projectRoot "scripts\\windows-test-db.mjs"',
    );
    expect(service).toContain(
      'Join-Path $projectRoot "node_modules\\next\\dist\\bin\\next"',
    );
    expect(service).toContain("dev --hostname 127.0.0.1 --port 3236");
    expect(service).toContain(
      "Get-NetTCPConnection -LocalPort $Port -State Listen",
    );
    expect(service).toContain("CmdletizationQuery_NotFound,*");
    expect(service).toContain("Get-NgtPortConnections");
    expect(service).toContain("Select-Object -ExpandProperty OwningProcess");
    expect(service).toContain("Get-CimInstance -ClassName Win32_Process");
    expect(service).toContain("Test-NgtListenerOwnership");
    expect(service).toContain("Test-NgtProcessTree");
    expect(service).toContain("Test-NgtProjectSupervisor");
    expect(service).toContain("Test-NgtServiceHealth");
    expect(service).toContain("127.0.0.1:3236/api/health");
    expect(service).toContain("runtime\\bin\\pg_ctl.exe");
    expect(service).toContain("TcpClient");
    expect(service).toContain('"ngt_test"');
    expect(service).toContain("refusing to reuse or stop it");
    expect(service).not.toContain("Stop-Process");
    expect(testDatabase).toContain('"CREATE DATABASE ngt_test"');
    expect(testDatabase).toContain('"55510"');
    expect(testDatabase).not.toContain('CREATE DATABASE ngt"');
    expect(installer).toContain('$taskName = "NGT Test Preview"');
    expect(installer).toContain(
      'New-ScheduledTaskAction -Execute "wscript.exe"',
    );
    expect(installer).toContain("//B //Nologo");
    expect(installer).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(launcher).toContain("shell.Run command, 0, False");
    expect(uninstaller).toContain("Unregister-ScheduledTask");
    expect(installer).toContain("install-windows-preview-shortcut.ps1");
    expect(shortcutInstaller).toContain("/target:winexe");
    expect(shortcutInstaller).toContain("/win32icon:$iconPath");
    expect(shortcutInstaller).toContain("0x6D4B, 0x8BD5, 0x7CFB, 0x7EDF");
    expect(shortcutInstaller).not.toContain('"NGT 测试系统.lnk"');
    expect(shortcutInstaller).toContain('$desktopName + ".exe"');
    expect(shortcutInstaller).toContain("Copy-Item -LiteralPath $launcherPath");
    expect(shortcutInstaller).toContain(
      "Remove-Item -LiteralPath $legacyShortcutPath",
    );
    expect(shortcutInstaller).not.toContain("CreateShortcut");
    expect(desktopLauncher).toContain('FileName = "http://127.0.0.1:3236/"');
    expect(desktopLauncher).toContain("UseShellExecute = true");
  });

  it("keeps manager state and business data outside versioned releases", async () => {
    const manager = await readFile("tools/ngt-updater/src/manager.rs", "utf8");
    const database = await readFile("scripts/windows-db.mjs", "utf8");
    const postgresRuntime = await readFile(
      "scripts/postgres-runtime.mjs",
      "utf8",
    );
    const packager = await readFile(
      "scripts/build-windows-studio-package.ps1",
      "utf8",
    );
    const installer = await readFile("installer/windows-studio.iss", "utf8");
    expect(manager).toContain('join("NGTManager")');
    expect(manager).toContain('root.join("state")');
    expect(manager).toContain('root.join("data")');
    expect(manager).toContain('root.join("backups")');
    expect(manager).toContain('root.join("releases")');
    expect(manager).toContain('"runtime/gh.exe"');
    expect(manager).toContain("fn verify_database_copy");
    expect(manager).toContain("fn restore_database");
    expect(manager).toContain("fn spawn_pg_ctl(");
    expect(manager).toContain("fn spawn_runtime_process(");
    expect(manager).toContain("fn inspect_postgres_directory(");
    expect(manager).toContain("database_initialization_owned");
    expect(manager).toContain(
      "fn cleanup_initial_database(root: &Path, transaction: &Transaction)",
    );
    expect(manager).toContain("NGT_PROGRESS|");
    expect(manager).toContain("installer.phase.completed");
    expect(manager).toContain("installer.phase.failed");
    expect(manager).toContain("installer.install.failed");
    expect(manager).toContain("fn validate_result_file_path");
    expect(manager).toContain(
      "fn write_setup_result(path: &Path, contents: &str)",
    );
    expect(manager).toContain("installer.package.extracted");
    expect(manager).toContain("record-installer-registration");
    expect(manager).toContain("NGT_DB_INIT_OPERATION_ID");
    expect(manager).toContain('"./scripts/run-pg-ctl.mjs"');
    expect(manager).toContain('"./scripts/runtime-start-gate.cjs"');
    const preflight = manager.slice(
      manager.indexOf("fn preflight("),
      manager.indexOf("fn required_space(", manager.indexOf("fn preflight(")),
    );
    expect(preflight.indexOf("check_windows_build()?")).toBeLessThan(
      preflight.indexOf("validate_runtime(source, progress)?"),
    );
    expect(preflight).toContain("ascii_temp_directory()");
    expect(preflight).toContain(
      "check_space(&temporary, postgres_runtime_size)",
    );
    expect(preflight).toContain(
      "PostgresDirectoryState::Empty | PostgresDirectoryState::Missing",
    );
    expect(database).toContain("process.env.NGT_DATA_ROOT");
    expect(database).toContain('from "./postgres-runtime.mjs"');
    expect(postgresRuntime).toContain(
      "process.env.NGT_MANAGER_ROOT ?? process.cwd()",
    );
    expect(postgresRuntime).toContain('startsWith("runtime/postgres/")');
    expect(postgresRuntime).toContain('"runtime.fingerprint"');
    expect(database).toContain('join(persistentRoot, "postgres")');
    expect(database).toContain('join(workspace, "database-ready.pid")');
    expect(database).toContain("NGT_DB_INIT_ONLY");
    expect(database).toContain("managerManaged && !initialized");
    expect(installer).toContain(
      "function PrepareToInstall(var NeedsRestart: Boolean): String",
    );
    expect(installer).toContain("ExecAndLogOutput(ManagerPath");
    expect(installer).toContain("CreateOutputMarqueeProgressPage(");
    expect(installer).toContain("--package-extract-ms ");
    expect(installer).toContain("--package-file-count ");
    expect(installer).toContain("record-installer-registration ");
    expect(installer).toContain(
      "Cancellation will wait for the current safe step",
    );
    expect(installer).toContain("WizardForm.CancelButton.Enabled := True");
    expect(installer).toContain("WizardForm.CancelButton.Enabled := False");
    expect(installer).not.toContain(
      "RaiseException('NGTManager installation failed.",
    );
    expect(database).toContain(
      "Database directory is incomplete; existing data was preserved.",
    );
    expect(packager).toContain('"NGTUpdater.exe"');
    expect(packager).toContain('"NGTManager.exe"');
    expect(packager).toContain('"start.mjs"');
    expect(packager).toContain('"windows-db.mjs"');
    expect(packager).toContain('"postgres-runtime.mjs"');
    expect(packager).toContain('"runtime-start-gate.cjs"');
    expect(packager).toContain('"run-pg-ctl.mjs"');
    expect(packager).toContain('"msvcp140.dll"');
    expect(packager).toContain('"vcruntime140.dll"');
    expect(installer).toContain("DefaultDirName={localappdata}\\NGTManager");
    expect(installer).toContain("PrivilegesRequired=lowest");
    const uninstallRules = installer.slice(
      installer.indexOf("[UninstallDelete]"),
      installer.indexOf("[Code]"),
    );
    expect(uninstallRules).not.toContain("\\data");
    expect(uninstallRules).not.toContain("\\backups");
    expect(uninstallRules).not.toContain("\\state");
  });

  it("backs up data, validates a candidate, and installs through the shared manager", async () => {
    const manager = await readFile("tools/ngt-updater/src/manager.rs", "utf8");
    const updater = await readFile("tools/ngt-updater/src/main.rs", "utf8");
    const installer = await readFile("installer/windows-studio.iss", "utf8");
    const packager = await readFile(
      "scripts/build-windows-studio-package.ps1",
      "utf8",
    );
    const workflow = (
      await readFile(".github/workflows/windows-studio-release.yml", "utf8")
    ).replace(/\r\n/g, "\n");
    const installStart = manager.indexOf("fn install_package(");
    const installEnd = manager.indexOf(
      "#[cfg(windows)]\nfn validate_candidate",
      installStart,
    );
    const install = manager.slice(installStart, installEnd);
    expect(manager).toContain("Stage::BackupVerifying");
    expect(manager).toContain("fn verify_database_copy");
    expect(manager).toContain("fn restore_database");
    expect(manager).toContain("fn recover_transaction");
    expect(manager).toContain("fn atomic_write");
    expect(
      install.indexOf(
        "preflight(source, requested_operation, Some(&progress))?",
      ),
    ).toBeLessThan(install.indexOf("backup_database("));
    expect(install.indexOf("backup_database(")).toBeLessThan(
      install.indexOf("validate_candidate("),
    );
    expect(install).toContain("write_maintenance(&root, &id, true)");
    expect(install).toContain("write_maintenance(&root, &id, false)");
    expect(updater).toContain("https://api.github.com");
    expect(updater).toContain("Installer size and SHA-256 verified.");
    expect(updater).toContain('"/VERYSILENT"');
    expect(updater).toContain('"/SUPPRESSMSGBOXES"');
    expect(updater).toContain('"/NORESTART"');
    expect(updater).toContain("check_install_space");
    expect(updater).toContain("finish_failed");
    expect(installer).toContain("NGTManager.exe");
    expect(installer).toContain("Operation := 'install'");
    expect(installer).toContain("Operation := 'update'");
    expect(installer).toContain("NGTUpdateId");
    expect(installer).toContain(
      "function PrepareToInstall(var NeedsRestart: Boolean): String",
    );
    expect(installer).not.toContain("RaiseException");
    expect(packager).toContain("cargo build --release --bins");
    expect(packager).toContain('"NGTManager.exe"');
    expect(packager).toContain('"NGTUpdater.exe"');
    expect(workflow).toContain("runs-on: windows-2022");
    expect(workflow).toContain("./.github/actions/windows-studio-acceptance");
  });

  it("installs pnpm before setup-node enables its cache", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("pnpm/action-setup@v4");
    expect(workflow.indexOf("pnpm/action-setup@v4")).toBeLessThan(
      workflow.indexOf("actions/setup-node@v5"),
    );
    expect(workflow).toContain("cache: pnpm");
    expect(workflow).not.toContain("npm install -g pnpm");
    expect(workflow).toContain("windows-studio-smoke:");
    expect(workflow).toContain("runs-on: windows-2022");
    expect(workflow).toContain("./scripts/build-windows-studio-package.ps1");
    expect(workflow).toContain("./scripts/test-windows-studio-package.ps1");
    expect(workflow).toContain("-IntegrityOnly");
    expect(workflow.indexOf("build-windows-studio-package.ps1")).toBeLessThan(
      workflow.indexOf("test-windows-studio-package.ps1"),
    );
  });

  it("builds a one-click per-user installer that delegates lifecycle to Rust", async () => {
    const definition = await readFile("installer/windows-studio.iss", "utf8");
    const builder = await readFile(
      "scripts/build-windows-studio-installer.ps1",
      "utf8",
    );
    const packager = await readFile(
      "scripts/build-windows-studio-package.ps1",
      "utf8",
    );
    const workflow = await readFile(
      ".github/workflows/windows-studio-release.yml",
      "utf8",
    );
    const buildAction = await readFile(
      ".github/actions/build-windows-studio-candidate/action.yml",
      "utf8",
    );
    const icon = await readFile("assets/ngt-studio.ico");
    expect(definition).toContain("PrivilegesRequired=lowest");
    expect(definition).toContain("DefaultDirName={localappdata}\\NGTManager");
    expect(definition).toContain(
      'Filename: "{localappdata}\\NGTManager\\tools\\NGTManager.exe"',
    );
    expect(definition).toContain('Parameters: "open"');
    expect(definition).toContain("Parameters := Operation +");
    expect(definition).toContain("Operation := 'install'");
    expect(definition).toContain("Operation := 'update'");
    expect(definition).toContain("function InitializeUninstall()");
    expect(definition).toContain("Exec(ManagerPath, 'uninstall'");
    expect(definition).toContain("SetupLogging=yes");
    expect(definition).toContain("{autodesktop}");
    expect(definition).toContain("{autoprograms}");
    expect(definition).toContain('Source: "{#PackageDirectory}\\*"');
    const uninstallRules = definition.slice(
      definition.indexOf("[UninstallDelete]"),
      definition.indexOf("[Code]"),
    );
    expect(uninstallRules).toContain("\\releases");
    expect(uninstallRules).toContain("\\tools");
    expect(uninstallRules).not.toContain("\\data");
    expect(uninstallRules).not.toContain("\\backups");
    expect(uninstallRules).not.toContain("\\state");
    expect(builder).toContain("ISCC.exe");
    expect(builder).toContain("Get-FileHash");
    expect(packager).toContain("cargo build --release --bins");
    expect(packager).toContain('"NGTManager.exe"');
    expect(packager).toContain('"NGTUpdater.exe"');
    expect(buildAction).toContain("build-windows-studio-installer.ps1");
    expect(workflow).toContain(
      "./.github/actions/build-windows-studio-candidate",
    );
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
  });

  it("shows Rust manager errors in one Inno preparation message", async () => {
    const installer = await readFile("installer/windows-studio.iss", "utf8");
    expect(installer).toContain("function ReadManagerError: String");
    expect(installer).toContain("LoadStringsFromFile(ResultPath, ResultLines)");
    expect(installer).toContain("Result := Copy(ResultLines[1], 1, 512)");
    expect(installer).toContain("if (not Started) or (ResultCode <> 0) then");
    expect(installer).not.toContain("RaiseException");
  });
});
