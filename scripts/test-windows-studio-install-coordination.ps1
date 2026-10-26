$ErrorActionPreference = "Stop"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-install-coordination-" + [guid]::NewGuid().ToString("N"))
. (Join-Path $PSScriptRoot "windows-studio-install-coordination.ps1")
$script:InstallerTestExecutorState = $false
$script:InstallerTestProcesses = @()
$script:InstallerTestProcessQueryFails = $false
$script:ProductionGetNgtUpdateExecutorState = (Get-Command Get-NgtUpdateExecutorState).ScriptBlock
$script:ProductionProtectNgtRepairInstallation = (Get-Command Protect-NgtRepairInstallation).ScriptBlock
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  if ($script:InstallerTestProcessQueryFails) { throw "Simulated process query failure." }
  return $script:InstallerTestProcesses
}
function Get-NgtUpdateExecutorState([object]$Lock, [object]$Status, [string]$ActiveRelease) {
  return $script:InstallerTestExecutorState
}
function Get-NgtInstallerParentProcessId { return 12345 }
function Protect-NgtRepairInstallation([string]$InstallRoot, [object]$Plan) { }

function New-NgtInstallFixture([string]$Root) {
  $installRoot = Join-Path $Root "install"
  $oldRelease = Join-Path $installRoot "releases\v2.0.11"
  $newRelease = Join-Path $installRoot "releases\v2.0.15"
  New-Item -ItemType Directory -Path (Join-Path $installRoot ".local") -Force | Out-Null
  New-Item -ItemType Directory -Path $oldRelease -Force | Out-Null
  New-Item -ItemType Directory -Path $newRelease -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $oldRelease "studio-release.json") -Value '{"version":"2.0.11"}' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $newRelease "studio-release.json") -Value '{"version":"2.0.15"}' -Encoding utf8
  Write-NgtInstallJsonAtomic (Join-Path $installRoot ".local\studio.json") ([pscustomobject]@{
    installRoot = $installRoot
    dataRoot = Join-Path $installRoot "data-store"
    activeRelease = $oldRelease
  })
  return [pscustomobject]@{ installRoot = $installRoot; oldRelease = $oldRelease; newRelease = $newRelease }
}

