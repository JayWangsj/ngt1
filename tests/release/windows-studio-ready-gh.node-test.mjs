import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  handleCandidate,
} = require("../../scripts/windows-studio-ready-gh.cjs");

test("Release Ready serves only verified local candidate assets and delegates published baseline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ngt-ready-gh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tag = "v2.0.16";
  const sha = "a".repeat(40);
  const name = `ngt-studio-windows-${tag}.zip`;
  const bytes = Buffer.from("candidate test bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(directory, name), bytes);
  await writeFile(
    path.join(directory, "release-manifest.json"),
    JSON.stringify({
      tag,
      sha,
      assets: [{ name, size: bytes.length, sha256: digest }],
    }),
  );
  const env = {
    NGT_READY_CANDIDATE_DIR: directory,
    NGT_READY_CANDIDATE_TAG: tag,
    GITHUB_SHA: sha,
  };
  assert.equal(handleCandidate(["release", "view", "v2.0.15"], env), false);
  assert.equal(handleCandidate(["auth", "status"], env), false);
  const destination = path.join(directory, "download");
  assert.equal(
    handleCandidate(
      ["release", "download", tag, "--pattern", name, "--dir", destination],
      env,
    ),
    true,
  );
  assert.deepEqual(await readFile(path.join(destination, name)), bytes);
  assert.throws(
    () =>
      handleCandidate(
        [
          "release",
          "download",
          tag,
          "--pattern",
          "unknown",
          "--dir",
          destination,
        ],
        env,
      ),
    /unknown asset/,
  );
  await writeFile(path.join(directory, name), "tampered");
  assert.throws(
    () =>
      handleCandidate(
        ["release", "download", tag, "--pattern", name, "--dir", destination],
        env,
      ),
    /SHA256 changed/,
  );
});

test(
  "Release Ready baseline uses the local candidate adapter before bundled gh.exe",
  { skip: process.platform !== "win32" },
  () => {
    const helper = path.resolve("scripts/windows-studio-ready-baseline.ps1");
    const command = `
$ErrorActionPreference = 'Stop'
try {
. '${helper.replaceAll("'", "''")}'
$source = 'function Get-NgtGitHubCli {' + "\`r\`n" +
  '  $releaseCli = Join-Path $script:NgtProjectRoot "runtime\\gh.exe"' + "\`r\`n" +
  '  if (Test-Path -LiteralPath $releaseCli) { return $releaseCli }' + "\`r\`n" +
  '  return (Get-Command gh -ErrorAction Stop).Source' + "\`r\`n" + '}'
$env:NGT_READY_GH_SHIM = 'C:\\candidate\\gh.cmd'
Invoke-Expression (Set-NgtReadyBaselineGhShim $source)
if ((Get-NgtGitHubCli) -ne $env:NGT_READY_GH_SHIM) { throw 'Bundled gh.exe bypassed candidate adapter.' }
try {
  Set-NgtReadyBaselineGhShim 'function Get-NgtGitHubCli { return "unrecognized" }' | Out-Null
  throw 'Unsupported baseline was accepted.'
} catch {
  if ($_.Exception.Message -notlike 'Baseline GitHub CLI selection*') { throw }
}
exit 0
} catch { [Console]::Error.WriteLine([string]$_); exit 1 }
`;
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      JSON.stringify({ stdout: result.stdout, stderr: result.stderr }),
    );
  },
);
