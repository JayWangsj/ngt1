import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPOSITORY = process.env.GITHUB_REPOSITORY || "JayWangsj/ngt1";
const API_ROOT = "https://api.github.com";
const REQUIRED_GATES = ["verify", "full-verification", "windows-studio-smoke"];
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function expectedAssetNames(tag) {
  return [
    "ngt-studio-windows-" + tag + ".zip",
    "ngt-studio-windows-" + tag + ".zip.sha256",
    "ngt-studio-runtime-" + tag + ".zip",
    "ngt-studio-runtime-" + tag + ".zip.sha256",
    "ngt-studio-windows-setup-" + tag + ".exe",
    "ngt-studio-windows-setup-" + tag + ".exe.sha256",
  ].sort();
}

export function calculateBuildIdentity({ tag, sha, version, assets }) {
  const canonical = JSON.stringify({
    tag,
    sha,
    version,
    assets: [...assets]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, size, sha256: digest }) => [name, size, digest]),
  });
  return sha256(Buffer.from(canonical, "utf8"));
}

export function createReleaseMarker(manifest) {
  return (
    "<!-- ngt-release-build:v1 tag=" +
    manifest.tag +
    " sha=" +
    manifest.sha +
    " version=" +
    manifest.version +
    " identity=" +
    manifest.buildIdentity +
    " -->"
  );
}

export function parseReleaseMarker(body = "") {
  const match = String(body).match(
    /<!-- ngt-release-build:v1 tag=(v\d+\.\d+\.\d+) sha=([a-f0-9]{40}) version=(\d+\.\d+\.\d+) identity=([a-f0-9]{64}) -->/i,
  );
  if (!match) return null;
  return {
    tag: match[1],
    sha: match[2].toLowerCase(),
    version: match[3],
    buildIdentity: match[4].toLowerCase(),
  };
}

export function assertManifest(manifest, expected = {}) {
  if (
    !manifest ||
    !/^v\d+\.\d+\.\d+$/.test(manifest.tag) ||
    manifest.version !== manifest.tag.slice(1) ||
    !/^[a-f0-9]{40}$/i.test(manifest.sha) ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error(
      "Release artifact manifest has an invalid tag, version, SHA, or asset list.",
    );
  }
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && manifest[key] !== value) {
      throw new Error(
        "Release artifact " + key + " does not match this workflow run.",
      );
    }
  }
  const names = manifest.assets.map((asset) => asset.name).sort();
  if (
    JSON.stringify(names) !==
      JSON.stringify(expectedAssetNames(manifest.tag)) ||
    new Set(names).size !== names.length ||
    manifest.assets.some(
      (asset) =>
        !Number.isSafeInteger(asset.size) ||
        asset.size < 0 ||
        !/^[a-f0-9]{64}$/i.test(asset.sha256),
    )
  ) {
    throw new Error(
      "Release artifact manifest has an incomplete or invalid asset inventory.",
    );
  }
  if (manifest.buildIdentity !== calculateBuildIdentity(manifest)) {
    throw new Error(
      "Release artifact build identity does not match its manifest.",
    );
  }
  return manifest;
}

