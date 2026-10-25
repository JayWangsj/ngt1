$ErrorActionPreference = "Stop"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-update-safety-" + [guid]::NewGuid().ToString("N"))
$installRoot = Join-Path $testRoot "install"
$releasesRoot = Join-Path $installRoot "releases"
New-Item -ItemType Directory -Path $releasesRoot -Force | Out-Null

try {
  $currentRelease = Join-Path $releasesRoot "v2.0.9"
  $failedRelease = Join-Path $releasesRoot "v2.0.10"
  $targetRelease = Join-Path $releasesRoot "v2.0.11"
  foreach ($directory in @($currentRelease, $failedRelease, $targetRelease)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  & (Join-Path $PSScriptRoot "retain-windows-studio-releases.ps1") `
    -InstallRoot $installRoot `
    -CurrentReleaseRoot $currentRelease `
    -TargetReleaseRoot $targetRelease `
    -PreviousReleaseRoot $currentRelease
  if (-not (Test-Path -LiteralPath $currentRelease) -or
      -not (Test-Path -LiteralPath $targetRelease) -or
      (Test-Path -LiteralPath $failedRelease)) {
    throw "Release retention did not protect the actual rollback version."
  }

  $releaseFixture = Join-Path $testRoot "release-fixture"
  New-Item -ItemType Directory -Path (Join-Path $releaseFixture ".next\standalone") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $releaseFixture ".local") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $releaseFixture "scripts") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $releaseFixture "tools") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $releaseFixture "prisma") -Force | Out-Null
  $releaseFiles = @(
    ".next/standalone/server.js",
    "tools/NGTUpdater.exe",
    "scripts/check-windows-credential-store.ps1",
    "scripts/install-windows-studio.ps1",
    "scripts/prepare-windows-studio-install.ps1",
    "scripts/retain-windows-studio-releases.ps1",
    "scripts/verify-windows-studio-release.ps1",
    "scripts/test-windows-studio-update-safety.ps1",
    "scripts/test-windows-studio-install-coordination.ps1",
    "scripts/windows-studio-install-coordination.ps1",
    "prisma/schema.prisma"
  )
  $manifest = @{}
  foreach ($relativePath in $releaseFiles) {
    $filePath = Join-Path $releaseFixture ($relativePath.Replace("/", "\"))
    Set-Content -LiteralPath $filePath -Value $relativePath -Encoding ascii
    $manifest[$relativePath] = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  @{ version = "2.0.11"; files = $manifest } |
    ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $releaseFixture "studio-release.json") -Encoding utf8
  Set-Content -LiteralPath (Join-Path $releaseFixture ".local\studio.json") `
    -Value '{"installRoot":"isolated"}' -Encoding ascii
  & (Join-Path $PSScriptRoot "verify-windows-studio-release.ps1") `
    -ReleaseRoot $releaseFixture -ExpectedVersion "v2.0.11" | Out-Null
  Set-Content -LiteralPath (Join-Path $releaseFixture "scripts\unlisted.ps1") `
    -Value "unlisted" -Encoding ascii
  $unlistedRejected = $false
  try {
    & (Join-Path $PSScriptRoot "verify-windows-studio-release.ps1") `
      -ReleaseRoot $releaseFixture -ExpectedVersion "2.0.11" | Out-Null
  } catch { $unlistedRejected = $true }
  if (-not $unlistedRejected) { throw "Release integrity validation accepted an unlisted file." }
  Remove-Item -LiteralPath (Join-Path $releaseFixture "scripts\unlisted.ps1") -Force
  Set-Content -LiteralPath (Join-Path $releaseFixture "tools\NGTUpdater.exe") `
    -Value "tampered" -Encoding ascii
  $integrityRejected = $false
  try {
    & (Join-Path $PSScriptRoot "verify-windows-studio-release.ps1") `
      -ReleaseRoot $releaseFixture -ExpectedVersion "2.0.11" | Out-Null
  } catch { $integrityRejected = $true }
  if (-not $integrityRejected) { throw "Release integrity validation accepted a modified file." }

  $backupRoot = Join-Path $testRoot "backup-fixture"
  New-Item -ItemType Directory -Path (Join-Path $backupRoot "postgres-data\base") -Force | Out-Null
  $databaseFile = Join-Path $backupRoot "postgres-data\base\1"
  Set-Content -LiteralPath $databaseFile -Value "isolated database fixture" -Encoding ascii
  $backupHash = (Get-FileHash -LiteralPath $databaseFile -Algorithm SHA256).Hash
  Set-Content -LiteralPath (Join-Path $backupRoot "SHA256SUMS.txt") `
    -Value ("$backupHash  postgres-data\base\1") -Encoding ascii
  & (Join-Path $PSScriptRoot "test-windows-studio-backup.ps1") `
    -BackupRoot $backupRoot | Out-Null
  Set-Content -LiteralPath $databaseFile -Value "corrupted fixture" -Encoding ascii
  $backupRejected = $false
  try {
    & (Join-Path $PSScriptRoot "test-windows-studio-backup.ps1") `
      -BackupRoot $backupRoot | Out-Null
  } catch { $backupRejected = $true }
  if (-not $backupRejected) { throw "Backup validation accepted a modified database file." }

  . (Join-Path $PSScriptRoot "windows-studio-common.ps1")
  . (Join-Path $PSScriptRoot "windows-studio-install-coordination.ps1")
  $processRoot = Join-Path $testRoot "process-fixture-管理"
  $processInstallRoot = Join-Path $processRoot "install"
  $processReleaseRoot = Join-Path $processInstallRoot "releases\v-test"
  $processDataRoot = Join-Path $processRoot "data"
  $processStateDirectory = Join-Path $processReleaseRoot ".local"
  New-Item -ItemType Directory -Path $processStateDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $processReleaseRoot "runtime") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $processReleaseRoot "runtime\node.exe") -Value "fixture" -Encoding ascii
  Set-NgtStudioConfig -Path (Join-Path $processStateDirectory "studio.json") -Configuration ([pscustomobject]@{
    dataRoot = $processDataRoot
    installRoot = $processInstallRoot
    activeRelease = $processReleaseRoot
  })
  $script:NgtStateDirectory = $processStateDirectory
  $configuredEnvironment = Set-NgtStudioEnvironment
  if ([System.IO.Path]::GetFullPath([string]$configuredEnvironment.activeRelease) -ine
        [System.IO.Path]::GetFullPath($processReleaseRoot) -or
      [System.IO.Path]::GetFullPath([string]$env:NGT_DATA_ROOT) -ine
        [System.IO.Path]::GetFullPath($processDataRoot)) {
    throw "A BOM-less UTF-8 Studio configuration was not read correctly."
  }
  $script:FixturePorts = @()
  $script:FixtureProcesses = @{}
  $script:FixtureStopCalls = @()
  $script:FixtureScheduledTask = $null
  $script:FixtureTaskStopCalls = @()
  function Get-NgtStudioPortConnections([int]$Port) {
    return @($script:FixturePorts | Where-Object { $_.LocalPort -eq $Port })
  }
  function Get-NgtStudioProcess([int]$ProcessId) {
    return $script:FixtureProcesses[[int]$ProcessId]
  }
  function Get-ScheduledTask([string]$TaskName) { return $script:FixtureScheduledTask }
  function Stop-ScheduledTask([string]$TaskName, [string]$ErrorAction) {
    $script:FixtureTaskStopCalls += $TaskName
    $script:FixtureScheduledTask = $null
  }
  function Stop-Process([int]$Id, [switch]$Force, [string]$ErrorAction) {
    $script:FixtureStopCalls += $Id
    $script:FixtureProcesses.Remove($Id)
    $script:FixturePorts = @($script:FixturePorts | Where-Object { $_.OwningProcess -ne $Id })
  }

  $unrelatedNode = [pscustomobject]@{
    ProcessId = 4101
    ParentProcessId = 4
    Name = "node.exe"
    ExecutablePath = "C:\Other\node.exe"
    CommandLine = '"C:\Other\node.exe" unrelated.js'
    CreationDate = "2026-10-16T00:00:00Z"
  }
  $script:FixtureProcesses[4101] = $unrelatedNode
  Set-Content -LiteralPath (Join-Path $processStateDirectory "application.pid") -Value "4101" -Encoding ascii
  $script:FixturePorts = @([pscustomobject]@{ LocalPort = 3000; OwningProcess = 4101 })
  $unrelatedPortRejected = $false
  try { Stop-NgtStudioProcesses } catch {
    $unrelatedPortRejected = $_.Exception.Message -match "unverified PID 4101"
  }
  if (-not $unrelatedPortRejected -or $script:FixtureStopCalls.Count -ne 0) {
    throw "An unrelated Node listener was not preserved with a clear port diagnostic."
  }
  $unrelatedPostgres = [pscustomobject]@{
    ProcessId = 4102
    ParentProcessId = 4
    Name = "postgres.exe"
    ExecutablePath = "C:\Other\postgres.exe"
    CommandLine = '"C:\Other\postgres.exe" -D C:\Other\data'
    CreationDate = "2026-10-16T00:00:00Z"
  }
  $script:FixtureProcesses[4102] = $unrelatedPostgres
  $script:FixturePorts = @([pscustomobject]@{ LocalPort = 55432; OwningProcess = 4102 })
  $unrelatedDatabaseRejected = $false
  try { Stop-NgtStudioProcesses } catch {
    $unrelatedDatabaseRejected = $_.Exception.Message -match "unverified PID 4102"
  }
  if (-not $unrelatedDatabaseRejected -or $script:FixtureStopCalls.Count -ne 0) {
    throw "An unrelated PostgreSQL listener was not preserved with a clear port diagnostic."
  }

  $applicationScript = Join-Path $processReleaseRoot "scripts\start.mjs"
  $application = [pscustomobject]@{
    ProcessId = 4200
    ParentProcessId = 4
    Name = "node.exe"
    ExecutablePath = Join-Path $processReleaseRoot "runtime\node.exe"
    CommandLine = '"' + (Join-Path $processReleaseRoot "runtime\node.exe") + '" "' + $applicationScript + '"'
    CreationDate = "2026-10-16T00:00:00Z"
  }
  $listener = [pscustomobject]@{
    ProcessId = 4201
    ParentProcessId = 4200
    Name = "node.exe"
    ExecutablePath = $application.ExecutablePath
    CommandLine = '"' + $application.ExecutablePath + '" .next\standalone\server.js'
    CreationDate = "2026-10-16T00:00:01Z"
  }
  $script:FixtureProcesses[4200] = $application
  $script:FixtureProcesses[4201] = $listener
  Set-Content -LiteralPath (Join-Path $processStateDirectory "application.pid") -Value "4200" -Encoding ascii
  $script:FixturePorts = @([pscustomobject]@{ LocalPort = 3000; OwningProcess = 4201 })
  Stop-NgtStudioProcesses
  if (($script:FixtureStopCalls -join ",") -ne "4201") {
    throw "An identified NGT application listener was not stopped by its verified identity."
  }

  $legacyReleaseRoot = Join-Path $processInstallRoot "releases\v2.0.11"
  $candidateReleaseRoot = Join-Path $processInstallRoot "releases\v2.0.14"
  $stableStateDirectory = Join-Path $processInstallRoot ".local"
  $candidateStateDirectory = Join-Path $candidateReleaseRoot ".local"
  New-Item -ItemType Directory -Path (Join-Path $legacyReleaseRoot "runtime") -Force | Out-Null
  New-Item -ItemType Directory -Path $stableStateDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $candidateStateDirectory -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $legacyReleaseRoot "runtime\node.exe") -Value "fixture" -Encoding ascii
  Set-NgtStudioConfig -Path (Join-Path $stableStateDirectory "studio.json") -Configuration ([pscustomobject]@{
    dataRoot = $processDataRoot
    installRoot = $processInstallRoot
    activeRelease = $legacyReleaseRoot
  })
  Set-Content -LiteralPath (Join-Path $stableStateDirectory "supervisor.pid") -Value "4199" -Encoding ascii
  Set-Content -LiteralPath (Join-Path $stableStateDirectory "application.pid") -Value "4200" -Encoding ascii
  $legacySupervisor = [pscustomobject]@{
    ProcessId = 4199
    ParentProcessId = 4
    Name = "powershell.exe"
    ExecutablePath = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    CommandLine = 'powershell.exe -File "' + (Join-Path $processInstallRoot "service\windows-service.ps1") + '"'
    CreationDate = "2026-10-16T00:00:03Z"
  }
  $legacyApplication = [pscustomobject]@{
    ProcessId = 4200
    ParentProcessId = 4199
    Name = "node.exe"
    ExecutablePath = Join-Path $legacyReleaseRoot "runtime\node.exe"
    CommandLine = '"' + (Join-Path $legacyReleaseRoot "runtime\node.exe") + '" scripts/start.mjs'
    CreationDate = "2026-10-16T00:00:04Z"
  }
  $legacyListener = [pscustomobject]@{
    ProcessId = 4201
    ParentProcessId = 4200
    Name = "node.exe"
    ExecutablePath = $legacyApplication.ExecutablePath
    CommandLine = '"' + $legacyApplication.ExecutablePath + '" .next/standalone/server.js'
    CreationDate = "2026-10-16T00:00:05Z"
  }
  $script:FixtureProcesses[4199] = $legacySupervisor
  $script:FixtureProcesses[4200] = $legacyApplication
  $script:FixtureProcesses[4201] = $legacyListener
  $script:FixtureScheduledTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{
      Execute = Join-Path $env:WINDIR "System32\wscript.exe"
      Arguments = '//B //Nologo "' + (Join-Path $processInstallRoot "service\windows-studio-launcher.vbs") + '"'
    })
  }
  $previousInstallRoot = $installRoot
  $installRoot = $processInstallRoot
  $script:NgtStateDirectory = $candidateStateDirectory
  $script:FixtureStopCalls = @()
  $script:FixtureTaskStopCalls = @()
  $script:FixturePorts = @([pscustomobject]@{ LocalPort = 3000; OwningProcess = 4201 })
  try {
    Stop-NgtStudioProcesses
  } finally {
    $installRoot = $previousInstallRoot
    $script:NgtStateDirectory = $processStateDirectory
    $script:FixtureTaskStopCalls = @()
  }
  if (($script:FixtureStopCalls -join ",") -ne "4199,4201") {
    throw "A v2.0.11 relative-path application listener was not stopped after its supervisor exited."
  }

  $postgresRuntime = Join-Path $processRoot "postgres-runtime"
  $postgresExecutable = Join-Path $postgresRuntime "bin\postgres.exe"
  $databaseDirectory = Join-Path $processDataRoot "data"
  $postgresFixture = [pscustomobject]@{
    Name = "postgres.exe"
    ExecutablePath = $postgresExecutable
    CommandLine = '"' + $postgresExecutable + '" -D "' + $databaseDirectory + '" -h 127.0.0.1'
  }
  if (-not (Test-NgtStudioPostgresProcess -Process $postgresFixture -RuntimeRoot $postgresRuntime -DataDirectory $databaseDirectory) -or
      (Test-NgtStudioPostgresProcess -Process $postgresFixture -RuntimeRoot $postgresRuntime -DataDirectory (Join-Path $processRoot "other-data"))) {
    throw "PostgreSQL process identity did not require the recorded executable and data directory."
  }
  $serviceScript = Join-Path $processInstallRoot "service\windows-service.ps1"
  if (-not (Test-NgtStudioSupervisorProcess -Process ([pscustomobject]@{
    Name = "powershell.exe"
    CommandLine = 'powershell.exe -File "' + $serviceScript + '"'
  }) -ServiceScript $serviceScript)) {
    throw "A supervisor using the configured stable service script was not recognized."
  }
  $launcherPath = Join-Path $processInstallRoot "service\windows-studio-launcher.vbs"
  $validScheduledTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{
      Execute = Join-Path $env:WINDIR "System32\wscript.exe"
      Arguments = '//B //Nologo "' + $launcherPath + '"'
    })
  }
  if (-not (Test-NgtStudioScheduledTask -Task $validScheduledTask -LauncherPath $launcherPath)) {
    throw "The configured NGT scheduled task was not recognized."
  }
  $script:FixtureScheduledTask = $validScheduledTask
  $partialStopListener = [pscustomobject]@{
    ProcessId = 4301
    ParentProcessId = 4
    Name = "node.exe"
    ExecutablePath = "C:\Other\node.exe"
    CommandLine = '"C:\Other\node.exe" unrelated.js'
    CreationDate = "2026-10-16T00:00:02Z"
  }
  $script:FixtureProcesses[4301] = $partialStopListener
  $script:FixturePorts = @([pscustomobject]@{ LocalPort = 3000; OwningProcess = 4301 })
  $partialStopRejected = $false
  try { Stop-NgtStudioProcesses } catch {
    $partialStopRejected = $_.Exception.Message -match "unverified PID 4301"
  }
  if (-not $partialStopRejected -or
      $script:FixtureTaskStopCalls.Count -ne 0 -or
      -not $script:FixtureScheduledTask -or
      $script:FixtureStopCalls -contains 4301 -or
      -not $script:FixtureProcesses.ContainsKey(4301)) {
    throw "An unverified listener was rejected before stopping the task or listener."
  }
  $script:FixturePorts = @()
  Stop-NgtStudioProcesses
  if ($script:FixtureTaskStopCalls.Count -ne 1) {
    throw "A retry with the port clear did not safely stop the startup task."
  }
  if (Test-NgtStudioScheduledTask -Task ([pscustomobject]@{
    Actions = @([pscustomobject]@{
      Execute = Join-Path $env:WINDIR "System32\wscript.exe"
      Arguments = '//B //Nologo "' + $launcherPath + '" -unrelated'
    })
  }) -LauncherPath $launcherPath) {
    throw "An NGT scheduled task with unexpected command arguments was accepted."
  }
  if (Test-NgtStudioScheduledTask -Task ([pscustomobject]@{
    Actions = @([pscustomobject]@{ Execute = "C:\Other\wscript.exe"; Arguments = '"' + $launcherPath + '"' })
  }) -LauncherPath $launcherPath) {
    throw "An unrelated scheduled-task executable was accepted as the NGT startup task."
  }

  $eventsPath = Join-Path $testRoot "mutex-events.txt"
  $firstOutput = Join-Path $testRoot "mutex-one.out"
  $firstError = Join-Path $testRoot "mutex-one.err"
  $secondOutput = Join-Path $testRoot "mutex-two.out"
  $secondError = Join-Path $testRoot "mutex-two.err"
  $mutexInstallRoot = Join-Path $testRoot "mutex-install"
  New-Item -ItemType Directory -Path $mutexInstallRoot -Force | Out-Null
  $mutexAlias = Join-Path $testRoot "mutex-install-junction"
  New-Item -ItemType Junction -Path $mutexAlias -Target $mutexInstallRoot | Out-Null
  $mutexName = Get-NgtStudioUpdateMutexName $mutexInstallRoot
  $missingMutexRoot = Join-Path $mutexAlias "not-created\install"
  $missingMutexName = Get-NgtStudioUpdateMutexName $missingMutexRoot
  if ($missingMutexName -cne (Get-NgtStudioUpdateMutexName (Join-Path $mutexInstallRoot "not-created\install"))) {
    throw "The update mutex identity changed for a missing path under a junction alias."
  }
  New-Item -ItemType Directory -Path $missingMutexRoot -Force | Out-Null
  if ((Get-NgtStudioUpdateMutexName $missingMutexRoot) -cne $missingMutexName) {
    throw "The update mutex identity changed after the install directory was created."
  }
  foreach ($mutexRootVariant in @($mutexInstallRoot, ($mutexInstallRoot + "\"), $mutexInstallRoot.ToUpperInvariant(), $mutexAlias)) {
    if ((Get-NgtStudioUpdateMutexName $mutexRootVariant) -cne $mutexName) {
      throw "The update mutex identity changed for a case, trailing-separator, or junction alias."
    }
  }
  $childScript = Join-Path $testRoot "mutex-child.ps1"
  @'
param([string]$MutexName, [string]$EventsPath, [string]$Slot)
$mutex = [System.Threading.Mutex]::new($false, $MutexName)
$owned = $false
try {
  try { $owned = $mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { throw "Mutex acquisition timed out." }
  Add-Content -LiteralPath $EventsPath -Value ("start-" + $Slot)
  Start-Sleep -Milliseconds 400
  Add-Content -LiteralPath $EventsPath -Value ("end-" + $Slot)
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
'@ | Set-Content -LiteralPath $childScript -Encoding utf8
  $quotedScript = '"' + $childScript + '"'
  $quotedEvents = '"' + $eventsPath + '"'
  $quotedMutex = '"' + $mutexName + '"'
  $first = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedScript -MutexName $quotedMutex -EventsPath $quotedEvents -Slot one" -RedirectStandardOutput $firstOutput -RedirectStandardError $firstError -WindowStyle Hidden -PassThru
  $second = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedScript -MutexName $quotedMutex -EventsPath $quotedEvents -Slot two" -RedirectStandardOutput $secondOutput -RedirectStandardError $secondError -WindowStyle Hidden -PassThru
  $firstFinished = $first.WaitForExit(60000)
  $secondFinished = $second.WaitForExit(60000)
  if (-not $firstFinished -or -not $secondFinished) {
    foreach ($child in @($first, $second)) {
      if (-not $child.HasExited) {
        Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
      }
    }
    throw "Parallel update mutex behavior test timed out for child processes $($first.Id), $($second.Id)."
  }
  $firstFailure = if (Test-Path -LiteralPath $firstError) { Get-Content -LiteralPath $firstError -Raw } else { "" }
  $secondFailure = if (Test-Path -LiteralPath $secondError) { Get-Content -LiteralPath $secondError -Raw } else { "" }
  if ($firstFailure -or $secondFailure) {
    throw "Parallel update mutex child process failed: $firstFailure $secondFailure"
  }
  $events = @(Get-Content -LiteralPath $eventsPath)
  $firstSlot = if ($events.Count -gt 0 -and $events[0] -match "^start-(one|two)$") { $Matches[1] } else { "" }
  $secondSlot = if ($events.Count -gt 2 -and $events[2] -match "^start-(one|two)$") { $Matches[1] } else { "" }
  if ($events.Count -ne 4 -or
      -not $firstSlot -or $events[1] -ne "end-$firstSlot" -or
      -not $secondSlot -or $secondSlot -eq $firstSlot -or $events[3] -ne "end-$secondSlot") {
    throw "The update mutex allowed concurrent owners."
  }
  & (Join-Path $PSScriptRoot "test-windows-studio-install-coordination.ps1")
  Write-Output "Windows update safety behavior tests passed."
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
