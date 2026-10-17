import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  calculateBuildIdentity,
  createLocalManifest,
  createReleaseMarker,
  downloadDraft,
  createWindowsPackageManifest,
  expectedAssetNames,
  findPublishedUpdateBaseline,
  GitHubReleaseApi,
  parseReleaseMarker,
  prepareDraft,
  publishRelease,
  qualifyRelease,
  verifyArtifact,
  verifyWindowsPackageArtifact,
} from "../../scripts/windows-studio-release.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceSha = "a".repeat(40);
const version = "2.0.14";
const tag = "v" + version;

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ngt-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(assets, { recursive: true }),
  );
  for (const name of expectedAssetNames(tag).filter(
    (entry) => !entry.endsWith(".sha256"),
  )) {
    const bytes = Buffer.from("fixture asset: " + name);
    await writeFile(path.join(assets, name), bytes);
    await writeFile(
      path.join(assets, name + ".sha256"),
      sha256(bytes) + "  " + name + "\n",
    );
  }
  const manifest = await createLocalManifest(assets, tag, sourceSha, version);
  return { root, assets, manifest };
}

function makeApi({
  release = null,
  tagCommit = sourceSha,
  ambiguousFirstUpload = false,
} = {}) {
  let state = release;
  let nextId =
    Math.max(0, ...(release?.assets || []).map((asset) => asset.id || 0)) + 1;
  let uploadCount = 0;
  const remoteContents = new Map();
  const uploads = [];
  const deletions = [];
  return {
    deletions,
    uploads,
    remoteContents,
    current: () => state,
    resolveTagCommit: async () => tagCommit,
    findRelease: async () => state,
    generateReleaseNotes: async () => "Generated release notes",
    createDraft: async ({ tag: candidateTag, sha, body }) => {
      state = {
        id: 77,
        tag_name: candidateTag,
        target_commitish: sha,
        draft: true,
        body,
        assets: [],
        upload_url:
          "https://uploads.example.test/releases/77/assets{?name,label}",
        html_url: "https://github.example.test/releases/tag/" + candidateTag,
      };
      return state;
    },
    updateRelease: async (_id, patch) => {
      state = { ...state, ...patch };
      return state;
    },
    deleteRelease: async (id) => {
      assert.equal(state?.id, id);
      deletions.push(id);
      state = null;
    },
    uploadAsset: async (_draft, name, bytes) => {
      uploadCount++;
      uploads.push(name);
      const data = Buffer.from(bytes);
      const asset = {
        id: nextId++,
        name,
        size: data.length,
        digest: "sha256:" + sha256(data),
        url: "asset:" + name,
      };
      remoteContents.set(asset.id, data);
      state.assets.push(asset);
      if (ambiguousFirstUpload && uploadCount === 1) {
        throw Object.assign(new Error("upload response was lost"), {
          retryable: true,
        });
      }
      return asset;
    },
    downloadAsset: async (asset) => remoteContents.get(asset.id),
  };
}

test("manifest ties the six release assets to their sidecars and source Commit", async (t) => {
  const { assets, manifest } = await makeFixture(t);
  assert.equal(manifest.sha, sourceSha);
  assert.equal(manifest.version, version);
  assert.equal(manifest.assets.length, 6);
  assert.equal(manifest.buildIdentity, calculateBuildIdentity(manifest));
  await verifyArtifact(assets, manifest, { sha: sourceSha, tag, version });
  const target = path.join(
    assets,
    manifest.assets.find((entry) => entry.name.endsWith(".zip")).name,
  );
  await writeFile(target, "tampered");
  await assert.rejects(verifyArtifact(assets, manifest), /SHA256 verification/);
});

test("findRelease discovers Draft Releases through the paginated release list", async () => {
  const requests = [];
  const api = new GitHubReleaseApi({
    token: "test-token",
    repository: "JayWangsj/ngt1",
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      requests.push(requestUrl.pathname + requestUrl.search);
      if (requestUrl.pathname.endsWith("/releases/tags/" + tag)) {
        return new Response(null, { status: 404 });
      }
      if (requestUrl.searchParams.get("page") === "1") {
        return new Response(
          JSON.stringify(
            Array.from({ length: 100 }, (_, index) => ({
              tag_name: "other-" + index,
            })),
          ),
          { status: 200 },
        );
      }
      if (requestUrl.searchParams.get("page") === "2") {
        return new Response(
          JSON.stringify([{ id: 123, tag_name: tag, draft: true }]),
          { status: 200 },
        );
      }
      throw new Error("Unexpected GitHub API request: " + requestUrl);
    },
  });

  assert.deepEqual(await api.findRelease(tag), {
    id: 123,
    tag_name: tag,
    draft: true,
  });
  assert.equal(requests.length, 3);
  assert.match(requests[1], /\/releases\?per_page=100&page=1$/);
  assert.match(requests[2], /\/releases\?per_page=100&page=2$/);
});

