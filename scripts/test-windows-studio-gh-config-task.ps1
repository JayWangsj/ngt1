param(
  [Parameter(Mandatory = $true)]
  [string]$GhPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedConfigDirectory,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedTokenSha256,
  [Parameter(Mandatory = $true)]
  [string]$ResultPath
)
$ErrorActionPreference = "Stop"

try {
  if (-not $env:GH_CONFIG_DIR -or
      [System.IO.Path]::GetFullPath($env:GH_CONFIG_DIR) -ine [System.IO.Path]::GetFullPath($ExpectedConfigDirectory) -or
      [Environment]::GetEnvironmentVariable("GH_TOKEN", "Process") -or
      [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "Process")) {
    throw "The scheduled task did not receive only the isolated GitHub CLI configuration."
  }
  Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue
  $token = (& $GhPath auth token --hostname github.com 2>$null | Out-String).Trim()
  $exitCode = $LASTEXITCODE
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $actualTokenSha256 = [BitConverter]::ToString(
      $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($token))
    ).Replace("-", "").ToLowerInvariant()
  } finally { $sha.Dispose() }
  if ($exitCode -ne 0 -or $actualTokenSha256 -cne $ExpectedTokenSha256) {
    throw "The scheduled task could not retrieve the isolated GitHub CLI credential."
  }
  [System.IO.File]::WriteAllText($ResultPath, "PASS", [System.Text.Encoding]::ASCII)
  exit 0
} catch {
  [System.IO.File]::WriteAllText($ResultPath, "FAIL", [System.Text.Encoding]::ASCII)
  exit 1
}
