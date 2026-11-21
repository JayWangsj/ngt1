import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const requiredSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256, 512];

describe("NGT brand assets", () => {
  it("keeps the horizontal logo and derives the phone mark from it", async () => {
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

    const [lightSource, darkSource, sourceCrop, generator] = await Promise.all([
      sharp("public/brand/ngt-phone-mark-source.png")
        .ensureAlpha()
        .raw()
        .toBuffer(),
      sharp("public/brand/ngt-phone-mark-source-dark.png")
        .ensureAlpha()
        .raw()
        .toBuffer(),
      sharp("public/brand/ngt-logo-horizontal.png")
        .extract({ left: 0, top: 0, width: 149, height: 235 })
        .ensureAlpha()
        .raw()
        .toBuffer(),
      readFile("scripts/generate-brand-assets.mjs", "utf8"),
    ]);
    expect(lightSource).toEqual(sourceCrop);
    expect(darkSource.length).toBe(lightSource.length);
    for (let offset = 0; offset < lightSource.length; offset += 4) {
      const alpha = lightSource[offset + 3];
      expect(darkSource[offset + 3]).toBe(alpha);
      if (alpha === 0) continue;
      const red = lightSource[offset];
      const green = lightSource[offset + 1];
      const blue = lightSource[offset + 2];
      const isYellow = red > 200 && green > 100 && blue < 64;
      if (isYellow) {
        expect(darkSource.subarray(offset, offset + 3)).toEqual(
          lightSource.subarray(offset, offset + 3),
        );
      } else {
        expect([...darkSource.subarray(offset, offset + 3)]).toEqual([
          255, 255, 255,
        ]);
      }
    }
    expect(generator).toContain("horizontalLogoPath");
    expect(generator).toContain(".extract(phoneCrop)");
    expect(generator).not.toContain("M42 132L152 55");
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
      const [light, dark] = await Promise.all([
        sharp(`public/brand/ngt-app-icon-${size}.png`)
          .ensureAlpha()
          .raw()
          .toBuffer(),
        sharp(`public/brand/ngt-app-icon-dark-${size}.png`)
          .ensureAlpha()
          .raw()
          .toBuffer(),
      ]);
      let minX = size;
      let maxX = -1;
      let minY = size;
      let maxY = -1;
      let yellowPixels = 0;
      for (let offset = 0; offset < light.length; offset += 4) {
        expect(dark[offset + 3]).toBe(light[offset + 3]);
        if (light[offset + 3] === 0) continue;
        const pixel = offset / 4;
        const x = pixel % size;
        const y = Math.floor(pixel / size);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        if (
          light[offset] > 200 &&
          light[offset + 1] > 100 &&
          light[offset + 2] < 64
        ) {
          yellowPixels += 1;
        }
      }
      expect(maxX - minX + 1).toBeGreaterThanOrEqual(
        Math.floor((size * 149) / 235) - 1,
      );
      expect(maxY - minY + 1).toBeGreaterThanOrEqual(size - 1);
      expect(yellowPixels).toBeGreaterThan(0);
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

  it("provides theme-aware favicon fallbacks from the same phone mark", async () => {
    const layout = await readFile("src/app/layout.tsx", "utf8");
    expect(layout).toContain("ngt-app-icon-dark.svg");
    expect(layout).toContain("ngt-app-icon-dark-32.png");
    expect(layout).toContain('media="(prefers-color-scheme: dark)"');
    expect(layout).toContain("?v=business-logo-1");
  });
});
