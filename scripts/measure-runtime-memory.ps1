param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 4294967295)]
    [uint32]$RootPid,
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$SamplerPath,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "NGTManager"),
    [string]$OutputRoot = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "NGTManager\external-memory-samples"),
    [ValidateRange(0, 3600)]
    [uint32]$WarmupSeconds = 120,
    [ValidateRange(1, 3600)]
    [uint32]$DurationSeconds = 600,
    [ValidateRange(1, 60)]
    [uint32]$IntervalSeconds = 2
)

$ErrorActionPreference = "Stop"
$managerPath = [IO.Path]::GetFullPath((Join-Path $InstallRoot "tools\NGTManager.exe"))
$sampler = [IO.Path]::GetFullPath($SamplerPath)
$target = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $RootPid"
if (-not $target) { throw "Root PID $RootPid is not running." }
if (-not [string]::Equals($target.ExecutablePath, $managerPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The root process is not the NGTManager executable in the selected install root."
}
if ($target.CommandLine -notmatch '(?i)(?:^|\s)run(?:\s|$)') {
    throw "The root NGTManager process was not started with the run command."
}

$null = New-Item -ItemType Directory -Path $OutputRoot -Force
$runName = "NGTManager-memory-sample-{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([Guid]::NewGuid().ToString("N"))
$runDirectory = Join-Path $OutputRoot $runName
$null = New-Item -ItemType Directory -Path $runDirectory
& $sampler memory-sample-external $RootPid $runDirectory $WarmupSeconds $DurationSeconds $IntervalSeconds
if ($LASTEXITCODE -ne 0) {
    throw "External memory sampling failed with exit code $LASTEXITCODE. Any completed CSV rows remain in $runDirectory."
}

Write-Output (Join-Path $runDirectory "summary.txt")
