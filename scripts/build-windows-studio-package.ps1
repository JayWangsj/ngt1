param(
  [string]$OutputDirectory = "dist",
  [string]$BuildDirectory = ".next"
)
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot "studio-runtime.ps1")
$standaloneBuild = Join-Path $BuildDirectory "standalone"
if (-not (Test-Path -LiteralPath (Join-Path $standaloneBuild "server.js"))) {
  throw "Production build is missing. Run pnpm build first."
}

$package = Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json
$version = $package.version
$commitOutput = git rev-parse HEAD
if (($LASTEXITCODE -ne 0) -or (-not $commitOutput)) { throw "Unable to read the Git commit." }
$commit = ($commitOutput | Out-String).Trim()
if (($env:GITHUB_REF_TYPE -eq "tag") -and ($env:GITHUB_REF_NAME -ne ("v" + $version))) {
  throw "Git tag $env:GITHUB_REF_NAME does not match package version v$version."
}

$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
$updaterManifest = Join-Path $projectRoot "tools\ngt-updater\Cargo.toml"
$cargoTarget = if ($env:CARGO_TARGET_DIR) {
  [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
} elseif ($env:RUNNER_TEMP) {
  Join-Path $env:RUNNER_TEMP "ngt-updater-cargo"
} else {
  Join-Path $projectRoot "tools\ngt-updater\target"
}
& cargo build --release --manifest-path $updaterManifest --target-dir $cargoTarget
if ($LASTEXITCODE -ne 0) { throw "Rust updater release build failed." }
$updaterBinary = Join-Path $cargoTarget "release\NGTUpdater.exe"
if (-not (Test-Path -LiteralPath $updaterBinary -PathType Leaf)) {
  throw "Rust updater executable is missing after the release build."
}
$dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty Source -First 1
if (-not $dumpbin) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $installationPath = (& $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath | Out-String).Trim()
    if ($installationPath) {
      $msvcTools = Join-Path $installationPath "VC\Tools\MSVC"
      $latestTools = Get-ChildItem -LiteralPath $msvcTools -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1
      if ($latestTools) {
        $candidateDumpbin = Join-Path $latestTools.FullName "bin\Hostx64\x64\dumpbin.exe"
        if (Test-Path -LiteralPath $candidateDumpbin -PathType Leaf) {
          $dumpbin = $candidateDumpbin
        }
      }
    }
  }
}
if (-not $dumpbin) {
  throw "dumpbin.exe is required to verify the updater's Windows runtime imports."
}
$updaterDependencies = @(& $dumpbin /dependents $updaterBinary 2>&1)
if ($LASTEXITCODE -ne 0) {
  throw "Unable to inspect the production updater's DLL dependencies."
}
$dynamicCrtImports = @($updaterDependencies | Where-Object {
  [string]$_ -match '(?i)^\s*(?:VCRUNTIME140(?:_1)?|MSVCP140(?:_[A-Z0-9]+)?|CONCRT140|VCOMP140)\.dll\s*$'
})
if ($dynamicCrtImports.Count -gt 0) {
  throw "The production updater imports the Visual C++ runtime dynamically: $($dynamicCrtImports -join ', ')"
}
$stage = Join-Path $projectRoot ".local\studio-package"
if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $stage ".next") -Force | Out-Null
$standaloneDestination = Join-Path $stage ".next\standalone"
& node (Join-Path $projectRoot "scripts\copy-directory-materialized.mjs") `
  $standaloneBuild $standaloneDestination
if ($LASTEXITCODE -ne 0) {
  throw "Standalone build copy failed."
}
$tracedUpdaterSource = Join-Path $standaloneDestination "tools\ngt-updater"
if (Test-Path -LiteralPath $tracedUpdaterSource) {
  Remove-Item -LiteralPath $tracedUpdaterSource -Recurse -Force
}
$tracedUpdaterBinary = Join-Path $standaloneDestination "tools\NGTUpdater.exe"
if (Test-Path -LiteralPath $tracedUpdaterBinary -PathType Leaf) {
  Remove-Item -LiteralPath $tracedUpdaterBinary -Force
}
$standalonePnpmStore = Join-Path $standaloneDestination "node_modules\.pnpm"
if (Test-Path -LiteralPath $standalonePnpmStore) {
  Remove-Item -LiteralPath $standalonePnpmStore -Recurse -Force
}
$standaloneDocs = Join-Path $standaloneDestination "docs"
if (Test-Path -LiteralPath $standaloneDocs) {
  Remove-Item -LiteralPath $standaloneDocs -Recurse -Force
}
$swcHelpersSource = Join-Path $projectRoot "node_modules\@swc\helpers"
$swcHelpersDestination = Join-Path $standaloneDestination "node_modules\@swc\helpers"
if (-not (Test-Path -LiteralPath $swcHelpersSource)) {
  throw "The @swc/helpers runtime is missing."
}
& node (Join-Path $projectRoot "scripts\copy-directory-materialized.mjs") `
  $swcHelpersSource $swcHelpersDestination
