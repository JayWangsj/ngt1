param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("online-update", "installer-acceptance")]
  [string]$Stage,
  [Parameter(Mandatory = $true)]
  [string]$Tag,
  [Parameter(Mandatory = $true)]
  [string]$Commit,
  [string]$Version = "",
  [string]$Message = "",
  [string[]]$SourcePaths = @(),
  [switch]$EmitToConsole,
  [string]$OutputDirectory = (Join-Path $env:RUNNER_TEMP ("ngt-" + $Stage + "-diagnostics"))
)
$ErrorActionPreference = "Stop"

function Protect-DiagnosticText([string]$Text) {
  $safe = $Text
  $safe = [regex]::Replace($safe, "(?is)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", "[REDACTED PRIVATE KEY]")
  $safe = [regex]::Replace($safe, '(?i)(password|secret|token|authorization)(\s*[:=]\s*)[^\s,;"]+', '$1$2[REDACTED]')
  $safe = [regex]::Replace($safe, 'github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,}', '[REDACTED TOKEN]')
  $safe = [regex]::Replace($safe, "(?i)(postgres(?:ql)?://)[^:/\s]+:[^@/\s]+@", '$1[REDACTED]@')
  $safe = [regex]::Replace($safe, "(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]")
  if ($safe.Length -gt 700000) { $safe = $safe.Substring($safe.Length - 700000) }
  return $safe
}

function Write-NgtDiagnosticExcerpt([string]$Name, [string]$Text) {
  $lines = @($Text -split "\r?\n")
  $excerptLines = @($lines | Select-Object -First 30)
  $failureLines = @($lines | Where-Object {
      $_ -match '(?i)\b(error|failed?|failure|exception|denied|cannot|fatal|rollback|exit code)\b'
    } | Select-Object -First 40)
  if ($failureLines.Count -gt 0) {
    $excerptLines += "-- lines matching failure indicators --"
    $excerptLines += $failureLines
  }
  $excerptLines += @($lines | Select-Object -Last 40)
  $excerpt = [string]::Join("`n", @($excerptLines | Select-Object -Unique))
  if ($excerpt.Length -gt 20000) { $excerpt = $excerpt.Substring(0, 20000) }
  Write-Output ("Sanitized release acceptance diagnostic ({0}, start, failure indicators, and tail):" -f $Name)
  Write-Output $excerpt
}

if ($Tag -notmatch '^v\d+\.\d+\.\d+$' -or $Commit -notmatch '^[a-fA-F0-9]{40}$') {
  throw "Refusing to write diagnostics with invalid release identity."
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
foreach ($sourcePath in $SourcePaths) {
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
  $name = switch ($Stage) {
    "online-update" {
      if ((Split-Path -Leaf $sourcePath) -eq "online-update.log") { "online-update.log" }
      elseif ((Split-Path -Leaf $sourcePath) -eq "update-status.json") { "update-status.json" }
      elseif ((Split-Path -Leaf $sourcePath) -match '^update-.+\.inno\.log$') { "online-installer.inno.log" }
      elseif ((Split-Path -Leaf $sourcePath) -in @("manual-upgrade-installer.log", "manual-repair-installer.log", "install-preflight.log", "install.log", "install-stages.log", "studio-database.log", "studio-database.error.log", "supervisor.error.log", "database.log", "database.error.log", "application.log", "application.error.log")) { Split-Path -Leaf $sourcePath }
      else { $null }
    }
    "installer-acceptance" {
      if ((Split-Path -Leaf $sourcePath) -in @("installer.log", "install.log", "install-stages.log", "studio-database.log", "studio-database.error.log", "supervisor.error.log", "database.log", "database.error.log", "application.log", "application.error.log")) { Split-Path -Leaf $sourcePath }
      else { $null }
    }
  }
  if (-not $name) { continue }
  try {
    $stream = [System.IO.File]::Open($sourcePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    try {
      $reader = [System.IO.StreamReader]::new($stream)
      try { $text = Protect-DiagnosticText $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
    [System.IO.File]::WriteAllText((Join-Path $OutputDirectory $name), $text, [System.Text.UTF8Encoding]::new($false))
    if ($EmitToConsole) { Write-NgtDiagnosticExcerpt -Name $name -Text $text }
  } catch {
    Write-Warning ("Could not read diagnostic {0}: {1}" -f $name, $_.Exception.Message)
  }
}
$summary = [ordered]@{
  stage = $Stage
  tag = $Tag
  version = $Version
  commit = $Commit.ToLowerInvariant()
  runId = $env:GITHUB_RUN_ID
  runnerOs = $env:RUNNER_OS
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  message = Protect-DiagnosticText $Message
}
[System.IO.File]::WriteAllText(
  (Join-Path $OutputDirectory "summary.json"),
  ($summary | ConvertTo-Json -Depth 4),
  [System.Text.UTF8Encoding]::new($false)
)
if ($EmitToConsole) {
  Write-NgtDiagnosticExcerpt -Name "summary.json" -Text ($summary | ConvertTo-Json -Depth 4)
}
