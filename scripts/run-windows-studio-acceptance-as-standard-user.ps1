param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("online-update", "installer", "manual-installer", "production-update")]
  [string]$Acceptance,
  [switch]$Child,
  [string]$RequestPath,
  [switch]$AuthMatrixOnly
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-studio-acceptance-coordinator.ps1")

function Get-NgtAcceptanceSha256([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Invoke-NgtGhAuthToken([string]$GhPath, [string]$ConfigDirectory, [string]$GhToken, [string]$GithubToken, [string]$Hostname) {
  $previousEnvironment = @{
    GH_CONFIG_DIR = [Environment]::GetEnvironmentVariable("GH_CONFIG_DIR", "Process")
    GH_TOKEN = [Environment]::GetEnvironmentVariable("GH_TOKEN", "Process")
    GITHUB_TOKEN = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "Process")
  }
  try {
    if ($ConfigDirectory) { $env:GH_CONFIG_DIR = $ConfigDirectory }
    else { Remove-Item Env:\GH_CONFIG_DIR -ErrorAction SilentlyContinue }
    if ($null -ne $GhToken) { $env:GH_TOKEN = $GhToken }
    else { Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue }
    if ($null -ne $GithubToken) { $env:GITHUB_TOKEN = $GithubToken }
    else { Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue }
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $GhPath
    $startInfo.Arguments = "auth token --hostname $Hostname"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $childEnvironment = $startInfo.EnvironmentVariables
    foreach ($name in @("GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN")) {
      $childEnvironment.Remove($name)
    }
    if ($ConfigDirectory) { $childEnvironment["GH_CONFIG_DIR"] = $ConfigDirectory }
    if ($null -ne $GhToken) { $childEnvironment["GH_TOKEN"] = $GhToken }
    if ($null -ne $GithubToken) { $childEnvironment["GITHUB_TOKEN"] = $GithubToken }
    $ghProcess = [System.Diagnostics.Process]::new()
    $ghProcess.StartInfo = $startInfo
    [void]$ghProcess.Start()
    $stdoutTask = $ghProcess.StandardOutput.ReadToEndAsync()
    $stderrTask = $ghProcess.StandardError.ReadToEndAsync()
    if (-not $ghProcess.WaitForExit(15000)) {
      $ghProcess.Kill()
      [void]$ghProcess.WaitForExit(5000)
      throw "GitHub CLI authentication probe timed out."
    }
    $token = $stdoutTask.GetAwaiter().GetResult().Trim()
    [void]$stderrTask.GetAwaiter().GetResult()
    $exitCode = $ghProcess.ExitCode
    return [pscustomobject]@{ ExitCode = $exitCode; Token = $token }
  } finally {
    foreach ($name in @("GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN")) {
      $value = $previousEnvironment[$name]
      if ($null -eq $value) { Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
    }
  }
}

function Assert-NgtGhAuthMode(
  [string]$GhPath,
  [string]$Mode,
  [string]$ConfigDirectory,
  [string]$GhToken,
  [string]$GithubToken,
  [string]$ExpectedTokenSha256,
  [string]$ExpectedToken,
  [switch]$ExpectUnauthenticated
) {
  # A dedicated host keeps the current Windows user's persisted github.com login out of this negative probe.
  $hostname = if ($ExpectUnauthenticated) { "ngt-noauth.invalid" } else { "github.com" }
  $result = Invoke-NgtGhAuthToken $GhPath $ConfigDirectory $GhToken $GithubToken $hostname
  if ($ExpectUnauthenticated) {
    if ($result.ExitCode -eq 0 -or $result.Token) {
      throw "GitHub CLI accepted credentials in the unauthenticated $Mode mode."
    }
  } elseif ($result.ExitCode -ne 0 -or
      ($ExpectedTokenSha256 -and (Get-NgtAcceptanceSha256 $result.Token) -cne $ExpectedTokenSha256) -or
      ($ExpectedToken -and $result.Token -cne $ExpectedToken)) {
    throw "GitHub CLI did not honor the expected $Mode authentication source."
  }
  Write-Output "GitHub CLI authentication mode passed: $Mode."
}

function Test-NgtGhAuthMatrix([string]$GhPath, [string]$TestRoot, [string]$ConfigToken) {
  $configDirectory = Join-Path $TestRoot "config"
  $emptyDirectory = Join-Path $TestRoot "empty-config"
  New-Item -ItemType Directory -Path $emptyDirectory -Force | Out-Null
  $configTokenHash = Get-NgtAcceptanceSha256 $ConfigToken
  $ghOnlyToken = "ngt-gh-token-only-probe"
  $githubOnlyToken = "ngt-github-token-only-probe"
  $bothGhToken = "ngt-gh-token-priority-probe"
  $bothGithubToken = "ngt-github-token-lower-priority-probe"
  Assert-NgtGhAuthMode $GhPath "GH_TOKEN only" $emptyDirectory $ghOnlyToken $null `
    (Get-NgtAcceptanceSha256 $ghOnlyToken)
  Assert-NgtGhAuthMode $GhPath "GITHUB_TOKEN only" $emptyDirectory $null $githubOnlyToken `
    (Get-NgtAcceptanceSha256 $githubOnlyToken)
  Assert-NgtGhAuthMode $GhPath "GH_CONFIG_DIR only" $configDirectory $null $null $configTokenHash
  Assert-NgtGhAuthMode $GhPath "both tokens" $configDirectory $bothGhToken $bothGithubToken $null $bothGhToken
  Assert-NgtGhAuthMode $GhPath "no credentials" $emptyDirectory $null $null $null $null -ExpectUnauthenticated
}

if ($AuthMatrixOnly) {
  $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ngt-gh-auth-" + [guid]::NewGuid().ToString("N"))
  $configDirectory = Join-Path $testRoot "config"
  $configToken = "ngt-config-only-probe"
  try {
    New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
    [System.IO.File]::WriteAllText(
      (Join-Path $configDirectory "hosts.yml"),
      "github.com:`r`n    oauth_token: $configToken`r`n    git_protocol: https`r`n",
      [System.Text.Encoding]::UTF8
    )
    $ghPath = Get-Command gh.exe -ErrorAction Stop | Select-Object -ExpandProperty Source
    Test-NgtGhAuthMatrix $ghPath $testRoot $configToken
  } finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
  }
  exit 0
}

if ($Child) {
  $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
  foreach ($name in @("GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN")) {
    Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
  }
  foreach ($entry in $request.environment.PSObject.Properties) {
    if ($null -ne $entry.Value) {
      [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, "Process")
    }
  }

  if ($request.ghConfigDirectory) {
    $expectedConfigDirectory = [System.IO.Path]::GetFullPath([string]$request.ghConfigDirectory)
    if (-not $env:GH_CONFIG_DIR -or
        [System.IO.Path]::GetFullPath($env:GH_CONFIG_DIR) -ine $expectedConfigDirectory -or
        -not (Test-Path -LiteralPath (Join-Path $expectedConfigDirectory "hosts.yml") -PathType Leaf)) {
      throw "The isolated GitHub CLI configuration was not available to the standard-user process."
    }
    $configTokenMatch = [regex]::Match(
      (Get-Content -LiteralPath (Join-Path $expectedConfigDirectory "hosts.yml") -Raw),
      '(?m)^\s+oauth_token:\s*(\S+)\s*$'
    )
    if (-not $configTokenMatch.Success -or
        (Get-NgtAcceptanceSha256 $configTokenMatch.Groups[1].Value) -cne [string]$request.expectedTokenSha256) {
      throw "The standard-user child process could not read the expected token from GH_CONFIG_DIR."
    }
    Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue
    $env:GH_CONFIG_DIR = $expectedConfigDirectory
  }

  if ($request.verifyGitHubAuth) {
    [Environment]::SetEnvironmentVariable("GH_CONFIG_DIR", $expectedConfigDirectory, "User")
    $userConfigDirectory = [Environment]::GetEnvironmentVariable("GH_CONFIG_DIR", "User")
    if (-not $userConfigDirectory -or
        [System.IO.Path]::GetFullPath($userConfigDirectory) -ine $expectedConfigDirectory) {
      throw "The isolated GH_CONFIG_DIR was not persisted for the standard-user profile."
    }
    $gh = Get-Command gh.exe -ErrorAction Stop
    Test-NgtGhAuthMatrix $gh.Source ([string]$request.authProbeRoot) $configTokenMatch.Groups[1].Value

    $repository = [string]$request.environment.NGT_UPDATER_TEST_REPOSITORY
    $targetTag = [string]$request.parameters.TargetTag
    $manifest = Get-Content -LiteralPath ([string]$request.parameters.ExpectedManifestPath) -Raw | ConvertFrom-Json
    $releaseOutput = & $gh.Source release view $targetTag --repo $repository --json tagName,isDraft,assets 2>$null
    if ($LASTEXITCODE -ne 0) { throw "The private updater-test Draft is not readable through GH_CONFIG_DIR only." }
    $release = ($releaseOutput | Out-String) | ConvertFrom-Json
    $expectedNames = @($manifest.assets | ForEach-Object name | Sort-Object)
    $releaseNames = @($release.assets | ForEach-Object name | Sort-Object)
    if ($release.tagName -ne $targetTag -or -not $release.isDraft -or
        (Compare-Object -ReferenceObject $expectedNames -DifferenceObject $releaseNames)) {
      throw "The authenticated updater-test Draft identity or asset inventory is incorrect."
    }
    $draftDownloadDirectory = Join-Path ([string]$request.authProbeRoot) "private-draft-assets"
    New-Item -ItemType Directory -Path $draftDownloadDirectory -Force | Out-Null
    try {
      & $gh.Source release download $targetTag --repo $repository --dir $draftDownloadDirectory 2>$null
      if ($LASTEXITCODE -ne 0) { throw "The private updater-test Draft assets could not be downloaded through GH_CONFIG_DIR only." }
      $downloadedNames = @(Get-ChildItem -LiteralPath $draftDownloadDirectory -File | ForEach-Object Name | Sort-Object)
      if (Compare-Object -ReferenceObject $expectedNames -DifferenceObject $downloadedNames) {
        throw "The downloaded private Draft asset inventory is incorrect."
      }
      foreach ($asset in $manifest.assets) {
        $assetPath = Join-Path $draftDownloadDirectory $asset.name
        if ((Get-Item -LiteralPath $assetPath).Length -ne [long]$asset.size -or
            (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$asset.sha256) {
          throw "A downloaded private Draft asset does not match the candidate SHA256: $($asset.name)"
        }
      }
    } finally {
      if (Test-Path -LiteralPath $draftDownloadDirectory) {
        Remove-Item -LiteralPath $draftDownloadDirectory -Recurse -Force
      }
    }
    [System.IO.File]::WriteAllText([string]$request.authProbeReadyPath, "READY", [System.Text.Encoding]::ASCII)
    $taskProbeDeadline = (Get-Date).AddMinutes(3)
    while (-not (Test-Path -LiteralPath ([string]$request.authProbeResultPath) -PathType Leaf) -and
        (Get-Date) -lt $taskProbeDeadline) { Start-Sleep -Milliseconds 250 }
    Assert-NgtAcceptanceFileContent -Path ([string]$request.authProbeResultPath) `
      -Expected "PASS" -Description "The scheduled-task GH_CONFIG_DIR restart probe"
    Write-Output "GH_CONFIG_DIR-only private Draft view, full asset download, and scheduled-task restart passed."
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
    $childFailure = $_
    [Console]::Error.WriteLine(("{0}: {1}`r`n{2}" -f
      $childFailure.Exception.GetType().FullName,
      $childFailure.Exception.Message,
      $childFailure.ScriptStackTrace))
    try {
      $invocation = $childFailure.InvocationInfo
      $childFailureReport = [ordered]@{
        type = $childFailure.Exception.GetType().FullName
        message = $childFailure.Exception.Message
        script = $invocation.ScriptName
        line = $invocation.ScriptLineNumber
        sourceLine = $invocation.Line
        position = $invocation.PositionMessage
        scriptStackTrace = $childFailure.ScriptStackTrace
      }
      [System.IO.File]::WriteAllText(
        [string]$request.failurePath,
        ($childFailureReport | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
      )
    } catch {
      [Console]::Error.WriteLine("Could not retain structured child failure details.")
    }
    $childExitCode = 1
  } finally {
    foreach ($name in @("GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR")) {
      Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
    }
    if ($request.verifyGitHubAuth) {
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
$requiresGitHubAuth = ($Acceptance -in @("manual-installer", "production-update")) -or
  ($Acceptance -eq "online-update" -and -not $parameters.CandidateDirectory)

$runId = [guid]::NewGuid().ToString("N")
$userName = "ngtci" + $runId.Substring(0, 8)
$account = "$env:COMPUTERNAME\$userName"
$passwordPlain = $runId + "Aa1!"
$password = ConvertTo-SecureString $passwordPlain -AsPlainText -Force
$user = $null
$process = $null
$cleanupFailures = New-Object 'System.Collections.Generic.List[object]'
$failureRecord = $null
$acceptanceTimedOut = $false
$childExitCode = $null
$processExitCode = $null
$capturedStdout = ""
$capturedStderr = ""
$childFailureDetails = $null
$additionalDiagnostics = New-Object 'System.Collections.Generic.List[string]'
$taskName = $null
$taskRegistered = $false
$workspaceAclPaths = @()
$isolatedTemp = Join-Path $env:RUNNER_TEMP ("ngt-acceptance-" + $runId)
$requestPath = Join-Path $isolatedTemp "request.json"
$childFailurePath = Join-Path $isolatedTemp "child-failure.json"
$resultPath = Join-Path $isolatedTemp "acceptance.exit-code"
$stdoutPath = Join-Path $isolatedTemp "acceptance.stdout.log"
$stderrPath = Join-Path $isolatedTemp "acceptance.stderr.log"
$ghConfigDirectory = Join-Path $isolatedTemp "gh-config"
$hostsPath = Join-Path $ghConfigDirectory "hosts.yml"
$authProbeRoot = Join-Path $isolatedTemp "auth-probe"
$authProbeReadyPath = Join-Path $isolatedTemp "auth-probe.ready"
$authProbeResultPath = Join-Path $isolatedTemp "auth-probe.result"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$ghExecutablePath = $null
$expectedTokenSha256 = $null
$protectedTokens = @(
  $env:GH_TOKEN,
  $env:GITHUB_TOKEN
) | Where-Object { -not [string]::IsNullOrEmpty($_) }
$diagnosticSecrets = @($protectedTokens + @($passwordPlain))

try {
  if ($requiresGitHubAuth) {
    if (-not $env:GH_TOKEN) { throw "GitHub release acceptance requires the scoped GitHub Actions token." }
    $expectedTokenSha256 = Get-NgtAcceptanceSha256 $env:GH_TOKEN
    if ($Acceptance -eq "production-update") {
      $ghExecutablePath = Get-Command gh.exe -ErrorAction Stop | Select-Object -ExpandProperty Source
    }
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

  if ($requiresGitHubAuth) {
    New-Item -ItemType Directory -Path $ghConfigDirectory -Force | Out-Null
    if ($Acceptance -eq "production-update") {
      New-Item -ItemType Directory -Path $authProbeRoot -Force | Out-Null
    }
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
    failurePath = $childFailurePath
    environment = @{
      GITHUB_ACTIONS = $env:GITHUB_ACTIONS
      RUNNER_ENVIRONMENT = $env:RUNNER_ENVIRONMENT
      RUNNER_OS = $env:RUNNER_OS
      GITHUB_SHA = $env:GITHUB_SHA
      GITHUB_REF_NAME = $env:GITHUB_REF_NAME
      NGT_RELEASE_READY = $env:NGT_RELEASE_READY
      GITHUB_WORKSPACE = $workspace
      RUNNER_TEMP = $isolatedTemp
      GH_CONFIG_DIR = if ($requiresGitHubAuth) { $ghConfigDirectory } else { $null }
      NGT_MANUAL_UPGRADE_BASELINE = $env:NGT_MANUAL_UPGRADE_BASELINE
      NGT_PRODUCTION_UPDATER_BASELINE = $env:NGT_PRODUCTION_UPDATER_BASELINE
      NGT_UPDATER_TEST_REPOSITORY = $env:NGT_UPDATER_TEST_REPOSITORY
      PATH = $env:PATH
    }
    verifyGitHubAuth = ($Acceptance -eq "production-update")
    ghConfigDirectory = if ($requiresGitHubAuth) { $ghConfigDirectory } else { $null }
    expectedTokenSha256 = $expectedTokenSha256
    authProbeRoot = if ($Acceptance -eq "production-update") { $authProbeRoot } else { $null }
    authProbeReadyPath = if ($Acceptance -eq "production-update") { $authProbeReadyPath } else { $null }
    authProbeResultPath = if ($Acceptance -eq "production-update") { $authProbeResultPath } else { $null }
  }
  $requestText = $request | ConvertTo-Json -Depth 6
  foreach ($protectedToken in $protectedTokens) {
    if ($requestText.IndexOf($protectedToken, [System.StringComparison]::Ordinal) -ge 0) {
      throw "The GitHub token must not be written to request.json."
    }
  }
  [System.IO.File]::WriteAllText($requestPath, $requestText, [System.Text.Encoding]::UTF8)

  $credential = [System.Management.Automation.PSCredential]::new($account, $password)
  $childArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Acceptance ' + $Acceptance + ' -Child -RequestPath "' + $requestPath + '"'
  Write-Output "Starting the verified $Acceptance acceptance as a disposable standard Windows user."
  $process = Start-Process -FilePath $powershellPath -ArgumentList $childArguments `
    -Credential $credential -LoadUserProfile -WorkingDirectory $workspace `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru

  $acceptanceDeadline = (Get-Date).AddMinutes(110)
  $nextProgress = (Get-Date).AddMinutes(1)
  $taskProbeCompleted = ($Acceptance -ne "production-update")
  while (-not $process.WaitForExit(1000)) {
    if (-not $taskProbeCompleted -and (Test-Path -LiteralPath $authProbeReadyPath -PathType Leaf)) {
      try {
        $taskName = "NGT Release GH Config Probe " + $runId
        $taskScript = Join-Path $workspace "scripts\test-windows-studio-gh-config-task.ps1"
        $taskArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $taskScript + '" -GhPath "' + $ghExecutablePath + '" -ExpectedConfigDirectory "' + $ghConfigDirectory + '" -ExpectedTokenSha256 ' + $expectedTokenSha256 + ' -ResultPath "' + $authProbeResultPath + '"'
        $taskAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $taskArguments
        $taskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2)
        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger `
          -User $account -Password $passwordPlain -RunLevel Limited -Force | Out-Null
        $taskRegistered = $true
        Start-ScheduledTask -TaskName $taskName
        $taskDeadline = (Get-Date).AddSeconds(90)
        while (-not (Test-Path -LiteralPath $authProbeResultPath -PathType Leaf) -and
            (Get-Date) -lt $taskDeadline) { Start-Sleep -Milliseconds 250 }
        try {
          Assert-NgtAcceptanceFileContent -Path $authProbeResultPath `
            -Expected "PASS" -Description "The scheduled-task GH_CONFIG_DIR restart probe"
        } catch {
          [System.IO.File]::WriteAllText($authProbeResultPath, "FAIL", [System.Text.Encoding]::ASCII)
          throw
        }
        $taskStopDeadline = (Get-Date).AddSeconds(10)
        do {
          $taskState = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State
          if ($taskState -eq "Ready") { break }
          Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $taskStopDeadline)
        if ($taskState -ne "Ready") { throw "The isolated credential probe task did not finish cleanly." }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        $taskRegistered = $false
        [System.IO.File]::WriteAllText($authProbeResultPath, "PASS", [System.Text.Encoding]::ASCII)
        $taskProbeCompleted = $true
      } catch {
        if (-not (Test-Path -LiteralPath $authProbeResultPath -PathType Leaf)) {
          [System.IO.File]::WriteAllText($authProbeResultPath, "FAIL", [System.Text.Encoding]::ASCII)
        }
        throw
      }
    }
    if ((Get-Date) -ge $acceptanceDeadline) {
      $acceptanceTimedOut = $true
      try {
        & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $process.Id /T /F | Out-Null
        [void]$process.WaitForExit(5000)
        $process.Refresh()
        if (-not $process.HasExited) { throw "The standard-user acceptance process remained active after timeout termination." }
        $processExitCode = $process.ExitCode
      } catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Timed-out acceptance process termination" -ErrorRecord $_ }
      $timeoutOutcome = Get-NgtAcceptanceProcessOutcome -Acceptance $Acceptance `
        -StdoutPath $stdoutPath -StderrPath $stderrPath -ResultPath $resultPath `
        -ProcessExitCode $processExitCode -Tokens $protectedTokens -TimedOut
      $capturedStdout = $timeoutOutcome.Stdout
      $capturedStderr = $timeoutOutcome.Stderr
      throw $timeoutOutcome.FailureMessage
    }
    if ((Get-Date) -ge $nextProgress) {
      Write-Output "The standard-user acceptance is still running."
      $nextProgress = (Get-Date).AddMinutes(1)
    }
  }
  $process.Refresh()
  $processExitCode = $process.ExitCode
  Assert-NgtAcceptanceTokenNotExposed -Paths @($stdoutPath, $stderrPath, $requestPath) -Tokens $protectedTokens
  $outcome = Get-NgtAcceptanceProcessOutcome -Acceptance $Acceptance `
    -StdoutPath $stdoutPath -StderrPath $stderrPath -ResultPath $resultPath `
    -ProcessExitCode $processExitCode -Tokens $protectedTokens
  $childExitCode = $outcome.ChildExitCode
  $capturedStdout = $outcome.Stdout
  $capturedStderr = $outcome.Stderr
  Assert-NgtAcceptanceProcessSucceeded -Outcome $outcome
  if (-not [string]::IsNullOrEmpty($capturedStdout)) { Write-Output $capturedStdout }
  if (-not [string]::IsNullOrEmpty($capturedStderr)) {
    Write-Output ("Acceptance stderr:`r`n" + $capturedStderr)
  }
} catch {
  $failureRecord = $_
} finally {
  if ($taskRegistered -and $taskName) {
    try {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
      $taskStopDeadline = (Get-Date).AddSeconds(5)
      do {
        $taskState = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State
        if ($taskState -eq "Ready") { break }
        Start-Sleep -Milliseconds 250
      } while ((Get-Date) -lt $taskStopDeadline)
      if ($taskState -ne "Ready") { throw "The isolated credential probe task did not stop before cleanup." }
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    } catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Scheduled authentication task" -ErrorRecord $_ }
  }
  if ($process) {
    try {
      $process.Refresh()
      if (-not $process.HasExited) {
        & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $process.Id /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "taskkill returned exit code $LASTEXITCODE." }
        [void]$process.WaitForExit(5000)
        $process.Refresh()
        if (-not $process.HasExited) { throw "The standard-user acceptance process is still running." }
      }
      if ($null -eq $processExitCode -and $process.HasExited) { $processExitCode = $process.ExitCode }
    } catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Acceptance process termination" -ErrorRecord $_ }
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
        $loadedConfig = Get-ItemProperty -LiteralPath $loadedEnvironment -Name "GH_CONFIG_DIR" -ErrorAction SilentlyContinue
        if ($loadedConfig) {
          Remove-ItemProperty -LiteralPath $loadedEnvironment -Name "GH_CONFIG_DIR" -ErrorAction Stop
          if ((Get-ItemProperty -LiteralPath $loadedEnvironment -Name "GH_CONFIG_DIR" -ErrorAction SilentlyContinue).GH_CONFIG_DIR) {
            throw "The isolated GH_CONFIG_DIR remained in the disposable user's loaded environment."
          }
        }
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
            $hiveConfig = Get-ItemProperty -LiteralPath $environmentKey -Name "GH_CONFIG_DIR" -ErrorAction SilentlyContinue
            if ($hiveConfig) {
              Remove-ItemProperty -LiteralPath $environmentKey -Name "GH_CONFIG_DIR" -ErrorAction Stop
              if ((Get-ItemProperty -LiteralPath $environmentKey -Name "GH_CONFIG_DIR" -ErrorAction SilentlyContinue).GH_CONFIG_DIR) {
                throw "The isolated GH_CONFIG_DIR remained in the disposable user's environment hive."
              }
            }
          }
        } finally {
          & (Join-Path $env:SystemRoot "System32\reg.exe") unload "HKU\$temporaryHive" | Out-Null
          if ($LASTEXITCODE -ne 0) { throw "Could not unload the disposable user environment hive after credential cleanup." }
        }
      }
    } catch {
      Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Disposable GitHub credential cleanup" -ErrorRecord $_
    }
  }
  try {
    foreach ($path in @($stdoutPath, $stderrPath)) {
      $log = Read-NgtAcceptanceTextFile -Path $path
      if ($path -eq $stdoutPath) { $capturedStdout = $log.Text }
      else { $capturedStderr = $log.Text }
    }
  } catch {
    Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Acceptance log collection" -ErrorRecord $_
  }
  try {
    Assert-NgtAcceptanceTokenNotExposed -Paths @($stdoutPath, $stderrPath, $requestPath, $resultPath) -Tokens $protectedTokens
  } catch {
    Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "GitHub credential exposure check" -ErrorRecord $_
  }
  try {
    if (Test-Path -LiteralPath $childFailurePath -PathType Leaf) {
      try {
        $childFailureText = [System.IO.File]::ReadAllText($childFailurePath)
        Assert-NgtAcceptanceTokenNotExposed -Paths @($childFailurePath) -Tokens $protectedTokens
        $childFailureDetails = $childFailureText | ConvertFrom-Json
      } catch {
        if ($_.Exception.Message -match "token was exposed") {
          try { throw "A child failure detail contained a protected GitHub credential." }
          catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Child failure credential exposure check" -ErrorRecord $_ }
          try { $childFailureDetails = $childFailureText | ConvertFrom-Json } catch { }
        } else {
          Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Structured child failure collection" -ErrorRecord $_
        }
      }
    }
  } catch {
    Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Structured child failure collection" -ErrorRecord $_
  }
  try {
    if (Test-Path -LiteralPath $isolatedTemp -PathType Container) {
      $sanitizedDiagnostics = Get-ChildItem -LiteralPath $isolatedTemp -Directory -Filter "ngt-*-diagnostics" -ErrorAction Stop
      foreach ($directory in $sanitizedDiagnostics) {
        foreach ($file in Get-ChildItem -LiteralPath $directory.FullName -File -Force -Recurse -ErrorAction Stop) {
          if ($file.Extension -notin @(".log", ".json")) { continue }
          if ($file.Name -in @("request.json", "hosts.yml", "child-failure.json", "acceptance.exit-code")) { continue }
          $text = [System.IO.File]::ReadAllText($file.FullName)
          $containsToken = $false
          foreach ($protectedToken in $protectedTokens) {
            if ($text.IndexOf($protectedToken, [System.StringComparison]::Ordinal) -ge 0) {
              $containsToken = $true
            }
          }
          if ($containsToken) {
            try { throw "A child diagnostic contained a protected GitHub credential." }
            catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Child diagnostic credential exposure check" -ErrorRecord $_ }
          }
          $safeText = Protect-NgtAcceptanceDiagnosticText -Text $text -Secrets @($protectedTokens + @($passwordPlain))
          $additionalDiagnostics.Add(("{0}/{1}`r`n{2}" -f $directory.Name, $file.Name, $safeText))
        }
      }
    }
  } catch {
    Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Sanitized diagnostic collection" -ErrorRecord $_
  }
  foreach ($entry in $workspaceAclPaths) {
    try {
      $icaclsArguments = @($entry.Path, "/remove", $account)
      if ($entry.Recursive) { $icaclsArguments += @("/T", "/C") }
      $icaclsArguments += "/Q"
      & (Join-Path $env:SystemRoot "System32\icacls.exe") @icaclsArguments | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "icacls returned exit code $LASTEXITCODE while removing the acceptance user ACL." }
    } catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Workspace ACL cleanup" -ErrorRecord $_ }
  }
  if ($user) {
    try { Remove-LocalUser -Name $userName -ErrorAction Stop }
    catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Disposable standard-user removal" -ErrorRecord $_ }
  }
  try {
    if (Test-Path -LiteralPath $isolatedTemp) {
      Remove-Item -LiteralPath $isolatedTemp -Recurse -Force -ErrorAction Stop
      if (Test-Path -LiteralPath $isolatedTemp) { throw "The isolated acceptance credential directory remains after cleanup." }
    }
  } catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Isolated credential and work directory cleanup" -ErrorRecord $_ }
  if ($requiresGitHubAuth) {
    Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
  }
  if ($password) {
    try { $password.Dispose() }
    catch { Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Credential object disposal" -ErrorRecord $_ }
  }
  $passwordPlain = $null
}

if ($failureRecord -or $cleanupFailures.Count -gt 0) {
  $diagnosticDirectoryName = "ngt-acceptance-diagnostics-{0}-{1}" -f $env:GITHUB_RUN_ID, $env:GITHUB_RUN_ATTEMPT
  $diagnosticPath = Join-Path (Join-Path $env:RUNNER_TEMP $diagnosticDirectoryName) "acceptance-failure.json"
  try {
    Write-NgtAcceptanceFailureDiagnostic -Path $diagnosticPath -Acceptance $Acceptance `
      -FailureRecord $failureRecord -ChildFailure $childFailureDetails -CleanupFailures $cleanupFailures.ToArray() `
      -Stdout $capturedStdout -Stderr $capturedStderr -ChildExitCode $childExitCode `
      -ProcessExitCode $processExitCode -TimedOut:$acceptanceTimedOut `
      -Secrets $diagnosticSecrets -AdditionalDiagnostics $additionalDiagnostics.ToArray()
  } catch {
    Add-NgtAcceptanceCleanupFailure -Failures $cleanupFailures -Step "Failure artifact generation" -ErrorRecord $_
  }
  if ($failureRecord) { throw $failureRecord }
  Assert-NgtAcceptanceCleanupSucceeded -Failures $cleanupFailures
}
