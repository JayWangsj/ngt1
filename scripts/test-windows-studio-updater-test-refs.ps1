$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw "Updater test refs regression requires Windows PowerShell 5.1."
}

$script:BaselineSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
$script:CandidateSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$script:CandidateTag = "v" + (Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\package.json") -Raw | ConvertFrom-Json).version
$script:FixtureToken = "fake-public-updater-test-token"
$script:RefsScript = Join-Path $PSScriptRoot "push-windows-studio-updater-test-refs.ps1"
$script:FakeGit = $null
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-updater-test-refs-" + [guid]::NewGuid().ToString("N"))
$runnerTemp = Join-Path $testRoot "runner-temp"
$savedEnvironment = @{}
foreach ($name in @(
    "NGT_UPDATER_TEST_REPOSITORY", "NGT_UPDATER_TEST_REPOSITORY_INPUT", "NGT_UPDATER_TEST_TOKEN", "GITHUB_SHA", "RUNNER_TEMP",
    "GIT_ASKPASS", "GIT_ASKPASS_REQUIRE", "GIT_TERMINAL_PROMPT", "NGT_UPDATER_GIT_ASKPASS_RESPONSE"
  )) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Assert-NgtUpdaterTestRefs([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function git {
  $arguments = @($args | ForEach-Object { [string]$_ })
  $script:FakeGit.Calls += ,($arguments -join " ")
  if ($arguments -contains "fetch") {
    $global:LASTEXITCODE = 0
    return
  }
  if ($arguments -contains "rev-parse") {
    $global:LASTEXITCODE = 0
    if ($arguments -contains "FETCH_HEAD^{commit}") { return $script:BaselineSha }
    return $script:CandidateSha
  }
  if ($arguments -contains "merge-base") {
    $global:LASTEXITCODE = 0
    return
  }
  if ($arguments -contains "ls-remote") {
    $global:LASTEXITCODE = 0
    if ($script:FakeGit.LeakOutput) { return $script:FakeGit.LeakOutput }
    if ($arguments -contains "--heads") { return $script:FakeGit.Heads }
    return $script:FakeGit.Tags
  }
  if ($arguments -contains "push") {
    $script:FakeGit.Pushes++
    $script:FakeGit.PushArguments = $arguments
    $global:LASTEXITCODE = $script:FakeGit.PushExitCode
    return $script:FakeGit.PushOutput
  }
  throw "Unexpected fake git invocation."
}

function Invoke-NgtUpdaterTestRefs([string]$Stage, [string]$Heads = "", [string]$Tags = "", [string]$LeakOutput = "", [string]$Token = $script:FixtureToken, [int]$PushExitCode = 0, [string]$RequestedRepository = "Owner/public-updater-test") {
  $script:FakeGit = @{
    Calls = @()
    Heads = $Heads
    Tags = $Tags
    LeakOutput = $LeakOutput
    Pushes = 0
    PushArguments = @()
    PushExitCode = $PushExitCode
    PushOutput = ""
  }
  $env:NGT_UPDATER_TEST_REPOSITORY = "Owner/public-updater-test"
  $env:NGT_UPDATER_TEST_REPOSITORY_INPUT = $RequestedRepository
  $env:NGT_UPDATER_TEST_TOKEN = $Token
  $env:GITHUB_SHA = $script:CandidateSha
  $env:RUNNER_TEMP = $runnerTemp
  try {
    $output = @(& { . $script:RefsScript -Stage $Stage } 2>&1 | ForEach-Object { [string]$_ })
    return [pscustomobject]@{ Passed = $true; Output = $output; Error = ""; Git = $script:FakeGit }
  } catch {
    return [pscustomobject]@{ Passed = $false; Output = @(); Error = $_.Exception.Message; Git = $script:FakeGit }
  }
}

try {
  New-Item -ItemType Directory -Path $runnerTemp -Force | Out-Null

  $emptyRepository = Invoke-NgtUpdaterTestRefs -Stage baseline
  Assert-NgtUpdaterTestRefs $emptyRepository.Passed "An empty public repository did not accept the exact baseline refs: $($emptyRepository.Error)"
  Assert-NgtUpdaterTestRefs ($emptyRepository.Git.Pushes -eq 1 -and $emptyRepository.Git.PushArguments -contains "--atomic") `
    "The baseline refs were not added through one atomic push."
  Assert-NgtUpdaterTestRefs (-not ($emptyRepository.Git.PushArguments -contains "--force")) "The ref push used force."
  Assert-NgtUpdaterTestRefs ($emptyRepository.Git.PushArguments -contains ($script:BaselineSha + ":refs/heads/main") -and
    $emptyRepository.Git.PushArguments -contains ($script:BaselineSha + ":refs/tags/v2.0.21")) `
    "The baseline push did not use the exact published v2.0.21 commit."

  $unrelatedBranch = Invoke-NgtUpdaterTestRefs -Stage baseline -Heads ("cccccccccccccccccccccccccccccccccccccccc`trefs/heads/feature")
  Assert-NgtUpdaterTestRefs (-not $unrelatedBranch.Passed -and $unrelatedBranch.Git.Pushes -eq 0) `
    "An unrelated branch was not rejected before pushing."

  $wrongMainSha = Invoke-NgtUpdaterTestRefs -Stage baseline -Heads ("cccccccccccccccccccccccccccccccccccccccc`trefs/heads/main")
  Assert-NgtUpdaterTestRefs (-not $wrongMainSha.Passed -and $wrongMainSha.Git.Pushes -eq 0) `
    "A main branch at an unexpected SHA was not rejected before pushing."

  $unrelatedTag = Invoke-NgtUpdaterTestRefs -Stage baseline -Tags ("cccccccccccccccccccccccccccccccccccccccc`trefs/tags/unrelated")
  Assert-NgtUpdaterTestRefs (-not $unrelatedTag.Passed -and $unrelatedTag.Git.Pushes -eq 0) `
    "An unrelated tag was not rejected before pushing."

  $wrongBaselineTag = Invoke-NgtUpdaterTestRefs -Stage baseline -Tags ("cccccccccccccccccccccccccccccccccccccccc`trefs/tags/v2.0.21")
  Assert-NgtUpdaterTestRefs (-not $wrongBaselineTag.Passed -and $wrongBaselineTag.Git.Pushes -eq 0) `
    "A baseline tag at an unexpected SHA was not rejected before pushing."

  $candidateTags = "{0}`trefs/tags/v2.0.21" -f $script:BaselineSha
  $candidate = Invoke-NgtUpdaterTestRefs -Stage candidate `
    -Heads ("{0}`trefs/heads/main" -f $script:BaselineSha) -Tags $candidateTags
  Assert-NgtUpdaterTestRefs ($candidate.Passed -and $candidate.Git.Pushes -eq 1 -and $candidate.Git.PushArguments -contains "--atomic") `
    "The exact candidate refs were not atomically pushed: $($candidate.Error)"
  Assert-NgtUpdaterTestRefs ($candidate.Git.PushArguments -contains ($script:CandidateSha + ":refs/heads/main") -and
    $candidate.Git.PushArguments -contains ($script:CandidateSha + ":refs/tags/" + $script:CandidateTag)) `
    "The candidate push did not use the exact workflow SHA and version tag."

  $failedPush = Invoke-NgtUpdaterTestRefs -Stage baseline -PushExitCode 17
  Assert-NgtUpdaterTestRefs (-not $failedPush.Passed -and $failedPush.Git.Pushes -eq 1) `
    "A nonzero atomic push exit code was incorrectly accepted."

  $wrongCandidateTag = Invoke-NgtUpdaterTestRefs -Stage candidate `
    -Heads ("{0}`trefs/heads/main" -f $script:BaselineSha) `
    -Tags ($candidateTags + "`ncccccccccccccccccccccccccccccccccccccccc`trefs/tags/" + $script:CandidateTag)
  Assert-NgtUpdaterTestRefs (-not $wrongCandidateTag.Passed -and $wrongCandidateTag.Git.Pushes -eq 0) `
    "A candidate tag at an unexpected SHA was not rejected before pushing."

  $missingToken = Invoke-NgtUpdaterTestRefs -Stage baseline -Token ""
  Assert-NgtUpdaterTestRefs (-not $missingToken.Passed -and $missingToken.Git.Calls.Count -eq 0) `
    "A missing test token was not rejected before Git access."

  $unapprovedRepository = Invoke-NgtUpdaterTestRefs -Stage baseline -RequestedRepository "Owner/unreviewed-repository"
  Assert-NgtUpdaterTestRefs (-not $unapprovedRepository.Passed -and $unapprovedRepository.Git.Calls.Count -eq 0) `
    "An unapproved manual repository input was not rejected before Git access."

  $credentialLeak = Invoke-NgtUpdaterTestRefs -Stage baseline `
    -LeakOutput ($script:FixtureToken + " refs/heads/main")
  Assert-NgtUpdaterTestRefs (-not $credentialLeak.Passed -and $credentialLeak.Git.Pushes -eq 0 -and
    -not $credentialLeak.Error.Contains($script:FixtureToken) -and
    -not (($credentialLeak.Output -join "`n").Contains($script:FixtureToken))) `
    "Git output containing the fixture token was not rejected and sanitized."

  Assert-NgtUpdaterTestRefs ((Get-ChildItem -LiteralPath $runnerTemp -Filter "ngt-updater-test-askpass-*.cmd" -File).Count -eq 0) `
    "The temporary askpass credential file was not cleaned up."
  Assert-NgtUpdaterTestRefs (-not $env:NGT_UPDATER_TEST_TOKEN) "The test token remained in the process environment after the push script."
  Write-Output "Windows PowerShell 5.1 public updater test refs regressions passed."
} finally {
  foreach ($name in @(
      "NGT_UPDATER_TEST_REPOSITORY", "NGT_UPDATER_TEST_REPOSITORY_INPUT", "NGT_UPDATER_TEST_TOKEN", "GITHUB_SHA", "RUNNER_TEMP",
      "GIT_ASKPASS", "GIT_ASKPASS_REQUIRE", "GIT_TERMINAL_PROMPT", "NGT_UPDATER_GIT_ASKPASS_RESPONSE"
    )) {
    $value = $savedEnvironment[$name]
    if ($null -eq $value) { Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
  }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
