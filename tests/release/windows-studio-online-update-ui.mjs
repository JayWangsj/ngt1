import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const [releaseArgument, expectedVersion, expectedCommit, acceptanceMode] =
  process.argv.slice(2);
if (!releaseArgument || !expectedVersion || !expectedCommit) {
  throw new Error(
    "Usage: node windows-studio-online-update-ui.mjs <release-root> <version> <commit> [acceptance-mode]",
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

const routes = [
  { url: "/", headings: ["Oggi in laboratorio", "今日工作台"] },
  { url: "/orders", headings: ["Schede di servizio", "服务单"] },
  {
    url: "/retail",
    headings: ["Vendita rapida", "零售工作台"],
    openSalesDialog: true,
  },
  {
    url: "/retail?view=sales",
    headings: ["Vendita rapida", "零售工作台"],
    dialogHeadings: ["Storico vendite", "销售记录"],
  },
  { url: "/inventory", headings: ["Magazzino", "库存"] },
  { url: "/customers", headings: ["Clienti", "客户"] },
  { url: "/prices", headings: ["Listino prezzi", "报价表"] },
  { url: "/settings", headings: ["Impostazioni", "设置"] },
];

async function verifyInstalledBrowser(channel) {
  const browser = await chromium.launch({ channel, headless: true });
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
        resourceErrors.push(
          `${request.url()}: ${request.failure()?.errorText}`,
        );
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

    for (const route of routes) {
      const target = new URL(route.url, baseUrl);
      const response = await page.goto(target.href, {
        waitUntil: "load",
        timeout: 30_000,
      });
      const actual = new URL(page.url());
      if (
        response?.status() !== 200 ||
        actual.pathname !== target.pathname ||
        actual.search !== target.search
      ) {
        throw new Error(
          `${route.url} did not load directly from the active release (HTTP ${response?.status()}, final URL ${page.url()}).`,
        );
      }
      const heading = page.locator("main h1").first();
      await heading.waitFor({ state: "visible", timeout: 10_000 });
      const actualHeading = (await heading.innerText()).trim();
      if (!route.headings.includes(actualHeading)) {
        throw new Error(
          `${route.url} rendered an unexpected or error heading: ${actualHeading}`,
        );
      }
      if (route.openSalesDialog || route.dialogHeadings) {
        const dialog = page.getByRole("dialog");
        if (route.openSalesDialog) {
          await page
            .getByRole("button", { name: /^(Vendite|销售记录)$/ })
            .click();
        }
        await dialog.waitFor({ state: "visible", timeout: 10_000 });
        const dialogHeading = await dialog.getByRole("heading").innerText();
        const expectedDialogHeadings = route.dialogHeadings || [
          "Storico vendite",
          "销售记录",
        ];
        if (!expectedDialogHeadings.includes(dialogHeading.trim())) {
          throw new Error(
            `The retail sales dialog rendered unexpected content: ${dialogHeading}`,
          );
        }
      }
      const styles = await page.evaluate(() => ({
        surface: getComputedStyle(document.documentElement)
          .getPropertyValue("--surface-page")
          .trim(),
        background: getComputedStyle(document.body).backgroundColor,
      }));
      if (!styles.surface || styles.background === "rgba(0, 0, 0, 0)") {
        throw new Error(
          `${route.url} rendered without the release's page styling.`,
        );
      }
    }

    if (
      acceptanceMode === "online-update" ||
      acceptanceMode === "production-update"
    ) {
      const updateResponse = await page.goto(
        `${baseUrl}/settings/system-update`,
        {
          waitUntil: "load",
          timeout: 30_000,
        },
      );
      if (
        updateResponse?.status() !== 200 ||
        new URL(page.url()).pathname !== "/settings/system-update"
      ) {
        throw new Error(
          `The completed update page did not load directly (HTTP ${updateResponse?.status()}, final URL ${page.url()}).`,
        );
      }
      const success = page.locator(".update-result-card.succeeded");
      await success.waitFor({ state: "visible", timeout: 15_000 });
      const summary = await success.innerText();
      if (
        !summary.includes(`v${expectedVersion}`) ||
        !summary.toLowerCase().includes(expectedCommit.toLowerCase()) ||
        (await success.locator(".update-diagnostics-toggle").count()) !== 0
      ) {
        throw new Error(
          "The verified update summary is missing its final version/commit or still exposes a diagnostics action.",
        );
      }
    }

    await page.reload({ waitUntil: "load", timeout: 30_000 });
    await page.locator("main h1").first().waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await Promise.all(resourceChecks);

    if (pageErrors.length || apiErrors.length || resourceErrors.length) {
      throw new Error(
        JSON.stringify(
          { channel, pageErrors, apiErrors, resourceErrors },
          null,
          2,
        ),
      );
    }
    if (!checkedResources.has(".css") || !checkedResources.has(".js")) {
      throw new Error(
        `${channel} did not load both CSS and JavaScript release assets.`,
      );
    }
    await context.close();
    process.stdout.write(
      `${channel} installed-release smoke passed for ${routes.length} direct routes plus retail sales dialog and reload; checked candidate CSS/JS hashes and server identity ${expectedCommit}.\n`,
    );
  } finally {
    await browser.close();
  }
}

for (const channel of ["msedge", "chrome"]) {
  await verifyInstalledBrowser(channel);
}

