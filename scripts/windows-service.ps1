$ErrorActionPreference = "Stop"

$installRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = Join-Path $installRoot ".local"
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
Set-Content -LiteralPath (Join-Path $stateDirectory "supervisor.pid") -Value $PID -Encoding ascii
. (Join-Path $PSScriptRoot "windows-studio-common.ps1")

$studioConfigPath = Join-Path $stateDirectory "studio.json"
if (Test-Path -LiteralPath $studioConfigPath) {
  $studioConfig = Get-Content -LiteralPath $studioConfigPath -Raw | ConvertFrom-Json
  if (-not $studioConfig.dataRoot -or -not $studioConfig.activeRelease) {
    throw "Studio configuration is missing dataRoot or activeRelease."
  }
  $env:NGT_DATA_ROOT = [System.IO.Path]::GetFullPath([string]$studioConfig.dataRoot)
  $projectRoot = [System.IO.Path]::GetFullPath([string]$studioConfig.activeRelease)
} else {
  throw "Studio configuration is missing. Run scripts/install-windows-studio.ps1 first."
}
Set-Location -LiteralPath $projectRoot

$releaseMetadata = Get-Content -LiteralPath (Join-Path $projectRoot "studio-release.json") -Raw | ConvertFrom-Json
if (-not $releaseMetadata.version -or [string]$releaseMetadata.version -notmatch '^\d+\.\d+\.\d+$' -or
    [string]$releaseMetadata.commit -notmatch '^[a-f0-9]{40}$') {
  throw "Active release metadata is missing its version or commit identity."
}
$expectedVersion = [string]$releaseMetadata.version
$expectedCommit = [string]$releaseMetadata.commit

$releaseNode = Join-Path $projectRoot "runtime\node.exe"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (Test-Path -LiteralPath $releaseNode) {
  $nodeExecutable = $releaseNode
} elseif (Test-Path -LiteralPath $bundledNode) {
  $nodeExecutable = $bundledNode
} else {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $nodeExecutable = $nodeCommand.Source
}

function Test-NgtPortOwnership([int]$Port) {
  $connections = @(Get-NgtStudioPortConnections -Port $Port)
  if ($connections.Count -eq 0) { return $false }

  foreach ($connection in $connections) {
    $listenerId = [int]$connection.OwningProcess
    $listener = Get-NgtStudioProcess -ProcessId $listenerId
    $owned = $false
    if ($Port -eq 3000) {
      $applicationPidPath = Join-Path $stateDirectory "application.pid"
      [int]$applicationId = 0
      if ((Test-Path -LiteralPath $applicationPidPath -PathType Leaf) -and
          [int]::TryParse((Get-Content -LiteralPath $applicationPidPath -Raw).Trim(), [ref]$applicationId)) {
        $application = Get-NgtStudioProcess -ProcessId $applicationId
        $nodePaths = Get-NgtStudioNodePaths -ReleaseRoot $projectRoot -InstallRoot $installRoot
        $owned = (Test-NgtStudioApplicationProcess `
            -Process $application -ReleaseRoot $projectRoot -AllowedNodePaths $nodePaths `
            -ActiveRelease $projectRoot -SupervisorId $PID) -and
          (Test-NgtStudioProcessTree -ProcessId $listenerId -AncestorId $applicationId) -and
          (Test-NgtStudioApplicationListenerProcess -Process $listener -ApplicationProcess $application)
      }
    } elseif ($Port -eq 55432) {
      $databasePidPath = Join-Path $stateDirectory "database.pid"
      $databaseState = Join-Path $projectRoot ".local"
      $dataPath = Join-Path $databaseState "database-location.txt"
      $runtimePath = Join-Path $databaseState "database-runtime-location.txt"
      [int]$databaseRootId = 0
      if ((Test-Path -LiteralPath $databasePidPath -PathType Leaf) -and
          (Test-Path -LiteralPath $dataPath -PathType Leaf) -and
          (Test-Path -LiteralPath $runtimePath -PathType Leaf) -and
          [int]::TryParse((Get-Content -LiteralPath $databasePidPath -Raw).Trim(), [ref]$databaseRootId)) {
        $databaseRoot = Get-NgtStudioProcess -ProcessId $databaseRootId
        $runtime = (Get-Content -LiteralPath $runtimePath -Raw).Trim()
        $dataDirectory = (Get-Content -LiteralPath $dataPath -Raw).Trim()
        $expectedDataDirectory = Join-Path $env:NGT_DATA_ROOT "data"
        $nodePaths = Get-NgtStudioNodePaths -ReleaseRoot $projectRoot -InstallRoot $installRoot
        $owned = (Test-NgtStudioPathEquals -Actual $dataDirectory -Expected $expectedDataDirectory) -and
          (Test-NgtStudioDatabaseLauncherProcess `
            -Process $databaseRoot -ReleaseRoot $projectRoot -AllowedNodePaths $nodePaths `
            -ActiveRelease $projectRoot -SupervisorId $PID) -and
          (Test-NgtStudioProcessTree -ProcessId $listenerId -AncestorId $databaseRootId) -and
          (Test-NgtStudioPostgresProcess -Process $listener -RuntimeRoot $runtime -DataDirectory $dataDirectory)
      }
    } else {
      throw "NGT service does not manage listener port $Port."
    }
    if (-not $owned) {
      $name = if ($listener) { [string]$listener.Name } else { "unknown process" }
      $executable = if ($listener) { [string]$listener.ExecutablePath } else { "executable unavailable" }
      throw "Port $Port is occupied by unverified PID $listenerId ($name, $executable); it was left running."
    }
  }
  return $true
}

