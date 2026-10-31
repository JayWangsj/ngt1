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
$script:RunIdCounter = 0
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-updater-test-refs-" + [guid]::NewGuid().ToString("N"))
$runnerTemp = Join-Path $testRoot "runner-temp"
$savedEnvironment = @{}
foreach ($name in @(
    "NGT_UPDATER_TEST_REPOSITORY", "NGT_UPDATER_TEST_REPOSITORY_INPUT", "NGT_UPDATER_TEST_TOKEN", "GITHUB_SHA", "RUNNER_TEMP",
    "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
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
    if ($script:FakeGit.EmitNativeProgress) {
      & $env:ComSpec /d /s /c "echo From native git fetch 1>&2"
    }
    $global:LASTEXITCODE = $script:FakeGit.FetchExitCode
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
    if ($script:FakeGit.EmitNativeProgress) {
      & $env:ComSpec /d /s /c "echo To native git push 1>&2"
    }
    $global:LASTEXITCODE = $script:FakeGit.PushExitCode
    return $script:FakeGit.PushOutput
  }
  throw "Unexpected fake git invocation."
}

function Invoke-NgtUpdaterTestRefs {
  param(
    [string]$Stage,
    [string]$Heads = "",
    [string]$Tags = "",
    [string]$LeakOutput = "",
    [string]$Token = $script:FixtureToken,
    [int]$FetchExitCode = 0,
    [int]$PushExitCode = 0,
    [string]$RequestedRepository = "Owner/public-updater-test",
    [string]$PushOutput = "",
    [bool]$EmitNativeProgress = $true,
    [bool]$BlockDiagnosticSave = $false
  )
  $script:FakeGit = @{
    Calls = @()
    Heads = $Heads
    Tags = $Tags
    LeakOutput = $LeakOutput
    FetchExitCode = $FetchExitCode
    Pushes = 0
    PushArguments = @()
    PushExitCode = $PushExitCode
    PushOutput = $PushOutput
    EmitNativeProgress = $EmitNativeProgress
  }
  $script:RunIdCounter++
  $runId = (80000000 + $script:RunIdCounter).ToString()
  $env:NGT_UPDATER_TEST_REPOSITORY = "Owner/public-updater-test"
  $env:NGT_UPDATER_TEST_REPOSITORY_INPUT = $RequestedRepository
  $env:NGT_UPDATER_TEST_TOKEN = $Token
  $env:GITHUB_SHA = $script:CandidateSha
  $env:RUNNER_TEMP = $runnerTemp
  $env:GITHUB_RUN_ID = $runId
  $env:GITHUB_RUN_ATTEMPT = "1"
  $diagnosticDirectory = Join-Path $runnerTemp ("ngt-acceptance-diagnostics-{0}-1" -f $runId)
  $diagnosticPath = Join-Path $diagnosticDirectory ("updater-test-refs-push-{0}.txt" -f $Stage)
  $blockerCreated = $false
  if ($BlockDiagnosticSave) {
    New-Item -ItemType File -Path $diagnosticDirectory -Force | Out-Null
    $blockerCreated = $true
  }
  $capturedOutput = New-Object System.Collections.Generic.List[string]
  $passed = $true
  $errorMessage = ""
  try {
    & { . $script:RefsScript -Stage $Stage } 2>&1 | ForEach-Object {
      [void]$capturedOutput.Add([string]$_)
    }
  } catch {
    $passed = $false
    $errorMessage = $_.Exception.Message
  } finally {
    if ($blockerCreated -and (Test-Path -LiteralPath $diagnosticDirectory -PathType Leaf)) {
      Remove-Item -LiteralPath $diagnosticDirectory -Force
    }
  }

  $diagnosticFile = if (Test-Path -LiteralPath $diagnosticPath -PathType Leaf) {
    Get-Content -LiteralPath $diagnosticPath -Raw
  } else {
    ""
  }
  return [pscustomobject]@{
    Passed = $passed
    Output = $capturedOutput.ToArray()
    Error = $errorMessage
    DiagnosticFile = [string]$diagnosticFile
    Git = $script:FakeGit
  }
}

