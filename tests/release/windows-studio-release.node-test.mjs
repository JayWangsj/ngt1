import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  calculateBuildIdentity,
  createLocalManifest,
  createReleaseMarker,
  downloadDraft,
  createWindowsPackageManifest,
  expectedAssetNames,
  GitHubReleaseApi,
  parseReleaseMarker,
  prepareDraft,
  publishRelease,
  qualifyRelease,
  requireReleaseReady,
  requiresReleaseReady,
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
  const updates = [];
  return {
    uploads,
    updates,
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
      updates.push(patch);
      state = { ...state, ...patch };
      return state;
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

test("candidate manifest accepts a GitHub pull-request merge ref", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ngt-release-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await mkdir(assets, { recursive: true });
  const packageVersion = JSON.parse(
    await readFile(path.join(process.cwd(), "package.json"), "utf8"),
  ).version;
  const candidateTag = "v" + packageVersion;
  for (const name of expectedAssetNames(candidateTag).filter(
    (entry) => !entry.endsWith(".sha256"),
  )) {
    const bytes = Buffer.from("fixture asset: " + name);
    await writeFile(path.join(assets, name), bytes);
    await writeFile(
      path.join(assets, name + ".sha256"),
      sha256(bytes) + "  " + name + "\n",
    );
  }

  execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), "scripts", "windows-studio-release.mjs"),
      "manifest",
      assets,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_SHA: sourceSha,
        GITHUB_REF_NAME: "28/merge",
        NGT_RELEASE_READY: "true",
      },
      encoding: "utf8",
    },
  );
  const manifest = JSON.parse(
    await readFile(path.join(assets, "release-manifest.json"), "utf8"),
  );
  assert.equal(manifest.tag, candidateTag);
  assert.equal(manifest.sha, sourceSha);
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

test("an unmarked legacy Draft is preserved and requires controlled recovery", async (t) => {
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
  await assert.rejects(
    prepareDraft(api, assets, manifest),
    /no trusted build identity; automatic recovery is disabled/,
  );
  assert.equal(api.uploads.length, 0);
  assert.equal(api.updates.length, 0);
  assert.equal(api.current().assets.length, 1);
});

