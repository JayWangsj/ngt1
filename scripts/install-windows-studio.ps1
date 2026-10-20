param(
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "NGT\data-store"),
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "NGT"),
  [string]$PreviousReleaseRoot,
  [string]$UpdateId,
  [switch]$InPlace,
  [switch]$OnlineUpdate
)
# v2.0.15 passes these two arguments without -OnlineUpdate.
if ($InPlace -and $PreviousReleaseRoot -and -not $OnlineUpdate) { $OnlineUpdate = $true }
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "studio-runtime.ps1")

function Invoke-NgtInstallStage([string]$Name, [scriptblock]$Action) {
  $script:NgtInstallStage = $Name
  if ($script:NgtOnlineUpdateId) {
    $onlineStage = switch ($Name) {
      "database-backup" { "backing-up" }
      "health-validation" { "validating" }
      default { "installing" }
    }
    Set-NgtStudioOnlineUpdateStage -InstallRoot $InstallRoot `
      -UpdateId $script:NgtOnlineUpdateId -Stage $onlineStage
  }
  $logPath = Join-Path $env:LOCALAPPDATA "NGT\install-stages.log"
  New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
  $startedAt = Get-Date
  Add-Content -LiteralPath $logPath -Value ("{0:o} START {1}" -f $startedAt.ToUniversalTime(), $Name)
  try {
    & $Action
    $elapsed = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
    Add-Content -LiteralPath $logPath -Value ("{0:o} COMPLETE {1} durationSeconds={2}" -f (Get-Date).ToUniversalTime(), $Name, $elapsed)
  } catch {
    $elapsed = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
    Add-Content -LiteralPath $logPath -Value ("{0:o} FAILED {1} durationSeconds={2} reason={3}" -f (Get-Date).ToUniversalTime(), $Name, $elapsed, $_.Exception.Message)
    throw
  }
}

$manualInstall = $false
$onlineInstall = $false
$script:NgtOnlineUpdateId = $UpdateId
$script:NgtInstallStage = "preflight"
function Restore-NgtStudioAfterManualInstallFailure([string]$InstallRoot, [string]$FailureMessage, [string]$FailedStage) {
  if (-not (Get-Command Stop-NgtStudioProcesses -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot "windows-studio-common.ps1")
  }
  $markerPath = Join-Path $InstallRoot ".local\update-maintenance.json"
  $reservation = Get-NgtManualInstallReservation $InstallRoot
  $marker = $reservation.marker
  if (-not $marker -or -not $marker.backupVerified -or -not $marker.backupRoot) {
    return $false
  }
  if ($marker.operation -notin @("manual-install", "online-update") -or
      [string]$marker.updateId -ne [string]$reservation.lock.updateId -or
      [string]$marker.updateId -ne [string]$(if ($marker.operation -eq "manual-install") { $reservation.status.manualInstallId } else { $reservation.status.updateId })) {
    throw "The failed installer no longer owns the maintenance marker and lock."
  }
  $backupRoot = [System.IO.Path]::GetFullPath([string]$marker.backupRoot)
  if (-not $marker.dataRoot) { throw "The installer did not record a data root for rollback verification." }
  $allowedBackupRoot = [System.IO.Path]::GetFullPath((Join-Path ([string]$marker.dataRoot) "backups")).TrimEnd("\") + "\"
  if (-not $backupRoot.StartsWith($allowedBackupRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The rollback backup is outside the installer-recorded backup directory."
  }
  & (Join-Path $PSScriptRoot "test-windows-studio-backup.ps1") -BackupRoot $backupRoot | Out-Null
  if ($marker.installMode -eq "repair" -and $marker.releaseBackupRoot) {
    Restore-NgtStudioRepairReleaseBackup `
      -InstallRoot $InstallRoot `
      -ReleaseRoot ([string]$marker.previousRelease) `
      -UpdateId ([string]$marker.updateId) | Out-Null
  }
  $backupConfigurationPath = Join-Path $backupRoot "config\studio.json"
  $previousConfig = Get-NgtInstallJson $backupConfigurationPath
  if (-not $previousConfig.activeRelease -or -not $previousConfig.dataRoot) {
    throw "The verified backup does not contain the previous Studio configuration."
  }
  if ([System.IO.Path]::GetFullPath([string]$previousConfig.dataRoot) -ine [System.IO.Path]::GetFullPath([string]$marker.dataRoot) -or
      [System.IO.Path]::GetFullPath([string]$previousConfig.activeRelease) -ine [System.IO.Path]::GetFullPath([string]$marker.previousRelease)) {
    throw "The rollback backup does not match the installer-recorded data root and previous release."
  }
  $previousRelease = [System.IO.Path]::GetFullPath([string]$previousConfig.activeRelease)
  $previousReleaseMetadata = Get-NgtInstallJson (Join-Path $previousRelease "studio-release.json")
  if (-not $previousReleaseMetadata.version) {
    throw "The previous application release is not available for rollback."
  }
  $startupScript = Join-Path $previousRelease "scripts\install-windows-startup.ps1"
  if (-not (Test-Path -LiteralPath $startupScript -PathType Leaf)) {
    throw "The previous application startup script is missing."
  }

  $script:NgtInstallStage = "rolling-back"
  Stop-NgtStudioProcesses
  $dataDirectory = Join-Path ([string]$previousConfig.dataRoot) "data"
  if (Test-Path -LiteralPath $dataDirectory -PathType Container) {
    $failedDataDirectory = $dataDirectory + ".failed-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N")
    Move-Item -LiteralPath $dataDirectory -Destination $failedDataDirectory
  }
  $databaseBackup = Join-Path $backupRoot "postgres-data"
  New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
  Get-ChildItem -LiteralPath $databaseBackup -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $dataDirectory -Recurse -Force
  }
  $backupSecrets = Join-Path $backupRoot "config\local-secrets.json"
  if (Test-Path -LiteralPath $backupSecrets -PathType Leaf) {
    Copy-Item -LiteralPath $backupSecrets -Destination ([string]$previousConfig.dataRoot) -Force
  }
  $backupEnvironment = Join-Path $backupRoot "config\.env"
  if (Test-Path -LiteralPath $backupEnvironment -PathType Leaf) {
    Copy-Item -LiteralPath $backupEnvironment -Destination $previousRelease -Force
  }
  $stableServiceDirectory = Join-Path $InstallRoot "service"
  foreach ($fileName in @(
    "windows-service.ps1",
    "windows-studio-common.ps1",
    "windows-studio-launcher.vbs",
    "uninstall-windows-studio.ps1",
    "uninstall-windows-startup.ps1"
  )) {
    $source = Join-Path $backupRoot ("service\" + $fileName)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "The verified backup is missing service file $fileName."
    }
    Copy-Item -LiteralPath $source -Destination $stableServiceDirectory -Force
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath (Join-Path $stableServiceDirectory $fileName) -Algorithm SHA256).Hash) {
      throw "The restored service file could not be verified: $fileName"
    }
  }
  $previousConfig.installRoot = $InstallRoot
  $previousConfig.activeRelease = $previousRelease
  Set-NgtStudioConfig -Path (Join-Path $InstallRoot ".local\studio.json") -Configuration $previousConfig
  Set-NgtStudioConfig -Path (Join-Path $previousRelease ".local\studio.json") -Configuration $previousConfig
  $env:NGT_DATA_ROOT = [System.IO.Path]::GetFullPath([string]$previousConfig.dataRoot)
  & $startupScript -InstallRoot $InstallRoot
  Wait-NgtStudioHealth -ExpectedVersion ([string]$previousReleaseMetadata.version)
  Complete-NgtStudioManualInstallRollback -InstallRoot $InstallRoot `
    -PreviousReleaseRoot $previousRelease `
    -VerifiedVersion ([string]$previousReleaseMetadata.version) `
    -FailureMessage ("Manual installation failed and the previous release and database backup were restored and health-checked. " + $FailureMessage) `
    -FailedStage $FailedStage `
    -OnlineUpdate:($marker.operation -eq "online-update") `
    -HealthVerified
  return $true
}

