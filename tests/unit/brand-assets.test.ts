import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const requiredSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256, 512];

describe("NGT brand assets", () => {
  it("keeps the horizontal logo and uses true vector app marks", async () => {
    const reference = await sharp("assets/ngt-brand-reference.png")
      .extract({ left: 154, top: 177, width: 632, height: 238 })
      .removeAlpha()
      .raw()
      .toBuffer();
    const rendered = await sharp("public/brand/ngt-logo-horizontal.png")
      .flatten({ background: "#fff" })
      .removeAlpha()
      .raw()
      .toBuffer();
    const difference = reference.reduce(
      (total, value, index) => total + Math.abs(value - rendered[index]),
      0,
    );
    expect(difference / reference.length).toBeLessThan(3);

    const [light, dark, generator] = await Promise.all([
      readFile("public/brand/ngt-app-icon.svg", "utf8"),
      readFile("public/brand/ngt-app-icon-dark.svg", "utf8"),
      readFile("scripts/generate-brand-assets.mjs", "utf8"),
    ]);
    for (const svg of [light, dark]) {
      expect(svg).not.toMatch(/<image|base64|data:image/i);
      expect(svg).toContain("#f4c62d");
    }
    const normalizeIcon = (svg: string, outline: string) =>
      svg
        .replace(/<desc[^>]*>.*?<\/desc>/, "")
        .replaceAll(outline, "outline");
    expect(normalizeIcon(light, "#111111")).toBe(
      normalizeIcon(dark, "#ffffff"),
    );
    expect(generator).toContain("renderSvg(appIconSource, size)");
    expect(generator).not.toContain('sharp(path.join(brandDir, "ngt-mark.png"))');
  });

  it("provides the required transparent and yellow icon sizes", async () => {
    for (const size of requiredSizes) {
      for (const variant of ["ngt-mark", "ngt-app-icon", "ngt-app-icon-dark"]) {
        const metadata = await sharp(
          `public/brand/${variant}-${size}.png`,
        ).metadata();
        expect(metadata.width).toBe(size);
        expect(metadata.height).toBe(size);
      }
    }

    for (const name of [
      "assets/ngt-studio.ico",
      "assets/ngt-studio-light.ico",
      "assets/ngt-studio-dark.ico",
    ]) {
      const ico = await readFile(name);
      expect(ico.readUInt16LE(2)).toBe(1);
      expect(ico.readUInt16LE(4)).toBe(10);
      const layers = Array.from({ length: 10 }, (_, index) => {
        const offset = 6 + index * 16;
        return {
          width: ico[offset] || 256,
          height: ico[offset + 1] || 256,
          bits: ico.readUInt16LE(offset + 6),
        };
      });
      expect(layers).toEqual(
        [16, 20, 24, 32, 40, 48, 64, 96, 128, 256].map((size) => ({
          width: size,
          height: size,
          bits: 32,
        })),
      );
    }
  });

  it("generates the warm installer rail used by the reference layout", async () => {
    const bitmap = await readFile("assets/ngt-studio-installer-rail.bmp");
    expect(bitmap.subarray(0, 2).toString("ascii")).toBe("BM");
    expect(bitmap.readInt32LE(18)).toBe(180);
    expect(bitmap.readInt32LE(22)).toBe(272);
    const generator = await readFile(
      "scripts/generate-brand-assets.mjs",
      "utf8",
    );
    expect(generator).toContain("installerRailSvg");
    expect(generator).toContain("ngt-studio-installer-rail.bmp");
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
