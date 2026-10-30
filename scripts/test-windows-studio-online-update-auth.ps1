$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-studio-online-update-auth.ps1")

if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "This regression must run in Windows PowerShell 5.1."
}

function Assert-NgtOnlineAuthTest([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Invoke-NgtOnlineAuthTest {
  param(
    [string]$GhPath,
    [string]$Repository,
    [string]$CandidateDirectory,
    [switch]$ManualInstaller,
    [switch]$ProductionUpdater
  )

  $output = @()
  try {
    $output = @(& {
      Assert-NgtOnlineUpdateGitHubAuth -GhPath $GhPath -Repository $Repository `
        -CandidateDirectory $CandidateDirectory -ManualInstaller:$ManualInstaller `
        -ProductionUpdater:$ProductionUpdater
    } 2>&1)
    return [pscustomobject]@{ Passed = $true; Output = $output; Message = $null }
  } catch {
    return [pscustomobject]@{ Passed = $false; Output = $output; Message = $_.Exception.Message }
  }
}

$savedEnvironment = @{}
foreach ($name in @(
    "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "NGT_FAKE_GH_EXIT_CODE",
    "NGT_FAKE_GH_STDOUT", "NGT_FAKE_GH_STDERR", "NGT_FAKE_GH_ARGS_PATH", "NGT_FAKE_GH_ENV_PATH"
  )) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-online-auth-" + [guid]::NewGuid().ToString("N"))
$configDirectory = Join-Path $testRoot "isolated-gh-config"
$missingConfigDirectory = Join-Path $testRoot "missing-hosts-config"
$candidateDirectory = Join-Path $testRoot "local-candidate"
$argsPath = Join-Path $testRoot "gh-arguments.txt"
$environmentPath = Join-Path $testRoot "gh-environment.txt"
$fakeToken = "ngt-isolated-auth-fixture-token"
$decoyGhToken = "ngt-env-gh-token-decoy"
$decoyGithubToken = "ngt-env-github-token-decoy"
$mainRepository = "JayWangsj/ngt1"
$testRepository = "ngt-fixture-owner/private-updater-test"
$fakeGhPath = Join-Path $testRoot "gh.cmd"

try {
  New-Item -ItemType Directory -Path $configDirectory, $missingConfigDirectory -Force | Out-Null
  [System.IO.File]::WriteAllText(
    (Join-Path $configDirectory "hosts.yml"),
    "github.com:`r`n    oauth_token: $fakeToken`r`n    git_protocol: https`r`n",
    [System.Text.Encoding]::ASCII
  )
  $fakeGhSource = @'
@echo off
setlocal DisableDelayedExpansion
if defined NGT_FAKE_GH_ARGS_PATH echo %*>"%NGT_FAKE_GH_ARGS_PATH%"
if defined NGT_FAKE_GH_ENV_PATH (
  echo GH_CONFIG_DIR=%GH_CONFIG_DIR%>"%NGT_FAKE_GH_ENV_PATH%"
  if defined GH_TOKEN (echo GH_TOKEN=present>>"%NGT_FAKE_GH_ENV_PATH%") else (echo GH_TOKEN=absent>>"%NGT_FAKE_GH_ENV_PATH%")
  if defined GITHUB_TOKEN (echo GITHUB_TOKEN=present>>"%NGT_FAKE_GH_ENV_PATH%") else (echo GITHUB_TOKEN=absent>>"%NGT_FAKE_GH_ENV_PATH%")
)
if defined NGT_FAKE_GH_STDOUT echo %NGT_FAKE_GH_STDOUT%
if defined NGT_FAKE_GH_STDERR >&2 echo %NGT_FAKE_GH_STDERR%
exit /b %NGT_FAKE_GH_EXIT_CODE%
'@
  [System.IO.File]::WriteAllText($fakeGhPath, $fakeGhSource.Replace("`n", "`r`n"), [System.Text.Encoding]::ASCII)

  $env:GH_CONFIG_DIR = $configDirectory
  $env:GH_TOKEN = $decoyGhToken
  $env:GITHUB_TOKEN = $decoyGithubToken
  $env:NGT_FAKE_GH_EXIT_CODE = "0"
  $env:NGT_FAKE_GH_STDOUT = "[]"
  $env:NGT_FAKE_GH_STDERR = ""
  $env:NGT_FAKE_GH_ARGS_PATH = $argsPath
  $env:NGT_FAKE_GH_ENV_PATH = $environmentPath

  $localCandidate = Invoke-NgtOnlineAuthTest -GhPath $fakeGhPath -Repository $mainRepository `
    -CandidateDirectory $candidateDirectory
  Assert-NgtOnlineAuthTest $localCandidate.Passed "A local synthetic candidate incorrectly required GitHub authentication."
  Assert-NgtOnlineAuthTest (-not (Test-Path -LiteralPath $argsPath)) "Local synthetic candidate mode called GitHub CLI."
  Write-Output "Local candidate mode continued without GitHub credentials."

  $resolvedManualRepository = Resolve-NgtOnlineUpdateAuthRepository -MainRepository $mainRepository `
    -TestReleaseRepository $testRepository
  $resolvedProductionRepository = Resolve-NgtOnlineUpdateAuthRepository -MainRepository $mainRepository `
    -TestReleaseRepository $testRepository -ProductionUpdater
  Assert-NgtOnlineAuthTest ($resolvedManualRepository -ceq $mainRepository) `
    "Manual upgrade authentication did not target the main repository."
  Assert-NgtOnlineAuthTest ($resolvedProductionRepository -ceq $testRepository) `
    "Production updater authentication did not target the isolated test repository."
  try {
    Resolve-NgtOnlineUpdateAuthRepository -MainRepository $mainRepository `
      -TestReleaseRepository $mainRepository -ProductionUpdater | Out-Null
    throw "Production updater accepted the main repository as its private test repository."
  } catch {
    if ($_.Exception.Message -notlike "*separate test Release repository*") { throw }
  }

  $requiredModes = @(
    @{ Name = "remote candidate"; CandidateDirectory = ""; Manual = $false; Production = $false; Repository = $mainRepository },
    @{ Name = "manual upgrade"; CandidateDirectory = $candidateDirectory; Manual = $true; Production = $false; Repository = $resolvedManualRepository },
    @{ Name = "production updater"; CandidateDirectory = $candidateDirectory; Manual = $false; Production = $true; Repository = $resolvedProductionRepository }
  )
  foreach ($mode in $requiredModes) {
    $result = Invoke-NgtOnlineAuthTest -GhPath $fakeGhPath -Repository $mode.Repository `
      -CandidateDirectory $mode.CandidateDirectory -ManualInstaller:$mode.Manual -ProductionUpdater:$mode.Production
    $capturedArguments = if (Test-Path -LiteralPath $argsPath) { [System.IO.File]::ReadAllText($argsPath).Trim() } else { "missing" }
    $capturedEnvironment = if (Test-Path -LiteralPath $environmentPath) { [System.IO.File]::ReadAllText($environmentPath).Trim() } else { "missing" }
    Assert-NgtOnlineAuthTest ($result.Passed -and $result.Output.Count -eq 0) `
      ("The isolated Releases API success response was not accepted for {0}: {1}; args={2}; env={3}" -f `
        $mode.Name, $result.Message, $capturedArguments, ($capturedEnvironment -replace "`r?`n", ";"))
    $expectedArguments = "api repos/$($mode.Repository)/releases?per_page=1 --hostname github.com --method GET"
    $actualArguments = [System.IO.File]::ReadAllText($argsPath).Trim()
    Assert-NgtOnlineAuthTest ($actualArguments -ceq $expectedArguments) `
      "The read-only Releases API request targeted the wrong repository or endpoint for $($mode.Name)."
    $ghEnvironment = [System.IO.File]::ReadAllText($environmentPath)
    Assert-NgtOnlineAuthTest ($ghEnvironment.Contains("GH_CONFIG_DIR=$configDirectory") -and
      $ghEnvironment.Contains("GH_TOKEN=absent") -and $ghEnvironment.Contains("GITHUB_TOKEN=absent")) `
      "The API probe did not use GH_CONFIG_DIR alone for $($mode.Name)."
    Assert-NgtOnlineAuthTest ($env:GH_TOKEN -ceq $decoyGhToken -and $env:GITHUB_TOKEN -ceq $decoyGithubToken) `
      "The API probe did not restore the caller's token environment after execution."
  }

  foreach ($status in @(401, 403, 404)) {
    $env:NGT_FAKE_GH_EXIT_CODE = "1"
    $env:NGT_FAKE_GH_STDOUT = "fake API body contains $fakeToken"
    $env:NGT_FAKE_GH_STDERR = "HTTP $status fake CLI diagnostic contains $fakeToken"
    $result = Invoke-NgtOnlineAuthTest -GhPath $fakeGhPath -Repository $mainRepository `
      -CandidateDirectory $candidateDirectory -ManualInstaller
    Assert-NgtOnlineAuthTest (-not $result.Passed -and
      $result.Message -eq "GitHub repository Releases API is not readable through the isolated GH_CONFIG_DIR.") `
      "An HTTP $status response was not rejected with a sanitized error."
    $exposed = (@($result.Output) + @($result.Message)) -join "`n"
    Assert-NgtOnlineAuthTest (-not $exposed.Contains($fakeToken) -and -not $exposed.Contains("fake CLI diagnostic")) `
      "An HTTP $status response leaked CLI output or a fake credential."
  }

  $env:NGT_FAKE_GH_EXIT_CODE = "1"
  $env:NGT_FAKE_GH_STDOUT = ""
  $env:NGT_FAKE_GH_STDERR = "network failure contains $fakeToken"
  $networkFailure = Invoke-NgtOnlineAuthTest -GhPath $fakeGhPath -Repository $mainRepository `
    -CandidateDirectory $candidateDirectory -ManualInstaller
  Assert-NgtOnlineAuthTest (-not $networkFailure.Passed -and
    -not ((@($networkFailure.Output) + @($networkFailure.Message)) -join "`n").Contains($fakeToken)) `
    "A nonzero GitHub CLI result leaked its diagnostic or accepted an unavailable API."

  $env:NGT_FAKE_GH_EXIT_CODE = "0"
  $env:NGT_FAKE_GH_STDOUT = "invalid JSON contains $fakeToken"
  $env:NGT_FAKE_GH_STDERR = ""
  $invalidResponse = Invoke-NgtOnlineAuthTest -GhPath $fakeGhPath -Repository $mainRepository `
    -CandidateDirectory $candidateDirectory -ManualInstaller
  Assert-NgtOnlineAuthTest (-not $invalidResponse.Passed -and
    $invalidResponse.Message -eq "GitHub repository Releases API returned an invalid response through the isolated GH_CONFIG_DIR.") `
    "A malformed successful CLI response was not rejected safely."
  Assert-NgtOnlineAuthTest (-not ((@($invalidResponse.Output) + @($invalidResponse.Message)) -join "`n").Contains($fakeToken)) `
    "A malformed response leaked a fake credential."

  $env:GH_CONFIG_DIR = $missingConfigDirectory
  Remove-Item -LiteralPath $argsPath -ErrorAction SilentlyContinue
  Remove-Item Env:\NGT_FAKE_GH_ARGS_PATH -ErrorAction SilentlyContinue
  $missingHosts = Invoke-NgtOnlineAuthTest -GhPath $fakeGhPath -Repository $mainRepository `
    -CandidateDirectory $candidateDirectory -ManualInstaller
  Assert-NgtOnlineAuthTest (-not $missingHosts.Passed -and
    $missingHosts.Message -eq "The isolated GitHub CLI hosts.yml is unavailable." -and
    -not (Test-Path -LiteralPath $argsPath)) `
    "A missing isolated hosts.yml was not rejected before invoking GitHub CLI."

  $childRoot = Join-Path $testRoot "hash-mismatch-child"
  $childConfig = Join-Path $childRoot "gh-config"
  New-Item -ItemType Directory -Path $childConfig -Force | Out-Null
  [System.IO.File]::WriteAllText(
    (Join-Path $childConfig "hosts.yml"),
    "github.com:`r`n    oauth_token: $fakeToken`r`n",
    [System.Text.Encoding]::ASCII
  )
  $requestPath = Join-Path $childRoot "request.json"
  $childRequest = [ordered]@{
    environment = @{ GH_CONFIG_DIR = $childConfig }
    ghConfigDirectory = $childConfig
    expectedTokenSha256 = ("0" * 64) -join ""
    verifyGitHubAuth = $false
    parameters = @{}
    scriptPath = "unused.ps1"
  }
  [System.IO.File]::WriteAllText(
    $requestPath,
    ($childRequest | ConvertTo-Json -Depth 4),
    [System.Text.UTF8Encoding]::new($false)
  )
  $childScript = Join-Path $PSScriptRoot "run-windows-studio-acceptance-as-standard-user.ps1"
  $childStdout = Join-Path $childRoot "stdout.txt"
  $childStderr = Join-Path $childRoot "stderr.txt"
  $childArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $childScript + '" -Acceptance manual-installer -Child -RequestPath "' + $requestPath + '"'
  $childProcess = Start-Process -FilePath (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe") `
    -ArgumentList $childArguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $childStdout -RedirectStandardError $childStderr
  if (-not $childProcess.WaitForExit(30000)) {
    & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $childProcess.Id /T /F | Out-Null
    throw "The isolated GH_CONFIG_DIR hash-mismatch probe timed out."
  }
  $childProcess.Refresh()
  $childOutput = [System.IO.File]::ReadAllText($childStdout) + [System.IO.File]::ReadAllText($childStderr)
  Assert-NgtOnlineAuthTest ($childProcess.ExitCode -ne 0 -and
    $childOutput.Contains("could not read the expected token from GH_CONFIG_DIR") -and
    -not $childOutput.Contains($fakeToken)) `
    "A mismatched isolated-config token hash was not rejected without exposing the token."

  Write-Output "Isolated GH_CONFIG_DIR Releases API and standard-user token-hash checks passed."
} finally {
  foreach ($name in @(
      "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "NGT_FAKE_GH_EXIT_CODE",
      "NGT_FAKE_GH_STDOUT", "NGT_FAKE_GH_STDERR", "NGT_FAKE_GH_ARGS_PATH", "NGT_FAKE_GH_ENV_PATH"
    )) {
    $value = $savedEnvironment[$name]
    if ($null -eq $value) { Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
  }
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
$global:LASTEXITCODE = 0
