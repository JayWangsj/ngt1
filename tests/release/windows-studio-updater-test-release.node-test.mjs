import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLocalManifest,
  expectedAssetNames,
} from "../../scripts/windows-studio-release.mjs";
import {
  preflightUpdaterTestRepository,
  prepareUpdaterTestBaseline,
  prepareUpdaterTestCandidate,
  UPDATER_TEST_BASELINE_TAG,
} from "../../scripts/prepare-windows-studio-updater-test-release.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baselineSha = "b".repeat(40);
const candidateSha = "a".repeat(40);

async function makeCandidate(root, tag = "v2.0.22") {
  const directory = path.join(root, "candidate");
  await mkdir(directory, { recursive: true });
  for (const name of expectedAssetNames(tag).filter(
    (entry) => !entry.endsWith(".sha256"),
  )) {
    const bytes = Buffer.from("candidate asset: " + name);
    await writeFile(path.join(directory, name), bytes);
    await writeFile(
      path.join(directory, name + ".sha256"),
      digest(bytes) + "  " + name + "\n",
    );
  }
  const manifest = await createLocalManifest(
    directory,
    tag,
    candidateSha,
    tag.slice(1),
  );
  return { directory, manifest };
}

function makeBaseline() {
  const files = new Map();
  for (const name of expectedAssetNames(UPDATER_TEST_BASELINE_TAG).filter(
    (entry) => !entry.endsWith(".sha256"),
  )) {
    files.set(name, Buffer.from("published baseline asset: " + name));
  }
  for (const name of expectedAssetNames(UPDATER_TEST_BASELINE_TAG).filter(
    (entry) => entry.endsWith(".sha256"),
  )) {
    const archiveName = name.slice(0, -".sha256".length);
    files.set(
      name,
      Buffer.from(digest(files.get(archiveName)) + "  " + archiveName + "\n"),
    );
  }
  const assets = [...files].map(([name, bytes], id) => ({
    id,
    name,
    size: bytes.length,
    digest: "sha256:" + digest(bytes),
    url: "source:" + name,
  }));
  return {
    files,
    release: {
      id: 1,
      tag_name: UPDATER_TEST_BASELINE_TAG,
      draft: false,
      prerelease: false,
      assets,
    },
  };
}

function makeApis({
  publicRepository = false,
  badBaselineTag = false,
  badSourceChecksum = false,
  badDefaultBranch = false,
} = {}) {
  const baseline = makeBaseline();
  if (badSourceChecksum) {
    const name = UPDATER_TEST_BASELINE_TAG;
    const sidecar = "ngt-studio-windows-" + name + ".zip.sha256";
    baseline.files.set(
      sidecar,
      Buffer.from("0".repeat(64) + "  ngt-studio-windows-" + name + ".zip\n"),
    );
    const remote = baseline.release.assets.find(
      (asset) => asset.name === sidecar,
    );
    remote.size = baseline.files.get(sidecar).length;
    remote.digest = "sha256:" + digest(baseline.files.get(sidecar));
  }
  const sourceApi = {
    findRelease: async () => baseline.release,
    resolveTagCommit: async () => baselineSha,
    downloadAsset: async (asset) => baseline.files.get(asset.name),
  };
  const state = {
    tags: new Map([
      [
        UPDATER_TEST_BASELINE_TAG,
        badBaselineTag ? "c".repeat(40) : baselineSha,
      ],
      ["v2.0.22", candidateSha],
    ]),
    releases: new Map(),
    assets: new Map(),
    uploads: 0,
    defaultBranchSha: badDefaultBranch ? "c".repeat(40) : baselineSha,
  };
  let nextAssetId = 1;
  const testApi = {
    state,
    repoPath: (suffix) => "repo:test" + suffix,
    json: async (url) => {
      if (url === "repo:test/git/ref/heads/main") {
        return { object: { sha: state.defaultBranchSha } };
      }
      return {
        default_branch: "main",
        full_name: "Owner/ngt-updater-test",
        private: !publicRepository,
      };
    },
    resolveTagCommit: async (tag) => {
      const commit = state.tags.get(tag);
      if (!commit) throw new Error("Missing tag: " + tag);
      return commit;
    },
    findRelease: async (tag) => state.releases.get(tag) || null,
    generateReleaseNotes: async () => "isolated test notes",
    createDraft: async ({ tag, sha, body }) => {
      const release = {
        id: state.releases.size + 10,
        tag_name: tag,
        target_commitish: sha,
        draft: true,
        prerelease: false,
        body,
        html_url:
          "https://github.com/Owner/ngt-updater-test/releases/tag/" + tag,
        assets: [],
      };
      state.releases.set(tag, release);
      return release;
    },
    uploadAsset: async (release, name, bytes) => {
      const remote = {
        id: nextAssetId++,
        name,
        size: bytes.length,
        digest: "sha256:" + digest(bytes),
      };
      release.assets.push(remote);
      state.assets.set(remote.id, Buffer.from(bytes));
      state.uploads++;
      return remote;
    },
    downloadAsset: async (asset) =>
      state.assets.get(asset.id) || baseline.files.get(asset.name),
    updateRelease: async (id, patch) => {
      const release = [...state.releases.values()].find(
        (entry) => entry.id === id,
      );
      Object.assign(release, patch);
      return release;
    },
  };
  return { baseline, sourceApi, testApi, state };
}

