param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion
)
$ErrorActionPreference = "Stop"

function Wait-NgtInstallerProcess(
  [System.Diagnostics.Process]$Process,
  [string]$Description,
  [int]$TimeoutMinutes,
  [string[]]$ProgressPaths
) {
  $deadline = [DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
  $lastProgress = @{}
  while (-not $Process.WaitForExit(15000)) {
    foreach ($path in $ProgressPaths) {
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
      $lines = @(Get-Content -LiteralPath $path -Tail 3 -ErrorAction SilentlyContinue)
      $progress = [string]::Join(" | ", $lines)
      if (-not $progress -or $lastProgress[$path] -eq $progress) { continue }
      $lastProgress[$path] = $progress
      $progress = $progress `
        -replace '(?i)(password|secret|token|authorization)(\s*[:=]\s*)[^\s,;"]+', '$1$2[REDACTED]' `
        -replace '(?i)(postgres(?:ql)?://)[^:/\s]+:[^@\s]+@', '$1[REDACTED]@' `
        -replace '(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]'
      Write-Output ("{0} progress ({1}): {2}" -f $Description, (Split-Path -Leaf $path), $progress)
    }
    if ($Process.HasExited) { break }
    if ([DateTime]::UtcNow -lt $deadline) { continue }

    Write-Output ("{0} exceeded its {1}-minute acceptance limit; stopping its process tree." -f $Description, $TimeoutMinutes)
    & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $Process.Id /T /F | Out-Null
    if (-not $Process.WaitForExit(5000)) {
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
      if (-not $Process.WaitForExit(5000)) {
        throw "$Description exceeded its acceptance limit and could not be stopped."
      }
    }
    throw "$Description exceeded its $TimeoutMinutes-minute acceptance limit."
  }
  $Process.Refresh()
}

if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted") {
  throw "Installer acceptance is restricted to a disposable GitHub-hosted Windows runner."
}

$installerPath = [System.IO.Path]::GetFullPath($InstallerPath)
$checksumPath = "$installerPath.sha256"
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
  throw "The Windows installer or its SHA256 file is missing."
}
$checksum = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
if ($checksum -notmatch '^([A-Fa-f0-9]{64})\s+(.+)$' -or
    $Matches[2] -ne (Split-Path -Leaf $installerPath) -or
    (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash -ne $Matches[1]) {
  throw "The Windows installer checksum is invalid."
}

$installRoot = Join-Path $env:LOCALAPPDATA "NGT"
if (Test-Path -LiteralPath (Join-Path $installRoot ".local\studio.json")) {
  throw "The disposable runner already has an NGT Studio installation."
}
if (Get-ScheduledTask -TaskName "NGT Management System" -ErrorAction SilentlyContinue) {
  throw "The disposable runner already has an NGT startup task."
}
foreach ($port in @(3000, 55432)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Installer acceptance port $port is already in use."
  }
}

$installationAttempted = $false
$cleanupSafe = $true
$installerLog = Join-Path $env:RUNNER_TEMP "installer.log"
$installStagesLog = Join-Path $installRoot "install-stages.log"
try {
  $installationAttempted = $true
  Write-Output "Starting the verified Windows installer; progress will be reported from its install logs."
  $installer = Start-Process -FilePath $installerPath `
    -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=$installerLog") `
    -WindowStyle Hidden -PassThru
  Wait-NgtInstallerProcess -Process $installer -Description "Windows installer" `
    -TimeoutMinutes 30 -ProgressPaths @($installerLog, $installStagesLog)
  if ($installer.ExitCode -ne 0) {
    throw "The Windows installer exited with code $($installer.ExitCode)."
  }

  $configurationPath = Join-Path $installRoot ".local\studio.json"
  if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
    throw "The installer did not write the stable Studio configuration."
  }
  $configuration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
  $releaseRoot = [System.IO.Path]::GetFullPath([string]$configuration.activeRelease)
  $metadataPath = Join-Path $releaseRoot "studio-release.json"
  if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "The installer did not activate a complete Studio release."
  }
  $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
  if ([string]$metadata.version -ne $ExpectedVersion) {
    throw "Installed release version does not match the verified build artifact."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $releaseRoot "runtime\node.exe"))) {
    throw "The installed release is missing its verified Node runtime."
  }

  $health = $null
  for ($attempt = 0; $attempt -lt 180; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5
      if ([string]$health.status -eq "ok" -and
          [string]$health.currentVersion -eq [string]$metadata.version -and
          [string]$health.buildCommit -ieq $env:GITHUB_SHA) { break }
    } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $health -or [string]$health.status -ne "ok" -or
      [string]$health.currentVersion -ne [string]$metadata.version -or
      [string]$health.buildCommit -ine $env:GITHUB_SHA) {
    throw "The installed Studio did not report the exact candidate version and commit as healthy."
  }
  & (Join-Path $releaseRoot "scripts\verify-windows-studio-runtime.ps1") `
    -ReleaseRoot $releaseRoot -ExpectedVersion ([string]$metadata.version) `
    -ExpectedCommit $env:GITHUB_SHA
  if (-not (Test-Path -LiteralPath $installStagesLog) -or
      -not (Select-String -LiteralPath $installStagesLog -Pattern "COMPLETE health-validation" -Quiet)) {
    throw "The installer did not complete its health-validation stage."
  }
  Write-Output "Windows installer acceptance passed for v$($metadata.version)."
} catch {
  try {
    $releaseStateDirectory = Join-Path $installRoot ("releases\v" + $ExpectedVersion + "\.local")
    $diagnosticSources = @(
      $installerLog,
      (Join-Path $installRoot "install.log"),
      $installStagesLog,
      (Join-Path $installRoot ".local\supervisor.error.log"),
      (Join-Path $installRoot ".local\database.log"),
      (Join-Path $installRoot ".local\database.error.log"),
      (Join-Path $installRoot ".local\application.log"),
      (Join-Path $installRoot ".local\application.error.log"),
      (Join-Path $releaseStateDirectory "studio-database.log"),
      (Join-Path $releaseStateDirectory "studio-database.error.log"),
      (Join-Path $releaseStateDirectory "supervisor.error.log"),
      (Join-Path $releaseStateDirectory "application.error.log")
    )
    & (Join-Path $PSScriptRoot "write-windows-studio-diagnostics.ps1") `
      -Stage "installer-acceptance" -Tag ("v" + $ExpectedVersion) -Commit $env:GITHUB_SHA `
      -Version $ExpectedVersion -Message $_.Exception.Message -SourcePaths $diagnosticSources -EmitToConsole
  } catch {
    Write-Warning "Sanitized installer diagnostics could not be written."
  }
  throw
} finally {
  if ($installationAttempted) {
    $uninstaller = Join-Path $installRoot "uninstall\unins000.exe"
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      try {
        $uninstallerLog = Join-Path $env:RUNNER_TEMP "uninstaller.log"
        $uninstallProcess = Start-Process -FilePath $uninstaller `
          -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=$uninstallerLog") `
          -WindowStyle Hidden -PassThru
        Wait-NgtInstallerProcess -Process $uninstallProcess `
          -Description "Windows installer acceptance uninstaller" `
          -TimeoutMinutes 5 -ProgressPaths @($uninstallerLog)
        if ($uninstallProcess.ExitCode -ne 0) {
          throw "The Windows installer acceptance uninstaller exited with code $($uninstallProcess.ExitCode)."
        }
      } catch {
        $cleanupSafe = $false
        Write-Warning ("Installer acceptance cleanup failed: " + $_.Exception.Message)
      }
    } elseif (Test-Path -LiteralPath (Join-Path $installRoot ".local\studio.json")) {
      $cleanupSafe = $false
      Write-Warning "Installer acceptance could not find its uninstaller; retained the isolated installation."
    }
  }
  if ($cleanupSafe) {
    foreach ($port in @(3000, 55432)) {
      if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        $cleanupSafe = $false
        Write-Warning "Installer acceptance left port $port open; no process was stopped by the test cleanup."
      }
    }
  }
  if (-not $cleanupSafe) { throw "Windows installer acceptance cleanup could not be verified." }
}