function Assert-NgtUpdaterPushDiagnostic([object]$Result, [string[]]$RequiredText, [string[]]$Secrets, [bool]$RequireFile = $true) {
  $channels = @{
    "captured output stream" = ($Result.Output -join [Environment]::NewLine)
    "exception message" = [string]$Result.Error
  }
  if ($RequireFile) { $channels["diagnostic file"] = [string]$Result.DiagnosticFile }
  foreach ($channel in $channels.Keys) {
    $text = [string]$channels[$channel]
    Assert-NgtUpdaterTestRefs (-not [string]::IsNullOrWhiteSpace($text)) ("The {0} diagnostic channel was empty." -f $channel)
    foreach ($required in $RequiredText) {
      Assert-NgtUpdaterTestRefs ($text.Contains($required)) ("The {0} did not contain required diagnostic evidence: {1}" -f $channel, $required)
    }
    foreach ($secret in $Secrets) {
      if (-not [string]::IsNullOrEmpty($secret)) {
        Assert-NgtUpdaterTestRefs (-not $text.Contains($secret)) ("A sensitive fixture value appeared in the {0}." -f $channel)
      }
    }
  }
}

function Assert-NgtUpdaterPushCredentialsCleaned([string]$Context) {
  Assert-NgtUpdaterTestRefs ((Get-ChildItem -LiteralPath $runnerTemp -Filter "ngt-updater-test-askpass-*.cmd" -File).Count -eq 0) `
    ("The temporary askpass credential file was not cleaned after {0}." -f $Context)
  Assert-NgtUpdaterTestRefs (-not $env:NGT_UPDATER_TEST_TOKEN -and
    -not $env:NGT_UPDATER_GIT_ASKPASS_RESPONSE -and
    -not $env:GIT_ASKPASS -and
    -not $env:GIT_ASKPASS_REQUIRE -and
    -not $env:GIT_TERMINAL_PROMPT) ("Sensitive Git credential environment remained after {0}." -f $Context)
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

  $pushRefusalOutput = "remote: permission denied: protected ref update rejected" + [Environment]::NewLine + "fatal: atomic push failed"
  $failedPush = Invoke-NgtUpdaterTestRefs -Stage baseline -PushExitCode 17 -PushOutput $pushRefusalOutput
  Assert-NgtUpdaterTestRefs (-not $failedPush.Passed -and $failedPush.Git.Pushes -eq 1) `
    "A nonzero atomic push exit code was incorrectly accepted."
  Assert-NgtUpdaterPushDiagnostic $failedPush @(
    "Operation: git push --atomic",
    "Stage: baseline",
    "Git exit code: 17",
    "Test repository: Owner/public-updater-test",
    "remote: permission denied: protected ref update rejected",
    "fatal: atomic push failed",
    "To native git push"
  ) @()
  Assert-NgtUpdaterPushCredentialsCleaned "a rejected baseline push"

  $emptyPush = Invoke-NgtUpdaterTestRefs -Stage candidate `
    -Heads ("{0}`trefs/heads/main" -f $script:BaselineSha) `
    -Tags ("{0}`trefs/tags/v2.0.21" -f $script:BaselineSha) `
    -PushExitCode 29 -PushOutput "" -EmitNativeProgress $false
  Assert-NgtUpdaterTestRefs (-not $emptyPush.Passed) "An empty-output atomic push failure was incorrectly accepted."
  Assert-NgtUpdaterPushDiagnostic $emptyPush @(
    "Stage: candidate",
    "Git exit code: 29",
    "No Git output was returned."
  ) @()
  Assert-NgtUpdaterPushCredentialsCleaned "an empty-output candidate push"

  $specialToken = 'fake.token+[regex] ?^$'
  $encodedSpecialToken = [System.Uri]::EscapeDataString($specialToken)
  $formEncodedSpecialToken = [System.Net.WebUtility]::UrlEncode($specialToken)
  $secretVariantsOutput = @(
    "remote: permission denied while updating refs"
    ("literal credential: " + $specialToken)
    ("encoded credential: " + $encodedSpecialToken)
    ("form-encoded credential: " + $formEncodedSpecialToken)
    "credential URL: https://url-user-secret:url-password-secret@github.com/Owner/public-updater-test.git"
    "Authorization: Basic basic-header-secret"
    "Authorization: Bearer bearer-header-secret"
    "remote: https://github.com/Owner/public-updater-test.git?token=query-token-secret&access_token=query-access-secret"
  ) -join [Environment]::NewLine
  $redactedPush = Invoke-NgtUpdaterTestRefs -Stage baseline -Token $specialToken -PushExitCode 23 -PushOutput $secretVariantsOutput
  Assert-NgtUpdaterTestRefs (-not $redactedPush.Passed) "A rejected push containing credential variants was accepted."
  Assert-NgtUpdaterPushDiagnostic $redactedPush @(
    "Stage: baseline",
    "Git exit code: 23",
    "Test repository: Owner/public-updater-test",
    "remote: permission denied while updating refs",
    "Authorization: Basic <redacted>",
    "Authorization: Bearer <redacted>",
    "?token=<redacted>&access_token=<redacted>"
  ) @(
    $specialToken,
    $encodedSpecialToken,
    $formEncodedSpecialToken,
    "url-user-secret",
    "url-password-secret",
    "basic-header-secret",
    "bearer-header-secret",
    "query-token-secret",
    "query-access-secret"
  )
  Assert-NgtUpdaterPushCredentialsCleaned "a credential-redaction failure"

  $truncationToken = "truncation.fixture+token?"
  $truncationPrefix = "remote: permission denied "
  $paddingLength = 8170 - $truncationPrefix.Length
  $padding = [string]::new([char]"x", $paddingLength)
  $tail = [string]::new([char]"z", 160)
  $longPushOutput = $truncationPrefix + $padding + $truncationToken + $tail
  $truncatedPush = Invoke-NgtUpdaterTestRefs -Stage baseline -Token $truncationToken -PushExitCode 31 `
    -PushOutput $longPushOutput -EmitNativeProgress $false
  Assert-NgtUpdaterTestRefs (-not $truncatedPush.Passed) "A truncated atomic push failure was incorrectly accepted."
  Assert-NgtUpdaterPushDiagnostic $truncatedPush @(
    "Stage: baseline",
    "Git exit code: 31",
    "remote: permission denied",
    "<redacted>",
    "[Git combined output truncated after sanitization at 8192 characters.]"
  ) @($truncationToken)
  Assert-NgtUpdaterPushCredentialsCleaned "a truncated push diagnostic"

  $blockedDiagnostic = Invoke-NgtUpdaterTestRefs -Stage baseline -PushExitCode 37 `
    -PushOutput "remote: permission denied while writing refs" -BlockDiagnosticSave $true
  Assert-NgtUpdaterTestRefs (-not $blockedDiagnostic.Passed) "A push failure was accepted when its diagnostic file could not be saved."
  Assert-NgtUpdaterTestRefs ([string]::IsNullOrEmpty($blockedDiagnostic.DiagnosticFile)) "A blocked diagnostic path unexpectedly produced a file."
  Assert-NgtUpdaterPushDiagnostic $blockedDiagnostic @(
    "Stage: baseline",
    "Git exit code: 37",
    "remote: permission denied while writing refs",
    "Sanitized diagnostic file could not be saved."
  ) @() $false
  Assert-NgtUpdaterPushCredentialsCleaned "a push failure with a blocked diagnostic file"

  $successfulPush = Invoke-NgtUpdaterTestRefs -Stage baseline -PushOutput "remote: receiving objects: 100%" -EmitNativeProgress $true
  Assert-NgtUpdaterTestRefs ($successfulPush.Passed -and $successfulPush.Git.Pushes -eq 1) `
    "A successful push with native stderr progress was incorrectly rejected: $($successfulPush.Error)"
  Assert-NgtUpdaterPushCredentialsCleaned "a successful push with native stderr progress"

  $leakingSuccessfulPush = Invoke-NgtUpdaterTestRefs -Stage baseline `
    -PushOutput ($script:FixtureToken + " remote: refs accepted")
  Assert-NgtUpdaterTestRefs (-not $leakingSuccessfulPush.Passed -and $leakingSuccessfulPush.Git.Pushes -eq 1) `
    "A successful push whose output contained the fixture token was not failed closed."
  Assert-NgtUpdaterPushDiagnostic $leakingSuccessfulPush @(
    "Stage: baseline",
    "Git exit code: 0",
    "git push --atomic output contained credential material",
    "remote: refs accepted",
    "Credential material was detected in Git combined output and redacted."
  ) @($script:FixtureToken)
  Assert-NgtUpdaterPushCredentialsCleaned "a successful push with detected credential output"

  $failedFetch = Invoke-NgtUpdaterTestRefs -Stage baseline -FetchExitCode 19
  Assert-NgtUpdaterTestRefs (-not $failedFetch.Passed -and $failedFetch.Git.Pushes -eq 0) `
    "A nonzero baseline fetch exit code was incorrectly accepted."

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

  Assert-NgtUpdaterPushCredentialsCleaned "the existing remote-ref credential-leak rejection"
  Write-Output "Windows PowerShell 5.1 public updater test refs regressions passed."
} finally {
  foreach ($name in @(
      "NGT_UPDATER_TEST_REPOSITORY", "NGT_UPDATER_TEST_REPOSITORY_INPUT", "NGT_UPDATER_TEST_TOKEN", "GITHUB_SHA", "RUNNER_TEMP",
      "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
      "GIT_ASKPASS", "GIT_ASKPASS_REQUIRE", "GIT_TERMINAL_PROMPT", "NGT_UPDATER_GIT_ASKPASS_RESPONSE"
    )) {
    $value = $savedEnvironment[$name]
    if ($null -eq $value) { Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
  }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
