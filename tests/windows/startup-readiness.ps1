$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root "scripts\windows-studio-common.ps1")
$servicePath = Join-Path $root "scripts\windows-service.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($servicePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Windows service script has a PowerShell syntax error." }
foreach ($name in @("Test-NgtDatabaseReady", "Wait-NgtDatabaseReady")) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $definition) { throw "Missing readiness function: $name" }
  . ([scriptblock]::Create($definition.Extent.Text))
}

$testRoot = Join-Path $root (".local\startup-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$projectRoot = Join-Path $testRoot "release"
$installRoot = Join-Path $testRoot "install"
$stateDirectory = Join-Path $testRoot "state"
$readyFile = Join-Path $projectRoot ".local\database-ready.pid"
$pidFile = Join-Path $stateDirectory "database.pid"
New-Item -ItemType Directory -Path (Split-Path -Parent $readyFile), $stateDirectory -Force | Out-Null
try {
  Set-Content -LiteralPath $pidFile -Value $PID -Encoding ascii
  $script:PortListening = $true
  function Test-NgtPortOwnership([int]$Port) {
    if ($Port -ne 55432) { throw "Unexpected port: $Port" }
    return $script:PortListening
  }
  function Get-NgtStudioProcess([int]$ProcessId) {
    if ($ProcessId -eq $PID) { return [pscustomobject]@{ ProcessId = $PID } }
    return $null
  }
  function Test-NgtStudioDatabaseLauncherProcess(
    [object]$Process,
    [string]$ReleaseRoot,
    [string[]]$AllowedNodePaths,
    [string]$ActiveRelease,
    [int]$SupervisorId
  ) {
    return $null -ne $Process -and [int]$Process.ProcessId -eq $PID
  }
  if (Test-NgtDatabaseReady) { throw "An open port alone passed database readiness." }
  Set-Content -LiteralPath $readyFile -Value 2147483647 -Encoding ascii
  if (Test-NgtDatabaseReady) { throw "A mismatched readiness marker passed." }
  Set-Content -LiteralPath $pidFile -Value 2147483647 -Encoding ascii
  if (Test-NgtDatabaseReady) { throw "A marker for an exited process passed." }
  Set-Content -LiteralPath $pidFile -Value $PID -Encoding ascii
  Set-Content -LiteralPath $readyFile -Value $PID -Encoding ascii
  $script:PortListening = $false
  if (Test-NgtDatabaseReady) { throw "A closed database port passed." }
  $script:PortListening = $true
  if (-not (Test-NgtDatabaseReady)) { throw "The initialized database was not accepted." }

  Remove-Item -LiteralPath $readyFile -Force
  $script:SleepCount = 0
  $script:PublishReadyMarker = $true
  function Start-Sleep([int]$Milliseconds) {
    if ($Milliseconds -ne 250) { throw "Unexpected readiness poll interval." }
    $script:SleepCount++
    if ($script:PublishReadyMarker -and $script:SleepCount -eq 2) {
      Set-Content -LiteralPath $readyFile -Value $PID -Encoding ascii
    }
  }
  Wait-NgtDatabaseReady
  if ($script:SleepCount -ne 2) { throw "Application startup did not wait for database initialization." }
  Remove-Item -LiteralPath $readyFile -Force
  $script:SleepCount = 0
  $script:PublishReadyMarker = $false
  $timedOut = $false
  try { Wait-NgtDatabaseReady } catch { $timedOut = $_.Exception.Message -like "Database did not finish initialization*" }
  if (-not $timedOut -or $script:SleepCount -ne 120) { throw "Database readiness timeout was not enforced." }
  Write-Output "Windows Studio startup readiness tests passed."
} finally {
  $resolved = [System.IO.Path]::GetFullPath($testRoot)
  $base = [System.IO.Path]::GetFullPath((Join-Path $root ".local")).TrimEnd("\") + "\"
  if ($resolved.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolved) -like "startup-????????") {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
