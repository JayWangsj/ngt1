import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertManifest,
  expectedAssetNames,
  GitHubReleaseApi,
  prepareDraft,
  verifyArtifact,
} from "./windows-studio-release.mjs";

export const UPDATER_TEST_BASELINE_TAG = "v2.0.21";
const SOURCE_REPOSITORY = "JayWangsj/ngt1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function baselineMarker(tag, commit, assets) {
  const identity = sha256(
    Buffer.from(
      JSON.stringify(
        assets
          .map(({ name, size, digest }) => [name, size, digest])
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      "utf8",
    ),
  );
  return `<!-- ngt-updater-test-baseline:v1 tag=${tag} sha=${commit} identity=${identity} -->`;
}

function verifyChecksumSidecar(name, bytes, assets) {
  const match = /^([a-f0-9]{64})\s+(.+)\s*$/i.exec(bytes.toString("utf8"));
  const archive = assets.get(match?.[2]);
  if (
    !match ||
    match[2] !== name.slice(0, -".sha256".length) ||
    !archive ||
    match[1].toLowerCase() !== sha256(archive).toLowerCase()
  ) {
    throw new Error("Published baseline checksum sidecar is invalid: " + name);
  }
}

async function readPublishedBaseline(sourceApi, tag) {
  const [release, commit] = await Promise.all([
    sourceApi.findRelease(tag),
    sourceApi.resolveTagCommit(tag),
  ]);
  if (
    !release ||
    release.draft ||
    release.prerelease ||
    release.tag_name !== tag
  ) {
    throw new Error(
      "The pinned published updater baseline is unavailable: " + tag,
    );
  }
  const names = expectedAssetNames(tag);
  const remoteAssets = new Map(
    (release.assets || []).map((asset) => [asset.name, asset]),
  );
  if (
    remoteAssets.size !== names.length ||
    names.some((name) => !remoteAssets.has(name))
  ) {
    throw new Error(
      "The published updater baseline has an incomplete asset set.",
    );
  }

  const files = new Map();
  const metadata = [];
  for (const name of names) {
    const remote = remoteAssets.get(name);
    const bytes = await sourceApi.downloadAsset(remote);
    const digest = sha256(bytes);
    if (
      bytes.length !== Number(remote.size) ||
      (remote.digest &&
        String(remote.digest).toLowerCase() !== "sha256:" + digest)
    ) {
      throw new Error(
        "Published baseline asset failed SHA256 verification: " + name,
      );
    }
    files.set(name, bytes);
    metadata.push({ name, size: bytes.length, digest });
  }
  for (const name of names.filter((assetName) =>
    assetName.endsWith(".sha256"),
  )) {
    verifyChecksumSidecar(name, files.get(name), files);
  }
  return { release, commit: commit.toLowerCase(), files, metadata };
}

async function verifyTestAsset(api, remote, expectedBytes) {
  const bytes = await api.downloadAsset(remote);
  if (
    bytes.length !== expectedBytes.length ||
    sha256(bytes) !== sha256(expectedBytes)
  ) {
    throw new Error(
      "The isolated baseline Release asset has changed: " + remote.name,
    );
  }
}

async function verifyTestAssets(api, release, expectedFiles) {
  const names = [...expectedFiles.keys()].sort();
  const remoteAssets = new Map(
    (release.assets || []).map((asset) => [asset.name, asset]),
  );
  if (
    remoteAssets.size > names.length ||
    [...remoteAssets.keys()].some((name) => !expectedFiles.has(name))
  ) {
    throw new Error(
      "The isolated baseline Release contains unexpected assets.",
    );
  }
  for (const name of names) {
    const remote = remoteAssets.get(name);
    if (!remote) continue;
    await verifyTestAsset(api, remote, expectedFiles.get(name));
  }
}

