$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-studio-online-update-auth.ps1")

$previousEnvironment = @{
  GH_CONFIG_DIR = [Environment]::GetEnvironmentVariable("GH_CONFIG_DIR", "Process")
  GH_TOKEN = [Environment]::GetEnvironmentVariable("GH_TOKEN", "Process")
  GITHUB_TOKEN = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "Process")
}
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-online-auth-" + [guid]::NewGuid().ToString("N"))
$emptyConfigDirectory = Join-Path $testRoot "empty-config"

try {
  New-Item -ItemType Directory -Path $emptyConfigDirectory -Force | Out-Null
  [Environment]::SetEnvironmentVariable("GH_CONFIG_DIR", $emptyConfigDirectory, "Process")
  Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue
  $ghPath = Get-Command gh.exe -ErrorAction Stop | Select-Object -ExpandProperty Source

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $LASTEXITCODE = 1
    $authOutput = & $ghPath auth status --hostname github.com 2>&1
    $authExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($authExitCode -eq 0) {
    throw "The isolated GitHub CLI fixture unexpectedly has an authenticated host."
  }

  $candidateDirectory = Join-Path $testRoot "candidate"
  Assert-NgtOnlineUpdateGitHubAuth -GhPath $ghPath -CandidateDirectory $candidateDirectory
  Write-Output "Local candidate mode continued without GitHub credentials."

  $requiredModes = @(
    @{ Name = "remote candidate"; CandidateDirectory = $null; ManualInstaller = $false; ProductionUpdater = $false },
    @{ Name = "manual upgrade"; CandidateDirectory = $candidateDirectory; ManualInstaller = $true; ProductionUpdater = $false },
    @{ Name = "production updater"; CandidateDirectory = $candidateDirectory; ManualInstaller = $false; ProductionUpdater = $true }
  )
  foreach ($mode in $requiredModes) {
    $failedWithAuthError = $false
    try {
      Assert-NgtOnlineUpdateGitHubAuth -GhPath $ghPath `
        -CandidateDirectory $mode.CandidateDirectory `
        -ManualInstaller:$mode.ManualInstaller `
        -ProductionUpdater:$mode.ProductionUpdater
    } catch {
      if ($_.Exception.Message -ne "GitHub release read authorization is unavailable.") { throw }
      $failedWithAuthError = $true
    }
    if (-not $failedWithAuthError) {
      throw "The unauthenticated GitHub CLI was accepted for $($mode.Name)."
    }
  }

  Write-Output "Online-update authentication modes passed without credentials."
} finally {
  foreach ($name in @("GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN")) {
    $value = $previousEnvironment[$name]
    if ($null -eq $value) { Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
  }
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
$global:LASTEXITCODE = 0
