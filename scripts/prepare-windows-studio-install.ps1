param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,
  [Parameter(Mandatory = $true)]
  [string]$TargetVersion,
  [string]$UpdateId,
  [Parameter(Mandatory = $true)]
  [string]$LogPath
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-studio-install-coordination.ps1")

New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
Set-Content -LiteralPath $LogPath -Value ((Get-Date).ToUniversalTime().ToString("o") + " Starting installer preflight.") -Encoding utf8
try {
  if ($UpdateId) {
    $plan = Start-NgtStudioOnlineUpdateInstall -InstallRoot $InstallRoot `
      -TargetVersion $TargetVersion -UpdateId $UpdateId
  } else {
    $plan = Start-NgtStudioManualInstall -InstallRoot $InstallRoot -TargetVersion $TargetVersion
  }
  Add-Content -LiteralPath $LogPath -Value ("{0:o} Prepared {1} for v{2}." -f (Get-Date).ToUniversalTime(), $plan.mode, $TargetVersion)
  Write-Output ("NGT_INSTALL_MODE=" + $plan.mode)
} catch {
  $message = $_.Exception.Message -replace "[\r\n]", " "
  Add-Content -LiteralPath $LogPath -Value ("{0:o} BLOCKED {1}" -f (Get-Date).ToUniversalTime(), $message)
  Write-Error $message
  exit 1
}
