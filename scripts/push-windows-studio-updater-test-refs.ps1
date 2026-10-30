param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("baseline", "candidate")]
  [string]$Stage
)
$ErrorActionPreference = "Stop"

$repository = $env:NGT_UPDATER_TEST_REPOSITORY
$token = $env:NGT_UPDATER_TEST_TOKEN
$candidateSha = $env:GITHUB_SHA
$candidateVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\package.json") -Raw | ConvertFrom-Json).version
$candidateTag = "v$candidateVersion"
if ($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
    $repository -ieq "JayWangsj/ngt1" -or
    -not $token -or
    $candidateVersion -notmatch '^\d+\.\d+\.\d+$' -or
    [version]$candidateVersion -le [version]"2.0.21" -or
    $candidateSha -notmatch '^[a-f0-9]{40}$') {
  throw "Isolated updater test repository identity or scoped credential is invalid."
}

$fetchOutput = & git fetch --no-tags origin refs/tags/v2.0.21 2>&1
if ($LASTEXITCODE -ne 0) { throw "Could not fetch the pinned v2.0.21 source tag." }
$baselineSha = (& git rev-parse "FETCH_HEAD^{commit}").Trim().ToLowerInvariant()
$localCandidateSha = (& git rev-parse "$candidateSha^{commit}").Trim().ToLowerInvariant()
if ($baselineSha -notmatch '^[a-f0-9]{40}$' -or $localCandidateSha -ne $candidateSha.ToLowerInvariant()) {
  throw "The updater test Git refs could not be resolved to exact source commits."
}
& git merge-base --is-ancestor $baselineSha $candidateSha
if ($LASTEXITCODE -ne 0) { throw "The Release Ready candidate is not based on published v2.0.21." }

$askPass = Join-Path $env:RUNNER_TEMP ("ngt-updater-test-askpass-" + [guid]::NewGuid().ToString("N") + ".cmd")
try {
  [System.IO.File]::WriteAllText($askPass, "@echo off`r`necho %NGT_UPDATER_GIT_ASKPASS_RESPONSE%`r`n", [System.Text.Encoding]::ASCII)
  $env:GIT_ASKPASS = $askPass
  $env:GIT_ASKPASS_REQUIRE = "force"
  $env:GIT_TERMINAL_PROMPT = "0"
  $env:NGT_UPDATER_GIT_ASKPASS_RESPONSE = $token
  $remote = "https://x-access-token@github.com/$repository.git"
  $remoteHeads = & git -c http.https://github.com/.extraheader= -c credential.helper= ls-remote --heads $remote 2>&1 | Out-String
  $headsExitCode = $LASTEXITCODE
  if ($remoteHeads.Contains($token)) { throw "GitHub test repository credentials were exposed by Git output." }
  if ($headsExitCode -ne 0) { throw "The isolated updater test repository could not be inspected." }
  $headEntries = @($remoteHeads -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object {
    $fields = $_ -split "\s+"
    [pscustomobject]@{ Sha = $fields[0].ToLowerInvariant(); Ref = $fields[1] }
  })
  if ($headEntries.Count -gt 1 -or ($headEntries.Count -eq 1 -and $headEntries[0].Ref -ne "refs/heads/main")) {
    throw "The isolated updater test repository must have no user branches except its managed main branch."
  }
  $branchSha = if ($headEntries.Count -eq 1) { $headEntries[0].Sha } else { $null }
  if ($branchSha -and $branchSha -notin @($baselineSha, $candidateSha.ToLowerInvariant())) {
    throw "The isolated updater test main branch contains unexpected source code. Use a fresh private repository."
  }
  $remoteTags = & git -c http.https://github.com/.extraheader= -c credential.helper= ls-remote --tags --refs $remote 2>&1 | Out-String
  $tagsExitCode = $LASTEXITCODE
  if ($remoteTags.Contains($token)) { throw "GitHub test repository credentials were exposed by Git output." }
  if ($tagsExitCode -ne 0) { throw "The isolated updater test repository tags could not be inspected." }
  $allowedTags = @("refs/tags/v2.0.21", "refs/tags/$candidateTag")
  $tagMap = @{}
  foreach ($line in @($remoteTags -split "`r?`n" | Where-Object { $_.Trim() })) {
    $fields = $line -split "\s+"
    $tagMap[$fields[1]] = $fields[0].ToLowerInvariant()
  }
  if (@($tagMap.Keys | Where-Object { $_ -notin $allowedTags }).Count -gt 0) {
    throw "The isolated updater test repository contains unrelated tags. Use a fresh private repository."
  }
  if (($tagMap.ContainsKey("refs/tags/v2.0.21") -and $tagMap["refs/tags/v2.0.21"] -ne $baselineSha) -or
      ($tagMap.ContainsKey("refs/tags/$candidateTag") -and $tagMap["refs/tags/$candidateTag"] -ne $candidateSha.ToLowerInvariant())) {
    throw "An isolated updater test tag already points to a different source SHA. Use a fresh private repository."
  }

  $references = @()
  if ($Stage -eq "baseline") {
    if (-not $branchSha) { $references += "$baselineSha`:refs/heads/main" }
    $references += "$baselineSha`:refs/tags/v2.0.21"
  } else {
    if (-not $branchSha) { throw "Prepare the isolated v2.0.21 baseline before advancing its main branch." }
    if ($branchSha -eq $baselineSha) { $references += "$candidateSha`:refs/heads/main" }
    $references += "$candidateSha`:refs/tags/$candidateTag"
  }
  $pushOutput = & git -c http.https://github.com/.extraheader= -c credential.helper= push --atomic $remote @references 2>&1 | Out-String
  $pushExitCode = $LASTEXITCODE
  if ($pushOutput.Contains($token)) { throw "GitHub test repository credentials were exposed by Git output." }
  if ($pushExitCode -ne 0) { throw "Could not add immutable exact-SHA tags to the isolated updater test repository." }
  Write-Output "Verified isolated updater $Stage refs at their exact source commits."
} finally {
  Remove-Item Env:\NGT_UPDATER_GIT_ASKPASS_RESPONSE -ErrorAction SilentlyContinue
  Remove-Item Env:\GIT_ASKPASS -ErrorAction SilentlyContinue
  Remove-Item Env:\GIT_ASKPASS_REQUIRE -ErrorAction SilentlyContinue
  Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
  Remove-Item Env:\NGT_UPDATER_TEST_TOKEN -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $askPass -Force -ErrorAction SilentlyContinue
}
