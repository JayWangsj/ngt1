/* eslint-disable @typescript-eslint/no-require-imports */
const { createReadStream, readFileSync, statSync } = require("node:fs");
const { createHash } = require("node:crypto");
const http = require("node:http");
const path = require("node:path");

const directory = path.resolve(process.argv[2]);
const manifestPath = path.resolve(process.argv[3]);
const port = Number(process.argv[4]);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("A valid loopback port is required.");
}

async function verifyAsset(asset) {
  const assetPath = path.join(directory, asset.name);
  if (statSync(assetPath).size !== asset.size) {
    throw new Error("Candidate asset identity changed: " + asset.name);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(assetPath)) hash.update(chunk);
  if (hash.digest("hex") !== asset.sha256) {
    throw new Error("Candidate asset identity changed: " + asset.name);
  }
}

const tag = manifest.tag;
const assets = manifest.assets.map((asset, index) => ({
  id: index + 1,
  name: asset.name,
  size: asset.size,
  digest: "sha256:" + asset.sha256,
  browser_download_url: "http://127.0.0.1:" + port + "/assets/" + (index + 1),
}));
const release = {
  tag_name: tag,
  name: "NGT acceptance candidate " + tag,
  body:
    "<!-- ngt-release-build:v1 tag=" +
    tag +
    " sha=" +
    manifest.sha +
    " version=" +
    manifest.version +
    " identity=" +
    manifest.buildIdentity +
    " -->",
  draft: false,
  assets,
};

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (
    request.method === "GET" &&
    request.url === "/repos/JayWangsj/ngt1/releases/tags/" + tag
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(release));
    return;
  }
  const assetMatch = request.url?.match(
    /^\/repos\/JayWangsj\/ngt1\/releases\/assets\/(\d+)$/,
  );
  const asset = assetMatch ? assets[Number(assetMatch[1]) - 1] : undefined;
  if (request.method === "GET" && asset) {
    const filePath = path.join(directory, asset.name);
    response.writeHead(200, {
      "content-length": String(statSync(filePath).size),
      "content-type": "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

async function startServer() {
  for (const asset of manifest.assets) await verifyAsset(asset);
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(JSON.stringify({ status: "ready", port }) + "\n");
  });
}

startServer().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