test("a retry fails closed when a marked Draft has a different build identity", async (t) => {
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
  await assert.rejects(
    prepareDraft(api, assets, manifest),
    /Draft Release build identity does not match/,
  );
  assert.equal(api.current().id, 43);
  assert.equal(api.current().body, createReleaseMarker(staleManifest));
  assert.equal(api.uploads.length, 0);
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
      body: createReleaseMarker(manifest),
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

test("every valid release tag requires exact-SHA Release Ready", () => {
  assert.equal(requiresReleaseReady("v2.0.23"), true);
  assert.equal(requiresReleaseReady("v2.0.24"), true);
  assert.equal(requiresReleaseReady("candidate"), false);
});

test("Release Ready rejects missing, stale, and incomplete exact-SHA Windows runs", async () => {
  const required = [
    "Release Ready qualification",
    "Release Ready candidate build",
    "Release Ready installer acceptance",
    "Release Ready online-update acceptance",
    "Release Ready versioned backup import acceptance",
    "Release Ready",
  ];
  const run = {
    id: 501,
    path: ".github/workflows/windows-studio-release-ready.yml",
    head_sha: sourceSha,
    head_branch: "master",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-18T00:00:00Z",
  };
  const api = {
    listReadyRuns: async () => ({
      workflow_runs: [{ ...run, head_sha: "b".repeat(40) }],
    }),
    listRunJobs: async () => ({
      jobs: required.map((name) => ({ name, conclusion: "success" })),
    }),
  };
  await assert.rejects(requireReleaseReady(api, sourceSha), /has not passed/);
  api.listReadyRuns = async () => ({ workflow_runs: [run] });
  assert.equal((await requireReleaseReady(api, sourceSha)).id, run.id);
  api.listRunJobs = async () => ({
    jobs: required
      .filter((name) => name !== "Release Ready online-update acceptance")
      .map((name) => ({ name, conclusion: "success" })),
  });
  await assert.rejects(
    requireReleaseReady(api, sourceSha),
    /missing a successful/,
  );
  api.listReadyRuns = async () => ({
    workflow_runs: [
      run,
      {
        ...run,
        id: 502,
        conclusion: "failure",
        created_at: "2026-10-18T01:00:00Z",
      },
    ],
  });
  await assert.rejects(requireReleaseReady(api, sourceSha), /has not passed/);
});

test("Release Ready verifies local candidate bytes without a version tag", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ngt-ready-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentVersion = JSON.parse(
    await readFile("package.json", "utf8"),
  ).version;
  const candidateTag = "v" + currentVersion;
  for (const name of expectedAssetNames(candidateTag).filter(
    (item) => !item.endsWith(".sha256"),
  )) {
    const bytes = Buffer.from("candidate " + name);
    await writeFile(path.join(root, name), bytes);
    await writeFile(
      path.join(root, name + ".sha256"),
      sha256(bytes) + "  " + name + "\n",
    );
  }
  const env = {
    ...process.env,
    GITHUB_REF_NAME: "master",
    GITHUB_SHA: sourceSha,
    NGT_RELEASE_READY: "true",
  };
  execFileSync(
    process.execPath,
    ["scripts/windows-studio-release.mjs", "manifest", root],
    { env },
  );
  execFileSync(
    process.execPath,
    ["scripts/windows-studio-release.mjs", "verify-artifact", root],
    { env },
  );
  await writeFile(
    path.join(root, expectedAssetNames(candidateTag)[0]),
    "tampered",
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["scripts/windows-studio-release.mjs", "verify-artifact", root],
        { env, stdio: "pipe" },
      ),
    /failed SHA256 verification/,
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

test("release gates require exact candidate install, Rust update, and versioned import", async () => {
  const [release, ready, online, acceptanceAction, buildAction, standardUser] =
    await Promise.all([
      readFile(".github/workflows/windows-studio-release.yml", "utf8"),
      readFile(".github/workflows/windows-studio-release-ready.yml", "utf8"),
      readFile(
        ".github/workflows/windows-studio-online-update-acceptance.yml",
        "utf8",
      ),
      readFile(".github/actions/windows-studio-acceptance/action.yml", "utf8"),
      readFile(
        ".github/actions/build-windows-studio-candidate/action.yml",
        "utf8",
      ),
      readFile(
        "scripts/run-windows-studio-acceptance-as-standard-user.ps1",
        "utf8",
      ),
    ]);
  const [installer, auth, authTest, releaseTool, ci, documentation] =
    await Promise.all([
      readFile("scripts/test-windows-studio-installer.ps1", "utf8"),
      readFile("scripts/windows-studio-online-update-auth.ps1", "utf8"),
      readFile("scripts/test-windows-studio-online-update-auth.ps1", "utf8"),
      readFile("scripts/windows-studio-release.mjs", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile("docs/windows-studio-release-ready.md", "utf8"),
    ]);

  assert.ok(release.includes("acceptance: production-update"));
  assert.ok(release.includes("backup-import-acceptance"));
  assert.ok(release.includes("versioned business backup format"));
  assert.ok(ready.includes("Require master and exact-SHA Verify MVP"));
  assert.ok(
    ready.includes(
      'tests/integration/business.test.ts -t "versioned data backup import"',
    ),
  );
  assert.ok(
    ready.includes(
      "BACKUP_IMPORT: ${{ needs.backup-import-acceptance.result }}",
    ),
  );
  assert.ok(!ready.includes("contents: write"));
  assert.ok(online.includes("-Acceptance online-update"));
  assert.ok(
    online.includes("ngt-studio-installer-candidate-${{ github.sha }}"),
  );
  assert.ok(
    online.includes("ngt-studio-windows-setup-*.exe.sha256") &&
      online.includes("release-manifest.json"),
  );
  assert.ok(
    buildAction.includes("-Acceptance production-update -AuthMatrixOnly"),
  );
  assert.ok(acceptanceAction.includes("inputs.acceptance == 'online-update'"));
  assert.ok(
    acceptanceAction.includes(
      "inputs.acceptance == 'production-update' && github.token",
    ),
  );
  assert.ok(standardUser.includes("auth-probe.cmd"));
  assert.ok(standardUser.includes("if errorlevel 1 goto authProbeFailed"));
  assert.ok(standardUser.includes(":authProbeFailed"));
  assert.ok(standardUser.includes("echo 0 >"));
  assert.ok(standardUser.includes("echo 1 >"));
  assert.ok(
    standardUser.includes("reg query HKCU\\Environment /v GH_CONFIG_DIR"),
  );
  assert.ok(standardUser.includes('set "GH_CONFIG_DIR=%%B"'));
  assert.ok(!standardUser.includes("echo %ERRORLEVEL%"));
  assert.ok(!standardUser.includes("$authProbeProcess.ExitCode"));
  assert.ok(standardUser.includes('$repository = "JayWangsj/ngt1"'));
  assert.ok(installer.includes("windows-studio-updater-acceptance-server.cjs"));
  assert.ok(installer.includes("clear-update-lock"));
  assert.ok(
    auth.includes("return (-not $CandidateDirectory) -or $ProductionUpdater"),
  );
  assert.ok(authTest.includes('Name = "production updater"'));
  assert.ok(
    releaseTool.includes("Release Ready versioned backup import acceptance"),
  );
  assert.ok(!releaseTool.includes("find-update-baseline"));
  assert.ok(!ci.includes("windows-studio-updater-test-release"));
  assert.ok(documentation.includes("mock GitHub Releases API"));
  assert.ok(documentation.includes("legacy v1 and v9 formats"));

  const obsoleteGateMarkers = [
    "v2.0.20",
    "v2.0.21",
    "NGT_MANUAL_UPGRADE_BASELINE",
    "NGT_PRODUCTION_UPDATER_BASELINE",
    "NGT_UPDATER_TEST_REPOSITORY",
    "NGT_UPDATER_TEST_TOKEN",
    "manual-v2020",
    "manual-installer",
    "public-updater-test",
    "find-update-baseline",
  ];
  for (const source of [
    release,
    ready,
    online,
    standardUser,
    auth,
    authTest,
    releaseTool,
    ci,
    documentation,
  ]) {
    for (const marker of obsoleteGateMarkers) {
      assert.ok(!source.includes(marker), "obsolete release gate: " + marker);
    }
  }
});

test("real Git ancestry check reproduces the shallow-clone false negative", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ngt release ready ancestry-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceRepository = path.join(root, "source repository with spaces");
  const shallowClone = path.join(root, "shallow clone with spaces");
  const fullClone = path.join(root, "complete history clone with spaces");
  const emptyGlobalConfig = path.join(root, "empty global config");
  const emptyHooks = path.join(root, "empty hooks");
  await mkdir(sourceRepository, { recursive: true });
  await mkdir(emptyHooks, { recursive: true });
  await writeFile(emptyGlobalConfig, "");

  const gitEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: root,
    USERPROFILE: root,
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "NGT Release Ready regression",
    GIT_AUTHOR_EMAIL: "ngt-release-ready-regression@example.invalid",
    GIT_COMMITTER_NAME: "NGT Release Ready regression",
    GIT_COMMITTER_EMAIL: "ngt-release-ready-regression@example.invalid",
  };

  const runGit = (cwd, args, expectedExitCode = 0) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=NGT Release Ready regression",
        "-c",
        "user.email=ngt-release-ready-regression@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=" + emptyHooks.replace(/\\/g, "/"),
        ...args,
      ],
      {
        cwd,
        env: gitEnv,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(
      result.error,
      undefined,
      "Git must be executable for this offline regression: " +
        (result.error?.message ?? "unknown spawn error"),
    );
    assert.equal(
      result.signal,
      null,
      "Git must exit normally: " + args.join(" "),
    );
    assert.equal(
      result.status,
      expectedExitCode,
      "git " +
        args.join(" ") +
        " exited " +
        result.status +
        " instead of " +
        expectedExitCode +
        ": " +
        result.stderr,
    );
    return result.stdout.trim();
  };

  runGit(root, ["init", "--quiet", sourceRepository]);
  runGit(sourceRepository, ["checkout", "-b", "main"]);

  const commitFile = async (contents, message) => {
    await writeFile(path.join(sourceRepository, "history.txt"), contents);
    runGit(sourceRepository, ["add", "--all"]);
    runGit(sourceRepository, ["commit", "-m", message]);
    return runGit(sourceRepository, ["rev-parse", "HEAD^{commit}"]);
  };

  const baselineSha = await commitFile("baseline\n", "baseline");
  runGit(sourceRepository, ["tag", "v1.0.0", baselineSha]);
  await commitFile("intermediate\n", "intermediate");
  const candidateSha = await commitFile("candidate\n", "candidate");
  const sourceUrl = pathToFileURL(sourceRepository).href;
  assert.ok(sourceUrl.startsWith("file:///"));
  assert.ok(sourceUrl.includes("%20"), "the local file URL must encode spaces");

  runGit(root, [
    "clone",
    "--quiet",
    "--depth=1",
    "--no-tags",
    sourceUrl,
    shallowClone,
  ]);
  assert.equal(
    runGit(shallowClone, ["rev-parse", "--is-shallow-repository"]),
    "true",
  );
  runGit(shallowClone, ["fetch", "--no-tags", "origin", "refs/tags/v1.0.0"]);
  const shallowBaselineSha = runGit(shallowClone, [
    "rev-parse",
    "FETCH_HEAD^{commit}",
  ]);
  const shallowCandidateSha = runGit(shallowClone, [
    "rev-parse",
    "HEAD^{commit}",
  ]);
  assert.equal(shallowBaselineSha, baselineSha);
  assert.equal(shallowCandidateSha, candidateSha);
  assert.match(shallowBaselineSha, /^[a-f0-9]{40}$/);
  assert.match(shallowCandidateSha, /^[a-f0-9]{40}$/);
  runGit(
    shallowClone,
    ["merge-base", "--is-ancestor", shallowBaselineSha, shallowCandidateSha],
    1,
  );

  runGit(root, ["clone", "--quiet", "--no-tags", sourceUrl, fullClone]);
  assert.equal(
    runGit(fullClone, ["rev-parse", "--is-shallow-repository"]),
    "false",
  );
  runGit(fullClone, ["fetch", "--no-tags", "origin", "refs/tags/v1.0.0"]);
  const fullBaselineSha = runGit(fullClone, [
    "rev-parse",
    "FETCH_HEAD^{commit}",
  ]);
  const fullCandidateSha = runGit(fullClone, ["rev-parse", "HEAD^{commit}"]);
  assert.equal(fullBaselineSha, baselineSha);
  assert.equal(fullCandidateSha, candidateSha);
  runGit(
    fullClone,
    ["merge-base", "--is-ancestor", fullBaselineSha, fullCandidateSha],
    0,
  );

  runGit(fullClone, ["checkout", "--orphan", "unrelated-root"]);
  runGit(fullClone, ["rm", "-r", "-f", "--", "."]);
  await writeFile(path.join(fullClone, "unrelated.txt"), "unrelated\n");
  runGit(fullClone, ["add", "--all"]);
  runGit(fullClone, ["commit", "-m", "unrelated orphan"]);
  const unrelatedSha = runGit(fullClone, ["rev-parse", "HEAD^{commit}"]);
  assert.match(unrelatedSha, /^[a-f0-9]{40}$/);
  assert.equal(
    runGit(fullClone, ["rev-parse", "--is-shallow-repository"]),
    "false",
  );
  runGit(
    fullClone,
    ["merge-base", "--is-ancestor", fullBaselineSha, unrelatedSha],
    1,
  );
});
