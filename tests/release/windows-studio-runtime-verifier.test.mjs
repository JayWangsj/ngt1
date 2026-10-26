import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const verifier = resolve(
  repositoryRoot,
  "scripts/verify-windows-studio-runtime.ps1",
);
const uiSmoke = resolve(
  repositoryRoot,
  "tests/release/windows-studio-online-update-ui.mjs",
);
const expectedVersion = "2.0.22";
const expectedCommit = "0".repeat(40);
const html = (heading) =>
  `<!doctype html><html><head><link rel="stylesheet" href="/_next/static/css/app.css"></head><body><main><h1>${heading}</h1>${heading === "Vendita rapida" ? '<button id="sales-button">Vendite</button><dialog id="sales-dialog"><h2>Storico vendite</h2></dialog>' : ""}</main><script src="/_next/static/chunks/app.js"></script></body></html>`;
const headings = new Map([
  ["/", "Oggi in laboratorio"],
  ["/orders", "Schede di servizio"],
  ["/retail", "Vendita rapida"],
  ["/inventory", "Magazzino"],
  ["/customers", "Clienti"],
  ["/prices", "Listino prezzi"],
  ["/settings", "Impostazioni"],
]);

async function runCommand(executable, args) {
  const child = spawn(executable, args, {
    cwd: repositoryRoot,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data) => (stdout += data));
  child.stderr.setEncoding("utf8").on("data", (data) => (stderr += data));
  const [code] = await once(child, "exit");
  return { code, output: `${stdout}${stderr}` };
}

async function runVerifier(releaseRoot) {
  return runCommand("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    verifier,
    "-ReleaseRoot",
    releaseRoot,
    "-ExpectedVersion",
    expectedVersion,
    "-ExpectedCommit",
    expectedCommit,
  ]);
}

await mkdir(resolve(repositoryRoot, ".local"), { recursive: true });
const fixtureRoot = await mkdtemp(
  resolve(repositoryRoot, ".local/runtime-verifier-fixture-"),
);
const staticRoot = resolve(fixtureRoot, "release/.next/static");
await mkdir(resolve(staticRoot, "css"), { recursive: true });
await mkdir(resolve(staticRoot, "chunks"), { recursive: true });
const css = Buffer.from(
  ":root { --surface-page: #fff; } body { background: #fff; }",
);
const javascript = Buffer.from(`
  const dialog = document.querySelector('#sales-dialog');
  document.querySelector('#sales-button')?.addEventListener('click', () => dialog.showModal());
  if (new URLSearchParams(location.search).get('view') === 'sales') dialog?.showModal();
`);
await writeFile(resolve(staticRoot, "css/app.css"), css);
await writeFile(resolve(staticRoot, "chunks/app.js"), javascript);
await writeFile(
  resolve(fixtureRoot, "release/studio-release.json"),
  JSON.stringify({
    version: expectedVersion,
    commit: expectedCommit,
    files: {
      ".next/static/css/app.css": createHash("sha256")
        .update(css)
        .digest("hex"),
      ".next/static/chunks/app.js": createHash("sha256")
        .update(javascript)
        .digest("hex"),
    },
  }),
);

let mode = "valid";
let listening = false;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:3000");
  if (url.pathname === "/api/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        status: "ok",
        currentVersion: expectedVersion,
        buildCommit: expectedCommit,
      }),
    );
    return;
  }
  if (mode === "redirect" && url.pathname === "/orders") {
    response.writeHead(302, { Location: "/login" });
    response.end("redirect");
    return;
  }
  if (url.pathname === "/_next/static/css/app.css") {
    response.writeHead(200, { "Content-Type": "text/css" });
    response.end(css);
    return;
  }
  if (url.pathname === "/_next/static/chunks/app.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(javascript);
    return;
  }
  if (headings.has(url.pathname)) {
    const heading =
      mode === "generic-error" && url.pathname === "/customers"
        ? "Error"
        : headings.get(url.pathname);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html(heading));
    return;
  }
  response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  response.end("not found");
});

try {
  const serverReady = once(server, "listening");
  server.listen(3000, "127.0.0.1");
  await serverReady;
  listening = true;
  const valid = await runVerifier(resolve(fixtureRoot, "release"));
  assert.equal(valid.code, 0, valid.output);
  assert.match(valid.output, /checks passed for 8 pages and 2 assets/);

  const smoke = await runCommand(process.execPath, [
    uiSmoke,
    resolve(fixtureRoot, "release"),
    expectedVersion,
    expectedCommit,
  ]);
  assert.equal(smoke.code, 0, smoke.output);
  assert.match(smoke.output, /msedge installed-release smoke passed/);
  assert.match(smoke.output, /chrome installed-release smoke passed/);

  mode = "redirect";
  const redirected = await runVerifier(resolve(fixtureRoot, "release"));
  assert.notEqual(
    redirected.code,
    0,
    "A redirected page must fail verification.",
  );
  assert.match(
    redirected.output,
    /failed its local response check without redirects/,
  );

  mode = "generic-error";
  const errorPage = await runVerifier(resolve(fixtureRoot, "release"));
  assert.notEqual(
    errorPage.code,
    0,
    "A generic 200 error page must fail verification.",
  );
  assert.match(errorPage.output, /unexpected or error heading/);
  process.stdout.write(
    "Runtime verifier fixtures passed: correct pages/assets accepted; redirect and generic 200 error rejected. Edge/Chrome installed UI smoke passed.\n",
  );
} finally {
  if (listening) {
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}
