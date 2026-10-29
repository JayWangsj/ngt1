import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  requireReleaseReady,
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
          {
            tag_name: "v2.0.22",
            draft: true,
            assets: assetsFor("v2.0.22"),
          },
          {
            tag_name: "v2.0.21",
            draft: false,
            assets: assetsFor("v2.0.21"),
          },
        ]),
        { status: 200 },
      );
    },
  });

  const baseline = await findPublishedUpdateBaseline(api, "v2.0.14");
  assert.equal(baseline.tag_name, "v2.0.13");
  const preferredBaseline = await findPublishedUpdateBaseline(
    api,
    "v2.0.14",
    "v2.0.11",
  );
  assert.equal(preferredBaseline.tag_name, "v2.0.11");
  assert.equal(
    await findPublishedUpdateBaseline(api, "v2.0.14", "v2.0.12"),
    null,
    "an incomplete baseline must not be silently replaced by a newer release",
  );
  const v2023Baseline = await findPublishedUpdateBaseline(api, "v2.0.23");
  assert.equal(
    v2023Baseline.tag_name,
    "v2.0.21",
    "v2.0.23 must remain discoverable from v2.0.21 while the v2.0.22 Draft is ignored",
  );
  assert.equal(requests.length, 4);
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

test("Release Ready rejects missing, stale, and incomplete exact-SHA Windows runs", async () => {
  const required = [
    "Release Ready qualification",
    "Release Ready candidate build",
    "Release Ready installer acceptance",
    "Release Ready online-update acceptance",
    "Release Ready manual upgrade and repair acceptance",
    "Release Ready v2.0.20 manual upgrade and repair acceptance",
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

test("workflow DAG gates publication and scopes Draft discovery to acceptance", async () => {
  const { readFile: readText } = await import("node:fs/promises");
  const ci = (await readText(".github/workflows/ci.yml", "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const release = (
    await readText(".github/workflows/windows-studio-release.yml", "utf8")
  ).replace(/\r\n/g, "\n");
  const ready = (
    await readText(".github/workflows/windows-studio-release-ready.yml", "utf8")
  ).replace(/\r\n/g, "\n");
  const updaterTestRelease = (
    await readText(
      "scripts/prepare-windows-studio-updater-test-release.mjs",
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  const updaterTestRefs = (
    await readText("scripts/push-windows-studio-updater-test-refs.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const onlineAcceptanceWorkflow = (
    await readText(
      ".github/workflows/windows-studio-online-update-acceptance.yml",
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  const candidateBuildAction = (
    await readText(
      ".github/actions/build-windows-studio-candidate/action.yml",
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  const acceptanceAction = (
    await readText(
      ".github/actions/windows-studio-acceptance/action.yml",
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  const updater = (
    await readText("tools/ngt-updater/src/main.rs", "utf8")
  ).replace(/\r\n/g, "\n");
  const innoInstaller = (
    await readText("installer/windows-studio.iss", "utf8")
  ).replace(/\r\n/g, "\n");
  const packageBuilder = (
    await readText("scripts/build-windows-studio-package.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const releaseVerifier = (
    await readText("scripts/verify-windows-studio-release.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const online = (
    await readText("scripts/test-windows-studio-online-update.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const onlineAuth = (
    await readText("scripts/windows-studio-online-update-auth.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const onlineAuthTest = (
    await readText("scripts/test-windows-studio-online-update-auth.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const onlineWorkflow = (
    await readText(
      ".github/workflows/windows-studio-online-update-acceptance.yml",
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  const onlineUi = (
    await readText("tests/release/windows-studio-online-update-ui.mjs", "utf8")
  ).replace(/\r\n/g, "\n");
  const releaseTool = (
    await readText("scripts/windows-studio-release.mjs", "utf8")
  ).replace(/\r\n/g, "\n");
  const updateSafety = (
    await readText("scripts/test-windows-studio-update-safety.ps1", "utf8")
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
  const acceptanceCoordinator = (
    await readText("scripts/windows-studio-acceptance-coordinator.ps1", "utf8")
  ).replace(/\r\n/g, "\n");
  const acceptanceCoordinatorTest = (
    await readText(
      "scripts/test-windows-studio-acceptance-coordinator.ps1",
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  const scheduledTaskAuthProbe = (
    await readText("scripts/test-windows-studio-gh-config-task.ps1", "utf8")
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
    /publish:[\s\S]*needs:\s*\[\s*qualify,\s*build,\s*online-update-acceptance,\s*production-updater-acceptance,\s*installer-acceptance,\s*manual-installer-acceptance,\s*manual-v2020-acceptance,?\s*\]/,
  );
  assert.doesNotMatch(release, /continue-on-error:/);
  assert.doesNotMatch(release, /--clobber/);
  assert.match(release, /windows-studio-release\.mjs prepare-draft/);
  assert.match(release, /\.\/\.github\/actions\/windows-studio-acceptance/);
  assert.match(acceptanceAction, /windows-studio-release\.mjs download-draft/);
  assert.match(acceptanceAction, /windows-studio-release\.mjs verify-artifact/);
  assert.match(acceptanceAction, /actions\/download-artifact@v4/);
  assert.match(
    acceptanceAction,
    /ngt-updater-acceptance-\$\{\{ github\.sha \}\}/,
  );
  assert.match(ready, /workflow_dispatch:/);
  assert.match(
    releaseTool,
    /process\.env\.GITHUB_REF !== "refs\/heads\/master"\s*\|\|\s*process\.env\.GITHUB_EVENT_NAME !== "workflow_dispatch"/,
  );
  assert.doesNotMatch(ready, /pull_request:/);
  assert.match(
    ready,
    /production-updater-acceptance:[\s\S]*?needs: \[qualify, build\]/,
  );
  assert.ok(
    ready.indexOf("Require master and exact-SHA Verify MVP") <
      ready.indexOf("secrets.NGT_UPDATER_TEST_TOKEN"),
    "the isolated test credential is unavailable until trusted-ref qualification succeeds",
  );
  assert.match(ready, /failure_probe:[\s\S]*options: \[none, installer\]/);
  assert.match(
    ready,
    /test_repository:[\s\S]*retained for audit, not auto-deleted[\s\S]*Manually delete only this test repo after results/,
  );
  assert.match(
    ready,
    /production-updater-acceptance:[\s\S]*?environment: ngt-updater-test/,
  );
  assert.ok(
    ready.indexOf("environment: ngt-updater-test") <
      ready.indexOf("secrets.NGT_UPDATER_TEST_TOKEN"),
    "the write credential is available only inside the protected updater-test environment",
  );
  const qualifyJob = ready.slice(
    ready.indexOf("  qualify:"),
    ready.indexOf("  build:"),
  );
  assert.doesNotMatch(
    qualifyJob,
    /NGT_UPDATER_TEST_TOKEN|NGT_UPDATER_TEST_REPOSITORY/,
  );
  assert.match(ready, /manual-installer-acceptance:[\s\S]*needs: build/);
  assert.match(ready, /release-ready:[\s\S]*if: \$\{\{ always\(\) \}\}/);
  assert.match(onlineAcceptanceWorkflow, /runs-on: windows-2022/);
  assert.match(
    candidateBuildAction,
    /test-windows-studio-acceptance-coordinator\.ps1/,
  );
  assert.match(
    onlineAcceptanceWorkflow,
    /Upload sanitized Windows acceptance failure diagnostics[\s\S]*?if: failure\(\)[\s\S]*?actions\/upload-artifact@v4[\s\S]*?ngt-acceptance-diagnostics/,
  );
  assert.match(
    ready,
    /ngt-acceptance-diagnostics-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(onlineAcceptanceWorkflow, /build-windows-studio-candidate/);
  assert.ok(
    onlineAcceptanceWorkflow.indexOf(
      "- uses: ./.github/actions/build-windows-studio-candidate",
    ) <
      onlineAcceptanceWorkflow.indexOf(
        "- name: Verify runtime gate rejects redirects and generic error pages",
      ),
    "runtime verifier fixtures require dependencies installed by the candidate build action",
  );
  assert.match(
    candidateBuildAction,
    /Run Windows updater coordination and safety regressions[\s\S]*test-windows-studio-update-safety\.ps1/,
  );
  assert.match(
    candidateBuildAction,
    /Test GitHub CLI authentication source precedence[\s\S]*-AuthMatrixOnly/,
  );
  assert.match(
    onlineAcceptanceWorkflow,
    /run-windows-studio-acceptance-as-standard-user\.ps1 -Acceptance online-update/,
  );
  assert.match(candidateBuildAction, /components: clippy, rustfmt/);
  assert.match(
    candidateBuildAction,
    /cargo clippy --manifest-path tools\/ngt-updater\/Cargo\.toml --all-targets --all-features -- -D warnings/,
  );
  assert.match(
    onlineAcceptanceWorkflow,
    /run-windows-studio-acceptance-as-standard-user\.ps1 -Acceptance manual-installer/,
  );
  assert.ok(
    onlineAcceptanceWorkflow.indexOf("-Acceptance online-update") <
      onlineAcceptanceWorkflow.indexOf("-Acceptance manual-installer"),
    "manual upgrade and repair acceptance must follow online acceptance on the exact candidate",
  );
  assert.match(online, /Invoke-GhDownload -Tag \$oldTag/);
  assert.match(online, /Assert-ReleaseChecksum \$oldAppArchive/);
  assert.match(online, /Assert-ReleaseChecksum \$oldRuntimeArchive/);
  assert.match(
    online,
    /\$savedDuringDisconnect\.stage -notin @\([\s\S]{0,250}"preparing-release"[\s\S]{0,100}"verifying-backup"[\s\S]{0,100}"preparing-runtime"/,
  );
  assert.match(online, /Manual repair installer/);
  assert.match(release, /actions\/upload-artifact@v4/);
  assert.match(release, /name: ngt-updater-acceptance-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(ci, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(release, /prepare-candidate:/);
  assert.match(updater, /fn get_release\(/);
  assert.match(updater, /fn github_api_base\(/);
  assert.match(updater, /fn download_asset\(/);
  assert.match(updater, /fn run_installer\(/);
  assert.match(updater, /--test-mutex-name/);
  assert.match(
    updater,
    /acceptance_mutex_diagnostic\(update_mutex_name\(&root\)\)/,
  );
  assert.match(updater, /fs::write\(output_path, diagnostic\)/);
  assert.match(updater, /ERROR \{\}: \{\}/);
  assert.match(updater, /\/VERYSILENT/);
  assert.match(updater, /\/SUPPRESSMSGBOXES/);
  assert.match(updater, /\/SP-/);
  assert.match(updater, /\/NORESTART/);
  assert.match(updater, /fn hide_console\(/);
  assert.match(updater, /0x08000000/);
  assert.match(updater, /check_install_space/);
  assert.match(updater, /fn finish_failed\(/);
  assert.match(updater, /"actualVersion"/);
  assert.match(online, /Get-NgtUpdaterWindowDiagnostics/);
  assert.match(online, /Start-Process -FilePath \$AcceptanceUpdaterPath/);
  assert.match(online, /-ArgumentList @\("--test-mutex-name"/);
  assert.match(online, /function Quote-NgtWindowsPathArgument/);
  assert.match(online, /Quote-NgtWindowsPathArgument \$mutexRootVariant/);
  assert.match(online, /Quote-NgtWindowsPathArgument \$mutexOutputPath/);
  assert.match(online, /WaitForExit\(30000\)/);
  assert.match(
    online,
    /\$mutexProcessExitCode = \$mutexDiagnosticProcess\.ExitCode/,
  );
  assert.match(online, /-WindowStyle Hidden -PassThru/);
  assert.match(online, /\$updaterProcessHandle = \$updateProcess\.Handle/);
  assert.match(
    updateSafety,
    /\$observedExitCodeHandle = \$observedExitCodeChild\.Handle/,
  );
  assert.match(updateSafety, /\$observedExitCodeChild\.ExitCode -ne 7/);
  assert.ok(
    online.indexOf("Interactive window probe completed") <
      online.indexOf("if ($updateProcess.ExitCode -ne 0)"),
    "window evidence must be emitted before updater exit-code checks can fail",
  );
  assert.match(online, /process exit code \{1\}; diagnostic: \{2\}/);
  assert.match(online, /different update mutex identities for path/);
  assert.match(online, /Get-NgtScreenVisibleWindows/);
  assert.ok(
    online.indexOf("$windowDiagnostics = @(Get-NgtUpdaterWindowDiagnostics") <
      online.indexOf(
        "if ($failedUpdateMessage) { throw $failedUpdateMessage }",
      ),
    "window evidence must be collected before a failed update ends acceptance",
  );
  assert.ok(
    online.indexOf('Write-Output ("Window evidence:') <
      online.indexOf(
        "if ($failedUpdateMessage) { throw $failedUpdateMessage }",
      ),
    "window evidence must be logged before a failed update ends acceptance",
  );
  assert.match(online, /silent online update displayed a visible installer/);
  assert.match(online, /Get-NgtInteractiveSessionEvidence/);
  assert.match(online, /activeConsoleSessionId/);
  assert.match(online, /windowClass/);
  assert.match(online, /extendedStyle/);
  assert.match(online, /windowTitle/);
  assert.match(online, /GetWindowRect/);
  assert.match(online, /windowBounds/);
  assert.match(online, /BoundsAvailable/);
  assert.match(online, /OnScreen/);
  assert.match(innoInstaller, /DisableStartupPrompt=yes/);
  assert.match(online, /NGT_TEST_RELEASE_API_URL/);
  assert.match(online, /Assert-NgtOnlineUpdateGitHubAuth -GhPath \$githubCli/);
  assert.match(
    onlineAuth,
    /return \(-not \$CandidateDirectory\) -or \$ManualInstaller -or \$ProductionUpdater/,
  );
  assert.match(
    onlineAuth,
    /GitHub release read authorization is unavailable\./,
  );
  assert.match(onlineAuthTest, /Remove-Item Env:\\GH_TOKEN/);
  assert.match(onlineAuthTest, /Remove-Item Env:\\GITHUB_TOKEN/);
  assert.match(onlineAuthTest, /\$global:LASTEXITCODE = 0/);
  assert.match(
    onlineAuthTest,
    /Local candidate mode continued without GitHub credentials\./,
  );
  assert.match(onlineAuthTest, /Name = "remote candidate"/);
  assert.match(onlineAuthTest, /Name = "manual upgrade"/);
  assert.match(onlineAuthTest, /Name = "production updater"/);
  assert.match(
    onlineWorkflow,
    /Verify local and remote online-update authentication modes/,
  );
  assert.match(
    onlineWorkflow,
    /run: \.\/scripts\/test-windows-studio-online-update-auth\.ps1/,
  );
  assert.match(
    onlineWorkflow,
    /"scripts\/test-windows-studio-online-update-auth\.ps1"/,
  );
  assert.match(
    onlineWorkflow,
    /"scripts\/windows-studio-online-update-auth\.ps1"/,
  );
  assert.match(
    online,
    /if \(\$ProductionUpdater\) \{\s+\$publishedLatestVersion = \$oldTag -replace "\^v", ""\s+if \(\$updateInfo\.updateAvailable -or \$updateInfo\.latestVersion -ne \$publishedLatestVersion\)/,
  );
  assert.match(
    online,
    /elseif \(-not \$updateInfo\.updateAvailable -or \$updateInfo\.latestVersion -ne \$targetVersion\)/,
  );
  assert.match(
    online,
    /\$startResponse = Invoke-RestMethod[\s\S]{0,400}targetVersion = \$TargetTag/,
  );
  assert.match(
    online,
    /\$startResponse = Invoke-RestMethod -Uri "http:\/\/127\.0\.0\.1:3000\/api\/system-update"[\s\S]{0,250}-Body \(@\{ targetVersion = \$TargetTag \}/,
  );
  assert.match(
    online,
    /Acceptance did not observe both the independent NGT outage state and automatic reconnection/,
  );
  assert.match(online, /Rust updater peak working set/);
  assert.match(
    packageBuilder,
    /"start\.mjs",\s*"verify-windows-studio-static-assets\.mjs",/,
  );
  assert.doesNotMatch(packageBuilder, /update-windows-studio\.ps1/);
  assert.doesNotMatch(releaseVerifier, /download-public-release-asset\.ps1/);
  assert.match(
    online,
    /\$baselineArguments = @\("scripts\/windows-studio-release\.mjs", "find-update-baseline", \$TargetTag\)/,
  );
  assert.match(
    online,
    /\$ProductionUpdater -and \$env:NGT_TEST_RELEASE_API_URL/,
  );
  assert.match(
    online,
    /Starting the real published \{0\} NGTUpdater\.exe SHA256/,
  );
  assert.match(online, /NGT_PRODUCTION_UPDATER_BASELINE/);
  assert.match(
    online,
    /real GitHub asset download did not report full byte-accurate progress/,
  );
  assert.match(onlineUi, /\.update-result-card\.succeeded/);
  assert.match(onlineUi, /still exposes a diagnostics action/);
  assert.match(
    releaseTool,
    /findPublishedUpdateBaseline\(\s*api,\s*directoryArg,\s*process\.argv\[4\]/,
  );
  assert.match(
    online,
    /updated production NGTUpdater\.exe does not match the verified candidate release manifest/,
  );
  assert.match(standardUserAcceptance, /ProductionUpdater = \$true/);
  assert.match(
    standardUserAcceptance,
    /\$requiresGitHubAuth = \(\$Acceptance -in @\("manual-installer", "production-update"\)\)/,
  );
  assert.ok(
    standardUserAcceptance.includes(
      '$ghConfigDirectory = Join-Path $isolatedTemp "gh-config"',
    ),
  );
  assert.ok(standardUserAcceptance.includes("oauth_token: $($env:GH_TOKEN)"));
  assert.match(
    standardUserAcceptance,
    /SetEnvironmentVariable\("GH_CONFIG_DIR", \$expectedConfigDirectory, "User"\)/,
  );
  assert.match(
    standardUserAcceptance,
    /SetEnvironmentVariable\("GH_CONFIG_DIR", \$null, "User"\)/,
  );
  assert.match(standardUserAcceptance, /Registry::HKEY_USERS/);
  assert.match(standardUserAcceptance, /Add-NgtAcceptanceCleanupFailure/);
  assert.match(standardUserAcceptance, /-ChildFailure \$childFailureDetails/);
  assert.match(acceptanceCoordinator, /ReadAllText\(\$Path\)/);
  assert.match(acceptanceCoordinator, /invalid exit result/);
  assert.match(acceptanceCoordinator, /Assert-NgtAcceptanceFileContent/);
  assert.match(acceptanceCoordinator, /Assert-NgtAcceptanceProcessSucceeded/);
  assert.match(acceptanceCoordinator, /Assert-NgtAcceptanceCleanupSucceeded/);
  assert.match(acceptanceCoordinator, /Write-NgtAcceptanceFailureDiagnostic/);
  assert.match(acceptanceCoordinatorTest, /empty-stdout-error-stderr/);
  assert.match(acceptanceCoordinatorTest, /token-in-log/);
  assert.match(acceptanceCoordinatorTest, /-TimedOut/);
  assert.match(standardUserAcceptance, /Test-NgtGhAuthMatrix/);
  assert.match(standardUserAcceptance, /GH_TOKEN only/);
  assert.match(standardUserAcceptance, /GITHUB_TOKEN only/);
  assert.match(standardUserAcceptance, /GH_CONFIG_DIR only/);
  assert.match(standardUserAcceptance, /both tokens/);
  assert.match(standardUserAcceptance, /no credentials/);
  assert.match(standardUserAcceptance, /ngt-noauth\.invalid/);
  assert.match(standardUserAcceptance, /Remove-Item Env:\\GITHUB_TOKEN/);
  assert.doesNotMatch(standardUserAcceptance, /\$env:GH_TOKEN = \$configToken/);
  assert.match(
    standardUserAcceptance,
    /release view \$targetTag --repo \$repository/,
  );
  assert.match(
    standardUserAcceptance,
    /release download \$targetTag --repo \$repository/,
  );
  assert.match(
    standardUserAcceptance,
    /Get-FileHash -LiteralPath \$assetPath -Algorithm SHA256/,
  );
  assert.match(standardUserAcceptance, /authProbeReadyPath/);
  assert.match(standardUserAcceptance, /Register-ScheduledTask/);
  assert.match(standardUserAcceptance, /Unregister-ScheduledTask/);
  assert.match(scheduledTaskAuthProbe, /GH_CONFIG_DIR/);
  assert.match(scheduledTaskAuthProbe, /GITHUB_TOKEN/);
  assert.match(scheduledTaskAuthProbe, /auth token --hostname github\.com/);
  assert.match(scheduledTaskAuthProbe, /ExpectedTokenSha256/);
  assert.match(
    standardUserAcceptance,
    /GH_CONFIG_DIR = if \(\$requiresGitHubAuth\) \{ \$ghConfigDirectory \} else \{ \$null \}/,
  );
  assert.match(
    standardUserAcceptance,
    /ghConfigDirectory = if \(\$requiresGitHubAuth\) \{ \$ghConfigDirectory \} else \{ \$null \}/,
  );
  assert.match(
    standardUserAcceptance,
    /verifyGitHubAuth = \(\$Acceptance -eq "production-update"\)/,
  );
  assert.match(
    standardUserAcceptance,
    /NGT_MANUAL_UPGRADE_BASELINE = \$env:NGT_MANUAL_UPGRADE_BASELINE/,
  );
  assert.match(
    standardUserAcceptance,
    /NGT_PRODUCTION_UPDATER_BASELINE = \$env:NGT_PRODUCTION_UPDATER_BASELINE/,
  );
  assert.match(online, /\$installRoot = Join-Path \$env:LOCALAPPDATA "NGT"/);
  assert.match(
    online,
    /if \(Test-Path -LiteralPath \$installRoot\)\s*\{\s*throw "The disposable runner already has an NGT installation\."/,
  );
  assert.doesNotMatch(online, /\$githubCli (?:api|release list).*releases/);
  assert.match(online, /\$ExpectedCommitSha/);
  assert.match(online, /\$ExpectedManifestPath/);
  assert.match(standardUserAcceptance, /TargetTag = \$targetTag/);
  assert.match(standardUserAcceptance, /ExpectedCommitSha = \$env:GITHUB_SHA/);
  assert.match(standardUserAcceptance, /ExpectedManifestPath = Join-Path/);
  assert.match(standardUserAcceptance, /InstallerPath = Join-Path/);
  assert.match(standardUserAcceptance, /"manual-installer"/);
  assert.match(online, /if \(\$ManualInstaller\)/);
  assert.doesNotMatch(
    online,
    /status = "queued"\s+previousVersion = \(\$oldTag/,
  );
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
  assert.match(diagnostics, /online-installer\.inno\.log/);
  assert.match(diagnostics, /studio-database\.error\.log/);
  assert.match(
    acceptanceAction,
    /run-windows-studio-acceptance-as-standard-user\.ps1 -Acceptance/,
  );
  assert.match(release, /mode: draft\s+acceptance: online-update/);
  assert.match(
    release,
    /production-updater-acceptance:[\s\S]*acceptance: production-update/,
  );
  assert.match(
    release,
    /production-updater-acceptance:[\s\S]*NGT_PRODUCTION_UPDATER_BASELINE: v2\.0\.21/,
  );
  assert.match(release, /mode: draft\s+acceptance: installer/);
  assert.match(release, /mode: draft\s+acceptance: manual-installer/);
  assert.match(
    release,
    /manual-v2020-acceptance:[\s\S]*NGT_MANUAL_UPGRADE_BASELINE: v2\.0\.20/,
  );
  assert.match(
    release,
    /publish:[\s\S]*production-updater-acceptance[\s\S]*manual-v2020-acceptance/,
  );
  assert.match(ready, /mode: ready\s+acceptance: online-update/);
  assert.match(ready, /mode: ready\s+acceptance: installer/);
  assert.match(ready, /mode: ready\s+acceptance: manual-installer/);
  assert.match(
    ready,
    /production-updater-acceptance:[\s\S]*Exercise the original v2\.0\.21 production updater as a standard user/,
  );
  assert.match(
    ready,
    /needs:\s*\[[\s\S]*production-updater-acceptance[\s\S]*\]/,
  );
  assert.match(
    ready,
    /PRODUCTION_UPDATER: \$\{\{ needs\.production-updater-acceptance\.result \}\}/,
  );
  assert.match(ready, /type: string\s+required: true/);
  assert.match(ready, /secrets\.NGT_UPDATER_TEST_TOKEN/);
  assert.match(
    ready,
    /scripts\/prepare-windows-studio-updater-test-release\.mjs/,
  );
  assert.match(ready, /scripts\/push-windows-studio-updater-test-refs\.ps1/);
  assert.match(
    ready,
    /Verify the isolated repository before any Git writes[\s\S]*prepare-windows-studio-updater-test-release\.mjs preflight/,
  );
  assert.match(ready, /v2\.0\.21 production updater as a standard user/);
  assert.ok(
    ready.indexOf("prepare-windows-studio-updater-test-release.mjs preflight") <
      ready.indexOf("-Stage baseline") &&
      ready.indexOf("-Stage baseline") <
        ready.indexOf(
          "prepare-windows-studio-updater-test-release.mjs baseline",
        ) &&
      ready.indexOf(
        "prepare-windows-studio-updater-test-release.mjs baseline",
      ) < ready.indexOf("-Stage candidate") &&
      ready.indexOf("-Stage candidate") <
        ready.indexOf(
          "prepare-windows-studio-updater-test-release.mjs candidate",
        ),
    "the test baseline must be published before main advances to the candidate SHA",
  );
  assert.match(updaterTestRelease, /repositoryInfo\?\.private !== true/);
  assert.match(updaterTestRelease, /repositoryInfo\.default_branch !== "main"/);
  assert.match(updaterTestRelease, /testDefaultBranchCommit\(testApi\)/);
  assert.match(
    updaterTestRelease,
    /prepareDraft\(\s*testApi,\s*candidateDirectory,\s*manifest,/,
  );
  assert.match(updaterTestRelease, /resolveTagCommit\(manifest\.tag\)/);
  assert.match(updaterTestRelease, /verifyChecksumSidecar/);
  assert.match(updaterTestRelease, /NGT_UPDATER_TEST_TOKEN/);
  assert.match(updaterTestRefs, /push --atomic/);
  assert.match(updaterTestRefs, /refs\/heads\/main/);
  assert.doesNotMatch(updaterTestRefs, /--force/);
  assert.match(
    online,
    /production updater acceptance requires the isolated test repository/,
  );
  assert.match(online, /taskConfig\.repository = \$TestReleaseRepository/);
  assert.match(online, /isolated private updater test repository/);
  assert.match(
    ready,
    /manual-v2020-acceptance:[\s\S]*NGT_MANUAL_UPGRADE_BASELINE: v2\.0\.20/,
  );
  assert.match(
    ready,
    /MANUAL_V2020: \$\{\{ needs\.manual-v2020-acceptance\.result \}\}/,
  );
});
