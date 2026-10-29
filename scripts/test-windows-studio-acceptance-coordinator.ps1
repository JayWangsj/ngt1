$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "This regression must run in Windows PowerShell 5.1."
}
. (Join-Path $PSScriptRoot "windows-studio-acceptance-coordinator.ps1")

function Assert-NgtAcceptanceTest([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-NgtAcceptanceFailure([scriptblock]$Action, [string]$ExpectedText) {
  try {
    & $Action
  } catch {
    Assert-NgtAcceptanceTest ($_.Exception.Message -like "*$ExpectedText*") `
      ("Expected failure containing '{0}', received '{1}'." -f $ExpectedText, $_.Exception.Message)
    return
  }
  throw "Expected failure containing '$ExpectedText', but the operation succeeded."
}

function New-NgtAcceptanceTestSecretSet {
  param(
    [string]$GhToken,
    [string]$GithubToken,
    [Parameter(Mandatory = $true)][string]$Password
  )

  $protectedTokens = @($GhToken, $GithubToken) | Where-Object { -not [string]::IsNullOrEmpty($_) }
  $passwordPlain = $Password
  $diagnosticSecrets = @(
    @($protectedTokens) + @($passwordPlain)
  )
  return [pscustomobject]@{
    Count = $diagnosticSecrets.Count
    Values = [object[]]$diagnosticSecrets
  }
}

function Invoke-NgtAcceptanceTestChild {
  param(
    [string]$PowerShellPath,
    [string]$ChildScript,
    [string]$Root,
    [string]$Name,
    [string]$Stdout,
    [string]$Stderr,
    [int]$ExitCode,
    [string]$FailureMessage = "",
    [int]$ResultExitCode = -1
  )
  $caseRoot = Join-Path $Root $Name
  New-Item -ItemType Directory -Path $caseRoot -Force | Out-Null
  $configPath = Join-Path $caseRoot "child-config.json"
  $stdoutPath = Join-Path $caseRoot "stdout.log"
  $stderrPath = Join-Path $caseRoot "stderr.log"
  $resultPath = Join-Path $caseRoot "exit-code.txt"
  $failurePath = Join-Path $caseRoot "child-failure.json"
  $config = [ordered]@{
    stdout = $Stdout
    stderr = $Stderr
    exitCode = $ExitCode
    resultExitCode = if ($ResultExitCode -lt 0) { $ExitCode } else { $ResultExitCode }
    resultPath = $resultPath
    failurePath = $failurePath
    failureMessage = $FailureMessage
  }
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 3), [System.Text.UTF8Encoding]::new($false))
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $ChildScript + '" -ConfigPath "' + $configPath + '"'
  $process = Start-Process -FilePath $PowerShellPath -ArgumentList $arguments `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $processHandle = Get-NgtAcceptanceProcessHandle -Process $process
  while (-not $process.WaitForExit(1000)) { }
  return [pscustomobject]@{
    StdoutPath = $stdoutPath
    StderrPath = $stderrPath
    ResultPath = $resultPath
    FailurePath = $failurePath
    ProcessExitCode = Get-NgtAcceptanceProcessExitCode -Process $process
  }
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-acceptance-coordinator-" + [guid]::NewGuid().ToString("N"))
$powerShellPath = Join-Path $PSHOME "powershell.exe"
$childScript = Join-Path $testRoot "child.ps1"
$ghToken = "fake-gh-token"
$githubToken = "fake-github-token"
$passwordPlain = "fake-password"
$diagnosticPath = Join-Path $testRoot "diagnostics\acceptance-failure.json"
try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  $secretCases = @(
    @{ Name = "GH_TOKEN only"; GhToken = $ghToken; GithubToken = $null; Expected = @($ghToken, $passwordPlain) },
    @{ Name = "GITHUB_TOKEN only"; GhToken = $null; GithubToken = $githubToken; Expected = @($githubToken, $passwordPlain) },
    @{ Name = "both tokens"; GhToken = $ghToken; GithubToken = $githubToken; Expected = @($ghToken, $githubToken, $passwordPlain) },
    @{ Name = "no token"; GhToken = $null; GithubToken = $null; Expected = @($passwordPlain) }
  )
  foreach ($case in $secretCases) {
    $secretSet = New-NgtAcceptanceTestSecretSet -GhToken $case.GhToken `
      -GithubToken $case.GithubToken -Password $passwordPlain
    Assert-NgtAcceptanceTest ($secretSet.Count -eq $case.Expected.Count -and $secretSet.Values.Count -eq $case.Expected.Count) `
      "The diagnostic secret array has the wrong number of independent entries for $($case.Name)."
    for ($index = 0; $index -lt $case.Expected.Count; $index++) {
      Assert-NgtAcceptanceTest ($secretSet.Values[$index] -ceq $case.Expected[$index]) `
        "The diagnostic secret array combined or reordered values for $($case.Name)."
    }
  }
  $protectedTokens = @($ghToken, $githubToken)
  $diagnosticSecrets = @(
    @($protectedTokens) + @($passwordPlain)
  )
  Assert-NgtAcceptanceTest ($diagnosticSecrets.Count -eq 3 -and
    $diagnosticSecrets[0] -ceq $ghToken -and
    $diagnosticSecrets[1] -ceq $githubToken -and
    $diagnosticSecrets[2] -ceq $passwordPlain) `
    "The coordinator's two-token-plus-password array construction did not preserve separate entries."

  $invalidHandleProcess = [pscustomobject]@{ Handle = [IntPtr]::Zero }
  Assert-NgtAcceptanceFailure { Get-NgtAcceptanceProcessHandle -Process $invalidHandleProcess } "handle is unavailable"
  Assert-NgtAcceptanceFailure { Get-NgtAcceptanceProcessHandle -Process $null } "did not return a process object"
  $missingExitCodeProcess = [pscustomobject]@{ HasExited = $true; ExitCode = $null }
  Add-Member -InputObject $missingExitCodeProcess -MemberType ScriptMethod -Name Refresh -Value { }
  Assert-NgtAcceptanceFailure { Get-NgtAcceptanceProcessExitCode -Process $missingExitCodeProcess } "exit code is unavailable"
  $runningProcess = [pscustomobject]@{ HasExited = $false; ExitCode = 0 }
  Add-Member -InputObject $runningProcess -MemberType ScriptMethod -Name Refresh -Value { }
  Assert-NgtAcceptanceFailure { Get-NgtAcceptanceProcessExitCode -Process $runningProcess } "has not exited"

  $childSource = @'
param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = "Stop"
$config = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
if (-not [string]::IsNullOrEmpty([string]$config.failureMessage)) {
  try {
    throw [System.InvalidOperationException]::new([string]$config.failureMessage)
  } catch {
    $failure = $_
    $invocation = $failure.InvocationInfo
    $failureReport = [ordered]@{
      type = $failure.Exception.GetType().FullName
      message = $failure.Exception.Message
      script = $invocation.ScriptName
      line = $invocation.ScriptLineNumber
      sourceLine = $invocation.Line
      position = $invocation.PositionMessage
      scriptStackTrace = $failure.ScriptStackTrace
    }
    [System.IO.File]::WriteAllText([string]$config.failurePath, ($failureReport | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
    [Console]::Error.WriteLine("The standard-user child failed; structured details are stored for parent-side sanitization.")
    [System.IO.File]::WriteAllText([string]$config.resultPath, ([string]$config.resultExitCode + "`r`n"), [System.Text.Encoding]::ASCII)
    exit [int]$config.exitCode
  }
}
if (-not [string]::IsNullOrEmpty([string]$config.stdout)) { [Console]::Out.Write([string]$config.stdout) }
if (-not [string]::IsNullOrEmpty([string]$config.stderr)) { [Console]::Error.Write([string]$config.stderr) }
[System.IO.File]::WriteAllText([string]$config.resultPath, ([string]$config.resultExitCode + "`r`n"), [System.Text.Encoding]::ASCII)
exit [int]$config.exitCode
'@
  [System.IO.File]::WriteAllText($childScript, $childSource, [System.Text.Encoding]::UTF8)

  $stderrFailure = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot `
    "empty-stdout-error-stderr" "" "subprocess error output" 7
  $stderrOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $stderrFailure.StdoutPath -StderrPath $stderrFailure.StderrPath `
    -ResultPath $stderrFailure.ResultPath -ProcessExitCode $stderrFailure.ProcessExitCode
  Assert-NgtAcceptanceTest ($stderrOutcome.Stdout -eq "") "Empty stdout was not preserved as an empty string."
  Assert-NgtAcceptanceTest ($stderrOutcome.Stderr -eq "subprocess error output") "stderr was not preserved."
  Assert-NgtAcceptanceTest (-not $stderrOutcome.Succeeded -and $stderrOutcome.ChildExitCode -eq 7 -and $stderrOutcome.ProcessExitCode -eq 7) `
    "The failing child exit code was not retained when stdout was empty and stderr contained an error."
  Assert-NgtAcceptanceFailure { Assert-NgtAcceptanceProcessSucceeded -Outcome $stderrOutcome } "child exit code 7"

  $normal = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot `
    "normal-output" "normal child output" "" 0
  $normalOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $normal.StdoutPath -StderrPath $normal.StderrPath `
    -ResultPath $normal.ResultPath -ProcessExitCode $normal.ProcessExitCode
  Assert-NgtAcceptanceTest ($normalOutcome.Succeeded -and $normalOutcome.Stdout -eq "normal child output" -and $normalOutcome.Stderr -eq "") `
    "A normal zero-exit child with stdout and empty stderr did not pass."
  Assert-NgtAcceptanceProcessSucceeded -Outcome $normalOutcome

  $silent = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot "silent-child" "" "" 0
  $silentOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $silent.StdoutPath -StderrPath $silent.StderrPath `
    -ResultPath $silent.ResultPath -ProcessExitCode $silent.ProcessExitCode
  Assert-NgtAcceptanceTest ($silentOutcome.Succeeded -and $silentOutcome.Stdout -eq "" -and $silentOutcome.Stderr -eq "") `
    "An intentionally silent zero-exit child did not pass."
  Assert-NgtAcceptanceProcessSucceeded -Outcome $silentOutcome

  $missingResult = Join-Path $testRoot "missing-result.txt"
  Assert-NgtAcceptanceFailure { Get-NgtAcceptanceChildExitCode -Path $missingResult } "missing"
  $emptyResult = Join-Path $testRoot "empty-result.txt"
  [System.IO.File]::WriteAllText($emptyResult, "", [System.Text.Encoding]::ASCII)
  Assert-NgtAcceptanceFailure { Get-NgtAcceptanceChildExitCode -Path $emptyResult } "empty"
  Assert-NgtAcceptanceFailure {
    Assert-NgtAcceptanceFileContent -Path $emptyResult -Expected "PASS" -Description "auth restart probe"
  } "empty"
  [System.IO.File]::WriteAllText($emptyResult, " PASS `r`n", [System.Text.Encoding]::ASCII)
  Assert-NgtAcceptanceFileContent -Path $emptyResult -Expected "PASS" -Description "auth restart probe"
  [System.IO.File]::WriteAllText($emptyResult, "not-an-exit-code", [System.Text.Encoding]::ASCII)
  Assert-NgtAcceptanceFailure { Get-NgtAcceptanceChildExitCode -Path $emptyResult } "invalid exit result"

  $nonzero = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot "nonzero-child" "" "" 17
  $nonzeroOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $nonzero.StdoutPath -StderrPath $nonzero.StderrPath `
    -ResultPath $nonzero.ResultPath -ProcessExitCode $nonzero.ProcessExitCode
  Assert-NgtAcceptanceTest (-not $nonzeroOutcome.Succeeded -and $nonzeroOutcome.ChildExitCode -eq 17 -and $nonzeroOutcome.ProcessExitCode -eq 17) `
    "A nonzero child exit did not fail with the real child and process exit codes."
  Assert-NgtAcceptanceFailure { Assert-NgtAcceptanceProcessSucceeded -Outcome $nonzeroOutcome } "child exit code 17"
  $mismatched = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot `
    "mismatched-exit-codes" "" "" 0 -ResultExitCode 17
  $mismatchedOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $mismatched.StdoutPath -StderrPath $mismatched.StderrPath `
    -ResultPath $mismatched.ResultPath -ProcessExitCode $mismatched.ProcessExitCode
  Assert-NgtAcceptanceTest (-not $mismatchedOutcome.Succeeded -and
    $mismatchedOutcome.ChildExitCode -eq 17 -and $mismatchedOutcome.ProcessExitCode -eq 0 -and
    $mismatchedOutcome.FailureMessage -match "disagrees") `
    "Mismatched result-file and operating-system exit codes did not fail explicitly."
  $zero = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot "zero-child" "" "" 0
  $zeroOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $zero.StdoutPath -StderrPath $zero.StderrPath `
    -ResultPath $zero.ResultPath -ProcessExitCode $zero.ProcessExitCode
  Assert-NgtAcceptanceTest $zeroOutcome.Succeeded "A zero-exit child was reported as failed."
  Assert-NgtAcceptanceProcessSucceeded -Outcome $zeroOutcome

  $credentialText = "child error: $ghToken`ntemporary password: $passwordPlain"
  $tokenCase = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot "credentials-in-stdout" $credentialText "" 0
  Assert-NgtAcceptanceFailure {
    Get-NgtAcceptanceProcessOutcome -Acceptance "test" -StdoutPath $tokenCase.StdoutPath `
      -StderrPath $tokenCase.StderrPath -ResultPath $tokenCase.ResultPath `
      -ProcessExitCode $tokenCase.ProcessExitCode -Secrets $diagnosticSecrets
  } "protected credential was exposed"

  $passwordCase = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot `
    "password-in-stderr" "" "temporary password: $passwordPlain" 0
  Assert-NgtAcceptanceFailure {
    Get-NgtAcceptanceProcessOutcome -Acceptance "test" -StdoutPath $passwordCase.StdoutPath `
      -StderrPath $passwordCase.StderrPath -ResultPath $passwordCase.ResultPath `
      -ProcessExitCode $passwordCase.ProcessExitCode -Secrets $diagnosticSecrets
  } "protected credential was exposed"

  $childException = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot `
    "sensitive-child-exception" "" "" 23 "child error: $ghToken`ntemporary password: $passwordPlain"
  $childExceptionOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $childException.StdoutPath -StderrPath $childException.StderrPath `
    -ResultPath $childException.ResultPath -ProcessExitCode $childException.ProcessExitCode `
    -Secrets $diagnosticSecrets
  Assert-NgtAcceptanceTest (-not $childExceptionOutcome.Succeeded -and
    $childExceptionOutcome.ChildExitCode -eq 23 -and
    $childExceptionOutcome.ProcessExitCode -eq 23) `
    "The child exception did not preserve a real nonzero process result."
  Assert-NgtAcceptanceTest ($childExceptionOutcome.Stderr.Contains("The standard-user child failed; structured details are stored for parent-side sanitization.")) `
    "The child exception omitted its safe stderr summary."
  foreach ($secret in $diagnosticSecrets) {
    Assert-NgtAcceptanceTest (-not $childExceptionOutcome.Stderr.Contains($secret)) `
      "The child exception wrote a protected value to the redirected stderr log."
  }
  $childFailureText = [System.IO.File]::ReadAllText($childException.FailurePath)
  $childFailure = $childFailureText | ConvertFrom-Json
  Assert-NgtAcceptanceFailure {
    Assert-NgtAcceptanceTokenNotExposed -Paths @($childException.FailurePath) -Secrets $diagnosticSecrets
  } "protected credential was exposed"
  $actualChildExitCode = Get-NgtAcceptanceChildExitCode -Path $childException.ResultPath
  Assert-NgtAcceptanceTest ($childFailure.type -eq "System.InvalidOperationException" -and $childFailure.line -gt 0) `
    "The real PowerShell child did not preserve its exception type and source line."
  Assert-NgtAcceptanceTest ($actualChildExitCode -eq 23 -and $childException.ProcessExitCode -eq 23) `
    "The real PowerShell child did not preserve its nonzero exit code."

  $cleanupFailures = New-Object 'System.Collections.Generic.List[object]'
  try { throw "primary acceptance failure: $githubToken" } catch { $primaryFailure = $_ }
  try { throw "temporary credential cleanup failure: $passwordPlain" }
  catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "temporary credential cleanup" -ErrorRecord $_ }
  Assert-NgtAcceptanceFailure { Assert-NgtAcceptanceCleanupSucceeded -Failures $cleanupFailures } "temporary credential cleanup"
  $safeConsoleMessage = Get-NgtAcceptanceSafeFailureMessage -Acceptance "manual-installer" `
    -Message $primaryFailure.Exception.Message -Secrets $diagnosticSecrets
  try { throw $safeConsoleMessage } catch { $thrownConsoleMessage = $_.Exception.Message }
  foreach ($secret in $diagnosticSecrets) {
    Assert-NgtAcceptanceTest (-not $safeConsoleMessage.Contains($secret)) `
      "The safe console failure message still contains a protected value."
    Assert-NgtAcceptanceTest (-not $thrownConsoleMessage.Contains($secret)) `
      "The thrown console failure still contains a protected value."
  }
  $tokenStdout = (Read-NgtAcceptanceTextFile -Path $tokenCase.StdoutPath).Text
  $passwordStderr = (Read-NgtAcceptanceTextFile -Path $passwordCase.StderrPath).Text
  Write-NgtAcceptanceFailureDiagnostic -Path $diagnosticPath -Acceptance "manual-installer" `
    -FailureRecord $primaryFailure -ChildFailure $childFailure -CleanupFailures $cleanupFailures.ToArray() `
    -Stdout $tokenStdout -Stderr $passwordStderr -ChildExitCode $actualChildExitCode `
    -ProcessExitCode $childException.ProcessExitCode -Secrets $diagnosticSecrets `
    -AdditionalDiagnostics @($credentialText)
  $diagnostic = [System.IO.File]::ReadAllText($diagnosticPath) | ConvertFrom-Json
  Assert-NgtAcceptanceTest ($diagnostic.primaryFailure.type -eq "System.Management.Automation.RuntimeException") `
    "The diagnostic did not preserve the first exception type."
  Assert-NgtAcceptanceTest ($diagnostic.primaryFailure.message -eq "primary acceptance failure: [REDACTED]") `
    "The diagnostic did not preserve the first exception message with credentials redacted."
  Assert-NgtAcceptanceTest ($diagnostic.primaryFailure.line -gt 0 -and $diagnostic.primaryFailure.scriptStackTrace) `
    "The diagnostic did not preserve the first exception script line/stack."
  Assert-NgtAcceptanceTest ($diagnostic.primaryFailure.script -eq $PSCommandPath) `
    "The diagnostic did not preserve the first exception script path."
  Assert-NgtAcceptanceTest ($diagnostic.childFailure.type -eq "System.InvalidOperationException" -and
    $diagnostic.childFailure.script -eq $childScript -and
    $diagnostic.childFailure.line -gt 0 -and
    $diagnostic.childFailure.scriptStackTrace) `
    "The diagnostic did not preserve the child exception type and script line."
  Assert-NgtAcceptanceTest ($diagnostic.childFailure.message -eq "child error: [REDACTED]`ntemporary password: [REDACTED]") `
    "The child error did not retain its content with all credentials redacted."
  Assert-NgtAcceptanceTest ($diagnostic.cleanupFailures.Count -eq 1 -and
    $diagnostic.cleanupFailures[0].message -eq "temporary credential cleanup failure: [REDACTED]") `
    "Cleanup failure details were not retained alongside the primary failure."
  Assert-NgtAcceptanceTest ($diagnostic.childExitCode -eq 23 -and $diagnostic.processExitCode -eq 23) `
    "The failure diagnostic did not retain the real child and process exit codes."
  $diagnosticJson = [System.IO.File]::ReadAllText($diagnosticPath)
  foreach ($secret in $diagnosticSecrets) {
    Assert-NgtAcceptanceTest (-not $diagnosticJson.Contains($secret)) `
      "A protected value was present in the sanitized failure diagnostic."
  }
  Assert-NgtAcceptanceTest ($diagnostic.stdout.Contains("child error: [REDACTED]") -and
    $diagnostic.stderr.Contains("temporary password: [REDACTED]") -and
    $diagnostic.additionalDiagnostics[0].Contains("temporary password: [REDACTED]")) `
    "The diagnostic artifact did not redact logs and additional diagnostics consistently."

  $occupiedDirectory = Join-Path $testRoot "occupied-diagnostic-directory"
  New-Item -ItemType Directory -Path $occupiedDirectory -Force | Out-Null
  $writeFailures = New-Object 'System.Collections.Generic.List[object]'
  try {
    Write-NgtAcceptanceFailureDiagnostic -Path (Join-Path $occupiedDirectory "failure.json") `
      -Acceptance "manual-installer" -FailureRecord $primaryFailure -Secrets $diagnosticSecrets
  } catch {
    Add-NgtAcceptanceCleanupFailure -Failures $writeFailures -Step "failure artifact generation" -ErrorRecord $_
  }
  Assert-NgtAcceptanceTest ($writeFailures.Count -eq 1) "Injected diagnostic write failure was not recorded."
  Assert-NgtAcceptanceFailure { Assert-NgtAcceptanceCleanupSucceeded -Failures $writeFailures } "failure artifact generation"

  $originalProtector = (Get-Command Protect-NgtAcceptanceDiagnosticText -CommandType Function).ScriptBlock
  $unsafeDiagnosticPath = Join-Path $testRoot "unsafe-diagnostics\failure.json"
  Set-Item Function:Protect-NgtAcceptanceDiagnosticText -Value { throw "injected sanitization failure" }
  try {
    Assert-NgtAcceptanceFailure {
      Write-NgtAcceptanceFailureDiagnostic -Path $unsafeDiagnosticPath `
        -Acceptance "manual-installer" -FailureRecord $primaryFailure -Secrets $diagnosticSecrets
    } "injected sanitization failure"
    Assert-NgtAcceptanceTest (-not (Test-Path -LiteralPath $unsafeDiagnosticPath)) `
      "An unsanitized diagnostic file was created after sanitization failed."
  } finally {
    Set-Item Function:Protect-NgtAcceptanceDiagnosticText -Value $originalProtector
  }

  $timeout = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $nonzero.StdoutPath -StderrPath $nonzero.StderrPath `
    -ResultPath $nonzero.ResultPath -ProcessExitCode $nonzero.ProcessExitCode -TimedOut
  Assert-NgtAcceptanceTest (-not $timeout.Succeeded -and $timeout.FailureMessage -match "timeout") `
    "A timed-out acceptance did not fail explicitly."
  Assert-NgtAcceptanceTest ($timeout.ChildExitCode -eq 17 -and $timeout.ProcessExitCode -eq 17) `
    "The timeout diagnostic discarded available child or process exit codes."
  Assert-NgtAcceptanceFailure { Assert-NgtAcceptanceProcessSucceeded -Outcome $timeout } "timeout"
  $missingTimeout = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $normal.StdoutPath -StderrPath $normal.StderrPath `
    -ResultPath (Join-Path $testRoot "timeout-result-must-not-be-read.txt") `
    -ProcessExitCode $null -TimedOut
  Assert-NgtAcceptanceTest ($missingTimeout.FailureMessage -match "timeout" -and $missingTimeout.FailureMessage -match "missing") `
    "A timeout did not retain the missing child-result diagnosis."

  Write-Output "Windows PowerShell 5.1 acceptance coordinator behavior tests passed."
} finally {
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