async function withCandidate(t, callback, options) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ngt-updater-test-release-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await makeCandidate(root);
  const apis = makeApis(options);
  const previousSha = process.env.GITHUB_SHA;
  process.env.GITHUB_SHA = candidateSha;
  try {
    return await callback({ ...candidate, ...apis });
  } finally {
    if (previousSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousSha;
  }
}

test("prepares an exact-SHA private baseline mirror and candidate Draft idempotently", async (t) => {
  await withCandidate(
    t,
    async ({ directory, manifest, sourceApi, testApi, state }) => {
      const baseline = await prepareUpdaterTestBaseline({
        sourceApi,
        testApi,
        repository: "Owner/ngt-updater-test",
      });
      assert.equal(baseline.tag_name, UPDATER_TEST_BASELINE_TAG);
      assert.equal(baseline.draft, false);
      assert.equal(baseline.assets.length, 6);
      assert.match(baseline.body, /ngt-updater-test-baseline:v1/);
      state.defaultBranchSha = candidateSha;
      const candidate = await prepareUpdaterTestCandidate({
        sourceApi,
        testApi,
        repository: "Owner/ngt-updater-test",
        candidateDirectory: directory,
        manifest,
      });
      assert.equal(candidate.tag_name, manifest.tag);
      assert.equal(candidate.draft, true);
      assert.match(candidate.body, new RegExp("sha=" + candidateSha));
      assert.equal(candidate.assets.length, 6);
      assert.equal(state.uploads, 12);

      await prepareUpdaterTestBaseline({
        sourceApi,
        testApi,
        repository: "Owner/ngt-updater-test",
      });
      await prepareUpdaterTestCandidate({
        sourceApi,
        testApi,
        repository: "Owner/ngt-updater-test",
        candidateDirectory: directory,
        manifest,
      });
      assert.equal(state.uploads, 12);
    },
  );
});

test("refuses a public or production repository before any remote writes", async (t) => {
  await withCandidate(
    t,
    async ({ sourceApi, testApi, state }) => {
      await assert.rejects(
        preflightUpdaterTestRepository(testApi, "Owner/ngt-updater-test"),
        /private GitHub repository named exactly/,
      );
      await assert.rejects(
        prepareUpdaterTestBaseline({
          sourceApi,
          testApi,
          repository: "Owner/ngt-updater-test",
        }),
        /private GitHub repository named exactly/,
      );
      await assert.rejects(
        prepareUpdaterTestBaseline({
          sourceApi,
          testApi,
          repository: "JayWangsj/ngt1",
        }),
        /production repository cannot be used/,
      );
      assert.equal(state.releases.size, 0);
      assert.equal(state.uploads, 0);
    },
    { publicRepository: true },
  );
});

test("requires the default branch to match each Release target before creation", async (t) => {
  await withCandidate(
    t,
    async ({ sourceApi, testApi, state }) => {
      await assert.rejects(
        prepareUpdaterTestBaseline({
          sourceApi,
          testApi,
          repository: "Owner/ngt-updater-test",
        }),
        /main points to the published v2\.0\.21 commit/,
      );
      assert.equal(state.releases.size, 0);
      assert.equal(state.uploads, 0);
    },
    { badDefaultBranch: true },
  );
});

test("refuses a baseline tag mismatch and a corrupt published checksum", async (t) => {
  await withCandidate(
    t,
    async ({ sourceApi, testApi, state }) => {
      await assert.rejects(
        prepareUpdaterTestBaseline({
          sourceApi,
          testApi,
          repository: "Owner/ngt-updater-test",
        }),
        /baseline tag does not match/,
      );
      assert.equal(state.releases.size, 0);
    },
    { badBaselineTag: true },
  );

  await withCandidate(
    t,
    async ({ sourceApi, testApi, state }) => {
      await assert.rejects(
        prepareUpdaterTestBaseline({
          sourceApi,
          testApi,
          repository: "Owner/ngt-updater-test",
        }),
        /checksum sidecar is invalid/,
      );
      assert.equal(state.releases.size, 0);
    },
    { badSourceChecksum: true },
  );
});
