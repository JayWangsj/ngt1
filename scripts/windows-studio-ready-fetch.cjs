/* eslint-disable @typescript-eslint/no-require-imports */
const { readFileSync } = require("node:fs");

const candidateReleaseUrl =
  "https://api.github.com/repos/JayWangsj/ngt1/releases/latest";

function createCandidateReleaseFetch(fetchImpl, manifestPath, expectedTag) {
  return async function candidateReleaseFetch(input, init) {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const method = init?.method || (input instanceof Request && input.method);
    if (
      requestUrl !== candidateReleaseUrl ||
      (method && method.toUpperCase() !== "GET")
    ) {
      return fetchImpl.call(this, input, init);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.tag !== expectedTag) {
      throw new Error(
        "Candidate release manifest does not match its expected tag.",
      );
    }
    return Response.json({
      tag_name: manifest.tag,
      name: "NGT Studio " + manifest.tag,
      body: "Isolated Release Ready candidate",
      html_url:
        "https://github.com/JayWangsj/ngt1/releases/tag/" + manifest.tag,
      published_at: new Date().toISOString(),
      assets: manifest.assets.map(({ name, size }) => ({ name, size })),
    });
  };
}

if (process.env.NGT_READY_CANDIDATE_MANIFEST) {
  globalThis.fetch = createCandidateReleaseFetch(
    globalThis.fetch,
    process.env.NGT_READY_CANDIDATE_MANIFEST,
    process.env.NGT_READY_CANDIDATE_TAG,
  );
}

module.exports = { createCandidateReleaseFetch };