test("deleteRelease removes a stale Draft by release ID", async () => {
  const requests = [];
  const api = new GitHubReleaseApi({
    token: "test-token",
    repository: "JayWangsj/ngt1",
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url).pathname, method: options.method });
      return new Response(null, { status: 204 });
    },
  });
  await api.deleteRelease(42);
  assert.deepEqual(requests, [
    { url: "/repos/JayWangsj/ngt1/releases/42", method: "DELETE" },
  ]);
});

test("findPublishedUpdateBaseline selects the newest supported stable release below the target", async () => {
  const requests = [];
  const assetsFor = (tag) =>
    [
      `ngt-studio-windows-${tag}.zip`,
      `ngt-studio-windows-${tag}.zip.sha256`,
      `ngt-studio-runtime-${tag}.zip`,
      `ngt-studio-runtime-${tag}.zip.sha256`,
    ].map((name) => ({ name }));
  const api = new GitHubReleaseApi({
    token: "test-token",
    repository: "JayWangsj/ngt1",
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      requests.push(requestUrl.pathname + requestUrl.search);
      return new Response(
        JSON.stringify([
          {
            tag_name: "v2.0.14",
            draft: true,
            assets: assetsFor("v2.0.14"),
          },
          {
            tag_name: "v2.0.15",
            draft: false,
            assets: assetsFor("v2.0.15"),
          },
          {
            tag_name: "v2.0.13-rc.1",
            draft: false,
            prerelease: true,
            assets: assetsFor("v2.0.13-rc.1"),
          },
          {
            tag_name: "v2.0.12",
            draft: false,
            assets: assetsFor("v2.0.12").slice(0, 3),
          },
          {
            tag_name: "v2.0.11",
            draft: false,
            assets: assetsFor("v2.0.11"),
          },
          {
            tag_name: "v2.0.13",
            draft: false,
            assets: assetsFor("v2.0.13"),
          },
        ]),
        { status: 200 },
      );
    },
  });

  const baseline = await findPublishedUpdateBaseline(api, "v2.0.14");
  assert.equal(baseline.tag_name, "v2.0.13");
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/releases\?per_page=100&page=1$/);
});

test("Draft creation survives an ambiguous upload response without duplicating assets", async (t) => {
  const { assets, manifest } = await makeFixture(t);
  const api = makeApi({ ambiguousFirstUpload: true });
  const result = await prepareDraft(api, assets, manifest);
  assert.equal(result.draft, true);
  assert.equal(api.uploads.length, 6);
  assert.equal(new Set(api.uploads).size, 6);
  assert.deepEqual(
    result.assets.map((asset) => asset.name).sort(),
    expectedAssetNames(tag),
  );
  assert.deepEqual(parseReleaseMarker(result.body), {
    tag,
    sha: sourceSha,
    version,
    buildIdentity: manifest.buildIdentity,
  });
});

test("a legacy partial Draft resumes only missing assets after content verification", async (t) => {
  const { assets, manifest } = await makeFixture(t);
  const first = manifest.assets[0];
  const firstBytes = await readFile(path.join(assets, first.name));
  const existing = {
    id: 1,
    name: first.name,
    size: first.size,
    digest: null,
    url: "asset:" + first.name,
  };
  const release = {
    id: 42,
    tag_name: tag,
    draft: true,
    body: "Existing release notes",
    assets: [existing],
    upload_url: "https://uploads.example.test/releases/42/assets{?name,label}",
  };
  const api = makeApi({ release });
  api.remoteContents.set(existing.id, firstBytes);
  const result = await prepareDraft(api, assets, manifest);
  assert.equal(result.draft, true);
  assert.equal(api.uploads.length, 5);
  assert.equal(api.uploads.includes(first.name), false);
  assert.equal(api.current().assets.length, 6);
});

