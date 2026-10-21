param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("online-update", "installer", "manual-installer")]
  [string]$Acceptance,
  [switch]$Child,
  [string]$RequestPath
)
$ErrorActionPreference = "Stop"

if ($Child) {
  $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
  foreach ($entry in $request.environment.PSObject.Properties) {
    if ($null -ne $entry.Value) {
      [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, "Process")
    }
  }

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Windows acceptance must run as a standard user, not an administrator."
  }

  $arguments = @{}
  foreach ($entry in $request.parameters.PSObject.Properties) {
    $arguments[$entry.Name] = $entry.Value
  }
  $childExitCode = 0
  try {
    $global:LASTEXITCODE = 0
    & $request.scriptPath @arguments
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
      $childExitCode = [int]$LASTEXITCODE
    }
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $childExitCode = 1
  }
  Set-Content -LiteralPath $request.resultPath -Value $childExitCode -Encoding ascii
  exit $childExitCode
}

if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted") {
  throw "Standard-user acceptance is restricted to a disposable GitHub-hosted Windows runner."
}

$scriptPath = switch ($Acceptance) {
  "online-update" { Join-Path $PSScriptRoot "test-windows-studio-online-update.ps1" }
  "manual-installer" { Join-Path $PSScriptRoot "test-windows-studio-online-update.ps1" }
  "installer" { Join-Path $PSScriptRoot "test-windows-studio-installer.ps1" }
}
$candidateVersion = (Get-Content -LiteralPath (Join-Path $env:GITHUB_WORKSPACE "package.json") -Raw | ConvertFrom-Json).version
$targetTag = if ($env:NGT_RELEASE_READY -eq "true") { "v$candidateVersion" } else { $env:GITHUB_REF_NAME }
$parameters = switch ($Acceptance) {
  "online-update" {
    @{
      TargetTag = $targetTag
      ExpectedCommitSha = $env:GITHUB_SHA
      ExpectedManifestPath = Join-Path $env:GITHUB_WORKSPACE "release-assets\release-manifest.json"
      CandidateDirectory = Join-Path $env:GITHUB_WORKSPACE "release-assets"
      AcceptanceUpdaterPath = Join-Path $env:RUNNER_TEMP "ngt-updater-acceptance\NGTUpdater.exe"
    }
  }
  "manual-installer" {
    @{
      TargetTag = $targetTag
      ExpectedCommitSha = $env:GITHUB_SHA
      ExpectedManifestPath = Join-Path $env:GITHUB_WORKSPACE "release-assets\release-manifest.json"
      CandidateDirectory = Join-Path $env:GITHUB_WORKSPACE "release-assets"
      ManualInstaller = $true
    }
  }
  "installer" {
    @{
      InstallerPath = Join-Path $env:GITHUB_WORKSPACE "release-assets\ngt-studio-windows-setup-v$candidateVersion.exe"
      ExpectedVersion = $candidateVersion
    }
  }
}

$runId = [guid]::NewGuid().ToString("N")
$userName = "ngtci" + $runId.Substring(0, 8)
$account = "$env:COMPUTERNAME\$userName"
$password = ConvertTo-SecureString ($runId + "Aa1!") -AsPlainText -Force
$user = $null
$process = $null
$workspaceAclPaths = @()
$isolatedTemp = Join-Path $env:RUNNER_TEMP ("ngt-acceptance-" + $runId)
$requestPath = Join-Path $isolatedTemp "request.json"
$resultPath = Join-Path $isolatedTemp "acceptance.exit-code"
$stdoutPath = Join-Path $isolatedTemp "acceptance.stdout.log"
$stderrPath = Join-Path $isolatedTemp "acceptance.stderr.log"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

