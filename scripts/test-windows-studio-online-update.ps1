param(
  [Parameter(Mandatory = $true)]
  [string]$TargetTag,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedCommitSha,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedManifestPath,
  [string]$CandidateDirectory = "",
  [string]$AcceptanceUpdaterPath = "",
  [switch]$ManualInstaller
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-studio-install-coordination.ps1")

if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted") {
  throw "Online update acceptance is restricted to a disposable GitHub-hosted Windows runner."
}

function Quote-NgtWindowsPathArgument([string]$Path) {
  if ($Path.EndsWith("\")) { $Path += "\" }
  return ('"{0}"' -f $Path)
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

if ($ManualInstaller) {
  $baselineOutput = & node scripts/windows-studio-release.mjs find-update-baseline $TargetTag
  if ($LASTEXITCODE -ne 0) { throw "Unable to find a supported published release for the manual-upgrade baseline." }
  $baseline = ($baselineOutput | Out-String) | ConvertFrom-Json
  if (-not $baseline) { throw "No published release was found for the manual-upgrade baseline." }
} else {
  if (-not $CandidateDirectory -or -not (Test-Path -LiteralPath $AcceptanceUpdaterPath -PathType Leaf)) {
    throw "Online acceptance requires the verified candidate assets and the isolated acceptance updater."
  }
  $versionParts = $targetVersion.Split(".") | ForEach-Object { [int]$_ }
  if ($versionParts.Count -ne 3 -or $versionParts[2] -lt 1) {
    throw "Online acceptance requires a patch version greater than zero."
  }
  $baseline = [pscustomobject]@{ tagName = "v{0}.{1}.{2}" -f $versionParts[0], $versionParts[1], ($versionParts[2] - 1) }
}

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
$acceptanceServerProcess = $null
$previousTestApiUrl = $env:NGT_TEST_RELEASE_API_URL
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

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class NgtUpdaterAcceptanceWindowProbe {
  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr state);
  private struct WindowRect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  public sealed class WindowInfo {
    public long Handle;
    public long ParentHandle;
    public long OwnerHandle;
    public int ThreadId;
    public int ProcessId;
    public string ClassName;
    public string Title;
    public long Style;
    public long ExtendedStyle;
    public bool IsVisible;
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
    public bool BoundsAvailable;
    public bool OnScreen;
  }

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")]
  private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
  private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, System.Text.StringBuilder className, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, System.Text.StringBuilder title, int maxCount);
  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr window, out WindowRect rect);
  [DllImport("user32.dll")]
  private static extern int GetSystemMetrics(int index);
  [DllImport("kernel32.dll")]
  private static extern uint WTSGetActiveConsoleSessionId();

  public static uint GetActiveConsoleSessionId() { return WTSGetActiveConsoleSessionId(); }

  public static WindowInfo[] GetTopLevelWindows() {
    var windows = new List<WindowInfo>();
    EnumWindows((window, state) => {
      uint processId;
      var threadId = GetWindowThreadProcessId(window, out processId);
      if (processId > 0) {
        var className = new System.Text.StringBuilder(256);
        var title = new System.Text.StringBuilder(512);
        var rect = new WindowRect();
        var boundsAvailable = GetWindowRect(window, out rect);
        GetClassName(window, className, className.Capacity);
        GetWindowText(window, title, title.Capacity);
        var screenLeft = GetSystemMetrics(76);
        var screenTop = GetSystemMetrics(77);
        var screenRight = screenLeft + GetSystemMetrics(78);
        var screenBottom = screenTop + GetSystemMetrics(79);
        windows.Add(new WindowInfo {
          Handle = window.ToInt64(),
          ParentHandle = GetParent(window).ToInt64(),
          OwnerHandle = GetWindow(window, 4).ToInt64(),
          ThreadId = (int)threadId,
          ProcessId = (int)processId,
          ClassName = className.ToString(),
          Title = title.ToString(),
          Style = GetWindowLongPtr(window, -16).ToInt64(),
          ExtendedStyle = GetWindowLongPtr(window, -20).ToInt64(),
          IsVisible = IsWindowVisible(window),
          Left = rect.Left,
          Top = rect.Top,
          Right = rect.Right,
          Bottom = rect.Bottom,
          BoundsAvailable = boundsAvailable,
          OnScreen = boundsAvailable && rect.Right > screenLeft && rect.Left < screenRight &&
            rect.Bottom > screenTop && rect.Top < screenBottom
        });
      }
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
"@

function Get-NgtInteractiveSessionEvidence {
  $currentProcess = Get-Process -Id $PID -ErrorAction Stop
  $sessionId = [int]$currentProcess.SessionId
  $activeSessionId = [uint32][NgtUpdaterAcceptanceWindowProbe]::GetActiveConsoleSessionId()
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  return [pscustomobject]@{
    user = $user
    sessionId = $sessionId
    activeConsoleSessionId = $activeSessionId
    interactive = ($sessionId -gt 0 -and $activeSessionId -eq [uint32]$sessionId)
  }
}

function Get-NgtTopLevelWindows(
  [object[]]$Processes,
  [System.Collections.Generic.HashSet[int]]$ProcessIds,
  [switch]$IncludeProcessDetails
) {
  if ($IncludeProcessDetails -and $null -eq $Processes) {
    $Processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  }
  $windows = [NgtUpdaterAcceptanceWindowProbe]::GetTopLevelWindows()
  foreach ($windowInfo in $windows) {
    if ($ProcessIds -and -not $ProcessIds.Contains([int]$windowInfo.ProcessId)) { continue }
    $process = $null
    if ($IncludeProcessDetails) {
      $process = $Processes | Where-Object { [int]$_.ProcessId -eq [int]$windowInfo.ProcessId } | Select-Object -First 1
      if (-not $process) { continue }
    }
    $owner = ""
    $processPath = ""
    $processSessionId = -1
    if ($IncludeProcessDetails) {
      try {
        $ownerResult = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction Stop
        if ($ownerResult.ReturnValue -eq 0) { $owner = "{0}\{1}" -f $ownerResult.Domain, $ownerResult.User }
      } catch { }
      $processPath = [string]$process.ExecutablePath
      $processSessionId = [int]$process.SessionId
    }
    [pscustomobject]@{
      handle = "0x{0:X}" -f [long]$windowInfo.Handle
      parentHandle = "0x{0:X}" -f [long]$windowInfo.ParentHandle
      ownerHandle = "0x{0:X}" -f [long]$windowInfo.OwnerHandle
      threadId = [int]$windowInfo.ThreadId
      processId = [int]$windowInfo.ProcessId
      processName = [string]$process.Name
      processPath = $processPath
      parentProcessId = if ($process) { [int]$process.ParentProcessId } else { -1 }
      sessionId = $processSessionId
      user = $owner
      commandLine = if ($process) { [string]$process.CommandLine } else { "" }
      windowTitle = [string]$windowInfo.Title
      windowClass = [string]$windowInfo.ClassName
      visible = [bool]$windowInfo.IsVisible
      style = "0x{0:X}" -f [long]$windowInfo.Style
      extendedStyle = "0x{0:X}" -f [long]$windowInfo.ExtendedStyle
      windowBounds = "[$($windowInfo.Left),$($windowInfo.Top),$($windowInfo.Right),$($windowInfo.Bottom)]"
      width = [int]($windowInfo.Right - $windowInfo.Left)
      height = [int]($windowInfo.Bottom - $windowInfo.Top)
      boundsAvailable = [bool]$windowInfo.BoundsAvailable
      onScreen = [bool]$windowInfo.OnScreen
    }
  }
}

function Get-NgtScreenVisibleWindows {
  return @(Get-NgtTopLevelWindows | Where-Object {
    $_.visible -and ((-not $_.boundsAvailable) -or
      ($_.width -gt 0 -and $_.height -gt 0 -and $_.onScreen))
  })
}

function Get-NgtUpdaterWindowDiagnostics([int]$UpdaterPid) {
  $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  $processIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$processIds.Add($UpdaterPid)
  do {
    $added = $false
    foreach ($process in $processes) {
      if ($processIds.Contains([int]$process.ParentProcessId) -and
          $processIds.Add([int]$process.ProcessId)) {
        $added = $true
      }
    }
  } while ($added)
  return @(Get-NgtTopLevelWindows -Processes $processes -ProcessIds $processIds -IncludeProcessDetails)
}

function Get-NgtVisibleWindowProcessIds {
  return @((Get-NgtScreenVisibleWindows | Select-Object -ExpandProperty processId -Unique))
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
  if (-not $ManualInstaller) {
    $portListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $portListener.Start()
    $acceptancePort = [int]$portListener.LocalEndpoint.Port
    $portListener.Stop()
    $serverScript = Join-Path $PSScriptRoot "windows-studio-updater-acceptance-server.cjs"
    $serverLog = Join-Path $testRoot "candidate-server.log"
    $serverArguments = '"' + $serverScript + '" "' + $CandidateDirectory + '" "' + $ExpectedManifestPath + '" ' + $acceptancePort
    $acceptanceServerProcess = Start-Process -FilePath (Get-Command node -ErrorAction Stop).Source `
      -ArgumentList $serverArguments -WorkingDirectory $env:GITHUB_WORKSPACE `
      -RedirectStandardOutput $serverLog -RedirectStandardError ($serverLog + ".error") `
      -WindowStyle Hidden -PassThru
    $env:NGT_TEST_RELEASE_API_URL = "http://127.0.0.1:$acceptancePort"
    $serverReady = $false
    $serverDeadline = (Get-Date).AddSeconds(15)
    do {
      try {
        Invoke-RestMethod -Uri ($env:NGT_TEST_RELEASE_API_URL + "/health") -TimeoutSec 1 | Out-Null
        $serverReady = $true
        break
      } catch { }
      if ($acceptanceServerProcess.HasExited) { throw "The controlled candidate API server exited during startup." }
      Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $serverDeadline)
    if (-not $serverReady) { throw "The controlled candidate API server did not become ready." }
  }
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
  $appName = if ($ManualInstaller) { "ngt-studio-windows-$oldTag.zip" } else { "ngt-studio-windows-$TargetTag.zip" }
  if ($ManualInstaller) {
    $appChecksumName = "$appName.sha256"
    $runtimeName = "ngt-studio-runtime-$oldTag.zip"
    $runtimeChecksumName = "$runtimeName.sha256"
    Invoke-GhDownload -Tag $oldTag -Directory $downloadRoot -AssetNames @(
      $appName, $appChecksumName, $runtimeName, $runtimeChecksumName
    )
    $oldAppArchive = Join-Path $downloadRoot $appName
    $oldRuntimeArchive = Join-Path $downloadRoot $runtimeName
    Assert-ReleaseChecksum $oldAppArchive (Join-Path $downloadRoot $appChecksumName)
    Assert-ReleaseChecksum $oldRuntimeArchive (Join-Path $downloadRoot $runtimeChecksumName)
  } else {
    $oldAppArchive = Join-Path $CandidateDirectory $appName
    Assert-ReleaseChecksum $oldAppArchive (Join-Path $CandidateDirectory ($appName + ".sha256"))
  }
  New-Item -ItemType Directory -Path $baselineRoot -Force | Out-Null
  & tar.exe -xf $oldAppArchive -C $baselineRoot
  if ($LASTEXITCODE -ne 0) { throw "Baseline application archive extraction failed." }
  if ($ManualInstaller) {
    & tar.exe -xf $oldRuntimeArchive -C $baselineRoot
    if ($LASTEXITCODE -ne 0) { throw "Baseline runtime archive extraction failed." }
    Normalize-LegacyBaselineDocumentationPaths -Root $baselineRoot
  } else {
    $baselineRuntimeArchive = Join-Path $CandidateDirectory "ngt-studio-runtime-$TargetTag.zip"
    Assert-ReleaseChecksum $baselineRuntimeArchive `
      (Join-Path $CandidateDirectory ("ngt-studio-runtime-$TargetTag.zip.sha256"))
    & tar.exe -xf $baselineRuntimeArchive -C $baselineRoot
    if ($LASTEXITCODE -ne 0) { throw "Candidate baseline runtime archive extraction failed." }
    $baselineMetadataPath = Join-Path $baselineRoot "studio-release.json"
    $baselineMetadata = Get-Content -LiteralPath $baselineMetadataPath -Raw | ConvertFrom-Json
    $baselineMetadata.version = $oldTag -replace "^v", ""
    Copy-Item -LiteralPath $AcceptanceUpdaterPath -Destination (Join-Path $baselineRoot "tools\NGTUpdater.exe") -Force
    $updaterEntry = $baselineMetadata.files.PSObject.Properties["tools/NGTUpdater.exe"]
    if (-not $updaterEntry) { throw "Candidate package is missing the updater integrity entry." }
    $updaterEntry.Value = (Get-FileHash -LiteralPath (Join-Path $baselineRoot "tools\NGTUpdater.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
    $baselineMetadata | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $baselineMetadataPath -Encoding utf8
  }

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

  $baselineMetadataPath = Join-Path $baselineRoot "studio-release.json"
  $baselineMetadata = Get-Content -LiteralPath $baselineMetadataPath -Raw | ConvertFrom-Json
  $legacyReplacePattern = '\[System\.IO\.File\]::Replace\((\$[A-Za-z0-9_:]+),\s*(\$[A-Za-z0-9_:]+),\s*\$null\)'
  $legacyReplaceFix = '[System.IO.File]::Replace($1, $2, "${1}.$([guid]::NewGuid().ToString(''N'')).bak")'
  foreach ($relativePath in @(
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
    $installerPath = Join-Path $env:GITHUB_WORKSPACE "release-assets\ngt-studio-windows-setup-$TargetTag.exe"
    $installerLog = Join-Path $testRoot "manual-upgrade-installer.log"
    $installer = Start-Process -FilePath $installerPath `
      -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=$installerLog") `
      -WindowStyle Hidden -PassThru
    Wait-NgtManualInstaller -Process $installer -Description "Manual upgrade installer"
  } else {
    $sameOriginHeaders = @{
      Origin = "http://127.0.0.1:3000"
      "Sec-Fetch-Site" = "same-origin"
    }
    $updateInfo = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/system-update" `
      -Headers $sameOriginHeaders -TimeoutSec 30
    if (-not $updateInfo.updateAvailable -or $updateInfo.latestVersion -ne $targetVersion) {
      throw "The installed NGT API did not offer the exact candidate version."
    }
    $sessionEvidence = Get-NgtInteractiveSessionEvidence
    Write-Output ("Interactive acceptance user={0}; session={1}; activeConsoleSession={2}." -f `
      $sessionEvidence.user, $sessionEvidence.sessionId, $sessionEvidence.activeConsoleSessionId)
    if (-not $sessionEvidence.interactive) {
      throw "Window acceptance requires the active interactive Windows console session; this process is not attached to it."
    }
    $visibleWindowBaseline = @(Get-NgtVisibleWindowProcessIds)
    $mutexAlias = Join-Path $testRoot "install-root-junction"
    New-Item -ItemType Junction -Path $mutexAlias -Target $installRoot | Out-Null
    foreach ($mutexRootVariant in @($installRoot, ($installRoot + "\"), $installRoot.ToUpperInvariant(), $mutexAlias)) {
      $mutexOutputPath = Join-Path $testRoot ("mutex-name-" + [guid]::NewGuid().ToString("N") + ".txt")
      $mutexDiagnosticProcess = Start-Process -FilePath $AcceptanceUpdaterPath `
        -ArgumentList @("--test-mutex-name", (Quote-NgtWindowsPathArgument $mutexRootVariant), `
          (Quote-NgtWindowsPathArgument $mutexOutputPath)) `
        -WindowStyle Hidden -PassThru
      if (-not $mutexDiagnosticProcess.WaitForExit(30000)) {
        Stop-Process -Id $mutexDiagnosticProcess.Id -Force
        throw "Rust updater mutex diagnostic timed out after 30 seconds."
      }
      $mutexDiagnosticProcess.Refresh()
      $mutexProcessExitCode = $mutexDiagnosticProcess.ExitCode
      if (-not (Test-Path -LiteralPath $mutexOutputPath -PathType Leaf)) {
        throw ("Rust updater did not write the mutex identity diagnostic for path '{0}' (process exit code {1}; output file missing)." -f `
          $mutexRootVariant, $mutexProcessExitCode)
      }
      $mutexDiagnostic = [System.IO.File]::ReadAllText($mutexOutputPath)
      if ($mutexProcessExitCode -ne 0) {
        throw ("Rust updater mutex diagnostic failed for path '{0}' (process exit code {1}; diagnostic: {2})." -f `
          $mutexRootVariant, $mutexProcessExitCode, $mutexDiagnostic.Trim())
      }
      $mutexDiagnosticLines = $mutexDiagnostic -split "`r?`n", 2
      if ($mutexDiagnosticLines.Count -ne 2 -or $mutexDiagnosticLines[0] -cne "OK") {
        throw ("Rust updater returned an invalid mutex diagnostic for path '{0}': {1}." -f `
          $mutexRootVariant, $mutexDiagnostic.Trim())
      }
      $rustMutexName = $mutexDiagnosticLines[1].Trim()
      $powershellMutexName = Get-NgtStudioUpdateMutexName $mutexRootVariant
      if ([string]($rustMutexName | Out-String).Trim() -cne [string]$powershellMutexName) {
        throw ("Rust and PowerShell computed different update mutex identities for path '{0}': Rust='{1}', PowerShell='{2}'." -f `
          $mutexRootVariant, $rustMutexName, $powershellMutexName)
      }
    }
    Write-Output "Rust and PowerShell update mutex identity matched for case, trailing-separator, and junction aliases."

    $updaterPath = Join-Path $taskRoot "tools\NGTUpdater.exe"
    $failureMarker = Join-Path $installRoot ".local\acceptance-failure-stage"
    "release-deployment" | Set-Content -LiteralPath $failureMarker -Encoding ascii
    $failedStartResponse = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/system-update" `
      -Method Post -Headers $sameOriginHeaders -ContentType "application/json" `
      -Body (@{ targetVersion = $TargetTag } | ConvertTo-Json -Compress) -TimeoutSec 30
    if (-not $failedStartResponse.started -or -not $failedStartResponse.executorConfirmed -or
        [string]$failedStartResponse.operation -ne "online-update") {
      throw "The NGT API did not start the injected Rust updater attempt."
    }
    $failedUpdateId = [string]$failedStartResponse.updateId
    $failedUpdater = Get-Process -Id ([int]$failedStartResponse.executorPid) -ErrorAction Stop
    $failedUpdaterHandle = $failedUpdater.Handle
    if ($failedUpdaterHandle -eq [IntPtr]::Zero -or
        [System.IO.Path]::GetFullPath($failedUpdater.Path) -ine [System.IO.Path]::GetFullPath($updaterPath) -or
        [int]$failedUpdater.SessionId -ne [int]$sessionEvidence.sessionId) {
      throw "The injected attempt was not executed by the versioned Rust updater in the tested session."
    }
    if (-not $failedUpdater.WaitForExit(1800000)) {
      throw "The injected Rust updater attempt exceeded 30 minutes."
    }
    $failedUpdater.Refresh()
    if ($failedUpdater.ExitCode -eq 0) {
      throw "The injected partial deployment unexpectedly succeeded."
    }
    if (Test-Path -LiteralPath $failureMarker) {
      throw "The acceptance-only Rust updater did not consume its failure marker."
    }
    $failedStatus = Get-Content -LiteralPath $updateStatus -Raw | ConvertFrom-Json
    if ([string]$failedStatus.updateId -ne $failedUpdateId -or
        [string]$failedStatus.status -ne "failed" -or
        [string]$failedStatus.failedStage -ne "release-deployment" -or
        [string]$failedStatus.recoveryStatus -ne "succeeded" -or
        [string]$failedStatus.actualVersion -ne ($oldTag -replace "^v", "") -or
        [bool]$failedStatus.manualReview) {
      throw "The injected deployment failure did not finish with a verified automatic rollback."
    }
    $failedLock = Get-Content -LiteralPath $updateLock -Raw | ConvertFrom-Json
    if ([string]$failedLock.updateId -ne $failedUpdateId -or
        [string]$failedLock.operation -ne "online-update") {
      throw "The failed updater lock no longer identifies the injected task."
    }
    $maintenanceFile = Join-Path $installRoot ".local\update-maintenance.json"
    if (Test-Path -LiteralPath $maintenanceFile) {
      throw "The verified rollback left its maintenance marker behind."
    }
    $rolledBackConfig = Get-Content -LiteralPath (Join-Path $installRoot ".local\studio.json") -Raw | ConvertFrom-Json
    if ([System.IO.Path]::GetFullPath([string]$rolledBackConfig.activeRelease) -ine
        [System.IO.Path]::GetFullPath($taskRoot)) {
      throw "The injected failure did not restore the previous active release."
    }
    $rolledBackHealth = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 15
    if ([string]$rolledBackHealth.currentVersion -ne ($oldTag -replace "^v", "")) {
      throw "The previous release was not healthy after automatic rollback."
    }
    Invoke-BusinessDataProbe -ReleaseRoot $taskRoot -Action "verify" -Code $businessCode -SnapshotPath $businessSnapshotPath
    $partialReleaseRoot = Join-Path $installRoot "releases\$TargetTag"
    $partialEntryCount = @(Get-ChildItem -LiteralPath $partialReleaseRoot -Force).Count
    $sourceEntryCount = @(Get-ChildItem -LiteralPath $baselineRoot -Force).Count
    if ($partialEntryCount -lt 1 -or $partialEntryCount -ge $sourceEntryCount) {
      throw "The injected deployment did not leave a demonstrably incomplete candidate directory."
    }
    Write-Output "Injected deployment interruption rolled back the release and database with an incomplete candidate retained for retry."

    $startResponse = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/system-update" `
      -Method Post -Headers $sameOriginHeaders -ContentType "application/json" `
      -Body (@{ targetVersion = $TargetTag } | ConvertTo-Json -Compress) -TimeoutSec 30
    if (-not $startResponse.started -or -not $startResponse.executorConfirmed -or
        [string]$startResponse.operation -ne "online-update") {
      throw "The NGT API did not confirm the Rust updater startup handshake."
    }
    $updateId = [string]$startResponse.updateId
    $updaterPid = [int]$startResponse.executorPid
    $updateProcess = Get-Process -Id $updaterPid -ErrorAction Stop
    $updaterProcessHandle = $updateProcess.Handle
    if ($updaterProcessHandle -eq [IntPtr]::Zero) {
      throw "The acceptance could not retain a process handle for the Rust updater."
    }
    if ([System.IO.Path]::GetFullPath($updateProcess.Path) -ine [System.IO.Path]::GetFullPath($updaterPath)) {
      throw "The API started a process other than the versioned Rust updater."
    }
    if ([int]$updateProcess.SessionId -ne [int]$sessionEvidence.sessionId) {
      throw "The Rust updater was not started in the tested interactive Windows user session."
    }

    $computer = Get-CimInstance -ClassName Win32_ComputerSystem
    $cpuCount = (Get-CimInstance -ClassName Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
    $memoryGiB = [Math]::Round($computer.TotalPhysicalMemory / 1GB, 2)
    Write-Output ("Acceptance host: {0} logical CPUs, {1} GiB RAM." -f $cpuCount, $memoryGiB)
    $peakUpdaterWorkingSet = 0L
    $apiDisconnectedObserved = $false
    $apiReconnectedAfterDisconnect = $false
    $observedWindowEvidence = @{}
    $deadline = (Get-Date).AddMinutes(50)
    $finalStatus = $null
    do {
      $failedUpdateMessage = $null
      if (Test-Path -LiteralPath $updateStatus) {
        $finalStatus = Get-Content -LiteralPath $updateStatus -Raw | ConvertFrom-Json
        if ([string]$finalStatus.updateId -ne $updateId) {
          throw "The persisted update state changed ownership during online update."
        }
        if ($finalStatus.status -eq "failed") {
          $failedUpdateMessage = "Rust online update failed at $($finalStatus.failedStage): $($finalStatus.message)"
        }
      }
      $windowDiagnostics = @(Get-NgtUpdaterWindowDiagnostics -UpdaterPid $updaterPid)
      foreach ($window in $windowDiagnostics) {
        $windowKey = "$($window.handle)/$($window.processId)"
        if (-not $observedWindowEvidence.ContainsKey($windowKey)) {
          $observedWindowEvidence[$windowKey] = $window
          Write-Output ("Window evidence: HWND={0} class='{1}' bounds={2} size={3}x{4} style={5} exstyle={6} visible={7} onScreen={8} pid={9} process='{10}' path='{11}' parent={12} session={13} user='{14}' title='{15}' command='{16}'" -f `
            $window.handle, $window.windowClass, $window.windowBounds, $window.width, $window.height,
            $window.style, $window.extendedStyle, $window.visible, $window.onScreen, $window.processId,
            $window.processName, $window.processPath, $window.parentProcessId, $window.sessionId,
            $window.user, $window.windowTitle, $window.commandLine)
        }
      }
      $unexpectedUpdaterWindows = @($windowDiagnostics | Where-Object {
        $_.visible -and ((-not $_.boundsAvailable) -or
          ($_.width -gt 0 -and $_.height -gt 0 -and $_.onScreen))
      })
      if ($unexpectedUpdaterWindows.Count -gt 0) {
        $windowOwners = ($unexpectedUpdaterWindows | ForEach-Object {
          "HWND=$($_.handle) class='$($_.windowClass)' bounds=$($_.windowBounds) size=$($_.width)x$($_.height) style=$($_.style) exstyle=$($_.extendedStyle) visible=$($_.visible) onScreen=$($_.onScreen) pid=$($_.processId) process='$($_.processName)' path='$($_.processPath)' parent=$($_.parentProcessId) session=$($_.sessionId) user='$($_.user)' title='$($_.windowTitle)' command='$($_.commandLine)'"
        }) -join ", "
        throw "The silent online update displayed a visible installer, CMD, or PowerShell window: $windowOwners"
      }
      $newVisibleWindowIds = @(Get-NgtVisibleWindowProcessIds | Where-Object { $_ -notin $visibleWindowBaseline })
      if ($newVisibleWindowIds.Count -gt 0) {
        $newVisibleWindows = @(Get-NgtScreenVisibleWindows | Where-Object {
          $_.processId -in $newVisibleWindowIds
        })
        $windowOwners = ($newVisibleWindows | ForEach-Object {
          "HWND=$($_.handle) class='$($_.windowClass)' bounds=$($_.windowBounds) size=$($_.width)x$($_.height) style=$($_.style) exstyle=$($_.extendedStyle) visible=$($_.visible) onScreen=$($_.onScreen) pid=$($_.processId)"
        }) -join ", "
        throw "The silent online update created an unexpected visible window: $windowOwners"
      }
      if ($failedUpdateMessage) { throw $failedUpdateMessage }
      try {
        $updateProcess.Refresh()
        $peakUpdaterWorkingSet = [Math]::Max($peakUpdaterWorkingSet, [long]$updateProcess.PeakWorkingSet64)
      } catch { }
      try {
        $liveStatus = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/system-update/status" `
          -Headers $sameOriginHeaders -TimeoutSec 1
        if ($apiDisconnectedObserved) { $apiReconnectedAfterDisconnect = $true }
        if ($liveStatus.status -eq "failed") {
          throw "NGT reported an online update failure at $($liveStatus.failedStage): $($liveStatus.message)"
        }
      } catch {
        if ($_.Exception.Message -like "NGT reported an online update failure*") { throw }
        $apiDisconnectedObserved = $true
        $savedDuringDisconnect = Get-Content -LiteralPath $updateStatus -Raw | ConvertFrom-Json
        if ([string]$savedDuringDisconnect.updateId -ne $updateId -or
            [string]$savedDuringDisconnect.stage -notin @("backing-up", "installing", "validating", "rolling-back")) {
          throw "The independent update state was not recoverable while NGT was disconnected."
        }
      }
      if ($finalStatus.status -eq "complete") {
        $updateProcess.Refresh()
        if ($updateProcess.HasExited) { break }
      }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    $updateProcess.Refresh()
    if (-not $updateProcess.HasExited) { throw "The Rust updater exceeded its 50-minute limit." }
    $updateProcess.WaitForExit()
    Write-Output ("Interactive window probe completed in session {0}; observed {1} updater-tree top-level HWNDs." -f `
      $sessionEvidence.sessionId, $observedWindowEvidence.Count)
    Write-Output ("Rust updater process exit code: {0}." -f $updateProcess.ExitCode)
    if ($updateProcess.ExitCode -ne 0) { throw "Rust updater exited with code $($updateProcess.ExitCode)." }
    if (-not $finalStatus -or $finalStatus.status -ne "complete" -or
        $finalStatus.actualVersion -ne $targetVersion) {
      throw "Rust online update did not reach a verified complete state for $TargetTag."
    }
    if (-not $apiDisconnectedObserved -or -not $apiReconnectedAfterDisconnect) {
      throw "Acceptance did not observe both the independent NGT outage state and automatic reconnection."
    }
    $statusResult = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/system-update/status" `
      -Headers $sameOriginHeaders -TimeoutSec 15
    if ($statusResult.status -ne "complete" -or $statusResult.actualVersion -ne $targetVersion) {
      throw "The restarted NGT API did not report the verified installed version."
    }
    if (Test-Path -LiteralPath $updateLock) { throw "The updater left its task lock after exiting." }
    $failedReleaseDirectory = Join-Path $installRoot ".local\failed-install-releases"
    $quarantinedCandidates = @(Get-ChildItem -LiteralPath $failedReleaseDirectory -Directory -ErrorAction SilentlyContinue |
      Where-Object Name -Like "$updateId-*")
    if ($quarantinedCandidates.Count -ne 1 -or
        @(Get-ChildItem -LiteralPath $quarantinedCandidates[0].FullName -Force).Count -ne $partialEntryCount) {
      throw "The retry did not quarantine exactly the incomplete candidate owned by its update task."
    }
    Write-Output ("Rust updater peak working set: {0:N1} MiB; CPU time: {1:N1} s." -f `
      ($peakUpdaterWorkingSet / 1MB), $updateProcess.TotalProcessorTime.TotalSeconds)
    if ($peakUpdaterWorkingSet -gt 100MB) {
      throw "Rust updater memory use exceeded the 100 MiB design target."
    }
  }
  if (Test-Path -LiteralPath $updateLock) { throw "Online update lock was not released." }
  $maintenanceFile = Join-Path $installRoot ".local\update-maintenance.json"
  if (Test-Path -LiteralPath $maintenanceFile) { throw "Online update maintenance marker was not cleared." }

  $activeConfig = Get-Content -LiteralPath (Join-Path $installRoot ".local\studio.json") -Raw | ConvertFrom-Json
  $activeReleaseRoot = [System.IO.Path]::GetFullPath([string]$activeConfig.activeRelease)
  if ([System.IO.Path]::GetFullPath([string]$activeConfig.dataRoot) -ine [System.IO.Path]::GetFullPath($dataRoot)) {
    throw "The update changed the configured database data root."
  }
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
  $uiSmoke = Join-Path (Split-Path $PSScriptRoot -Parent) "tests\release\windows-studio-online-update-ui.mjs"
  & (Get-Command node -ErrorAction Stop).Source $uiSmoke $activeReleaseRoot $targetVersion $ExpectedCommitSha
  if ($LASTEXITCODE -ne 0) { throw "Installed Edge page, API, or static-resource acceptance failed." }
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
    } elseif ($updateId) {
      $diagnosticSources += Join-Path $installRoot "logs\update-$updateId.inno.log"
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
  if ($acceptanceServerProcess -and -not $acceptanceServerProcess.HasExited) {
    $acceptanceServerProcess.Kill()
    if (-not $acceptanceServerProcess.WaitForExit(5000)) {
      $cleanupSafe = $false
      Write-Warning "The controlled candidate API server could not be stopped."
    }
  }
  if ($null -eq $previousTestApiUrl) {
    Remove-Item Env:NGT_TEST_RELEASE_API_URL -ErrorAction SilentlyContinue
  } else {
    $env:NGT_TEST_RELEASE_API_URL = $previousTestApiUrl
  }
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