export async function createLocalManifest(directory, tag, sha, version) {
  if (
    tag !== "v" + version ||
    !/^v\d+\.\d+\.\d+$/.test(tag) ||
    !/^[a-f0-9]{40}$/i.test(sha)
  ) {
    throw new Error(
      "Release tag, package version, and source Commit SHA do not match.",
    );
  }
  const expectedNames = expectedAssetNames(tag);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedNames)) {
    throw new Error(
      "Windows release asset inventory is incomplete or contains unexpected files.",
    );
  }
  const assets = [];
  for (const name of expectedNames) {
    const filePath = path.join(directory, name);
    const bytes = await readFile(filePath);
    assets.push({ name, size: bytes.length, sha256: sha256(bytes) });
  }
  for (const asset of assets.filter((entry) =>
    entry.name.endsWith(".sha256"),
  )) {
    const checksumText = (
      await readFile(path.join(directory, asset.name), "utf8")
    ).trim();
    const targetName = asset.name.slice(0, -".sha256".length);
    const target = assets.find((entry) => entry.name === targetName);
    const checksumMatch = checksumText.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (
      !checksumMatch ||
      checksumMatch[2] !== targetName ||
      checksumMatch[1].toLowerCase() !== target.sha256
    ) {
      throw new Error(
        "Release checksum sidecar does not match " + targetName + ".",
      );
    }
  }
  const manifest = {
    tag,
    version,
    sha: sha.toLowerCase(),
    assets,
    buildIdentity: calculateBuildIdentity({
      tag,
      version,
      sha: sha.toLowerCase(),
      assets,
    }),
  };
  await writeFile(
    path.join(directory, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

export async function createWindowsPackageManifest(
  artifactDirectory,
  packageDirectory,
  sha,
  version,
) {
  if (!/^[a-f0-9]{40}$/i.test(sha) || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Windows package artifact source identity is invalid.");
  }
  const archiveName = "ngt-studio-windows-v" + version + ".zip";
  const checksumName = archiveName + ".sha256";
  const names = (await readdir(artifactDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (
    JSON.stringify(names) !== JSON.stringify([archiveName, checksumName].sort())
  ) {
    throw new Error(
      "Windows Smoke package artifact is incomplete or contains unexpected files.",
    );
  }
  const metadata = JSON.parse(
    (
      await readFile(path.join(packageDirectory, "studio-release.json"), "utf8")
    ).replace(/^\uFEFF/, ""),
  );
  if (
    metadata.version !== version ||
    metadata.commit?.toLowerCase() !== sha.toLowerCase() ||
    !/^[a-f0-9]{64}$/i.test(metadata.runtimeHash)
  ) {
    throw new Error(
      "Windows Smoke package metadata does not match this exact Commit SHA and package version.",
    );
  }
  const bytes = await readFile(path.join(artifactDirectory, archiveName));
  const digest = sha256(bytes);
  const checksum = (
    await readFile(path.join(artifactDirectory, checksumName), "utf8")
  ).trim();
  const match = checksum.match(/^([a-f0-9]{64})\s+(.+)$/i);
  if (!match || match[2] !== archiveName || match[1].toLowerCase() !== digest) {
    throw new Error(
      "Windows Smoke package checksum does not match its ZIP archive.",
    );
  }
  const manifest = {
    sha: sha.toLowerCase(),
    version,
    runtimeHash: metadata.runtimeHash.toLowerCase(),
    archive: { name: archiveName, size: bytes.length, sha256: digest },
  };
  manifest.buildIdentity = sha256(
    Buffer.from(JSON.stringify(manifest), "utf8"),
  );
  await writeFile(
    path.join(artifactDirectory, "package-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

export async function verifyWindowsPackageArtifact(
  artifactDirectory,
  expected = {},
) {
  const manifest = JSON.parse(
    await readFile(
      path.join(artifactDirectory, "package-manifest.json"),
      "utf8",
    ),
  );
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && manifest[key] !== value) {
      throw new Error(
        "Windows Smoke package artifact " +
          key +
          " does not match this Release run.",
      );
    }
  }
  const identity = { ...manifest };
  delete identity.buildIdentity;
  if (
    manifest.buildIdentity !==
      sha256(Buffer.from(JSON.stringify(identity), "utf8")) ||
    manifest.archive?.name !==
      "ngt-studio-windows-v" + manifest.version + ".zip" ||
    !/^[a-f0-9]{40}$/i.test(manifest.sha) ||
    !/^[a-f0-9]{64}$/i.test(manifest.archive.sha256)
  ) {
    throw new Error("Windows Smoke package provenance manifest is invalid.");
  }
  const bytes = await readFile(
    path.join(artifactDirectory, manifest.archive.name),
  );
  if (
    bytes.length !== manifest.archive.size ||
    sha256(bytes) !== manifest.archive.sha256
  ) {
    throw new Error(
      "Windows Smoke package artifact failed SHA256 verification.",
    );
  }
  const checksum = (
    await readFile(
      path.join(artifactDirectory, manifest.archive.name + ".sha256"),
      "utf8",
    )
  ).trim();
  const match = checksum.match(/^([a-f0-9]{64})\s+(.+)$/i);
  if (
    !match ||
    match[2] !== manifest.archive.name ||
    match[1].toLowerCase() !== manifest.archive.sha256
  ) {
    throw new Error("Windows Smoke package checksum sidecar is invalid.");
  }
  return manifest;
}

export async function verifyArtifact(directory, manifest, expected = {}) {
  assertManifest(manifest, expected);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== "release-manifest.json")
    .map((entry) => entry.name)
    .sort();
  if (
    JSON.stringify(entries) !== JSON.stringify(expectedAssetNames(manifest.tag))
  ) {
    throw new Error(
      "Downloaded release artifact inventory does not match its manifest.",
    );
  }
  for (const asset of manifest.assets) {
    const bytes = await readFile(path.join(directory, asset.name));
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
      throw new Error(
        "Downloaded release artifact failed SHA256 verification: " + asset.name,
      );
    }
  }
  return manifest;
}

const markerMatches = (release, manifest) => {
  const marker = parseReleaseMarker(release.body);
  return (
    marker &&
    marker.tag === manifest.tag &&
    marker.sha === manifest.sha &&
    marker.version === manifest.version &&
    marker.buildIdentity === manifest.buildIdentity
  );
};

function assertRemoteInventory(release, manifest, complete) {
  const names = (release.assets || []).map((asset) => asset.name);
  const expected = new Set(manifest.assets.map((asset) => asset.name));
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !expected.has(name))
  ) {
    throw new Error(
      "Draft Release contains duplicate or unexpected assets; it will not be overwritten.",
    );
  }
  if (complete && names.length !== expected.size) {
    throw new Error("Draft Release is missing one or more verified assets.");
  }
}

async function verifyRemoteAsset(api, remote, local) {
  if (!remote || remote.size !== local.size) {
    throw new Error(
      "Draft Release asset size does not match the verified build: " +
        local.name,
    );
  }
  if (remote.digest) {
    if (String(remote.digest).toLowerCase() !== "sha256:" + local.sha256) {
      throw new Error(
        "Draft Release asset digest does not match the verified build: " +
          local.name,
      );
    }
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const bytes = await api.downloadAsset(remote);
      if (bytes.length !== local.size || sha256(bytes) !== local.sha256) {
        throw new Error(
          "Downloaded Draft Release asset does not match the verified build: " +
            local.name,
        );
      }
      return;
    } catch (error) {
      if (
        error.message.includes("does not match the verified build") ||
        (![404, 422].includes(error.status) && !retryable(error)) ||
        attempt === 4
      ) {
        throw error;
      }
      await delay(1000 * 2 ** attempt);
    }
  }
}