test("a retry replaces only a stale marked Draft for the same tag", async (t) => {
  const { assets, manifest } = await makeFixture(t);
  const staleManifest = { ...manifest, sha: "b".repeat(40) };
  staleManifest.buildIdentity = calculateBuildIdentity(staleManifest);
  const api = makeApi({
    release: {
      id: 43,
      tag_name: tag,
      draft: true,
      body: createReleaseMarker(staleManifest),
      assets: [],
      upload_url:
        "https://uploads.example.test/releases/43/assets{?name,label}",
    },
  });
  const result = await prepareDraft(api, assets, manifest);
  assert.deepEqual(api.deletions, [43]);
  assert.equal(result.draft, true);
  assert.deepEqual(parseReleaseMarker(result.body), {
    tag,
    sha: sourceSha,
    version,
    buildIdentity: manifest.buildIdentity,
  });
  assert.equal(api.uploads.length, 6);
});

test("mismatched or already public Releases fail closed without overwriting", async (t) => {
  const { assets, manifest } = await makeFixture(t);
  const badAsset = {
    id: 8,
    name: manifest.assets[0].name,
    size: manifest.assets[0].size,
    digest: "sha256:" + "f".repeat(64),
  };
  const mismatchApi = makeApi({
    release: {
      id: 8,
      tag_name: tag,
      draft: true,
      body: "",
      assets: [badAsset],
    },
  });
  await assert.rejects(
    prepareDraft(mismatchApi, assets, manifest),
    /digest does not match/,
  );
  assert.equal(mismatchApi.uploads.length, 0);

  const publicApi = makeApi({
    release: { id: 9, tag_name: tag, draft: false, body: "", assets: [] },
  });
  await assert.rejects(
    prepareDraft(publicApi, assets, manifest),
    /published Release already uses this tag/,
  );
  assert.equal(publicApi.uploads.length, 0);
});

test("Draft Release handoff preserves provenance without Actions Artifacts", async (t) => {
  const { root, assets, manifest } = await makeFixture(t);
  const api = makeApi();
  await prepareDraft(api, assets, manifest);
  const downloaded = path.join(root, "downloaded");
  const recovered = await downloadDraft(api, downloaded, {
    tag,
    sha: sourceSha,
    version,
  });
  assert.equal(recovered.buildIdentity, manifest.buildIdentity);
  await verifyArtifact(downloaded, recovered, { tag, sha: sourceSha, version });
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(
    (await readdir(downloaded))
      .sort()
      .filter((name) => name !== "release-manifest.json"),
    expectedAssetNames(tag),
  );
});

test("Draft handoff fails closed on altered bytes, identity, or published state", async (t) => {
  const { root, assets, manifest } = await makeFixture(t);
  const api = makeApi();
  await prepareDraft(api, assets, manifest);
  const release = api.current();
  const target = release.assets.find((asset) => asset.name.endsWith(".zip"));
  const original = api.remoteContents.get(target.id);
  api.remoteContents.set(target.id, Buffer.alloc(original.length, 0));
  await assert.rejects(
    downloadDraft(api, path.join(root, "tampered"), {
      tag,
      sha: sourceSha,
      version,
    }),
    /digest mismatch/,
  );
  api.remoteContents.set(target.id, original);
  release.body = "unexpected release metadata";
  await assert.rejects(
    downloadDraft(api, path.join(root, "wrong-identity"), {
      tag,
      sha: sourceSha,
      version,
    }),
    /identity marker/,
  );
  release.body = createReleaseMarker(manifest);
  release.draft = false;
  await assert.rejects(
    downloadDraft(api, path.join(root, "published"), {
      tag,
      sha: sourceSha,
      version,
    }),
    /identity marker/,
  );
});

test("publication can be safely retried after an ambiguous successful response", async (t) => {
  const { assets, manifest } = await makeFixture(t);
  const releaseAssets = manifest.assets.map((asset, index) => ({
    id: index + 1,
    name: asset.name,
    size: asset.size,
    digest: "sha256:" + asset.sha256,
  }));
  const release = {
    id: 77,
    tag_name: tag,
    draft: true,
    body: createReleaseMarker(manifest),
    assets: releaseAssets,
  };
  const api = makeApi({ release });
  const updateRelease = api.updateRelease;
  let loseFirstResponse = true;
  api.updateRelease = async (...args) => {
    const published = await updateRelease(...args);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw Object.assign(new Error("publish response was lost"), {
        retryable: true,
      });
    }
    return published;
  };

  await assert.rejects(
    publishRelease(api, assets, manifest),
    /publish response was lost/,
  );
  const retried = await publishRelease(api, assets, manifest);
  assert.equal(retried.draft, false);
  assert.equal(api.current().draft, false);
});

