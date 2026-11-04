import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  calculateBuildIdentity,
  createLocalManifest,
  expectedAssetNames,
  GitHubReleaseApi,
} from "../../scripts/windows-studio-release.mjs";
import {
  assertApprovedUpdaterTestRepository,
  preflightUpdaterTestRepository,
  prepareUpdaterTestBaseline,
  prepareUpdaterTestCandidate,
  UPDATER_TEST_BASELINE_TAG,
} from "../../scripts/prepare-windows-studio-updater-test-release.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baselineSha = "b".repeat(40);
const candidateSha = "a".repeat(40);
const candidateVersion = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;
const candidateTag = "v" + candidateVersion;

async function makeCandidate(root, tag = candidateTag) {
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
  privateRepository = false,
  visibility = "public",
  repositoryName = "Owner/ngt-updater-test",
  defaultBranch = "main",
  badBaselineTag = false,
  badSourceChecksum = false,
  badDefaultBranch = false,
  unrelatedRelease = false,
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
      [candidateTag, candidateSha],
    ]),
    releases: new Map(),
    assets: new Map(),
    uploads: 0,
    defaultBranchSha: badDefaultBranch ? "c".repeat(40) : baselineSha,
  };
  if (unrelatedRelease) {
    state.releases.set("v9.9.9", {
      tag_name: "v9.9.9",
      draft: false,
    });
  }
  let nextAssetId = 1;
  const repositoryInfo = {
    default_branch: defaultBranch,
    full_name: repositoryName,
    private: privateRepository,
  };
  if (visibility !== null) repositoryInfo.visibility = visibility;
  const testApi = {
    state,
    repoPath: (suffix) => "repo:test" + suffix,
    json: async (url) => {
      if (url === "repo:test/git/ref/heads/main") {
        return { object: { sha: state.defaultBranchSha } };
      }
      return repositoryInfo;
    },
    listReleases: async () => [...state.releases.values()],
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

test("prepares an exact-SHA public baseline mirror and candidate Draft idempotently", async (t) => {
  await withCandidate(
    t,
    async ({ directory, manifest, sourceApi, testApi, state }) => {
      const baseline = await prepareUpdaterTestBaseline({
        sourceApi,
        testApi,
        repository: "Owner/ngt-updater-test",
      });
      assert.equal(manifest.tag, candidateTag);
      assert.equal(manifest.version, candidateVersion);
      assert.equal(baseline.tag_name, UPDATER_TEST_BASELINE_TAG);
      assert.equal(baseline.draft, false);
      assert.equal(baseline.assets.length, 6);
      assert.match(baseline.body, /ngt-updater-test-baseline:v1/);
      assert.match(baseline.body, /Dedicated public baseline mirror/);
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

test("accepts a public repository with public visibility or no visibility field", async (t) => {
  await withCandidate(t, async ({ testApi }) => {
    await preflightUpdaterTestRepository(testApi, "Owner/ngt-updater-test");
  });
  await withCandidate(
    t,
    async ({ testApi }) => {
      await preflightUpdaterTestRepository(testApi, "Owner/ngt-updater-test");
    },
    { visibility: null },
  );
});

test("requires the manual repository input to match the Environment allowlist exactly", () => {
  assert.equal(
    assertApprovedUpdaterTestRepository(
      "Owner/ngt-updater-test",
      "Owner/ngt-updater-test",
    ),
    "Owner/ngt-updater-test",
  );
  for (const requestedRepository of [
    "Owner/other-test-repository",
    "owner/ngt-updater-test",
    "JayWangsj/ngt1",
    "",
  ]) {
    assert.throws(
      () =>
        assertApprovedUpdaterTestRepository(
          "Owner/ngt-updater-test",
          requestedRepository,
        ),
      /does not match the approved Environment repository/,
    );
  }
  assert.throws(
    () => assertApprovedUpdaterTestRepository("", "Owner/ngt-updater-test"),
    /does not match the approved Environment repository/,
  );
});

test("rejects private, non-public, wrong-name, and non-main repositories before writes", async (t) => {
  const invalidRepositories = [
    {
      name: "private",
      options: { privateRepository: true, visibility: "private" },
    },
    { name: "inconsistent visibility", options: { visibility: "private" } },
    {
      name: "wrong API full name",
      options: { repositoryName: "Other/ngt-updater-test" },
    },
    { name: "wrong default branch", options: { defaultBranch: "trunk" } },
  ];
  for (const invalid of invalidRepositories) {
    await withCandidate(
      t,
      async ({ testApi, state }) => {
        await assert.rejects(
          preflightUpdaterTestRepository(testApi, "Owner/ngt-updater-test"),
          /exact approved public GitHub repository/,
          invalid.name,
        );
        assert.equal(state.releases.size, 0, invalid.name);
        assert.equal(state.uploads, 0, invalid.name);
      },
      invalid.options,
    );
  }
  await withCandidate(t, async ({ sourceApi, testApi, state }) => {
    await assert.rejects(
      prepareUpdaterTestBaseline({
        sourceApi,
        testApi,
        repository: "Owner/other-test-repository",
      }),
      /exact approved public GitHub repository/,
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
  });
});

test("rejects unrelated Releases and an already-published candidate", async (t) => {
  await withCandidate(
    t,
    async ({ testApi }) => {
      await assert.rejects(
        preflightUpdaterTestRepository(testApi, "Owner/ngt-updater-test"),
        /unrelated Release/,
      );
    },
    { unrelatedRelease: true },
  );
  await withCandidate(t, async ({ testApi, state }) => {
    state.releases.set(candidateTag, {
      tag_name: candidateTag,
      draft: false,
    });
    await assert.rejects(
      preflightUpdaterTestRepository(testApi, "Owner/ngt-updater-test"),
      /must remain a Draft/,
    );
  });
});

test("GitHub API authorization failures reject without exposing the token", async () => {
  const token = "fixture-public-test-token";
  for (const status of [401, 403, 404]) {
    const api = new GitHubReleaseApi({
      token,
      repository: "Owner/ngt-updater-test",
      fetchImpl: async (url) =>
        String(url).endsWith("/releases?per_page=100&page=1")
          ? new Response("denied " + token, { status })
          : new Response(
              JSON.stringify({
                private: false,
                visibility: "public",
                full_name: "Owner/ngt-updater-test",
                default_branch: "main",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
    });
    await assert.rejects(
      preflightUpdaterTestRepository(api, "Owner/ngt-updater-test"),
      (error) => error.status === status && !error.message.includes(token),
    );
  }
  assert.throws(
    () => new GitHubReleaseApi({ token: "" }),
    /GitHub token is required/,
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

test("requires the candidate manifest and tag to match the exact workflow SHA", async (t) => {
  await withCandidate(
    t,
    async ({ sourceApi, testApi, state, directory, manifest }) => {
      const invalidManifest = { ...manifest, sha: "c".repeat(40) };
      invalidManifest.buildIdentity = calculateBuildIdentity(invalidManifest);
      await assert.rejects(
        prepareUpdaterTestCandidate({
          sourceApi,
          testApi,
          repository: "Owner/ngt-updater-test",
          candidateDirectory: directory,
          manifest: invalidManifest,
        }),
        /match this exact workflow SHA/,
      );
      assert.equal(state.releases.size, 0);
      assert.equal(state.uploads, 0);
    },
  );

  await withCandidate(
    t,
    async ({ sourceApi, testApi, state, directory, manifest }) => {
      await prepareUpdaterTestBaseline({
        sourceApi,
        testApi,
        repository: "Owner/ngt-updater-test",
      });
      state.defaultBranchSha = candidateSha;
      state.tags.set(candidateTag, "c".repeat(40));
      await assert.rejects(
        prepareUpdaterTestCandidate({
          sourceApi,
          testApi,
          repository: "Owner/ngt-updater-test",
          candidateDirectory: directory,
          manifest,
        }),
        /candidate tag does not resolve to the exact workflow SHA/,
      );
      assert.equal(state.releases.has(candidateTag), false);
    },
  );
});
