$ErrorActionPreference = "Stop"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-diagnostics-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$logPath = Join-Path $testRoot "application.log"
$statusPath = Join-Path $testRoot "update-status.json"
$runStatePath = Join-Path $testRoot "run-state.json"
$candidateRunPath = Join-Path $testRoot "candidate-run.json"
$runtimeDiagnosticsPath = Join-Path $testRoot "acceptance-runtime-diagnostics.log"
$activeManagerInstallerPath = Join-Path $testRoot "active-manager-reinstall.log"
$managerRunOutputPath = Join-Path $testRoot "acceptance-manager-run.stdout.log"
$outputPath = Join-Path $testRoot "sanitized"
$acceptanceOutputPath = Join-Path $testRoot "installer-acceptance-sanitized"
$writer = $null
try {
  $writer = [System.IO.File]::Open($logPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes("first failure: token=private-value`n")
  $writer.Write($bytes, 0, $bytes.Length)
  $writer.Flush()
  & (Join-Path $PSScriptRoot "write-windows-studio-diagnostics.ps1") `
    -Stage online-update -Tag v2.0.16 -Commit ("a" * 40) -Version 2.0.16 `
    -Message "failed at database: token=private-value" -SourcePaths @($logPath) -OutputDirectory $outputPath
  $sanitized = Get-Content -LiteralPath (Join-Path $outputPath "application.log") -Raw
  $summary = Get-Content -LiteralPath (Join-Path $outputPath "summary.json") -Raw | ConvertFrom-Json
  if ($sanitized -notmatch "first failure" -or $sanitized -match "private-value" -or
      $summary.message -match "private-value" -or $summary.commit -ne ("a" * 40)) {
    throw "A live diagnostic log was not retained and sanitized correctly."
  }
  [System.IO.File]::WriteAllText($statusPath, '{"status":"failed","message":"token=private-value"}')
  & (Join-Path $PSScriptRoot "write-windows-studio-diagnostics.ps1") `
    -Stage installer-acceptance -Tag v2.0.16 -Commit ("a" * 40) -Version 2.0.16 `
    -SourcePaths @($statusPath) -OutputDirectory $acceptanceOutputPath
  $sanitizedStatus = Get-Content -LiteralPath (Join-Path $acceptanceOutputPath "update-status.json") -Raw
  if ($sanitizedStatus -notmatch '"status":"failed"' -or $sanitizedStatus -match "private-value") {
    throw "The installer acceptance did not retain and sanitize the online update status."
  }
  [System.IO.File]::WriteAllText($runStatePath, '{"phase":"startup-failed"}')
  [System.IO.File]::WriteAllText($candidateRunPath, '{"phase":"completed"}')
  [System.IO.File]::WriteAllText($runtimeDiagnosticsPath, "runtime startup failure: token=private-value`n")
  [System.IO.File]::WriteAllText($activeManagerInstallerPath, "Error: active installer failure: token=private-value`n")
  [System.IO.File]::WriteAllText($managerRunOutputPath, "manager run failed: token=private-value`n")
  $runtimeAcceptanceOutputPath = Join-Path $testRoot "runtime-acceptance-sanitized"
  & (Join-Path $PSScriptRoot "write-windows-studio-diagnostics.ps1") `
    -Stage installer-acceptance -Tag v2.0.16 -Commit ("a" * 40) -Version 2.0.16 `
    -SourcePaths @($runStatePath, $candidateRunPath, $runtimeDiagnosticsPath, $activeManagerInstallerPath, $managerRunOutputPath) `
    -OutputDirectory $runtimeAcceptanceOutputPath
  foreach ($fileName in @("run-state.json", "candidate-run.json", "acceptance-runtime-diagnostics.log", "active-manager-reinstall.log", "acceptance-manager-run.stdout.log")) {
    $captured = Get-Content -LiteralPath (Join-Path $runtimeAcceptanceOutputPath $fileName) -Raw
    if ($captured -match "private-value") {
      throw "Installer acceptance diagnostics exposed a protected token in $fileName."
    }
  }
  if ((Get-Content -LiteralPath (Join-Path $runtimeAcceptanceOutputPath "acceptance-runtime-diagnostics.log") -Raw) -notmatch "runtime startup failure") {
    throw "The installer acceptance did not retain the manager diagnostic export."
  }
  Write-Output "Shared-open diagnostic capture and sanitization passed."
} finally {
  if ($writer) { $writer.Dispose() }
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}
