param(
  [string]$ArchivePath,
  [switch]$IntegrityOnly
)
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "windows-studio-common.ps1")
. (Join-Path $PSScriptRoot "windows-studio-release-metadata.ps1")
$package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
if (-not $ArchivePath) {
  $ArchivePath = Join-Path $projectRoot ("dist\ngt-studio-windows-v" + $package.version + ".zip")
}
$ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath)
if (-not (Test-Path -LiteralPath $ArchivePath)) {
  throw "Studio package is missing: $ArchivePath"
}
$archiveEntries = @(& tar.exe -tf $ArchivePath)
if ($LASTEXITCODE -ne 0) { throw "Studio package archive inventory could not be read." }
$normalizedArchiveEntries = @($archiveEntries | ForEach-Object {
  ([string]$_).Replace("\", "/").TrimStart([char[]]@('.', '/'))
})
$archiveUpdaterExecutables = @($normalizedArchiveEntries | Where-Object { $_ -match '(?i)(^|/)NGTUpdater\.exe$' })
if ($archiveUpdaterExecutables.Count -ne 1 -or $archiveUpdaterExecutables[0] -ine "tools/NGTUpdater.exe") {
  throw "Studio archive must contain exactly one production tools/NGTUpdater.exe binary."
}
$archiveManagerExecutables = @($normalizedArchiveEntries | Where-Object { $_ -match '(?i)(^|/)NGTManager\.exe$' })
if ($archiveManagerExecutables.Count -ne 1 -or $archiveManagerExecutables[0] -ine "tools/NGTManager.exe") {
  throw "Studio archive must contain exactly one production tools/NGTManager.exe binary."
}
$unexpectedArchiveEntries = @($normalizedArchiveEntries | Where-Object {
  $_ -match '(?i)(^|/)tools/ngt-updater/(target|src|acceptance|debug|\.cargo)(/|$)|(^|/)tools/ngt-updater/.*\.(rs|toml|lock)$|\.(pdb|rlib|rmeta|d)$'
})
if ($unexpectedArchiveEntries.Count -gt 0) {
  throw "Studio archive contains Rust source, acceptance/debug output, or symbols: $($unexpectedArchiveEntries[0])"
}
foreach ($port in @(3000, 55432)) {
  if ([bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    throw "Studio smoke-test port is already in use: $port"
  }
}

$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-studio-smoke-" + [guid]::NewGuid())
$releaseRoot = Join-Path $smokeRoot "release"
$dataRoot = Join-Path $smokeRoot "data"
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$databaseProcess = $null
$applicationProcess = $null
$previousEnvironment = @{}

function Write-SmokeLogs {
  $stateDirectory = Join-Path $smokeRoot "state"
  if (-not (Test-Path -LiteralPath $stateDirectory)) { return }
  Get-ChildItem -LiteralPath $stateDirectory -File -Filter "*.log" | ForEach-Object {
    Write-Output ("--- " + $_.Name + " ---")
    Get-Content -LiteralPath $_.FullName -Tail 200
  }
}

try {
  & tar.exe -xf $ArchivePath -C $releaseRoot
  if ($LASTEXITCODE -ne 0) { throw "Studio package extraction failed." }
  $extractedFiles = @(Get-ChildItem -LiteralPath $releaseRoot -File -Recurse -Force)
  $extractedUpdaterExecutables = @($extractedFiles | Where-Object { $_.Name -ieq "NGTUpdater.exe" })
  if ($extractedUpdaterExecutables.Count -ne 1 -or
      $extractedUpdaterExecutables[0].FullName -ine [System.IO.Path]::GetFullPath((Join-Path $releaseRoot "tools\NGTUpdater.exe"))) {
    throw "Extracted Studio runtime must contain exactly one production tools\NGTUpdater.exe binary."
  }
  $extractedManagerExecutables = @($extractedFiles | Where-Object { $_.Name -ieq "NGTManager.exe" })
  if ($extractedManagerExecutables.Count -ne 1 -or
      $extractedManagerExecutables[0].FullName -ine [System.IO.Path]::GetFullPath((Join-Path $releaseRoot "tools\NGTManager.exe"))) {
    throw "Extracted Studio runtime must contain exactly one production tools\NGTManager.exe binary."
  }
  $unexpectedExtractedFiles = @($extractedFiles | Where-Object {
    $relative = $_.FullName.Substring(([System.IO.Path]::GetFullPath($releaseRoot).TrimEnd("\") + "\").Length).Replace("\", "/")
    $relative -match '(?i)(^|/)tools/ngt-updater/(target|src|acceptance|debug|\.cargo)(/|$)|(^|/)tools/ngt-updater/.*\.(rs|toml|lock)$|\.(pdb|rlib|rmeta|d)$'
  })
  if ($unexpectedExtractedFiles.Count -gt 0) {
    throw "Extracted Studio runtime contains Rust source, acceptance/debug output, or symbols: $($unexpectedExtractedFiles[0].FullName)"
  }
  & (Join-Path $PSScriptRoot "verify-windows-studio-release.ps1") `
    -ReleaseRoot $releaseRoot -ExpectedVersion ([string]$package.version) | Out-Null
  $expectedCommit = [string]$env:GITHUB_SHA
  if (-not $expectedCommit) {
    $commitOutput = & git -C $projectRoot rev-parse HEAD
    if (($LASTEXITCODE -ne 0) -or (-not $commitOutput)) {
      throw "Unable to read the expected Git commit for the Studio package."
    }
    $expectedCommit = ($commitOutput | Out-String).Trim()
  }
  $nodeExecutable = Join-Path $releaseRoot "runtime\node.exe"
  Test-NgtStudioReleaseMetadata `
    -Path (Join-Path $releaseRoot "studio-release.json") `
    -ExpectedVersion ([string]$package.version) `
    -ExpectedCommit $expectedCommit `
    -NodeExecutable $nodeExecutable
  $staticRoot = Join-Path $releaseRoot ".next\static"
  $standaloneStaticRoot = Join-Path $releaseRoot ".next\standalone\.next\static"
  $staticFiles = @(Get-ChildItem -LiteralPath $staticRoot -File -Recurse)
  if ($staticFiles.Count -eq 0) {
    throw "Studio package has no static build assets."
  }
  foreach ($staticFile in $staticFiles) {
    $relativeStaticPath = $staticFile.FullName.Substring(($staticRoot.TrimEnd("\") + "\").Length)
    $standaloneStaticFile = Join-Path $standaloneStaticRoot $relativeStaticPath
    if (-not (Test-Path -LiteralPath $standaloneStaticFile -PathType Leaf)) {
      throw "Studio standalone package is missing static asset: $relativeStaticPath"
    }
    $sourceHash = (Get-FileHash -LiteralPath $staticFile.FullName -Algorithm SHA256).Hash
    $standaloneHash = (Get-FileHash -LiteralPath $standaloneStaticFile -Algorithm SHA256).Hash
    if ($sourceHash -cne $standaloneHash) {
      throw "Studio standalone static asset does not match its release copy: $relativeStaticPath"
    }
  }
  $publicRoot = Join-Path $releaseRoot "public"
  $standalonePublicRoot = Join-Path $releaseRoot ".next\standalone\public"
  $publicFiles = @(Get-ChildItem -LiteralPath $publicRoot -File -Recurse)
  $standalonePublicFiles = @(Get-ChildItem -LiteralPath $standalonePublicRoot -File -Recurse)
  $publicRelativePaths = @($publicFiles | ForEach-Object {
    $_.FullName.Substring(($publicRoot.TrimEnd("\") + "\").Length)
  } | Sort-Object)
  $standalonePublicRelativePaths = @($standalonePublicFiles | ForEach-Object {
    $_.FullName.Substring(($standalonePublicRoot.TrimEnd("\") + "\").Length)
  } | Sort-Object)
  if ((Compare-Object -ReferenceObject $publicRelativePaths -DifferenceObject $standalonePublicRelativePaths).Count -gt 0) {
    throw "Studio standalone package public file inventory does not match the release copy."
  }
  foreach ($publicFile in $publicFiles) {
    $relativePath = $publicFile.FullName.Substring(($publicRoot.TrimEnd("\") + "\").Length)
    $standalonePublicFile = Join-Path $standalonePublicRoot $relativePath
    if ((Get-FileHash -LiteralPath $publicFile.FullName -Algorithm SHA256).Hash -cne
        (Get-FileHash -LiteralPath $standalonePublicFile -Algorithm SHA256).Hash) {
      throw "Studio standalone public asset does not match its release copy: $relativePath"
    }
  }
  & (Join-Path $PSScriptRoot "test-windows-studio-update-safety.ps1")
  if (Test-Path -LiteralPath (Join-Path $releaseRoot ".next\standalone\node_modules\.pnpm")) {
    throw "Studio package contains the redundant standalone pnpm store."
  }

  $previousEnvironment = @{
    NGT_DATA_ROOT = $env:NGT_DATA_ROOT
    NGT_DB_DIR = $env:NGT_DB_DIR
    NGT_RUNTIME_STATE = $env:NGT_RUNTIME_STATE
    NGT_ENV_FILE = $env:NGT_ENV_FILE
    NGT_MANAGER_ROOT = $env:NGT_MANAGER_ROOT
    NGT_STUDIO_ROOT = $env:NGT_STUDIO_ROOT
    NGT_DB_PORT = $env:NGT_DB_PORT
    TEMP = $env:TEMP
    TMP = $env:TMP
  }
  $stateRoot = Join-Path $smokeRoot "state"
  $tempRoot = Join-Path $smokeRoot "temp"
  New-Item -ItemType Directory -Path $stateRoot, $tempRoot -Force | Out-Null
  $env:NGT_DATA_ROOT = $dataRoot
  $env:NGT_DB_DIR = Join-Path $dataRoot "postgres"
  $env:NGT_RUNTIME_STATE = $stateRoot
  $env:NGT_ENV_FILE = Join-Path $stateRoot "application.env"
  $env:NGT_MANAGER_ROOT = $smokeRoot
  $env:NGT_STUDIO_ROOT = $releaseRoot
  $env:NGT_DB_PORT = "55432"
  $env:TEMP = $tempRoot
  $env:TMP = $tempRoot
  Set-Location -LiteralPath $releaseRoot
  New-Item -ItemType Directory -Path (Join-Path $stateRoot "runtime") -Force | Out-Null
  @{
    formatVersion = 1
    installRoot = $smokeRoot
    activeRelease = $releaseRoot
    dataRoot = $dataRoot
    version = [string]$package.version
    repository = "JayWangsj/ngt1"
    maintenance = $false
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateRoot "studio.json") -Encoding utf8

  if ($IntegrityOnly) {
    $nodeExecutable = Join-Path $releaseRoot "runtime\node.exe"
    Invoke-NgtCommand $nodeExecutable @("--version")
    Invoke-NgtCommand $nodeExecutable @("-e", "require('pg');")
    foreach ($requiredPath in @(
      "node_modules\prisma\build\index.js",
      ".next\standalone\node_modules\.prisma\client\default.js",
      ".next\standalone\node_modules\@prisma\client\runtime\library.js"
    )) {
      if (-not (Test-Path -LiteralPath (Join-Path $releaseRoot $requiredPath))) {
        throw "Studio package is missing runtime file: $requiredPath"
      }
    }
    Invoke-NgtCommand `
      (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe") `
      @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "test-windows-studio-baseline-json-encoding.ps1"))
    Push-Location -LiteralPath (Join-Path $releaseRoot ".next\standalone")
    $previousVerifyModules = $env:NGT_VERIFY_MODULES
    $previousPrismaPackage = $env:NGT_PRISMA_PACKAGE
    $env:NGT_VERIFY_MODULES = "next,react,react-dom"
    $env:NGT_PRISMA_PACKAGE = "@prisma/client"
    try {
      Invoke-NgtCommand $nodeExecutable @(
        "-e",
        'for (const name of process.env.NGT_VERIFY_MODULES.split(String.fromCharCode(44))) require.resolve(name);'
      )
      Invoke-NgtCommand $nodeExecutable @(
        "-e",
        'const { PrismaClient } = require(process.env.NGT_PRISMA_PACKAGE); const db = new PrismaClient(); db.$disconnect();'
      )
    } finally {
      if ($null -eq $previousPrismaPackage) {
        Remove-Item Env:\NGT_PRISMA_PACKAGE -ErrorAction SilentlyContinue
      } else {
        $env:NGT_PRISMA_PACKAGE = $previousPrismaPackage
      }
      if ($null -eq $previousVerifyModules) {
        Remove-Item Env:\NGT_VERIFY_MODULES -ErrorAction SilentlyContinue
      } else {
        $env:NGT_VERIFY_MODULES = $previousVerifyModules
      }
      Pop-Location
    }

    $postgresBin = Join-Path $releaseRoot "runtime\postgres\bin"
    foreach ($executable in @("postgres.exe", "pg_ctl.exe")) {
      Invoke-NgtCommand (Join-Path $postgresBin $executable) @("--version")
    }
    $validationData = Join-Path $smokeRoot "validation-data"
    $passwordFile = Join-Path $smokeRoot "validation-password.txt"
    Set-Content -LiteralPath $passwordFile -Value "ci-validation-password" -Encoding ascii
    Invoke-NgtCommand (Join-Path $postgresBin "initdb.exe") @(
      "-D", $validationData,
      "-U", "ngt",
      "--auth=scram-sha-256",
      "--locale=C",
      "--encoding=UTF8",
      "--pwfile=$passwordFile"
    )
    Write-Output "Studio package integrity test passed."
    Write-Output ("Archive size: {0:N0} bytes; Rust installer: {1:N0} bytes; updater: {2:N0} bytes." -f `
      (Get-Item -LiteralPath $ArchivePath).Length,
      (Get-Item -LiteralPath (Join-Path $releaseRoot "tools\NGTManager.exe")).Length,
      (Get-Item -LiteralPath (Join-Path $releaseRoot "tools\NGTUpdater.exe")).Length)
    return
  }

  $nodeExecutable = Join-Path $releaseRoot "runtime\node.exe"
  $databaseLog = Join-Path $stateRoot "database.log"
  $databaseProcess = Start-Process -FilePath $nodeExecutable `
    -ArgumentList (Join-Path $releaseRoot "scripts\windows-db.mjs") `
    -WorkingDirectory $releaseRoot `
    -RedirectStandardOutput $databaseLog `
    -RedirectStandardError (Join-Path $stateRoot "database.error.log") `
    -WindowStyle Hidden -PassThru
  $readyFile = Join-Path $stateRoot "database-ready.pid"
  for ($attempt = 0; $attempt -lt 180 -and -not (Test-Path -LiteralPath $readyFile); $attempt++) {
    if ($databaseProcess.HasExited) {
      throw "Packaged database runtime exited during startup."
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $readyFile)) {
    throw "Packaged database runtime did not become ready."
  }
  $prismaCli = Join-Path $releaseRoot "node_modules\prisma\build\index.js"
  & $nodeExecutable ("--env-file=" + $env:NGT_ENV_FILE) $prismaCli migrate deploy
  if ($LASTEXITCODE -ne 0) { throw "Packaged database migrations failed with exit code $LASTEXITCODE." }

  $applicationLog = Join-Path $stateRoot "application.log"
  $applicationErrorLog = Join-Path $stateRoot "application.error.log"
  $applicationProcess = Start-Process -FilePath $nodeExecutable `
    -ArgumentList (Join-Path $releaseRoot "scripts\start.mjs") `
    -WorkingDirectory $releaseRoot `
    -RedirectStandardOutput $applicationLog `
    -RedirectStandardError $applicationErrorLog `
    -WindowStyle Hidden -PassThru
  Wait-NgtStudioHealth ([string]$package.version)
  $githubCli = Join-Path $releaseRoot "runtime\gh.exe"
  $authHelp = & $githubCli auth login --help | Out-String
  if (($LASTEXITCODE -ne 0) -or
      (-not $authHelp.Contains("--web")) -or
      (-not $authHelp.Contains("--clipboard"))) {
    throw "Bundled GitHub CLI does not support browser device authorization."
  }
  $authStatus = Invoke-RestMethod `
    -Uri "http://127.0.0.1:3000/api/system-update/auth" `
    -Method Get `
    -Headers @{ Origin = "http://127.0.0.1:3000"; "Sec-Fetch-Site" = "same-origin" } `
    -TimeoutSec 35
  if ($authStatus.status -ne "idle") {
    throw "Studio package GitHub authorization status endpoint is not ready."
  }
  $updateInfo = Invoke-RestMethod `
    -Uri "http://127.0.0.1:3000/api/system-update" `
    -Method Get `
    -Headers @{ Origin = "http://127.0.0.1:3000"; "Sec-Fetch-Site" = "same-origin" } `
    -TimeoutSec 35
  if (-not $updateInfo.installed) {
    throw "Studio package update check did not recognize the installed release."
  }
  Write-Output "Studio package smoke test passed."
} catch {
  Write-Output "--- Packaged startup files ---"
  & tar.exe -tf $ArchivePath | Where-Object { $_ -match "(^|/)(start\.mjs|windows-db\.mjs|NGTManager\.exe)$" }
  $releaseScripts = Join-Path $releaseRoot "scripts"
  if (Test-Path -LiteralPath $releaseScripts -PathType Container) {
    Write-Output "--- Extracted release scripts ---"
    Get-ChildItem -LiteralPath $releaseScripts -File -Force | ForEach-Object { $_.Name }
  }
  Write-SmokeLogs
  throw
} finally {
  if ($applicationProcess) {
    $applicationProcess.Refresh()
    if (-not $applicationProcess.HasExited) {
      & taskkill.exe /PID $applicationProcess.Id /T /F | Out-Null
    }
  }
  $databaseData = Join-Path $dataRoot "postgres"
  $runtimeLocationPath = Join-Path $smokeRoot "state\database-runtime-location.txt"
  if ((Test-Path -LiteralPath (Join-Path $databaseData "PG_VERSION")) -and
      (Test-Path -LiteralPath $runtimeLocationPath)) {
    $databaseRuntime = (Get-Content -LiteralPath $runtimeLocationPath -Raw).Trim()
    $pgCtl = Join-Path $databaseRuntime "bin\pg_ctl.exe"
    if (Test-Path -LiteralPath $pgCtl) {
      & $pgCtl -D $databaseData -m fast -w -t 30 stop 2>$null | Out-Null
    }
  }
  if ($databaseProcess) {
    $databaseProcess.Refresh()
    if (-not $databaseProcess.HasExited) {
      & taskkill.exe /PID $databaseProcess.Id /T /F | Out-Null
    }
  }
  foreach ($name in $previousEnvironment.Keys) {
    if ($null -eq $previousEnvironment[$name]) {
      Remove-Item -Path "Env:\$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path "Env:\$name" -Value $previousEnvironment[$name]
    }
  }
  Set-Location -LiteralPath $projectRoot
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
