import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

async function listFiles(root, directory = root, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await listFiles(root, fullPath, files);
    } else if (entry.isFile()) {
      files.push(relative(root, fullPath).split(sep).join("/"));
    } else {
      throw new Error(`Static asset is not a regular file: ${fullPath}`);
    }
  }
  return files.sort();
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isChildPath(parent, candidate) {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function verifyMirror(sourceRoot, standaloneRoot, manifestFiles, prefix) {
  const sourceFiles = await listFiles(sourceRoot);
  const standaloneFiles = await listFiles(standaloneRoot);
  const manifestFilesUnderPrefix = Object.keys(manifestFiles)
    .filter((manifestPath) => manifestPath.startsWith(`${prefix}/`))
    .map((manifestPath) => manifestPath.slice(prefix.length + 1))
    .sort();
  if (JSON.stringify(sourceFiles) !== JSON.stringify(standaloneFiles)) {
    throw new Error(
      `Standalone ${prefix} file inventory does not match the release.`,
    );
  }
  for (const relativePath of sourceFiles) {
    const manifestPath = `${prefix}/${relativePath}`;
    if (!/^[a-f0-9]{64}$/i.test(manifestFiles[manifestPath] || "")) {
      throw new Error(
        `Release manifest is missing static asset ${manifestPath}.`,
      );
    }
  }
  if (
    JSON.stringify(sourceFiles) !== JSON.stringify(manifestFilesUnderPrefix)
  ) {
    throw new Error(
      `Release manifest ${prefix} file inventory does not match the build.`,
    );
  }
  for (const relativePath of sourceFiles) {
    const manifestPath = `${prefix}/${relativePath}`;
    const expectedHash = manifestFiles[manifestPath];
    const sourceBytes = await readFile(join(sourceRoot, relativePath));
    const standaloneBytes = await readFile(join(standaloneRoot, relativePath));
    const expected = expectedHash.toLowerCase();
    if (
      digest(sourceBytes) !== expected ||
      digest(standaloneBytes) !== expected
    ) {
      throw new Error(
        `Static asset failed release integrity validation: ${manifestPath}.`,
      );
    }
  }
  return sourceFiles.length;
}

export async function verifyWindowsStudioStaticAssets({
  projectRoot,
  buildDirectory,
  standaloneBuildDirectory,
  standaloneRoot,
}) {
  const root = resolve(projectRoot);
  const metadata = JSON.parse(
    await readFile(join(root, "studio-release.json"), "utf8"),
  );
  if (
    !metadata.files ||
    typeof metadata.files !== "object" ||
    Array.isArray(metadata.files)
  ) {
    throw new Error("Studio release static asset manifest is missing.");
  }
  const buildRoot = resolve(buildDirectory);
  const standaloneBuildRoot = resolve(standaloneBuildDirectory);
  const appRoot = resolve(standaloneRoot);
  if (
    !isChildPath(root, buildRoot) ||
    !isChildPath(appRoot, standaloneBuildRoot) ||
    !isChildPath(root, appRoot)
  ) {
    throw new Error(
      "Static asset paths must stay inside the verified release.",
    );
  }
  for (const directory of [
    buildRoot,
    join(buildRoot, "static"),
    standaloneBuildRoot,
    join(standaloneBuildRoot, "static"),
    join(root, "public"),
    join(appRoot, "public"),
  ]) {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `Static asset root is not a regular directory: ${directory}`,
      );
    }
  }
  const staticCount = await verifyMirror(
    join(buildRoot, "static"),
    join(standaloneBuildRoot, "static"),
    metadata.files,
    `${relative(root, buildRoot).split(sep).join("/")}/static`,
  );
  if (staticCount === 0) {
    throw new Error("The standalone build has no static assets.");
  }
  await verifyMirror(
    join(root, "public"),
    join(appRoot, "public"),
    metadata.files,
    "public",
  );
}
