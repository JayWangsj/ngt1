$ErrorActionPreference = "Stop"

function Get-NgtInstallJson([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw "Install state is unreadable: $Path"
  }
}

function Get-NgtUpdateLock([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $contents = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    $legacyTimestamp = $contents.Trim()
    if ($legacyTimestamp -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
      $parsedTimestamp = [System.DateTimeOffset]::MinValue
      if ([System.DateTimeOffset]::TryParseExact(
        $legacyTimestamp,
        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal,
        [ref]$parsedTimestamp
      )) {
        return [pscustomobject]@{ createdAt = $legacyTimestamp }
      }
    }
    try {
      return $contents | ConvertFrom-Json -ErrorAction Stop
    } catch {
      throw "Expected JSON or a legacy ISO-8601 UTC timestamp. $($_.Exception.Message)"
    }
  } catch {
    throw "Install state is unreadable: $Path. $($_.Exception.Message)"
  }
}

function Write-NgtInstallJsonAtomic([string]$Path, [object]$Value) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  $backup = "$Path.$PID.$([guid]::NewGuid().ToString('N')).bak"
  $json = $Value | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
  try {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [System.IO.File]::Replace($temporary, $Path, $backup)
    } else {
      if (Test-Path -LiteralPath $Path) {
        throw "Install state target is not a regular file: $Path"
      }
      try {
        [System.IO.File]::Move($temporary, $Path)
      } catch {
        throw "Unable to create install state at '$Path' from '$temporary': $($_.Exception.Message)"
      }
    }
    $verified = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ([string]$verified.updateId -ne [string]$Value.updateId) {
      throw "Install state could not be verified after writing: $Path"
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-NgtStudioInstallMutex([string]$InstallRoot, [scriptblock]$Action) {
  $mutexRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\").ToLowerInvariant()
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $rootHash = [System.BitConverter]::ToString(
      $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($mutexRoot))
    ).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  $mutex = [System.Threading.Mutex]::new($false, "Global\NGTStudioUpdate-$rootHash")
  $owned = $false
  try {
    try { $owned = $mutex.WaitOne(10000) }
    catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { throw "Timed out waiting for the system update lock." }
    & $Action
  } finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Get-NgtUpdateExecutorState(
  [object]$Lock,
  [object]$Status,
  [string]$ActiveRelease
) {
  try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  } catch {
    return $null
  }
  $executorPid = if ($Lock.executorPid) { [int]$Lock.executorPid } elseif ($Status.executorPid) { [int]$Status.executorPid } else { 0 }
  $updateId = if ($Lock.updateId) { [string]$Lock.updateId } else { [string]$Status.updateId }
  if (-not $updateId) { return $false }
  $executorPath = if ($Lock.executorPath) {
    [string]$Lock.executorPath
  } elseif ($Status.executorPath) {
    [string]$Status.executorPath
  } else {
    Join-Path $ActiveRelease "tools\NGTUpdater.exe"
  }
  $legacyScript = if ($Lock.executorScriptPath) {
    [string]$Lock.executorScriptPath
  } elseif ($Status.executorScriptPath) {
    [string]$Status.executorScriptPath
  } else {
    $null
  }
  try { $target = [System.IO.Path]::GetFullPath($executorPath) } catch { return $null }
  $legacyTarget = $null
  if ($legacyScript) {
    try { $legacyTarget = [System.IO.Path]::GetFullPath($legacyScript) } catch { return $null }
  }
  $unverified = $false
  foreach ($process in $processes) {
    if ($executorPid -gt 0 -and [int]$process.ProcessId -ne $executorPid) { continue }
    if ($process.Name -ine "NGTUpdater.exe" -and $process.Name -notmatch '^(powershell|pwsh)(\.exe)?$') { continue }
    $commandLine = [string]$process.CommandLine
    if (-not $commandLine) { $unverified = $true; continue }
    if ($process.Name -ieq "NGTUpdater.exe") {
      try { $processPath = [System.IO.Path]::GetFullPath([string]$process.ExecutablePath) } catch { $unverified = $true; continue }
      if ($processPath.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) -and
          $commandLine.IndexOf($updateId, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
      continue
    }
    if ($legacyTarget -and $process.Name -match '^(powershell|pwsh)(\.exe)?$') {
      $quotedScript = '"' + [regex]::Escape($legacyTarget) + '"'
      $taskArgument = '(?i)-UpdateId\s+["'']?' + [regex]::Escape($updateId) + '(?:["'']|\s|$)'
      if ($commandLine -match $quotedScript -and $commandLine -match $taskArgument) { return $true }
    }
  }
  if ($unverified) { return $null }
  return $false
}

function Compare-NgtStudioVersion([string]$Left, [string]$Right) {
  try {
    $leftVersion = [version]($Left -replace '^v', '')
    $rightVersion = [version]($Right -replace '^v', '')
  } catch {
    throw "Invalid Studio version metadata."
  }
  return $leftVersion.CompareTo($rightVersion)
}

function Get-NgtInstallerParentProcessId {
  try {
    $process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + $PID) -ErrorAction Stop
  } catch {
    throw "Unable to verify which installer process launched the preflight."
  }
  if (-not $process -or [int]$process.ParentProcessId -le 0) {
    throw "Unable to verify which installer process launched the preflight."
  }
  return [int]$process.ParentProcessId
}