trap {
  $failureRecord = $_
  $installFailure = [string]$failureRecord.Exception.Message -replace "[\r\n]", " "
  $failedInstallStage = $script:NgtInstallStage
  try {
    $failureLog = Join-Path $env:LOCALAPPDATA "NGT\install-stages.log"
    New-Item -ItemType Directory -Path (Split-Path -Parent $failureLog) -Force | Out-Null
    Add-Content -LiteralPath $failureLog -Value ("{0:o} FAILURE {1} type={2} reason={3}" -f `
      (Get-Date).ToUniversalTime(), $failedInstallStage, $failureRecord.Exception.GetType().FullName, $installFailure)
    if ($failureRecord.InvocationInfo.PositionMessage) {
      Add-Content -LiteralPath $failureLog -Value ("POSITION {0}" -f $failureRecord.InvocationInfo.PositionMessage)
    }
    if ($failureRecord.ScriptStackTrace) {
      Add-Content -LiteralPath $failureLog -Value ("STACK {0}" -f $failureRecord.ScriptStackTrace)
    }
  } catch { }
  if (($manualInstall -or $onlineInstall) -and (Get-Command Set-NgtStudioManualInstallFailure -ErrorAction SilentlyContinue)) {
    $recoveryStatus = "not-started"
    $restored = $false
    try {
      $restored = Restore-NgtStudioAfterManualInstallFailure `
        -InstallRoot $InstallRoot -FailureMessage $installFailure -FailedStage $failedInstallStage
    } catch {
      $recoveryStatus = "failed"
      $installFailure += " Rollback verification failed: " + $_.Exception.Message
    }
    if ($restored) {
      throw "Manual installation failed; the prior release and database were restored and verified."
    }
    try {
      Set-NgtStudioManualInstallFailure -InstallRoot $InstallRoot `
        -Stage $failedInstallStage -Message $installFailure `
        -RecoveryStatus $recoveryStatus
    } catch { }
  }
  throw $failureRecord
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$stableInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$releaseFile = Join-Path $sourceRoot "studio-release.json"
$release = if (Test-Path -LiteralPath $releaseFile) {
  Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json
} else { $null }
if (Test-Path -LiteralPath $releaseFile) {
  . (Join-Path $PSScriptRoot "windows-studio-install-coordination.ps1")
  $incomingRelease = Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json
  if ($OnlineUpdate) {
    if (-not $UpdateId) { throw "A Rust updater task ID is required for an online installation." }
    $onlineInstallPlan = Start-NgtStudioOnlineUpdateInstall `
      -InstallRoot $InstallRoot -TargetVersion ([string]$incomingRelease.version) -UpdateId $UpdateId
    $onlineInstall = $true
  } else {
    $manualInstallPlan = Start-NgtStudioManualInstall `
      -InstallRoot $InstallRoot -TargetVersion ([string]$incomingRelease.version)
    $manualInstall = $true
  }
}
if ((Test-Path -LiteralPath $releaseFile) -and (-not $InPlace)) {
  $stableRoot = Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) ("releases\v" + $release.version)
  if ([System.IO.Path]::GetFullPath($sourceRoot) -ne [System.IO.Path]::GetFullPath($stableRoot)) {
    & (Join-Path $sourceRoot "scripts\verify-windows-studio-release.ps1") `
      -ReleaseRoot $sourceRoot -ExpectedVersion ([string]$release.version) | Out-Null
    if (Test-Path -LiteralPath $stableRoot) {
      $manualReservation = if ($manualInstall -or $onlineInstall) { Get-NgtManualInstallReservation $stableInstallRoot } else { $null }
      $previousRepairRelease = if ($manualReservation) { [string]$manualReservation.marker.previousRelease } else { "" }
      $installMode = if ($onlineInstall) { $onlineInstallPlan.mode } else { $manualInstallPlan.mode }
      if ((-not $manualInstall -and -not $onlineInstall) -or $installMode -ne "repair" -or
          -not $previousRepairRelease -or
          [System.IO.Path]::GetFullPath($previousRepairRelease) -ine [System.IO.Path]::GetFullPath($stableRoot)) {
        if ((-not $manualInstall -and -not $onlineInstall) -or $installMode -notin @("first-install", "upgrade")) {
          throw "Studio release is already installed: $stableRoot"
        }
        if ($manualInstall) { Invoke-NgtInstallStage "incomplete-release-recovery" {
          Move-NgtStudioIncompleteCandidateRelease `
            -InstallRoot $stableInstallRoot `
            -ReleaseRoot $stableRoot `
            -UpdateId ([string](Get-NgtManualInstallReservation $stableInstallRoot).marker.updateId) | Out-Null
        } }
      } else {
        Invoke-NgtInstallStage "release-backup" {
          Move-NgtStudioRepairReleaseToBackup `
            -InstallRoot $stableInstallRoot `
            -ReleaseRoot $stableRoot `
            -UpdateId ([string]$manualReservation.marker.updateId) | Out-Null
        }
      }
    }
    New-Item -ItemType Directory -Path $stableRoot -Force | Out-Null
    Invoke-NgtInstallStage "release-deployment" {
      Get-ChildItem -LiteralPath $sourceRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $stableRoot -Recurse -Force
      }
      & (Join-Path $stableRoot "scripts\verify-windows-studio-release.ps1") `
        -ReleaseRoot $stableRoot -ExpectedVersion ([string]$release.version) | Out-Null
    }
    & (Join-Path $stableRoot "scripts\install-windows-studio.ps1") `
      -DataRoot $DataRoot -InstallRoot $InstallRoot -UpdateId $UpdateId -InPlace -OnlineUpdate:$OnlineUpdate
    return
  }
}

. (Join-Path $PSScriptRoot "windows-studio-common.ps1")
Set-Location -LiteralPath $script:NgtProjectRoot
$projectRoot = [System.IO.Path]::GetFullPath($script:NgtProjectRoot)
$stableDataRoot = [System.IO.Path]::GetFullPath($DataRoot)
if ($stableDataRoot.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Studio data must be stored outside the application release directory."
}

New-Item -ItemType Directory -Path $script:NgtStateDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $stableDataRoot -Force | Out-Null
$stableServiceDirectory = Join-Path $stableInstallRoot "service"
$stableAssetDirectory = Join-Path $stableInstallRoot "assets"
$stableStateDirectory = Join-Path $stableInstallRoot ".local"
New-Item -ItemType Directory -Path $stableServiceDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $stableAssetDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $stableStateDirectory -Force | Out-Null
$previousActiveRelease = $PreviousReleaseRoot
$existingStableConfig = Join-Path $stableStateDirectory "studio.json"
if (Test-Path -LiteralPath $existingStableConfig) {
  if (-not $previousActiveRelease) {
    $previousActiveRelease = [string](Get-Content -LiteralPath $existingStableConfig -Raw | ConvertFrom-Json).activeRelease
  }
  if ($manualInstall) {
    Copy-Item -LiteralPath $existingStableConfig `
      -Destination (Join-Path $script:NgtStateDirectory "studio.json") -Force
  }
}

