import { cp, mkdir, readFile, access, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

export async function resolvePostgresRuntime() {
  const packagedNative = resolve("runtime/postgres");
  let native;
  try {
    await access(join(packagedNative, "bin/postgres.exe"));
    native = packagedNative;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const require = createRequire(import.meta.url);
    const embeddedRequire = createRequire(require.resolve("embedded-postgres"));
    native = resolve(
      dirname(embeddedRequire.resolve("@embedded-postgres/windows-x64")),
      "../native",
    );
  }

  const cacheKey = resolve(
    process.env.NGT_MANAGER_ROOT ?? process.cwd(),
  ).toLowerCase();
  let runtimeFingerprint = createHash("sha256")
    .update(native.toLowerCase())
    .digest("hex");
  let runtimeFiles = [];
  if (process.env.NGT_MANAGER_ROOT) {
    const manifestText = await readFile(resolve("studio-release.json"), "utf8");
    const manifest = JSON.parse(
      manifestText.charCodeAt(0) === 0xfeff
        ? manifestText.slice(1)
        : manifestText,
    );
    runtimeFiles = Object.entries(manifest.files ?? {})
      .filter(([path]) => path.toLowerCase().startsWith("runtime/postgres/"))
      .sort(([left], [right]) => left.localeCompare(right));
    if (runtimeFiles.length === 0)
      throw new Error("The bundled PostgreSQL runtime manifest is missing.");
    const fingerprint = createHash("sha256");
    for (const [path, hash] of runtimeFiles)
      fingerprint.update(`${path}\0${hash}\n`);
    runtimeFingerprint = fingerprint.digest("hex");
  }
  const filesToVerify = runtimeFiles.length
    ? runtimeFiles.map(([path]) => path.slice("runtime/postgres/".length))
    : ["bin/postgres.exe", "bin/pg_ctl.exe", "bin/initdb.exe"];
  const verifyRuntimeFiles = async (runtimePath) => {
    for (const path of filesToVerify) await access(join(runtimePath, path));
  };

  const cache = join(
    tmpdir(),
    `ngt-pg-${createHash("sha256").update(cacheKey).digest("hex").slice(0, 10)}-${runtimeFingerprint.slice(0, 12)}`,
  );
  const runtime = /[^\x00-\x7F]/.test(native) ? join(cache, "runtime") : native;
  if (/[^\x00-\x7F]/.test(cache))
    throw new Error(
      "Set TEMP to an ASCII-only directory for the Windows PostgreSQL runtime.",
    );

  if (runtime !== native) {
    const marker = join(cache, "runtime.fingerprint");
    let ready = false;
    try {
      ready = (await readFile(marker, "utf8")) === runtimeFingerprint;
      if (ready) await verifyRuntimeFiles(runtime);
    } catch (error) {
      if (error.code !== "ENOENT") ready = false;
    }
    if (!ready) {
      await mkdir(cache, { recursive: true });
      await rm(runtime, { recursive: true, force: true });
      await cp(native, runtime, { recursive: true, dereference: true });
      await verifyRuntimeFiles(runtime);
      await writeFile(marker, runtimeFingerprint);
    }
  }
  return { runtime, cache };
}