if ($LASTEXITCODE -ne 0) {
  throw "The @swc/helpers runtime copy failed."
}
$requiredSwcHelper = ".next\standalone\node_modules\@swc\helpers\esm\_interop_require_default.js"
if (-not (Test-Path -LiteralPath (Join-Path $stage $requiredSwcHelper))) {
  throw "The standalone @swc/helpers runtime is incomplete."
}
$nextEnvironmentSource = Join-Path $projectRoot "node_modules\@next\env"
$nextEnvironmentDestination = Join-Path $standaloneDestination "node_modules\@next\env"
if (-not (Test-Path -LiteralPath $nextEnvironmentSource)) {
  throw "The @next/env runtime is missing."
}
& node (Join-Path $projectRoot "scripts\copy-directory-materialized.mjs") `
  $nextEnvironmentSource $nextEnvironmentDestination
if ($LASTEXITCODE -ne 0) {
  throw "The @next/env runtime copy failed."
}
$requiredNextEnvironment = ".next\standalone\node_modules\@next\env\dist\index.js"
if (-not (Test-Path -LiteralPath (Join-Path $stage $requiredNextEnvironment))) {
  throw "The standalone @next/env runtime is incomplete."
}
$prismaRuntimeSource = Join-Path $projectRoot "node_modules\@prisma\client\runtime"
if (-not (Test-Path -LiteralPath (Join-Path $prismaRuntimeSource "library.js"))) {
  throw "The @prisma/client runtime is missing."
}
$prismaRuntimeDestination = Join-Path $standaloneDestination "node_modules\@prisma\client\runtime"
& node (Join-Path $projectRoot "scripts\copy-directory-materialized.mjs") `
  $prismaRuntimeSource $prismaRuntimeDestination
