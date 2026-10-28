function Write-NgtStudioReleaseMetadataNoBom {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [object]$Metadata,
    [ValidateRange(1, 100)]
    [int]$Depth = 100
  )

  $json = ConvertTo-Json -InputObject $Metadata -Depth $Depth
  [System.IO.File]::WriteAllText(
    $Path,
    $json + [System.Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Test-NgtStudioReleaseMetadata {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommit,
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Studio release metadata is missing: $Path"
  }
  if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
    throw "The Node.js executable required to validate Studio release metadata is missing: $NodeExecutable"
  }
  if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw "The expected Studio release commit is invalid."
  }

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "Studio release metadata must be UTF-8 without a BOM."
  }

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-release-metadata-" + [guid]::NewGuid().ToString("N"))
  if (Test-Path -LiteralPath $tempRoot) {
    throw "Studio metadata validation temp path already exists."
  }
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  $nodeScriptPath = Join-Path $tempRoot "verify-metadata.cjs"
  $nodeScript = @'
const fs = require("node:fs");
const file = process.argv[2];
const expectedVersion = process.argv[3];
const expectedCommit = process.argv[4].toLowerCase();
const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
if (metadata.version !== expectedVersion) throw new Error("Studio release version does not match the expected version.");
if (typeof metadata.commit !== "string" || !/^[a-f0-9]{40}$/i.test(metadata.commit) || metadata.commit.toLowerCase() !== expectedCommit) {
  throw new Error("Studio release commit does not match the expected commit.");
}
if (!metadata.files || typeof metadata.files !== "object" || Array.isArray(metadata.files) || Object.keys(metadata.files).length === 0) {
  throw new Error("Studio release file manifest is missing or invalid.");
}
for (const [filePath, hash] of Object.entries(metadata.files)) {
  if (!filePath || typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error("Studio release file entry is invalid: " + filePath);
  }
}
'@

  try {
    [System.IO.File]::WriteAllText($nodeScriptPath, $nodeScript, [System.Text.UTF8Encoding]::new($false))
    $nodeOutput = & $NodeExecutable $nodeScriptPath $Path $ExpectedVersion $ExpectedCommit 2>&1
    $nodeExitCode = $LASTEXITCODE
    if ($nodeExitCode -ne 0) {
      $nodeMessage = [string]::Join([System.Environment]::NewLine, @($nodeOutput | ForEach-Object { [string]$_ }))
      throw "Node.js rejected Studio release metadata (exit code $nodeExitCode): $nodeMessage"
    }
  } finally {
    if (Test-Path -LiteralPath $tempRoot -PathType Container) {
      $tempRootFullPath = [System.IO.Path]::GetFullPath($tempRoot)
      $tempBasePath = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
      if (-not $tempRootFullPath.StartsWith($tempBasePath, [System.StringComparison]::OrdinalIgnoreCase) -or
          [System.IO.Path]::GetFileName($tempRootFullPath) -notmatch "^ngt-release-metadata-[a-f0-9]{32}$") {
        throw "Studio metadata validation refused to remove an unexpected temp path."
      }
      Remove-Item -LiteralPath $tempRootFullPath -Recurse -Force -ErrorAction Stop
    }
  }
}
