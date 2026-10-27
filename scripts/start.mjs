import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { verifyWindowsStudioStaticAssets } from "./verify-windows-studio-static-assets.mjs";
try {
  process.loadEnvFile(".env");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const projectRoot = process.env.NGT_STUDIO_ROOT ?? process.cwd();
const standaloneRoot = resolve(projectRoot, ".next/standalone");
const serverSource = await readFile(join(standaloneRoot, "server.js"), "utf8");
const configStartMarker = "const nextConfig = ";
const configEndMarker = "\n\nprocess.env.__NEXT_PRIVATE_STANDALONE_CONFIG";
const configStart = serverSource.indexOf(configStartMarker);
const configEnd = serverSource.indexOf(configEndMarker, configStart);
if (configStart < 0 || configEnd < 0) {
  throw new Error("Unable to read the standalone Next.js configuration.");
}
const nextConfig = JSON.parse(
  serverSource.slice(configStart + configStartMarker.length, configEnd),
);
const buildDirectory = resolve(projectRoot, nextConfig.distDir ?? ".next");
const standaloneBuildDirectory = resolve(
  standaloneRoot,
  nextConfig.distDir ?? ".next",
);
if (
  !buildDirectory.startsWith(`${resolve(projectRoot)}${sep}`) ||
  !standaloneBuildDirectory.startsWith(`${standaloneRoot}${sep}`)
) {
  throw new Error(
    "The standalone build directory must stay inside the project.",
  );
}
await verifyWindowsStudioStaticAssets({
  projectRoot,
  buildDirectory,
  standaloneBuildDirectory,
  standaloneRoot,
});
const child = spawn(process.execPath, [".next/standalone/server.js"], {
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    HOSTNAME: process.env.APP_HOST || "127.0.0.1",
    NGT_STUDIO_ROOT: process.cwd(),
  },
});
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
