import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertStudioWritesAvailable } from "../../src/lib/studio-maintenance";

const roots: string[] = [];

async function createStudio() {
  const root = await mkdtemp(path.join(tmpdir(), "ngt-maintenance-"));
  roots.push(root);
  const installRoot = path.join(root, "installed");
  await mkdir(path.join(installRoot, "state"), { recursive: true });
  await mkdir(path.join(root, ".local"), { recursive: true });
  await writeFile(
    path.join(root, ".local", "studio.json"),
    JSON.stringify({ installRoot }),
  );
  return { root, installRoot };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("studio maintenance write gate", () => {
  it("allows writes when no installed studio maintenance marker exists", async () => {
    const { root } = await createStudio();
    await expect(assertStudioWritesAvailable(root)).resolves.toBeUndefined();
  });

  it("blocks writes while the update maintenance marker exists", async () => {
    const { root, installRoot } = await createStudio();
    await writeFile(
      path.join(installRoot, "state", "update-maintenance.json"),
      JSON.stringify({ updateId: "update-1", stage: "installing" }),
    );
    await expect(assertStudioWritesAvailable(root)).rejects.toThrow(
      "Manutenzione di sistema in corso",
    );
  });

  it("fails closed when the installed maintenance state cannot be read", async () => {
    const { root, installRoot } = await createStudio();
    await mkdir(path.join(installRoot, "state", "update-maintenance.json"), {
      recursive: true,
    });
    await expect(assertStudioWritesAvailable(root)).rejects.toThrow(
      "Manutenzione di sistema non verificabile",
    );
  });
});