async function verifyRemoteAssets(api, release, manifest, complete) {
  assertRemoteInventory(release, manifest, complete);
  for (const remote of release.assets || []) {
    const local = manifest.assets.find((asset) => asset.name === remote.name);
    await verifyRemoteAsset(api, remote, local);
  }
}

function retryable(error) {
  return (
    error?.retryable === true ||
    [408, 429, 500, 502, 503, 504].includes(error?.status)
  );
}

// Draft Releases are the transport between isolated GitHub-hosted runners.
// Recreate the local manifest from downloaded bytes instead of trusting
// mutable remote metadata or an Actions artifact.
export async function downloadDraft(api, directory, { tag, sha, version }) {
  if (
    tag !== "v" + version ||
    !/^v\d+\.\d+\.\d+$/.test(tag) ||
    !/^[a-f0-9]{40}$/i.test(sha)
  ) {
    throw new Error("Draft Release download has an invalid source identity.");
  }
  const expectedSha = sha.toLowerCase();
  if ((await api.resolveTagCommit(tag)) !== expectedSha) {
    throw new Error(
      "Draft Release Git tag does not match the qualified Commit SHA.",
    );
  }
  const release = await api.findRelease(tag);
  const marker = parseReleaseMarker(release?.body);
  if (
    !release?.draft ||
    release.tag_name !== tag ||
    marker?.tag !== tag ||
    marker.sha !== expectedSha ||
    marker.version !== version
  ) {
    throw new Error(
      "Draft Release is missing or has an unexpected identity marker.",
    );
  }
  const expectedNames = expectedAssetNames(tag);
  const remoteAssets = release.assets || [];
  if (
    remoteAssets.length !== expectedNames.length ||
    JSON.stringify(remoteAssets.map((asset) => asset.name).sort()) !==
      JSON.stringify(expectedNames)
  ) {
    throw new Error("Draft Release contains incomplete or unexpected assets.");
  }
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length !== 0) {
    throw new Error(
      "Refusing to overwrite a nonempty Draft download directory.",
    );
  }
  for (const name of expectedNames) {
    const remote = remoteAssets.find((asset) => asset.name === name);
    const bytes = await api.downloadAsset(remote);
    if (
      !Buffer.isBuffer(bytes) ||
      !Number.isSafeInteger(remote.size) ||
      bytes.length !== remote.size ||
      (remote.digest &&
        String(remote.digest).toLowerCase() !== "sha256:" + sha256(bytes))
    ) {
      throw new Error(
        "Draft Release downloaded asset size or digest mismatch: " + name,
      );
    }
    await writeFile(path.join(directory, name), bytes, { flag: "wx" });
  }
  const manifest = await createLocalManifest(
    directory,
    tag,
    expectedSha,
    version,
  );
  if (!markerMatches(release, manifest)) {
    throw new Error(
      "Draft Release downloaded bytes do not match the marked build identity.",
    );
  }
  const latest = await api.findRelease(tag);
  if (!latest?.draft || !markerMatches(latest, manifest)) {
    throw new Error(
      "Draft Release changed identity or became public during download.",
    );
  }
  await verifyRemoteAssets(api, latest, manifest, true);
  return manifest;
}