function Get-NgtStudioInstallPlan([string]$InstallRoot, [string]$TargetVersion, [object]$ManualMarker) {
  Compare-NgtStudioVersion $TargetVersion $TargetVersion | Out-Null
  $stableRoot = [System.IO.Path]::GetFullPath($InstallRoot)
  $stateRoot = Join-Path $stableRoot ".local"
  $configPath = Join-Path $stateRoot "studio.json"
  $config = Get-NgtInstallJson $configPath
  if (-not $config) {
    if ($ManualMarker -and
        $ManualMarker.operation -eq "manual-install" -and
        [string]$ManualMarker.targetVersion -eq $TargetVersion -and
        [string]$ManualMarker.installMode -eq "first-install" -and
        -not $ManualMarker.previousVersion -and -not $ManualMarker.previousRelease -and
        [System.IO.Path]::GetFullPath([string]$ManualMarker.dataRoot) -ieq
          [System.IO.Path]::GetFullPath((Join-Path $stableRoot "data-store"))) {
      return [pscustomobject]@{
        mode = "first-install"
        installRoot = $stableRoot
        targetVersion = $TargetVersion
        previousVersion = ""
        previousRelease = ""
        dataRoot = [System.IO.Path]::GetFullPath([string]$ManualMarker.dataRoot)
      }
    }
    foreach ($fileName in @("update-status.json", "update.lock", "update-maintenance.json")) {
      if (Test-Path -LiteralPath (Join-Path $stableRoot $fileName)) {
        throw "An incomplete NGT installation has update state but no readable Studio configuration. Repair it before installing."
      }
    }
    $orphanedData = Join-Path $stableRoot "data-store\data"
    if (Test-Path -LiteralPath $orphanedData -PathType Container) {
      throw "Existing NGT database files were found without an installation record. The installer will not initialize over them."
    }
    return [pscustomobject]@{
      mode = "first-install"
      installRoot = $stableRoot
      targetVersion = $TargetVersion
      previousVersion = ""
      previousRelease = ""
      dataRoot = Join-Path $stableRoot "data-store"
    }
  }

  if ([System.IO.Path]::GetFullPath([string]$config.installRoot) -ine $stableRoot) {
    throw "The saved Studio configuration points to a different installation root: '$($config.installRoot)' (expected '$stableRoot')."
  }
  $previousRelease = [System.IO.Path]::GetFullPath([string]$config.activeRelease)
  $metadataRoot = $previousRelease
  if ($ManualMarker.releaseBackupRoot) {
    $expectedBackupRoot = [System.IO.Path]::GetFullPath((Join-Path $stableRoot ".local\manual-install-release-backups\$($ManualMarker.updateId)"))
    if ([System.IO.Path]::GetFullPath([string]$ManualMarker.releaseBackupRoot) -ine $expectedBackupRoot) {
      throw "The manual repair release backup points outside its installer-owned directory."
    }
    if (Test-Path -LiteralPath $expectedBackupRoot -PathType Container) {
      $metadataRoot = $expectedBackupRoot
    }
  }
  $previousMetadataPath = Join-Path $metadataRoot "studio-release.json"
  $previousMetadata = Get-NgtInstallJson $previousMetadataPath
  if (-not $previousMetadata.version) { throw "The active installed Studio version cannot be verified." }
  $previousVersion = [string]$previousMetadata.version
  $comparison = Compare-NgtStudioVersion $TargetVersion $previousVersion
  if ($comparison -lt 0) {
    throw "Downgrade blocked: v$TargetVersion is older than the installed v$previousVersion."
  }
  return [pscustomobject]@{
    mode = if ($comparison -eq 0) { "repair" } else { "upgrade" }
    installRoot = $stableRoot
    targetVersion = $TargetVersion
    previousVersion = $previousVersion
    previousRelease = $previousRelease
    dataRoot = [System.IO.Path]::GetFullPath([string]$config.dataRoot)
  }
}

function Test-NgtSafeStaleUpdate([object]$Status, [string]$CurrentVersion) {
  if (-not $Status) { return $false }
  if ($Status.recoveryStatus -in @("running", "failed")) { return $false }
  if ($Status.recoveryStatus -eq "succeeded") {
    return [string]$Status.actualVersion -eq $CurrentVersion -and
      [string]$Status.previousVersion -eq $CurrentVersion
  }
  $stage = if ($Status.failedStage) { [string]$Status.failedStage } elseif ($Status.stage) { [string]$Status.stage } else { [string]$Status.status }
  if ($stage -in @("starting", "queued", "reading-release", "checking", "downloading", "downloaded", "verifying", "preparing-runtime")) {
    $completed = @($Status.completedStages | Where-Object { $_ -in @("backing-up", "installing", "validating", "rolling-back") })
    return $completed.Count -eq 0
  }
  if ($Status.status -eq "complete") {
    return [string]$Status.actualVersion -eq $CurrentVersion -or [string]$Status.targetVersion -eq $CurrentVersion
  }
  if ($Status.status -in @("failed", "interrupted")) {
    return [string]$Status.failedStage -in @("starting", "reading-release", "checking", "downloading", "downloaded", "verifying", "preparing-runtime")
  }
  return $false
}

function Get-NgtManualInstallReservation([string]$InstallRoot) {
  $root = [System.IO.Path]::GetFullPath($InstallRoot)
  $lock = Get-NgtUpdateLock (Join-Path $root "update.lock")
  $status = Get-NgtInstallJson (Join-Path $root "update-status.json")
  $marker = Get-NgtInstallJson (Join-Path $root ".local\update-maintenance.json")
  return [pscustomobject]@{ lock = $lock; status = $status; marker = $marker }
}

