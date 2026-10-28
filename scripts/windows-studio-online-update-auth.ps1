function Test-NgtOnlineUpdateRequiresGitHubAuth(
  [string]$CandidateDirectory,
  [switch]$ManualInstaller,
  [switch]$ProductionUpdater
) {
  return (-not $CandidateDirectory) -or $ManualInstaller -or $ProductionUpdater
}

function Assert-NgtOnlineUpdateGitHubAuth(
  [string]$GhPath,
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

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $LASTEXITCODE = 1
    $authOutput = & $GhPath auth status --hostname github.com 2>&1
    $authExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($authExitCode -ne 0) {
    throw "GitHub release read authorization is unavailable."
  }
}
