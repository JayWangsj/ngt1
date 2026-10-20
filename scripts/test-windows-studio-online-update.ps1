param(
  [Parameter(Mandatory = $true)]
  [string]$TargetTag,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedCommitSha,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedManifestPath,
  [string]$CandidateDirectory = "",
  [switch]$ManualInstaller
)
$ErrorActionPreference = "Stop"

if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted") {
  throw "Online update acceptance is restricted to a disposable GitHub-hosted Windows runner."
}

function Wait-NgtManualInstaller([System.Diagnostics.Process]$Process, [string]$Description) {
  if (-not $Process.WaitForExit(1800000)) {
    & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $Process.Id /T /F | Out-Null
    throw "$Description exceeded 30 minutes."
  }
  $Process.Refresh()
  if ($Process.ExitCode -ne 0) { throw "$Description exited with code $($Process.ExitCode)." }
}

$repository = "JayWangsj/ngt1"
$githubCli = Get-Command gh -ErrorAction Stop | Select-Object -ExpandProperty Source
$authOutput = & $githubCli auth status --hostname github.com 2>&1
if ($LASTEXITCODE -ne 0) { throw "GitHub release read authorization is unavailable." }

$manifest = Get-Content -LiteralPath $ExpectedManifestPath -Raw | ConvertFrom-Json
$targetVersion = $TargetTag -replace "^v", ""
if ($targetVersion -notmatch '^\d+\.\d+\.\d+$' -or
    $manifest.tag -ne $TargetTag -or $manifest.version -ne $targetVersion -or
    $manifest.sha -ne $ExpectedCommitSha.ToLowerInvariant() -or
    $ExpectedCommitSha -ne $env:GITHUB_SHA) {
  throw "Online update acceptance artifact identity does not match the target tag and triggering Commit SHA."
}

$candidate = $null
if (-not $CandidateDirectory) {
  $candidateOutput = & $githubCli release view $TargetTag --repo $repository --json tagName,isDraft,assets,body
  if ($LASTEXITCODE -ne 0) { throw "Candidate release assets are not readable: $TargetTag" }
  $candidate = ($candidateOutput | Out-String) | ConvertFrom-Json
  $expectedMarker = "<!-- ngt-release-build:v1 tag=$TargetTag sha=$ExpectedCommitSha version=$targetVersion identity=$($manifest.buildIdentity) -->"
  if ($candidate.tagName -ne $TargetTag -or -not $candidate.isDraft -or
      -not ([string]$candidate.body).Contains($expectedMarker)) {
    throw "Online update acceptance requires the exact verified candidate to remain a Draft Release."
  }
}

