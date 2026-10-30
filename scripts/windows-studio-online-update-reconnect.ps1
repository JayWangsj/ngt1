function Assert-NgtOnlineUpdateState {
  param(
    [Parameter(Mandatory = $true)][object]$State,
    [Parameter(Mandatory = $true)][string]$ExpectedUpdateId,
    [Parameter(Mandatory = $true)][string]$TargetVersion,
    [Parameter(Mandatory = $true)][string]$Source,
    [switch]$AllowVerifyingTask
  )

  if (-not [string]::Equals([string]$State.updateId, $ExpectedUpdateId, [System.StringComparison]::Ordinal)) {
    throw "$Source update state belongs to a different update task."
  }
  if (-not [string]::Equals([string]$State.targetVersion, $TargetVersion, [System.StringComparison]::Ordinal)) {
    throw "$Source update state targets a different version."
  }

  $status = [string]$State.status
  $stage = [string]$State.stage
  if ([string]::IsNullOrWhiteSpace($status) -or [string]::IsNullOrWhiteSpace($stage)) {
    throw "$Source update state has no interpretable status and stage."
  }
  if ($status -ceq "failed") {
    throw "$Source update state reports failure at stage '$stage'."
  }
  if ($AllowVerifyingTask -and $status -ceq "verifying-task") {
    if ($stage -notin @("starting", "checking", "reading-release", "downloading", "downloaded", "verifying", "starting-installer", "backing-up", "preparing-release", "verifying-backup", "preparing-runtime", "installing", "validating", "rolling-back", "complete")) {
      throw "$Source update state has an unknown verification stage ('$stage')."
    }
    if ($stage -ceq "complete" -and
        -not [string]::Equals([string]$State.actualVersion, $TargetVersion, [System.StringComparison]::Ordinal)) {
      throw "$Source update state has an invalid completed actual version."
    }
    return $false
  }
  if ($status -ceq $stage -and $stage -cin @("starting", "queued", "checking", "reading-release", "downloading", "downloaded", "verifying", "starting-installer", "backing-up", "preparing-release", "verifying-backup", "preparing-runtime", "installing", "validating", "rolling-back")) {
    return $false
  }
  if ($status -ceq "complete") {
    if ($stage -cne "complete" -or
        -not [string]::Equals([string]$State.actualVersion, $TargetVersion, [System.StringComparison]::Ordinal)) {
      throw "$Source update state has an invalid completed status, stage, or actual version."
    }
    return $true
  }
  if ($stage -ceq "complete") {
    throw "$Source update state has a completed stage without completed status."
  }

  $stageByStatus = @{
    starting = @("starting")
    queued = @("starting", "queued")
    running = @("checking", "reading-release", "starting-installer")
    checking = @("checking", "reading-release")
    downloading = @("downloading")
    downloaded = @("downloaded")
    verifying = @("verifying")
    installing = @("backing-up", "preparing-release", "verifying-backup", "preparing-runtime", "installing")
    validating = @("validating")
    "rolling-back" = @("rolling-back")
  }
  if (-not $stageByStatus.ContainsKey($status) -or $stage -cnotin $stageByStatus[$status]) {
    throw "$Source update state has an unknown or inconsistent status/stage transition ('$status'/'$stage')."
  }
  return $false
}

function Read-NgtOnlineUpdateStatusFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedUpdateId,
    [Parameter(Mandatory = $true)][string]$TargetVersion
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "The persisted online update state file is missing."
  }
  $json = [System.IO.File]::ReadAllText($Path)
  if ([string]::IsNullOrWhiteSpace($json)) {
    throw "The persisted online update state file is empty."
  }
  try {
    $state = ConvertFrom-Json -InputObject $json -ErrorAction Stop
  } catch {
    throw "The persisted online update state file is not valid JSON."
  }
  if ($null -eq $state -or $state -is [System.Array] -or $state -is [string]) {
    throw "The persisted online update state is not a JSON object."
  }
  [void](Assert-NgtOnlineUpdateState -State $state -ExpectedUpdateId $ExpectedUpdateId `
    -TargetVersion $TargetVersion -Source "Persisted")
  return $state
}

function Get-NgtOnlineUpdateReconnectDecision {
  param(
    [Parameter(Mandatory = $true)][object]$PersistedStatus,
    [Parameter(Mandatory = $true)][bool]$ApiAvailable,
    [object]$LiveStatus,
    [Parameter(Mandatory = $true)][string]$UpdateId,
    [Parameter(Mandatory = $true)][string]$TargetVersion,
    [Parameter(Mandatory = $true)][bool]$ApiDisconnectedObserved,
    [Parameter(Mandatory = $true)][bool]$ApiReconnectedAfterDisconnect,
    [Parameter(Mandatory = $true)][bool]$UpdaterHasExited,
    [object]$UpdaterExitCode
  )

  $persistedComplete = Assert-NgtOnlineUpdateState -State $PersistedStatus `
    -ExpectedUpdateId $UpdateId -TargetVersion $TargetVersion -Source "Persisted"
  $disconnected = $ApiDisconnectedObserved -or -not $ApiAvailable
  $reconnected = $ApiReconnectedAfterDisconnect -or ($ApiDisconnectedObserved -and $ApiAvailable)
  $apiComplete = $false

  if ($ApiAvailable) {
    if ($null -eq $LiveStatus) { throw "The update API returned no status after connecting." }
    $apiComplete = Assert-NgtOnlineUpdateState -State $LiveStatus -ExpectedUpdateId $UpdateId `
      -TargetVersion $TargetVersion -Source "Live API" -AllowVerifyingTask
  }
  if ($UpdaterHasExited) {
    if ($null -eq $UpdaterExitCode) { throw "The Rust updater exited without an operating-system exit code." }
    if ($UpdaterExitCode -ne 0) { throw "The Rust updater exited with code $UpdaterExitCode." }
    if (-not $persistedComplete) { throw "The Rust updater exited before persisted state reached complete." }
  }
  if ($persistedComplete -and $ApiAvailable -and $UpdaterHasExited -and -not $apiComplete) {
    throw "The reconnected NGT API did not report complete after the Rust updater exited."
  }

  $shouldComplete = $persistedComplete -and $apiComplete -and $UpdaterHasExited -and
    $disconnected -and $reconnected
  return [pscustomobject]@{
    ShouldComplete = [bool]$shouldComplete
    ApiDisconnectedObserved = [bool]$disconnected
    ApiReconnectedAfterDisconnect = [bool]$reconnected
  }
}
