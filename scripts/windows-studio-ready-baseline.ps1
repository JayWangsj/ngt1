function Set-NgtReadyBaselineGhShim([string]$ScriptContent) {
  $cliFunction = 'function Get-NgtGitHubCli {'
  if (-not $ScriptContent.Contains($cliFunction) -or
      -not $ScriptContent.Contains('$releaseCli = Join-Path $script:NgtProjectRoot "runtime\gh.exe"')) {
    throw "Baseline GitHub CLI selection cannot be adapted for the local candidate."
  }
  return $ScriptContent.Replace($cliFunction, "$cliFunction`r`n  if (`$env:NGT_READY_GH_SHIM) { return `$env:NGT_READY_GH_SHIM }")
}

function Write-NgtStudioReleaseMetadataNoBom {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [object]$Metadata
  )

  $json = $Metadata | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText(
    $Path,
    $json + [System.Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )
}
