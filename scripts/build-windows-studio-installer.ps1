param(
  [string]$OutputDirectory = "dist",
  [string]$CompilerPath
)
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$package = Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json
$version = [string]$package.version
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
$installerDefinition = Join-Path $projectRoot "installer\windows-studio.iss"
$installerSupportDirectory = $PSScriptRoot
$iconPath = Join-Path $projectRoot "assets\ngt-studio.ico"
$packageDirectory = Join-Path $projectRoot ".local\studio-package"

if (-not (Test-Path -LiteralPath (Join-Path $packageDirectory "studio-release.json"))) {
  throw "Studio package directory is missing. Run scripts/build-windows-studio-package.ps1 first."
}
if (-not (Test-Path -LiteralPath (Join-Path $packageDirectory "scripts\install-windows-studio-bootstrap.ps1"))) {
  throw "Studio installer bootstrap is missing from the package. Rebuild the studio package first."
}
if (-not (Test-Path -LiteralPath $iconPath)) {
  throw "Studio package icon is missing: $iconPath"
}
if (-not (Test-Path -LiteralPath $installerDefinition)) {
  throw "Installer definition is missing: $installerDefinition"
}

if (-not $CompilerPath) {
  $compilerCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
  )
  $CompilerPath = $compilerCandidates | Where-Object {
    Test-Path -LiteralPath $_
  } | Select-Object -First 1
  if (-not $CompilerPath) {
    $compiler = Get-Command "iscc.exe" -ErrorAction SilentlyContinue
    if ($compiler) {
      $CompilerPath = $compiler.Source
    }
  }
}
if ((-not $CompilerPath) -or (-not (Test-Path -LiteralPath $CompilerPath))) {
  throw "Inno Setup compiler was not found: $CompilerPath"
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
Write-Output "Inno Setup compiler: $CompilerPath"
Write-Output "Installer package directory: $packageDirectory"
Write-Output "Installer output: $outputRoot"
$packageDrive = "Z:"
if (Get-PSDrive -Name "Z" -ErrorAction SilentlyContinue) {
  throw "Temporary installer package drive Z: is already in use."
}
& subst.exe $packageDrive $packageDirectory
if ($LASTEXITCODE -ne 0) {
  throw "Unable to create a short path for the installer package."
}
try {
  & $CompilerPath `
    ("/DAppVersion=" + $version) `
    ("/DPackageDirectory=" + $packageDrive) `
    ("/DIconPath=" + $iconPath) `
    ("/DInstallerSupportDirectory=" + $installerSupportDirectory) `
    ("/DOutputDir=" + $outputRoot) `
    $installerDefinition
  if ($LASTEXITCODE -ne 0) {
    throw "Windows studio installer compilation failed."
  }
} finally {
  & subst.exe $packageDrive /D
}

$installer = Join-Path $outputRoot ("ngt-studio-windows-setup-v" + $version + ".exe")
if (-not (Test-Path -LiteralPath $installer)) {
  throw "Windows studio installer was not created."
}
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
Set-Content -LiteralPath ($installer + ".sha256") `
  -Value ("$hash  " + (Split-Path $installer -Leaf)) -Encoding ascii
Write-Output $installer