export async function prepareDraft(api, directory, manifest) {
  assertManifest(manifest);
  await verifyArtifact(directory, manifest);
  if ((await api.resolveTagCommit(manifest.tag)) !== manifest.sha) {
    throw new Error(
      "Git tag does not resolve to the verified source Commit SHA.",
    );
  }

  let release = await api.findRelease(manifest.tag);
  if (release && !release.draft) {
    throw new Error(
      "A published Release already uses this tag; published versions are never overwritten.",
    );
  }
  if (
    release &&
    parseReleaseMarker(release.body) &&
    !markerMatches(release, manifest)
  ) {
    await api.deleteRelease(release.id);
    release = null;
  }
  if (!release) {
    const marker = createReleaseMarker(manifest);
    const notes = await api.generateReleaseNotes(manifest.tag, manifest.sha);
    try {
      release = await api.createDraft({
        tag: manifest.tag,
        sha: manifest.sha,
        body: marker + (notes ? "\n\n" + notes : ""),
      });
    } catch (error) {
      release = await api.findRelease(manifest.tag);
      if (!release) throw error;
    }
  }
  if (!release.draft) {
    throw new Error(
      "Candidate Release is public; refusing to upload or replace assets.",
    );
  }

  const existingMarker = parseReleaseMarker(release.body);
  if (existingMarker && !markerMatches(release, manifest)) {
    throw new Error(
      "Draft Release build identity does not match this tag, Commit SHA, version, and artifact.",
    );
  }
  await verifyRemoteAssets(api, release, manifest, false);

  if (!existingMarker) {
    const body =
      createReleaseMarker(manifest) +
      (release.body ? "\n\n" + release.body : "");
    release = await api.updateRelease(release.id, { body });
    if (!release.draft)
      throw new Error("Draft Release changed state during safe recovery.");
  }

  for (const asset of manifest.assets) {
    if ((release.assets || []).some((entry) => entry.name === asset.name))
      continue;
    let uploaded = false;
    for (let attempt = 0; attempt < 4 && !uploaded; attempt++) {
      try {
        await api.uploadAsset(
          release,
          asset.name,
          await readFile(path.join(directory, asset.name)),
        );
        uploaded = true;
      } catch (error) {
        const refreshed = await api.findRelease(manifest.tag);
        const remote = (refreshed?.assets || []).find(
          (entry) => entry.name === asset.name,
        );
        if (remote) {
          await verifyRemoteAsset(api, remote, asset);
          release = refreshed;
          uploaded = true;
        } else if (!retryable(error) || attempt === 3) {
          throw error;
        } else {
          await delay(1000 * 2 ** attempt);
          release = refreshed || release;
        }
      }
    }
    if (!uploaded)
      throw new Error(
        "Draft Release asset upload did not complete: " + asset.name,
      );
    release = await api.findRelease(manifest.tag);
    if (!release?.draft)
      throw new Error(
        "Draft Release disappeared or became public during asset upload.",
      );
    const remote = (release.assets || []).find(
      (entry) => entry.name === asset.name,
    );
    if (remote) await verifyRemoteAsset(api, remote, asset);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    release = await api.findRelease(manifest.tag);
    if (!release?.draft)
      throw new Error("Candidate Release is no longer a draft.");
    if ((release.assets || []).length === manifest.assets.length) {
      await verifyRemoteAssets(api, release, manifest, true);
      if (!markerMatches(release, manifest)) {
        throw new Error(
          "Draft Release build identity changed during asset verification.",
        );
      }
      return release;
    }
    if (attempt < 4) await delay(1000 * 2 ** attempt);
  }
  throw new Error(
    "Draft Release asset list did not become complete after bounded verification retries.",
  );
}

