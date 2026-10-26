param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseRoot,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedCommit
)
$ErrorActionPreference = "Stop"

$releaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$manifest = Get-Content -LiteralPath (Join-Path $releaseRoot "studio-release.json") -Raw | ConvertFrom-Json
if ([string]$manifest.version -ne $ExpectedVersion -or
    [string]$manifest.commit -ine $ExpectedCommit) {
  throw "The active release manifest does not match the expected version and commit."
}

$baseUri = [uri]"http://127.0.0.1:3000"
$routes = @(
  "/",
  "/orders",
  "/retail",
  "/retail/sales",
  "/inventory",
  "/customers",
  "/prices",
  "/settings"
)
$assetPattern = '(?i)(?:href|src)\s*=\s*["''](?<asset>/_next/static/[^"''\s>]+\.(?:css|js)(?:\?[^"''\s>]*)?)["'']'
$assetPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$deadline = (Get-Date).AddMinutes(3)
Add-Type -AssemblyName System.Net.Http
$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(20)
try {
  $healthResponse = $client.GetAsync([uri]::new($baseUri, "/api/health")).GetAwaiter().GetResult()
  try {
    $health = $healthResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    if ($healthResponse.StatusCode -ne [System.Net.HttpStatusCode]::OK -or
        [string]$health.status -ne "ok" -or
        [string]$health.currentVersion -ne $ExpectedVersion -or
        [string]$health.buildCommit -ine $ExpectedCommit) {
      throw "The active application process does not match the expected version and commit."
    }
  } finally {
    $healthResponse.Dispose()
  }

  foreach ($route in $routes) {
    if ((Get-Date) -gt $deadline) {
      throw "Local business-page and static-resource checks exceeded three minutes."
    }
    $response = $client.GetAsync([uri]::new($baseUri, $route)).GetAwaiter().GetResult()
    try {
      if ($response.StatusCode -ne [System.Net.HttpStatusCode]::OK -or
          $response.RequestMessage.RequestUri.AbsolutePath -cne $route) {
        throw "Business page failed its local response check: $route (HTTP $([int]$response.StatusCode))."
      }
      $html = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if ($html -notmatch '<main\b' -or $html -notmatch '<h1\b') {
        throw "Business page did not render its expected content: $route."
      }
      foreach ($match in [regex]::Matches($html, $assetPattern)) {
        $assetUri = [uri]::new($baseUri, [string]$match.Groups["asset"].Value)
        [void]$assetPaths.Add($assetUri.AbsolutePath)
      }
    } finally {
      $response.Dispose()
    }
  }

  $assetTypes = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($assetPath in $assetPaths) {
    if ((Get-Date) -gt $deadline) {
      throw "Local business-page and static-resource checks exceeded three minutes."
    }
    $relativePath = [uri]::UnescapeDataString($assetPath.Substring("/_next/static/".Length)).Replace("\", "/")
    $manifestPath = ".next/static/$relativePath"
    $manifestEntry = $manifest.files.PSObject.Properties[$manifestPath]
    if (-not $manifestEntry) {
      throw "A served static asset is missing from the active release manifest: $manifestPath"
    }

    $assetResponse = $client.GetAsync([uri]::new($baseUri, $assetPath)).GetAwaiter().GetResult()
    try {
      $extension = [System.IO.Path]::GetExtension($relativePath)
      $contentType = [string]$assetResponse.Content.Headers.ContentType.MediaType
      if ($assetResponse.StatusCode -ne [System.Net.HttpStatusCode]::OK -or
          ($extension -eq ".css" -and $contentType -ne "text/css") -or
          ($extension -eq ".js" -and $contentType -notmatch '^(application|text)/(x-)?(java|ecma)script$')) {
        throw "A served static asset failed its HTTP or Content-Type check: $assetPath."
      }
      $body = $assetResponse.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      if ($body.Length -eq 0) {
        throw "A served static asset is empty: $assetPath."
      }
      $sha256 = [System.Security.Cryptography.SHA256]::Create()
      try {
        $actualHash = [BitConverter]::ToString($sha256.ComputeHash($body)).Replace("-", "").ToLowerInvariant()
      } finally {
        $sha256.Dispose()
      }
      if ($actualHash -cne [string]$manifestEntry.Value) {
        throw "A served static asset does not match its release manifest hash: $assetPath."
      }
      [void]$assetTypes.Add($extension)
    } finally {
      $assetResponse.Dispose()
    }
  }

  if (-not $assetTypes.Contains(".css") -or -not $assetTypes.Contains(".js")) {
    throw "The business pages did not serve both CSS and JavaScript assets."
  }
  Write-Output ("Local business-page and static-resource checks passed for {0} pages and {1} assets." -f `
    $routes.Count, $assetPaths.Count)
} finally {
  $client.Dispose()
}
