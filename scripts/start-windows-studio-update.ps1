param(
  [Parameter(Mandatory = $true)]
  [string]$UpdaterScriptPath,
  [Parameter(Mandatory = $true)]
  [string]$UpdateId,
  [string]$ExpectedTargetVersion,
  [Parameter(Mandatory = $true)]
  [string]$StatusFile,
  [Parameter(Mandatory = $true)]
  [string]$UpdateLockFile,
  [Parameter(Mandatory = $true)]
  [string]$LogFile,
  [Parameter(Mandatory = $true)]
  [string]$DiagnosticFile
)

$ErrorActionPreference = "Stop"

function Protect-NgtBootstrapText([string]$Value) {
  return $Value `
    -replace '(?i)((?:"|'')?authorization(?:"|'')?\s*[:=]\s*)(?:"[^"]*"|''[^'']*''|[^\s,;}]+(?:\s+[^\s,;}]+)?)', '$1[redacted]' `
    -replace '(?i)((?:"|'')?(?:password|passwd|secret|token|api[_-]?key)(?:"|'')?\s*[:=]\s*)(?:"[^"]*"|''[^'']*''|[^\s,;}]+)', '$1[redacted]' `
    -replace '(?i)(?:postgres(?:ql)?|mysql)://[^\s"''<>]+', "[redacted connection string]" `
    -replace "github_pat_[A-Za-z0-9_]+", "[redacted token]" `
    -replace "gh[pousr]_[A-Za-z0-9]{20,}", "[redacted token]"
}

function Write-NgtBootstrapDiagnostic(
  [string]$Event,
  [string]$Message = ""
) {
  try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $DiagnosticFile) -Force | Out-Null
    $entry = [ordered]@{
      at = (Get-Date).ToUniversalTime().ToString("o")
      updateId = $UpdateId
      event = $Event
      pid = $PID
      scriptPath = [System.IO.Path]::GetFullPath($UpdaterScriptPath)
    }
    if ($Message) { $entry.message = Protect-NgtBootstrapText $Message }
    $line = ($entry | ConvertTo-Json -Compress -Depth 4) + [Environment]::NewLine
    [System.IO.File]::AppendAllText(
      $DiagnosticFile,
      $line,
      (New-Object System.Text.UTF8Encoding($false))
    )
  } catch {
    [Console]::Error.WriteLine("Could not persist update executor diagnostics.")
  }
}

function Invoke-NgtBootstrapOwnership([scriptblock]$Action) {
  $mutexRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $UpdateLockFile)).TrimEnd("\").ToLowerInvariant()
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $rootBytes = [System.Text.Encoding]::UTF8.GetBytes($mutexRoot)
    $rootHash = [System.BitConverter]::ToString($sha256.ComputeHash($rootBytes)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  $mutex = [System.Threading.Mutex]::new($false, "Global\NGTStudioUpdate-$rootHash")
  $owned = $false
  try {
    try { $owned = $mutex.WaitOne(10000) }
    catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { throw "Timed out waiting for the update lock." }
    if (-not (Test-Path -LiteralPath $UpdateLockFile -PathType Leaf)) { return $false }
    $lock = Get-Content -LiteralPath $UpdateLockFile -Raw | ConvertFrom-Json
    if ([string]$lock.updateId -ne $UpdateId) { return $false }
    return (& $Action)
  } finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Write-NgtBootstrapFailure([string]$Message) {
  try {
    return [bool](Invoke-NgtBootstrapOwnership {
      if (-not (Test-Path -LiteralPath $StatusFile -PathType Leaf)) { return $false }
      $status = Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json
      if ([string]$status.updateId -ne $UpdateId -or $status.status -in @("complete", "failed")) {
        return $false
      }

      $stage = if ($status.stage) { [string]$status.stage } else { "starting" }
      $status | Add-Member -NotePropertyName status -NotePropertyValue "failed" -Force
      $status | Add-Member -NotePropertyName stage -NotePropertyValue $stage -Force
      $status | Add-Member -NotePropertyName failedStage -NotePropertyValue $stage -Force
      $status | Add-Member -NotePropertyName message -NotePropertyValue (Protect-NgtBootstrapText $Message) -Force
      $status | Add-Member -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force
      $temporaryFile = "$StatusFile.$UpdateId.bootstrap.tmp"
      $backupFile = "$StatusFile.$UpdateId.$([guid]::NewGuid().ToString('N')).bak"
      [System.IO.File]::WriteAllText(
        $temporaryFile,
        ($status | ConvertTo-Json -Depth 8),
        (New-Object System.Text.UTF8Encoding($false))
      )
      try {
        [System.IO.File]::Replace($temporaryFile, $StatusFile, $backupFile)
      } finally {
        Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
      }
      Remove-Item -LiteralPath $UpdateLockFile -Force -ErrorAction SilentlyContinue
      return $true
    })
  } catch {
    Write-NgtBootstrapDiagnostic "failure-status-write-failed" $_.Exception.Message
    return $false
  }
}

Write-NgtBootstrapDiagnostic "script-started"
try {
  if (-not (Test-Path -LiteralPath $UpdaterScriptPath -PathType Leaf)) {
    throw "The update script is missing from the active release."
  }

  Write-NgtBootstrapDiagnostic "updater-invoking"
  & $UpdaterScriptPath `
    -UpdateId $UpdateId `
    -ExpectedTargetVersion $ExpectedTargetVersion `
    -StatusFile $StatusFile `
    -UpdateLockFile $UpdateLockFile `
    -LogFile $LogFile

  if (-not (Test-Path -LiteralPath $StatusFile -PathType Leaf)) {
    throw "The update script returned without writing task status."
  }
  $status = Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json
  if ([string]$status.updateId -ne $UpdateId) {
    throw "The update script returned with status for a different task."
  }
  if ($status.status -eq "failed") {
    throw "The update script recorded failure at $($status.failedStage): $($status.message)"
  }
  if ($status.status -ne "complete") {
    throw "The update script returned without a terminal status (current status: $($status.status))."
  }

  Write-NgtBootstrapDiagnostic "terminal-status-confirmed" "complete"
} catch {
  $message = Protect-NgtBootstrapText $_.Exception.Message
  Write-NgtBootstrapDiagnostic "executor-error" $message
  [void](Write-NgtBootstrapFailure $message)
  throw
}
