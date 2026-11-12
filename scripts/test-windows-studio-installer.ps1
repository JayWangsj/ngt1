param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,
  [switch]$OnlineUpdateAcceptance,
  [switch]$ProductionUpdaterAcceptance,
  [string]$CandidateDirectory = "",
  [string]$AcceptanceUpdaterPath = ""
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

function Invoke-NgtBusinessDataProbe([string]$ReleaseRoot, [string]$Action, [string]$Code, [string]$SnapshotPath) {
  $probePath = Join-Path $PSScriptRoot "windows-studio-business-probe.cjs"
  $node = Join-Path $ReleaseRoot "runtime\node.exe"
  $client = Join-Path $ReleaseRoot ".next\standalone\node_modules\@prisma\client"
  & $node $probePath $Action (Join-Path $installRoot "state\application.env") $client $Code $SnapshotPath
  if ($LASTEXITCODE -ne 0) { throw "Isolated business database $Action probe failed." }
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

$installRoot = Join-Path $env:LOCALAPPDATA "NGTManager"
$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
if (Test-Path -LiteralPath $installRoot) {
  throw "The disposable user already has an NGTManager directory."
}
$runEntry = Get-ItemProperty -LiteralPath $runKeyPath -Name NGTManager -ErrorAction SilentlyContinue
if ($runEntry -and $runEntry.NGTManager) {
  throw "The disposable user already has an NGTManager startup entry."
}
foreach ($port in @(3000, 55432, 55433)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Installer acceptance port $port is already in use."
  }
}

