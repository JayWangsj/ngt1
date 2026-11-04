function Read-NgtAcceptanceTextFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [switch]$Required,
    [switch]$NonEmpty
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    if ($Required) { throw "Required acceptance file is missing: $Path" }
    return [pscustomobject]@{ Exists = $false; Text = "" }
  }
  try {
    $text = [System.IO.File]::ReadAllText($Path)
  } catch {
    throw "Could not read acceptance file '$Path': $($_.Exception.Message)"
  }
  if ($NonEmpty -and [string]::IsNullOrWhiteSpace($text)) {
    throw "Required acceptance file is empty: $Path"
  }
  return [pscustomobject]@{ Exists = $true; Text = $text }
}

function Get-NgtAcceptanceChildExitCode {
  param([Parameter(Mandatory = $true)][string]$Path)

  $file = Read-NgtAcceptanceTextFile -Path $Path -Required -NonEmpty
  $value = $file.Text.Trim()
  if ($value -notmatch '^(0|[1-9][0-9]{0,9})$') {
    throw "The standard-user acceptance wrote an invalid exit result."
  }
  [int]$exitCode = 0
  if (-not [int]::TryParse($value, [ref]$exitCode)) {
    throw "The standard-user acceptance wrote an invalid exit result."
  }
  return $exitCode
}

function Assert-NgtAcceptanceFileContent {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $file = Read-NgtAcceptanceTextFile -Path $Path -Required -NonEmpty
  if ($file.Text.Trim() -cne $Expected) {
    throw "$Description did not contain the expected result."
  }
}

function Assert-NgtAcceptanceTokenNotExposed {
  param(
    [Parameter(Mandatory = $true)][string[]]$Paths,
    [string[]]$Secrets = @()
  )

  foreach ($secret in $Secrets) {
    if ([string]::IsNullOrEmpty($secret)) { continue }
    foreach ($path in $Paths) {
      $file = Read-NgtAcceptanceTextFile -Path $path
      if ($file.Exists -and $file.Text.IndexOf($secret, [System.StringComparison]::Ordinal) -ge 0) {
        throw "A protected credential was exposed in standard-user acceptance diagnostics."
      }
    }
  }
}

function Get-NgtAcceptanceProcessHandle {
  param([Parameter(Mandatory = $true)][AllowNull()][object]$Process)

  if ($null -eq $Process) {
    throw "Standard-user acceptance did not return a process object."
  }
  try {
    $processHandle = $Process.Handle
  } catch {
    throw "Standard-user acceptance process handle is unavailable."
  }
  if ($null -eq $processHandle -or $processHandle -eq [IntPtr]::Zero) {
    throw "Standard-user acceptance process handle is unavailable."
  }
  return $processHandle
}

function Get-NgtAcceptanceProcessExitCode {
  param([Parameter(Mandatory = $true)][AllowNull()][object]$Process)

  if ($null -eq $Process) {
    throw "Standard-user acceptance process object is unavailable."
  }
  try {
    $Process.Refresh()
    $hasExited = $Process.HasExited
  } catch {
    throw "Standard-user acceptance process exit code is unavailable."
  }
  if (-not $hasExited) { throw "Standard-user acceptance process has not exited." }
  try { $processExitCode = $Process.ExitCode }
  catch { throw "Standard-user acceptance process exit code is unavailable." }
  if ($null -eq $processExitCode) {
    throw "Standard-user acceptance process exit code is unavailable."
  }
  return [int]$processExitCode
}

