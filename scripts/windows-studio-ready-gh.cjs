/* eslint-disable @typescript-eslint/no-require-imports */
const { copyFileSync, mkdirSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function handleCandidate(args, env = process.env) {
  const [group, command, tag] = args;
  if (group !== "release" || tag !== env.NGT_READY_CANDIDATE_TAG) return false;
  const directory = env.NGT_READY_CANDIDATE_DIR;
  const manifest = JSON.parse(
    readFileSync(path.join(directory, "release-manifest.json"), "utf8"),
  );
  if (manifest.tag !== tag || manifest.sha !== env.GITHUB_SHA?.toLowerCase()) {
    throw new Error("Local candidate identity changed before online update.");
  }
  if (command === "view") {
    const assets = manifest.assets.map(({ name, size, sha256 }) => ({
      name,
      size,
      digest: "sha256:" + sha256,
    }));
    process.stdout.write(JSON.stringify({ tagName: tag, assets }) + "\n");
    return true;
  }
  if (command === "download") {
    const destination = args[args.indexOf("--dir") + 1];
    const patterns = args.flatMap((value, index) =>
      value === "--pattern" ? [args[index + 1]] : [],
    );
    if (
      !destination ||
      patterns.length === 0 ||
      patterns.some(
        (name) => !manifest.assets.some((asset) => asset.name === name),
      )
    ) {
      throw new Error("Local candidate download requested an unknown asset.");
    }
    mkdirSync(destination, { recursive: true });
    for (const name of patterns) {
      const asset = manifest.assets.find((entry) => entry.name === name);
      const source = path.join(directory, name);
      const bytes = readFileSync(source);
      if (
        bytes.length !== asset.size ||
        createHash("sha256").update(bytes).digest("hex") !== asset.sha256
      ) {
        throw new Error("Local candidate asset SHA256 changed: " + name);
      }
      copyFileSync(source, path.join(destination, name));
    }
    return true;
  }
  throw new Error("Unsupported local candidate gh action: " + command);
}

module.exports = { handleCandidate };

if (require.main === module) {
  try {
    if (!handleCandidate(process.argv.slice(2))) {
      const result = spawnSync(
        process.env.NGT_READY_GH_ORIGINAL,
        process.argv.slice(2),
        { stdio: "inherit" },
      );
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
