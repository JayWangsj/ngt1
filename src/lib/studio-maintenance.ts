import { readFile } from "node:fs/promises";
import path from "node:path";
import { BusinessError } from "./domain";

export async function assertStudioWritesAvailable(
  root = process.env.NGT_STUDIO_ROOT || process.cwd(),
) {
  type StudioConfig = { installRoot?: string; maintenance?: boolean };
  const managerRoot = process.env.NGT_MANAGER_ROOT;
  const configPath = managerRoot
    ? path.join(managerRoot, "state", "studio.json")
    : path.join(root, ".local", "studio.json");
  let config: StudioConfig;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as StudioConfig;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new BusinessError(
      "Manutenzione di sistema non verificabile. Riprova tra poco.",
    );
  }
  if (!config.installRoot) return;
  if (config.maintenance) {
    throw new BusinessError(
      "Manutenzione di sistema in corso. Riprova tra poco.",
    );
  }

  try {
    await readFile(
      path.join(config.installRoot, "state", "update-maintenance.json"),
      "utf8",
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new BusinessError(
      "Manutenzione di sistema non verificabile. Riprova tra poco.",
    );
  }
  throw new BusinessError(
    "Manutenzione di sistema in corso. Riprova tra poco.",
  );
}