$candidateRequired = @($manifest.assets | ForEach-Object name | Sort-Object)
$expectedNames = @(
  "ngt-studio-windows-$TargetTag.zip",
  "ngt-studio-windows-$TargetTag.zip.sha256",
  "ngt-studio-runtime-$TargetTag.zip",
  "ngt-studio-runtime-$TargetTag.zip.sha256",
  "ngt-studio-windows-setup-$TargetTag.exe",
  "ngt-studio-windows-setup-$TargetTag.exe.sha256"
) | Sort-Object
if (Compare-Object -ReferenceObject $expectedNames -DifferenceObject $candidateRequired) {
  throw "Online update acceptance manifest has an incomplete candidate asset set."
}
$candidateNeedsContentCheck = $false
if ($CandidateDirectory) {
  $candidateAssetNames = @(Get-ChildItem -LiteralPath $CandidateDirectory -File | Where-Object Name -ne "release-manifest.json" | ForEach-Object Name | Sort-Object)
  if (Compare-Object -ReferenceObject $expectedNames -DifferenceObject $candidateAssetNames) {
    throw "Local candidate asset names do not match the verified build."
  }
  foreach ($asset in $manifest.assets) {
    $assetPath = Join-Path $CandidateDirectory $asset.name
    if ((Get-Item -LiteralPath $assetPath).Length -ne [long]$asset.size -or
        (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$asset.sha256) {
      throw "Local candidate asset SHA256 does not match the verified build: $($asset.name)"
    }
  }
} else {
  $candidateAssetNames = @($candidate.assets | ForEach-Object name | Sort-Object)
  if (Compare-Object -ReferenceObject $expectedNames -DifferenceObject $candidateAssetNames) {
    throw "Candidate Draft asset names do not match the verified build."
  }
  foreach ($asset in $manifest.assets) {
    $remoteAsset = @($candidate.assets | Where-Object name -eq $asset.name)
    if ($remoteAsset.Count -ne 1 -or [long]$remoteAsset[0].size -ne [long]$asset.size) {
      throw "Candidate Draft asset size or inventory does not match the verified build: $($asset.name)"
    }
    $digest = [string]$remoteAsset[0].digest
    if ($digest) {
      if ($digest.ToLowerInvariant() -ne "sha256:$($asset.sha256)") {
        throw "Candidate Draft asset SHA256 does not match the verified build: $($asset.name)"
      }
    } else {
      $candidateNeedsContentCheck = $true
    }
  }
}

$baselineOutput = & node scripts/windows-studio-release.mjs find-update-baseline $TargetTag
if ($LASTEXITCODE -ne 0) { throw "Unable to find a supported published release for the update baseline." }
$baseline = ($baselineOutput | Out-String) | ConvertFrom-Json
if (-not $baseline) { throw "No published release with supported online-update assets was found." }

$baselineVersion = [version]($baseline.tagName -replace "^v", "")
if ($baselineVersion -ge [version]$targetVersion) {
  throw "The online update baseline $($baseline.tagName) is not older than $TargetTag."
}

foreach ($port in @(3000, 55432)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Online update acceptance port $port is already in use."
  }
}
if (Get-ScheduledTask -TaskName "NGT Management System" -ErrorAction SilentlyContinue) {
  throw "The disposable runner already has an NGT startup task."
}
$installRoot = Join-Path $env:LOCALAPPDATA "NGT"
if (Test-Path -LiteralPath $installRoot) {
  throw "The disposable runner already has an NGT installation."
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-online-update-" + [guid]::NewGuid().ToString("N"))
$downloadRoot = Join-Path $testRoot "downloads"
$baselineRoot = Join-Path $testRoot "baseline"
$dataRoot = if ($ManualInstaller) { Join-Path $installRoot "data-store" } else { Join-Path $testRoot "data-store" }
$updateLock = Join-Path $installRoot "update.lock"
$updateStatus = Join-Path $installRoot "update-status.json"
$updateLog = Join-Path $installRoot "logs\online-update.log"
$updateProcess = $null
$installationAttempted = $false
$cleanupSafe = $true
$acceptanceFailed = $false

function Invoke-GhDownload([string]$Tag, [string]$Directory, [string[]]$AssetNames) {
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $arguments = @("release", "download", $Tag, "--repo", $repository, "--dir", $Directory)
  foreach ($assetName in $AssetNames) { $arguments += @("--pattern", $assetName) }
  & $githubCli @arguments
  if ($LASTEXITCODE -ne 0) { throw "Release assets could not be downloaded for $Tag." }
}

function Assert-ReleaseChecksum([string]$ArchivePath, [string]$ChecksumPath) {
  $line = (Get-Content -LiteralPath $ChecksumPath -Raw).Trim()
  if ($line -notmatch '^([A-Fa-f0-9]{64})\s+(.+)$' -or
      $Matches[2] -ne (Split-Path -Leaf $ArchivePath)) {
    throw "Release checksum file is invalid: $(Split-Path -Leaf $ChecksumPath)"
  }
  if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ne $Matches[1]) {
    throw "Release checksum validation failed: $(Split-Path -Leaf $ArchivePath)"
  }
}