if (Test-Path -LiteralPath $existingStableConfig) {
  Invoke-NgtInstallStage "database-backup" {
    $installMarker = if ($manualInstall -or $onlineInstall) {
      Get-NgtInstallJson (Join-Path $stableInstallRoot ".local\update-maintenance.json")
    } else { $null }
    if ($installMarker -and $installMarker.backupVerified -and $installMarker.backupRoot) {
      & (Join-Path $PSScriptRoot "test-windows-studio-backup.ps1") `
        -BackupRoot ([string]$installMarker.backupRoot) | Out-Null
    } else {
      $backupOutput = @(& (Join-Path $PSScriptRoot "backup-windows-studio.ps1") -LeaveStopped)
      $backupLine = @($backupOutput | Where-Object { [string]$_ -like "Studio backup created: *" } | Select-Object -Last 1)
      if (-not $backupLine) { throw "Studio backup did not return its destination." }
      $backupRoot = [string]$backupLine[0].Substring("Studio backup created: ".Length)
      & (Join-Path $PSScriptRoot "test-windows-studio-backup.ps1") -BackupRoot $backupRoot | Out-Null
      if ($manualInstall) {
        Set-NgtStudioManualInstallBackup -InstallRoot $stableInstallRoot `
          -UpdateId ([string]$installMarker.updateId) -BackupRoot $backupRoot
      } elseif ($onlineInstall) {
        & (Join-Path $stableInstallRoot "scripts\test-windows-studio-backup.ps1") `
          -BackupRoot $backupRoot | Out-Null
        Set-NgtStudioOnlineUpdateBackup -InstallRoot $stableInstallRoot `
          -UpdateId $UpdateId -BackupRoot $backupRoot
      }
    }
  }
}