function Test-NgtDatabaseReady {
  if (-not (Test-NgtPortOwnership 55432)) { return $false }
  $readyFile = Join-Path $projectRoot ".local\database-ready.pid"
  $pidFile = Join-Path $stateDirectory "database.pid"
  if (-not (Test-Path -LiteralPath $readyFile -PathType Leaf) -or
      -not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $false }
  [int]$readyProcessId = 0
  [int]$databaseProcessId = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $readyFile -Raw).Trim(), [ref]$readyProcessId) -or
      -not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$databaseProcessId)) { return $false }
  $databaseProcess = Get-NgtStudioProcess -ProcessId $databaseProcessId
  return $readyProcessId -eq $databaseProcessId -and
    (Test-NgtStudioDatabaseLauncherProcess `
      -Process $databaseProcess -ReleaseRoot $projectRoot `
      -AllowedNodePaths (Get-NgtStudioNodePaths -ReleaseRoot $projectRoot -InstallRoot $installRoot) `
      -ActiveRelease $projectRoot -SupervisorId $PID)
}

function Wait-NgtDatabaseReady {
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-NgtDatabaseReady) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Database did not finish initialization before application startup."
}

function Test-NgtServicePortReady([int]$Port) {
  if ($Port -eq 55432) { return Test-NgtDatabaseReady }
  if ($Port -eq 3000) { return Test-NgtApplicationReady }
  throw "NGT service does not manage listener port $Port."
}

function Start-NgtProcess(
  [string]$Name,
  [string]$Script,
  [int]$Port
) {
  if (Test-NgtPortOwnership $Port) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
      if (-not (Test-NgtPortOwnership $Port)) { break }
      if (Test-NgtServicePortReady $Port) { return }
      Start-Sleep -Milliseconds 250
    }
    if (Test-NgtPortOwnership $Port) {
      throw "$Name has a verified active-release listener that did not become ready; it was left running."
    }
  }

  $stdoutPath = Join-Path $stateDirectory ($Name + ".log")
  $stderrPath = Join-Path $stateDirectory ($Name + ".error.log")
  $startOptions = @{
    FilePath = $nodeExecutable
    ArgumentList = $Script
    WorkingDirectory = $projectRoot
    RedirectStandardOutput = $stdoutPath
    RedirectStandardError = $stderrPath
    WindowStyle = "Hidden"
    PassThru = $true
  }
  $process = Start-Process @startOptions
  Set-Content -LiteralPath (Join-Path $stateDirectory ($Name + ".pid")) -Value $process.Id -Encoding ascii

  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-NgtPortOwnership $Port) {
      if (Test-NgtServicePortReady $Port) { return }
    }
    if ($process.HasExited) {
      throw ($Name + " exited before port " + $Port + " was ready.")
    }
    Start-Sleep -Milliseconds 250
  }
  throw ($Name + " did not open port " + $Port + " in time.")
}

function Test-NgtApplicationReady {
  if (-not (Test-NgtPortOwnership 3000)) { return $false }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5
    return [string]$health.status -eq "ok" -and
      [string]$health.currentVersion -eq $expectedVersion -and
      [string]$health.buildCommit -ieq $expectedCommit
  } catch {
    return $false
  }
}

while ($true) {
  try {
    Start-NgtProcess -Name "database" `
      -Script (Join-Path $projectRoot "scripts\windows-db.mjs") -Port 55432
    Wait-NgtDatabaseReady
    Start-NgtProcess -Name "application" `
      -Script (Join-Path $projectRoot "scripts\start.mjs") -Port 3000
  } catch {
    $line = (Get-Date -Format o) + " " + $_.Exception.Message
    Add-Content -LiteralPath (Join-Path $stateDirectory "supervisor.error.log") -Value $line
  }
  Start-Sleep -Seconds 5
}
