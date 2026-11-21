import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const brandDirectory = path.join(root, "public", "brand");
const appIconSource = path.join(brandDirectory, "ngt-app-icon.svg");
const darkAppIconSource = path.join(
  brandDirectory,
  "ngt-app-icon-dark.svg",
);
const markSource = path.join(brandDirectory, "ngt-mark.svg");
const pngSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256, 512];
const icoSizes = new Set([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);

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

async function renderSvg(source, size) {
  return sharp(source, { density: 384 })
    .resize(size, size, { fit: "contain" })
    .png()
    .toBuffer();
}

async function toInstallerBitmap(source) {
  const size = 96;
  const pixels = await sharp(source, { density: 384 })
    .resize(size, size, { fit: "contain" })
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
const darkIcoPngs = [];
for (const size of pngSizes) {
  const appPng = await renderSvg(appIconSource, size);
  const darkAppPng = await renderSvg(darkAppIconSource, size);
  const markPng = await renderSvg(markSource, size);
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
  await toInstallerBitmap(appIconSource),
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
  await renderSvg(appIconSource, 194),
);
await writeFile(
  path.join(brandDirectory, "ngt-app-icon-dark.png"),
  await renderSvg(darkAppIconSource, 194),
);
await writeFile(
  path.join(brandDirectory, "ngt-mark.png"),
  await renderSvg(markSource, 194),
);
await writeFile(
  path.join(root, "assets", "ngt-studio-icon.png"),
  await readFile(path.join(brandDirectory, "ngt-app-icon-256.png")),
);
await writeFile(
  path.join(root, "assets", "ngt-studio-icon.svg"),
  await readFile(appIconSource),
);
