import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Windows persistent startup", () => {
  it("supervises both the database and application without machine-specific paths", async () => {
    const service = await readFile("scripts/windows-service.ps1", "utf8");
    expect(service).toContain(
      'Join-Path $projectRoot "scripts\\windows-db.mjs"',
    );
    expect(service).toContain('Join-Path $projectRoot "scripts\\start.mjs"');
    expect(service).toContain("Get-NgtStudioPortConnections -Port $Port");
    expect(service).toContain("Test-NgtPortOwnership");
    expect(service).toContain("Test-NgtStudioProcessTree");
    expect(service).toContain("Test-NgtStudioApplicationProcess");
    expect(service).toContain("Test-NgtStudioPostgresProcess");
    expect(service).toContain("unverified PID");
    expect(service).toContain("$expectedCommit");
    expect(service).toContain("$health.buildCommit");
    expect(service).toContain("$process.HasExited");
    expect(service).toContain("$PSScriptRoot");
    expect(service).not.toContain("D:\\NGT");
  });

  it("waits for database initialization before starting the application", async () => {
    const service = (
      await readFile("scripts/windows-service.ps1", "utf8")
    ).replace(/\r\n/g, "\n");
    expect(service).toContain(
      'Join-Path $projectRoot ".local\\database-ready.pid"',
    );
    expect(service).toContain('Join-Path $stateDirectory "database.pid"');
    expect(service).toContain("$readyProcessId -eq $databaseProcessId");
    expect(service.indexOf('Start-NgtProcess -Name "database"')).toBeLessThan(
      service.indexOf("\n    Wait-NgtDatabaseReady\n"),
    );
    expect(service.indexOf("\n    Wait-NgtDatabaseReady\n")).toBeLessThan(
      service.indexOf('Start-NgtProcess -Name "application"'),
    );
  });

  it("installs a logon task with restart settings and has a matching uninstaller", async () => {
    const installer = await readFile(
      "scripts/install-windows-startup.ps1",
      "utf8",
    );
    const uninstaller = await readFile(
      "scripts/uninstall-windows-startup.ps1",
      "utf8",
    );
    expect(installer).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(installer).toContain(
      "New-ScheduledTaskAction -Execute $wscriptPath",
    );
    expect(installer).toContain("//B //Nologo");
    expect(installer).toContain("Register-ScheduledTask");
    expect(installer).not.toContain("Start-ScheduledTask");
    expect(installer).toContain(
      "Start-Process -FilePath $wscriptPath -ArgumentList $launcherArguments -WindowStyle Hidden",
    );
    expect(installer).toContain(
      "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    );
    expect(installer).toContain("Start-Process -FilePath $wscriptPath");
    expect(uninstaller).toContain("Unregister-ScheduledTask");
    expect(uninstaller).toContain("Remove-ItemProperty");
  });

  it("runs real Windows release acceptance with a disposable standard user", async () => {
    const runner = await readFile(
      "scripts/run-windows-studio-acceptance-as-standard-user.ps1",
      "utf8",
    );
    const coordinator = await readFile(
      "scripts/windows-studio-acceptance-coordinator.ps1",
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
    expect(runner).toContain("windows-studio-acceptance-coordinator.ps1");
    expect(runner).toContain("Get-NgtAcceptanceProcessOutcome");
    expect(coordinator).toContain("Required acceptance file is missing");
    expect(coordinator).toContain("Required acceptance file is empty");
    expect(coordinator).toContain("$childExitCode -ne 0");
    expect(runner).toContain("@($protectedTokens) + @($passwordPlain)");
    expect(runner).toContain("foreach ($sensitiveValue in $diagnosticSecrets)");
    expect(runner).toContain("throw $safeFailureMessage");
    expect(runner).not.toContain("throw $failureRecord");
    expect(runner).toContain("Remove-LocalUser -Name $userName");
    expect(workflow).toContain("./.github/actions/windows-studio-acceptance");
    expect(workflow).toContain("acceptance: online-update");
    expect(workflow).toContain("acceptance: installer");
    expect(acceptanceAction).toContain(
      "run-windows-studio-acceptance-as-standard-user.ps1 -Acceptance ${{ inputs.acceptance }}",
    );
    expect(acceptanceAction).toContain("GH_TOKEN: ${{ github.token }}");
    expect(acceptanceAction).toContain("if: failure()");
    expect(acceptanceAction).toContain(
      "ngt-acceptance-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}/",
    );
  });

  it("adapts only legacy baseline startup for the non-interactive hosted runner", async () => {
    const acceptance = await readFile(
      "scripts/test-windows-studio-online-update.ps1",
      "utf8",
    );
    expect(acceptance).toContain(
      'Join-Path $baselineRoot "scripts\\install-windows-startup.ps1"',
    );
    expect(acceptance).toContain('"Start-ScheduledTask -TaskName `$taskName"');
    expect(acceptance).toContain(
      '"Start-Process -FilePath `$wscriptPath -ArgumentList `$launcherArguments -WindowStyle Hidden"',
    );
    expect(acceptance).toContain(
      '$baselineMetadata.files.PSObject.Properties["scripts/install-windows-startup.ps1"]',
    );
    expect(acceptance).toContain(
      "Baseline startup script failed integrity validation before runner adaptation.",
    );
    expect(acceptance).toContain(
      "$startupManifestEntry.Value = (Get-FileHash -LiteralPath $baselineStartupScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()",
    );
    expect(acceptance).toContain(
      "Adapted legacy baseline atomic file replacement for Windows PowerShell 5.1",
    );
    expect(acceptance).toContain(
      "Baseline script failed integrity validation before runner adaptation",
    );
    expect(acceptance).toContain(
      "Baseline startup script has no supported immediate launcher command.",
    );
  });

  it("writes baseline manifests through the shared BOM-free metadata helper", async () => {
    const acceptance = await readFile(
      "scripts/test-windows-studio-online-update.ps1",
      "utf8",
    );
    const metadataHelper = await readFile(
      "scripts/windows-studio-release-metadata.ps1",
      "utf8",
    );
    const packageBuilder = await readFile(
      "scripts/build-windows-studio-package.ps1",
      "utf8",
    );

    expect(acceptance).toContain(
      '. (Join-Path $PSScriptRoot "windows-studio-release-metadata.ps1")',
    );
    expect(
      acceptance.match(
        /Write-NgtStudioReleaseMetadataNoBom\s+-Path \$baselineMetadataPath\s+-Metadata \$baselineMetadata/g,
      ),
    ).toHaveLength(3);
    expect(metadataHelper).toContain(
      "function Write-NgtStudioReleaseMetadataNoBom",
    );
    expect(metadataHelper).toMatch(/\[int\]\$Depth = 100/);
    expect(metadataHelper).toContain(
      "ConvertTo-Json -InputObject $Metadata -Depth $Depth",
    );
    expect(packageBuilder).toMatch(
      /Write-NgtStudioReleaseMetadataNoBom\s+`\s*-Path \(Join-Path \$stage "studio-release\.json"\)\s+`\s*-Metadata \$releaseMetadata\s+`\s*-Depth 5/,
    );
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

  it("keeps studio data outside versioned releases and packages updates at home", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const database = await readFile("scripts/windows-db.mjs", "utf8");
    const service = await readFile("scripts/windows-service.ps1", "utf8");
    const installer = await readFile(
      "scripts/install-windows-studio.ps1",
      "utf8",
    );
    const packager = await readFile(
      "scripts/build-windows-studio-package.ps1",
      "utf8",
    );
    const runtime = await readFile("scripts/studio-runtime.ps1", "utf8");
    const updateAssets = await readFile(
      "scripts/prepare-windows-studio-update-assets.ps1",
      "utf8",
    );
    const start = await readFile("scripts/start.mjs", "utf8");
    const materializedCopy = await readFile(
      "scripts/copy-directory-materialized.mjs",
      "utf8",
    );
    expect(database).toContain("process.env.NGT_DATA_ROOT");
    expect(database).toContain(
      'const runtime = /[^\\x00-\\x7F]/.test(native) ? join(cache, "runtime") : native;',
    );
    expect(database).toContain("Using packaged PostgreSQL runtime");
    expect(database).toContain("Preparing PostgreSQL runtime");
    expect(database).toContain("Initializing PostgreSQL data");
    expect(database).toContain("Starting PostgreSQL from");
    expect(database).toContain(
      'const readyFile = join(workspace, "database-ready.pid")',
    );
    expect(database).toContain(
      "await writeFile(readyFile, String(process.pid))",
    );
    expect(database).toContain("Preserved incomplete database");
    expect(database).toContain("initializingDataDir");
    expect(database).toContain("output.trim()");
    expect(packageJson.dependencies["embedded-postgres"]).toBe(
      "17.10.0-beta.17",
    );
    expect(database).toContain('join(persistentRoot, "data")');
    expect(installer).toContain("Stop-NgtStudioProcesses");
    expect(installer.indexOf("Stop-NgtStudioProcesses")).toBeLessThan(
      installer.indexOf("Start-NgtStudioDatabase"),
    );
    expect(installer).toContain("Start-NgtStudioDatabase");
    expect(installer).toContain("Wait-NgtStudioHealth");
    const standalonePublicDestination = packager.indexOf(
      '$standalonePublicDestination = Join-Path $standaloneDestination "public"',
    );
    const removeStandalonePublic = packager.indexOf(
      "Remove-Item -LiteralPath $standalonePublicDestination -Recurse -Force",
      standalonePublicDestination,
    );
    const copyStandalonePublic = packager.indexOf(
      'Copy-Item -LiteralPath "public" -Destination $standalonePublicDestination -Recurse -Force',
      removeStandalonePublic,
    );
    expect(standalonePublicDestination).toBeGreaterThanOrEqual(0);
    expect(removeStandalonePublic).toBeGreaterThan(standalonePublicDestination);
    expect(copyStandalonePublic).toBeGreaterThan(removeStandalonePublic);
    const common = await readFile("scripts/windows-studio-common.ps1", "utf8");
    expect(common).toContain("$process.HasExited");
    expect(common).toContain(
      '$readyFile = Join-Path $script:NgtStateDirectory "database-ready.pid"',
    );
    expect(common).toContain("$readyProcessId.Trim() -eq [string]$process.Id");
    expect(common).not.toContain("Database did not open port 55432 in time.");
    expect(common).toContain("studio-database.error.log");
    expect(common).toContain("studio-database.log");
    expect(common).toContain("$process.WaitForExit()");
    expect(common).toContain("$process.Refresh()");
    expect(common).toContain('"unknown"');
    expect(common).toContain("if ($content) { $content.Trim() }");
    expect(common).toContain("$details -join");
    expect(common).not.toContain(
      "(Get-Content -LiteralPath $errorLog -Raw).Trim()",
    );
    expect(service).toContain('"studio.json"');
    expect(service).toContain('"runtime\\node.exe"');
    expect(service).toContain('"supervisor.pid"');
    expect(common).toContain("Get-CimInstance -ClassName Win32_Process");
    expect(common).toContain('"windows-service.ps1"');
    expect(common).toContain("$stateDirectories");
    expect(common).toContain('$ErrorActionPreference = "Stop"');
    expect(common).toContain("$stoppedDatabasePaths");
    expect(common).toContain("Test-NgtStudioPostgresProcess");
    expect(common).toContain("Test-NgtStudioProcessTree");
    expect(common).toContain(
      "Stop-NgtStudioProcessIfUnchanged -Process $databaseProcess",
    );
    expect(installer).toContain('"releases\\v" + $release.version');
    expect(installer).toContain('"--max-old-space-size=1536"');
    expect(packager).toContain("--config.node-linker=hoisted");
    expect(packager).toContain('"scripts\\copy-directory-materialized.mjs"');
    expect(packager).toContain('"node_modules\\@swc\\helpers"');
    expect(packager).toContain("_interop_require_default.js");
    expect(packager).toContain(
      "Studio archive is missing the @swc/helpers runtime.",
    );
    expect(packager).toContain('"node_modules\\@next\\env"');
    expect(packager).toContain(
      '".next\\standalone\\node_modules\\@next\\env\\dist\\index.js"',
    );
    expect(packager).toContain(
      "Studio archive is missing the @next/env runtime.",
    );
    expect(packager).toContain('"node_modules\\@prisma\\client\\runtime"');
    expect(packager).toContain(
      '".next\\standalone\\node_modules\\@prisma\\client\\runtime\\library.js"',
    );
    expect(packager).toContain("The @prisma/client runtime is missing.");
    expect(packager).toContain('"node_modules\\.prisma\\client"');
    expect(packager).toContain("require.resolve('.prisma/client/default'");
    expect(packager).toContain("$prismaClientSourceOutput");
    expect(packager).toContain(
      '".next\\standalone\\node_modules\\.prisma\\client\\default.js"',
    );
    expect(packager).toContain(
      "Studio archive is missing the generated Prisma client.",
    );
    expect(packager).toContain("runtimeHash = $runtimeHash");
    expect(runtime).toContain("Install-NgtSharedRuntime");
    expect(runtime).toContain("New-Item -ItemType HardLink");
    expect(runtime).toContain("Remove-NgtUnusedRuntimes");
    expect(updateAssets).toContain('Where-Object { $_.Name -ne "runtime" }');
    expect(updateAssets).toContain(
      '".next/standalone/node_modules/@prisma/client/runtime/library.js"',
    );
    expect(updateAssets).toContain(
      "Application update archive is missing the Prisma client runtime.",
    );
    expect(updateAssets).toContain(
      "$actualRuntimeHash -ne [string]$releaseMetadata.runtimeHash",
    );
    expect(updateAssets).toContain(
      '[string]$PackageDirectory = ".local\\studio-package"',
    );
    expect(updateAssets).toContain(
      '"ngt-studio-runtime-v" + $version + ".zip"',
    );
    expect(materializedCopy).toContain("lstat(sourcePath)");
    expect(materializedCopy).toContain("readlink(sourcePath)");
    expect(packager).toContain('$runtimeDirectory "postgres"');
    expect(packager).toContain("VCToolsRedistDir");
    expect(packager).toContain("$vcRuntimeCandidates += (Join-Path");
    expect(packager).toContain("vswhere.exe");
    expect(packager).toContain('"msvcp140.dll"');
    expect(packager).toContain('"vcruntime140.dll"');
    expect(packager).toContain('"vcruntime140_1.dll"');
    expect(packager).toContain('".next\\standalone\\.env"');
    expect(packager).toContain("--frozen-lockfile");
    expect(packager).toContain("tar.exe -a -c");
    expect(packager).toContain(
      "sharp-libvips-(darwin|linux|freebsd|linuxmusl|win32-arm64)",
    );
    expect(packager).toContain(
      'Get-ChildItem -LiteralPath $stage -File -Recurse -Filter "*.map"',
    );
    expect(start).toContain('nextConfig.distDir ?? ".next"');
    expect(start).toContain("verifyWindowsStudioStaticAssets");
    expect(start).not.toContain("await rm(");
    expect(start).not.toContain("await cp(");
    expect(packager).toContain('Join-Path $standaloneDestination "public"');
    expect(packager).toContain('$env:GITHUB_REF_TYPE -eq "tag"');
  });

  it("backs up and verifies private releases before switching the studio", async () => {
    const backup = await readFile("scripts/backup-windows-studio.ps1", "utf8");
    const updater = await readFile("tools/ngt-updater/src/main.rs", "utf8");
    const studioCommon = await readFile(
      "scripts/windows-studio-common.ps1",
      "utf8",
    );
    const workflow = (
      await readFile(".github/workflows/windows-studio-release.yml", "utf8")
    ).replace(/\r\n/g, "\n");
    const acceptanceAction = await readFile(
      ".github/actions/windows-studio-acceptance/action.yml",
      "utf8",
    );
    const buildAction = await readFile(
      ".github/actions/build-windows-studio-candidate/action.yml",
      "utf8",
    );
    const packageSmokeTest = await readFile(
      "scripts/test-windows-studio-package.ps1",
      "utf8",
    );
    const onlineUpdateTest = await readFile(
      "scripts/test-windows-studio-online-update.ps1",
      "utf8",
    );
    const installScript = await readFile(
      "scripts/install-windows-studio.ps1",
      "utf8",
    );
    const installBootstrap = await readFile(
      "scripts/install-windows-studio-bootstrap.ps1",
      "utf8",
    );
    const acceptanceServer = await readFile(
      "scripts/windows-studio-updater-acceptance-server.cjs",
      "utf8",
    );
    const innoInstaller = await readFile(
      "installer/windows-studio.iss",
      "utf8",
    );
    const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(backup).toContain('"SHA256SUMS.txt"');
    expect(backup).toContain("Stop-NgtStudioProcesses");
    expect(backup).toContain("$_.FullName.Substring($backupPrefix.Length)");
    expect(backup).not.toContain("[System.IO.Path]::GetRelativePath");
    expect(studioCommon).toContain(
      "if (Test-Path -LiteralPath $postmasterPid -PathType Leaf) {",
    );
    expect(
      studioCommon.indexOf("if (Test-Path -LiteralPath $postmasterPid"),
    ).toBeLessThan(
      studioCommon.indexOf("& $pgCtl -D $recordedData -m fast stop 2>$null"),
    );
    const fileReplaceCalls = [
      ...studioCommon.matchAll(/\[System\.IO\.File\]::Replace\([^\r\n]+/g),
    ];
    expect(fileReplaceCalls.length).toBeGreaterThan(0);
    for (const replaceCall of fileReplaceCalls) {
      expect(replaceCall[0]).not.toMatch(/,\s*\$null\s*\)/);
    }
    expect(updater).toContain("https://api.github.com");
    expect(updater).toContain("The installer checksum sidecar is invalid.");
    expect(updater).toContain("Installer size and SHA-256 verified.");
    expect(updater).toContain("CREATE_NO_WINDOW");
    expect(updater).toContain('"/VERYSILENT"');
    expect(updater).toContain('"/SUPPRESSMSGBOXES"');
    expect(updater).toContain('"/SP-"');
    expect(updater).toContain('"/NORESTART"');
    expect(updater).toContain("check_install_space");
    expect(updater).toContain('"actualVersion": args.target_version');
    expect(updater).toContain("finish_failed");
    expect(updater).toContain("take_acceptance_failure_stage");
    expect(updater).toContain('feature = "acceptance-api"');
    expect(updater).toContain("update_log_path");
    expect(onlineUpdateTest).toContain("Get-NgtUpdaterWindowDiagnostics");
    expect(onlineUpdateTest).toContain("Get-NgtInteractiveSessionEvidence");
    expect(onlineUpdateTest).toContain("Get-NgtScreenVisibleWindows");
    expect(onlineUpdateTest).toContain("Get-NgtVisibleWindowProcessIds");
    expect(onlineUpdateTest).toContain("GetWindowRect");
    expect(onlineUpdateTest).toContain("windowBounds");
    expect(onlineUpdateTest).toContain("boundsAvailable");
    expect(onlineUpdateTest).toContain("OnScreen");
    expect(onlineUpdateTest).toContain("inno.log");
    expect(onlineUpdateTest).toContain(
      "silent online update displayed a visible installer",
    );
    expect(onlineUpdateTest).toContain("100 MiB design target");
    expect(onlineUpdateTest).toContain("Rust updater peak working set");
    expect(onlineUpdateTest).toContain("NGT_TEST_RELEASE_API_URL");
    expect(onlineUpdateTest).toContain("acceptance-failure-stage");
    expect(onlineUpdateTest).toContain(
      "Injected deployment interruption rolled back the release and database",
    );
    expect(onlineUpdateTest).toContain("quarantinedCandidates");
    expect(onlineUpdateTest).toContain(
      "The API started a process other than the versioned Rust updater.",
    );
    expect(acceptanceServer).toContain(
      'request.url === "/repos/JayWangsj/ngt1/releases/latest"',
    );
    expect(innoInstaller).toContain("SW_HIDE, ewWaitUntilTerminated");
    expect(innoInstaller).toContain("skipifsilent");
    expect(innoInstaller).toContain("DisableStartupPrompt=yes");
    expect(innoInstaller).toContain("NGTAcceptanceFailureStage");
    expect(installBootstrap).toContain("-AcceptanceFailureStage");
    expect(installScript).toContain('RUNNER_ENVIRONMENT -ne "github-hosted"');
    expect(installScript).toContain(
      "Injected hosted acceptance failure after partial release deployment.",
    );
    expect(onlineUpdateTest).toContain("Assert-ReleaseChecksum $oldAppArchive");
    expect(onlineUpdateTest).toContain(
      "Assert-ReleaseChecksum $oldRuntimeArchive",
    );
    expect(onlineUpdateTest).toContain(
      '$baselineRuntimeArchive = Join-Path $CandidateDirectory "ngt-studio-runtime-$TargetTag.zip"',
    );
    expect(onlineUpdateTest).toContain(
      "Candidate baseline runtime archive extraction failed.",
    );
    const baselinePathNormalization = onlineUpdateTest.indexOf(
      "Normalize-LegacyBaselineDocumentationPaths -Root $baselineRoot",
    );
    const baselineInstallation = onlineUpdateTest.indexOf(
      '& (Join-Path $baselineRoot "scripts\\install-windows-studio.ps1")',
    );
    expect(baselinePathNormalization).toBeGreaterThanOrEqual(0);
    expect(baselinePathNormalization).toBeLessThan(baselineInstallation);
    const normalizationFunctionStart = onlineUpdateTest.indexOf(
      "function Normalize-LegacyBaselineDocumentationPaths",
    );
    const normalizationFunctionEnd = onlineUpdateTest.indexOf(
      "function Invoke-BusinessDataProbe",
      normalizationFunctionStart,
    );
    const normalizationFunction = onlineUpdateTest.slice(
      normalizationFunctionStart,
      normalizationFunctionEnd,
    );
    expect(normalizationFunction).toContain("Get-FileHash");
    expect(normalizationFunction).toContain("Move-Item");
    const onlineTestRootCreation = onlineUpdateTest.indexOf(
      "New-Item -ItemType Directory -Path $testRoot -Force | Out-Null",
    );
    expect(onlineTestRootCreation).toBeGreaterThanOrEqual(0);
    expect(onlineTestRootCreation).toBeLessThan(
      onlineUpdateTest.indexOf("$taskRoot = Join-Path $installRoot"),
    );
    const onlineTestCleanupDirectoryReset = onlineUpdateTest.indexOf(
      "Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())",
    );
    const onlineTestRootCleanup = onlineUpdateTest.indexOf(
      "Remove-Item -LiteralPath $testRoot -Recurse -Force",
    );
    expect(onlineTestCleanupDirectoryReset).toBeGreaterThanOrEqual(0);
    expect(onlineTestCleanupDirectoryReset).toBeLessThan(onlineTestRootCleanup);
    expect(workflow).toContain('tags:\n      - "v*"');
    expect(workflow).toContain("runs-on: windows-2022");
    expect(ciWorkflow).toContain("--config.node-linker=hoisted");
    expect(ciWorkflow).toContain("--config.package-import-method=copy");
    expect(ciWorkflow).toContain(
      "node --test tests/release/windows-studio-release.node-test.mjs",
    );
    const packageBuilder = await readFile(
      "scripts/build-windows-studio-package.ps1",
      "utf8",
    );
    const updateSafetyTest = await readFile(
      "scripts/test-windows-studio-update-safety.ps1",
      "utf8",
    );
    const releaseVerifier = await readFile(
      "scripts/verify-windows-studio-release.ps1",
      "utf8",
    );
    expect(packageBuilder).toContain("cargo build --release");
    expect(packageBuilder).toContain('"NGTUpdater.exe"');
    expect(updateSafetyTest).toContain('"tools/NGTUpdater.exe"');
    expect(releaseVerifier).toContain('"tools/NGTUpdater.exe"');
    expect(packageBuilder).not.toContain('"update-windows-studio.ps1"');
    expect(workflow).not.toContain("actions/download-artifact@v4");
    expect(workflow).not.toContain("windows-studio-package-${{ github.sha }}");
    expect(workflow).not.toContain("prepare-candidate:");
    expect(workflow).toContain(
      "node scripts/windows-studio-release.mjs prepare-draft",
    );
    expect(workflow).toContain("./.github/actions/windows-studio-acceptance");
    expect(acceptanceAction).toContain(
      "node scripts/windows-studio-release.mjs download-draft release-assets",
    );
    expect(acceptanceAction).toContain(
      "node scripts/windows-studio-release.mjs verify-artifact release-assets",
    );
    expect(workflow).toContain(
      "node scripts/windows-studio-release.mjs publish release-assets",
    );
    expect(workflow).toMatch(
      /needs:\s*\[\s*qualify,\s*build,\s*online-update-acceptance,\s*production-updater-acceptance,\s*installer-acceptance,\s*manual-installer-acceptance,\s*manual-v2020-acceptance,?\s*\]/,
    );
    expect(workflow).toContain(
      "./.github/actions/build-windows-studio-candidate",
    );
    expect(buildAction).toContain("innosetup --version=6.7.1");
    expect(buildAction).toContain("$installedInnoSetup[0].DisplayVersion");
    expect(buildAction).toContain("$compilerDirectory");
    expect(workflow).toContain("windows-studio-release-metrics.mjs");
    expect(workflow).not.toContain("--clobber");
    expect(workflow).not.toContain("continue-on-error");
    expect(packageSmokeTest).toContain("Start-NgtStudioDatabase");
    expect(packageSmokeTest).toContain("[switch]$IntegrityOnly");
    expect(packageSmokeTest).toContain('"initdb.exe"');
    expect(packageSmokeTest).toContain("--- Archive bootstrap entries ---");
    expect(packageSmokeTest).toContain("--- Extracted release scripts ---");
    expect(packageSmokeTest).toContain("require('pg')");
    expect(packageSmokeTest).toContain("new PrismaClient()");
    expect(packageSmokeTest).toContain("verify-windows-studio-release.ps1");
    expect(packageSmokeTest).toContain(
      '".next\\standalone\\node_modules\\.prisma\\client\\default.js"',
    );
    expect(packageSmokeTest).toContain(
      '".next\\standalone\\node_modules\\@prisma\\client\\runtime\\library.js"',
    );
    expect(packageSmokeTest).toContain('"migrate", "deploy"');
    expect(packageSmokeTest).toContain("Wait-NgtStudioHealth");
    expect(packageSmokeTest).toContain("Write-SmokeLogs");
    expect(packageSmokeTest).toContain("-Tail 200");
    expect(packageSmokeTest).toContain("Stop-NgtStudioProcesses");
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

  it("builds a one-click per-user studio installer", async () => {
    const definition = await readFile("installer/windows-studio.iss", "utf8");
    const builder = await readFile(
      "scripts/build-windows-studio-installer.ps1",
      "utf8",
    );
    const bootstrap = await readFile(
      "scripts/install-windows-studio-bootstrap.ps1",
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
    const uninstaller = await readFile(
      "scripts/uninstall-windows-studio.ps1",
      "utf8",
    );
    const icon = await readFile("assets/ngt-studio.ico");
    expect(definition).toContain("PrivilegesRequired=lowest");
    expect(definition).toContain("UsePreviousAppDir=no");
    expect(definition).not.toContain("BootstrapPath");
    expect(definition).toContain("install-windows-studio.ps1");
    expect(definition).toContain("uninstall-windows-studio.ps1");
    expect(definition).toContain("{autodesktop}");
    expect(definition).toContain("SetupIconFile={#IconPath}");
    expect(definition).toContain('Source: "{#PackageDirectory}\\*"');
    expect(definition).toContain("recursesubdirs createallsubdirs");
    expect(definition).not.toContain("ngt-studio-package.zip");
    expect(definition).toContain("UninstallDisplayIcon");
    expect(definition).toContain(
      "UninstallFilesDir={localappdata}\\NGT\\uninstall",
    );
    expect(definition).toContain(
      'IconFilename: "{localappdata}\\NGT\\assets\\ngt-studio.ico"',
    );
    expect(definition).toContain("IconFilename");
    expect(definition).toContain('Filename: "http://127.0.0.1:3000"');
    expect(definition).toContain(
      "Flags: shellexec postinstall nowait skipifsilent",
    );
    expect(definition).not.toContain("{sys}\\explorer.exe");
    expect(builder).toContain("ISCC.exe");
    expect(builder).not.toContain("BootstrapPath");
    expect(builder.indexOf("$compilerCandidates")).toBeLessThan(
      builder.indexOf('Get-Command "iscc.exe"'),
    );
    expect(builder).toContain("Studio installer bootstrap is missing");
    expect(builder).toContain("Inno Setup compiler:");
    expect(builder).toContain("Get-FileHash");
    expect(packager).toContain('"windows-studio-launcher.vbs"');
    expect(packager).toContain('"install-windows-studio-bootstrap.ps1"');
    expect(packager).toContain(
      '$standaloneDocs = Join-Path $standaloneDestination "docs"',
    );
    expect(packager).toContain('"assets\\ngt-studio.ico"');
    expect(packager).toContain('(Join-Path $runtimeDirectory "gh.exe")');
    expect(packager).toContain('"licenses\\github-cli.txt"');
    expect(workflow).toContain(
      "./.github/actions/build-windows-studio-candidate",
    );
    expect(buildAction).toContain("build-windows-studio-installer.ps1");
    expect(buildAction).toContain("prepare-windows-studio-update-assets.ps1");
    expect(
      buildAction.indexOf("build-windows-studio-installer.ps1"),
    ).toBeLessThan(
      buildAction.indexOf("prepare-windows-studio-update-assets.ps1"),
    );
    expect(bootstrap).not.toContain("Expand-Archive");
    expect(bootstrap).not.toContain("PackagePath");
    expect(bootstrap).toContain("install-windows-studio.ps1");
    expect(bootstrap).not.toContain("-InPlace");
    expect(bootstrap).toContain("Start-Transcript");
    expect(definition).toContain("install.log");
    expect(definition).toContain("if not WizardSilent then");
    expect(bootstrap).toContain("Start-Transcript");
    expect(
      await readFile("scripts/install-windows-studio.ps1", "utf8"),
    ).toContain('"health-validation"');
    expect(uninstaller).toContain("Stop-NgtStudioProcesses");
    expect(uninstaller).toContain("uninstall-windows-startup.ps1");
    expect(uninstaller).not.toContain("data-store");
    const service = await readFile("scripts/windows-service.ps1", "utf8");
    const startup = await readFile(
      "scripts/install-windows-startup.ps1",
      "utf8",
    );
    const installerScript = await readFile(
      "scripts/install-windows-studio.ps1",
      "utf8",
    );
    expect(service).toContain("studioConfig.activeRelease");
    expect(startup).toContain('"service\\windows-studio-launcher.vbs"');
    expect(installerScript).toContain("activeRelease = $projectRoot");
    expect(installerScript).toContain("-InPlace -OnlineUpdate:$OnlineUpdate");
    expect(installerScript).toContain("$resolvedDataRoot = $DataRoot");
    expect(installerScript).toContain(
      "$resolvedDataRoot = [string]$onlineInstallPlan.dataRoot",
    );
    expect(installerScript).toContain(
      "$resolvedDataRoot = [string]$manualInstallPlan.dataRoot",
    );
    expect(installerScript).toContain(
      "Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue",
    );
    expect(installerScript).toContain(
      "$manualReservation.marker.previousRelease",
    );
    expect(installerScript).toContain(
      'if ($manualInstall -or $onlineInstall) { Invoke-NgtInstallStage "incomplete-release-recovery"',
    );
    expect(
      installerScript.indexOf(
        "$stableInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)",
      ),
    ).toBeLessThan(
      installerScript.indexOf('Invoke-NgtInstallStage "release-backup"'),
    );
    expect(installerScript).toContain(
      "if ($InPlace -and $PreviousReleaseRoot -and -not $OnlineUpdate) { $OnlineUpdate = $true }",
    );
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    const iconCount = icon.readUInt16LE(4);
    const iconSizes = Array.from({ length: iconCount }, (_, index) => {
      const size = icon[6 + index * 16];
      return size === 0 ? 256 : size;
    });
    expect(iconSizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
    const firstImageOffset = icon.readUInt32LE(6 + 12);
    expect(icon.readUInt32LE(firstImageOffset)).toBe(40);
  });
});

describe("Windows installer acceptance boundaries", () => {
  it("checks the installed candidate locally without querying GitHub updates", async () => {
    const installerAcceptance = await readFile(
      "scripts/test-windows-studio-installer.ps1",
      "utf8",
    );
    expect(installerAcceptance).toContain(
      "[string]$health.buildCommit -ieq $env:GITHUB_SHA",
    );
    expect(installerAcceptance).toContain(
      "scripts\\verify-windows-studio-runtime.ps1",
    );
    expect(installerAcceptance).not.toContain("/api/system-update");
  });
});

describe("Production updater GitHub authentication", () => {
  it("proves isolated CLI and GH_TOKEN access in the real standard-user child", async () => {
    const runner = await readFile(
      "scripts/run-windows-studio-acceptance-as-standard-user.ps1",
      "utf8",
    );
    expect(runner).toContain("auth token --hostname $Hostname");
    expect(runner).toContain("ngt-noauth.invalid");
    expect(runner).toContain("SetAccessRuleProtection($true, $false)");
    expect(runner).toContain("expectedTokenSha256");
    expect(runner).toContain('Join-Path $ghConfigDirectory "hosts.yml"');
    expect(runner).toContain("must not be written to request.json");
    expect(runner).toContain("AddMinutes(110)");
    expect(runner).toContain("windows-studio-acceptance-coordinator.ps1");
    expect(runner).toContain("Assert-NgtAcceptanceTokenNotExposed");
    expect(runner).toContain("childFailurePath");
    expect(runner).not.toContain("GH_TOKEN = $env:GH_TOKEN");
  });
});

describe("Windows installer failure diagnostics", () => {
  it("logs the original PowerShell error and rethrows it without ScriptHalted", async () => {
    const installer = await readFile(
      "scripts/install-windows-studio.ps1",
      "utf8",
    );
    expect(installer).toContain("$failureRecord = $_");
    expect(installer).toContain(
      "$failureRecord.InvocationInfo.PositionMessage",
    );
    expect(installer).toContain("$failureRecord.ScriptStackTrace");
    expect(installer).toContain("throw $failureRecord");
  });
});
