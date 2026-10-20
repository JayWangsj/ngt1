param(
  [Parameter(Mandatory = $true)]
  [string]$DataRoot,
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,
  [string]$UpdateId,
  [Parameter(Mandatory = $true)]
  [string]$LogPath
)
$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
Start-Transcript -LiteralPath $LogPath -Force
try {
  & (Join-Path $PSScriptRoot "install-windows-studio.ps1") `
    -DataRoot $DataRoot -InstallRoot $InstallRoot -UpdateId $UpdateId `
    -OnlineUpdate:([bool]$UpdateId)
} catch {
  Write-Error $_
  exit 1
} finally {
  Stop-Transcript
}