try {
  $executorId = [guid]::NewGuid().ToString()
  $executorScript = Join-Path $testRoot "releases\v2.0.11\scripts\update-windows-studio.ps1"
  $legacyRelease = Split-Path (Split-Path $executorScript -Parent) -Parent
  $staleExecutor = & $script:ProductionGetNgtUpdateExecutorState $null ([pscustomobject]@{
    updateId = $executorId
  }) $legacyRelease
  if ($staleExecutor -ne $false) { throw "A queued task without an executor was not recognized as inactive." }
  $script:InstallerTestProcesses = @([pscustomobject]@{
    Name = "powershell.exe"
    ProcessId = 45678
    ExecutablePath = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    CommandLine = "powershell.exe -File `"$executorScript`" -UpdateId $executorId"
  })
  $activeExecutor = & $script:ProductionGetNgtUpdateExecutorState `
    ([pscustomobject]@{ executorPid = 45678; updateId = $executorId; executorScriptPath = $executorScript }) `
    ([pscustomobject]@{ updateId = $executorId }) $legacyRelease
  if ($activeExecutor -ne $true) { throw "A matching legacy online update executor was not recognized as active." }
  $updaterPath = Join-Path $legacyRelease "tools\NGTUpdater.exe"
  $script:InstallerTestProcesses = @([pscustomobject]@{
    Name = "NGTUpdater.exe"
    ProcessId = 45679
    ExecutablePath = $updaterPath
    CommandLine = "`"$updaterPath`" --update-id $executorId"
  })
  $activeRustExecutor = & $script:ProductionGetNgtUpdateExecutorState `
    ([pscustomobject]@{ executorPid = 45679; updateId = $executorId; executorPath = $updaterPath }) `
    ([pscustomobject]@{ updateId = $executorId; executorPath = $updaterPath }) $legacyRelease
  if ($activeRustExecutor -ne $true) { throw "A matching Rust online update executor was not recognized as active." }
  $script:InstallerTestProcessQueryFails = $true
  $unverifiedExecutor = & $script:ProductionGetNgtUpdateExecutorState $null ([pscustomobject]@{
    updateId = $executorId
    executorPath = $updaterPath
  }) $legacyRelease
  if ($null -ne $unverifiedExecutor) { throw "A failed process query was not kept in the unverified state." }
  $script:InstallerTestProcessQueryFails = $false
  $script:InstallerTestProcesses = @()
  $freshRoot = Join-Path $testRoot "fresh"
  New-Item -ItemType Directory -Path $freshRoot -Force | Out-Null
  $freshPlan = Get-NgtStudioInstallPlan -InstallRoot $freshRoot -TargetVersion "2.0.15"
  if ($freshPlan.mode -ne "first-install") { throw "A clean machine was not classified as a first install." }

  $fixture = New-NgtInstallFixture (Join-Path $testRoot "modes")
  $upgradePlan = Get-NgtStudioInstallPlan -InstallRoot $fixture.installRoot -TargetVersion "2.0.15"
  $repairPlan = Get-NgtStudioInstallPlan -InstallRoot $fixture.installRoot -TargetVersion "2.0.11"
  if ($upgradePlan.mode -ne "upgrade" -or $repairPlan.mode -ne "repair") {
    throw "Upgrade and same-version repair modes were not distinguished."
  }
  $onlineBackup = New-NgtInstallFixture (Join-Path $testRoot "online-backup-state")
  $onlineUpdateId = [guid]::NewGuid().ToString()
  $onlineBackupRoot = Join-Path $onlineBackup.installRoot "data-store\backups\verified-online"
  New-Item -ItemType Directory -Path $onlineBackupRoot -Force | Out-Null
  Write-NgtInstallJsonAtomic (Join-Path $onlineBackup.installRoot "update.lock") ([pscustomobject]@{
    updateId = $onlineUpdateId
    operation = "online-update"
    targetVersion = "2.0.15"
  })
  Write-NgtInstallJsonAtomic (Join-Path $onlineBackup.installRoot "update-status.json") ([pscustomobject]@{
    updateId = $onlineUpdateId
    operation = "online-update"
    status = "installing"
    stage = "backing-up"
    targetVersion = "2.0.15"
  })
  Write-NgtInstallJsonAtomic (Join-Path $onlineBackup.installRoot ".local\update-maintenance.json") ([pscustomobject]@{
    updateId = $onlineUpdateId
    operation = "online-update"
    targetVersion = "2.0.15"
    dataRoot = Join-Path $onlineBackup.installRoot "data-store"
  })
  Set-NgtStudioOnlineUpdateBackup -InstallRoot $onlineBackup.installRoot `
    -UpdateId $onlineUpdateId -BackupRoot $onlineBackupRoot
  $onlineMarkerAfterBackup = Get-NgtInstallJson (Join-Path $onlineBackup.installRoot ".local\update-maintenance.json")
  $onlineStatusAfterBackup = Get-NgtInstallJson (Join-Path $onlineBackup.installRoot "update-status.json")
  if (-not $onlineMarkerAfterBackup.backupVerified -or
      [string]$onlineMarkerAfterBackup.backupRoot -ne [System.IO.Path]::GetFullPath($onlineBackupRoot) -or
      -not $onlineStatusAfterBackup.backupVerified -or
      [string]$onlineStatusAfterBackup.backupRoot -ne [System.IO.Path]::GetFullPath($onlineBackupRoot) -or
      [string]$onlineMarkerAfterBackup.updateId -ne $onlineUpdateId -or
      [string]$onlineStatusAfterBackup.updateId -ne $onlineUpdateId) {
    throw "Online backup state fields were not persisted for the current update ID."
  }
  $onlineProgress = New-NgtInstallFixture (Join-Path $testRoot "online-progress-stages")
  $progressUpdateId = [guid]::NewGuid().ToString()
  Write-NgtInstallJsonAtomic (Join-Path $onlineProgress.installRoot "update.lock") ([pscustomobject]@{
    updateId = $progressUpdateId
    operation = "online-update"
    targetVersion = "2.0.15"
  })
  Write-NgtInstallJsonAtomic (Join-Path $onlineProgress.installRoot "update-status.json") ([pscustomobject]@{
    updateId = $progressUpdateId
    operation = "online-update"
    status = "running"
    stage = "starting-installer"
    targetVersion = "2.0.15"
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  })
  Write-NgtInstallJsonAtomic (Join-Path $onlineProgress.installRoot ".local\update-maintenance.json") ([pscustomobject]@{
    updateId = $progressUpdateId
    operation = "online-update"
    targetVersion = "2.0.15"
  })
  foreach ($stage in @("preparing-release", "backing-up", "verifying-backup", "preparing-runtime", "installing", "validating")) {
    Set-NgtStudioOnlineUpdateStage -InstallRoot $onlineProgress.installRoot `
      -UpdateId $progressUpdateId -Stage $stage
  }
  $onlineProgressStatus = Get-NgtInstallJson (Join-Path $onlineProgress.installRoot "update-status.json")
  if ([string]$onlineProgressStatus.stage -ne "validating" -or
      [string]$onlineProgressStatus.status -ne "validating" -or
      @($onlineProgressStatus.completedStages) -join "," -ne "starting-installer,preparing-release,backing-up,verifying-backup,preparing-runtime,installing" -or
      $onlineProgressStatus.skippedStages -isnot [array]) {
    throw "Online update stage changes did not preserve ordered completed and skipped steps."
  }
  $wrongBackupOwnerRejected = $false
  try {
    Set-NgtStudioOnlineUpdateBackup -InstallRoot $onlineBackup.installRoot `
      -UpdateId ([guid]::NewGuid().ToString()) -BackupRoot $onlineBackupRoot
  } catch { $wrongBackupOwnerRejected = $_.Exception.Message -like "The online installer no longer owns*" }
  if (-not $wrongBackupOwnerRejected) {
    throw "Online backup state accepted a non-current update ID."
  }
  $onlineStarting = New-NgtInstallFixture (Join-Path $testRoot "online-start-reservation")
  $onlineStartingId = [guid]::NewGuid().ToString()
  $onlineStartingTimestamp = (Get-Date).ToUniversalTime().ToString("o")
  Write-NgtInstallJsonAtomic (Join-Path $onlineStarting.installRoot "update.lock") ([pscustomobject]@{
    updateId = $onlineStartingId
    operation = "online-update"
    targetVersion = "2.0.15"
    createdAt = $onlineStartingTimestamp
  })
  Write-NgtInstallJsonAtomic (Join-Path $onlineStarting.installRoot "update-status.json") ([pscustomobject]@{
    updateId = $onlineStartingId
    operation = "online-update"
    status = "starting"
    stage = "starting"
    targetVersion = "2.0.15"
    createdAt = $onlineStartingTimestamp
    executorConfirmed = $false
  })
  $startupReservationProtected = $false
  $startupReservationFailure = ""
  try {
    Start-NgtStudioManualInstall -InstallRoot $onlineStarting.installRoot -TargetVersion "2.0.15" | Out-Null
  } catch {
    $startupReservationFailure = $_.Exception.Message
    $startupReservationProtected = $_.Exception.Message -like "A new online update is reserving the installer*"
  }
  if (-not $startupReservationProtected -or
      -not (Test-Path -LiteralPath (Join-Path $onlineStarting.installRoot "update.lock")) -or
      (Test-Path -LiteralPath (Join-Path $onlineStarting.installRoot ".local\update-maintenance.json"))) {
    throw "A manual installer displaced an online update before the Rust startup handshake: $startupReservationFailure"
  }
  $oldOnlineStartingTimestamp = "2020-01-01T00:00:00.000Z"
  $oldOnlineLock = Get-NgtInstallJson (Join-Path $onlineStarting.installRoot "update.lock")
  $oldOnlineStatus = Get-NgtInstallJson (Join-Path $onlineStarting.installRoot "update-status.json")
  $oldOnlineLock.createdAt = $oldOnlineStartingTimestamp
  $oldOnlineStatus.createdAt = $oldOnlineStartingTimestamp
  Write-NgtInstallJsonAtomic (Join-Path $onlineStarting.installRoot "update.lock") $oldOnlineLock
  Write-NgtInstallJsonAtomic (Join-Path $onlineStarting.installRoot "update-status.json") $oldOnlineStatus
  $staleReservationPlan = Start-NgtStudioManualInstall `
    -InstallRoot $onlineStarting.installRoot -TargetVersion "2.0.15"
  if ($staleReservationPlan.mode -ne "upgrade") {
    throw "A stale unconfirmed online reservation could not be safely superseded."
  }
  $queued = New-NgtInstallFixture (Join-Path $testRoot "queued-without-lock")
  Write-NgtInstallJsonAtomic (Join-Path $queued.installRoot "update-status.json") ([pscustomobject]@{
    status = "queued"
    updateId = [guid]::NewGuid().ToString()
    previousVersion = "2.0.11"
    targetVersion = "2.0.15"
  })
  Start-NgtStudioManualInstall -InstallRoot $queued.installRoot -TargetVersion "2.0.15" | Out-Null
  $queuedResume = Start-NgtStudioManualInstall -InstallRoot $queued.installRoot -TargetVersion "2.0.15"
  if ($queuedResume.mode -ne "upgrade") { throw "The queued update could not be superseded and resumed." }
  $downgradeBlocked = $false
  try { Get-NgtStudioInstallPlan -InstallRoot $fixture.installRoot -TargetVersion "2.0.10" | Out-Null }
  catch { $downgradeBlocked = $_.Exception.Message -like "Downgrade blocked:*" }
  if (-not $downgradeBlocked) { throw "An older installer was not blocked." }

  $legacyLock = New-NgtInstallFixture (Join-Path $testRoot "legacy-timestamp-lock")
  $legacyLockTimestamp = "2026-10-15T00:31:53.000Z"
  [System.IO.File]::WriteAllText(
    (Join-Path $legacyLock.installRoot "update.lock"),
    $legacyLockTimestamp,
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-NgtInstallJsonAtomic (Join-Path $legacyLock.installRoot "update-status.json") ([pscustomobject]@{
    status = "complete"
    updateId = [guid]::NewGuid().ToString()
    actualVersion = "2.0.11"
    previousVersion = "2.0.11"
  })
  $legacyLockPlan = Start-NgtStudioManualInstall -InstallRoot $legacyLock.installRoot -TargetVersion "2.0.15"
  $legacyLockReservation = Get-NgtManualInstallReservation $legacyLock.installRoot
  $legacyLockHistory = Get-NgtInstallJson ([string](Get-NgtInstallJson (Join-Path $legacyLock.installRoot ".local\update-maintenance.json")).historyPath)
  $archivedLegacyTimestamp = ([System.DateTimeOffset]$legacyLockHistory.previousLock.createdAt).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
  if ($legacyLockPlan.mode -ne "upgrade" -or
      $legacyLockReservation.lock.operation -ne "manual-install" -or
      $archivedLegacyTimestamp -ne $legacyLockTimestamp) {
    throw ("A safe legacy timestamp lock was not archived and replaced by the manual installer. " +
      "mode=$($legacyLockPlan.mode); operation=$($legacyLockReservation.lock.operation); " +
      "archived=$($legacyLockHistory.previousLock.createdAt); expected=$legacyLockTimestamp")
  }

  $unsafeLegacyLock = New-NgtInstallFixture (Join-Path $testRoot "unsafe-legacy-timestamp-lock")
  $unsafeLegacyLockPath = Join-Path $unsafeLegacyLock.installRoot "update.lock"
  [System.IO.File]::WriteAllText($unsafeLegacyLockPath, $legacyLockTimestamp, [System.Text.UTF8Encoding]::new($false))
  Write-NgtInstallJsonAtomic (Join-Path $unsafeLegacyLock.installRoot "update-status.json") ([pscustomobject]@{
    status = "failed"
    recoveryStatus = "running"
    updateId = [guid]::NewGuid().ToString()
    previousVersion = "2.0.11"
    targetVersion = "2.0.15"
  })
  $unsafeLegacyBlocked = $false
  try { Start-NgtStudioManualInstall -InstallRoot $unsafeLegacyLock.installRoot -TargetVersion "2.0.15" | Out-Null }
  catch { $unsafeLegacyBlocked = $_.Exception.Message -like "The previous update may have changed the database*" }
  if (-not $unsafeLegacyBlocked -or
      [System.IO.File]::ReadAllText($unsafeLegacyLockPath) -ne $legacyLockTimestamp -or
      (Test-Path -LiteralPath (Join-Path $unsafeLegacyLock.installRoot ".local\update-maintenance.json"))) {
    throw "An unsafe legacy timestamp lock was modified instead of remaining blocked."
  }

  $invalidLegacyLockPath = Join-Path $unsafeLegacyLock.installRoot "invalid-update.lock"
  [System.IO.File]::WriteAllText($invalidLegacyLockPath, "2026-10-15T00", [System.Text.UTF8Encoding]::new($false))
  $invalidLegacyLockBlocked = $false
  try { Get-NgtUpdateLock $invalidLegacyLockPath | Out-Null }
  catch { $invalidLegacyLockBlocked = $_.Exception.Message -like "Install state is unreadable:*legacy ISO-8601 UTC timestamp*" }
  if (-not $invalidLegacyLockBlocked) { throw "An unsupported legacy lock value was not rejected with a format diagnostic." }

  $firstInstall = Join-Path $testRoot "first-install-resume"
  New-Item -ItemType Directory -Path $firstInstall -Force | Out-Null
  Start-NgtStudioManualInstall -InstallRoot $firstInstall -TargetVersion "2.0.15" | Out-Null
  $partialFirstRelease = Join-Path $firstInstall "releases\v2.0.15"
  New-Item -ItemType Directory -Path $partialFirstRelease -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $partialFirstRelease "partial.txt") -Value "incomplete first install"
  $firstResumePlan = Start-NgtStudioManualInstall -InstallRoot $firstInstall -TargetVersion "2.0.15"
  if ($firstResumePlan.mode -ne "first-install") { throw "An interrupted first install did not retain its install mode." }
  $firstResumeMarker = Get-NgtInstallJson (Join-Path $firstInstall ".local\update-maintenance.json")
  Move-NgtStudioIncompleteCandidateRelease -InstallRoot $firstInstall `
    -ReleaseRoot $partialFirstRelease -UpdateId ([string]$firstResumeMarker.updateId) | Out-Null
  if ((Test-Path -LiteralPath $partialFirstRelease) -or
      -not (Get-ChildItem -LiteralPath (Join-Path $firstInstall ".local\failed-install-releases") -Directory)) {
    throw "An incomplete first-install candidate was not preserved for a safe retry."
  }

  $upgradeCandidate = New-NgtInstallFixture (Join-Path $testRoot "upgrade-candidate")
  Start-NgtStudioManualInstall -InstallRoot $upgradeCandidate.installRoot -TargetVersion "2.0.15" | Out-Null
  $upgradeMarker = Get-NgtInstallJson (Join-Path $upgradeCandidate.installRoot ".local\update-maintenance.json")
  Move-NgtStudioIncompleteCandidateRelease -InstallRoot $upgradeCandidate.installRoot `
    -ReleaseRoot $upgradeCandidate.newRelease -UpdateId ([string]$upgradeMarker.updateId) | Out-Null
  if ((Test-Path -LiteralPath $upgradeCandidate.newRelease) -or
      -not (Test-Path -LiteralPath $upgradeCandidate.oldRelease)) {
    throw "A partial upgrade candidate was not isolated from the still-active previous release."
  }

  $onlineCandidate = New-NgtInstallFixture (Join-Path $testRoot "online-upgrade-candidate")
  $onlineCandidateId = [guid]::NewGuid().ToString()
  $onlineCandidateLock = [pscustomobject]@{
    updateId = $onlineCandidateId
    operation = "online-update"
    targetVersion = "2.0.15"
  }
  $onlineCandidateStatus = [pscustomobject]@{
    updateId = $onlineCandidateId
    operation = "online-update"
    status = "installing"
    stage = "installing"
    targetVersion = "2.0.15"
  }
  $onlineCandidateMarker = [pscustomobject]@{
    updateId = $onlineCandidateId
    operation = "online-update"
    targetVersion = "2.0.15"
    previousVersion = "2.0.11"
    previousRelease = $onlineCandidate.oldRelease
    dataRoot = Join-Path $onlineCandidate.installRoot "data-store"
    installMode = "upgrade"
  }
  Write-NgtInstallJsonAtomic (Join-Path $onlineCandidate.installRoot "update.lock") $onlineCandidateLock
  Write-NgtInstallJsonAtomic (Join-Path $onlineCandidate.installRoot "update-status.json") $onlineCandidateStatus
  Write-NgtInstallJsonAtomic `
    (Join-Path $onlineCandidate.installRoot ".local\update-maintenance.json") $onlineCandidateMarker
  $businessDataSentinel = Join-Path $onlineCandidate.installRoot "data-store\business-data.txt"
  New-Item -ItemType Directory -Path (Split-Path -Parent $businessDataSentinel) -Force | Out-Null
  Set-Content -LiteralPath $businessDataSentinel -Value "preserve business data" -NoNewline
  Set-Content -LiteralPath (Join-Path $onlineCandidate.newRelease "partial-only.txt") `
    -Value "interrupted deployment" -NoNewline

  $wrongOnlineOwnerRejected = $false
  try {
    Move-NgtStudioIncompleteCandidateRelease -InstallRoot $onlineCandidate.installRoot `
      -ReleaseRoot $onlineCandidate.newRelease -UpdateId ([guid]::NewGuid().ToString()) | Out-Null
  } catch { $wrongOnlineOwnerRejected = $_.Exception.Message -like "The installer cannot replace*" }
  if (-not $wrongOnlineOwnerRejected -or -not (Test-Path -LiteralPath $onlineCandidate.newRelease)) {
    throw "An unrelated online task was allowed to move the candidate release."
  }

  $onlineCandidateMarker.targetVersion = "2.0.16"
  Write-NgtInstallJsonAtomic `
    (Join-Path $onlineCandidate.installRoot ".local\update-maintenance.json") $onlineCandidateMarker
  $wrongOnlineVersionRejected = $false
  try {
    Move-NgtStudioIncompleteCandidateRelease -InstallRoot $onlineCandidate.installRoot `
      -ReleaseRoot $onlineCandidate.newRelease -UpdateId $onlineCandidateId | Out-Null
  } catch { $wrongOnlineVersionRejected = $_.Exception.Message -like "The installer cannot replace*" }
  if (-not $wrongOnlineVersionRejected -or -not (Test-Path -LiteralPath $onlineCandidate.newRelease)) {
    throw "A mismatched online target version was allowed to move the candidate release."
  }
  $onlineCandidateMarker.targetVersion = "2.0.15"
  Write-NgtInstallJsonAtomic `
    (Join-Path $onlineCandidate.installRoot ".local\update-maintenance.json") $onlineCandidateMarker

  $onlineCandidateMarker.operation = "manual-install"
  Write-NgtInstallJsonAtomic `
    (Join-Path $onlineCandidate.installRoot ".local\update-maintenance.json") $onlineCandidateMarker
  $wrongOnlineMarkerRejected = $false
  try {
    Move-NgtStudioIncompleteCandidateRelease -InstallRoot $onlineCandidate.installRoot `
      -ReleaseRoot $onlineCandidate.newRelease -UpdateId $onlineCandidateId | Out-Null
  } catch { $wrongOnlineMarkerRejected = $_.Exception.Message -like "The installer cannot replace*" }
  if (-not $wrongOnlineMarkerRejected -or -not (Test-Path -LiteralPath $onlineCandidate.newRelease)) {
    throw "A mismatched maintenance operation was allowed to move the online candidate release."
  }
  $onlineCandidateMarker.operation = "online-update"
  Write-NgtInstallJsonAtomic `
    (Join-Path $onlineCandidate.installRoot ".local\update-maintenance.json") $onlineCandidateMarker

  Move-NgtStudioIncompleteCandidateRelease -InstallRoot $onlineCandidate.installRoot `
    -ReleaseRoot $onlineCandidate.newRelease -UpdateId $onlineCandidateId | Out-Null
  $onlineFailedReleases = @(
    Get-ChildItem -LiteralPath (Join-Path $onlineCandidate.installRoot ".local\failed-install-releases") -Directory
  )
  $repeatMove = Move-NgtStudioIncompleteCandidateRelease -InstallRoot $onlineCandidate.installRoot `
    -ReleaseRoot $onlineCandidate.newRelease -UpdateId $onlineCandidateId
  if ((Test-Path -LiteralPath $onlineCandidate.newRelease) -or
      -not (Test-Path -LiteralPath $onlineCandidate.oldRelease) -or
      -not (Test-Path -LiteralPath $businessDataSentinel) -or
      $onlineFailedReleases.Count -ne 1 -or $null -ne $repeatMove) {
    throw "An online retry did not isolate exactly one incomplete candidate while preserving the active release and data."
  }
  New-Item -ItemType Directory -Path $onlineCandidate.newRelease -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $onlineCandidate.newRelease "studio-release.json") `
    -Value '{"version":"2.0.15"}' -NoNewline
  if ((Test-Path -LiteralPath (Join-Path $onlineCandidate.newRelease "partial-only.txt")) -or
      -not (Test-Path -LiteralPath (Join-Path $onlineCandidate.newRelease "studio-release.json"))) {
    throw "A same-version online retry reused files from the interrupted candidate."
  }

  $activeCandidate = New-NgtInstallFixture (Join-Path $testRoot "online-active-candidate")
  $activeCandidateId = [guid]::NewGuid().ToString()
  $activeCandidateConfigPath = Join-Path $activeCandidate.installRoot ".local\studio.json"
  $activeCandidateConfig = Get-NgtInstallJson $activeCandidateConfigPath
  $activeCandidateConfig.activeRelease = $activeCandidate.newRelease
  Write-NgtInstallJsonAtomic $activeCandidateConfigPath $activeCandidateConfig
  Write-NgtInstallJsonAtomic (Join-Path $activeCandidate.installRoot "update.lock") ([pscustomobject]@{
    updateId = $activeCandidateId
    operation = "online-update"
    targetVersion = "2.0.15"
  })
  Write-NgtInstallJsonAtomic (Join-Path $activeCandidate.installRoot "update-status.json") ([pscustomobject]@{
    updateId = $activeCandidateId
    operation = "online-update"
    status = "installing"
    targetVersion = "2.0.15"
  })
  Write-NgtInstallJsonAtomic `
    (Join-Path $activeCandidate.installRoot ".local\update-maintenance.json") ([pscustomobject]@{
      updateId = $activeCandidateId
      operation = "online-update"
      targetVersion = "2.0.15"
      previousVersion = "2.0.11"
      previousRelease = $activeCandidate.oldRelease
      dataRoot = Join-Path $activeCandidate.installRoot "data-store"
      installMode = "upgrade"
    })
  $activeCandidateRejected = $false
  try {
    Move-NgtStudioIncompleteCandidateRelease -InstallRoot $activeCandidate.installRoot `
      -ReleaseRoot $activeCandidate.newRelease -UpdateId $activeCandidateId | Out-Null
  } catch { $activeCandidateRejected = $true }
  if (-not $activeCandidateRejected -or -not (Test-Path -LiteralPath $activeCandidate.newRelease)) {
    throw "The active online release was moved as if it were an incomplete candidate."
  }

  $activeRoot = Join-Path $testRoot "active"
  $active = New-NgtInstallFixture $activeRoot
  $updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16"
  Write-NgtInstallJsonAtomic (Join-Path $active.installRoot "update.lock") ([pscustomobject]@{
    updateId = $updateId
    executorPid = 12345
    executorScriptPath = Join-Path $active.oldRelease "scripts\update-windows-studio.ps1"
  })
  Write-NgtInstallJsonAtomic (Join-Path $active.installRoot "update-status.json") ([pscustomobject]@{
    status = "queued"
    updateId = $updateId
    previousVersion = "2.0.11"
    targetVersion = "2.0.12"
  })
  $script:InstallerTestExecutorState = $true
  $activeUpdateBlocked = $false
  try { Start-NgtStudioManualInstall -InstallRoot $active.installRoot -TargetVersion "2.0.15" | Out-Null }
  catch { $activeUpdateBlocked = $_.Exception.Message -like "An online update executor is active*" }
  if (-not $activeUpdateBlocked -or (Test-Path -LiteralPath (Join-Path $active.installRoot ".local\update-maintenance.json"))) {
    throw "The installer did not block an active online updater before modifying state."
  }

  $script:InstallerTestExecutorState = $false
  $plan = Start-NgtStudioManualInstall -InstallRoot $active.installRoot -TargetVersion "2.0.15"
  if ($plan.mode -ne "upgrade") { throw "The v2.0.11 to v2.0.15 upgrade mode was not selected." }
  $reservation = Get-NgtManualInstallReservation $active.installRoot
  if ($reservation.marker.operation -ne "manual-install" -or
      $reservation.lock.updateId -ne $reservation.marker.updateId) {
    throw "The manual installer did not reserve the shared update state atomically."
  }
  $oldUpdateId = $reservation.marker.updateId
  $verifiedHealthRequired = $false
  try {
    Complete-NgtStudioManualInstall -InstallRoot $active.installRoot `
      -ReleaseRoot $active.newRelease -VerifiedVersion "2.0.15"
  } catch { $verifiedHealthRequired = $_.Exception.Message -like "A successful application and database health check*" }
  if (-not $verifiedHealthRequired) { throw "The installer finalized without a health-validation attestation." }
  $configPath = Join-Path $active.installRoot ".local\studio.json"
  $config = Get-NgtInstallJson $configPath
  $config.activeRelease = $active.newRelease
  Write-NgtInstallJsonAtomic $configPath $config
  Complete-NgtStudioManualInstall -InstallRoot $active.installRoot `
    -ReleaseRoot $active.newRelease -VerifiedVersion "2.0.15" -HealthVerified
  $finalStatus = Get-NgtInstallJson (Join-Path $active.installRoot "update-status.json")
  if ($finalStatus.status -ne "superseded" -or
      $finalStatus.previousStatus -ne "queued" -or
      $finalStatus.previousUpdateId -ne $updateId -or
      $finalStatus.actualVersion -ne "2.0.15") {
    throw "The queued v2.0.11 task was not retained as a verified supersession."
  }
  if ((Test-Path -LiteralPath (Join-Path $active.installRoot "update.lock")) -or
      (Test-Path -LiteralPath (Join-Path $active.installRoot ".local\update-maintenance.json"))) {
    throw "A verified installation left its task lock or maintenance marker behind."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $active.installRoot ".local\update-history\$oldUpdateId.json"))) {
    throw "The prior task's diagnostic state was not archived."
  }
  $sameVersionRepair = Start-NgtStudioManualInstall -InstallRoot $active.installRoot -TargetVersion "2.0.15"
  if ($sameVersionRepair.mode -ne "repair") { throw "A completed upgrade could not enter same-version repair." }
  Complete-NgtStudioManualInstall -InstallRoot $active.installRoot `
    -ReleaseRoot $active.newRelease -VerifiedVersion "2.0.15" -HealthVerified
  $repairedStatus = Get-NgtInstallJson (Join-Path $active.installRoot "update-status.json")
  if ($repairedStatus.status -ne "idle" -or $repairedStatus.installMode -ne "repair" -or
      (Test-Path -LiteralPath (Join-Path $active.installRoot "update.lock")) -or
      (Test-Path -LiteralPath (Join-Path $active.installRoot ".local\update-maintenance.json"))) {
    throw "A verified same-version repair did not clear the prior superseded state."
  }

  $legacyRecovery = New-NgtInstallFixture (Join-Path $testRoot "legacy-v2.0.15-recovery")
  $installedRelease = $legacyRecovery.newRelease
  $legacyConfigPath = Join-Path $legacyRecovery.installRoot ".local\studio.json"
  $legacyConfig = Get-NgtInstallJson $legacyConfigPath
  $legacyConfig.activeRelease = $installedRelease
  Write-NgtInstallJsonAtomic $legacyConfigPath $legacyConfig
  $legacyUpdateId = [guid]::NewGuid().ToString()
  Write-NgtInstallJsonAtomic (Join-Path $legacyRecovery.installRoot "update-status.json") ([pscustomobject]@{
    status = "queued"
    stage = "queued"
    updateId = $legacyUpdateId
    previousVersion = "2.0.11"
    targetVersion = "2.0.12"
  })
  $legacyRepairPlan = Start-NgtStudioManualInstall `
    -InstallRoot $legacyRecovery.installRoot -TargetVersion "2.0.15"
  if ($legacyRepairPlan.mode -ne "repair") {
    throw "An already-installed v2.0.15 instance with a queued legacy task was not repairable."
  }
  Complete-NgtStudioManualInstall -InstallRoot $legacyRecovery.installRoot `
    -ReleaseRoot $installedRelease -VerifiedVersion "2.0.15" -HealthVerified
  $legacyRecoveredStatus = Get-NgtInstallJson (Join-Path $legacyRecovery.installRoot "update-status.json")
  if ($legacyRecoveredStatus.status -ne "superseded" -or
      $legacyRecoveredStatus.previousStatus -ne "queued" -or
      $legacyRecoveredStatus.previousUpdateId -ne $legacyUpdateId -or
      $legacyRecoveredStatus.actualVersion -ne "2.0.15" -or
      (Test-Path -LiteralPath (Join-Path $legacyRecovery.installRoot "update.lock")) -or
      (Test-Path -LiteralPath (Join-Path $legacyRecovery.installRoot ".local\update-maintenance.json"))) {
    throw "A health-verified v2.0.15 repair did not safely resolve its queued v2.0.11-era task."
  }

  $rollback = New-NgtInstallFixture (Join-Path $testRoot "rollback")
  $script:InstallerTestExecutorState = $false
  Start-NgtStudioManualInstall -InstallRoot $rollback.installRoot -TargetVersion "2.0.15" | Out-Null
  $rollbackMarker = Get-NgtInstallJson (Join-Path $rollback.installRoot ".local\update-maintenance.json")
  $rollbackBackup = Join-Path $rollback.installRoot "data-store\backups\verified-fixture"
  New-Item -ItemType Directory -Path $rollbackBackup -Force | Out-Null
  Set-NgtStudioManualInstallBackup -InstallRoot $rollback.installRoot `
    -UpdateId ([string]$rollbackMarker.updateId) -BackupRoot $rollbackBackup
  $rollbackHealthRequired = $false
  try {
    Complete-NgtStudioManualInstallRollback -InstallRoot $rollback.installRoot `
      -PreviousReleaseRoot $rollback.oldRelease -VerifiedVersion "2.0.11" `
      -FailureMessage "simulated failed migration" -FailedStage "migrations"
  } catch { $rollbackHealthRequired = $_.Exception.Message -like "A successful rollback health check*" }
  if (-not $rollbackHealthRequired) { throw "The installer cleared maintenance without a verified rollback health check." }
  Complete-NgtStudioManualInstallRollback -InstallRoot $rollback.installRoot `
    -PreviousReleaseRoot $rollback.oldRelease -VerifiedVersion "2.0.11" `
    -FailureMessage "simulated failed migration" -FailedStage "migrations" -HealthVerified
  $rollbackStatus = Get-NgtInstallJson (Join-Path $rollback.installRoot "update-status.json")
  if ($rollbackStatus.status -ne "failed" -or $rollbackStatus.recoveryStatus -ne "succeeded" -or
      $rollbackStatus.actualVersion -ne "2.0.11" -or $rollbackStatus.failedStage -ne "migrations" -or
      -not (Test-NgtSafeStaleUpdate $rollbackStatus "2.0.11")) {
    throw "A health-verified installer rollback was not recorded as recoverable."
  }
  if ((Test-Path -LiteralPath (Join-Path $rollback.installRoot "update.lock")) -or
      (Test-Path -LiteralPath (Join-Path $rollback.installRoot ".local\update-maintenance.json"))) {
    throw "A verified rollback left its task lock or maintenance marker behind."
  }

  $repair = New-NgtInstallFixture (Join-Path $testRoot "repair")
  $repairPlan = Start-NgtStudioManualInstall -InstallRoot $repair.installRoot -TargetVersion "2.0.11"
  if ($repairPlan.mode -ne "repair") { throw "A same-version installer was not classified as a repair." }
  $repairResumePlan = Start-NgtStudioManualInstall -InstallRoot $repair.installRoot -TargetVersion "2.0.11"
  if ($repairResumePlan.mode -ne "repair" -or $repairResumePlan.previousRelease -ne $repair.oldRelease) {
    throw "A repair could not resume with its original release path."
  }
  $repairMarker = Get-NgtInstallJson (Join-Path $repair.installRoot ".local\update-maintenance.json")
  $repairBackup = Join-Path $repair.installRoot "data-store\backups\verified-repair-fixture"
  New-Item -ItemType Directory -Path (Join-Path $repairBackup "postgres-data"), (Join-Path $repair.oldRelease "scripts") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $repairBackup "postgres-data\fixture.data") -Value "verified database data" -NoNewline
  $backupFileHash = (Get-FileHash -LiteralPath (Join-Path $repairBackup "postgres-data\fixture.data") -Algorithm SHA256).Hash
  Set-Content -LiteralPath (Join-Path $repairBackup "SHA256SUMS.txt") -Value ("$backupFileHash  postgres-data\fixture.data") -Encoding utf8
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "test-windows-studio-backup.ps1") `
    -Destination (Join-Path $repair.oldRelease "scripts\test-windows-studio-backup.ps1")
  Set-NgtStudioManualInstallBackup -InstallRoot $repair.installRoot `
    -UpdateId ([string]$repairMarker.updateId) -BackupRoot $repairBackup
  function Protect-NgtRepairInstallation([string]$InstallRoot, [object]$Plan) {
    & $script:ProductionProtectNgtRepairInstallation -InstallRoot $InstallRoot -Plan $Plan
  }
  $verifiedRepairResume = Start-NgtStudioManualInstall -InstallRoot $repair.installRoot -TargetVersion "2.0.11"
  if ($verifiedRepairResume.mode -ne "repair" -or $verifiedRepairResume.previousRelease -ne $repair.oldRelease) {
    throw "A verified repair backup changed the resuming release plan."
  }
  Set-Content -LiteralPath (Join-Path $repair.oldRelease "previous-release.txt") -Value "previous release" -NoNewline
  Move-NgtStudioRepairReleaseToBackup -InstallRoot $repair.installRoot `
    -ReleaseRoot $repair.oldRelease -UpdateId ([string]$repairMarker.updateId) | Out-Null
  if (Test-Path -LiteralPath $repair.oldRelease) {
    throw "A repair overwrote its active release before preserving a rollback copy."
  }
  & $script:ProductionProtectNgtRepairInstallation -InstallRoot $repair.installRoot -Plan $repairPlan
  New-Item -ItemType Directory -Path $repair.oldRelease -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $repair.oldRelease "studio-release.json") -Value '{"version":"2.0.11"}'
  Set-Content -LiteralPath (Join-Path $repair.oldRelease "candidate.txt") -Value "partially deployed repair"
  Restore-NgtStudioRepairReleaseBackup -InstallRoot $repair.installRoot `
    -ReleaseRoot $repair.oldRelease -UpdateId ([string]$repairMarker.updateId) | Out-Null
  if ((Get-Content -LiteralPath (Join-Path $repair.oldRelease "previous-release.txt") -Raw) -ne "previous release" -or
      -not (Get-ChildItem -LiteralPath (Join-Path $repair.installRoot ".local\failed-install-releases") -Directory)) {
    throw "A failed repair did not restore the original program files and preserve the incomplete candidate."
  }
  Complete-NgtStudioManualInstallRollback -InstallRoot $repair.installRoot `
    -PreviousReleaseRoot $repair.oldRelease -VerifiedVersion "2.0.11" `
    -FailureMessage "simulated repair failure" -FailedStage "release-deployment" -HealthVerified

  Write-Output "Windows Studio install coordination tests passed."
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
