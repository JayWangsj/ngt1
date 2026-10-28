function Set-NgtReadyBaselineGhShim([string]$ScriptContent) {
  $cliFunction = 'function Get-NgtGitHubCli {'
  if (-not $ScriptContent.Contains($cliFunction) -or
      -not $ScriptContent.Contains('$releaseCli = Join-Path $script:NgtProjectRoot "runtime\gh.exe"')) {
    throw "Baseline GitHub CLI selection cannot be adapted for the local candidate."
  }
  return $ScriptContent.Replace($cliFunction, "$cliFunction`r`n  if (`$env:NGT_READY_GH_SHIM) { return `$env:NGT_READY_GH_SHIM }")
}
