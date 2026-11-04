import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyWindowsStudioStaticAssets } from "../../scripts/verify-windows-studio-static-assets.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ngt-static-assets-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const buildDirectory = path.join(root, ".next");
  const standaloneRoot = path.join(buildDirectory, "standalone");
  const standaloneBuildDirectory = path.join(standaloneRoot, ".next");
  const paths = [
    [
      path.join(buildDirectory, "static", "chunks", "app.js"),
      Buffer.from("app chunk"),
    ],
    [
      path.join(standaloneBuildDirectory, "static", "chunks", "app.js"),
      Buffer.from("app chunk"),
    ],
    [path.join(root, "public", "brand.svg"), Buffer.from("brand")],
    [path.join(standaloneRoot, "public", "brand.svg"), Buffer.from("brand")],
  ];
  for (const [file, bytes] of paths) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const metadata = {
    files: {
      ".next/static/chunks/app.js": hash(Buffer.from("app chunk")),
      "public/brand.svg": hash(Buffer.from("brand")),
    },
  };
  await writeFile(
    path.join(root, "studio-release.json"),
    JSON.stringify(metadata),
  );
  const verify = () =>
    verifyWindowsStudioStaticAssets({
      projectRoot: root,
      buildDirectory,
      standaloneBuildDirectory,
      standaloneRoot,
    });
  return { root, paths, verify };
}

test("repeated and concurrent startup verification is read-only", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.verify();
  const before = await Promise.all(
    fixture.paths.map(([file]) => readFile(file)),
  );
  await Promise.all(Array.from({ length: 4 }, () => fixture.verify()));
  const after = await Promise.all(
    fixture.paths.map(([file]) => readFile(file)),
  );
  assert.deepEqual(after, before);
});

test("startup rejects missing, extra, or corrupt standalone assets", async (t) => {
  const fixture = await makeFixture(t);
  await rm(fixture.paths[1][0]);
  await assert.rejects(fixture.verify(), /file inventory does not match/);

  await writeFile(fixture.paths[1][0], "corrupted");
  await assert.rejects(fixture.verify(), /failed release integrity validation/);

  await writeFile(
    path.join(fixture.root, ".next/standalone/.next/static/extra.js"),
    "extra",
  );
  await assert.rejects(fixture.verify(), /file inventory does not match/);
});

test("startup rejects missing release manifest entries and empty static builds", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(
    path.join(fixture.root, "studio-release.json"),
    JSON.stringify({ files: {} }),
  );
  await assert.rejects(fixture.verify(), /manifest is missing static asset/);

  const emptyFixture = await makeFixture(t);
  await rm(emptyFixture.paths[0][0]);
  await rm(emptyFixture.paths[1][0]);
  await writeFile(
    path.join(emptyFixture.root, "studio-release.json"),
    JSON.stringify({
      files: { "public/brand.svg": hash(Buffer.from("brand")) },
    }),
  );
  await assert.rejects(emptyFixture.verify(), /no static assets/);
});

test("startup rejects files removed from both copies but still listed in the manifest", async (t) => {
  const fixture = await makeFixture(t);
  await rm(fixture.paths[0][0]);
  await rm(fixture.paths[1][0]);
  await assert.rejects(
    fixture.verify(),
    /Release manifest \.next\/static file inventory does not match the build/,
  );
});

test("startup accepts equivalent Windows paths with different letter case", async (t) => {
  if (process.platform !== "win32")
    return t.skip("Windows path comparison only");
  const fixture = await makeFixture(t);
  await verifyWindowsStudioStaticAssets({
    projectRoot: fixture.root.toUpperCase(),
    buildDirectory: path.join(fixture.root, ".next"),
    standaloneBuildDirectory: path.join(fixture.root, ".next/standalone/.next"),
    standaloneRoot: path.join(fixture.root, ".next/standalone"),
  });
});
