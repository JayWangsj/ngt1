$ErrorActionPreference = "Stop"

$failure = $null
$tempRoot = $null
$tempCreated = $false

try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw "This regression test requires Windows PowerShell 5.1."
  }

  foreach ($scriptPath in @(
      $PSCommandPath,
      (Join-Path $PSScriptRoot "test-windows-studio-online-update.ps1"),
      (Join-Path $PSScriptRoot "windows-studio-ready-baseline.ps1"),
      (Join-Path $PSScriptRoot "windows-studio-release-metadata.ps1"),
      (Join-Path $PSScriptRoot "build-windows-studio-package.ps1"),
      (Join-Path $PSScriptRoot "test-windows-studio-package.ps1")
    )) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
      $scriptPath,
      [ref]$tokens,
      [ref]$parseErrors
    ) | Out-Null
    if ($parseErrors.Count -gt 0) {
      throw "Windows PowerShell 5.1 found a syntax error in $($scriptPath): $($parseErrors[0].Message)"
    }
  }

  . (Join-Path $PSScriptRoot "windows-studio-ready-baseline.ps1")
  . (Join-Path $PSScriptRoot "windows-studio-release-metadata.ps1")

  $nodePath = (Get-Command "node.exe" -ErrorAction Stop).Source
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-baseline-json-" + [guid]::NewGuid().ToString("N"))
  $tempRootFullPath = [System.IO.Path]::GetFullPath($tempRoot)
  $tempBasePath = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
  if (-not $tempRootFullPath.StartsWith($tempBasePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Regression test temp path is outside the system temp directory."
  }
  if (Test-Path -LiteralPath $tempRootFullPath) {
    throw "Regression test temp path already exists."
  }

  New-Item -ItemType Directory -Path $tempRootFullPath | Out-Null
  $tempCreated = $true
  $baselineRoot = Join-Path $tempRootFullPath "baseline"
  $scriptsRoot = Join-Path $baselineRoot "scripts"
  $toolsRoot = Join-Path $baselineRoot "tools"
  $docsRoot = Join-Path $baselineRoot "docs"
  New-Item -ItemType Directory -Path $scriptsRoot, $toolsRoot, $docsRoot | Out-Null

  $nodeProbePath = Join-Path $tempRootFullPath "parse-json.cjs"
  [System.IO.File]::WriteAllText(
    $nodeProbePath,
    @(
      'const fs = require("node:fs");'
      'const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));'
      'const expectedProductName = "NGT Gestione \u2014 \u7BA1\u7406\u7CFB\u7EDF";'
      'const expectedLabel = "Riparazione \u2014 ripristinata; \u68C0\u67E5\u5B8C\u6210";'
      'if (manifest.productName !== expectedProductName) throw new Error("Non-ASCII manifest text changed.");'
      'if (fs.readFileSync(process.argv[3], "utf8") !== expectedLabel) throw new Error("Non-ASCII file text changed.");'
    ) -join [System.Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )

  $manifestPath = Join-Path $baselineRoot "studio-release.json"
  $updaterPath = Join-Path $toolsRoot "NGTUpdater.exe"
  $startupPath = Join-Path $scriptsRoot "install-windows-startup.ps1"
  $commonPath = Join-Path $scriptsRoot "windows-studio-common.ps1"
  $labelPath = Join-Path $docsRoot "label.txt"
  $commit = "0123456789abcdef0123456789abcdef01234567"
  $productName = "NGT Gestione " + [char]0x2014 + " " + [char]0x7BA1 + [char]0x7406 + [char]0x7CFB + [char]0x7EDF
  $nonAsciiText = "Riparazione " + [char]0x2014 + " ripristinata; " + [char]0x68C0 + [char]0x67E5 + [char]0x5B8C + [char]0x6210

  [System.IO.File]::WriteAllBytes($updaterPath, [byte[]]@(1, 3, 5, 7))
  $startupContent = @(
    '$taskName = "NGT Management System"'
    'Start-ScheduledTask -TaskName $taskName'
  ) -join [System.Environment]::NewLine
  [System.IO.File]::WriteAllText(
    $startupPath,
    $startupContent,
    [System.Text.UTF8Encoding]::new($false)
  )
  $commonContent = @(
    'function Get-NgtGitHubCli {'
    '  $releaseCli = Join-Path $script:NgtProjectRoot "runtime\gh.exe"'
    '  if (Test-Path -LiteralPath $releaseCli) { return $releaseCli }'
    '  return (Get-Command gh -ErrorAction Stop).Source'
    '}'
    '[System.IO.File]::Replace($source, $target, $null)'
  ) -join [System.Environment]::NewLine
  [System.IO.File]::WriteAllText(
    $commonPath,
    $commonContent,
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::WriteAllText($labelPath, $nonAsciiText, [System.Text.UTF8Encoding]::new($false))

  $files = @{
    "tools/NGTUpdater.exe" = (Get-FileHash -LiteralPath $updaterPath -Algorithm SHA256).Hash.ToLowerInvariant()
    "scripts/install-windows-startup.ps1" = (Get-FileHash -LiteralPath $startupPath -Algorithm SHA256).Hash.ToLowerInvariant()
    "scripts/windows-studio-common.ps1" = (Get-FileHash -LiteralPath $commonPath -Algorithm SHA256).Hash.ToLowerInvariant()
    "docs/label.txt" = (Get-FileHash -LiteralPath $labelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $metadata = [pscustomobject]@{
    tag = "v2.0.23"
    version = "2.0.23"
    commit = $commit
    productName = $productName
    files = [pscustomobject]$files
  }

  function Assert-NgtBaselineManifestWrite {
    param(
      [string]$Stage,
      [string]$ExpectedVersion,
      [string]$ExpectedTag,
      [string]$ExpectedCommit,
      [System.Collections.IDictionary]$ExpectedFiles,
      [string]$ManifestPath,
      [string]$BaselineRoot,
      [string]$NodePath,
      [string]$NodeProbePath,
      [string]$LabelPath
    )

    $bytes = [System.IO.File]::ReadAllBytes($ManifestPath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      throw "$Stage wrote a UTF-8 BOM to studio-release.json."
    }

    & $NodePath $NodeProbePath $ManifestPath $LabelPath
    $nodeExitCode = $LASTEXITCODE
    if ($nodeExitCode -ne 0) {
      throw "Node JSON.parse failed after $Stage with exit code $nodeExitCode."
    }
    Test-NgtStudioReleaseMetadata `
      -Path $ManifestPath `
      -ExpectedVersion $ExpectedVersion `
      -ExpectedCommit $ExpectedCommit `
      -NodeExecutable $NodePath

    $actual = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($actual.version -cne $ExpectedVersion) { throw "$Stage changed release version unexpectedly." }
    if ($actual.tag -cne $ExpectedTag) { throw "$Stage changed release tag unexpectedly." }
    if ($actual.commit -cne $ExpectedCommit) { throw "$Stage changed release commit unexpectedly." }

    $actualPaths = @($actual.files.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    $expectedPaths = @($ExpectedFiles.Keys | Sort-Object)
    if (Compare-Object -ReferenceObject $expectedPaths -DifferenceObject $actualPaths) {
      throw "$Stage changed the studio-release.json file inventory unexpectedly."
    }
    foreach ($relativePath in $expectedPaths) {
      $entry = $actual.files.PSObject.Properties[$relativePath]
      $filePath = Join-Path $BaselineRoot ($relativePath -replace "/", "\")
      $actualHash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if (-not $entry -or ([string]$entry.Value).ToLowerInvariant() -cne $ExpectedFiles[$relativePath] -or
          $actualHash -cne $ExpectedFiles[$relativePath]) {
        throw "$Stage changed a manifest SHA-256 unexpectedly: $relativePath"
      }
    }
  }

  Write-NgtStudioReleaseMetadataNoBom -Path $manifestPath -Metadata $metadata
  Assert-NgtBaselineManifestWrite -Stage "Initial baseline" -ExpectedVersion "2.0.23" `
    -ExpectedTag "v2.0.23" -ExpectedCommit $commit -ExpectedFiles $files `
    -ManifestPath $manifestPath -BaselineRoot $baselineRoot -NodePath $nodePath `
    -NodeProbePath $nodeProbePath -LabelPath $labelPath

  [System.IO.File]::WriteAllBytes($updaterPath, [byte[]]@(8, 6, 4, 2))
  $metadata.version = "2.0.22"
  $files["tools/NGTUpdater.exe"] = (Get-FileHash -LiteralPath $updaterPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $metadata.files.PSObject.Properties["tools/NGTUpdater.exe"].Value = $files["tools/NGTUpdater.exe"]
  Write-NgtStudioReleaseMetadataNoBom -Path $manifestPath -Metadata $metadata
  Assert-NgtBaselineManifestWrite -Stage "Version and updater hash adaptation" -ExpectedVersion "2.0.22" `
    -ExpectedTag "v2.0.23" -ExpectedCommit $commit -ExpectedFiles $files `
    -ManifestPath $manifestPath -BaselineRoot $baselineRoot -NodePath $nodePath `
    -NodeProbePath $nodeProbePath -LabelPath $labelPath

  $startupText = Get-Content -LiteralPath $startupPath -Raw
  $startupText = $startupText.Replace(
    "Start-ScheduledTask -TaskName `$taskName",
    "Start-Process -FilePath `$wscriptPath -ArgumentList `$launcherArguments -WindowStyle Hidden"
  )
  Set-Content -LiteralPath $startupPath -Value $startupText -Encoding utf8
  $files["scripts/install-windows-startup.ps1"] = (Get-FileHash -LiteralPath $startupPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $metadata.files.PSObject.Properties["scripts/install-windows-startup.ps1"].Value = $files["scripts/install-windows-startup.ps1"]
  Write-NgtStudioReleaseMetadataNoBom -Path $manifestPath -Metadata $metadata
  Assert-NgtBaselineManifestWrite -Stage "Startup script adaptation" -ExpectedVersion "2.0.22" `
    -ExpectedTag "v2.0.23" -ExpectedCommit $commit -ExpectedFiles $files `
    -ManifestPath $manifestPath -BaselineRoot $baselineRoot -NodePath $nodePath `
    -NodeProbePath $nodeProbePath -LabelPath $labelPath

  $commonText = Get-Content -LiteralPath $commonPath -Raw
  $legacyReplacePattern = '\[System\.IO\.File\]::Replace\((\$[A-Za-z0-9_:]+),\s*(\$[A-Za-z0-9_:]+),\s*\$null\)'
  $legacyReplaceFix = '[System.IO.File]::Replace($1, $2, "${1}.$([guid]::NewGuid().ToString(''N'')).bak")'
  if ([regex]::Matches($commonText, $legacyReplacePattern).Count -ne 1) {
    throw "Baseline fixture did not contain the expected legacy file-replacement call."
  }
  $commonText = [regex]::Replace($commonText, $legacyReplacePattern, $legacyReplaceFix)
  $commonText = Set-NgtReadyBaselineGhShim $commonText
  if ([regex]::IsMatch($commonText, $legacyReplacePattern) -or
      -not $commonText.Contains('NGT_READY_GH_SHIM')) {
    throw "Baseline script adaptation did not apply the expected changes."
  }
  Set-Content -LiteralPath $commonPath -Value $commonText -Encoding utf8
  $files["scripts/windows-studio-common.ps1"] = (Get-FileHash -LiteralPath $commonPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $metadata.files.PSObject.Properties["scripts/windows-studio-common.ps1"].Value = $files["scripts/windows-studio-common.ps1"]
  Write-NgtStudioReleaseMetadataNoBom -Path $manifestPath -Metadata $metadata
  Assert-NgtBaselineManifestWrite -Stage "Common baseline script adaptation" -ExpectedVersion "2.0.22" `
    -ExpectedTag "v2.0.23" -ExpectedCommit $commit -ExpectedFiles $files `
    -ManifestPath $manifestPath -BaselineRoot $baselineRoot -NodePath $nodePath `
    -NodeProbePath $nodeProbePath -LabelPath $labelPath

  $packageRoot = Join-Path $tempRootFullPath "package"
  $packageRuntimeRoot = Join-Path $packageRoot "runtime"
  $packageAssetRoot = Join-Path $packageRoot "assets"
  New-Item -ItemType Directory -Path $packageRuntimeRoot, $packageAssetRoot | Out-Null
  $packageUpdaterPath = Join-Path $packageRuntimeRoot "NGTUpdater.exe"
  $packageAssetPath = Join-Path $packageAssetRoot "application.txt"
  $unicodeAssetName = [string]([char]0x7BA1) + [string]([char]0x7406) + "-system.txt"
  $unicodeAssetRelativePath = "assets/" + $unicodeAssetName
  $unicodeAssetPath = Join-Path $packageAssetRoot $unicodeAssetName
  [System.IO.File]::WriteAllBytes($packageUpdaterPath, [byte[]]@(2, 4, 6, 8))
  [System.IO.File]::WriteAllText($packageAssetPath, $nonAsciiText, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($unicodeAssetPath, "release asset", [System.Text.UTF8Encoding]::new($false))
  $packageFiles = @{
    "runtime/NGTUpdater.exe" = (Get-FileHash -LiteralPath $packageUpdaterPath -Algorithm SHA256).Hash.ToLowerInvariant()
    "assets/application.txt" = (Get-FileHash -LiteralPath $packageAssetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $unicodeAssetRelativePath = (Get-FileHash -LiteralPath $unicodeAssetPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $packageMetadata = @{
    version = "2.0.23"
    commit = $commit
    runtimeHash = (Get-FileHash -LiteralPath $packageUpdaterPath -Algorithm SHA256).Hash.ToLowerInvariant()
    files = $packageFiles
    createdAt = "2026-10-28T00:00:00.0000000Z"
  }
  $packageManifestPath = Join-Path $packageRoot "studio-release.json"
  Write-NgtStudioReleaseMetadataNoBom -Path $packageManifestPath -Metadata $packageMetadata -Depth 5
  Test-NgtStudioReleaseMetadata `
    -Path $packageManifestPath `
    -ExpectedVersion "2.0.23" `
    -ExpectedCommit $commit `
    -NodeExecutable $nodePath
  $writtenPackageMetadata = [System.IO.File]::ReadAllText(
    $packageManifestPath,
    [System.Text.Encoding]::UTF8
  ) | ConvertFrom-Json
  if ($writtenPackageMetadata.runtimeHash -cne $packageMetadata.runtimeHash) {
    throw "Formal package manifest generation changed runtimeHash."
  }
  if (([DateTime]$writtenPackageMetadata.createdAt).ToUniversalTime().ToString("o") -cne
      ([DateTime]$packageMetadata.createdAt).ToUniversalTime().ToString("o")) {
    throw "Formal package manifest generation changed createdAt."
  }
  $writtenPackagePaths = @($writtenPackageMetadata.files.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
  $expectedPackagePaths = @($packageFiles.Keys | Sort-Object)
  if (Compare-Object -ReferenceObject $expectedPackagePaths -DifferenceObject $writtenPackagePaths) {
    throw "Formal package manifest generation changed the file inventory or non-ASCII paths."
  }
  foreach ($relativePath in $expectedPackagePaths) {
    $entry = $writtenPackageMetadata.files.PSObject.Properties[$relativePath]
    if (-not $entry -or ([string]$entry.Value).ToLowerInvariant() -cne $packageFiles[$relativePath]) {
      throw "Formal package manifest generation changed SHA-256: $relativePath"
    }
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $packageZipPath = Join-Path $tempRootFullPath "package.zip"
  [System.IO.Compression.ZipFile]::CreateFromDirectory($packageRoot, $packageZipPath)
  $extractedPackageRoot = Join-Path $tempRootFullPath "extracted-package"
  New-Item -ItemType Directory -Path $extractedPackageRoot | Out-Null
  & tar.exe -xf $packageZipPath -C $extractedPackageRoot
  if ($LASTEXITCODE -ne 0) {
    throw "The manifest regression ZIP could not be extracted."
  }
  $extractedManifestPath = Join-Path $extractedPackageRoot "studio-release.json"
  Test-NgtStudioReleaseMetadata `
    -Path $extractedManifestPath `
    -ExpectedVersion "2.0.23" `
    -ExpectedCommit $commit `
    -NodeExecutable $nodePath
  foreach ($relativePath in @($packageFiles.Keys)) {
    $extractedFilePath = Join-Path $extractedPackageRoot ($relativePath -replace "/", "\")
    $extractedHash = (Get-FileHash -LiteralPath $extractedFilePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($extractedHash -cne $packageFiles[$relativePath]) {
      throw "ZIP extraction changed a file covered by the manifest: $relativePath"
    }
  }

  $extractedManifestBytes = [System.IO.File]::ReadAllBytes($extractedManifestPath)
  $bomManifestBytes = New-Object byte[] ($extractedManifestBytes.Length + 3)
  [Array]::Copy([byte[]]@(0xEF, 0xBB, 0xBF), 0, $bomManifestBytes, 0, 3)
  [Array]::Copy($extractedManifestBytes, 0, $bomManifestBytes, 3, $extractedManifestBytes.Length)
  [System.IO.File]::WriteAllBytes($extractedManifestPath, $bomManifestBytes)
  $bomRejected = $false
  try {
    Test-NgtStudioReleaseMetadata `
      -Path $extractedManifestPath `
      -ExpectedVersion "2.0.23" `
      -ExpectedCommit $commit `
      -NodeExecutable $nodePath
  } catch {
    $bomRejected = $true
  }
  if (-not $bomRejected) {
    throw "The extracted ZIP manifest validator accepted a UTF-8 BOM."
  }

  $missingFileRejected = $false
  try {
    Test-NgtStudioReleaseMetadata `
      -Path (Join-Path $extractedPackageRoot "missing-studio-release.json") `
      -ExpectedVersion "2.0.23" `
      -ExpectedCommit $commit `
      -NodeExecutable $nodePath
  } catch {
    $missingFileRejected = $true
  }
  if (-not $missingFileRejected) {
    throw "The extracted ZIP manifest validator accepted a missing manifest."
  }

  $missingNodeRejected = $false
  try {
    Test-NgtStudioReleaseMetadata `
      -Path $packageManifestPath `
      -ExpectedVersion "2.0.23" `
      -ExpectedCommit $commit `
      -NodeExecutable (Join-Path $tempRootFullPath "missing-node.exe")
  } catch {
    $missingNodeRejected = $true
  }
  if (-not $missingNodeRejected) {
    throw "The extracted ZIP manifest validator accepted a missing Node.js executable."
  }

  Write-Output "Windows PowerShell 5.1 manifest regressions passed: baseline rewrites, package generation, ZIP extraction, BOM rejection, and missing dependencies."
} catch {
  [Console]::Error.WriteLine("Baseline JSON encoding regression failed: " + [string]$_)
  $failure = $_
} finally {
  if ($tempCreated -and $tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
    try {
      $tempRootFullPath = [System.IO.Path]::GetFullPath($tempRoot)
      $tempBasePath = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
      if (-not $tempRootFullPath.StartsWith($tempBasePath, [System.StringComparison]::OrdinalIgnoreCase) -or
          [System.IO.Path]::GetFileName($tempRootFullPath) -notmatch "^ngt-baseline-json-[a-f0-9]{32}$") {
        throw "Regression test refused to remove an unexpected temp path."
      }
      Remove-Item -LiteralPath $tempRootFullPath -Recurse -Force -ErrorAction Stop
    } catch {
      [Console]::Error.WriteLine("Baseline JSON encoding regression cleanup failed: " + [string]$_)
      $failure = $_
    }
  }
}

if ($failure) {
  exit 1
}
