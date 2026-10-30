function Test-NgtOnlineUpdateRequiresGitHubAuth(
  [string]$CandidateDirectory,
  [switch]$ManualInstaller,
  [switch]$ProductionUpdater
) {
  return (-not $CandidateDirectory) -or $ManualInstaller -or $ProductionUpdater
}

function Resolve-NgtOnlineUpdateAuthRepository(
  [Parameter(Mandatory = $true)][string]$MainRepository,
  [string]$TestReleaseRepository,
  [switch]$ProductionUpdater
) {
  if (-not $ProductionUpdater) { return $MainRepository }
  if ($TestReleaseRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
      $TestReleaseRepository -ieq $MainRepository) {
    throw "Production updater acceptance requires a separate test Release repository."
  }
  return $TestReleaseRepository
}

function Assert-NgtOnlineUpdateGitHubAuth(
  [string]$GhPath,
  [string]$Repository = "JayWangsj/ngt1",
  [string]$CandidateDirectory,
  [switch]$ManualInstaller,
  [switch]$ProductionUpdater
) {
  if (-not (Test-NgtOnlineUpdateRequiresGitHubAuth `
        -CandidateDirectory $CandidateDirectory `
        -ManualInstaller:$ManualInstaller `
        -ProductionUpdater:$ProductionUpdater)) {
    return
  }

  $configDirectory = [string]$env:GH_CONFIG_DIR
  if ([string]::IsNullOrWhiteSpace($configDirectory) -or
      -not (Test-Path -LiteralPath $configDirectory -PathType Container) -or
      -not (Test-Path -LiteralPath (Join-Path $configDirectory "hosts.yml") -PathType Leaf)) {
    throw "The isolated GitHub CLI hosts.yml is unavailable."
  }
  if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw "The GitHub Release repository is invalid."
  }

  $previousEnvironment = @{
    GH_CONFIG_DIR = [Environment]::GetEnvironmentVariable("GH_CONFIG_DIR", "Process")
    GH_TOKEN = [Environment]::GetEnvironmentVariable("GH_TOKEN", "Process")
    GITHUB_TOKEN = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "Process")
  }
  $previousErrorActionPreference = $ErrorActionPreference
  $previousLastExitCode = $global:LASTEXITCODE
  $apiExitCode = 1
  $apiOutput = @()
  try {
    Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue
    $env:GH_CONFIG_DIR = $configDirectory
    $ErrorActionPreference = "Continue"
    $global:LASTEXITCODE = 1
    $apiOutput = & $GhPath api "repos/$Repository/releases?per_page=1" `
      --hostname github.com --method GET 2>&1
    $apiExitCode = $global:LASTEXITCODE
  } catch {
    $apiExitCode = 1
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $global:LASTEXITCODE = $previousLastExitCode
    foreach ($name in @("GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN")) {
      $value = $previousEnvironment[$name]
      if ($null -eq $value) { Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
    }
  }

  if ($apiExitCode -ne 0) {
    throw "GitHub repository Releases API is not readable through the isolated GH_CONFIG_DIR."
  }
  $apiJson = (@($apiOutput) | ForEach-Object { [string]$_ }) -join "`n"
  if ([string]::IsNullOrWhiteSpace($apiJson)) {
    throw "GitHub repository Releases API returned no response through the isolated GH_CONFIG_DIR."
  }
  try {
    $null = ConvertFrom-Json -InputObject $apiJson -ErrorAction Stop
  } catch {
    throw "GitHub repository Releases API returned an invalid response through the isolated GH_CONFIG_DIR."
  }
}
