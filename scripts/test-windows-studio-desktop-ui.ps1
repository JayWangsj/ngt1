param([string]$CompilerPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $CompilerPath) {
  $CompilerPath = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $CompilerPath) {
    $CompilerPath = (Get-Command ISCC.exe -ErrorAction Stop).Source
  }
}
$testRoot = Join-Path $projectRoot ('.local\desktop-ui-test-' + [guid]::NewGuid().ToString('N'))
$payload = Join-Path $testRoot 'payload'
New-Item -ItemType Directory -Path $payload -Force | Out-Null
Set-Content -LiteralPath (Join-Path $payload 'studio-release.json') -Value '{}'
Set-Content -LiteralPath (Join-Path $payload 'ui-fixture.txt') -Value 'UI test only; not an installable package'
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
& $CompilerPath /Q /DDesktopUiTest "/DAppVersion=$version" "/DPackageDirectory=$payload" `
  /DPackageBytes=40 /DPackageFileCount=2 `
  "/DIconPath=$projectRoot\assets\ngt-studio.ico" `
  "/DIconBitmapPath=$projectRoot\assets\ngt-studio-installer.bmp" `
  "/DRailBitmapPath=$projectRoot\assets\ngt-studio-installer-rail.bmp" `
  "/DOutputDir=$testRoot" (Join-Path $projectRoot 'installer\windows-studio.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno desktop UI self-test compilation failed.' }
$previousLocalAppData = $env:LOCALAPPDATA
try {
  $env:LOCALAPPDATA = Join-Path $testRoot 'profile'
  foreach ($language in @('english', 'italian', 'chinesesimplified')) {
    $result = Join-Path $testRoot ($language + '.txt')
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', "/LANG=$language", ('/UiTestResult="' + $result + '"'))
    $process = Start-Process -FilePath (Join-Path $testRoot "ngt-studio-windows-setup-v$version.exe") `
      -ArgumentList $arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(15000)) { throw "UI self-test timed out: $language" }
    if (-not (Test-Path -LiteralPath $result)) { throw "Missing UI self-test evidence: $language" }
    $evidence = Get-Content -LiteralPath $result -Raw
    if (($process.ExitCode -ne 0) -or (-not $evidence.StartsWith('PASS:'))) { throw "$language`: $evidence" }
    Write-Output "$language`: $($evidence.Trim())"
  }
} finally {
  $env:LOCALAPPDATA = $previousLocalAppData
}
Write-Output "UI evidence: $testRoot"
