$ErrorActionPreference = "Stop"

$script:NgtTaskName = "NGT Management System"
$script:NgtProjectRoot = Split-Path -Parent $PSScriptRoot
$script:NgtStateDirectory = Join-Path $script:NgtProjectRoot ".local"

function Assert-NgtCommand([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command is not installed: $Name"
  }
}

function Invoke-NgtCommand([string]$Name, [string[]]$Arguments) {
  & $Name @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE."
  }
}

function Get-NgtNodeExecutable {
  $releaseNode = Join-Path $script:NgtProjectRoot "runtime\node.exe"
  if (Test-Path -LiteralPath $releaseNode) {
    return $releaseNode
  }
  $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $bundledNode) {
    return $bundledNode
  }
  return (Get-Command node -ErrorAction Stop).Source
}

function Get-NgtGitHubCli {
  $releaseCli = Join-Path $script:NgtProjectRoot "runtime\gh.exe"
  if (Test-Path -LiteralPath $releaseCli) {
    return $releaseCli
  }
  return (Get-Command gh -ErrorAction Stop).Source
}

function Set-NgtStudioEnvironment {
  $configPath = Join-Path $script:NgtStateDirectory "studio.json"
  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Studio mode is not installed. Run scripts/install-windows-studio.ps1 first."
  }
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if (-not $config.dataRoot) {
    throw "Studio configuration is missing dataRoot."
  }
  $env:NGT_DATA_ROOT = [System.IO.Path]::GetFullPath([string]$config.dataRoot)
  return $config
}

function Set-NgtStudioConfig([string]$Path, [object]$Configuration) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  New-Item -ItemType Directory -Path (Split-Path -Parent $fullPath) -Force | Out-Null
  $temporaryPath = "$fullPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  $backupPath = "$fullPath.$PID.$([guid]::NewGuid().ToString('N')).bak"
  $json = $Configuration | ConvertTo-Json -Depth 8
  try {
    [System.IO.File]::WriteAllText(
      $temporaryPath,
      $json,
      (New-Object System.Text.UTF8Encoding($false))
    )
    if (Test-Path -LiteralPath $fullPath) {
      [System.IO.File]::Replace($temporaryPath, $fullPath, $backupPath)
    } else {
      [System.IO.File]::Move($temporaryPath, $fullPath)
    }
    $written = [System.IO.File]::ReadAllText($fullPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ([string]$written.activeRelease -ne [string]$Configuration.activeRelease -or
        [string]$written.dataRoot -ne [string]$Configuration.dataRoot -or
        [string]$written.installRoot -ne [string]$Configuration.installRoot) {
      throw "The active studio configuration could not be verified after writing."
    }
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  }
}

function Wait-NgtPort([int]$Port, [bool]$Open) {
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    $listening = [bool](Get-NgtStudioPortConnections -Port $Port)
    if ($listening -eq $Open) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
  $expected = if ($Open) { "open" } else { "close" }
  throw "Port $Port did not $expected in time."
}

function Get-NgtStudioPortConnections([int]$Port) {
  try {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
  } catch {
    if ($_.FullyQualifiedErrorId -like "CmdletizationQuery_NotFound,*") {
      return @()
    }
    throw
  }
}

function Get-NgtStudioProcess([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  return Get-CimInstance -ClassName Win32_Process `
    -Filter ("ProcessId = " + $ProcessId) -ErrorAction SilentlyContinue
}

function Test-NgtStudioPathEquals([string]$Actual, [string]$Expected) {
  if (-not $Actual -or -not $Expected) { return $false }
  try {
    return [System.IO.Path]::GetFullPath($Actual.Trim('"')) -ieq `
      [System.IO.Path]::GetFullPath($Expected.Trim('"'))
  } catch {
    return $false
  }
}

function Test-NgtStudioProcessTree([int]$ProcessId, [int]$AncestorId) {
  $visited = @{}
  $currentId = $ProcessId
  while ($currentId -gt 0 -and -not $visited.ContainsKey($currentId)) {
    if ($currentId -eq $AncestorId) { return $true }
    $visited[$currentId] = $true
    $process = Get-NgtStudioProcess -ProcessId $currentId
    if (-not $process) { return $false }
    $currentId = [int]$process.ParentProcessId
  }
  return $false
}