try {
  $user = New-LocalUser -Name $userName -Password $password `
    -Description "NGT release acceptance standard account" -PasswordNeverExpires
  New-Item -ItemType Directory -Path $isolatedTemp -Force | Out-Null

  $tempAcl = Get-Acl -LiteralPath $isolatedTemp
  $tempRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $account,
    [System.Security.AccessControl.FileSystemRights]::Modify,
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $tempAcl.AddAccessRule($tempRule)
  Set-Acl -LiteralPath $isolatedTemp -AclObject $tempAcl

  $workspace = [System.IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
  $workspaceAclPaths = @(
    @{ Path = $workspace; Recursive = $false },
    @{ Path = (Join-Path $workspace "scripts"); Recursive = $true },
    @{ Path = (Join-Path $workspace "release-assets"); Recursive = $true },
    @{ Path = (Join-Path $env:RUNNER_TEMP "ngt-updater-acceptance"); Recursive = $true },
    @{ Path = (Join-Path $workspace "package.json"); Recursive = $false }
  ) | Where-Object { Test-Path -LiteralPath $_.Path }
  foreach ($entry in $workspaceAclPaths) {
    $icaclsArguments = @($entry.Path, "/grant:r", "${account}:(RX)")
    if ($entry.Recursive) { $icaclsArguments += @("/T", "/C") }
    $icaclsArguments += "/Q"
    & (Join-Path $env:SystemRoot "System32\icacls.exe") @icaclsArguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not grant the acceptance user read access to $($entry.Path)." }
  }

  $request = @{
    scriptPath = $scriptPath
    parameters = $parameters
    resultPath = $resultPath
    environment = @{
      GITHUB_ACTIONS = $env:GITHUB_ACTIONS
      RUNNER_ENVIRONMENT = $env:RUNNER_ENVIRONMENT
      RUNNER_OS = $env:RUNNER_OS
      GITHUB_SHA = $env:GITHUB_SHA
      GITHUB_REF_NAME = $env:GITHUB_REF_NAME
      NGT_RELEASE_READY = $env:NGT_RELEASE_READY
      GITHUB_WORKSPACE = $workspace
      RUNNER_TEMP = $isolatedTemp
      GH_TOKEN = $env:GH_TOKEN
      PATH = $env:PATH
    }
  }
  $request | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $requestPath -Encoding utf8

  $credential = [System.Management.Automation.PSCredential]::new($account, $password)
  $childArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Acceptance ' + $Acceptance + ' -Child -RequestPath "' + $requestPath + '"'
  Write-Output "Starting the verified $Acceptance acceptance as a disposable standard Windows user."
  $process = Start-Process -FilePath $powershellPath -ArgumentList $childArguments `
    -Credential $credential -LoadUserProfile -WorkingDirectory $workspace `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru

  while (-not $process.WaitForExit(60000)) {
    Write-Output "The standard-user acceptance is still running."
  }
  $process.Refresh()
  if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath }
  if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath | ForEach-Object { Write-Output ("Acceptance stderr: " + $_) } }
  if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
    throw "The standard-user $Acceptance acceptance did not write its exit result."
  }
  $resultText = (Get-Content -LiteralPath $resultPath -Raw).Trim()
  [int]$childExitCode = 0
  if (-not [int]::TryParse($resultText, [ref]$childExitCode)) {
    throw "The standard-user $Acceptance acceptance wrote an invalid exit result."
  }
  $processExitCode = $process.ExitCode
  if ($childExitCode -ne 0 -or ($null -ne $processExitCode -and $processExitCode -ne 0)) {
    throw "The standard-user $Acceptance acceptance failed with child exit code $childExitCode and process exit code $processExitCode."
  }
} finally {
  if ($process -and -not $process.HasExited) {
    & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $process.Id /T /F | Out-Null
    [void]$process.WaitForExit(5000)
  }
  try {
    $sanitizedDiagnostics = Get-ChildItem -LiteralPath $isolatedTemp -Directory -Filter "ngt-*-diagnostics" -ErrorAction SilentlyContinue
    if ($sanitizedDiagnostics) {
      $retainedDiagnostics = Join-Path $env:RUNNER_TEMP "ngt-acceptance-diagnostics"
      New-Item -ItemType Directory -Path $retainedDiagnostics -Force | Out-Null
      foreach ($directory in $sanitizedDiagnostics) {
        Copy-Item -LiteralPath $directory.FullName -Destination $retainedDiagnostics -Recurse -Force
      }
    }
  } catch {
    Write-Warning ("Sanitized acceptance diagnostics could not be retained: " + $_.Exception.Message)
  }
  foreach ($entry in $workspaceAclPaths) {
    $icaclsArguments = @($entry.Path, "/remove", $account)
    if ($entry.Recursive) { $icaclsArguments += @("/T", "/C") }
    $icaclsArguments += "/Q"
    & (Join-Path $env:SystemRoot "System32\icacls.exe") @icaclsArguments | Out-Null
  }
  if ($user) { Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $isolatedTemp) {
    Remove-Item -LiteralPath $isolatedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