Copy-Item -LiteralPath (Join-Path $script:NgtProjectRoot "scripts\windows-service.ps1") `
  -Destination $stableServiceDirectory -Force
Copy-Item -LiteralPath (Join-Path $script:NgtProjectRoot "scripts\windows-studio-common.ps1") `
  -Destination $stableServiceDirectory -Force
Copy-Item -LiteralPath (Join-Path $script:NgtProjectRoot "scripts\windows-studio-launcher.vbs") `
  -Destination $stableServiceDirectory -Force
Copy-Item -LiteralPath (Join-Path $script:NgtProjectRoot "scripts\uninstall-windows-studio.ps1") `
  -Destination $stableServiceDirectory -Force
Copy-Item -LiteralPath (Join-Path $script:NgtProjectRoot "scripts\uninstall-windows-startup.ps1") `
  -Destination $stableServiceDirectory -Force
$previousActiveRelease = if ($PreviousReleaseRoot) { $PreviousReleaseRoot } else { $previousActiveRelease }
$studioConfig = [pscustomobject]@{
  dataRoot = $stableDataRoot
  installRoot = $stableInstallRoot
  activeRelease = $projectRoot
  repository = "JayWangsj/ngt1"
}
Set-NgtStudioConfig `
  -Path (Join-Path $script:NgtStateDirectory "studio.json") `
  -Configuration $studioConfig
Set-NgtStudioConfig `
  -Path (Join-Path $stableStateDirectory "studio.json") `
  -Configuration $studioConfig
$env:NGT_DATA_ROOT = $stableDataRoot

$isRelease = Test-Path -LiteralPath (Join-Path $script:NgtProjectRoot "studio-release.json")
if ($isRelease) {
  & (Join-Path $PSScriptRoot "verify-windows-studio-release.ps1") `
    -ReleaseRoot $script:NgtProjectRoot `
    -ExpectedVersion ([string](Get-Content -LiteralPath (Join-Path $script:NgtProjectRoot "studio-release.json") -Raw | ConvertFrom-Json).version) | Out-Null
  Install-NgtSharedRuntime -ProjectRoot $script:NgtProjectRoot -InstallRoot $stableInstallRoot
  $nodeExecutable = Get-NgtNodeExecutable
  $prismaCli = Join-Path $script:NgtProjectRoot "node_modules\prisma\build\index.js"
  if (-not (Test-Path -LiteralPath $prismaCli)) {
    throw "Studio release is missing the Prisma migration runtime."
  }
} else {
  Assert-NgtCommand "git"
  Assert-NgtCommand "node"
  Assert-NgtCommand "pnpm"
  $env:NODE_OPTIONS = "--max-old-space-size=1536"
  Invoke-NgtCommand "pnpm" @("install", "--frozen-lockfile")
}

Invoke-NgtInstallStage "database" {
  Stop-NgtStudioProcesses
  Start-NgtStudioDatabase
}
Invoke-NgtInstallStage "migrations" {
  if ($isRelease) {
    Invoke-NgtCommand $nodeExecutable @($prismaCli, "migrate", "deploy")
  } else {
    Invoke-NgtCommand "pnpm" @("db:generate")
    Invoke-NgtCommand "pnpm" @("db:migrate")
    Invoke-NgtCommand "pnpm" @("build")
  }
  Stop-NgtStudioProcesses
}
Invoke-NgtInstallStage "application-start" {
  & (Join-Path $PSScriptRoot "install-windows-startup.ps1") -InstallRoot $stableInstallRoot
}
Invoke-NgtInstallStage "health-validation" {
  $expectedVersion = if ($isRelease) { [string]$release.version } else { "" }
  Wait-NgtStudioHealth -ExpectedVersion $expectedVersion
}
if ($manualInstall) {
  Invoke-NgtInstallStage "install-state-validation" {
    Complete-NgtStudioManualInstall -InstallRoot $stableInstallRoot `
      -ReleaseRoot $projectRoot -VerifiedVersion ([string]$release.version) `
      -HealthVerified
  }
} elseif ($onlineInstall) {
  Invoke-NgtInstallStage "install-state-validation" {
    Complete-NgtStudioManualInstall -InstallRoot $stableInstallRoot `
      -ReleaseRoot $projectRoot -VerifiedVersion ([string]$release.version) `
      -OnlineUpdate -HealthVerified
  }
}
try {
  Copy-Item -LiteralPath (Join-Path $script:NgtProjectRoot "assets\ngt-studio.ico") `
    -Destination $stableAssetDirectory -Force
} catch {
  $assetWarning = "The studio is healthy, but the shortcut icon could not be refreshed: " + $_.Exception.Message
  Write-Warning $assetWarning
  Add-Content -LiteralPath (Join-Path $env:LOCALAPPDATA "NGT\install-stages.log") `
    -Value ("{0:o} WARNING icon-refresh reason={1}" -f (Get-Date).ToUniversalTime(), $assetWarning)
}
try {
  & (Join-Path $PSScriptRoot "retain-windows-studio-releases.ps1") `
    -InstallRoot $stableInstallRoot `
    -CurrentReleaseRoot $projectRoot `
    -TargetReleaseRoot $projectRoot `
    -PreviousReleaseRoot $previousActiveRelease
  Remove-NgtUnusedRuntimes -InstallRoot $stableInstallRoot
} catch {
  $cleanupWarning = "The studio is healthy, but old release cleanup needs retry: " + $_.Exception.Message
  Write-Warning $cleanupWarning
  Add-Content -LiteralPath (Join-Path $env:LOCALAPPDATA "NGT\install-stages.log") `
    -Value ("{0:o} WARNING post-install-cleanup reason={1}" -f (Get-Date).ToUniversalTime(), $cleanupWarning)
}
Write-Output "NGT studio installation is ready at http://127.0.0.1:3000"