function Protect-NgtRepairInstallation([string]$InstallRoot, [object]$Plan) {
  if ($Plan.mode -ne "repair" -or -not $Plan.previousRelease) { return }
  $reservation = Get-NgtManualInstallReservation $InstallRoot
  $marker = $reservation.marker
  if (-not $marker -or [string]$marker.updateId -ne [string]$reservation.lock.updateId) {
    throw "The repair installation does not own a verified maintenance marker."
  }
  $previousReleaseRoot = [string]$Plan.previousRelease
  if ($marker.releaseBackupRoot -and (Test-Path -LiteralPath ([string]$marker.releaseBackupRoot) -PathType Container)) {
    $previousReleaseRoot = [string]$marker.releaseBackupRoot
  }
  if ($marker.backupVerified -and $marker.backupRoot) {
    $testScript = Join-Path $previousReleaseRoot "scripts\test-windows-studio-backup.ps1"
    if (-not (Test-Path -LiteralPath $testScript -PathType Leaf)) {
      throw "The saved repair backup cannot be verified because the backup checker is missing."
    }
    & $testScript -BackupRoot ([string]$marker.backupRoot) | Out-Null
    return
  }
  $backupScript = Join-Path $previousReleaseRoot "scripts\backup-windows-studio.ps1"
  $testScript = Join-Path $previousReleaseRoot "scripts\test-windows-studio-backup.ps1"
  if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf) -or
      -not (Test-Path -LiteralPath $testScript -PathType Leaf)) {
    throw "The installed version does not provide verified database backup support; repair was stopped before files were replaced."
  }
  $backupOutput = @(& $backupScript -LeaveStopped)
  $backupLine = @($backupOutput | Where-Object { [string]$_ -like "Studio backup created: *" } | Select-Object -Last 1)
  if (-not $backupLine) { throw "The repair backup did not return its destination." }
  $backupRoot = [string]$backupLine[0].Substring("Studio backup created: ".Length)
  & $testScript -BackupRoot $backupRoot | Out-Null
  $marker | Add-Member -NotePropertyName backupRoot -NotePropertyValue $backupRoot -Force
  $marker | Add-Member -NotePropertyName backupVerified -NotePropertyValue $true -Force
  $marker | Add-Member -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force
  Write-NgtInstallJsonAtomic (Join-Path $InstallRoot ".local\update-maintenance.json") $marker
}

function Set-NgtStudioManualInstallBackup(
  [string]$InstallRoot,
  [string]$UpdateId,
  [string]$BackupRoot
) {
  Invoke-NgtStudioInstallMutex $InstallRoot {
    $markerPath = Join-Path $InstallRoot ".local\update-maintenance.json"
    $marker = Get-NgtInstallJson $markerPath
    $lock = Get-NgtInstallJson (Join-Path $InstallRoot "update.lock")
    if (-not $marker -or [string]$marker.updateId -ne $UpdateId -or [string]$lock.updateId -ne $UpdateId) {
      throw "Manual installation no longer owns the backup state."
    }
    $marker | Add-Member -NotePropertyName backupRoot -NotePropertyValue $BackupRoot -Force
    $marker | Add-Member -NotePropertyName backupVerified -NotePropertyValue $true -Force
    $marker | Add-Member -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force
    Write-NgtInstallJsonAtomic $markerPath $marker
  }
}

function Set-NgtStudioManualInstallReleaseBackup(
  [string]$InstallRoot,
  [string]$UpdateId,
  [string]$ReleaseRoot,
  [string]$BackupRoot
) {
  Invoke-NgtStudioInstallMutex $InstallRoot {
    $reservation = Get-NgtManualInstallReservation $InstallRoot
    $expectedBackupRoot = [System.IO.Path]::GetFullPath((Join-Path $InstallRoot ".local\manual-install-release-backups\$UpdateId"))
    if (-not $reservation.marker -or
        [string]$reservation.marker.updateId -ne $UpdateId -or
        [string]$reservation.lock.updateId -ne $UpdateId -or
        [string]$reservation.status.manualInstallId -ne $UpdateId -or
        [string]$reservation.marker.installMode -ne "repair" -or
        [System.IO.Path]::GetFullPath([string]$reservation.marker.previousRelease) -ine [System.IO.Path]::GetFullPath($ReleaseRoot) -or
        [System.IO.Path]::GetFullPath($BackupRoot) -ine $expectedBackupRoot) {
      throw "The manual repair does not own this release backup path."
    }
    if ($reservation.marker.releaseBackupRoot -and
        [System.IO.Path]::GetFullPath([string]$reservation.marker.releaseBackupRoot) -ine $expectedBackupRoot) {
      throw "The manual repair release backup path changed during installation."
    }
    $reservation.marker | Add-Member -NotePropertyName releaseBackupRoot -NotePropertyValue $expectedBackupRoot -Force
    $reservation.marker | Add-Member -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force
    Write-NgtInstallJsonAtomic (Join-Path $InstallRoot ".local\update-maintenance.json") $reservation.marker
  }
}