function Get-NgtAcceptanceProcessOutcome {
  param(
    [Parameter(Mandatory = $true)][string]$Acceptance,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [Parameter(Mandatory = $true)][string]$ResultPath,
    [Parameter(Mandatory = $true)][AllowNull()][object]$ProcessExitCode,
    [string[]]$Secrets = @(),
    [switch]$TimedOut
  )

  $stdout = Read-NgtAcceptanceTextFile -Path $StdoutPath
  $stderr = Read-NgtAcceptanceTextFile -Path $StderrPath
  Assert-NgtAcceptanceTokenNotExposed -Paths @($StdoutPath, $StderrPath, $ResultPath) -Secrets $Secrets
  $childExitCode = $null
  $resultFailure = $null
  if ($TimedOut) {
    try { $childExitCode = Get-NgtAcceptanceChildExitCode -Path $ResultPath }
    catch { $resultFailure = $_.Exception.Message }
  } else {
    $childExitCode = Get-NgtAcceptanceChildExitCode -Path $ResultPath
  }
  $failureMessage = $null
  if ($TimedOut) {
    $failureMessage = "The standard-user $Acceptance acceptance exceeded its 110-minute timeout."
    if ($resultFailure) { $failureMessage += " Exit result: $resultFailure" }
  } elseif ($null -eq $ProcessExitCode) {
    $failureMessage = "The standard-user $Acceptance acceptance process exit code is unavailable."
  } elseif ($childExitCode -ne $ProcessExitCode) {
    $failureMessage = "The standard-user $Acceptance acceptance result exit code $childExitCode disagrees with process exit code $ProcessExitCode."
  } elseif ($childExitCode -ne 0 -or $ProcessExitCode -ne 0) {
    $failureMessage = "The standard-user $Acceptance acceptance failed with child exit code $childExitCode and process exit code $ProcessExitCode."
  }
  return [pscustomobject]@{
    Stdout = $stdout.Text
    Stderr = $stderr.Text
    ChildExitCode = $childExitCode
    ProcessExitCode = $ProcessExitCode
    Succeeded = ($null -eq $failureMessage)
    FailureMessage = $failureMessage
  }
}

function Assert-NgtAcceptanceProcessSucceeded {
  param([Parameter(Mandatory = $true)]$Outcome)

  if (-not $Outcome.Succeeded) { throw $Outcome.FailureMessage }
}

function Add-NgtAcceptanceCleanupFailure {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Failures,
    [Parameter(Mandatory = $true)][string]$Step,
    [Parameter(Mandatory = $true)]$ErrorRecord
  )

  $Failures.Add([pscustomobject]@{ Step = $Step; ErrorRecord = $ErrorRecord })
}

function Assert-NgtAcceptanceCleanupSucceeded {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Failures
  )

  if ($Failures.Count -gt 0) {
    $steps = ($Failures | ForEach-Object { $_.Step }) -join ", "
    throw "The standard-user acceptance failed during cleanup or failure diagnostics: $steps."
  }
}

function Protect-NgtAcceptanceDiagnosticText {
  param(
    [AllowNull()][string]$Text,
    [string[]]$Secrets = @()
  )

  $safe = if ($null -eq $Text) { "" } else { $Text }
  foreach ($secret in $Secrets) {
    if (-not [string]::IsNullOrEmpty($secret)) {
      $safe = $safe.Replace($secret, "[REDACTED]")
    }
  }
  $safe = [regex]::Replace($safe, '(?i)(oauth_token\s*:\s*)[^\s,;]+', '$1[REDACTED]')
  $safe = [regex]::Replace($safe, '(?i)(\b(?:GH_TOKEN|GITHUB_TOKEN|password|secret|authorization)\b\s*[:=]\s*)[^\s,;]+', '$1[REDACTED]')
  $safe = [regex]::Replace($safe, '(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]')
  $safe = [regex]::Replace($safe, 'github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,}', '[REDACTED TOKEN]')
  if ($safe.Length -gt 100000) { $safe = $safe.Substring($safe.Length - 100000) }
  return $safe
}

function Get-NgtAcceptanceSafeFailureMessage {
  param(
    [Parameter(Mandatory = $true)][string]$Acceptance,
    [AllowNull()][string]$Message,
    [string[]]$Secrets = @()
  )

  try {
    $safeMessage = Protect-NgtAcceptanceDiagnosticText -Text $Message -Secrets $Secrets
    foreach ($secret in $Secrets) {
      if (-not [string]::IsNullOrEmpty($secret) -and
          $safeMessage.IndexOf($secret, [System.StringComparison]::Ordinal) -ge 0) {
        throw "Sensitive text remained after sanitization."
      }
    }
    return "The standard-user $Acceptance acceptance failed: $safeMessage"
  } catch {
    return "The standard-user $Acceptance acceptance failed; the error details were withheld because they could not be safely sanitized."
  }
}

