import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const requiredSizes = [16, 32, 48, 64, 128, 256];

describe("NGT brand assets", () => {
  it("matches the supplied design board instead of redrawing the logo", async () => {
    for (const [asset, crop, maximumDifference] of [
      [
        "ngt-logo-horizontal.png",
        { left: 154, top: 177, width: 632, height: 238 },
        3,
      ],
      [
        "ngt-app-icon.png",
        { left: 1138, top: 138, width: 194, height: 194 },
        1,
      ],
    ] as const) {
      const reference = await sharp("assets/ngt-brand-reference.png")
        .extract(crop)
        .removeAlpha()
        .raw()
        .toBuffer();
      const rendered = await sharp(`public/brand/${asset}`)
        .flatten({ background: "#fff" })
        .removeAlpha()
        .raw()
        .toBuffer();
      const difference = reference.reduce(
        (total, value, index) => total + Math.abs(value - rendered[index]),
        0,
      );
      expect(difference / reference.length).toBeLessThan(maximumDifference);
    }
  });

  it("provides the required transparent and yellow icon sizes", async () => {
    for (const size of requiredSizes) {
      for (const variant of ["ngt-mark", "ngt-app-icon"]) {
        const metadata = await sharp(
          `public/brand/${variant}-${size}.png`,
        ).metadata();
        expect(metadata.width).toBe(size);
        expect(metadata.height).toBe(size);
      }
    }
  });

  it("keeps the shared web assets in the standalone Windows package", async () => {
    const launcher = await readFile("scripts/start.mjs", "utf8");
    const e2eRunner = await readFile("scripts/run-e2e.mjs", "utf8");
    const packager = await readFile(
      "scripts/build-windows-studio-package.ps1",
      "utf8",
    );
    expect(launcher).toContain(
      'from "./verify-windows-studio-static-assets.mjs"',
    );
    expect(launcher).toContain("await verifyWindowsStudioStaticAssets({");
    expect(launcher).toContain("buildDirectory,");
    expect(launcher).toContain("standaloneBuildDirectory,");
    expect(launcher).toContain("standaloneRoot,");
    expect(e2eRunner).toContain('cp("public", `${distDir}/standalone/public`');
    expect(packager).toContain(
      'Copy-Item -LiteralPath "public" -Destination (Join-Path $stage "public")',
    );
  });
});