function Test-NgtStudioApplicationProcess(
  [object]$Process,
  [string]$ReleaseRoot,
  [string[]]$AllowedNodePaths,
  [string]$ActiveRelease = "",
  [int]$SupervisorId = 0
) {
  if (-not $Process -or $Process.Name -ine "node.exe") { return $false }
  if (-not ($AllowedNodePaths | Where-Object {
    Test-NgtStudioPathEquals -Actual ([string]$Process.ExecutablePath) -Expected $_
  })) { return $false }
  $startScript = Join-Path ([System.IO.Path]::GetFullPath($ReleaseRoot)) "scripts\start.mjs"
  if (([string]$Process.CommandLine).IndexOf(
    $startScript,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -ge 0) { return $true }
  return (
    $SupervisorId -gt 0 -and
    (Test-NgtStudioPathEquals -Actual $ReleaseRoot -Expected $ActiveRelease) -and
    [string]$Process.CommandLine -match '(?i)(^|\s)"?scripts[\\/]start\.mjs"?(\s|$)' -and
    (Test-NgtStudioProcessTree -ProcessId ([int]$Process.ProcessId) -AncestorId $SupervisorId)
  )
}

function Test-NgtStudioDatabaseLauncherProcess(
  [object]$Process,
  [string]$ReleaseRoot,
  [string[]]$AllowedNodePaths,
  [string]$ActiveRelease,
  [int]$SupervisorId
) {
  if (-not $Process -or $Process.Name -ine "node.exe") { return $false }
  if (-not ($AllowedNodePaths | Where-Object {
    Test-NgtStudioPathEquals -Actual ([string]$Process.ExecutablePath) -Expected $_
  })) { return $false }
  $databaseScript = Join-Path ([System.IO.Path]::GetFullPath($ReleaseRoot)) "scripts\windows-db.mjs"
  if (([string]$Process.CommandLine).IndexOf(
    $databaseScript,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -ge 0) { return $true }
  return (
    $SupervisorId -gt 0 -and
    (Test-NgtStudioPathEquals -Actual $ReleaseRoot -Expected $ActiveRelease) -and
    [string]$Process.CommandLine -match '(?i)(^|\s)"?scripts[\\/]windows-db\.mjs"?(\s|$)' -and
    (Test-NgtStudioProcessTree -ProcessId ([int]$Process.ProcessId) -AncestorId $SupervisorId)
  )
}

function Test-NgtStudioApplicationListenerProcess(
  [object]$Process,
  [object]$ApplicationProcess
) {
  if (-not $Process -or -not $ApplicationProcess -or $Process.Name -ine "node.exe") {
    return $false
  }
  if (-not (Test-NgtStudioPathEquals `
    -Actual ([string]$Process.ExecutablePath) `
    -Expected ([string]$ApplicationProcess.ExecutablePath))) {
    return $false
  }
  if ([int]$Process.ProcessId -eq [int]$ApplicationProcess.ProcessId) { return $true }
  return [string]$Process.CommandLine -match '(?i)\.next[\\/]standalone[\\/]server\.js'
}

function Get-NgtStudioNodePaths([string]$ReleaseRoot, [string]$InstallRoot) {
  $paths = @(
    (Join-Path $ReleaseRoot "runtime\node.exe"),
    (Join-Path $InstallRoot "runtime\node.exe"),
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
  )
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $paths += $nodeCommand.Source }
  return @($paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
}

function Test-NgtStudioPostgresProcess(
  [object]$Process,
  [string]$RuntimeRoot,
  [string]$DataDirectory
) {
  if (-not $Process -or $Process.Name -ine "postgres.exe") { return $false }
  $postgresExe = Join-Path $RuntimeRoot "bin\postgres.exe"
  if (-not (Test-NgtStudioPathEquals -Actual ([string]$Process.ExecutablePath) -Expected $postgresExe)) {
    return $false
  }
  $commandLine = [string]$Process.CommandLine
  $dataArguments = [regex]::Matches(
    $commandLine,
    '(?i)(?:^|\s)-D\s+(?:"([^"]+)"|(\S+))'
  )
  $expectedData = [System.IO.Path]::GetFullPath($DataDirectory)
  foreach ($argument in $dataArguments) {
    $actualData = if ($argument.Groups[1].Success) {
      $argument.Groups[1].Value
    } else {
      $argument.Groups[2].Value
    }
    if (Test-NgtStudioPathEquals -Actual $actualData -Expected $expectedData) {
      return $true
    }
  }
  return $false
}

function Test-NgtStudioSupervisorProcess([object]$Process, [string]$ServiceScript) {
  if (-not $Process -or $Process.Name -notin @("powershell.exe", "pwsh.exe")) {
    return $false
  }
  $expectedName = [System.IO.Path]::GetFileName($ServiceScript)
  if ($expectedName -ine "windows-service.ps1") { return $false }
  return ([string]$Process.CommandLine).IndexOf(
    [System.IO.Path]::GetFullPath($ServiceScript),
    [System.StringComparison]::OrdinalIgnoreCase
  ) -ge 0
}

function Test-NgtStudioScheduledTask(
  [object]$Task,
  [string]$LauncherPath
) {
  if (-not $Task) { return $false }
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) { return $false }
  $expectedWscript = Join-Path $env:WINDIR "System32\wscript.exe"
  $expectedLauncher = [System.IO.Path]::GetFullPath($LauncherPath)
  $actualArguments = ([string]$actions[0].Arguments).Trim()
  return (
    (Test-NgtStudioPathEquals -Actual ([string]$actions[0].Execute) -Expected $expectedWscript) -and
    ($actualArguments -ieq ('//B //Nologo "' + $expectedLauncher + '"') -or
      $actualArguments -ieq ('"' + $expectedLauncher + '"'))
  )
}

function Stop-NgtStudioProcessIfUnchanged([object]$Process) {
  $current = Get-NgtStudioProcess -ProcessId ([int]$Process.ProcessId)
  if (-not $current) { return }
  if ([string]$current.CreationDate -ne [string]$Process.CreationDate -or
      [string]$current.ExecutablePath -ine [string]$Process.ExecutablePath -or
      [string]$current.CommandLine -cne [string]$Process.CommandLine) {
    throw "Process $($Process.ProcessId) changed identity before it could be stopped."
  }
  Stop-Process -Id ([int]$Process.ProcessId) -Force -ErrorAction Stop
}

function Stop-NgtStudioProcesses {
  $studioConfigFile = Join-Path $script:NgtStateDirectory "studio.json"
  if (-not (Test-Path -LiteralPath $studioConfigFile)) {
    $configuredInstallRoot = if ($InstallRoot) {
      [string]$InstallRoot
    } else {
      Join-Path $env:LOCALAPPDATA "NGT"
    }
    $studioConfigFile = Join-Path $configuredInstallRoot ".local\studio.json"
  }
  if (-not (Test-Path -LiteralPath $studioConfigFile)) {
    throw "Studio configuration is missing; refusing to stop unverified processes."
  }
  $studioConfig = Get-Content -LiteralPath $studioConfigFile -Raw | ConvertFrom-Json
  if (-not $studioConfig.installRoot -or -not $studioConfig.dataRoot -or -not $studioConfig.activeRelease) {
    throw "Studio configuration is incomplete; refusing to stop unverified processes."
  }
  $installRoot = [System.IO.Path]::GetFullPath([string]$studioConfig.installRoot)
  $dataRoot = [System.IO.Path]::GetFullPath([string]$studioConfig.dataRoot)
  $dataDirectory = Join-Path $dataRoot "data"
  $activeRelease = [System.IO.Path]::GetFullPath([string]$studioConfig.activeRelease)
  $releaseRoots = @($activeRelease, $script:NgtProjectRoot)
  $installedReleases = Join-Path $installRoot "releases"
  if (Test-Path -LiteralPath $installedReleases) {
    $releaseRoots += @(Get-ChildItem -LiteralPath $installedReleases -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName })
  }
  $releaseRoots = @($releaseRoots | Where-Object { $_ } | Select-Object -Unique)
  $stateDirectories = @(
    $script:NgtStateDirectory,
    (Join-Path $installRoot ".local")
  ) + @($releaseRoots | ForEach-Object { Join-Path $_ ".local" })
  $stateDirectories = @($stateDirectories | Select-Object -Unique)

  $verifiedSupervisorId = 0
  $supervisorProcess = $null
  $supervisorPath = Join-Path $installRoot ".local\supervisor.pid"
  if (Test-Path -LiteralPath $supervisorPath) {
    [int]$supervisorId = 0
    $supervisorText = (Get-Content -LiteralPath $supervisorPath -Raw).Trim()
    if ([int]::TryParse($supervisorText, [ref]$supervisorId)) {
      $supervisor = Get-NgtStudioProcess -ProcessId $supervisorId
      $serviceScript = Join-Path $installRoot "service\windows-service.ps1"
      if (Test-NgtStudioSupervisorProcess -Process $supervisor -ServiceScript $serviceScript) {
        $verifiedSupervisorId = $supervisorId
        $supervisorProcess = $supervisor
      }
    }
  }

  $applicationStateDirectories = @((Join-Path $installRoot ".local")) + @(
    $releaseRoots | ForEach-Object { Join-Path $_ ".local" }
  )
  $verifiedApplicationListeners = @{}
  foreach ($connection in (Get-NgtStudioPortConnections -Port 3000)) {
    $listenerId = [int]$connection.OwningProcess
    $listener = Get-NgtStudioProcess -ProcessId $listenerId
    if (-not $listener) {
      if (-not (Get-NgtStudioPortConnections -Port 3000 | Where-Object { $_.OwningProcess -eq $listenerId })) {
        continue
      }
    }
    $owned = $false
    foreach ($stateDirectory in $applicationStateDirectories) {
      $pidFile = Join-Path $stateDirectory "application.pid"
      if (-not (Test-Path -LiteralPath $pidFile)) { continue }
      [int]$applicationId = 0
      if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$applicationId)) {
        continue
      }
      $application = Get-NgtStudioProcess -ProcessId $applicationId
      foreach ($releaseRoot in $releaseRoots) {
        $nodePaths = Get-NgtStudioNodePaths -ReleaseRoot $releaseRoot -InstallRoot $installRoot
        if ((Test-NgtStudioApplicationProcess `
          -Process $application `
          -ReleaseRoot $releaseRoot `
          -AllowedNodePaths $nodePaths `
          -ActiveRelease $activeRelease `
          -SupervisorId $verifiedSupervisorId) -and
            (Test-NgtStudioProcessTree -ProcessId $listenerId -AncestorId $applicationId) -and
            (Test-NgtStudioApplicationListenerProcess -Process $listener -ApplicationProcess $application)) {
          $owned = $true
          break
        }
      }
      if ($owned) { break }
    }
    if (-not $owned) {
      $name = if ($listener) { [string]$listener.Name } else { "unknown process" }
      $executable = if ($listener) { [string]$listener.ExecutablePath } else { "executable unavailable" }
      throw "Port 3000 is occupied by unverified PID $listenerId ($name, $executable); it was left running."
    }
    $verifiedApplicationListeners[$listenerId] = $listener
  }

  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    $task = Get-ScheduledTask -TaskName $script:NgtTaskName -ErrorAction SilentlyContinue
    if ($task) {
      $launcherPath = Join-Path $installRoot "service\windows-studio-launcher.vbs"
      if (-not (Test-NgtStudioScheduledTask -Task $task -LauncherPath $launcherPath)) {
        throw "The NGT startup task has an unexpected action; refusing to stop it."
      }
      Stop-ScheduledTask -TaskName $script:NgtTaskName -ErrorAction Stop
    }
  }
  if ($supervisorProcess) {
    Stop-NgtStudioProcessIfUnchanged -Process $supervisorProcess
  }

  $stoppedDatabasePaths = @{}
  foreach ($stateDirectory in $stateDirectories) {
    $databaseLocation = Join-Path $stateDirectory "database-location.txt"
    $runtimeLocation = Join-Path $stateDirectory "database-runtime-location.txt"
    if (-not (Test-Path -LiteralPath $databaseLocation) -or
        -not (Test-Path -LiteralPath $runtimeLocation)) { continue }
    $recordedData = [System.IO.Path]::GetFullPath((Get-Content -LiteralPath $databaseLocation -Raw).Trim())
    if (-not (Test-NgtStudioPathEquals -Actual $recordedData -Expected $dataDirectory)) { continue }
    $databaseKey = $recordedData.ToLowerInvariant()
    if ($stoppedDatabasePaths.ContainsKey($databaseKey)) { continue }
    $stoppedDatabasePaths[$databaseKey] = $true
    $runtime = [System.IO.Path]::GetFullPath((Get-Content -LiteralPath $runtimeLocation -Raw).Trim())
    $pgCtl = Join-Path $runtime "bin\pg_ctl.exe"
    $postmasterPid = Join-Path $recordedData "postmaster.pid"
    if (Test-Path -LiteralPath $pgCtl) {
      if (Test-Path -LiteralPath $postmasterPid -PathType Leaf) {
        & $pgCtl -D $recordedData -m fast stop 2>$null
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "The recorded NGT database did not stop cleanly; verifying its listener identity."
        }
      }
    }
  }

  foreach ($stateDirectory in $applicationStateDirectories) {
    $pidFile = Join-Path $stateDirectory "database.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { continue }
    [int]$databaseRootId = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$databaseRootId)) {
      continue
    }
    $databaseRoot = Get-NgtStudioProcess -ProcessId $databaseRootId
    if (-not $databaseRoot) { continue }
    foreach ($releaseRoot in $releaseRoots) {
      $nodePaths = Get-NgtStudioNodePaths -ReleaseRoot $releaseRoot -InstallRoot $installRoot
      if (Test-NgtStudioDatabaseLauncherProcess `
        -Process $databaseRoot `
        -ReleaseRoot $releaseRoot `
        -AllowedNodePaths $nodePaths `
        -ActiveRelease $activeRelease `
        -SupervisorId $verifiedSupervisorId) {
        Stop-NgtStudioProcessIfUnchanged -Process $databaseRoot
        break
      }
    }
  }

  foreach ($listener in $verifiedApplicationListeners.Values) {
    Stop-NgtStudioProcessIfUnchanged -Process $listener
  }
  foreach ($connection in (Get-NgtStudioPortConnections -Port 3000)) {
    $listenerId = [int]$connection.OwningProcess
    if (-not $verifiedApplicationListeners.ContainsKey($listenerId)) {
      $listener = Get-NgtStudioProcess -ProcessId $listenerId
      $name = if ($listener) { [string]$listener.Name } else { "unknown process" }
      $executable = if ($listener) { [string]$listener.ExecutablePath } else { "executable unavailable" }
      throw "Port 3000 is occupied by unverified PID $listenerId ($name, $executable); it was left running."
    }
  }

  foreach ($connection in (Get-NgtStudioPortConnections -Port 55432)) {
    $databaseId = [int]$connection.OwningProcess
    $databaseProcess = Get-NgtStudioProcess -ProcessId $databaseId
    if (-not $databaseProcess) {
      if (-not (Get-NgtStudioPortConnections -Port 55432 | Where-Object { $_.OwningProcess -eq $databaseId })) {
        continue
      }
    }
    $owned = $false
    foreach ($stateDirectory in $stateDirectories) {
      $databaseLocation = Join-Path $stateDirectory "database-location.txt"
      $runtimeLocation = Join-Path $stateDirectory "database-runtime-location.txt"
      if (-not (Test-Path -LiteralPath $databaseLocation) -or
          -not (Test-Path -LiteralPath $runtimeLocation)) { continue }
      $recordedData = [System.IO.Path]::GetFullPath((Get-Content -LiteralPath $databaseLocation -Raw).Trim())
      if (-not (Test-NgtStudioPathEquals -Actual $recordedData -Expected $dataDirectory)) { continue }
      $runtime = [System.IO.Path]::GetFullPath((Get-Content -LiteralPath $runtimeLocation -Raw).Trim())
      foreach ($databaseStateDirectory in $applicationStateDirectories) {
        $pidFile = Join-Path $databaseStateDirectory "database.pid"
        if (-not (Test-Path -LiteralPath $pidFile)) { continue }
        [int]$databaseRootId = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$databaseRootId)) {
          continue
        }
        $databaseRoot = Get-NgtStudioProcess -ProcessId $databaseRootId
        foreach ($releaseRoot in $releaseRoots) {
          $nodePaths = Get-NgtStudioNodePaths -ReleaseRoot $releaseRoot -InstallRoot $installRoot
          if ((Test-NgtStudioDatabaseLauncherProcess `
            -Process $databaseRoot `
            -ReleaseRoot $releaseRoot `
            -AllowedNodePaths $nodePaths `
            -ActiveRelease $activeRelease `
            -SupervisorId $verifiedSupervisorId) -and
              (Test-NgtStudioProcessTree -ProcessId $databaseId -AncestorId $databaseRootId) -and
              (Test-NgtStudioPostgresProcess -Process $databaseProcess -RuntimeRoot $runtime -DataDirectory $recordedData)) {
            $owned = $true
            break
          }
        }
        if ($owned) { break }
      }
      if ($owned) { break }
    }
    if (-not $owned) {
      $name = if ($databaseProcess) { [string]$databaseProcess.Name } else { "unknown process" }
      $executable = if ($databaseProcess) { [string]$databaseProcess.ExecutablePath } else { "executable unavailable" }
      throw "Port 55432 is occupied by unverified PID $databaseId ($name, $executable); it was left running."
    }
    Stop-NgtStudioProcessIfUnchanged -Process $databaseProcess
  }

  Wait-NgtPort -Port 3000 -Open $false
  Wait-NgtPort -Port 55432 -Open $false
}

function Start-NgtStudioDatabase {
  if (Get-NgtStudioPortConnections -Port 55432) {
    throw "Port 55432 is already in use; refusing to replace an unverified database process."
  }
  New-Item -ItemType Directory -Path $script:NgtStateDirectory -Force | Out-Null
  $nodeExecutable = Get-NgtNodeExecutable
  $outputLog = Join-Path $script:NgtStateDirectory "studio-database.log"
  $errorLog = Join-Path $script:NgtStateDirectory "studio-database.error.log"
  $readyFile = Join-Path $script:NgtStateDirectory "database-ready.pid"
  Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $nodeExecutable `
    -ArgumentList (Join-Path $script:NgtProjectRoot "scripts\windows-db.mjs") `
    -WorkingDirectory $script:NgtProjectRoot `
    -RedirectStandardOutput $outputLog `
    -RedirectStandardError $errorLog `
    -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath (Join-Path $script:NgtStateDirectory "database.pid") `
    -Value $process.Id -Encoding ascii
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-Path -LiteralPath $readyFile) {
      $readyProcessId = [string](Get-Content -LiteralPath $readyFile -Raw -ErrorAction SilentlyContinue)
      if ($readyProcessId.Trim() -eq [string]$process.Id) {
        return
      }
    }
    if ($process.HasExited) {
      $process.WaitForExit()
      $process.Refresh()
      $exitCode = if ($null -eq $process.ExitCode) { "unknown" } else { [string]$process.ExitCode }
      $details = @($outputLog, $errorLog) | ForEach-Object {
        $content = Get-Content -LiteralPath $_ -Raw -ErrorAction SilentlyContinue
        if ($content) { $content.Trim() }
      }
      if ($details) {
        throw "Database initialization failed with exit code ${exitCode}:`n$($details -join "`n")"
      }
      throw "Database initialization failed with exit code ${exitCode}."
    }
    Start-Sleep -Milliseconds 250
  }
  $details = @($outputLog, $errorLog) | ForEach-Object {
    $content = Get-Content -LiteralPath $_ -Raw -ErrorAction SilentlyContinue
    if ($content) { $content.Trim() }
  }
  if ($details) {
    throw "Database did not become ready in time:`n$($details -join "`n")"
  }
  throw "Database did not become ready in time."
}

function Start-NgtStudioTask {
  $task = Get-ScheduledTask -TaskName $script:NgtTaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    throw "Windows startup task is not installed."
  }
  Start-ScheduledTask -TaskName $script:NgtTaskName
}

function Wait-NgtStudioHealth([string]$ExpectedVersion = "") {
  $routes = @("http://127.0.0.1:3000/api/health", "http://127.0.0.1:3000/orders")
  foreach ($route in $routes) {
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      try {
        $response = Invoke-WebRequest -Uri $route -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) {
          if (($ExpectedVersion) -and ($route -like "*/api/health")) {
            $health = $response.Content | ConvertFrom-Json
            if ([string]$health.currentVersion -ne $ExpectedVersion) {
              Start-Sleep -Seconds 1
              continue
            }
          }
          $ready = $true
          break
        }
      } catch {
        Start-Sleep -Seconds 1
      }
    }
    if (-not $ready) {
      throw "Studio verification failed: $route did not return HTTP 200."
    }
  }
}
