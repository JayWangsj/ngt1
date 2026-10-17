param(
  [string]$UpdateId,
  [string]$ExpectedTargetVersion,
  [string]$StatusFile,
  [string]$UpdateLockFile,
  [string]$LogFile
)

$ErrorActionPreference = "Stop"
$script:NgtUpdateCreatedAt = (Get-Date).ToUniversalTime().ToString("o")
$script:NgtCompletedUpdateStages = @()
$script:NgtSkippedUpdateStages = @()
$script:NgtCurrentTargetVersion = $ExpectedTargetVersion
$script:NgtUpdateExecutorConfirmed = $false
$script:NgtUpdateCommitted = $false
$script:NgtUpdateMaintenanceFile = $null
$script:NgtUpdateScriptPath = [System.IO.Path]::GetFullPath($PSCommandPath)

function Protect-NgtUpdateText([string]$Value) {
  return $Value `
    -replace "github_pat_[A-Za-z0-9_]+", "[redacted token]" `
    -replace "gh[pousr]_[A-Za-z0-9]{20,}", "[redacted token]" `
    -replace "(?i)(token\s*[:=]\s*)\S+", '$1[redacted]'
}

function Invoke-NgtUpdateOwnership([scriptblock]$Action) {
  $mutexRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $UpdateLockFile)).TrimEnd("\").ToLowerInvariant()
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $rootBytes = [System.Text.Encoding]::UTF8.GetBytes($mutexRoot)
    $rootHash = [System.BitConverter]::ToString($sha256.ComputeHash($rootBytes)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  $mutex = [System.Threading.Mutex]::new($false, "Global\NGTStudioUpdate-$rootHash")
  $owned = $false
  try {
    try { $owned = $mutex.WaitOne(10000) }
    catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { throw "Timed out waiting for the update lock." }
    if (-not (Test-Path -LiteralPath $UpdateLockFile)) { return $false }
    try {
      $lock = Get-Content -LiteralPath $UpdateLockFile -Raw | ConvertFrom-Json
    } catch {
      return $false
    }
    if ([string]$lock.updateId -ne $UpdateId) { return $false }
    & $Action
    return $true
  } finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Write-NgtUpdateMaintenance(
  [string]$Stage,
  [hashtable]$Details = @{}
) {
  if (-not $script:NgtUpdateMaintenanceFile) { return }
  $payload = @{
    updateId = $UpdateId
    stage = $Stage
    targetVersion = $script:NgtCurrentTargetVersion
    previousVersion = $previousVersion
    backupRoot = $backupRoot
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  foreach ($key in $Details.Keys) { $payload[$key] = $Details[$key] }
  $owned = Invoke-NgtUpdateOwnership {
    $temporaryFile = "$script:NgtUpdateMaintenanceFile.$UpdateId.tmp"
    $backupFile = "$script:NgtUpdateMaintenanceFile.$UpdateId.$([guid]::NewGuid().ToString('N')).bak"
    $json = $payload | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($temporaryFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    try {
      if (Test-Path -LiteralPath $script:NgtUpdateMaintenanceFile) {
        [System.IO.File]::Replace($temporaryFile, $script:NgtUpdateMaintenanceFile, $backupFile)
      } else {
        [System.IO.File]::Move($temporaryFile, $script:NgtUpdateMaintenanceFile)
      }
    } finally {
      Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $owned) { throw "Update task no longer owns the lock." }
}

function Clear-NgtUpdateMaintenance {
  if (-not $script:NgtUpdateMaintenanceFile) { return $false }
  if (-not (Test-Path -LiteralPath $script:NgtUpdateMaintenanceFile)) { return $true }
  $owned = Invoke-NgtUpdateOwnership {
    Remove-Item -LiteralPath $script:NgtUpdateMaintenanceFile -Force -ErrorAction Stop
  }
  return ([bool]$owned -and -not (Test-Path -LiteralPath $script:NgtUpdateMaintenanceFile))
}

function Restore-NgtStudioServiceFiles([string]$BackupRoot, [string]$InstallRoot) {
  $serviceBackup = Join-Path $BackupRoot "service"
  $serviceDirectory = Join-Path $InstallRoot "service"
  foreach ($fileName in @(
    "windows-service.ps1",
    "windows-studio-common.ps1",
    "windows-studio-launcher.vbs",
    "uninstall-windows-studio.ps1",
    "uninstall-windows-startup.ps1"
  )) {
    $source = Join-Path $serviceBackup $fileName
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "The verified backup is missing a stable service file: $fileName"
    }
    $destination = Join-Path $serviceDirectory $fileName
    $temporaryPath = "$destination.$UpdateId.tmp"
    $backupPath = "$destination.$UpdateId.$([guid]::NewGuid().ToString('N')).bak"
    Copy-Item -LiteralPath $source -Destination $temporaryPath -Force
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
      throw "The restored service file failed verification: $fileName"
    }
    try {
      if (Test-Path -LiteralPath $destination) {
        [System.IO.File]::Replace($temporaryPath, $destination, $backupPath)
      } else {
        [System.IO.File]::Move($temporaryPath, $destination)
      }
    } finally {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) {
      throw "The restored service file could not be verified: $fileName"
    }
  }
}

function Write-NgtUpdateStatus(
  [string]$Status,
  [string]$Message = "",
  [hashtable]$Details = @{}
) {
  $payload = @{
    status = $Status
    message = Protect-NgtUpdateText $Message
    updateId = $UpdateId
    targetVersion = $script:NgtCurrentTargetVersion
    executorPid = $PID
    executorScriptPath = $script:NgtUpdateScriptPath
    executorConfirmed = $script:NgtUpdateExecutorConfirmed
    createdAt = $script:NgtUpdateCreatedAt
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    completedStages = @($script:NgtCompletedUpdateStages)
    skippedStages = @($script:NgtSkippedUpdateStages)
  }
  foreach ($key in $Details.Keys) {
    $value = $Details[$key]
    if ($value -is [string]) { $value = Protect-NgtUpdateText $value }
    $payload[$key] = $value
  }
  $owned = Invoke-NgtUpdateOwnership {
    $temporaryStatusFile = "$StatusFile.$UpdateId.tmp"
    $statusBackupFile = "$StatusFile.$UpdateId.$([guid]::NewGuid().ToString('N')).bak"
    $json = $payload | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText(
      $temporaryStatusFile,
      $json,
      (New-Object System.Text.UTF8Encoding($false))
    )
    try {
      if (Test-Path -LiteralPath $StatusFile) {
        [System.IO.File]::Replace($temporaryStatusFile, $StatusFile, $statusBackupFile)
      } else {
        [System.IO.File]::Move($temporaryStatusFile, $StatusFile)
      }
    } catch {
      Move-Item -LiteralPath $temporaryStatusFile -Destination $StatusFile -Force
    } finally {
      Remove-Item -LiteralPath $temporaryStatusFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $statusBackupFile -Force -ErrorAction SilentlyContinue
    }
    if ($script:NgtUpdateMaintenanceFile -and $Status -in @("backing-up", "installing", "validating", "rolling-back")) {
      $maintenance = @{
        updateId = $UpdateId
        stage = $Status
        stopAttempted = $true
        targetVersion = $script:NgtCurrentTargetVersion
        previousVersion = $previousVersion
        backupRoot = $backupRoot
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
      } | ConvertTo-Json -Depth 8
      $maintenanceFile = "$script:NgtUpdateMaintenanceFile.$UpdateId.tmp"
      $maintenanceBackupFile = "$script:NgtUpdateMaintenanceFile.$UpdateId.$([guid]::NewGuid().ToString('N')).bak"
      [System.IO.File]::WriteAllText($maintenanceFile, $maintenance, (New-Object System.Text.UTF8Encoding($false)))
      try {
        if (Test-Path -LiteralPath $script:NgtUpdateMaintenanceFile) {
          [System.IO.File]::Replace($maintenanceFile, $script:NgtUpdateMaintenanceFile, $maintenanceBackupFile)
        } else {
          [System.IO.File]::Move($maintenanceFile, $script:NgtUpdateMaintenanceFile)
        }
      } finally {
        Remove-Item -LiteralPath $maintenanceFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $maintenanceBackupFile -Force -ErrorAction SilentlyContinue
      }
    }
  }
  if (-not $owned) { throw "Update task no longer owns the lock." }
}

function Complete-NgtUpdateStage([string]$Stage) {
  if ($script:NgtCompletedUpdateStages -notcontains $Stage) {
    $script:NgtCompletedUpdateStages += $Stage
  }
}

function Get-NgtFileBytes([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory)) { return [long]0 }
  $measure = Get-ChildItem -LiteralPath $Directory -File -Recurse -Force -ErrorAction Stop |
    Measure-Object -Property Length -Sum
  return [long]($measure.Sum -as [long])
}

function Assert-NgtWritableDirectory([string]$Directory) {
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $probe = Join-Path $Directory (".ngt-update-write-test-" + [guid]::NewGuid().ToString("N"))
  try {
    [System.IO.File]::WriteAllText($probe, "test")
  } catch {
    throw "Update path is not writable: $Directory"
  } finally {
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
  }
}

function Assert-NgtUpdateSpace(
  [string]$InstallRoot,
  [string]$DataRoot,
  [long]$ApplicationArchiveBytes,
  [long]$RuntimeArchiveBytes,
  [string]$CurrentReleaseRoot
) {
  Assert-NgtWritableDirectory (Join-Path $InstallRoot "downloads")
  Assert-NgtWritableDirectory (Join-Path $DataRoot "backups")
  $installDrive = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($InstallRoot))
  $dataDrive = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($DataRoot))
  $currentReleaseBytes = Get-NgtFileBytes $CurrentReleaseRoot
  $dataBytes = Get-NgtFileBytes (Join-Path $DataRoot "data")
  $installRequired = [long]([Math]::Max($currentReleaseBytes, $ApplicationArchiveBytes * 4) + $ApplicationArchiveBytes + ($RuntimeArchiveBytes * 2) + 536870912)
  $dataRequired = [long]($dataBytes * 2 + 268435456)
  $sameDrive = $installDrive.Name.Equals($dataDrive.Name, [System.StringComparison]::OrdinalIgnoreCase)
  $requiredOnInstall = if ($sameDrive) { $installRequired + $dataRequired } else { $installRequired }
  if ($installDrive.AvailableFreeSpace -lt $requiredOnInstall) {
    throw "Not enough free space on $($installDrive.Name). The update needs about $([Math]::Ceiling($requiredOnInstall / 1GB)) GB, with $([Math]::Round($installDrive.AvailableFreeSpace / 1GB, 2)) GB available."
  }
  if (-not $sameDrive -and $dataDrive.AvailableFreeSpace -lt $dataRequired) {
    throw "Not enough free space on $($dataDrive.Name) for a verified database backup and rollback copy."
  }
}

function ConvertTo-NgtProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

$studioStopAttempted = $false
$backupRoot = $null
$backupVerified = $false
$recoveryStatus = "not-started"
$recoveryMessage = ""
$previousVersion = ""
$failedStage = "initializing"
$transcriptStarted = $false
$currentStage = "initializing"
$totalBytes = [long]0
$downloadedBytes = [long]0
$bytesPerSecond = [long]0
$etaSeconds = 0
try {
  try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $LogFile) -Force | Out-Null
    Start-Transcript -Path $LogFile -Force | Out-Null
    $transcriptStarted = $true
  } catch {
    Write-Output "Update transcript is unavailable: $($_.Exception.Message)"
  }
  . (Join-Path $PSScriptRoot "windows-studio-common.ps1")
  . (Join-Path $PSScriptRoot "studio-runtime.ps1")
  Set-Location -LiteralPath $script:NgtProjectRoot
  $config = Set-NgtStudioEnvironment
  $releaseFile = Join-Path $script:NgtProjectRoot "studio-release.json"
  if (-not (Test-Path -LiteralPath $releaseFile)) {
    throw "One-click studio updates require an installed Windows studio release."
  }
  $currentRelease = Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json
  $previousVersion = [string]$currentRelease.version
  $script:NgtCurrentTargetVersion = $ExpectedTargetVersion
  $previousReleaseRoot = $script:NgtProjectRoot
  $previousStudioConfig = Get-Content -LiteralPath (Join-Path $script:NgtStateDirectory "studio.json") -Raw | ConvertFrom-Json
  $repository = if ($config.repository -and $config.repository -ne "JayWangsj/ngt-repair-system") {
    [string]$config.repository
  } else { "JayWangsj/ngt1" }
  $isPublicRepository = $repository -eq "JayWangsj/ngt1"
  if ($isPublicRepository) {
    $previousStudioConfig | Add-Member -NotePropertyName repository -NotePropertyValue $repository -Force
  }
  $githubCli = if ($isPublicRepository) { $null } else { Get-NgtGitHubCli }
  $installRoot = [System.IO.Path]::GetFullPath([string]$config.installRoot)
  $script:NgtUpdateMaintenanceFile = Join-Path (Join-Path $installRoot ".local") "update-maintenance.json"
  $currentStage = "reading-release"
  $script:NgtUpdateExecutorConfirmed = $true
  Write-NgtUpdateStatus "running" "" @{ stage = $currentStage; previousVersion = $previousVersion }
  $releaseArguments = @("release", "view")
  if ($ExpectedTargetVersion) {
    $requestedTag = if ($ExpectedTargetVersion -match "^v") {
      $ExpectedTargetVersion
    } else {
      "v$ExpectedTargetVersion"
    }
    $releaseArguments += $requestedTag
  }
  if ($isPublicRepository) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $releaseEndpoint = if ($ExpectedTargetVersion) {
      "https://api.github.com/repos/$repository/releases/tags/$requestedTag"
    } else {
      "https://api.github.com/repos/$repository/releases/latest"
    }
    $release = Invoke-RestMethod -Uri $releaseEndpoint -Headers @{
      Accept = "application/vnd.github+json"
      "X-GitHub-Api-Version" = "2022-11-28"
      "User-Agent" = "NGT-Studio-Updater"
    } -TimeoutSec 30
    $release | Add-Member -NotePropertyName tagName -NotePropertyValue $release.tag_name -Force
  } else {
    $releaseArguments += @("--repo", $repository, "--json", "tagName,assets")
    $releaseOutput = & $githubCli @releaseArguments
    if (($LASTEXITCODE -ne 0) -or (-not $releaseOutput)) {
      throw "Unable to read the latest GitHub release."
    }
    $release = ($releaseOutput | Out-String) | ConvertFrom-Json
  }
  $latestTag = [string]$release.tagName
  $script:NgtCurrentTargetVersion = $latestTag -replace "^v", ""
  if ($ExpectedTargetVersion -and ($script:NgtCurrentTargetVersion -ne ($ExpectedTargetVersion -replace "^v", ""))) {
    throw "The available release changed after confirmation. Check updates and confirm again."
  }
  if ($latestTag -eq ("v" + $currentRelease.version)) {
    Write-NgtUpdateStatus "complete" "" @{ stage = "complete"; latestVersion = $latestTag; actualVersion = [string]$currentRelease.version }
    Write-Output "NGT is already up to date."
    exit 0
  }

  $archiveName = "ngt-studio-windows-$latestTag.zip"
  $checksumName = "$archiveName.sha256"
  $archiveAsset = @($release.assets) |
    Where-Object { $_.name -eq $archiveName } |
    Select-Object -First 1
  $checksumAsset = @($release.assets) |
    Where-Object { $_.name -eq $checksumName } |
    Select-Object -First 1
  $runtimeArchiveName = "ngt-studio-runtime-$latestTag.zip"
  $runtimeChecksumName = "$runtimeArchiveName.sha256"
  $runtimeArchiveAsset = @($release.assets) | Where-Object { $_.name -eq $runtimeArchiveName } | Select-Object -First 1
  $runtimeChecksumAsset = @($release.assets) | Where-Object { $_.name -eq $runtimeChecksumName } | Select-Object -First 1
  if ((-not $archiveAsset) -or (-not $checksumAsset) -or (-not $runtimeArchiveAsset) -or (-not $runtimeChecksumAsset)) {
    throw "GitHub release is missing the studio archive, runtime package, or checksum."
  }
  Complete-NgtUpdateStage "reading-release"

  $downloadRoot = Join-Path $installRoot ("downloads\" + $latestTag)
  $newReleaseRoot = Join-Path $installRoot ("releases\" + $latestTag)
  Assert-NgtUpdateSpace $installRoot ([string]$config.dataRoot) ([long]$archiveAsset.size) ([long]$runtimeArchiveAsset.size) $previousReleaseRoot
  $reuseRelease = $false
  if (Test-Path -LiteralPath $newReleaseRoot) {
    try {
      & (Join-Path $PSScriptRoot "verify-windows-studio-release.ps1") `
        -ReleaseRoot $newReleaseRoot -ExpectedVersion $latestTag | Out-Null
      $reuseRelease = $true
    } catch {
      $quarantineRoot = Join-Path $installRoot "downloads\quarantine"
      New-Item -ItemType Directory -Path $quarantineRoot -Force | Out-Null
      $quarantinePath = Join-Path $quarantineRoot ($latestTag + "-" + [guid]::NewGuid().ToString("N"))
      Move-Item -LiteralPath $newReleaseRoot -Destination $quarantinePath
      Write-Warning "An incomplete target release was isolated and will be downloaded again."
    }
  }
  if (-not $reuseRelease) {
    if (Test-Path -LiteralPath $downloadRoot) {
      Remove-Item -LiteralPath $downloadRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
    if ($isPublicRepository) {
      & (Join-Path $PSScriptRoot "download-public-release-asset.ps1") `
        -AssetUrl ([string]$checksumAsset.browser_download_url) `
        -Destination (Join-Path $downloadRoot ([string]$checksumAsset.name))
    } else {
      Invoke-NgtCommand $githubCli @(
        "release", "download", $latestTag,
        "--repo", $repository,
        "--pattern", ([string]$checksumAsset.name),
        "--dir", $downloadRoot
      )
    }
  }
  New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

  $totalBytes = [long]$archiveAsset.size
  $archivePath = Join-Path $downloadRoot ([string]$archiveAsset.name)
  $downloadErrorPath = Join-Path $downloadRoot "download.error.log"
  if (-not $reuseRelease) {
  $currentStage = "downloading"
  Write-NgtUpdateStatus "downloading" "" @{
    stage = $currentStage
    latestVersion = $latestTag
    bytesDownloaded = 0
    totalBytes = $totalBytes
    bytesPerSecond = 0
    progressKnown = $false
  }
  if ($isPublicRepository) {
    $downloadArguments = @(
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $PSScriptRoot "download-public-release-asset.ps1"),
      "-AssetUrl", ([string]$archiveAsset.browser_download_url),
      "-Destination", $archivePath
    ) | ForEach-Object { ConvertTo-NgtProcessArgument ([string]$_) }
    $downloadExecutable = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
  } else {
    $downloadArguments = @(
      "release", "download", $latestTag,
      "--repo", $repository,
      "--pattern", ([string]$archiveAsset.name),
      "--dir", $downloadRoot
    ) | ForEach-Object { ConvertTo-NgtProcessArgument ([string]$_) }
    $downloadExecutable = $githubCli
  }
  $downloadStart = Get-Date
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $downloadExecutable
  $processInfo.Arguments = $downloadArguments -join " "
  $processInfo.WorkingDirectory = $script:NgtProjectRoot
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $downloadProcess = New-Object System.Diagnostics.Process
  $downloadProcess.StartInfo = $processInfo
  if (-not $downloadProcess.Start()) {
    throw "Unable to start the GitHub release download."
  }
  $downloadOutput = $downloadProcess.StandardOutput.ReadToEndAsync()
  $downloadError = $downloadProcess.StandardError.ReadToEndAsync()
  while (-not $downloadProcess.WaitForExit(1000)) {
    $downloadProcess.Refresh()
    $downloadedBytes = [long](@(
      Get-ChildItem -LiteralPath $downloadRoot -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne $checksumAsset.name -and $_.Name -ne "download.error.log" } |
        Measure-Object -Property Length -Sum
    )[0].Sum)
    $elapsedSeconds = [Math]::Max(0.001, ((Get-Date) - $downloadStart).TotalSeconds)
    $bytesPerSecond = [long]($downloadedBytes / $elapsedSeconds)
    $etaSeconds = if (($totalBytes -gt $downloadedBytes) -and ($bytesPerSecond -gt 0)) {
      [int][Math]::Ceiling(($totalBytes - $downloadedBytes) / $bytesPerSecond)
    } else { 0 }
    Write-NgtUpdateStatus "downloading" "" @{
      stage = $currentStage
      latestVersion = $latestTag
      bytesDownloaded = $downloadedBytes
      totalBytes = $totalBytes
      bytesPerSecond = $bytesPerSecond
      etaSeconds = $etaSeconds
      progressKnown = (($totalBytes -gt 0) -and ($downloadedBytes -gt 0))
    }
  }
  $downloadProcess.WaitForExit()
  $downloadProcess.Refresh()
  $downloadOutputText = $downloadOutput.Result
  $downloadErrorText = $downloadError.Result
  if ($downloadProcess.ExitCode -ne 0) {
    Set-Content -LiteralPath $downloadErrorPath -Value $downloadErrorText -Encoding utf8
    $failureDetail = ($downloadErrorText | Out-String).Trim()
    if (-not $failureDetail) { $failureDetail = "GitHub CLI exited with code $($downloadProcess.ExitCode)." }
    throw "Release download failed. $failureDetail"
  }
  if ($downloadOutputText) { $downloadOutputText | Write-Output }

  if (-not (Test-Path -LiteralPath $archivePath)) {
    throw "GitHub release archive was not downloaded."
  }
  $downloadedBytes = (Get-Item -LiteralPath $archivePath).Length
  Complete-NgtUpdateStage "downloading"
  } else {
    $script:NgtSkippedUpdateStages += @("downloading", "verifying")
  }
  if (-not $reuseRelease) {
    Write-NgtUpdateStatus "downloaded" "" @{
      stage = "downloaded"
      latestVersion = $latestTag
      bytesDownloaded = $downloadedBytes
      totalBytes = $totalBytes
      bytesPerSecond = 0
      etaSeconds = 0
      progressKnown = ($totalBytes -gt 0)
    }

    $currentStage = "verifying"
    Write-NgtUpdateStatus "verifying" "" @{
      stage = $currentStage
      latestVersion = $latestTag
      bytesDownloaded = $downloadedBytes
      totalBytes = $totalBytes
      progressKnown = ($totalBytes -gt 0)
    }
  }
  if (-not $reuseRelease) {
    $archive = Get-ChildItem -LiteralPath $downloadRoot -Filter "*.zip" -File | Select-Object -First 1
    $checksumFile = Get-ChildItem -LiteralPath $downloadRoot -Filter "*.sha256" -File | Select-Object -First 1
    if ((-not $archive) -or (-not $checksumFile)) {
      throw "GitHub release is missing the studio archive or checksum."
    }
    $expectedHash = ((Get-Content -LiteralPath $checksumFile.FullName -Raw).Trim() -split "\s+")[0]
    $actualHash = (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) {
      throw "Studio release checksum does not match."
    }
    $stagingRoot = Join-Path $installRoot ("downloads\" + $latestTag + "-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    try {
      & tar.exe -xf $archive.FullName -C $stagingRoot
      if ($LASTEXITCODE -ne 0) { throw "Studio release extraction failed." }
      $stagedMetadata = Join-Path $stagingRoot "studio-release.json"
      if (-not (Test-Path -LiteralPath $stagedMetadata)) {
        throw "Downloaded studio release is invalid."
      }
      $stagedRelease = Get-Content -LiteralPath $stagedMetadata -Raw | ConvertFrom-Json
      if (("v" + $stagedRelease.version) -ne $latestTag) {
        throw "Downloaded studio release version does not match its GitHub tag."
      }
      & (Join-Path $PSScriptRoot "verify-windows-studio-release.ps1") `
        -ReleaseRoot $stagingRoot -ExpectedVersion $latestTag | Out-Null
      Complete-NgtUpdateStage "verifying"
      Move-Item -LiteralPath $stagingRoot -Destination $newReleaseRoot
    } finally {
      if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
      }
    }
  } else {
    $script:NgtSkippedUpdateStages += "preparing-runtime"
  }
  $newMetadataPath = Join-Path $newReleaseRoot "studio-release.json"
  if (-not (Test-Path -LiteralPath $newMetadataPath)) {
    throw "Downloaded studio release is invalid."
  }
  $newRelease = Get-Content -LiteralPath $newMetadataPath -Raw | ConvertFrom-Json
  if (("v" + $newRelease.version) -ne $latestTag) {
    throw "Downloaded studio release version does not match its GitHub tag."
  }
  & (Join-Path $PSScriptRoot "verify-windows-studio-release.ps1") `
    -ReleaseRoot $newReleaseRoot -ExpectedVersion $latestTag | Out-Null

  $currentStage = "preparing-runtime"
  Write-NgtUpdateStatus "preparing-runtime" "" @{
    stage = $currentStage
    latestVersion = $latestTag
    bytesDownloaded = $downloadedBytes
    totalBytes = $totalBytes
    progressKnown = ($totalBytes -gt 0)
  }
  $sharedRuntime = Join-Path (Join-Path $installRoot "runtimes") ([string]$newRelease.runtimeHash)
  if (Test-Path -LiteralPath $sharedRuntime) {
    try {
      if ((Get-NgtRuntimeHash $sharedRuntime) -ne [string]$newRelease.runtimeHash) {
        throw "Cached runtime checksum does not match."
      }
    } catch {
      $runtimeQuarantine = Join-Path $installRoot "runtimes\quarantine"
      New-Item -ItemType Directory -Path $runtimeQuarantine -Force | Out-Null
      Move-Item -LiteralPath $sharedRuntime -Destination (Join-Path $runtimeQuarantine ([string]$newRelease.runtimeHash + "-" + [guid]::NewGuid().ToString("N")))
    }
  }
  if (-not (Test-Path -LiteralPath $sharedRuntime)) {
    if ($isPublicRepository) {
      & (Join-Path $PSScriptRoot "download-public-release-asset.ps1") `
        -AssetUrl ([string]$runtimeChecksumAsset.browser_download_url) `
        -Destination (Join-Path $downloadRoot $runtimeChecksumName)
      & (Join-Path $PSScriptRoot "download-public-release-asset.ps1") `
        -AssetUrl ([string]$runtimeArchiveAsset.browser_download_url) `
        -Destination (Join-Path $downloadRoot $runtimeArchiveName)
    } else {
      Invoke-NgtCommand $githubCli @(
        "release", "download", $latestTag, "--repo", $repository,
        "--pattern", $runtimeChecksumName, "--pattern", $runtimeArchiveName,
        "--dir", $downloadRoot
      )
    }
    $runtimeArchivePath = Join-Path $downloadRoot $runtimeArchiveName
    $runtimeChecksumPath = Join-Path $downloadRoot $runtimeChecksumName
    $expectedRuntimeHash = ((Get-Content -LiteralPath $runtimeChecksumPath -Raw).Trim() -split "\s+")[0]
    $actualRuntimeHash = (Get-FileHash -LiteralPath $runtimeArchivePath -Algorithm SHA256).Hash
    if ($actualRuntimeHash -ne $expectedRuntimeHash) {
      throw "Studio runtime package checksum does not match."
    }
    Install-NgtRuntimeArchive -ArchivePath $runtimeArchivePath `
      -ExpectedHash ([string]$newRelease.runtimeHash) -InstallRoot $installRoot
  }
  Complete-NgtUpdateStage "preparing-runtime"

  if ($reuseRelease) { $script:NgtSkippedUpdateStages += "preparing-application" }
  $currentStage = "backing-up"
  Assert-NgtUpdateSpace $installRoot ([string]$config.dataRoot) 0 0 $previousReleaseRoot
  New-Item -ItemType Directory -Path (Split-Path -Parent $script:NgtUpdateMaintenanceFile) -Force | Out-Null
  $studioStopAttempted = $true
  Write-NgtUpdateMaintenance $currentStage @{
    previousVersion = $previousVersion
    targetVersion = $script:NgtCurrentTargetVersion
    stopAttempted = $true
  }
  Write-NgtUpdateStatus "backing-up" "" @{
    stage = $currentStage
    stopAttempted = $true
    latestVersion = $latestTag
    bytesDownloaded = $downloadedBytes
    totalBytes = $totalBytes
    progressKnown = ($totalBytes -gt 0)
  }
  Stop-NgtStudioProcesses
  $backupOutput = & (Join-Path $PSScriptRoot "backup-windows-studio.ps1") -LeaveStopped
  $backupLine = @($backupOutput | Where-Object { $_ -like "Studio backup created: *" } | Select-Object -Last 1)
  if (-not $backupLine) { throw "Studio backup did not return its destination." }
  $backupRoot = [string]$backupLine[0].Substring("Studio backup created: ".Length)
  & (Join-Path $PSScriptRoot "test-windows-studio-backup.ps1") -BackupRoot $backupRoot | Out-Null
  $backupVerified = $true
  $backupOutput | Write-Output
  Complete-NgtUpdateStage "backing-up"
  $currentStage = "installing"
  Write-NgtUpdateStatus "installing" "" @{
    stage = $currentStage
    latestVersion = $latestTag
    bytesDownloaded = $downloadedBytes
    totalBytes = $totalBytes
    progressKnown = ($totalBytes -gt 0)
  }
  $nextStudioConfig = $previousStudioConfig | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $nextStudioConfig | Add-Member -NotePropertyName activeRelease -NotePropertyValue $newReleaseRoot -Force
  $newReleaseState = Join-Path $newReleaseRoot ".local"
  New-Item -ItemType Directory -Path $newReleaseState -Force | Out-Null
  Set-NgtStudioConfig `
    -Path (Join-Path $newReleaseState "studio.json") `
    -Configuration $nextStudioConfig
  Set-NgtStudioConfig `
    -Path (Join-Path $installRoot ".local\studio.json") `
    -Configuration $nextStudioConfig
  & (Join-Path $newReleaseRoot "scripts\install-windows-studio.ps1") `
    -DataRoot ([string]$config.dataRoot) `
    -InstallRoot $installRoot `
    -PreviousReleaseRoot $previousReleaseRoot `
    -InPlace -OnlineUpdate
  if ($LASTEXITCODE -ne 0) {
    throw "New studio release installer failed."
  }
  Complete-NgtUpdateStage "installing"
  $currentStage = "validating"
  Write-NgtUpdateStatus "validating" "" @{
    stage = $currentStage
    latestVersion = $latestTag
    bytesDownloaded = $downloadedBytes
    totalBytes = $totalBytes
    progressKnown = ($totalBytes -gt 0)
  }
  Wait-NgtStudioHealth -ExpectedVersion ([string]$newRelease.version)
  Complete-NgtUpdateStage "validating"
  if (-not (Clear-NgtUpdateMaintenance)) {
    throw "The new release passed health checks, but the maintenance marker could not be verified as cleared."
  }
  Write-NgtUpdateStatus "complete" "" @{
    stage = "complete"
    latestVersion = $latestTag
    actualVersion = [string]$newRelease.version
    bytesDownloaded = $downloadedBytes
    totalBytes = $totalBytes
    progressKnown = ($totalBytes -gt 0)
  }
  $script:NgtUpdateCommitted = $true
  try {
    Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction Stop
    & (Join-Path $PSScriptRoot "retain-windows-studio-releases.ps1") `
      -InstallRoot $installRoot `
      -CurrentReleaseRoot $newReleaseRoot `
      -PreviousReleaseRoot $previousReleaseRoot
    Remove-NgtUnusedRuntimes -InstallRoot $installRoot
  } catch {
    $cleanupWarning = Protect-NgtUpdateText $_.Exception.Message
    Write-Warning ("The update succeeded, but post-update cleanup needs retry: " + $cleanupWarning)
    Write-NgtUpdateStatus "complete" $cleanupWarning @{
      stage = "complete"
      latestVersion = $latestTag
      actualVersion = [string]$newRelease.version
      cleanupWarning = $cleanupWarning
    }
  }
  Write-Output "NGT studio updated: v$($currentRelease.version) -> $latestTag"
} catch {
  $failure = $_.Exception.Message
  $failedStage = $currentStage
  if ($script:NgtUpdateCommitted) {
    $cleanupWarning = Protect-NgtUpdateText $failure
    Write-Warning ("The update succeeded, but post-update cleanup needs retry: " + $cleanupWarning)
    try {
      Write-NgtUpdateStatus "complete" $cleanupWarning @{
        stage = "complete"
        latestVersion = $script:NgtCurrentTargetVersion
        actualVersion = $script:NgtCurrentTargetVersion
        cleanupWarning = $cleanupWarning
      }
    } catch { Write-Warning "The completed update status could not be refreshed." }
  } elseif ($studioStopAttempted) {
    $recoveryStatus = "running"
    try {
      $currentStage = "rolling-back"
      Write-NgtUpdateStatus "rolling-back" $failure @{
        stage = $currentStage
        failedStage = $failedStage
        latestVersion = $script:NgtCurrentTargetVersion
        previousVersion = $previousVersion
        recoveryStatus = $recoveryStatus
      }
      Stop-NgtStudioProcesses
      if ($backupVerified) {
        & (Join-Path $PSScriptRoot "test-windows-studio-backup.ps1") -BackupRoot $backupRoot | Out-Null
        $dataDirectory = Join-Path ([string]$config.dataRoot) "data"
        $failedDataDirectory = $dataDirectory + ".failed-" + (Get-Date -Format "yyyyMMdd-HHmmss")
        if (Test-Path -LiteralPath $dataDirectory) {
          Move-Item -LiteralPath $dataDirectory -Destination $failedDataDirectory
        }
        New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
        Get-ChildItem -LiteralPath (Join-Path $backupRoot "postgres-data") -Force | ForEach-Object {
          Copy-Item -LiteralPath $_.FullName -Destination $dataDirectory -Recurse -Force
        }
        $backupSecrets = Join-Path $backupRoot "config\local-secrets.json"
        if (Test-Path -LiteralPath $backupSecrets) {
          Copy-Item -LiteralPath $backupSecrets -Destination ([string]$config.dataRoot) -Force
        }
        $backupEnvironment = Join-Path $backupRoot "config\.env"
        if (Test-Path -LiteralPath $backupEnvironment) {
          Copy-Item -LiteralPath $backupEnvironment -Destination $previousReleaseRoot -Force
        }
        Restore-NgtStudioServiceFiles -BackupRoot $backupRoot -InstallRoot $installRoot
      }
      $previousStudioConfig | Add-Member -NotePropertyName activeRelease `
        -NotePropertyValue $previousReleaseRoot -Force
      $stableConfigPath = Join-Path $installRoot ".local\studio.json"
      Set-NgtStudioConfig -Path $stableConfigPath -Configuration $previousStudioConfig
      Set-NgtStudioConfig `
        -Path (Join-Path $previousReleaseRoot ".local\studio.json") `
        -Configuration $previousStudioConfig
      & (Join-Path $previousReleaseRoot "scripts\install-windows-startup.ps1") -InstallRoot $installRoot
      Wait-NgtStudioHealth -ExpectedVersion $previousVersion
      if (-not (Clear-NgtUpdateMaintenance)) {
        throw "The previous release started, but the maintenance marker could not be verified as cleared."
      }
      $recoveryStatus = "succeeded"
      $recoveryMessage = "The previous studio version was restored and verified."
    } catch {
      $recoveryStatus = "failed"
      $recoveryMessage = $_.Exception.Message
      $failure += " Previous release restart also failed: $recoveryMessage"
    }
  }
  if (-not $script:NgtUpdateCommitted) {
    Write-NgtUpdateStatus "failed" $failure @{
      stage = $failedStage
      failedStage = $failedStage
      previousVersion = $previousVersion
      actualVersion = if ($recoveryStatus -eq "succeeded") { $previousVersion } else { "" }
      recoveryStatus = $recoveryStatus
      recoveryMessage = $recoveryMessage
      bytesDownloaded = $downloadedBytes
      totalBytes = $totalBytes
      bytesPerSecond = $bytesPerSecond
      etaSeconds = $etaSeconds
      progressKnown = (($totalBytes -gt 0) -and ($downloadedBytes -gt 0))
    }
    throw "Studio update failed. $failure"
  }
} finally {
  if ($transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
  }
  try {
    [void](Invoke-NgtUpdateOwnership {
      Remove-Item -LiteralPath $UpdateLockFile -Force -ErrorAction SilentlyContinue
    })
  } catch { Write-Warning "The update lock could not be safely released." }
}
