import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { expect, test as base, type Page, type Route } from "@playwright/test";

async function serveWorkspaceAsset(route: Route, root: string, prefix: string) {
  const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
  const assetPath = resolve(root, pathname.slice(prefix.length));
  const relativePath = relative(root, assetPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error(`Requested asset is outside its root: ${pathname}`);
  if (!existsSync(assetPath)) return route.continue();
  return route.fulfill({ path: assetPath });
}

export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const nextStatic = resolve(
      process.cwd(),
      process.env.NEXT_DIST_DIR || ".next",
      "static",
    );
    const publicRoot = resolve(process.cwd(), "public");
    const originalGoto = page.goto.bind(page);
    page.goto = async (url, options) => {
      try {
        return await originalGoto(url, options);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("net::ERR_NO_BUFFER_SPACE") ||
          !baseURL
        )
          throw error;

        console.warn("Retrying navigation after net::ERR_NO_BUFFER_SPACE.");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        try {
          const health = await fetch(new URL("/api/health", baseURL));
          if (!health.ok) throw error;
          await health.arrayBuffer();
        } catch {
          throw error;
        }
        return originalGoto(url, options);
      }
    };
    await page
      .context()
      .route("**/_next/static/**", (route) =>
        serveWorkspaceAsset(route, nextStatic, "/_next/static/"),
      );
    await page
      .context()
      .route("**/brand/**", (route) =>
        serveWorkspaceAsset(route, publicRoot, "/"),
      );
    // Playwright fixture callback, not a React hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
  },
});

export { expect };
export type { Page };