async function preparePublishedBaseline(testApi, baseline) {
  const tag = UPDATER_TEST_BASELINE_TAG;
  const marker = baselineMarker(tag, baseline.commit, baseline.metadata);
  let release = await testApi.findRelease(tag);
  if (release && !String(release.body || "").includes(marker)) {
    throw new Error(
      "The isolated baseline Release has an untrusted or conflicting identity.",
    );
  }
  if (!release) {
    try {
      release = await testApi.createDraft({
        tag,
        sha: baseline.commit,
        body:
          marker +
          "\n\nPrivate baseline mirror for production updater acceptance.",
      });
    } catch (error) {
      release = await testApi.findRelease(tag);
      if (!release || !String(release.body || "").includes(marker)) throw error;
    }
  }
  if (release.tag_name !== tag) {
    throw new Error(
      "The isolated baseline Release tag does not match its identity.",
    );
  }
  await verifyTestAssets(testApi, release, baseline.files);
  if (!release.draft && (release.assets || []).length !== baseline.files.size) {
    throw new Error(
      "The published isolated baseline is incomplete and cannot be repaired in place.",
    );
  }

  for (const [name, bytes] of baseline.files) {
    if ((release.assets || []).some((asset) => asset.name === name)) continue;
    await testApi.uploadAsset(release, name, bytes);
    release = await testApi.findRelease(tag);
    if (!release || !String(release.body || "").includes(marker)) {
      throw new Error(
        "The isolated baseline Release identity changed during upload.",
      );
    }
    const uploaded = (release.assets || []).find(
      (asset) => asset.name === name,
    );
    if (!uploaded) {
      throw new Error(
        "The isolated baseline Release did not retain asset " + name + ".",
      );
    }
    await verifyTestAsset(testApi, uploaded, bytes);
  }
  await verifyTestAssets(testApi, release, baseline.files);
  if (release.draft) {
    await testApi.updateRelease(release.id, { draft: false });
    release = await testApi.findRelease(tag);
  }
  if (
    !release ||
    release.draft ||
    !String(release.body || "").includes(marker) ||
    (release.assets || []).length !== baseline.files.size
  ) {
    throw new Error(
      "The isolated published baseline Release could not be verified.",
    );
  }
  await verifyTestAssets(testApi, release, baseline.files);
  return release;
}

export async function preflightUpdaterTestRepository(testApi, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
    throw new Error("The isolated updater test repository must be owner/name.");
  }
  if (repository.toLowerCase() === SOURCE_REPOSITORY.toLowerCase()) {
    throw new Error(
      "The production repository cannot be used as the isolated updater test repository.",
    );
  }
  const repositoryInfo = await testApi.json(testApi.repoPath(""));
  if (
    repositoryInfo?.private !== true ||
    String(repositoryInfo.full_name).toLowerCase() !==
      repository.toLowerCase() ||
    repositoryInfo.default_branch !== "main"
  ) {
    throw new Error(
      "The updater test repository must be a private GitHub repository named exactly and using main as its default branch.",
    );
  }
}

async function testDefaultBranchCommit(testApi) {
  const reference = await testApi.json(testApi.repoPath("/git/ref/heads/main"));
  if (!/^[a-f0-9]{40}$/i.test(reference?.object?.sha || "")) {
    throw new Error(
      "The isolated updater test repository main branch is unavailable.",
    );
  }
  return reference.object.sha.toLowerCase();
}

async function readAndVerifyTestBaseline(sourceApi, testApi) {
  const baseline = await readPublishedBaseline(
    sourceApi,
    UPDATER_TEST_BASELINE_TAG,
  );
  if (
    (
      await sourceApi.resolveTagCommit(UPDATER_TEST_BASELINE_TAG)
    ).toLowerCase() !== baseline.commit
  ) {
    throw new Error(
      "The production updater baseline tag changed during verification.",
    );
  }
  if (
    (
      await testApi.resolveTagCommit(UPDATER_TEST_BASELINE_TAG)
    ).toLowerCase() !== baseline.commit
  ) {
    throw new Error(
      "The isolated repository baseline tag does not match published v2.0.21.",
    );
  }
  return baseline;
}

export async function prepareUpdaterTestBaseline({
  sourceApi,
  testApi,
  repository,
}) {
  await preflightUpdaterTestRepository(testApi, repository);
  const baseline = await readAndVerifyTestBaseline(sourceApi, testApi);
  const existing = await testApi.findRelease(UPDATER_TEST_BASELINE_TAG);
  if (
    !existing &&
    (await testDefaultBranchCommit(testApi)) !== baseline.commit
  ) {
    throw new Error(
      "Create the isolated baseline Release while main points to the published v2.0.21 commit.",
    );
  }
  return preparePublishedBaseline(testApi, baseline);
}