function Write-NgtAcceptanceFailureDiagnostic {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Acceptance,
    $FailureRecord,
    $ChildFailure,
    [object[]]$CleanupFailures = @(),
    [AllowNull()][string]$Stdout = "",
    [AllowNull()][string]$Stderr = "",
    [AllowNull()][object]$ChildExitCode,
    [AllowNull()][object]$ProcessExitCode,
    [switch]$TimedOut,
    [string[]]$Secrets = @(),
    [string[]]$AdditionalDiagnostics = @()
  )

  $primary = $null
  if ($FailureRecord) {
    $invocation = $FailureRecord.InvocationInfo
    $primary = [ordered]@{
      type = Protect-NgtAcceptanceDiagnosticText -Text $FailureRecord.Exception.GetType().FullName -Secrets $Secrets
      message = Protect-NgtAcceptanceDiagnosticText -Text $FailureRecord.Exception.Message -Secrets $Secrets
      script = Protect-NgtAcceptanceDiagnosticText -Text $invocation.ScriptName -Secrets $Secrets
      line = $invocation.ScriptLineNumber
      sourceLine = Protect-NgtAcceptanceDiagnosticText -Text $invocation.Line -Secrets $Secrets
      position = Protect-NgtAcceptanceDiagnosticText -Text $invocation.PositionMessage -Secrets $Secrets
      scriptStackTrace = Protect-NgtAcceptanceDiagnosticText -Text $FailureRecord.ScriptStackTrace -Secrets $Secrets
    }
  }
  $child = $null
  if ($ChildFailure) {
    $child = [ordered]@{
      type = Protect-NgtAcceptanceDiagnosticText -Text $ChildFailure.type -Secrets $Secrets
      message = Protect-NgtAcceptanceDiagnosticText -Text $ChildFailure.message -Secrets $Secrets
      script = Protect-NgtAcceptanceDiagnosticText -Text $ChildFailure.script -Secrets $Secrets
      line = $ChildFailure.line
      sourceLine = Protect-NgtAcceptanceDiagnosticText -Text $ChildFailure.sourceLine -Secrets $Secrets
      position = Protect-NgtAcceptanceDiagnosticText -Text $ChildFailure.position -Secrets $Secrets
      scriptStackTrace = Protect-NgtAcceptanceDiagnosticText -Text $ChildFailure.scriptStackTrace -Secrets $Secrets
    }
  }
  $cleanup = @(
    foreach ($failure in $CleanupFailures) {
      [ordered]@{
        step = Protect-NgtAcceptanceDiagnosticText -Text $failure.Step -Secrets $Secrets
        type = Protect-NgtAcceptanceDiagnosticText -Text $failure.ErrorRecord.Exception.GetType().FullName -Secrets $Secrets
        message = Protect-NgtAcceptanceDiagnosticText -Text $failure.ErrorRecord.Exception.Message -Secrets $Secrets
        scriptStackTrace = Protect-NgtAcceptanceDiagnosticText -Text $failure.ErrorRecord.ScriptStackTrace -Secrets $Secrets
      }
    }
  )
  $details = @(
    foreach ($entry in $AdditionalDiagnostics) {
      Protect-NgtAcceptanceDiagnosticText -Text $entry -Secrets $Secrets
    }
  )
  $report = [ordered]@{
    acceptance = $Acceptance
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    primaryFailure = $primary
    childFailure = $child
    childExitCode = $ChildExitCode
    processExitCode = $ProcessExitCode
    timedOut = [bool]$TimedOut
    cleanupFailures = $cleanup
    stdout = Protect-NgtAcceptanceDiagnosticText -Text $Stdout -Secrets $Secrets
    stderr = Protect-NgtAcceptanceDiagnosticText -Text $Stderr -Secrets $Secrets
    additionalDiagnostics = $details
  }
  $json = $report | ConvertTo-Json -Depth 8
  foreach ($secret in $Secrets) {
    if (-not [string]::IsNullOrEmpty($secret) -and $json.IndexOf($secret, [System.StringComparison]::Ordinal) -ge 0) {
      throw "Refusing to write an acceptance diagnostic that still contains a protected credential."
    }
  }
  $directory = Split-Path -Parent $Path
  if (Test-Path -LiteralPath $directory) {
    throw "Refusing to add acceptance diagnostics to an existing artifact directory."
  }
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}
