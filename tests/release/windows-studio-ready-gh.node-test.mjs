import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