function Move-NgtStudioRepairReleaseToBackup(
  [string]$InstallRoot,
  [string]$ReleaseRoot,
  [string]$UpdateId
) {
  $root = [System.IO.Path]::GetFullPath($InstallRoot)
  $release = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $backupRoot = [System.IO.Path]::GetFullPath((Join-Path $root ".local\manual-install-release-backups\$UpdateId"))
  $reservation = Get-NgtManualInstallReservation $root
  if (-not $reservation.marker -or
      [string]$reservation.marker.updateId -ne $UpdateId -or
      [string]$reservation.lock.updateId -ne $UpdateId -or
      [string]$reservation.marker.installMode -ne "repair" -or
      [System.IO.Path]::GetFullPath([string]$reservation.marker.previousRelease) -ine $release -or
      -not $reservation.marker.backupVerified) {
    throw "The manual repair cannot move its active release before its verified data backup is ready."
  }
  Set-NgtStudioManualInstallReleaseBackup -InstallRoot $root -UpdateId $UpdateId `
    -ReleaseRoot $release -BackupRoot $backupRoot
  if (Test-Path -LiteralPath $backupRoot -PathType Container) {
    if (Test-Path -LiteralPath $release -PathType Container) {
      $failedReleaseRoot = Join-Path $root (".local\failed-install-releases\{0}-{1}" -f $UpdateId, [guid]::NewGuid().ToString("N"))
      New-Item -ItemType Directory -Path (Split-Path -Parent $failedReleaseRoot) -Force | Out-Null
      Move-Item -LiteralPath $release -Destination $failedReleaseRoot
    }
  } else {
    if (-not (Test-Path -LiteralPath $release -PathType Container)) {
      throw "The previous release disappeared before its repair backup was created."
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $backupRoot) -Force | Out-Null
    Move-Item -LiteralPath $release -Destination $backupRoot
  }
  return $backupRoot
}

function Restore-NgtStudioRepairReleaseBackup(
  [string]$InstallRoot,
  [string]$ReleaseRoot,
  [string]$UpdateId
) {
  $root = [System.IO.Path]::GetFullPath($InstallRoot)
  $release = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $reservation = Get-NgtManualInstallReservation $root
  $marker = $reservation.marker
  if (-not $marker -or
      [string]$marker.updateId -ne $UpdateId -or
      [string]$reservation.lock.updateId -ne $UpdateId -or
      [string]$marker.installMode -ne "repair") {
    throw "The manual repair no longer owns the previous release backup."
  }
  if (-not $marker.releaseBackupRoot) { return $false }
  $backupRoot = [System.IO.Path]::GetFullPath([string]$marker.releaseBackupRoot)
  $expectedBackupRoot = [System.IO.Path]::GetFullPath((Join-Path $root ".local\manual-install-release-backups\$UpdateId"))
  if ($backupRoot -ine $expectedBackupRoot -or
      [System.IO.Path]::GetFullPath([string]$marker.previousRelease) -ine $release) {
    throw "The manual repair release backup is outside its installer-owned directory."
  }
  if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) {
    if (-not (Test-Path -LiteralPath $release -PathType Container)) {
      throw "The previous release backup and active release are both missing."
    }
    return $false
  }
  if (Test-Path -LiteralPath $release -PathType Container) {
    $failedReleaseRoot = Join-Path $root (".local\failed-install-releases\{0}-{1}" -f $UpdateId, [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path (Split-Path -Parent $failedReleaseRoot) -Force | Out-Null
    Move-Item -LiteralPath $release -Destination $failedReleaseRoot
  }
  Move-Item -LiteralPath $backupRoot -Destination $release
  return $true
}

function Move-NgtStudioIncompleteCandidateRelease(
  [string]$InstallRoot,
  [string]$ReleaseRoot,
  [string]$UpdateId
) {
  $root = [System.IO.Path]::GetFullPath($InstallRoot)
  $release = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $reservation = Get-NgtManualInstallReservation $root
  $marker = $reservation.marker
  $expectedRelease = [System.IO.Path]::GetFullPath((Join-Path $root ("releases\v" + [string]$marker.targetVersion)))
  if (-not $marker -or
      [string]$marker.updateId -ne $UpdateId -or
      [string]$reservation.lock.updateId -ne $UpdateId -or
      [string]$reservation.status.manualInstallId -ne $UpdateId -or
      [string]$marker.targetVersion -eq "" -or
      [string]$marker.installMode -notin @("first-install", "upgrade") -or
      $release -ine $expectedRelease) {
    throw "The installer cannot replace a release directory outside its reserved candidate path."
  }
  if ($marker.installMode -eq "first-install") {
    if ($marker.previousVersion -or $marker.previousRelease -or
        (Test-Path -LiteralPath (Join-Path $root ".local\studio.json"))) {
      throw "The first-install reservation unexpectedly names a previous release."
    }
  } else {
    $previousRelease = [System.IO.Path]::GetFullPath([string]$marker.previousRelease)
    if ($previousRelease -ieq $release) {
      throw "An active release cannot be treated as an incomplete upgrade candidate."
    }
    $previousMetadata = Get-NgtInstallJson (Join-Path $previousRelease "studio-release.json")
    $configuration = Get-NgtInstallJson (Join-Path $root ".local\studio.json")
    if ([string]$previousMetadata.version -ne [string]$marker.previousVersion -or
        [System.IO.Path]::GetFullPath([string]$configuration.activeRelease) -ine $previousRelease) {
      throw "The previous application release cannot be verified before replacing an upgrade candidate."
    }
  }
  if (-not (Test-Path -LiteralPath $release -PathType Container)) { return $null }
  $failedReleaseRoot = Join-Path $root (".local\failed-install-releases\{0}-{1}" -f $UpdateId, [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path (Split-Path -Parent $failedReleaseRoot) -Force | Out-Null
  Move-Item -LiteralPath $release -Destination $failedReleaseRoot
  return $failedReleaseRoot
}

function Start-NgtStudioManualInstall([string]$InstallRoot, [string]$TargetVersion) {
  Invoke-NgtStudioInstallMutex $InstallRoot {
    $root = [System.IO.Path]::GetFullPath($InstallRoot)
    $reservation = Get-NgtManualInstallReservation $root
    $resumeMarker = $null
    if ($reservation.marker) {
      if ($reservation.marker.operation -ne "manual-install" -or
          [string]$reservation.marker.targetVersion -ne $TargetVersion -or
          [string]$reservation.marker.updateId -ne [string]$reservation.lock.updateId -or
          [string]$reservation.marker.updateId -ne [string]$reservation.status.updateId) {
        throw "A different or unverifiable maintenance operation is already present."
      }
      $resumeMarker = $reservation.marker
    }
    $plan = Get-NgtStudioInstallPlan $root $TargetVersion $resumeMarker
    $resuming = $false
    if (-not $reservation.marker -and
        $reservation.lock.operation -eq "manual-install" -and
        [string]$reservation.status.manualInstallId -eq [string]$reservation.lock.updateId -and
        [string]$reservation.status.status -in @("idle", "complete", "superseded")) {
      Remove-Item -LiteralPath (Join-Path $root "update.lock") -Force -ErrorAction Stop
      $reservation.lock = $null
    }
    if ($reservation.marker) {
      if ($reservation.marker.operation -ne "manual-install" -or
          [string]$reservation.marker.targetVersion -ne $TargetVersion -or
          [string]$reservation.marker.updateId -ne [string]$reservation.lock.updateId -or
          [string]$reservation.marker.updateId -ne [string]$reservation.status.updateId) {
        throw "A different or unverifiable maintenance operation is already present."
      }
      $setupProcessId = [int]$reservation.marker.setupPid
      $currentSetupProcessId = Get-NgtInstallerParentProcessId
      if ($setupProcessId -gt 0 -and $setupProcessId -ne $currentSetupProcessId -and
          (Get-Process -Id $setupProcessId -ErrorAction SilentlyContinue)) {
        throw "Another NGT installer is still running."
      }
      if ([string]$reservation.marker.installMode -eq "first-install" -and $plan.mode -eq "repair") {
        $configuration = Get-NgtInstallJson (Join-Path $root ".local\studio.json")
        $activeRelease = [System.IO.Path]::GetFullPath([string]$configuration.activeRelease)
        $activeMetadata = Get-NgtInstallJson (Join-Path $activeRelease "studio-release.json")
        if ([string]$activeMetadata.version -ne $TargetVersion -or
            [string]$reservation.marker.targetVersion -ne $TargetVersion -or
            [string]$reservation.marker.previousVersion -or [string]$reservation.marker.previousRelease) {
          throw "The interrupted first installation cannot be safely resumed as a repair."
        }
        $plan.previousVersion = [string]$activeMetadata.version
        $plan.previousRelease = $activeRelease
        $plan.dataRoot = [System.IO.Path]::GetFullPath([string]$configuration.dataRoot)
        $plan.mode = "repair"
        $reservation.marker.previousVersion = [string]$activeMetadata.version
        $reservation.marker.previousRelease = $activeRelease
        $reservation.marker.dataRoot = $plan.dataRoot
        $reservation.marker.installMode = "repair"
        $reservation.lock.mode = "repair"
        $reservation.status.previousVersion = [string]$activeMetadata.version
        $reservation.status.installMode = "repair"
        Write-NgtInstallJsonAtomic (Join-Path $root "update.lock") $reservation.lock
        Write-NgtInstallJsonAtomic (Join-Path $root "update-status.json") $reservation.status
        Write-NgtInstallJsonAtomic (Join-Path $root ".local\update-maintenance.json") $reservation.marker
      }
      $resuming = $true
    } elseif ($reservation.lock) {
      if (-not $reservation.status -or
          ([string]$reservation.lock.updateId -and [string]$reservation.lock.updateId -ne [string]$reservation.status.updateId)) {
        throw "The existing update lock does not match a readable task status."
      }
      $alive = Get-NgtUpdateExecutorState $reservation.lock $reservation.status $plan.previousRelease
      if ($alive -ne $false) { throw "An online update executor is active or cannot be verified. Close it before installing." }
      if (-not (Test-NgtSafeStaleUpdate $reservation.status $plan.previousVersion)) {
        throw "The previous update may have changed the database or installation. Verify and recover it before installing."
      }
    } elseif ($reservation.status) {
      $active = [string]$reservation.status.status -in @("starting", "queued", "running", "checking", "downloading", "downloaded", "verifying", "preparing-runtime", "backing-up", "installing", "validating", "rolling-back")
      if ($active) {
        $alive = Get-NgtUpdateExecutorState $null $reservation.status $plan.previousRelease
        if ($alive -ne $false -or -not (Test-NgtSafeStaleUpdate $reservation.status $plan.previousVersion)) {
          throw "An unfinished online update cannot be verified safe to replace."
        }
      }
      if ([string]$reservation.status.status -in @("failed", "interrupted") -and
          -not (Test-NgtSafeStaleUpdate $reservation.status $plan.previousVersion)) {
        throw "The previous update recovery is unresolved. Verify the database and maintenance state before installing."
      }
      if ([string]$reservation.status.operation -eq "manual-install" -and
          [string]$reservation.status.status -notin @("idle", "complete", "superseded")) {
        throw "A previous manual installation did not finish its verification. Rerun the same installer to resume it."
      }
    }

    if (-not $resuming) {
      $updateId = [guid]::NewGuid().ToString()
      $historyPath = Join-Path $root (".local\update-history\{0}.json" -f $updateId)
      if ($reservation.status -or $reservation.lock) {
        Write-NgtInstallJsonAtomic $historyPath ([pscustomobject]@{
          operation = "manual-install"
          archivedAt = (Get-Date).ToUniversalTime().ToString("o")
          previousStatus = $reservation.status
          previousLock = $reservation.lock
        })
      }
      $setupPid = Get-NgtInstallerParentProcessId
      $lock = [pscustomobject]@{
        updateId = $updateId
        targetVersion = $TargetVersion
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        executorPid = $PID
        executorScriptPath = $PSCommandPath
        operation = "manual-install"
        setupPid = $setupPid
        mode = $plan.mode
      }
      $status = [pscustomobject]@{
        status = "installing"
        stage = "installing"
        operation = "manual-install"
        updateId = $updateId
        manualInstallId = $updateId
        targetVersion = $TargetVersion
        previousVersion = $plan.previousVersion
        executorPid = $PID
        executorScriptPath = $PSCommandPath
        executorConfirmed = $true
        createdAt = $lock.createdAt
        updatedAt = $lock.createdAt
        installMode = $plan.mode
      }
      $marker = [pscustomobject]@{
        operation = "manual-install"
        updateId = $updateId
        targetVersion = $TargetVersion
        previousVersion = $plan.previousVersion
        previousRelease = $plan.previousRelease
        dataRoot = $plan.dataRoot
        installMode = $plan.mode
        setupPid = $setupPid
        historyPath = $historyPath
        updatedAt = $lock.createdAt
      }
      Write-NgtInstallJsonAtomic (Join-Path $root "update.lock") $lock
      Write-NgtInstallJsonAtomic (Join-Path $root "update-status.json") $status
      Write-NgtInstallJsonAtomic (Join-Path $root ".local\update-maintenance.json") $marker
    }
    $stageLog = Join-Path $root "install-stages.log"
    New-Item -ItemType Directory -Path (Split-Path -Parent $stageLog) -Force | Out-Null
    Add-Content -LiteralPath $stageLog -Value ("{0:o} DETECTED mode={1} target=v{2}" -f (Get-Date).ToUniversalTime(), $plan.mode, $TargetVersion)
    if ($plan.mode -eq "repair") {
      Protect-NgtRepairInstallation -InstallRoot $InstallRoot -Plan $plan
    }
    return $plan
  }
}

function Start-NgtStudioOnlineUpdateInstall(
  [string]$InstallRoot,
  [string]$TargetVersion,
  [string]$UpdateId
) {
  $state = Invoke-NgtStudioInstallMutex $InstallRoot {
    $root = [System.IO.Path]::GetFullPath($InstallRoot)
    $reservation = Get-NgtManualInstallReservation $root
    $lock = $reservation.lock
    $status = $reservation.status
    if (-not $UpdateId -or
        [string]$lock.updateId -ne $UpdateId -or
        [string]$status.updateId -ne $UpdateId -or
        [string]$lock.operation -ne "online-update" -or
        [string]$status.operation -ne "online-update" -or
        [string]$lock.targetVersion -ne $TargetVersion -or
        [string]$status.targetVersion -ne $TargetVersion -or
        -not $status.executorConfirmed -or
        [int]$status.executorPid -le 0 -or
        -not (Get-NgtUpdateExecutorState $lock $status ([string](Get-NgtInstallJson (Join-Path $root ".local\studio.json")).activeRelease))) {
      throw "The Rust updater does not own a verifiable online installation task."
    }
    if ($reservation.marker) {
      if ([string]$reservation.marker.operation -ne "online-update" -or
          [string]$reservation.marker.updateId -ne $UpdateId -or
          [string]$reservation.marker.targetVersion -ne $TargetVersion) {
        throw "A different or unverifiable maintenance operation is already present."
      }
      return [pscustomobject]@{
        plan = Get-NgtStudioInstallPlan $root $TargetVersion $reservation.marker
        backupRoot = [string]$reservation.marker.backupRoot
        backupVerified = [bool]$reservation.marker.backupVerified
      }
    }
    $plan = Get-NgtStudioInstallPlan $root $TargetVersion $null
    $marker = [pscustomobject]@{
      operation = "online-update"
      updateId = $UpdateId
      targetVersion = $TargetVersion
      previousVersion = $plan.previousVersion
      previousRelease = $plan.previousRelease
      dataRoot = $plan.dataRoot
      installMode = $plan.mode
      updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    Write-NgtInstallJsonAtomic (Join-Path $root ".local\update-maintenance.json") $marker
    return [pscustomobject]@{
      plan = $plan
      backupRoot = ""
      backupVerified = $false
    }
  }

  if ($state.backupVerified -and $state.backupRoot) {
    $testScript = Join-Path $state.plan.previousRelease "scripts\test-windows-studio-backup.ps1"
    if (-not (Test-Path -LiteralPath $testScript -PathType Leaf)) {
      throw "The existing online-update backup cannot be verified because its checker is missing."
    }
    & $testScript -BackupRoot $state.backupRoot | Out-Null
    return $state.plan
  }

  $backupScript = Join-Path $state.plan.previousRelease "scripts\backup-windows-studio.ps1"
  $testScript = Join-Path $state.plan.previousRelease "scripts\test-windows-studio-backup.ps1"
  if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf) -or
      -not (Test-Path -LiteralPath $testScript -PathType Leaf)) {
    throw "The active release does not provide verified database backup support."
  }
  Set-NgtStudioOnlineUpdateStage -InstallRoot $InstallRoot -UpdateId $UpdateId -Stage "backing-up"
  try {
    $backupOutput = @(& $backupScript -LeaveStopped)
    $backupLine = @($backupOutput | Where-Object { [string]$_ -like "Studio backup created: *" } | Select-Object -Last 1)
    if (-not $backupLine) { throw "The online update backup did not return its destination." }
    $backupRoot = [string]$backupLine[0].Substring("Studio backup created: ".Length)
    & $testScript -BackupRoot $backupRoot | Out-Null
    Set-NgtStudioOnlineUpdateBackup -InstallRoot $InstallRoot -UpdateId $UpdateId -BackupRoot $backupRoot
    return $state.plan
  } catch {
    $failure = $_
    try {
      $startupScript = Join-Path $state.plan.previousRelease "scripts\install-windows-startup.ps1"
      if (-not (Test-Path -LiteralPath $startupScript -PathType Leaf)) {
        throw "The previous release startup script is missing after the database backup failed."
      }
      & $startupScript -InstallRoot $InstallRoot
      $deadline = (Get-Date).AddMinutes(2)
      $healthy = $false
      do {
        try {
          $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5
          $healthy = [string]$health.status -eq "ok" -and [string]$health.currentVersion -eq [string]$state.plan.previousVersion
        } catch { }
        if ($healthy) { break }
        Start-Sleep -Seconds 2
      } while ((Get-Date) -lt $deadline)
      if (-not $healthy) { throw "The previous release could not be restarted after the database backup failed." }
      Invoke-NgtStudioInstallMutex $InstallRoot {
        $reservation = Get-NgtManualInstallReservation $InstallRoot
        if ([string]$reservation.marker.updateId -eq $UpdateId -and
            -not $reservation.marker.backupVerified) {
          Remove-Item -LiteralPath (Join-Path $InstallRoot ".local\update-maintenance.json") -Force
        }
      }
    } catch {
      throw ("The online update backup failed and automatic restart verification failed: " + $_.Exception.Message)
    }
    throw $failure
  }
}

function Set-NgtStudioOnlineUpdateStage(
  [string]$InstallRoot,
  [string]$UpdateId,
  [string]$Stage
) {
  Invoke-NgtStudioInstallMutex $InstallRoot {
    $reservation = Get-NgtManualInstallReservation $InstallRoot
    if ([string]$reservation.marker.operation -ne "online-update" -or
        [string]$reservation.marker.updateId -ne $UpdateId -or
        [string]$reservation.lock.updateId -ne $UpdateId -or
        [string]$reservation.status.updateId -ne $UpdateId) {
      throw "The online installer no longer owns its update stage."
    }
    $status = $reservation.status
    $status.status = if ($Stage -eq "validating") { "validating" } else { "installing" }
    $status.stage = $Stage
    $status.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    Write-NgtInstallJsonAtomic (Join-Path $InstallRoot "update-status.json") $status
  }
}

function Set-NgtStudioOnlineUpdateBackup(
  [string]$InstallRoot,
  [string]$UpdateId,
  [string]$BackupRoot
) {
  Invoke-NgtStudioInstallMutex $InstallRoot {
    $reservation = Get-NgtManualInstallReservation $InstallRoot
    if ([string]$reservation.marker.operation -ne "online-update" -or
        [string]$reservation.marker.updateId -ne $UpdateId -or
        [string]$reservation.lock.updateId -ne $UpdateId -or
        [string]$reservation.status.updateId -ne $UpdateId) {
      throw "The online installer no longer owns the verified database backup."
    }
    $backupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
    $allowedBackupRoot = [System.IO.Path]::GetFullPath((Join-Path ([string]$reservation.marker.dataRoot) "backups")).TrimEnd("\") + "\"
    if (-not $backupRoot.StartsWith($allowedBackupRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "The online installer backup is outside the configured data directory."
    }
    $reservation.marker.backupRoot = $backupRoot
    $reservation.marker.backupVerified = $true
    $reservation.marker.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    Write-NgtInstallJsonAtomic (Join-Path $InstallRoot ".local\update-maintenance.json") $reservation.marker
    $status = $reservation.status
    $status.status = "installing"
    $status.stage = "backing-up"
    $status.backupRoot = $backupRoot
    $status.backupVerified = $true
    $status.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    Write-NgtInstallJsonAtomic (Join-Path $InstallRoot "update-status.json") $status
  }
}

function Complete-NgtStudioManualInstall(
  [string]$InstallRoot,
  [string]$ReleaseRoot,
  [string]$VerifiedVersion,
  [switch]$HealthVerified,
  [switch]$OnlineUpdate
) {
  if (-not $HealthVerified) { throw "A successful application and database health check is required before installation state can be finalized." }
  Invoke-NgtStudioInstallMutex $InstallRoot {
    $root = [System.IO.Path]::GetFullPath($InstallRoot)
    $reservation = Get-NgtManualInstallReservation $root
    $marker = $reservation.marker
    $lock = $reservation.lock
    $expectedOperation = if ($OnlineUpdate) { "online-update" } else { "manual-install" }
    if (-not $marker -or $marker.operation -ne $expectedOperation -or
        [string]$marker.updateId -ne [string]$lock.updateId -or
        [string]$marker.updateId -ne [string]$(if ($marker.operation -eq "manual-install") { $reservation.status.manualInstallId } else { $reservation.status.updateId }) -or
        [string]$marker.targetVersion -ne $VerifiedVersion) {
      throw "The installer does not own the maintenance marker and update lock."
    }
    $activeRelease = [System.IO.Path]::GetFullPath([string](Get-NgtInstallJson (Join-Path $root ".local\studio.json")).activeRelease)
    $release = Get-NgtInstallJson (Join-Path $activeRelease "studio-release.json")
    if ($activeRelease -ine [System.IO.Path]::GetFullPath($ReleaseRoot) -or [string]$release.version -ne $VerifiedVersion) {
      throw "The active release does not match the health-verified installer version."
    }
    if ($marker.operation -eq "online-update") {
      if (-not $marker.backupVerified -or -not $marker.backupRoot) {
        throw "The online update cannot finish without a verified database backup."
      }
      Remove-Item -LiteralPath (Join-Path $root ".local\update-maintenance.json") -Force -ErrorAction Stop
      return
    }
    if ($reservation.status.status -in @("complete", "superseded", "idle") -and
        [string]$reservation.status.manualInstallId -eq [string]$marker.updateId) {
      Remove-Item -LiteralPath (Join-Path $root ".local\update-maintenance.json") -Force -ErrorAction Stop
      Remove-Item -LiteralPath (Join-Path $root "update.lock") -Force -ErrorAction Stop
      return
    }
    $archived = $null
    if ($marker.historyPath -and (Test-Path -LiteralPath $marker.historyPath -PathType Leaf)) {
      $history = Get-NgtInstallJson ([string]$marker.historyPath)
      $archived = $history.previousStatus
      if ($history.previousLock -or $archived) {
        $alive = Get-NgtUpdateExecutorState $history.previousLock $archived ([string]$marker.previousRelease)
        if ($alive -ne $false) {
          throw "The previous online update executor is still active or cannot be verified."
        }
      }
    }
    $previousVersion = [string]$marker.previousVersion
    $finalStatus = if ($archived -and
      [string]$archived.status -notin @("idle", "superseded") -and
      ([string]$archived.status -ne "complete" -or [string]$archived.targetVersion -ne $VerifiedVersion)) {
      [pscustomobject]@{
        status = "superseded"
        stage = "complete"
        operation = "manual-install"
        updateId = [string]$archived.updateId
        previousUpdateId = [string]$archived.updateId
        manualInstallId = [string]$marker.updateId
        previousStatus = [string]$archived.status
        targetVersion = $VerifiedVersion
        previousVersion = $previousVersion
        currentVersion = $VerifiedVersion
        actualVersion = $VerifiedVersion
        installMode = [string]$marker.installMode
        message = "The previous update task was safely superseded by a manually installed release after database and application health checks passed."
        recoveryMessage = [string]$archived.recoveryMessage
        createdAt = [string]$archived.createdAt
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
      }
    } else {
      [pscustomobject]@{
        status = "idle"
        operation = "manual-install"
        manualInstallId = [string]$marker.updateId
        previousVersion = $previousVersion
        currentVersion = $VerifiedVersion
        actualVersion = $VerifiedVersion
        installMode = [string]$marker.installMode
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
      }
    }
    Write-NgtInstallJsonAtomic (Join-Path $root "update-status.json") $finalStatus
    Remove-Item -LiteralPath (Join-Path $root ".local\update-maintenance.json") -Force -ErrorAction Stop
    Remove-Item -LiteralPath (Join-Path $root "update.lock") -Force -ErrorAction Stop
    if ($marker.releaseBackupRoot -and (Test-Path -LiteralPath ([string]$marker.releaseBackupRoot) -PathType Container)) {
      Remove-Item -LiteralPath ([string]$marker.releaseBackupRoot) -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Complete-NgtStudioManualInstallRollback(
  [string]$InstallRoot,
  [string]$PreviousReleaseRoot,
  [string]$VerifiedVersion,
  [string]$FailureMessage,
  [string]$FailedStage,
  [switch]$OnlineUpdate,
  [switch]$HealthVerified
) {
  if (-not $HealthVerified) { throw "A successful rollback health check is required before maintenance can be cleared." }
  Invoke-NgtStudioInstallMutex $InstallRoot {
    $root = [System.IO.Path]::GetFullPath($InstallRoot)
    $reservation = Get-NgtManualInstallReservation $root
    $marker = $reservation.marker
    $expectedOperation = if ($OnlineUpdate) { "online-update" } else { "manual-install" }
    if (-not $marker -or $marker.operation -ne $expectedOperation -or
        -not $marker.backupVerified -or
        [string]$marker.updateId -ne [string]$reservation.lock.updateId -or
        [string]$marker.updateId -ne [string]$(if ($marker.operation -eq "manual-install") { $reservation.status.manualInstallId } else { $reservation.status.updateId })) {
      throw "The installer does not own a verified backup and maintenance marker."
    }
    if (-not (Test-Path -LiteralPath ([string]$marker.backupRoot) -PathType Container)) {
      throw "The verified rollback backup is no longer available."
    }
    $configuration = Get-NgtInstallJson (Join-Path $root ".local\studio.json")
    $activeRelease = [System.IO.Path]::GetFullPath([string]$configuration.activeRelease)
    $release = Get-NgtInstallJson (Join-Path $activeRelease "studio-release.json")
    if ($activeRelease -ine [System.IO.Path]::GetFullPath($PreviousReleaseRoot) -or
        [string]$release.version -ne $VerifiedVersion) {
      throw "The restored release does not match the health-verified rollback version."
    }
    $status = [pscustomobject]@{
      status = "failed"
      stage = "rolling-back"
      failedStage = $FailedStage
      operation = [string]$marker.operation
      updateId = [string]$marker.updateId
      manualInstallId = if ($marker.operation -eq "manual-install") { [string]$marker.updateId } else { $null }
      targetVersion = [string]$marker.targetVersion
      previousVersion = $VerifiedVersion
      currentVersion = $VerifiedVersion
      actualVersion = $VerifiedVersion
      installMode = [string]$marker.installMode
      recoveryStatus = "succeeded"
      recoveryMessage = $FailureMessage
      manualReview = $false
      updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    Write-NgtInstallJsonAtomic (Join-Path $root "update-status.json") $status
    Remove-Item -LiteralPath (Join-Path $root ".local\update-maintenance.json") -Force -ErrorAction Stop
    if ($marker.operation -eq "manual-install") {
      Remove-Item -LiteralPath (Join-Path $root "update.lock") -Force -ErrorAction Stop
    }
  }
}

function Set-NgtStudioManualInstallFailure(
  [string]$InstallRoot,
  [string]$Stage,
  [string]$Message,
  [string]$RecoveryStatus = "not-started"
) {
  Invoke-NgtStudioInstallMutex $InstallRoot {
    $reservation = Get-NgtManualInstallReservation $InstallRoot
    if (-not $reservation.marker -or
        [string]$reservation.marker.operation -notin @("manual-install", "online-update") -or
        [string]$reservation.marker.updateId -ne [string]$reservation.lock.updateId) { return }
    $status = [pscustomobject]@{
      status = "failed"
      stage = $Stage
      failedStage = $Stage
      operation = [string]$reservation.marker.operation
      updateId = [string]$reservation.marker.updateId
      manualInstallId = if ($reservation.marker.operation -eq "manual-install") { [string]$reservation.marker.updateId } else { $null }
      targetVersion = [string]$reservation.marker.targetVersion
      previousVersion = [string]$reservation.marker.previousVersion
      installMode = [string]$reservation.marker.installMode
      message = $Message
      recoveryStatus = $RecoveryStatus
      manualReview = $true
      updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    Write-NgtInstallJsonAtomic (Join-Path $InstallRoot "update-status.json") $status
  }
}