test("same-SHA qualification requires all named Verify MVP gates to succeed", async () => {
  const run = {
    id: 123,
    path: ".github/workflows/ci.yml",
    head_sha: sourceSha,
    head_branch: "master",
    event: "push",
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-16T00:00:00Z",
  };
  const names = ["verify", "full-verification", "windows-studio-smoke"];
  const api = {
    resolveTagCommit: async () => sourceSha,
    findRelease: async () => null,
    listVerifyRuns: async () => ({ workflow_runs: [run] }),
    listRunJobs: async () => ({
      jobs: names.map((name) => ({ name, conclusion: "success" })),
    }),
  };
  const accepted = await qualifyRelease({
    api,
    tag,
    sha: sourceSha,
    version,
    timeoutMs: 100,
  });
  assert.equal(accepted.run.id, run.id);

  api.listRunJobs = async () => ({
    jobs: names.map((name) => ({
      name,
      conclusion: name === "windows-studio-smoke" ? "cancelled" : "success",
    })),
  });
  await assert.rejects(
    qualifyRelease({ api, tag, sha: sourceSha, version, timeoutMs: 100 }),
    /incomplete or failed required gates/,
  );
});

test("Windows Smoke package provenance detects mutation and source mismatch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ngt-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "artifact");
  const packageDirectory = path.join(root, "package");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(artifacts, { recursive: true }),
  );
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(packageDirectory, { recursive: true }),
  );
  const archiveName = "ngt-studio-windows-v" + version + ".zip";
  const bytes = Buffer.from("smoke package bytes");
  await writeFile(path.join(artifacts, archiveName), bytes);
  await writeFile(
    path.join(artifacts, archiveName + ".sha256"),
    sha256(bytes) + "  " + archiveName + "\n",
  );
  await writeFile(
    path.join(packageDirectory, "studio-release.json"),
    JSON.stringify({
      version,
      commit: sourceSha,
      runtimeHash: "b".repeat(64),
    }),
  );
  const manifest = await createWindowsPackageManifest(
    artifacts,
    packageDirectory,
    sourceSha,
    version,
  );
  assert.equal(
    (await verifyWindowsPackageArtifact(artifacts, { sha: sourceSha, version }))
      .buildIdentity,
    manifest.buildIdentity,
  );
  await assert.rejects(
    verifyWindowsPackageArtifact(artifacts, { sha: "c".repeat(40), version }),
    /sha does not match/,
  );
});