export async function publishRelease(api, directory, manifest) {
  assertManifest(manifest);
  await verifyArtifact(directory, manifest);
  if ((await api.resolveTagCommit(manifest.tag)) !== manifest.sha) {
    throw new Error(
      "Git tag no longer resolves to the verified source Commit SHA.",
    );
  }
  let release = await api.findRelease(manifest.tag);
  if (!release) {
    throw new Error("Publish gate cannot find the verified candidate Release.");
  }
  if (!markerMatches(release, manifest)) {
    throw new Error(
      "Publish gate rejected a Release with a different build identity.",
    );
  }
  await verifyRemoteAssets(api, release, manifest, true);
  if (!release.draft) return release;
  await api.updateRelease(release.id, { draft: false });

  for (let attempt = 0; attempt < 6; attempt++) {
    release = await api.findRelease(manifest.tag);
    if (release && !release.draft) {
      await verifyRemoteAssets(api, release, manifest, true);
      if (!markerMatches(release, manifest)) {
        throw new Error(
          "CRITICAL: published Release identity changed after publication.",
        );
      }
      return release;
    }
    if (attempt < 5) await delay(2000 * (attempt + 1));
  }
  throw new Error(
    "CRITICAL: Publish request completed but public Release state could not be confirmed; inspect before retrying.",
  );
}

export class GitHubReleaseApi {
  constructor({ token, repository = REPOSITORY, fetchImpl = fetch }) {
    if (!token)
      throw new Error("GitHub token is required for release API access.");
    this.token = token;
    this.repository = repository;
    this.fetchImpl = fetchImpl;
  }

  async request(
    url,
    options = {},
    {
      retries = 0,
      retrySafe = false,
      accept = "application/vnd.github+json",
    } = {},
  ) {
    const method = options.method || "GET";
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(url, {
          ...options,
          headers: {
            Accept: accept,
            Authorization: "Bearer " + this.token,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(options.headers || {}),
          },
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        const error = Object.assign(
          new Error(
            "GitHub API " + method + " request failed due to a network error.",
          ),
          { retryable: true },
        );
        if (retrySafe && attempt < retries) {
          await delay(1000 * 2 ** attempt);
          continue;
        }
        throw error;
      }
      if (!response.ok) {
        const error = Object.assign(
          new Error(
            "GitHub API " +
              method +
              " request failed with HTTP " +
              response.status +
              ".",
          ),
          {
            status: response.status,
            retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
          },
        );
        if (retrySafe && error.retryable && attempt < retries) {
          await delay(1000 * 2 ** attempt);
          continue;
        }
        throw error;
      }
      return response;
    }
  }

  repoPath(suffix) {
    return API_ROOT + "/repos/" + this.repository + suffix;
  }

  async json(url, options, retrySafe = true) {
    const response = await this.request(url, options, {
      retries: retrySafe ? 4 : 0,
      retrySafe,
    });
    return response.status === 204 ? null : response.json();
  }

  async resolveTagCommit(tag) {
    const ref = await this.json(
      this.repoPath("/git/ref/tags/" + encodeURIComponent(tag)),
    );
    if (ref.object.type !== "tag") return ref.object.sha;
    const annotation = await this.json(
      this.repoPath("/git/tags/" + ref.object.sha),
    );
    return annotation.object.sha;
  }

