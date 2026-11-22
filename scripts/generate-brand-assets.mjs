import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const brandDirectory = path.join(root, "public", "brand");
const horizontalLogoPath = path.join(brandDirectory, "ngt-logo-horizontal.png");
const phoneSourcePath = path.join(brandDirectory, "ngt-phone-mark-source.png");
const darkPhoneSourcePath = path.join(
  brandDirectory,
  "ngt-phone-mark-source-dark.png",
);
const phoneCrop = { left: 0, top: 0, width: 149, height: 235 };
const pngSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256, 512];
const icoSizes = new Set([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);

async function extractPhoneSources() {
  const light = await sharp(horizontalLogoPath)
    .extract(phoneCrop)
    .ensureAlpha()
    .png()
    .toBuffer();
  const { data, info } = await sharp(light)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const darkPixels = Buffer.from(data);
  for (let offset = 0; offset < darkPixels.length; offset += 4) {
    if (darkPixels[offset + 3] === 0) continue;
    const red = darkPixels[offset];
    const green = darkPixels[offset + 1];
    const blue = darkPixels[offset + 2];
    const isYellow = red > 200 && green > 100 && blue < 64;
    if (!isYellow) {
      darkPixels[offset] = 255;
      darkPixels[offset + 1] = 255;
      darkPixels[offset + 2] = 255;
    }
  }
  const dark = await sharp(darkPixels, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
  await writeFile(phoneSourcePath, light);
  await writeFile(darkPhoneSourcePath, dark);
  return { light, dark };
}

function embeddedPhoneSvg(source, square) {
  const width = square ? phoneCrop.height : phoneCrop.width;
  const height = phoneCrop.height;
  const x = square ? (phoneCrop.height - phoneCrop.width) / 2 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="NGT"><image x="${x}" y="0" width="${phoneCrop.width}" height="${phoneCrop.height}" href="data:image/png;base64,${source.toString("base64")}"/></svg>\n`;
}

async function toWindowsIconBitmap(png, size) {
  const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
  const bitmapHeader = Buffer.alloc(40);
  const bitmap = Buffer.alloc(size * size * 4);
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const transparencyMask = Buffer.alloc(maskRowBytes * size);

  bitmapHeader.writeUInt32LE(40, 0);
  bitmapHeader.writeInt32LE(size, 4);
  bitmapHeader.writeInt32LE(size * 2, 8);
  bitmapHeader.writeUInt16LE(1, 12);
  bitmapHeader.writeUInt16LE(32, 14);
  bitmapHeader.writeUInt32LE(bitmap.length, 20);

  for (let y = 0; y < size; y += 1) {
    const targetRow = size - y - 1;
    for (let x = 0; x < size; x += 1) {
      const source = (y * size + x) * 4;
      const target = (targetRow * size + x) * 4;
      bitmap[target] = pixels[source + 2];
      bitmap[target + 1] = pixels[source + 1];
      bitmap[target + 2] = pixels[source];
      bitmap[target + 3] = pixels[source + 3];
      if (pixels[source + 3] < 16) {
        const maskByte = targetRow * maskRowBytes + Math.floor(x / 8);
        transparencyMask[maskByte] |= 1 << (7 - (x % 8));
      }
    }
  }

  return Buffer.concat([bitmapHeader, bitmap, transparencyMask]);
}

async function renderPhone(source, size) {
  return sharp(source)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();
}

async function renderAppIcon(source, size) {
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] > 100 && data[i + 2] < 64) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    }
  }
  const inset = Math.round(size * 0.14);
  const phone = await sharp(data, { raw: info })
    .resize(size - inset * 2, size - inset * 2, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const background = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#f4c62d"/></svg>`,
  );
  return sharp(background)
    .composite([{ input: phone, left: inset, top: inset }])
    .png()
    .toBuffer();
}

async function toInstallerBitmap(source) {
  const size = 96;
  const pixels = await sharp(source)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .flatten({ background: "#fbfaf7" })
    .raw()
    .toBuffer();
  const rowBytes = Math.ceil((size * 3) / 4) * 4;
  const bitmap = Buffer.alloc(54 + rowBytes * size);
  bitmap.write("BM", 0, "ascii");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(size, 18);
  bitmap.writeInt32LE(size, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(rowBytes * size, 34);
  for (let y = 0; y < size; y += 1) {
    const targetRow = size - y - 1;
    for (let x = 0; x < size; x += 1) {
      const sourceOffset = (y * size + x) * 3;
      const targetOffset = 54 + targetRow * rowBytes + x * 3;
      bitmap[targetOffset] = pixels[sourceOffset + 2];
      bitmap[targetOffset + 1] = pixels[sourceOffset + 1];
      bitmap[targetOffset + 2] = pixels[sourceOffset];
    }
  }
  return bitmap;
}

async function rgbBitmap(source, width, height) {
  const pixels = await sharp(Buffer.from(source), { density: 192 })
    .resize(width, height, { fit: "fill" })
    .flatten({ background: "#fbfaf7" })
    .raw()
    .toBuffer();
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const bitmap = Buffer.alloc(54 + rowBytes * height);
  bitmap.write("BM", 0, "ascii");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(rowBytes * height, 34);
  for (let y = 0; y < height; y += 1) {
    const targetRow = height - y - 1;
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * 3;
      const targetOffset = 54 + targetRow * rowBytes + x * 3;
      bitmap[targetOffset] = pixels[sourceOffset + 2];
      bitmap[targetOffset + 1] = pixels[sourceOffset + 1];
      bitmap[targetOffset + 2] = pixels[sourceOffset];
    }
  }
  return bitmap;
}

async function buildIco(images) {
  const iconBitmaps = [];
  for (const image of images) {
    iconBitmaps.push({
      size: image.size,
      data: await toWindowsIconBitmap(image.data, image.size),
    });
  }
  const headerSize = 6 + iconBitmaps.length * 16;
  let imageOffset = headerSize;
  const directory = Buffer.alloc(headerSize);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(iconBitmaps.length, 4);

  for (const [index, icon] of iconBitmaps.entries()) {
    const entry = 6 + index * 16;
    directory[entry] = icon.size === 256 ? 0 : icon.size;
    directory[entry + 1] = icon.size === 256 ? 0 : icon.size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(icon.data.length, entry + 8);
    directory.writeUInt32LE(imageOffset, entry + 12);
    imageOffset += icon.data.length;
  }
  return Buffer.concat([directory, ...iconBitmaps.map((icon) => icon.data)]);
}

const lightIcoPngs = [];
const stageIcons = {
  package:
    '<path d="m12 19 12-6 12 6v19l-12 6-12-6zM12 19l12 6 12-6M24 25v19M18 16l12 6"/>',
  shield:
    '<path d="M24 10c5 4 10 5 15 6v13c0 10-10 16-15 19-5-3-15-9-15-19V16c5-1 10-2 15-6Z"/><path d="m17 28 5 5 10-11"/>',
  clock: '<circle cx="24" cy="28" r="16"/><path d="M24 17v12l8 5"/>',
  success: '<circle cx="24" cy="28" r="16"/><path d="m15 28 6 6 13-14"/>',
  error: '<circle cx="24" cy="28" r="16"/><path d="m18 22 12 12m0-12L18 34"/>',
};
for (const [name, shape] of Object.entries(stageIcons)) {
  const color =
    name === "clock"
      ? "#ec7900"
      : name === "success"
        ? "#479b28"
        : name === "error"
          ? "#c43838"
          : "#258cd9";
  const background =
    name === "clock"
      ? "#fff0df"
      : name === "success"
        ? "#eaf5df"
        : name === "error"
          ? "#fff0ee"
          : "#e8f3fc";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" rx="12" fill="${background}"/><g transform="translate(4 0)" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">${shape}</g></svg>`;
  await writeFile(
    path.join(root, "assets", `ngt-stage-${name}.bmp`),
    await rgbBitmap(svg, 112, 112),
  );
}
const darkIcoPngs = [];
const phoneSources = await extractPhoneSources();
const appSource = await renderAppIcon(phoneSources.light, 512);
await writeFile(
  path.join(brandDirectory, "ngt-app-icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,${appSource.toString("base64")}"/></svg>`,
);
await writeFile(
  path.join(brandDirectory, "ngt-app-icon-dark.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,${appSource.toString("base64")}"/></svg>`,
);
await writeFile(
  path.join(brandDirectory, "ngt-mark.svg"),
  embeddedPhoneSvg(phoneSources.light, false),
);
for (const size of pngSizes) {
  const appPng = await renderAppIcon(phoneSources.light, size);
  const darkAppPng = appPng;
  const markPng = await renderPhone(phoneSources.light, size);
  await writeFile(
    path.join(brandDirectory, `ngt-app-icon-${size}.png`),
    appPng,
  );
  await writeFile(
    path.join(brandDirectory, `ngt-app-icon-dark-${size}.png`),
    darkAppPng,
  );
  await writeFile(path.join(brandDirectory, `ngt-mark-${size}.png`), markPng);
  if (icoSizes.has(size)) {
    lightIcoPngs.push({ size, data: appPng });
    darkIcoPngs.push({ size, data: darkAppPng });
  }
}

const lightIco = await buildIco(lightIcoPngs);
const darkIco = await buildIco(darkIcoPngs);
await writeFile(path.join(root, "assets", "ngt-studio.ico"), lightIco);
await writeFile(path.join(root, "assets", "ngt-studio-light.ico"), lightIco);
await writeFile(path.join(root, "assets", "ngt-studio-dark.ico"), darkIco);
await writeFile(
  path.join(root, "assets", "ngt-studio-installer.bmp"),
  await toInstallerBitmap(appSource),
);
const installerRailSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="272" viewBox="0 0 180 272">
  <rect width="180" height="272" fill="#fbfaf7"/>
  <path d="M-20 244C33 236 56 203 100 198c39-5 65 13 100-13v87H-20z" fill="#fff6d8"/>
  <path d="M-24 272c51-50 86-43 123-69 33-23 55-23 101-47v116H-24z" fill="#fff1bf" fill-opacity=".72"/>
</svg>`;
await writeFile(
  path.join(root, "assets", "ngt-studio-installer-rail.bmp"),
  await rgbBitmap(installerRailSvg, 180, 272),
);
await writeFile(
  path.join(brandDirectory, "ngt-app-icon.png"),
  await renderAppIcon(phoneSources.light, 194),
);
await writeFile(
  path.join(brandDirectory, "ngt-app-icon-dark.png"),
  await renderAppIcon(phoneSources.light, 194),
);
await writeFile(
  path.join(brandDirectory, "ngt-mark.png"),
  await renderPhone(phoneSources.light, 194),
);
await writeFile(
  path.join(root, "assets", "ngt-studio-icon.png"),
  await readFile(path.join(brandDirectory, "ngt-app-icon-256.png")),
);
await writeFile(
  path.join(root, "assets", "ngt-studio-icon.svg"),
  await readFile(path.join(brandDirectory, "ngt-app-icon.svg")),
);