function Normalize-LegacyBaselineDocumentationPaths([string]$Root) {
  $metadata = Get-Content -LiteralPath (Join-Path $Root "studio-release.json") -Raw | ConvertFrom-Json
  $docsRoot = Join-Path $Root ".next\standalone\docs"
  $docsPrefix = ".next/standalone/docs/"
  foreach ($entry in $metadata.files.PSObject.Properties) {
    $relativePath = [string]$entry.Name
    if (-not $relativePath.StartsWith($docsPrefix, [System.StringComparison]::Ordinal)) { continue }
    $expectedPath = Join-Path $Root ($relativePath.Replace("/", "\"))
    if (Test-Path -LiteralPath $expectedPath -PathType Leaf) { continue }
    $matchingFiles = @(Get-ChildItem -LiteralPath $docsRoot -File -Recurse -Force | Where-Object {
      (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -ieq [string]$entry.Value
    })
    if ($matchingFiles.Count -ne 1) {
      throw "Legacy baseline documentation could not be matched to its manifest SHA256: $relativePath"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $expectedPath) -Force | Out-Null
    Move-Item -LiteralPath $matchingFiles[0].FullName -Destination $expectedPath
    Write-Output ("Normalized legacy baseline documentation path by manifest SHA256: {0}" -f $relativePath)
  }
}

function Invoke-BusinessDataProbe([string]$ReleaseRoot, [string]$Action, [string]$Code, [string]$SnapshotPath) {
  $probePath = Join-Path $PSScriptRoot "windows-studio-business-probe.cjs"
  $node = Join-Path $ReleaseRoot "runtime\node.exe"
  $client = Join-Path $ReleaseRoot ".next\standalone\node_modules\@prisma\client"
  & $node $probePath $Action (Join-Path $ReleaseRoot ".env") $client $Code $SnapshotPath
  if ($LASTEXITCODE -ne 0) { throw "Isolated business database $Action probe failed for $ReleaseRoot." }
}

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  if ($CandidateDirectory) {
    $shimRoot = Join-Path $testRoot "candidate-gh"
    New-Item -ItemType Directory -Path $shimRoot -Force | Out-Null
    $shimScript = Join-Path $PSScriptRoot "windows-studio-ready-gh.cjs"
    $shimCommand = Join-Path $shimRoot "gh.cmd"
    "@echo off`r`nnode `"$shimScript`" %*`r`n" | Set-Content -LiteralPath $shimCommand -Encoding ascii
    $env:NGT_READY_GH_ORIGINAL = $githubCli
    $env:NGT_READY_GH_SHIM = $shimCommand
    $env:NGT_READY_CANDIDATE_DIR = [System.IO.Path]::GetFullPath($CandidateDirectory)
    $env:NGT_READY_CANDIDATE_TAG = $TargetTag
    $env:PATH = "$shimRoot;$env:PATH"
  }
  if ($candidateNeedsContentCheck) {
    $candidateVerifyRoot = Join-Path $testRoot "candidate-assets"
    Invoke-GhDownload -Tag $TargetTag -Directory $candidateVerifyRoot -AssetNames $candidateRequired
    foreach ($asset in $manifest.assets) {
      $candidatePath = Join-Path $candidateVerifyRoot $asset.name
      if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf) -or
          (Get-Item -LiteralPath $candidatePath).Length -ne [long]$asset.size -or
          (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$asset.sha256) {
        throw "Downloaded Draft candidate asset did not match the verified build: $($asset.name)"
      }
    }
  }
  $oldTag = $baseline.tagName
  $appName = "ngt-studio-windows-$oldTag.zip"
  $appChecksumName = "$appName.sha256"
  $runtimeName = "ngt-studio-runtime-$oldTag.zip"
  $runtimeChecksumName = "$runtimeName.sha256"
  $anonymousChecksumPath = Join-Path $testRoot "anonymous-runtime-checksum.sha256"
  $anonymousAssetUrl = "https://github.com/$repository/releases/download/$oldTag/$runtimeChecksumName"
  & (Join-Path $PSScriptRoot "download-public-release-asset.ps1") `
    -AssetUrl $anonymousAssetUrl -Destination $anonymousChecksumPath
  $anonymousChecksum = (Get-Content -LiteralPath $anonymousChecksumPath -Raw).Trim()
  if ($anonymousChecksum -notmatch "^[A-Fa-f0-9]{64}\s+$([regex]::Escape($runtimeName))$") {
    throw "Anonymous public Release asset download did not return the expected checksum file."
  }
  Invoke-GhDownload -Tag $oldTag -Directory $downloadRoot -AssetNames @(
    $appName, $appChecksumName, $runtimeName, $runtimeChecksumName
  )
  $oldAppArchive = Join-Path $downloadRoot $appName
  $oldRuntimeArchive = Join-Path $downloadRoot $runtimeName
  Assert-ReleaseChecksum $oldAppArchive (Join-Path $downloadRoot $appChecksumName)
  Assert-ReleaseChecksum $oldRuntimeArchive (Join-Path $downloadRoot $runtimeChecksumName)

  New-Item -ItemType Directory -Path $baselineRoot -Force | Out-Null
  & tar.exe -xf $oldAppArchive -C $baselineRoot
  if ($LASTEXITCODE -ne 0) { throw "Baseline application archive extraction failed." }
  & tar.exe -xf $oldRuntimeArchive -C $baselineRoot
  if ($LASTEXITCODE -ne 0) { throw "Baseline runtime archive extraction failed." }
  Normalize-LegacyBaselineDocumentationPaths -Root $baselineRoot

  # GitHub's disposable standard user has no interactive Task Scheduler session.
  $baselineStartupScriptPath = Join-Path $baselineRoot "scripts\install-windows-startup.ps1"
  $baselineStartupScript = Get-Content -LiteralPath $baselineStartupScriptPath -Raw
  $scheduledTaskStart = "Start-ScheduledTask -TaskName `$taskName"
  $directLauncherStart = "Start-Process -FilePath `$wscriptPath -ArgumentList `$launcherArguments -WindowStyle Hidden"
  if ($baselineStartupScript.Contains($scheduledTaskStart)) {
    $baselineMetadataPath = Join-Path $baselineRoot "studio-release.json"
    $baselineMetadata = Get-Content -LiteralPath $baselineMetadataPath -Raw | ConvertFrom-Json
    $startupManifestEntry = $baselineMetadata.files.PSObject.Properties["scripts/install-windows-startup.ps1"]
    if (-not $startupManifestEntry) {
      throw "Baseline startup script is missing its integrity manifest entry."
    }
    $originalStartupHash = (Get-FileHash -LiteralPath $baselineStartupScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($originalStartupHash -ne ([string]$startupManifestEntry.Value).ToLowerInvariant()) {
      throw "Baseline startup script failed integrity validation before runner adaptation."
    }
    $baselineStartupScript = $baselineStartupScript.Replace($scheduledTaskStart, $directLauncherStart)
    Set-Content -LiteralPath $baselineStartupScriptPath -Value $baselineStartupScript -Encoding utf8
    $startupManifestEntry.Value = (Get-FileHash -LiteralPath $baselineStartupScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $baselineMetadata | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $baselineMetadataPath -Encoding utf8
    Write-Output "Adapted the legacy baseline launch for the non-interactive hosted acceptance."
  } elseif (-not $baselineStartupScript.Contains($directLauncherStart)) {
    throw "Baseline startup script has no supported immediate launcher command."
  }

  $baselineUpdaterScriptPath = Join-Path $baselineRoot "scripts\update-windows-studio.ps1"
  $baselineUpdaterScript = Get-Content -LiteralPath $baselineUpdaterScriptPath -Raw
  $publicReleaseSelection = '$isPublicRepository = $repository -eq "JayWangsj/ngt1"'
  $latestReleaseView = '$releaseOutput = & $githubCli release view --repo $repository --json "tagName,assets"'
  $confirmedReleaseView = '$releaseOutput = & $githubCli release view $ExpectedTargetVersion --repo $repository --json "tagName,assets"'
  if ($baselineUpdaterScript.Contains($publicReleaseSelection) -or
      $baselineUpdaterScript.Contains($latestReleaseView)) {
    $baselineMetadataPath = Join-Path $baselineRoot "studio-release.json"
    $baselineMetadata = Get-Content -LiteralPath $baselineMetadataPath -Raw | ConvertFrom-Json
    $updaterManifestEntry = $baselineMetadata.files.PSObject.Properties["scripts/update-windows-studio.ps1"]
    if (-not $updaterManifestEntry) {
      throw "Baseline updater script is missing its integrity manifest entry."
    }
    $originalUpdaterHash = (Get-FileHash -LiteralPath $baselineUpdaterScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($originalUpdaterHash -ne ([string]$updaterManifestEntry.Value).ToLowerInvariant()) {
      throw "Baseline updater script failed integrity validation before runner adaptation."
    }
    if ($baselineUpdaterScript.Contains($publicReleaseSelection)) {
      if (-not $baselineUpdaterScript.Contains('$releaseArguments += $requestedTag') -or
          -not $baselineUpdaterScript.Contains('$releaseOutput = & $githubCli @releaseArguments')) {
        throw "Baseline public updater has no supported Draft release lookup command."
      }
      $baselineUpdaterScript = $baselineUpdaterScript.Replace($publicReleaseSelection, '$isPublicRepository = $false')
    } else {
      $baselineUpdaterScript = $baselineUpdaterScript.Replace($latestReleaseView, $confirmedReleaseView)
    }
    Set-Content -LiteralPath $baselineUpdaterScriptPath -Value $baselineUpdaterScript -Encoding utf8
    $updaterManifestEntry.Value = (Get-FileHash -LiteralPath $baselineUpdaterScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $baselineMetadata | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $baselineMetadataPath -Encoding utf8
    Write-Output "Adapted the legacy baseline release lookup to the confirmed Draft tag."
  } elseif (-not $baselineUpdaterScript.Contains($confirmedReleaseView)) {
    throw "Baseline updater script has no supported release lookup command."
  }

  $baselineMetadataPath = Join-Path $baselineRoot "studio-release.json"
  $baselineMetadata = Get-Content -LiteralPath $baselineMetadataPath -Raw | ConvertFrom-Json
  $legacyReplacePattern = '\[System\.IO\.File\]::Replace\((\$[A-Za-z0-9_:]+),\s*(\$[A-Za-z0-9_:]+),\s*\$null\)'
  $legacyReplaceFix = '[System.IO.File]::Replace($1, $2, "${1}.$([guid]::NewGuid().ToString(''N'')).bak")'
  foreach ($relativePath in @(
    "scripts/update-windows-studio.ps1",
    "scripts/windows-studio-common.ps1"
  )) {
    $scriptPath = Join-Path $baselineRoot ($relativePath -replace '/', '\')
    $manifestEntry = $baselineMetadata.files.PSObject.Properties[$relativePath]
    if (-not $manifestEntry) {
      throw "Baseline script is missing its integrity manifest entry: $relativePath"
    }
    $scriptHash = (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($scriptHash -ne ([string]$manifestEntry.Value).ToLowerInvariant()) {
      throw "Baseline script failed integrity validation before runner adaptation: $relativePath"
    }
    $scriptContent = Get-Content -LiteralPath $scriptPath -Raw
    $replaceCount = [regex]::Matches($scriptContent, $legacyReplacePattern).Count
    if ($replaceCount -gt 0) {
      $scriptContent = [regex]::Replace($scriptContent, $legacyReplacePattern, $legacyReplaceFix)
      Write-Output "Adapted legacy baseline atomic file replacement for Windows PowerShell 5.1: $relativePath ($replaceCount calls)."
    }
    if ($CandidateDirectory -and $relativePath -eq "scripts/windows-studio-common.ps1") {
      . (Join-Path $PSScriptRoot "windows-studio-ready-baseline.ps1")
      $scriptContent = Set-NgtReadyBaselineGhShim $scriptContent
      Write-Output "Adapted the verified legacy baseline to use the local candidate release adapter."
    }
    if ($replaceCount -gt 0 -or ($CandidateDirectory -and $relativePath -eq "scripts/windows-studio-common.ps1")) {
      Set-Content -LiteralPath $scriptPath -Value $scriptContent -Encoding utf8
      $manifestEntry.Value = (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $baselineMetadata | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $baselineMetadataPath -Encoding utf8

  $installationAttempted = $true
  & (Join-Path $baselineRoot "scripts\install-windows-studio.ps1") `
    -DataRoot $dataRoot -InstallRoot $installRoot
  if ($LASTEXITCODE -ne 0) { throw "Baseline studio installation failed." }

  $oldHealth = $null
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
      $oldHealth = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5
      if ([string]$oldHealth.currentVersion -eq ($oldTag -replace "^v", "")) { break }
    } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $oldHealth -or [string]$oldHealth.currentVersion -ne ($oldTag -replace "^v", "")) {
    throw "The previous studio version did not become healthy."
  }
  $ordersResponse = Invoke-WebRequest -Uri "http://127.0.0.1:3000/orders" -UseBasicParsing -TimeoutSec 30
  if ($ordersResponse.StatusCode -ne 200) { throw "The previous studio orders page did not load." }
  $businessCode = "CI-UPDATE-" + [guid]::NewGuid().ToString("N")
  $businessSnapshotPath = Join-Path $testRoot "business-data-snapshot.json"
  Invoke-BusinessDataProbe -ReleaseRoot (Join-Path $installRoot ("releases\$oldTag")) -Action "seed" -Code $businessCode -SnapshotPath $businessSnapshotPath

  $taskRoot = Join-Path $installRoot ("releases\$oldTag")
  $taskConfig = Get-Content -LiteralPath (Join-Path $installRoot ".local\studio.json") -Raw | ConvertFrom-Json
  if ([System.IO.Path]::GetFullPath([string]$taskConfig.activeRelease) -ne [System.IO.Path]::GetFullPath($taskRoot)) {
    throw "The baseline release is not the configured active release."
  }
  $updateId = [guid]::NewGuid().ToString()
  if ($ManualInstaller) {
    @{
      updateId = $updateId
      status = "queued"
      previousVersion = ($oldTag -replace "^v", "")
      targetVersion = $targetVersion
      createdAt = (Get-Date).ToUniversalTime().AddMinutes(-5).ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $updateStatus -Encoding utf8

    $installerPath = Join-Path $env:GITHUB_WORKSPACE "release-assets\ngt-studio-windows-setup-$TargetTag.exe"
    $installerLog = Join-Path $testRoot "manual-upgrade-installer.log"
    $installer = Start-Process -FilePath $installerPath `
      -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=$installerLog") `
      -WindowStyle Hidden -PassThru
    Wait-NgtManualInstaller -Process $installer -Description "Manual upgrade installer"
    $manualStatus = Get-Content -LiteralPath $updateStatus -Raw | ConvertFrom-Json
    if ($manualStatus.status -ne "superseded" -or $manualStatus.actualVersion -ne $targetVersion) {
      throw "Manual upgrade did not supersede the old queued update task."
    }
  } else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $updateLog) -Force | Out-Null
    @{ updateId = $updateId; createdAt = (Get-Date).ToUniversalTime().ToString("o") } |
      ConvertTo-Json | Set-Content -LiteralPath $updateLock -Encoding utf8

    $updaterPath = Join-Path $taskRoot "scripts\update-windows-studio.ps1"
    $arguments = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $updaterPath,
      "-UpdateId", $updateId, "-ExpectedTargetVersion", $TargetTag,
      "-StatusFile", $updateStatus, "-UpdateLockFile", $updateLock, "-LogFile", $updateLog
    )
    $argumentLine = ($arguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join " "
    $updateProcess = Start-Process -FilePath (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe") `
      -ArgumentList $argumentLine -WindowStyle Hidden -PassThru

    $deadline = (Get-Date).AddMinutes(50)
    $finalStatus = $null
    do {
      if (Test-Path -LiteralPath $updateStatus) {
        $finalStatus = Get-Content -LiteralPath $updateStatus -Raw | ConvertFrom-Json
        if ($finalStatus.status -eq "failed") {
          if (-not $updateProcess.HasExited) { [void]$updateProcess.WaitForExit(30000) }
          throw "Online update failed at $($finalStatus.failedStage): $($finalStatus.message)"
        }
      }
      if ($updateProcess.HasExited -and -not (Test-Path -LiteralPath $updateLock)) { break }
      Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if (-not $updateProcess.HasExited) { throw "Online update executor exceeded its 50-minute limit." }
    $updateProcess.WaitForExit()
    if ($updateProcess.ExitCode -ne 0) { throw "Online update executor exited with code $($updateProcess.ExitCode)." }
    if (-not $finalStatus -or $finalStatus.status -ne "complete" -or
        $finalStatus.actualVersion -ne $targetVersion -or $finalStatus.cleanupWarning) {
      throw "Online update did not reach a clean completed state for $TargetTag."
    }
  }
  if (Test-Path -LiteralPath $updateLock) { throw "Online update lock was not released." }
  $maintenanceFile = Join-Path $installRoot ".local\update-maintenance.json"
  if (Test-Path -LiteralPath $maintenanceFile) { throw "Online update maintenance marker was not cleared." }

  $activeConfig = Get-Content -LiteralPath (Join-Path $installRoot ".local\studio.json") -Raw | ConvertFrom-Json
  $activeReleaseRoot = [System.IO.Path]::GetFullPath([string]$activeConfig.activeRelease)
  if ($activeReleaseRoot -ne [System.IO.Path]::GetFullPath((Join-Path $installRoot "releases\$TargetTag"))) {
    throw "The online update did not activate the candidate release."
  }
  $newHealth = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 15
  if ([string]$newHealth.currentVersion -ne $targetVersion) { throw "The new release health version is incorrect." }
  $newOrders = Invoke-WebRequest -Uri "http://127.0.0.1:3000/orders" -UseBasicParsing -TimeoutSec 30
  if ($newOrders.StatusCode -ne 200) { throw "The new release orders page did not load." }
  Invoke-BusinessDataProbe -ReleaseRoot $activeReleaseRoot -Action "verify-and-write" -Code $businessCode -SnapshotPath $businessSnapshotPath
  if ($ManualInstaller) {
    $repairLog = Join-Path $testRoot "manual-repair-installer.log"
    $repair = Start-Process -FilePath $installerPath `
      -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=$repairLog") `
      -WindowStyle Hidden -PassThru
    Wait-NgtManualInstaller -Process $repair -Description "Manual repair installer"
    $repairHealth = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 15
    if ([string]$repairHealth.currentVersion -ne $targetVersion) { throw "Manual repair health version is incorrect." }
    $repairStatus = Get-Content -LiteralPath $updateStatus -Raw | ConvertFrom-Json
    if ($repairStatus.status -ne "idle" -or $repairStatus.actualVersion -ne $targetVersion -or
        $repairStatus.installMode -ne "repair" -or (Test-Path -LiteralPath $maintenanceFile)) {
      throw "Manual repair did not finish with a clean verified status."
    }
    Invoke-BusinessDataProbe -ReleaseRoot $activeReleaseRoot -Action "verify-and-write" -Code $businessCode -SnapshotPath $businessSnapshotPath
  }
  $node = Join-Path $activeReleaseRoot "runtime\node.exe"
  $prisma = Join-Path $activeReleaseRoot "node_modules\prisma\build\index.js"
  Push-Location -LiteralPath $activeReleaseRoot
  try {
    & $node $prisma migrate status
    if ($LASTEXITCODE -ne 0) { throw "Post-update database migration status failed." }
  } finally { Pop-Location }

  $backupDirectory = Join-Path $dataRoot "backups"
  $backup = Get-ChildItem -LiteralPath $backupDirectory -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $backup) { throw "Online update did not create a database and service backup." }
  & (Join-Path $activeReleaseRoot "scripts\test-windows-studio-backup.ps1") -BackupRoot $backup.FullName | Out-Null
  if ($ManualInstaller) {
    Write-Output "Windows manual installer upgrade and repair acceptance passed: $oldTag -> $TargetTag."
  } else {
    Write-Output "Windows online update acceptance passed: $oldTag -> $TargetTag."
  }
} catch {
  $acceptanceFailed = $true
  try {
    $startupTask = Get-ScheduledTask -TaskName "NGT Management System" -ErrorAction SilentlyContinue
    if ($startupTask) {
      Write-Output "--- NGT startup task status ---"
      Get-ScheduledTaskInfo -TaskName "NGT Management System" |
        Select-Object TaskName, LastRunTime, LastTaskResult, NextRunTime | Format-List
      $startupTask.Actions | Select-Object Execute, Arguments, WorkingDirectory | Format-List
    } else {
      Write-Output "NGT startup task was not registered."
    }
    $diagnosticSources = @()
    if ($ManualInstaller) {
      $diagnosticSources += @(@($installerLog, $repairLog) | Where-Object { $_ })
    }
    if (Test-Path -LiteralPath $updateLog -PathType Leaf) { $diagnosticSources += $updateLog }
    if (Test-Path -LiteralPath $updateStatus -PathType Leaf) { $diagnosticSources += $updateStatus }
    $diagnosticSources += @(
      (Join-Path $installRoot "install-preflight.log"),
      (Join-Path $installRoot "install.log"),
      (Join-Path $installRoot "install-stages.log"),
      (Join-Path $installRoot ".local\supervisor.error.log"),
      (Join-Path $installRoot ".local\database.log"),
      (Join-Path $installRoot ".local\database.error.log"),
      (Join-Path $installRoot ".local\application.log"),
      (Join-Path $installRoot ".local\application.error.log"),
      (Join-Path $installRoot ("releases\$oldTag\.local\studio-database.log")),
      (Join-Path $installRoot ("releases\$oldTag\.local\studio-database.error.log")),
      (Join-Path $installRoot ("releases\$oldTag\.local\supervisor.error.log")),
      (Join-Path $installRoot ("releases\$TargetTag\.local\studio-database.log")),
      (Join-Path $installRoot ("releases\$TargetTag\.local\studio-database.error.log")),
      (Join-Path $installRoot ("releases\$TargetTag\.local\supervisor.error.log")),
      (Join-Path $installRoot ("releases\$TargetTag\.local\application.error.log"))
    )
    & (Join-Path $PSScriptRoot "write-windows-studio-diagnostics.ps1") `
      -Stage "online-update" -Tag $TargetTag -Commit $ExpectedCommitSha -Version $targetVersion `
      -Message $_.Exception.Message -SourcePaths $diagnosticSources -EmitToConsole
  } catch {
    Write-Warning "Sanitized online-update diagnostics could not be written."
  }
  throw
} finally {
  if ($updateProcess -and -not $updateProcess.HasExited) {
    & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $updateProcess.Id /T /F | Out-Null
    if (-not $updateProcess.WaitForExit(5000)) {
      $cleanupSafe = $false
      Write-Warning "The update executor could not be stopped; retained isolated test files."
    }
  }
  if ($cleanupSafe -and $installationAttempted -and (Test-Path -LiteralPath (Join-Path $installRoot ".local\studio.json"))) {
    try {
      $activeConfig = Get-Content -LiteralPath (Join-Path $installRoot ".local\studio.json") -Raw | ConvertFrom-Json
      $activeReleaseRoot = [string]$activeConfig.activeRelease
      $commonScript = Join-Path $activeReleaseRoot "scripts\windows-studio-common.ps1"
      if (Test-Path -LiteralPath $commonScript) {
        . $commonScript
        Set-Location -LiteralPath $script:NgtProjectRoot
        Stop-NgtStudioProcesses
      }
      $startupUninstaller = Join-Path $installRoot "service\uninstall-windows-startup.ps1"
      if (Test-Path -LiteralPath $startupUninstaller) { & $startupUninstaller -InstallRoot $installRoot }
    } catch {
      $cleanupSafe = $false
      Write-Warning ("Isolated online-update cleanup needs attention: " + $_.Exception.Message)
    }
  }
  if ($cleanupSafe -and (Test-Path -LiteralPath $testRoot)) {
    $deadline = (Get-Date).AddSeconds(15)
    do {
      $listeners = @(Get-NetTCPConnection -LocalPort 3000, 55432 -State Listen -ErrorAction SilentlyContinue)
      if ($listeners.Count -eq 0 -or (Get-Date) -ge $deadline) { break }
      Start-Sleep -Milliseconds 500
    } while ($true)
    if ($listeners.Count -gt 0) {
      $cleanupSafe = $false
      Write-Warning ("Acceptance cleanup left listeners: " + (($listeners | ForEach-Object { "$($_.LocalPort)/PID $($_.OwningProcess)" }) -join ", "))
    }
  }
  if ($cleanupSafe -and (Test-Path -LiteralPath $testRoot)) {
    Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  } elseif (Test-Path -LiteralPath $testRoot) {
    Write-Warning "Retained the isolated test data at $testRoot because its services could not be verified stopped."
  }
  if (-not $cleanupSafe -and -not $acceptanceFailed) {
    throw "Windows update acceptance cleanup could not be verified."
  }
}