$installationAttempted = $false
$cleanupSafe = $true
$cleanupProblems = New-Object 'System.Collections.Generic.List[string]'
$installerLog = Join-Path $env:RUNNER_TEMP "installer.log"
$managerLog = Join-Path $installRoot "logs\manager.log"
$previousTestApiUrl = $env:NGT_TEST_RELEASE_API_URL
$updateServerProcess = $null
$managerUninstallFailure = $null
$businessSnapshotPath = Join-Path $env:RUNNER_TEMP "ngt-manager-online-update-business.json"
try {
  if ($OnlineUpdateAcceptance -and $ProductionUpdaterAcceptance) {
    throw "Online-update and production-updater acceptance modes are mutually exclusive."
  }
  if ($OnlineUpdateAcceptance -or $ProductionUpdaterAcceptance) {
    if (-not $CandidateDirectory) {
      throw "Update acceptance requires the verified candidate directory."
    }
    if ($OnlineUpdateAcceptance -and -not (Test-Path -LiteralPath $AcceptanceUpdaterPath -PathType Leaf)) {
      throw "Online-update acceptance requires the acceptance updater."
    }
    $manifestPath = Join-Path $CandidateDirectory "release-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      throw "Online-update acceptance is missing the verified candidate manifest."
    }
    $candidateManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($candidateManifest.version -ne $ExpectedVersion -or
        $candidateManifest.sha -ine $env:GITHUB_SHA -or
        $candidateManifest.tag -ne "v$ExpectedVersion") {
      throw "Online-update acceptance candidate does not match the expected version and commit."
    }
    foreach ($asset in $candidateManifest.assets) {
      $assetPath = Join-Path $CandidateDirectory ([string]$asset.name)
      if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf) -or
          (Get-Item -LiteralPath $assetPath).Length -ne [long]$asset.size -or
          (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$asset.sha256) {
        throw "Online-update candidate asset failed exact-SHA verification: $($asset.name)"
      }
    }
  }
  $installationAttempted = $true
  Write-Output "Starting the verified Windows installer; progress will be reported from its install logs."
  $installer = Start-Process -FilePath $installerPath `
    -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=$installerLog") `
    -WindowStyle Hidden -PassThru
  Wait-NgtInstallerProcess -Process $installer -Description "Windows installer" `
    -TimeoutMinutes 30 -ProgressPaths @($installerLog, $managerLog)
  if ($installer.ExitCode -ne 0) {
    throw "The Windows installer exited with code $($installer.ExitCode)."
  }

  $configurationPath = Join-Path $installRoot "state\studio.json"
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
  if ([System.IO.Path]::GetFullPath([string]$configuration.installRoot) -ne [System.IO.Path]::GetFullPath($installRoot) -or
      [System.IO.Path]::GetFullPath([string]$configuration.dataRoot) -ne [System.IO.Path]::GetFullPath((Join-Path $installRoot "data"))) {
    throw "The installed manager configuration points outside the per-user NGTManager directories."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $releaseRoot "runtime\node.exe"))) {
    throw "The installed release is missing its verified Node runtime."
  }
  $managerPath = Join-Path $installRoot "tools\NGTManager.exe"
  $statusResult = (& $managerPath status 2>&1 | Out-String).Trim()
  $statusExitCode = $LASTEXITCODE
  if ($statusExitCode -ne 0) {
    throw "NGTManager status failed with exit code $statusExitCode."
  }
  if ([string]::IsNullOrWhiteSpace($statusResult)) {
    throw "NGTManager returned an empty status result."
  }
  $managerStatus = $statusResult | ConvertFrom-Json
  if (-not $managerStatus.installed -or
      $managerStatus.transactionStage -ne "Committed" -or
      [string]$managerStatus.version -ne [string]$metadata.version) {
    throw "NGTManager did not report a committed installation of the verified release."
  }
  $runEntry = Get-ItemProperty -LiteralPath $runKeyPath -Name NGTManager -ErrorAction SilentlyContinue
  if (-not $runEntry -or $runEntry.NGTManager -notmatch 'NGTManager\.exe" run$') {
    throw "NGTManager did not register direct per-user startup."
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

  if ($OnlineUpdateAcceptance -or $ProductionUpdaterAcceptance) {
    if ($OnlineUpdateAcceptance) {
      $updateServer = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
      $updateServer.Start()
      $updatePort = [int]$updateServer.LocalEndpoint.Port
      $updateServer.Stop()
      $serverScript = Join-Path $PSScriptRoot "windows-studio-updater-acceptance-server.cjs"
      $serverLog = Join-Path $env:RUNNER_TEMP "ngt-candidate-api.log"
      $serverArguments = '"{0}" "{1}" {2}' -f $CandidateDirectory, $manifestPath, $updatePort
      $updateServerProcess = Start-Process -FilePath (Get-Command node.exe -ErrorAction Stop).Source `
        -ArgumentList ('"{0}" {1}' -f $serverScript, $serverArguments) `
        -WorkingDirectory $env:GITHUB_WORKSPACE -RedirectStandardOutput $serverLog `
        -RedirectStandardError ($serverLog + ".error") -WindowStyle Hidden -PassThru
      $env:NGT_TEST_RELEASE_API_URL = "http://127.0.0.1:$updatePort"
      $serverReady = $false
      $serverDeadline = [DateTime]::UtcNow.AddSeconds(15)
      do {
        try {
          Invoke-RestMethod -Uri ($env:NGT_TEST_RELEASE_API_URL + "/health") -TimeoutSec 1 | Out-Null
          $serverReady = $true
          break
        } catch { }
        if ($updateServerProcess.HasExited) { throw "The exact-SHA candidate API server exited during startup." }
        Start-Sleep -Milliseconds 200
      } while ([DateTime]::UtcNow -lt $serverDeadline)
      if (-not $serverReady) { throw "The exact-SHA candidate API server did not become ready." }
    } else {
      $releaseTag = "v$ExpectedVersion"
      $ghPath = (Get-Command gh.exe -ErrorAction Stop).Source
      $releaseOutput = & $ghPath release view $releaseTag --repo "JayWangsj/ngt1" --json tagName,isDraft,assets,body
      if ($LASTEXITCODE -ne 0) { throw "The exact candidate Draft Release is not readable through the isolated GitHub CLI credentials." }
      $release = ($releaseOutput | Out-String) | ConvertFrom-Json
      $expectedMarker = "<!-- ngt-release-build:v1 tag=$releaseTag sha=$env:GITHUB_SHA version=$ExpectedVersion identity=$($candidateManifest.buildIdentity) -->"
      if ($release.tagName -cne $releaseTag -or -not $release.isDraft -or
          -not ([string]$release.body).Contains($expectedMarker)) {
        throw "Production updater acceptance requires the exact candidate to remain a Draft Release."
      }
      $expectedAssets = @($candidateManifest.assets | ForEach-Object name | Sort-Object)
      $releaseAssets = @($release.assets | ForEach-Object name | Sort-Object)
      if (Compare-Object -ReferenceObject $expectedAssets -DifferenceObject $releaseAssets) {
        throw "The authenticated Draft Release asset inventory does not match the exact candidate."
      }
      foreach ($asset in $candidateManifest.assets) {
        $remote = @($release.assets | Where-Object name -eq $asset.name)
        if ($remote.Count -ne 1 -or [long]$remote[0].size -ne [long]$asset.size) {
          throw "The authenticated Draft Release asset size is incorrect: $($asset.name)"
        }
        if ($remote[0].digest -and [string]$remote[0].digest -ine "sha256:$($asset.sha256)") {
          throw "The authenticated Draft Release asset digest is incorrect: $($asset.name)"
        }
      }
    }
    $managerPath = Join-Path $installRoot "tools\NGTManager.exe"
    $testBaselineVersion = "$ExpectedVersion-acceptance.0"
    $configuration.version = $testBaselineVersion
    [System.IO.File]::WriteAllText(
      $configurationPath,
      ($configuration | ConvertTo-Json -Depth 20) + "`n",
      [System.Text.UTF8Encoding]::new($false)
    )
    $metadata.version = $testBaselineVersion
    [System.IO.File]::WriteAllText(
      $metadataPath,
      ($metadata | ConvertTo-Json -Depth 100) + "`n",
      [System.Text.UTF8Encoding]::new($false)
    )
    if ($OnlineUpdateAcceptance) {
      Copy-Item -LiteralPath $AcceptanceUpdaterPath `
        -Destination (Join-Path $installRoot "tools\NGTUpdater.exe") -Force
    }

    $businessCode = "CI-UPDATE-" + [guid]::NewGuid().ToString("N")
    Invoke-NgtBusinessDataProbe -ReleaseRoot $releaseRoot -Action "seed" `
      -Code $businessCode -SnapshotPath $businessSnapshotPath

    $updateId = [guid]::NewGuid().ToString()
    $reserveOutput = & $managerPath reserve-update $updateId $ExpectedVersion 2>&1
    $reserveExitCode = $LASTEXITCODE
    $reserveText = (@($reserveOutput) -join "`n").Trim()
    $reserveStatus = $null
    try { $reserveStatus = $reserveText | ConvertFrom-Json } catch { }
    if ($reserveExitCode -ne 0 -or -not $reserveStatus -or
        $reserveStatus.updateId -ne $updateId -or
        $reserveStatus.targetVersion -ne $ExpectedVersion -or
        $reserveStatus.status -ne "starting") {
      $failureDetails = Protect-NgtAcceptanceDiagnosticText -Text $reserveText -Secrets $diagnosticSecrets
      $failureDetails = [regex]::Replace([string]$failureDetails, '[\r\n]+', ' ').Trim()
      if ($failureDetails.Length -gt 400) { $failureDetails = $failureDetails.Substring(0, 400) }
      if (-not $failureDetails) { $failureDetails = "no manager output" }
      throw "NGTManager could not reserve the exact-SHA online update (exit code $reserveExitCode; $failureDetails)."
    }
    $startOutput = & $managerPath start-update $updateId 2>&1
    $startExitCode = $LASTEXITCODE
    $startText = (@($startOutput) -join "`n").Trim()
    $startStatus = $null
    try { $startStatus = $startText | ConvertFrom-Json } catch { }
    if ($startExitCode -ne 0 -or -not $startStatus -or
        $startStatus.updateId -ne $updateId -or
        $startStatus.executorConfirmed -ne $true) {
      throw "NGTManager could not start the Rust online updater."
    }

    $updateStatusPath = Join-Path $installRoot "state\update-status.json"
    $updateDeadline = [DateTime]::UtcNow.AddMinutes(90)
    $updateStatus = $null
    do {
      if (Test-Path -LiteralPath $updateStatusPath -PathType Leaf) {
        try { $updateStatus = Get-Content -LiteralPath $updateStatusPath -Raw | ConvertFrom-Json } catch { }
      }
      if ($updateStatus -and $updateStatus.updateId -eq $updateId) {
        if ($updateStatus.status -eq "failed" -or $updateStatus.status -eq "interrupted") {
          throw "The Rust online updater failed at stage $($updateStatus.stage)."
        }
        if ($updateStatus.status -eq "complete") { break }
      }
      if ($updateServerProcess -and $updateServerProcess.HasExited) { throw "The exact-SHA candidate API server stopped during update acceptance." }
      Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $updateDeadline)
    if (-not $updateStatus -or $updateStatus.updateId -ne $updateId -or $updateStatus.status -ne "complete" -or
        $updateStatus.buildCommit -ine $env:GITHUB_SHA -or $updateStatus.actualVersion -ne $ExpectedVersion) {
      throw "The Rust online updater did not complete with the exact candidate version and commit."
    }

    $processDeadline = [DateTime]::UtcNow.AddMinutes(2)
    do {
      $processOutput = & $managerPath update-process $updateId 2>&1
      $processExitCode = $LASTEXITCODE
      $processText = (@($processOutput) -join "`n").Trim()
      $processResult = $null
      try { $processResult = $processText | ConvertFrom-Json } catch { }
      if ($processExitCode -ne 0 -or -not $processResult -or $null -eq $processResult.active) {
        throw "NGTManager could not inspect the online updater process lease."
      }
      $processActive = [bool]$processResult.active
      if (-not $processActive) { break }
      Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $processDeadline)
    if ($processActive) { throw "The Rust online updater did not release its process lease." }

    & $managerPath clear-update-lock $updateId complete 2>&1 | Out-Null
    $clearExitCode = $LASTEXITCODE
    if ($clearExitCode -ne 0) {
      throw "NGTManager could not release the completed update lock."
    }
    if (Test-Path -LiteralPath (Join-Path $installRoot "state\update.lock")) {
      throw "NGTManager left the online update lock after successful completion."
    }

    $configuration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
    $releaseRoot = [System.IO.Path]::GetFullPath([string]$configuration.activeRelease)
    $metadataPath = Join-Path $releaseRoot "studio-release.json"
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($configuration.version -ne $ExpectedVersion -or $metadata.version -ne $ExpectedVersion -or
        $metadata.commit -ine $env:GITHUB_SHA) {
      throw "The online updater activated a release with the wrong version or commit."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot "data\postgres\PG_VERSION")) -or
        @(Get-ChildItem -LiteralPath (Join-Path $installRoot "backups") -Directory -ErrorAction SilentlyContinue).Count -eq 0) {
      throw "The online update did not preserve the database and create an operation backup."
    }
    Invoke-NgtBusinessDataProbe -ReleaseRoot $releaseRoot -Action "verify" `
      -Code $businessCode -SnapshotPath $businessSnapshotPath
  } else {
    $releaseManagerPath = Join-Path $releaseRoot "tools\NGTManager.exe"
    $repairArguments = 'repair "{0}"' -f $releaseRoot
    $repair = Start-Process -FilePath $releaseManagerPath -ArgumentList $repairArguments `
      -WindowStyle Hidden -PassThru
    Wait-NgtInstallerProcess -Process $repair -Description "NGTManager repair" `
      -TimeoutMinutes 30 -ProgressPaths @($managerLog)
    if ($repair.ExitCode -ne 0) {
      throw "NGTManager could not repair the verified candidate package."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot "data\postgres\PG_VERSION")) -or
        @(Get-ChildItem -LiteralPath (Join-Path $installRoot "backups") -Directory -ErrorAction SilentlyContinue).Count -eq 0) {
      throw "NGTManager repair did not preserve the database and create a verified backup."
    }
  }

  & (Join-Path $PSScriptRoot "verify-windows-studio-runtime.ps1") `
    -ReleaseRoot $releaseRoot -ExpectedVersion ([string]$metadata.version) `
    -ExpectedCommit $env:GITHUB_SHA
  $uninstallStdoutPath = Join-Path $env:RUNNER_TEMP ("ngt-manager-uninstall-" + [guid]::NewGuid().ToString("N") + ".stdout.log")
  $uninstallStderrPath = Join-Path $env:RUNNER_TEMP ("ngt-manager-uninstall-" + [guid]::NewGuid().ToString("N") + ".stderr.log")
  $managerUninstall = Start-Process -FilePath $managerPath -ArgumentList @("uninstall") `
    -WorkingDirectory $installRoot -RedirectStandardOutput $uninstallStdoutPath `
    -RedirectStandardError $uninstallStderrPath -WindowStyle Hidden -PassThru
  Wait-NgtInstallerProcess -Process $managerUninstall -Description "NGTManager safe-uninstall command" `
    -TimeoutMinutes 5 -ProgressPaths @($managerLog)
  if ($managerUninstall.ExitCode -ne 0) {
    $uninstallDetails = @(
      Get-Content -LiteralPath $uninstallStdoutPath -Raw -ErrorAction SilentlyContinue
      Get-Content -LiteralPath $uninstallStderrPath -Raw -ErrorAction SilentlyContinue
    ) -join "`n"
    $uninstallDetails = Protect-NgtAcceptanceDiagnosticText -Text $uninstallDetails -Secrets $diagnosticSecrets
    $uninstallDetails = [regex]::Replace($uninstallDetails, "[`r`n]+", " ").Trim()
    if ($uninstallDetails.Length -gt 400) { $uninstallDetails = $uninstallDetails.Substring(0, 400) }
    if ($uninstallDetails) {
      $managerUninstallFailure = "exit code $($managerUninstall.ExitCode): $uninstallDetails"
      throw "NGTManager safe-uninstall command failed with $managerUninstallFailure"
    }
    $managerUninstallFailure = "exit code $($managerUninstall.ExitCode), no diagnostic text"
    throw "NGTManager safe-uninstall command failed with $managerUninstallFailure"
  }

  Write-Output "NGTManager safe-uninstall command passed."
  Write-Output "Windows installer acceptance passed for v$($metadata.version)."
} catch {
  $primaryFailureMessage = Protect-NgtAcceptanceDiagnosticText -Text $_.Exception.Message -Secrets $diagnosticSecrets
  $primaryFailureMessage = [regex]::Replace([string]$primaryFailureMessage, '[\r\n]+', ' ').Trim()
  if ($primaryFailureMessage.Length -gt 400) { $primaryFailureMessage = $primaryFailureMessage.Substring(0, 400) }
  if ($primaryFailureMessage) { $cleanupProblems.Add("primary failure: $primaryFailureMessage") }
  try {
    $diagnosticSources = @(
      $installerLog,
      (Join-Path $installRoot "logs\manager.log"),
      (Join-Path $installRoot "logs\database.log"),
      (Join-Path $installRoot "logs\application.log")
    )
    $diagnosticSources += Join-Path $installRoot "state\update-status.json"
    $diagnosticSources += Join-Path $installRoot "state\runtime\candidate-run.json"
    $diagnosticSources += Join-Path $installRoot "state\runtime\run-state.json"
    $diagnosticSources += @(Get-ChildItem -LiteralPath (Join-Path $installRoot "logs") -File -Filter "update-*.log" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    if (Test-Path -LiteralPath $installerLog -PathType Leaf) {
      $attemptLog = Get-Content -LiteralPath $installerLog -Raw -ErrorAction SilentlyContinue
      $attemptMatch = [regex]::Match($attemptLog, 'NGTManager install attempt ID: (?<id>[A-Za-z0-9-]{1,64})')
      if ($attemptMatch.Success) {
        $documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
        $attemptDiagnostics = Join-Path $documents ("NGTManager-diagnostics-" + $attemptMatch.Groups["id"].Value + ".txt")
        if (Test-Path -LiteralPath $attemptDiagnostics -PathType Leaf) {
          $diagnosticSources += $attemptDiagnostics
        }
      }
    }
    $diagnosticSources += @(Get-ChildItem -LiteralPath (Join-Path $installRoot "logs") -File -Filter "migration-*.log" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    & (Join-Path $PSScriptRoot "write-windows-studio-diagnostics.ps1") `
      -Stage "installer-acceptance" -Tag ("v" + $ExpectedVersion) -Commit $env:GITHUB_SHA `
      -Version $ExpectedVersion -Message $_.Exception.Message -SourcePaths $diagnosticSources -EmitToConsole
  } catch {
    Write-Warning "Sanitized installer diagnostics could not be written."
  }
  throw
} finally {
  if ($updateServerProcess) {
    try {
      $updateServerProcess.Refresh()
      if (-not $updateServerProcess.HasExited) {
        $updateServerProcess.Kill()
        if (-not $updateServerProcess.WaitForExit(5000)) {
          throw "The candidate API server did not exit after cleanup."
        }
      }
    } catch {
      $cleanupSafe = $false
      $cleanupProblems.Add("online-update-api")
      Write-Warning ("Online-update acceptance API cleanup failed: " + $_.Exception.Message)
    }
  }
  if ($null -eq $previousTestApiUrl) { Remove-Item Env:\NGT_TEST_RELEASE_API_URL -ErrorAction SilentlyContinue }
  else { $env:NGT_TEST_RELEASE_API_URL = $previousTestApiUrl }
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
        if (-not (Test-Path -LiteralPath (Join-Path $installRoot "data\postgres\PG_VERSION")) -or
            -not (Test-Path -LiteralPath (Join-Path $installRoot "state\studio.json"))) {
          throw "The uninstaller did not retain the business database and manager state."
        }
        if (Get-ItemProperty -LiteralPath $runKeyPath -Name NGTManager -ErrorAction SilentlyContinue) {
          throw "The uninstaller left the per-user NGTManager startup entry registered."
        }
      } catch {
        $cleanupSafe = $false
        $cleanupMessage = [regex]::Replace([string]$_.Exception.Message, "[\r\n]+", " ")
        if (-not [string]::IsNullOrWhiteSpace([string]$uninstallerLog) -and
            (Test-Path -LiteralPath $uninstallerLog -PathType Leaf)) {
          try {
            $uninstallerLogTail = @(Get-Content -LiteralPath $uninstallerLog -Tail 8 -ErrorAction Stop) -join " | "
            $uninstallerLogTail = [regex]::Replace($uninstallerLogTail, "[\r\n]+", " ")
            if ($uninstallerLogTail.Length -gt 250) { $uninstallerLogTail = $uninstallerLogTail.Substring($uninstallerLogTail.Length - 250) }
            if ($uninstallerLogTail) { $cleanupMessage += "; log tail: $uninstallerLogTail" }
          } catch { $cleanupMessage += "; uninstaller log could not be read" }
        }
        if ($cleanupMessage.Length -gt 600) { $cleanupMessage = $cleanupMessage.Substring(0, 600) }
        $cleanupProblems.Add("uninstaller: $cleanupMessage")
        Write-Warning ("Installer acceptance cleanup failed: " + $cleanupMessage)
      }
    } elseif (Test-Path -LiteralPath (Join-Path $installRoot "state\studio.json")) {
      $cleanupSafe = $false
      $cleanupProblems.Add("missing-uninstaller")
      Write-Warning "Installer acceptance could not find its uninstaller; retained the isolated installation."
    }
  }
  if ($managerUninstallFailure) {
    $cleanupSafe = $false
    $cleanupProblems.Add("manager safe-uninstall: $managerUninstallFailure")
  }
  if ($cleanupSafe) {
    foreach ($port in @(3000, 55432, 55433)) {
      if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        $cleanupSafe = $false
        $cleanupProblems.Add("listener-port-$port")
        Write-Warning "Installer acceptance left port $port open; no process was stopped by the test cleanup."
      }
    }
  }
  if (-not $cleanupSafe) {
    $reason = if ($cleanupProblems.Count) { $cleanupProblems -join ", " } else { "unclassified" }
    throw "Windows installer acceptance cleanup could not be verified ($reason)."
  }
  if (Test-Path -LiteralPath $installRoot) {
    $expectedInstallRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "NGTManager"))
    if ([System.IO.Path]::GetFullPath($installRoot) -ne $expectedInstallRoot) {
      throw "Refusing to remove an unexpected installer acceptance directory."
    }
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(60)
    while (Test-Path -LiteralPath $installRoot) {
      try {
        Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction Stop
      } catch {
        if ([DateTime]::UtcNow -ge $cleanupDeadline) {
          throw "Unable to remove the isolated installer acceptance directory within 60 seconds."
        }
      }
      if (Test-Path -LiteralPath $installRoot) {
        if ([DateTime]::UtcNow -ge $cleanupDeadline) {
          throw "The isolated installer acceptance directory remains after cleanup."
        }
        Start-Sleep -Milliseconds 100
      }
    }
  }
}