  async findRelease(tag) {
    try {
      return await this.json(
        this.repoPath("/releases/tags/" + encodeURIComponent(tag)),
      );
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    for (let page = 1; ; page++) {
      const releases = await this.json(
        this.repoPath("/releases?per_page=100&page=" + page),
      );
      const release = releases.find((candidate) => candidate.tag_name === tag);
      if (release) return release;
      if (releases.length < 100) return null;
    }
  }

  async listReleases() {
    const releases = [];
    for (let page = 1; ; page++) {
      const entries = await this.json(
        this.repoPath("/releases?per_page=100&page=" + page),
      );
      releases.push(...entries);
      if (entries.length < 100) return releases;
    }
  }

  async generateReleaseNotes(tag, sha) {
    const result = await this.json(this.repoPath("/releases/generate-notes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_name: tag, target_commitish: sha }),
    });
    return result.body || "";
  }

  async createDraft({ tag, sha, body }) {
    return this.json(
      this.repoPath("/releases"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: sha,
          name: tag,
          body,
          draft: true,
          prerelease: false,
        }),
      },
      false,
    );
  }

  async updateRelease(id, patch) {
    return this.json(this.repoPath("/releases/" + id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async deleteRelease(id) {
    await this.json(
      this.repoPath("/releases/" + id),
      { method: "DELETE" },
      false,
    );
  }

  async uploadAsset(release, name, bytes) {
    const uploadUrl = release.upload_url.replace(
      /\{\?name,label\}$/,
      "?name=" + encodeURIComponent(name),
    );
    const response = await this.request(
      uploadUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      },
      { accept: "application/vnd.github+json" },
    );
    return response.json();
  }

  async downloadAsset(asset) {
    const response = await this.request(
      asset.url,
      {},
      {
        retries: 4,
        retrySafe: true,
        accept: "application/octet-stream",
      },
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async listVerifyRuns(sha) {
    const query = new URLSearchParams({
      head_sha: sha,
      branch: "master",
      event: "push",
      per_page: "100",
    });
    return this.json(this.repoPath("/actions/runs?" + query.toString()));
  }

  async listReadyRuns(sha) {
    const query = new URLSearchParams({
      head_sha: sha,
      branch: "master",
      event: "workflow_dispatch",
      per_page: "100",
    });
    return this.json(
      this.repoPath(
        "/actions/workflows/windows-studio-release-ready.yml/runs?" + query,
      ),
    );
  }

  async listRunJobs(runId) {
    return this.json(
      this.repoPath("/actions/runs/" + runId + "/jobs?per_page=100"),
    );
  }
}

function stableReleaseVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag || "");
  return match ? match.slice(1).map(Number) : null;
}

function compareReleaseVersions(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export async function findPublishedUpdateBaseline(
  api,
  targetTag,
  preferredTag,
) {
  const targetVersion = stableReleaseVersion(targetTag);
  if (!targetVersion)
    throw new Error("Online update target must be a stable release tag.");

  const candidates = (await api.listReleases()).filter((release) => {
    const version = stableReleaseVersion(release.tag_name);
    if (
      release.draft ||
      release.prerelease ||
      !version ||
      compareReleaseVersions(version, targetVersion) >= 0
    ) {
      return false;
    }
    const names = new Set((release.assets || []).map((asset) => asset.name));
    return [
      "ngt-studio-windows-" + release.tag_name + ".zip",
      "ngt-studio-windows-" + release.tag_name + ".zip.sha256",
      "ngt-studio-runtime-" + release.tag_name + ".zip",
      "ngt-studio-runtime-" + release.tag_name + ".zip.sha256",
    ].every((name) => names.has(name));
  });

  if (preferredTag) {
    return (
      candidates.find((release) => release.tag_name === preferredTag) || null
    );
  }

  candidates.sort((left, right) =>
    compareReleaseVersions(
      stableReleaseVersion(right.tag_name),
      stableReleaseVersion(left.tag_name),
    ),
  );
  return candidates[0] || null;
}

export async function qualifyRelease({
  api,
  tag,
  sha,
  version,
  timeoutMs = 20 * 60 * 1000,
  now = Date.now,
  sleep = delay,
  requireTag = true,
}) {
  if (tag !== "v" + version || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(
      "Release tag, package version, and Commit SHA are not qualified.",
    );
  }
  if (requireTag && (await api.resolveTagCommit(tag)) !== sha.toLowerCase()) {
    throw new Error(
      "Release tag does not resolve to the triggering Commit SHA.",
    );
  }
  const existing = await api.findRelease(tag);
  if (existing && !existing.draft) {
    throw new Error(
      "A public Release already uses this tag; published versions are never overwritten.",
    );
  }

  const deadline = now() + timeoutMs;
  let backoff = 5000;
  let lastState =
    "No Verify MVP push run is visible for this exact Commit SHA yet.";
  while (now() < deadline) {
    const response = await api.listVerifyRuns(sha);
    const runs = (response.workflow_runs || [])
      .filter(
        (run) =>
          run.path === ".github/workflows/ci.yml" &&
          run.head_sha === sha.toLowerCase() &&
          run.head_branch === "master" &&
          run.event === "push",
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const run = runs[0];
    if (run) {
      if (run.status === "completed" && run.conclusion !== "success") {
        throw new Error(
          "Exact-SHA Verify MVP concluded " +
            run.conclusion +
            "; Release is blocked.",
        );
      }
      if (run.status === "completed") {
        const jobsResponse = await api.listRunJobs(run.id);
        const jobs = jobsResponse.jobs || [];
        const states = REQUIRED_GATES.map((name) => {
          const matches = jobs.filter((job) => job.name === name);
          return {
            name,
            conclusion:
              matches.length === 1
                ? matches[0].conclusion
                : "missing-or-duplicate",
          };
        });
        if (states.every((entry) => entry.conclusion === "success"))
          return { run, jobs: states };
        if (
          states.some(
            (entry) =>
              entry.conclusion !== "success" &&
              entry.conclusion !== "queued" &&
              entry.conclusion !== "in_progress",
          )
        ) {
          throw new Error(
            "Exact-SHA Verify MVP is incomplete or failed required gates: " +
              states
                .map((entry) => entry.name + "=" + entry.conclusion)
                .join(", "),
          );
        }
        lastState =
          "Exact-SHA Verify MVP jobs are still being published by GitHub.";
      } else {
        lastState = "Exact-SHA Verify MVP is " + run.status + ".";
      }
    }
    await sleep(Math.min(backoff, Math.max(1, deadline - now())));
    backoff = Math.min(30000, backoff * 2);
  }
  throw new Error("Timed out before Windows build: " + lastState);
}

export async function requireReleaseReady(api, sha) {
  const response = await api.listReadyRuns(sha);
  const runs = (response.workflow_runs || [])
    .filter(
      (run) =>
        run.path === ".github/workflows/windows-studio-release-ready.yml" &&
        run.head_sha === sha.toLowerCase() &&
        run.head_branch === "master" &&
        run.event === "workflow_dispatch",
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const run = runs[0];
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      "Exact-SHA Release Ready has not passed for this Commit SHA.",
    );
  }
  const jobs = (await api.listRunJobs(run.id)).jobs || [];
  const required = [
    "Release Ready qualification",
    "Release Ready candidate build",
    "Release Ready installer acceptance",
    "Release Ready online-update acceptance",
    "Release Ready manual upgrade and repair acceptance",
    "Release Ready v2.0.20 manual upgrade and repair acceptance",
    "Release Ready",
  ];
  if (
    required.some(
      (name) =>
        jobs.filter((job) => job.name === name && job.conclusion === "success")
          .length !== 1,
    )
  ) {
    throw new Error(
      "Exact-SHA Release Ready is missing a successful required Windows acceptance job.",
    );
  }
  return run;
}

async function readExpectedPackageEnvironment() {
  const sha = process.env.GITHUB_SHA?.toLowerCase();
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  if (
    !/^[a-f0-9]{40}$/.test(sha || "") ||
    !/^\d+\.\d+\.\d+$/.test(packageJson.version)
  ) {
    throw new Error(
      "Windows package artifact requires a valid source SHA and package version.",
    );
  }
  return { sha, version: packageJson.version };
}
async function readExpectedEnvironment(allowCandidate = false) {
  const sha = process.env.GITHUB_SHA?.toLowerCase();
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const version = packageJson.version;
  const tag =
    allowCandidate && process.env.NGT_RELEASE_READY === "true"
      ? "v" + version
      : process.env.GITHUB_REF_NAME;
  if (tag !== "v" + version)
    throw new Error(
      "Tag " + tag + " does not match package version " + version + ".",
    );
  return { tag, sha, version };
}

async function main() {
  const [command, directoryArg] = process.argv.slice(2);
  if (command === "find-update-baseline") {
    if (!directoryArg)
      throw new Error("find-update-baseline requires the target release tag.");
    const api = new GitHubReleaseApi({
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    });
    const baseline = await findPublishedUpdateBaseline(
      api,
      directoryArg,
      process.argv[4],
    );
    if (!baseline)
      throw new Error(
        "No published release with supported online-update assets was found.",
      );
    console.log(JSON.stringify({ tagName: baseline.tag_name }));
    return;
  }
  if (command === "manifest") {
    const directory = directoryArg || process.env.NGT_RELEASE_ASSET_DIR;
    if (!directory)
      throw new Error("manifest requires the Windows release asset directory.");
    const { tag, sha, version } = await readExpectedEnvironment(true);
    const manifest = await createLocalManifest(directory, tag, sha, version);
    console.log("Verified build identity " + manifest.buildIdentity);
    return;
  }
  if (command === "package-manifest" || command === "verify-package") {
    const directory = directoryArg;
    if (!directory)
      throw new Error(
        command + " requires a Windows package artifact directory.",
      );
    const { sha, version } = await readExpectedPackageEnvironment();
    if (command === "package-manifest") {
      const packageDirectory = process.argv[4];
      if (!packageDirectory)
        throw new Error(
          "package-manifest requires the verified Studio package directory.",
        );
      const manifest = await createWindowsPackageManifest(
        directory,
        packageDirectory,
        sha,
        version,
      );
      console.log(
        "Created Windows package provenance " + manifest.buildIdentity,
      );
      return;
    }
    const manifest = await verifyWindowsPackageArtifact(directory, {
      sha,
      version,
    });
    console.log("Verified Windows package artifact " + manifest.buildIdentity);
    return;
  }
  if (command === "download-draft") {
    if (!directoryArg)
      throw new Error("download-draft requires an empty download directory.");
    const { tag, sha, version } = await readExpectedEnvironment();
    const api = new GitHubReleaseApi({
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    });
    const manifest = await downloadDraft(api, directoryArg, {
      tag,
      sha,
      version,
    });
    console.log(
      "Downloaded and verified Draft Release " + manifest.buildIdentity,
    );
    return;
  }
  if (
    command === "verify-artifact" ||
    command === "prepare-draft" ||
    command === "publish"
  ) {
    const directory = directoryArg;
    if (!directory)
      throw new Error(command + " requires the release artifact directory.");
    const manifest = JSON.parse(
      await readFile(path.join(directory, "release-manifest.json"), "utf8"),
    );
    const { tag, sha, version } = await readExpectedEnvironment(
      command === "verify-artifact",
    );
    await verifyArtifact(directory, manifest, { tag, sha, version });
    if (command === "verify-artifact") {
      console.log(
        "Verified exact-SHA release artifact " + manifest.buildIdentity,
      );
      return;
    }
    const api = new GitHubReleaseApi({
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    });
    if (command === "prepare-draft") {
      const draft = await prepareDraft(api, directory, manifest);
      console.log(
        "Verified resumable Draft Release " +
          draft.html_url +
          " (" +
          manifest.buildIdentity +
          ").",
      );
      return;
    }
    const published = await publishRelease(api, directory, manifest);
    console.log("Published verified Release " + published.html_url + ".");
    return;
  }
  if (command === "qualify") {
    const { tag, sha, version } = await readExpectedEnvironment();
    const api = new GitHubReleaseApi({
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    });
    const result = await qualifyRelease({
      api,
      tag,
      sha,
      version,
      timeoutMs:
        Number(process.env.NGT_VERIFY_TIMEOUT_MINUTES || 20) * 60 * 1000,
    });
    const ready = await requireReleaseReady(api, sha);
    if (process.env.GITHUB_OUTPUT) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        process.env.GITHUB_OUTPUT,
        "run_id=" + result.run.id + "\n",
        "utf8",
      );
    }
    console.log(
      "Exact-SHA Verify MVP gates passed for run " +
        result.run.id +
        "; Release Ready passed for run " +
        ready.id +
        ".",
    );
    return;
  }
  if (command === "qualify-candidate") {
    if (
      process.env.GITHUB_REF !== "refs/heads/master" ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    ) {
      throw new Error(
        "Release Ready must be dispatched for the master commit before tagging.",
      );
    }
    const { tag, sha, version } = await readExpectedEnvironment(true);
    const api = new GitHubReleaseApi({
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    });
    const result = await qualifyRelease({
      api,
      tag,
      sha,
      version,
      requireTag: false,
    });
    console.log(
      "Exact-SHA Verify MVP passed for Release Ready candidate: " +
        result.run.id,
    );
    return;
  }
  throw new Error(
    "Command must be manifest, package-manifest, verify-package, verify-artifact, download-draft, prepare-draft, publish, or qualify.",
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error("Windows Studio release workflow failed: " + error.message);
    process.exitCode = 1;
  });
}

