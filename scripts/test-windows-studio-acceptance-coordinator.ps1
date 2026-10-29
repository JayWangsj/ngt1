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

function Invoke-NgtAcceptanceTestChild {
  param(
    [string]$PowerShellPath,
    [string]$ChildScript,
    [string]$Root,
    [string]$Name,
    [string]$Stdout,
    [string]$Stderr,
    [int]$ExitCode
  )
  $caseRoot = Join-Path $Root $Name
  New-Item -ItemType Directory -Path $caseRoot -Force | Out-Null
  $configPath = Join-Path $caseRoot "child-config.json"
  $stdoutPath = Join-Path $caseRoot "stdout.log"
  $stderrPath = Join-Path $caseRoot "stderr.log"
  $resultPath = Join-Path $caseRoot "exit-code.txt"
  $config = [ordered]@{ stdout = $Stdout; stderr = $Stderr; exitCode = $ExitCode; resultPath = $resultPath }
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 3), [System.Text.UTF8Encoding]::new($false))
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $ChildScript + '" -ConfigPath "' + $configPath + '"'
  $process = Start-Process -FilePath $PowerShellPath -ArgumentList $arguments `
    -NoNewWindow -PassThru -Wait -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  return [pscustomobject]@{
    StdoutPath = $stdoutPath
    StderrPath = $stderrPath
    ResultPath = $resultPath
    ProcessExitCode = $process.ExitCode
  }
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-acceptance-coordinator-" + [guid]::NewGuid().ToString("N"))
$powerShellPath = Join-Path $PSHOME "powershell.exe"
$childScript = Join-Path $testRoot "child.ps1"
$token = "ngt-coordinator-regression-token-never-upload"
$diagnosticPath = Join-Path $testRoot "diagnostics\acceptance-failure.json"
try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  $childSource = @'
param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = "Stop"
$config = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
if (-not [string]::IsNullOrEmpty([string]$config.stdout)) { [Console]::Out.Write([string]$config.stdout) }
if (-not [string]::IsNullOrEmpty([string]$config.stderr)) { [Console]::Error.Write([string]$config.stderr) }
[System.IO.File]::WriteAllText([string]$config.resultPath, ([string]$config.exitCode + "`r`n"), [System.Text.Encoding]::ASCII)
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

  $nonzero = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot "nonzero-child" "" "" 19
  $nonzeroOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $nonzero.StdoutPath -StderrPath $nonzero.StderrPath `
    -ResultPath $nonzero.ResultPath -ProcessExitCode $nonzero.ProcessExitCode
  Assert-NgtAcceptanceTest (-not $nonzeroOutcome.Succeeded -and $nonzeroOutcome.ChildExitCode -eq 19 -and $nonzeroOutcome.ProcessExitCode -eq 19) `
    "A nonzero child exit did not fail with the real child and process exit codes."
  Assert-NgtAcceptanceFailure { Assert-NgtAcceptanceProcessSucceeded -Outcome $nonzeroOutcome } "child exit code 19"
  $zero = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot "zero-child" "" "" 0
  $zeroOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $zero.StdoutPath -StderrPath $zero.StderrPath `
    -ResultPath $zero.ResultPath -ProcessExitCode $zero.ProcessExitCode
  Assert-NgtAcceptanceTest $zeroOutcome.Succeeded "A zero-exit child was reported as failed."
  Assert-NgtAcceptanceProcessSucceeded -Outcome $zeroOutcome

  $tokenCase = Invoke-NgtAcceptanceTestChild $powerShellPath $childScript $testRoot "token-in-log" $token "" 0
  Assert-NgtAcceptanceFailure {
    Get-NgtAcceptanceProcessOutcome -Acceptance "test" -StdoutPath $tokenCase.StdoutPath `
      -StderrPath $tokenCase.StderrPath -ResultPath $tokenCase.ResultPath `
      -ProcessExitCode $tokenCase.ProcessExitCode -Tokens @($token)
  } "token was exposed"

  $cleanupFailures = New-Object 'System.Collections.Generic.List[object]'
  try { throw "primary acceptance failure" } catch { $primaryFailure = $_ }
  try { throw "temporary credential cleanup failure" }
  catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "temporary credential cleanup" -ErrorRecord $_ }
  Assert-NgtAcceptanceFailure { Assert-NgtAcceptanceCleanupSucceeded -Failures $cleanupFailures } "temporary credential cleanup"
  $tokenStdout = (Read-NgtAcceptanceTextFile -Path $tokenCase.StdoutPath).Text
  $childFailure = [pscustomobject]@{
    type = "System.InvalidOperationException"
    message = "child failure $token"
    script = "scripts/test-child.ps1"
    line = 42
    sourceLine = "throw 'child failure'"
    position = "At scripts/test-child.ps1:42 char:1"
    scriptStackTrace = "at scripts/test-child.ps1: line 42"
  }
  Write-NgtAcceptanceFailureDiagnostic -Path $diagnosticPath -Acceptance "manual-installer" `
    -FailureRecord $primaryFailure -ChildFailure $childFailure -CleanupFailures $cleanupFailures.ToArray() `
    -Stdout $tokenStdout -Stderr "" -ChildExitCode $nonzeroOutcome.ChildExitCode `
    -ProcessExitCode $nonzeroOutcome.ProcessExitCode `
    -Secrets @($token)
  $diagnostic = [System.IO.File]::ReadAllText($diagnosticPath) | ConvertFrom-Json
  Assert-NgtAcceptanceTest ($diagnostic.primaryFailure.type -eq "System.Management.Automation.RuntimeException") `
    "The diagnostic did not preserve the first exception type."
  Assert-NgtAcceptanceTest ($diagnostic.primaryFailure.message -eq "primary acceptance failure") `
    "The diagnostic did not preserve the first exception message."
  Assert-NgtAcceptanceTest ($diagnostic.primaryFailure.line -gt 0 -and $diagnostic.primaryFailure.scriptStackTrace) `
    "The diagnostic did not preserve the first exception script line/stack."
  Assert-NgtAcceptanceTest ($diagnostic.childFailure.type -eq "System.InvalidOperationException" -and $diagnostic.childFailure.line -eq 42) `
    "The diagnostic did not preserve the child exception type and script line."
  Assert-NgtAcceptanceTest ($diagnostic.childFailure.message -eq "child failure [REDACTED]") `
    "The child error was not retained with its credential redacted."
  Assert-NgtAcceptanceTest ($diagnostic.cleanupFailures.Count -eq 1 -and $diagnostic.cleanupFailures[0].message -eq "temporary credential cleanup failure") `
    "Cleanup failure details were not retained alongside the primary failure."
  Assert-NgtAcceptanceTest ($diagnostic.childExitCode -eq 19 -and $diagnostic.processExitCode -eq 19) `
    "The failure diagnostic did not retain the real child and process exit codes."
  Assert-NgtAcceptanceTest (-not [System.IO.File]::ReadAllText($diagnosticPath).Contains($token)) `
    "The token was present in the sanitized failure diagnostic."

  $timeout = Get-NgtAcceptanceProcessOutcome -Acceptance "test" `
    -StdoutPath $nonzero.StdoutPath -StderrPath $nonzero.StderrPath `
    -ResultPath $nonzero.ResultPath -ProcessExitCode $nonzero.ProcessExitCode -TimedOut
  Assert-NgtAcceptanceTest (-not $timeout.Succeeded -and $timeout.FailureMessage -match "timeout") `
    "A timed-out acceptance did not fail explicitly."
  Assert-NgtAcceptanceTest ($timeout.ChildExitCode -eq 19 -and $timeout.ProcessExitCode -eq 19) `
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