function verifyCandidateManifest(candidateDirectory, manifest) {
  assertManifest(manifest);
  if (!candidateDirectory)
    throw new Error("The isolated updater candidate assets are missing.");
  if (manifest.sha !== process.env.GITHUB_SHA?.toLowerCase()) {
    throw new Error(
      "The isolated updater candidate must match this exact workflow SHA.",
    );
  }
  const candidateVersion = manifest.version.split(".").map(Number);
  const baselineVersion = UPDATER_TEST_BASELINE_TAG.slice(1)
    .split(".")
    .map(Number);
  if (
    candidateVersion.reduce(
      (result, part, index) =>
        result || Math.sign(part - baselineVersion[index]),
      0,
    ) <= 0
  ) {
    throw new Error(
      "The isolated updater candidate must be newer than v2.0.21.",
    );
  }
}

export async function prepareUpdaterTestCandidate({
  sourceApi,
  testApi,
  repository,
  candidateDirectory,
  manifest,
}) {
  verifyCandidateManifest(candidateDirectory, manifest);
  await verifyArtifact(candidateDirectory, manifest);
  await preflightUpdaterTestRepository(testApi, repository);
  if ((await testDefaultBranchCommit(testApi)) !== manifest.sha) {
    throw new Error(
      "The isolated test repository main branch must point to the exact candidate SHA before creating its Draft.",
    );
  }
  const baseline = await readAndVerifyTestBaseline(sourceApi, testApi);
  const baselineRelease = await testApi.findRelease(UPDATER_TEST_BASELINE_TAG);
  const marker = baselineMarker(
    UPDATER_TEST_BASELINE_TAG,
    baseline.commit,
    baseline.metadata,
  );
  if (
    !baselineRelease ||
    baselineRelease.draft ||
    !String(baselineRelease.body || "").includes(marker)
  ) {
    throw new Error(
      "The isolated v2.0.21 published baseline Release is not ready.",
    );
  }
  await verifyTestAssets(testApi, baselineRelease, baseline.files);
  if (
    (await testApi.resolveTagCommit(manifest.tag)).toLowerCase() !==
    manifest.sha
  ) {
    throw new Error(
      "The isolated candidate tag does not resolve to the exact workflow SHA.",
    );
  }
  const candidateRelease = await prepareDraft(
    testApi,
    candidateDirectory,
    manifest,
  );
  return candidateRelease;
}

async function main() {
  const [stage, directory] = process.argv.slice(2);
  const repository = process.env.NGT_UPDATER_TEST_REPOSITORY;
  const token = process.env.NGT_UPDATER_TEST_TOKEN;
  const sourceToken = process.env.GITHUB_TOKEN;
  if (
    !["preflight", "baseline", "candidate"].includes(stage) ||
    (stage === "candidate" && !directory) ||
    !repository ||
    !token ||
    (stage !== "preflight" && !sourceToken)
  ) {
    throw new Error(
      "Isolated updater release preparation requires the repository and scoped credentials for its selected stage.",
    );
  }
  const testApi = new GitHubReleaseApi({ token, repository });
  if (stage === "preflight") {
    await preflightUpdaterTestRepository(testApi, repository);
    console.log(
      "Verified the isolated private updater test repository before Git writes.",
    );
    return;
  }
  const sourceApi = new GitHubReleaseApi({
    token: sourceToken,
    repository: SOURCE_REPOSITORY,
  });
  if (stage === "baseline") {
    const release = await prepareUpdaterTestBaseline({
      sourceApi,
      testApi,
      repository,
    });
    console.log(
      "Verified isolated published baseline Release " + release.html_url + ".",
    );
  } else {
    const manifest = JSON.parse(
      await readFile(path.join(directory, "release-manifest.json"), "utf8"),
    );
    const release = await prepareUpdaterTestCandidate({
      sourceApi,
      testApi,
      repository,
      candidateDirectory: directory,
      manifest,
    });
    console.log(
      "Verified isolated candidate Draft Release " +
        release.html_url +
        " for " +
        manifest.tag +
        " at " +
        manifest.sha +
        ".",
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
