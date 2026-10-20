$ErrorActionPreference = "Stop"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-diagnostics-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$logPath = Join-Path $testRoot "application.log"
$updateTranscriptPath = Join-Path $testRoot ("update-" + [guid]::NewGuid().ToString() + ".log")
$updateLaunchPath = Join-Path $testRoot ("update-launch-" + [guid]::NewGuid().ToString() + ".jsonl")
$updateExecutorPath = Join-Path $testRoot ("update-executor-" + [guid]::NewGuid().ToString() + ".jsonl")
$legacyUpdaterProbePath = Join-Path $testRoot "legacy-updater-probe.jsonl"
$legacyUpdaterProcessProbePath = Join-Path $testRoot "legacy-updater-process-probe.jsonl"
$outputPath = Join-Path $testRoot "sanitized"
$writer = $null
try {
  $writer = [System.IO.File]::Open($logPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes("first failure: token=private-value`n")
  $writer.Write($bytes, 0, $bytes.Length)
  $writer.Flush()
  Set-Content -LiteralPath $updateTranscriptPath -Value "transcript failure: token=private-value" -Encoding utf8
  Set-Content -LiteralPath $updateLaunchPath -Value '{"event":"spawned","password":"private-value"}' -Encoding utf8
  Set-Content -LiteralPath $updateExecutorPath -Value '{"event":"bootstrap-started","authorization":"Bearer private-value"}' -Encoding utf8
  Set-Content -LiteralPath $legacyUpdaterProbePath -Value '{"event":"script-started","hasUpdateId":false}' -Encoding utf8
  Set-Content -LiteralPath $legacyUpdaterProcessProbePath -Value '{"event":"process-closed","exitCode":0,"password":"private-value"}' -Encoding utf8
  & (Join-Path $PSScriptRoot "write-windows-studio-diagnostics.ps1") `
    -Stage online-update -Tag v2.0.16 -Commit ("a" * 40) -Version 2.0.16 `
    -Message "failed at database: token=private-value" `
    -SourcePaths @($logPath, $updateTranscriptPath, $updateLaunchPath, $updateExecutorPath, $legacyUpdaterProbePath, $legacyUpdaterProcessProbePath) `
    -OutputDirectory $outputPath
  $sanitized = Get-Content -LiteralPath (Join-Path $outputPath "application.log") -Raw
  $transcript = Get-Content -LiteralPath (Join-Path $outputPath "update-transcript.log") -Raw
  $launch = Get-Content -LiteralPath (Join-Path $outputPath "update-launch.jsonl") -Raw
  $executor = Get-Content -LiteralPath (Join-Path $outputPath "update-executor.jsonl") -Raw
  $probe = Get-Content -LiteralPath (Join-Path $outputPath "update-executor-probe.jsonl") -Raw
  $processProbe = Get-Content -LiteralPath (Join-Path $outputPath "update-launch-process-probe.jsonl") -Raw
  $summary = Get-Content -LiteralPath (Join-Path $outputPath "summary.json") -Raw | ConvertFrom-Json
  if ($sanitized -notmatch "first failure" -or $sanitized -match "private-value") {
    throw "An application diagnostic was not retained and sanitized correctly."
  }
  if ($transcript -notmatch "transcript failure") { throw "The per-update transcript was not captured." }
  if ($launch -notmatch '"spawned"') { throw "The per-update launcher log was not captured." }
  if ($executor -notmatch '"bootstrap-started"') { throw "The per-update executor log was not captured." }
  if ($probe -notmatch '"hasUpdateId":false') { throw "The legacy updater startup probe was not captured." }
  if ($processProbe -notmatch '"exitCode":0') { throw "The legacy updater process probe was not captured." }
  if (($transcript + $launch + $executor + $probe + $processProbe + $summary.message) -match "private-value") {
    throw "A secret value was not redacted from per-update diagnostics."
  }
  if ($summary.commit -ne ("a" * 40)) { throw "Diagnostic release identity was not preserved." }
  Write-Output "Shared-open diagnostic capture and sanitization passed."
} finally {
  if ($writer) { $writer.Dispose() }
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}