test("workflow DAG gates publication and scopes Draft discovery to acceptance", async () => {
  const { readFile: readText } = await import("node:fs/promises");
  const ci = (await readText(".github/workflows/ci.yml", "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const release = (
    await readText(".github/workflows/windows-studio-release.yml", "utf8")
  ).replace(/\r\n/g, "\n");
  const updater = (
    await readText("scripts/update-windows-studio.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const online = (
    await readText("scripts/test-windows-studio-online-update.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const installerAcceptance = (
    await readText("scripts/test-windows-studio-installer.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const standardUserAcceptance = (
    await readText(
      "scripts/run-windows-studio-acceptance-as-standard-user.ps1",
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  const diagnostics = (
    await readText("scripts/write-windows-studio-diagnostics.ps1", "utf8")
  ).replace(/\r\n/g, "\n");

  assert.match(
    ci,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
  );
  const pushTrigger = ci.slice(
    ci.indexOf("\n  push:"),
    ci.indexOf("\n  pull_request:"),
  );
  assert.doesNotMatch(pushTrigger, /paths-ignore:/);
  assert.match(
    ci,
    /pull_request:\n    branches: \[master\]\n    paths-ignore:\n      - "\*\*\/\*\.md"/,
  );
  assert.match(ci, /queue: max/);
  assert.match(
    ci,
    /full-verification:[\s\S]*needs: \[verify, windows-studio-smoke\]/,
  );
  assert.match(
    release,
    /online-update-acceptance:[\s\S]*needs: \[qualify, build\]/,
  );
  assert.match(
    release,
    /installer-acceptance:[\s\S]*needs: \[qualify, build\]/,
  );
  assert.match(
    release,
    /manual-installer-acceptance:[\s\S]*needs: \[qualify, build\]/,
  );
  assert.match(
    release,
    /online-update-acceptance:[\s\S]*?permissions:\s*\n\s*# GitHub exposes draft releases only to users with push access\.\s*\n\s*contents: write/,
  );
  assert.match(
    release,
    /installer-acceptance:[\s\S]*?permissions:\s*\n\s*# GitHub exposes draft releases only to users with push access\.\s*\n\s*contents: write/,
  );
  assert.match(
    release,
    /publish:[\s\S]*needs:\s*\[\s*qualify,\s*build,\s*online-update-acceptance,\s*installer-acceptance,\s*manual-installer-acceptance,?\s*\]/,
  );
  assert.doesNotMatch(release, /continue-on-error:/);
  assert.doesNotMatch(release, /--clobber/);
  assert.match(release, /windows-studio-release\.mjs prepare-draft/);
  assert.match(release, /windows-studio-release\.mjs download-draft/);
  assert.doesNotMatch(release, /actions\/(?:upload|download)-artifact@v4/);
  assert.doesNotMatch(ci, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(release, /prepare-candidate:/);
  assert.match(updater, /\$releaseArguments = @\("release", "view"\)/);
  assert.match(updater, /if \(\$ExpectedTargetVersion\)/);
  assert.match(
    online,
    /node scripts\/windows-studio-release\.mjs find-update-baseline \$TargetTag/,
  );
  assert.match(online, /\$installRoot = Join-Path \$env:LOCALAPPDATA "NGT"/);
  assert.match(
    online,
    /if \(Test-Path -LiteralPath \$installRoot\)\s*\{\s*throw "The disposable runner already has an NGT installation\."/,
  );
  assert.doesNotMatch(online, /\$githubCli (?:api|release list).*releases/);
  assert.match(online, /\$ExpectedCommitSha/);
  assert.match(online, /\$ExpectedManifestPath/);
  assert.match(standardUserAcceptance, /TargetTag = \$env:GITHUB_REF_NAME/);
  assert.match(standardUserAcceptance, /ExpectedCommitSha = \$env:GITHUB_SHA/);
  assert.match(standardUserAcceptance, /ExpectedManifestPath = Join-Path/);
  assert.match(standardUserAcceptance, /InstallerPath = Join-Path/);
  assert.match(standardUserAcceptance, /"manual-installer"/);
  assert.match(online, /if \(\$ManualInstaller\)/);
  assert.match(online, /\$manualStatus\.status -ne "superseded"/);
  assert.match(online, /\$repairStatus\.installMode -ne "repair"/);
  assert.match(installerAcceptance, /function Wait-NgtInstallerProcess/);
  assert.match(installerAcceptance, /\.WaitForExit\(15000\)/);
  assert.match(
    installerAcceptance,
    /-TimeoutMinutes 30 -ProgressPaths @\(\$installerLog, \$installStagesLog\)/,
  );
  assert.match(
    installerAcceptance,
    /-TimeoutMinutes 5 -ProgressPaths @\(\$uninstallerLog\)/,
  );
  assert.match(installerAcceptance, /System32\\taskkill\.exe/);
  assert.doesNotMatch(installerAcceptance, /Start-Process[\s\S]*?-Wait/);
  assert.match(installerAcceptance, /-EmitToConsole/);
  assert.match(
    installerAcceptance,
    /Join-Path \$installRoot "\.local\\application\.error\.log"/,
  );
  assert.match(online, /Join-Path \$installRoot "\.local\\application\.log"/);
  assert.match(
    online,
    /Join-Path \$installRoot "\.local\\application\.error\.log"/,
  );
  assert.match(online, /-EmitToConsole/);
  assert.match(
    diagnostics,
    /github_pat_\[A-Za-z0-9_\]\+\|gh\[pousr\]_\[A-Za-z0-9\]\{20,\}/,
  );
  assert.match(diagnostics, /Select-Object -First 30/);
  assert.match(diagnostics, /Select-Object -Last 40/);
  assert.match(diagnostics, /lines matching failure indicators/);
  assert.match(diagnostics, /"application\.log", "application\.error\.log"/);
  assert.match(diagnostics, /studio-database\.error\.log/);
  assert.match(
    release,
    /run-windows-studio-acceptance-as-standard-user\.ps1 -Acceptance online-update/,
  );
  assert.match(
    release,
    /run-windows-studio-acceptance-as-standard-user\.ps1 -Acceptance installer/,
  );
  assert.match(
    release,
    /run-windows-studio-acceptance-as-standard-user\.ps1 -Acceptance manual-installer/,
  );
});
