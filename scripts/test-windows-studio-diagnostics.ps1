$ErrorActionPreference = "Stop"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-diagnostics-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$logPath = Join-Path $testRoot "application.log"
$statusPath = Join-Path $testRoot "update-status.json"
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
  Write-Output "Shared-open diagnostic capture and sanitization passed."
} finally {
  if ($writer) { $writer.Dispose() }
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}
