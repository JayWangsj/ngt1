param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseRoot,
  [string]$ExpectedVersion
)
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath($ReleaseRoot)
$metadataPath = Join-Path $root "studio-release.json"
if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
  throw "Studio release metadata is missing."
}
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ($ExpectedVersion -and ([string]$metadata.version -ne ($ExpectedVersion -replace "^v", ""))) {
  throw "Studio release version does not match the expected version."
}
if (-not $metadata.files -or $metadata.files.PSObject.Properties.Count -eq 0) {
  throw "Studio release file manifest is missing."
}

$rootPrefix = $root.TrimEnd("\") + "\"
$expectedPaths = @($metadata.files.PSObject.Properties | ForEach-Object { $_.Name })
$actualPaths = @(Get-ChildItem -LiteralPath $root -File -Recurse -Force |
  Where-Object { $_.FullName -ne $metadataPath } |
  ForEach-Object {
    $_.FullName.Substring($rootPrefix.Length).Replace("\", "/")
  })
$expectedAppPaths = @($expectedPaths | Where-Object {
  $_ -notmatch "^(?i)runtime/" -and $_ -ne ".local/studio.json"
} | Sort-Object)
$actualAppPaths = @($actualPaths | Where-Object {
  $_ -notmatch "^(?i)runtime/" -and $_ -ne ".local/studio.json"
} | Sort-Object)
$pathDifferences = @(Compare-Object -ReferenceObject $expectedAppPaths -DifferenceObject $actualAppPaths)
if ($pathDifferences.Count -gt 0) {
  $missingPaths = @($pathDifferences | Where-Object SideIndicator -eq "<=" | ForEach-Object InputObject)
  $unexpectedPaths = @($pathDifferences | Where-Object SideIndicator -eq "=>" | ForEach-Object InputObject)
  $missingSample = [string]::Join(", ", @($missingPaths | Select-Object -First 20))
  $unexpectedSample = [string]::Join(", ", @($unexpectedPaths | Select-Object -First 20))
  throw ("Studio release files do not match the installed file manifest. Missing: {0} ({1}); unexpected: {2} ({3})." -f `
    $missingSample, $missingPaths.Count, $unexpectedSample, $unexpectedPaths.Count)
}

foreach ($entry in $metadata.files.PSObject.Properties) {
  $relativePath = [string]$entry.Name
  if ($relativePath -match "^(?i)runtime/") { continue }
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $root ($relativePath.Replace("/", "\"))))
  if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Studio release manifest contains an invalid path."
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Studio release file is missing: $relativePath"
  }
  $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne ([string]$entry.Value).ToLowerInvariant()) {
    throw "Studio release file failed integrity validation: $relativePath"
  }
}
foreach ($requiredFile in @(
  ".next/standalone/server.js",
  "scripts/update-windows-studio.ps1",
  "scripts/download-public-release-asset.ps1",
  "scripts/check-windows-credential-store.ps1",
  "scripts/install-windows-studio.ps1",
  "scripts/prepare-windows-studio-install.ps1",
  "scripts/windows-studio-install-coordination.ps1",
  "scripts/retain-windows-studio-releases.ps1",
  "scripts/verify-windows-studio-release.ps1",
  "scripts/test-windows-studio-update-safety.ps1",
  "scripts/test-windows-studio-install-coordination.ps1",
  "prisma/schema.prisma"
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $requiredFile.Replace("/", "\")) -PathType Leaf)) {
    throw "Studio release is missing a required runtime file: $requiredFile"
  }
}
Write-Output ([pscustomobject]@{ version = [string]$metadata.version; commit = [string]$metadata.commit })
