param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("online-update", "installer", "manual-installer", "production-update")]
  [string]$Acceptance,
  [switch]$Child,
  [string]$RequestPath
)
$ErrorActionPreference = "Stop"

function Get-NgtAcceptanceSha256([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

if ($Child) {
  $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
  foreach ($entry in $request.environment.PSObject.Properties) {
    if ($null -ne $entry.Value) {
      [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, "Process")
    }
  }

  if ($request.verifyGitHubAuth) {
    $expectedConfigDirectory = [System.IO.Path]::GetFullPath([string]$request.ghConfigDirectory)
    if (-not $env:GH_CONFIG_DIR -or
        [System.IO.Path]::GetFullPath($env:GH_CONFIG_DIR) -ine $expectedConfigDirectory -or
        -not (Test-Path -LiteralPath (Join-Path $expectedConfigDirectory "hosts.yml") -PathType Leaf)) {
      throw "The isolated GitHub CLI configuration was not available to the standard-user process."
    }
    [Environment]::SetEnvironmentVariable("GH_CONFIG_DIR", $expectedConfigDirectory, "User")
    $gh = Get-Command gh.exe -ErrorAction Stop
    Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
    $configToken = (& $gh.Source auth token --hostname github.com 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or
        (Get-NgtAcceptanceSha256 $configToken) -cne [string]$request.expectedTokenSha256) {
      throw "The standard-user child process could not read the expected token from GH_CONFIG_DIR."
    }
    $env:GH_TOKEN = $configToken
    $environmentToken = (& $gh.Source auth token --hostname github.com 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or
        (Get-NgtAcceptanceSha256 $environmentToken) -cne [string]$request.expectedTokenSha256) {
      throw "The standard-user child process could not read the expected GH_TOKEN value."
    }
    if ((Get-Content -LiteralPath $RequestPath -Raw).Contains($configToken)) {
      throw "The acceptance request file contains the GitHub token."
    }
    Write-Output "GH_CONFIG_DIR and GH_TOKEN were verified through real gh child processes without placing the token in request.json."
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
  } finally {
    if ($request.verifyGitHubAuth) {
      Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
      Remove-Item Env:\GH_CONFIG_DIR -ErrorAction SilentlyContinue
      [Environment]::SetEnvironmentVariable("GH_CONFIG_DIR", $null, "User")
    }
  }
  Set-Content -LiteralPath $request.resultPath -Value $childExitCode -Encoding ascii
  exit $childExitCode
}

if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted") {
  throw "Standard-user acceptance is restricted to a disposable GitHub-hosted Windows runner."
}

$scriptPath = switch ($Acceptance) {
  "online-update" { Join-Path $PSScriptRoot "test-windows-studio-online-update.ps1" }
  "production-update" { Join-Path $PSScriptRoot "test-windows-studio-online-update.ps1" }
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
  "production-update" {
    @{
      TargetTag = $targetTag
      ExpectedCommitSha = $env:GITHUB_SHA
      ExpectedManifestPath = Join-Path $env:GITHUB_WORKSPACE "release-assets\release-manifest.json"
      CandidateDirectory = Join-Path $env:GITHUB_WORKSPACE "release-assets"
      AcceptanceUpdaterPath = Join-Path $env:RUNNER_TEMP "ngt-updater-acceptance\NGTUpdater.exe"
      TestReleaseRepository = $env:NGT_UPDATER_TEST_REPOSITORY
      ProductionUpdater = $true
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
$processTerminationFailed = $false
$credentialCleanupFailed = $false
$workspaceAclPaths = @()
$isolatedTemp = Join-Path $env:RUNNER_TEMP ("ngt-acceptance-" + $runId)
$requestPath = Join-Path $isolatedTemp "request.json"
$resultPath = Join-Path $isolatedTemp "acceptance.exit-code"
$stdoutPath = Join-Path $isolatedTemp "acceptance.stdout.log"
$stderrPath = Join-Path $isolatedTemp "acceptance.stderr.log"
$ghConfigDirectory = Join-Path $isolatedTemp "gh-config"
$hostsPath = Join-Path $ghConfigDirectory "hosts.yml"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$expectedTokenSha256 = $null

try {
  if ($Acceptance -eq "production-update") {
    if (-not $env:GH_TOKEN) { throw "Production updater acceptance requires the scoped GitHub Actions token." }
    $expectedTokenSha256 = Get-NgtAcceptanceSha256 $env:GH_TOKEN
  }
  $user = New-LocalUser -Name $userName -Password $password `
    -Description "NGT release acceptance standard account" -PasswordNeverExpires
  New-Item -ItemType Directory -Path $isolatedTemp -Force | Out-Null

  $tempAcl = Get-Acl -LiteralPath $isolatedTemp
  $tempAcl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
    [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
    [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
  )) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $tempAcl.AddAccessRule($rule)
  }
  $tempRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $account,
    [System.Security.AccessControl.FileSystemRights]::Modify,
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $tempAcl.AddAccessRule($tempRule)
  Set-Acl -LiteralPath $isolatedTemp -AclObject $tempAcl
  if (-not (Get-Acl -LiteralPath $isolatedTemp).AreAccessRulesProtected) {
    throw "The acceptance temp directory still inherits access from the shared runner temp directory."
  }

  if ($Acceptance -eq "production-update") {
    New-Item -ItemType Directory -Path $ghConfigDirectory -Force | Out-Null
    $hostsConfiguration = "github.com:`r`n    oauth_token: $($env:GH_TOKEN)`r`n    git_protocol: https`r`n"
    [System.IO.File]::WriteAllText($hostsPath, $hostsConfiguration, [System.Text.Encoding]::UTF8)
    if ((Get-Acl -LiteralPath $hostsPath).AccessToString -match "Everyone|Authenticated Users|BUILTIN\\Users") {
      throw "The isolated hosts.yml grants access to a broad user group."
    }
  }

  $workspace = [System.IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
  $workspaceAclPaths = @(
    @{ Path = $workspace; Recursive = $false },
    @{ Path = (Join-Path $workspace "scripts"); Recursive = $true },
    @{ Path = (Join-Path $workspace "node_modules"); Recursive = $true },
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
      GH_CONFIG_DIR = if ($Acceptance -eq "production-update") { $ghConfigDirectory } else { $null }
      NGT_MANUAL_UPGRADE_BASELINE = $env:NGT_MANUAL_UPGRADE_BASELINE
      NGT_PRODUCTION_UPDATER_BASELINE = $env:NGT_PRODUCTION_UPDATER_BASELINE
      NGT_UPDATER_TEST_REPOSITORY = $env:NGT_UPDATER_TEST_REPOSITORY
      PATH = $env:PATH
    }
    verifyGitHubAuth = ($Acceptance -eq "production-update")
    ghConfigDirectory = if ($Acceptance -eq "production-update") { $ghConfigDirectory } else { $null }
    expectedTokenSha256 = $expectedTokenSha256
  }
  $requestText = $request | ConvertTo-Json -Depth 6
  if ($expectedTokenSha256 -and $requestText.Contains($env:GH_TOKEN)) {
    throw "The GitHub token must not be written to request.json."
  }
  [System.IO.File]::WriteAllText($requestPath, $requestText, [System.Text.Encoding]::UTF8)

  $credential = [System.Management.Automation.PSCredential]::new($account, $password)
  $childArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Acceptance ' + $Acceptance + ' -Child -RequestPath "' + $requestPath + '"'
  Write-Output "Starting the verified $Acceptance acceptance as a disposable standard Windows user."
  $process = Start-Process -FilePath $powershellPath -ArgumentList $childArguments `
    -Credential $credential -LoadUserProfile -WorkingDirectory $workspace `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru

  $acceptanceDeadline = (Get-Date).AddMinutes(110)
  while (-not $process.WaitForExit(60000)) {
    if ((Get-Date) -ge $acceptanceDeadline) {
      & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $process.Id /T /F | Out-Null
      [void]$process.WaitForExit(5000)
      $process.Refresh()
      if (-not $process.HasExited) { $processTerminationFailed = $true }
      throw "The standard-user $Acceptance acceptance exceeded its 110-minute timeout."
    }
    Write-Output "The standard-user acceptance is still running."
  }
  $process.Refresh()
  if ($expectedTokenSha256) {
    foreach ($outputPath in @($stdoutPath, $stderrPath, $requestPath)) {
      if ((Test-Path -LiteralPath $outputPath) -and
          (Get-Content -LiteralPath $outputPath -Raw).Contains($env:GH_TOKEN)) {
        throw "The GitHub token was exposed in standard-user acceptance diagnostics."
      }
    }
  }
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
    $process.Refresh()
    if (-not $process.HasExited) { $processTerminationFailed = $true }
  }
  if ($user -and $Acceptance -eq "production-update") {
    try {
      $userSid = [string]$user.SID.Value
      $profile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$userSid'" -ErrorAction Stop |
        Select-Object -First 1
      if (-not $profile -or -not $profile.LocalPath) {
        throw "Could not locate the disposable standard-user profile for credential cleanup."
      }
      $loadedEnvironment = "Registry::HKEY_USERS\$userSid\Environment"
      if (Test-Path -LiteralPath $loadedEnvironment) {
        Remove-ItemProperty -LiteralPath $loadedEnvironment -Name "GH_CONFIG_DIR" -ErrorAction SilentlyContinue
      } else {
        $hiveFile = Join-Path ([string]$profile.LocalPath) "NTUSER.DAT"
        if (-not (Test-Path -LiteralPath $hiveFile -PathType Leaf)) {
          throw "The disposable standard-user environment hive is unavailable for credential cleanup."
        }
        $temporaryHive = "NGTAcceptance_$runId"
        & (Join-Path $env:SystemRoot "System32\reg.exe") load "HKU\$temporaryHive" $hiveFile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not load the disposable user environment hive for credential cleanup." }
        try {
          $environmentKey = "Registry::HKEY_USERS\$temporaryHive\Environment"
          if (Test-Path -LiteralPath $environmentKey) {
            Remove-ItemProperty -LiteralPath $environmentKey -Name "GH_CONFIG_DIR" -ErrorAction SilentlyContinue
          }
        } finally {
          & (Join-Path $env:SystemRoot "System32\reg.exe") unload "HKU\$temporaryHive" | Out-Null
          if ($LASTEXITCODE -ne 0) { $credentialCleanupFailed = $true }
        }
      }
    } catch {
      $credentialCleanupFailed = $true
    }
  }
  try {
    $sanitizedDiagnostics = Get-ChildItem -LiteralPath $isolatedTemp -Directory -Filter "ngt-*-diagnostics" -ErrorAction SilentlyContinue
    if ($sanitizedDiagnostics) {
      $containsToken = $false
      if ($expectedTokenSha256 -and $env:GH_TOKEN) {
        foreach ($directory in $sanitizedDiagnostics) {
          foreach ($file in Get-ChildItem -LiteralPath $directory.FullName -File -Force -Recurse) {
            if ([System.IO.File]::ReadAllText($file.FullName).Contains($env:GH_TOKEN)) {
              $containsToken = $true
              break
            }
          }
          if ($containsToken) { break }
        }
      }
      if ($containsToken) {
        Write-Warning "Acceptance diagnostics contained the GitHub token and were discarded."
      } else {
        $retainedDiagnostics = Join-Path $env:RUNNER_TEMP "ngt-acceptance-diagnostics"
        New-Item -ItemType Directory -Path $retainedDiagnostics -Force | Out-Null
        foreach ($directory in $sanitizedDiagnostics) {
          Copy-Item -LiteralPath $directory.FullName -Destination $retainedDiagnostics -Recurse -Force
        }
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
    if (Test-Path -LiteralPath $isolatedTemp) { $credentialCleanupFailed = $true }
  }
  if ($Acceptance -eq "production-update") {
    Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
  }
  if ($processTerminationFailed -or $credentialCleanupFailed) {
    throw "The isolated GitHub credentials or standard-user process could not be fully cleaned up; discard this hosted runner."
  }
}
