import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const [releaseArgument, expectedVersion, expectedCommit] =
  process.argv.slice(2);
if (!releaseArgument || !expectedVersion || !expectedCommit) {
  throw new Error(
    "Usage: node windows-studio-online-update-ui.mjs <release-root> <version> <commit>",
  );
}

const releaseRoot = resolve(releaseArgument);
const manifest = JSON.parse(
  (await readFile(resolve(releaseRoot, "studio-release.json"), "utf8")).replace(
    /^\uFEFF/,
    "",
  ),
);
if (
  manifest.version !== expectedVersion ||
  manifest.commit?.toLowerCase() !== expectedCommit.toLowerCase()
) {
  throw new Error("The active release manifest does not match the candidate.");
}

const baseUrl = "http://127.0.0.1:3000";
const healthResponse = await fetch(`${baseUrl}/api/health`, {
  cache: "no-store",
});
const health = await healthResponse.json();
if (
  healthResponse.status !== 200 ||
  health.status !== "ok" ||
  health.currentVersion !== expectedVersion ||
  health.buildCommit?.toLowerCase() !== expectedCommit.toLowerCase()
) {
  throw new Error(
    `The active server identity does not match the candidate (HTTP ${healthResponse.status}, version ${health.currentVersion}, commit ${health.buildCommit}).`,
  );
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const apiErrors = [];
  const resourceErrors = [];
  const checkedResources = new Set();
  const resourceChecks = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/_next/static/")) {
      resourceErrors.push(`${request.url()}: ${request.failure()?.errorText}`);
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== baseUrl) return;

    if (
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/system-update/") &&
      url.pathname !== "/api/system-update" &&
      response.status() >= 400
    ) {
      apiErrors.push(`${url.pathname}: HTTP ${response.status()}`);
    }

    const extension = url.pathname
      .toLowerCase()
      .split("?")[0]
      .slice(url.pathname.lastIndexOf("."));
    if (
      !url.pathname.startsWith("/_next/static/") ||
      ![".css", ".js"].includes(extension)
    ) {
      return;
    }
    checkedResources.add(extension);
    resourceChecks.push(
      (async () => {
        const relativePath = decodeURIComponent(
          url.pathname.slice("/_next/static/".length),
        ).replaceAll("\\", "/");
        const manifestPath = `.next/static/${relativePath}`;
        const expectedHash = manifest.files?.[manifestPath];
        const contentType = response.headers()["content-type"] || "";
        if (response.status() !== 200 || !expectedHash) {
          resourceErrors.push(
            `${url.pathname}: HTTP ${response.status()} or missing release manifest entry`,
          );
          return;
        }
        if (
          (extension === ".css" &&
            !contentType.toLowerCase().startsWith("text/css")) ||
          (extension === ".js" &&
            !/(?:application|text)\/(?:x-)?(?:java|ecma)script/i.test(
              contentType,
            ))
        ) {
          resourceErrors.push(
            `${url.pathname}: unexpected Content-Type ${contentType}`,
          );
          return;
        }
        const body = await response.body();
        if (body.length === 0) {
          resourceErrors.push(`${url.pathname}: empty response body`);
          return;
        }
        const actualHash = createHash("sha256").update(body).digest("hex");
        if (actualHash !== String(expectedHash).toLowerCase()) {
          resourceErrors.push(
            `${url.pathname}: response SHA-256 differs from the active release manifest`,
          );
        }
      })(),
    );
  });

  const routes = [
    "/",
    "/orders",
    "/retail",
    "/retail/sales",
    "/inventory",
    "/customers",
    "/prices",
    "/settings",
  ];
  for (const route of routes) {
    const response = await page.goto(`${baseUrl}${route}`, {
      waitUntil: "load",
      timeout: 30_000,
    });
    if (response?.status() !== 200 || new URL(page.url()).pathname !== route) {
      throw new Error(
        `${route} did not load from the active release (HTTP ${response?.status()}).`,
      );
    }
    await page
      .locator("main h1")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    const styles = await page.evaluate(() => ({
      surface: getComputedStyle(document.documentElement)
        .getPropertyValue("--surface-page")
        .trim(),
      background: getComputedStyle(document.body).backgroundColor,
    }));
    if (!styles.surface || styles.background === "rgba(0, 0, 0, 0)") {
      throw new Error(`${route} rendered without the release's page styling.`);
    }
  }

  await page.reload({ waitUntil: "load", timeout: 30_000 });
  await page
    .locator("main h1")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await Promise.all(resourceChecks);

  if (pageErrors.length || apiErrors.length || resourceErrors.length) {
    throw new Error(
      JSON.stringify({ pageErrors, apiErrors, resourceErrors }, null, 2),
    );
  }
  if (!checkedResources.has(".css") || !checkedResources.has(".js")) {
    throw new Error(
      "The browser did not load both CSS and JavaScript release assets.",
    );
  }
  await context.close();
  process.stdout.write(
    `Installed Edge smoke passed for ${routes.length} pages plus reload; checked candidate CSS/JS hashes and server identity ${expectedCommit}.\n`,
  );
} finally {
  await browser.close();
}