if ($LASTEXITCODE -ne 0) {
  throw "The @prisma/client runtime copy failed."
}
$requiredPrismaRuntime = ".next\standalone\node_modules\@prisma\client\runtime\library.js"
if (-not (Test-Path -LiteralPath (Join-Path $stage $requiredPrismaRuntime))) {
  throw "The standalone @prisma/client runtime is incomplete."
}
$prismaClientSourceOutput = & node -e "const path = require('node:path'); console.log(path.dirname(require.resolve('.prisma/client/default', { paths: [path.dirname(require.resolve('@prisma/client'))] })));"
if (($LASTEXITCODE -ne 0) -or (-not $prismaClientSourceOutput)) {
  throw "Unable to resolve the generated Prisma client."
}
$prismaClientSource = [System.IO.Path]::GetFullPath(($prismaClientSourceOutput | Out-String).Trim())
if (-not (Test-Path -LiteralPath (Join-Path $prismaClientSource "default.js"))) {
  throw "The generated Prisma client is missing."
}
$prismaClientDestinations = @(
  (Join-Path $standaloneDestination "node_modules\.prisma\client")
)
$nestedRuntimeModules = Join-Path $standaloneDestination (Join-Path $BuildDirectory "node_modules")
if (Test-Path -LiteralPath (Join-Path $nestedRuntimeModules "@prisma")) {
  $prismaClientDestinations += (Join-Path $nestedRuntimeModules ".prisma\client")
}
foreach ($prismaClientDestination in $prismaClientDestinations) {
  & node (Join-Path $projectRoot "scripts\copy-directory-materialized.mjs") `
    $prismaClientSource $prismaClientDestination
  if ($LASTEXITCODE -ne 0) {
    throw "The generated Prisma client copy failed."
  }
}
$requiredPrismaClient = ".next\standalone\node_modules\.prisma\client\default.js"
if (-not (Test-Path -LiteralPath (Join-Path $stage $requiredPrismaClient))) {
  throw "The standalone Prisma client is incomplete."
}
$standaloneUpdaterSource = Join-Path $standaloneDestination "tools\ngt-updater"
if (Test-Path -LiteralPath $standaloneUpdaterSource) {
  throw "The standalone package retained Rust updater source or build output."
}
Copy-Item -LiteralPath (Join-Path $BuildDirectory "static") -Destination (Join-Path $stage ".next\static") -Recurse -Force
Copy-Item -LiteralPath "public" -Destination (Join-Path $stage "public") -Recurse -Force
$nonWindowsSharpPackages = Get-ChildItem -LiteralPath $stage -Directory -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^sharp-libvips-(darwin|linux|freebsd|linuxmusl|win32-arm64)' }
foreach ($nativePackage in $nonWindowsSharpPackages) {
  Remove-Item -LiteralPath $nativePackage.FullName -Recurse -Force
}
$sourceMaps = Get-ChildItem -LiteralPath $stage -File -Recurse -Filter "*.map" -ErrorAction SilentlyContinue
foreach ($sourceMap in $sourceMaps) {
  Remove-Item -LiteralPath $sourceMap.FullName -Force
}
$copiedEnvironment = Join-Path $stage ".next\standalone\.env"
if (Test-Path -LiteralPath $copiedEnvironment) {
  Remove-Item -LiteralPath $copiedEnvironment -Force
}
Copy-Item -LiteralPath "prisma" -Destination (Join-Path $stage "prisma") -Recurse -Force
$stageAssets = Join-Path $stage "assets"
New-Item -ItemType Directory -Path $stageAssets -Force | Out-Null
Copy-Item -LiteralPath "assets\ngt-studio.ico" -Destination $stageAssets -Force
$stageTools = Join-Path $stage "tools"
New-Item -ItemType Directory -Path $stageTools -Force | Out-Null
Copy-Item -LiteralPath $updaterBinary -Destination (Join-Path $stageTools "NGTUpdater.exe") -Force

$runtimeScripts = @(
  "backup-windows-studio.ps1",
  "check-windows-credential-store.ps1",
  "test-windows-studio-backup.ps1",
  "test-windows-studio-install-coordination.ps1",
  "test-windows-studio-update-safety.ps1",
  "install-windows-startup.ps1",
  "install-windows-studio.ps1",
  "install-windows-studio-bootstrap.ps1",
  "prepare-windows-studio-install.ps1",
  "retain-windows-studio-releases.ps1",
  "studio-runtime.ps1",
  "start.mjs",
  "uninstall-windows-startup.ps1",
  "uninstall-windows-studio.ps1",
  "verify-windows-studio-release.ps1",
  "verify-windows-studio-runtime.ps1",
  "windows-db.mjs",
  "windows-service.ps1",
  "windows-studio-launcher.vbs",
  "windows-studio-common.ps1",
  "windows-studio-install-coordination.ps1"
)
$stageScripts = Join-Path $stage "scripts"
New-Item -ItemType Directory -Path $stageScripts -Force | Out-Null
foreach ($scriptName in $runtimeScripts) {
  Copy-Item -LiteralPath (Join-Path "scripts" $scriptName) -Destination $stageScripts -Force
}

$runtimeDefinition = Join-Path $projectRoot "scripts\studio-runtime"
Copy-Item -LiteralPath (Join-Path $runtimeDefinition "package.json") `
  -Destination (Join-Path $stage "package.json") -Force
$dependencyStage = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-studio-runtime-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $dependencyStage -Force | Out-Null
try {
  Get-ChildItem -LiteralPath $runtimeDefinition -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $dependencyStage -Force
  }
  Push-Location -LiteralPath $dependencyStage
  try {
    & pnpm install --prod --frozen-lockfile `
      --config.node-linker=hoisted --config.package-import-method=copy
    if ($LASTEXITCODE -ne 0) { throw "Runtime dependency installation failed." }
  } finally {
    Pop-Location
  }
  Copy-Item -LiteralPath (Join-Path $dependencyStage "node_modules") `
    -Destination (Join-Path $stage "node_modules") -Recurse -Force
} finally {
  if (Test-Path -LiteralPath $dependencyStage) {
    Remove-Item -LiteralPath $dependencyStage -Recurse -Force
  }
}

$nativePackage = Get-ChildItem -LiteralPath "node_modules\.pnpm" -Directory `
  -Filter "@embedded-postgres+windows-x64@*" | Select-Object -First 1
if (-not $nativePackage) {
  throw "Windows PostgreSQL runtime is missing."
}
$nativeSource = Join-Path $nativePackage.FullName "node_modules\@embedded-postgres\windows-x64\native"
$runtimeDirectory = Join-Path $stage "runtime"
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$postgresRuntime = Join-Path $runtimeDirectory "postgres"
Copy-Item -LiteralPath $nativeSource -Destination $postgresRuntime -Recurse -Force

$vcRuntimeCandidates = @()
if ($env:VCToolsRedistDir) {
  $vcRuntimeCandidates += (Join-Path $env:VCToolsRedistDir "x64\Microsoft.VC143.CRT")
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path -LiteralPath $vswhere) {
  $installations = & $vswhere -products * -format json | ConvertFrom-Json
  foreach ($installation in $installations) {
    $redistRoot = Join-Path $installation.installationPath "VC\Redist\MSVC"
    if (Test-Path -LiteralPath $redistRoot) {
      $vcRuntimeCandidates += @(Get-ChildItem -LiteralPath $redistRoot -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "x64\Microsoft.VC143.CRT" })
    }
  }
}
$vcRuntime = $vcRuntimeCandidates |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $vcRuntime) {
  throw "Microsoft Visual C++ x64 application-local runtime is missing."
}
$postgresBin = Join-Path $postgresRuntime "bin"
Get-ChildItem -LiteralPath $vcRuntime -File -Filter "*.dll" | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $postgresBin -Force
}
foreach ($runtimeName in @("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")) {
  if (-not (Test-Path -LiteralPath (Join-Path $postgresBin $runtimeName))) {
    throw "Microsoft Visual C++ runtime file is missing: $runtimeName"
  }
}
Copy-Item -LiteralPath (Get-Command node -ErrorAction Stop).Source `
  -Destination (Join-Path $runtimeDirectory "node.exe") -Force
$githubCli = (Get-Command gh -ErrorAction Stop).Source
Copy-Item -LiteralPath $githubCli `
  -Destination (Join-Path $runtimeDirectory "gh.exe") -Force
$licenseDirectory = Join-Path $stage "licenses"
New-Item -ItemType Directory -Path $licenseDirectory -Force | Out-Null
Copy-Item -LiteralPath "licenses\github-cli.txt" `
  -Destination $licenseDirectory -Force

$runtimeHash = Get-NgtRuntimeHash $runtimeDirectory
$fileManifest = @{}
$stageFiles = @(Get-ChildItem -LiteralPath $stage -File -Recurse -Force)
$updaterExecutables = @($stageFiles | Where-Object { $_.Name -ieq "NGTUpdater.exe" })
if ($updaterExecutables.Count -ne 1 -or
    $updaterExecutables[0].FullName -ine [System.IO.Path]::GetFullPath((Join-Path $stage "tools\NGTUpdater.exe"))) {
  throw "The staged runtime must contain only the production tools\NGTUpdater.exe binary."
}
$unexpectedUpdaterFiles = @($stageFiles | Where-Object {
  $relative = $_.FullName.Substring(([System.IO.Path]::GetFullPath($stage).TrimEnd("\") + "\").Length).Replace("\", "/")
  $relative -match '(?i)(^|/)tools/ngt-updater/(target|src|acceptance|debug|\.cargo)(/|$)|(^|/)tools/ngt-updater/.*\.(rs|toml|lock)$|\.(pdb|rlib|rmeta|d)$'
})
if ($unexpectedUpdaterFiles.Count -gt 0) {
  throw "The staged runtime contains Rust source, acceptance/debug output, or symbols: $($unexpectedUpdaterFiles[0].FullName)"
}
$stageFiles | ForEach-Object {
  $relativePath = $_.FullName.Substring(([System.IO.Path]::GetFullPath($stage).TrimEnd("\") + "\").Length).Replace("\", "/")
  $fileManifest[$relativePath] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}

@{
  version = $version
  commit = $commit
  runtimeHash = $runtimeHash
  files = $fileManifest
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage "studio-release.json") -Encoding utf8

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$archive = Join-Path $outputRoot ("ngt-studio-windows-v" + $version + ".zip")
if (Test-Path -LiteralPath $archive) {
  Remove-Item -LiteralPath $archive -Force
}
Push-Location -LiteralPath $stage
try {
  & tar.exe -a -c -f $archive .
  if ($LASTEXITCODE -ne 0) { throw "Studio archive creation failed." }
} finally {
  Pop-Location
}
$requiredArchiveEntry = $requiredSwcHelper.Replace("\", "/")
$requiredNextEnvironmentEntry = $requiredNextEnvironment.Replace("\", "/")
$requiredPrismaClientEntry = $requiredPrismaClient.Replace("\", "/")
$archiveEntries = & tar.exe -tf $archive
if ($LASTEXITCODE -ne 0) { throw "Studio archive verification failed." }
if (-not ($archiveEntries | Where-Object { $_ -like ("*" + $requiredArchiveEntry) })) {
  throw "Studio archive is missing the @swc/helpers runtime."
}
if (-not ($archiveEntries | Where-Object { $_ -like ("*" + $requiredNextEnvironmentEntry) })) {
  throw "Studio archive is missing the @next/env runtime."
}
if (-not ($archiveEntries | Where-Object { $_ -like ("*" + $requiredPrismaClientEntry) })) {
  throw "Studio archive is missing the generated Prisma client."
}
$normalizedArchiveEntries = @($archiveEntries | ForEach-Object { ([string]$_).Replace("\", "/").TrimStart([char[]]@('.', '/')) })
$archiveUpdaterExecutables = @($normalizedArchiveEntries | Where-Object { $_ -match '(?i)(^|/)NGTUpdater\.exe$' })
if ($archiveUpdaterExecutables.Count -ne 1 -or $archiveUpdaterExecutables[0] -ine "tools/NGTUpdater.exe") {
  throw "The archive must contain only the production tools/NGTUpdater.exe binary."
}
$unexpectedArchiveEntries = @($normalizedArchiveEntries | Where-Object {
  $_ -match '(?i)(^|/)tools/ngt-updater/(target|src|acceptance|debug|\.cargo)(/|$)|(^|/)tools/ngt-updater/.*\.(rs|toml|lock)$|\.(pdb|rlib|rmeta|d)$'
})
if ($unexpectedArchiveEntries.Count -gt 0) {
  throw "The archive contains Rust source, acceptance/debug output, or symbols: $($unexpectedArchiveEntries[0])"
}
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
Set-Content -LiteralPath ($archive + ".sha256") -Value ("$hash  " + (Split-Path $archive -Leaf)) -Encoding ascii
Write-Output $archive
Write-Output ("Archive size: {0:N0} bytes; production Rust updater: {1:N0} bytes." -f `
  (Get-Item -LiteralPath $archive).Length, (Get-Item -LiteralPath $updaterBinary).Length)
Write-Output ("Excluded {0} source maps and {1} non-Windows Sharp packages." -f $sourceMaps.Count, $nonWindowsSharpPackages.Count)
