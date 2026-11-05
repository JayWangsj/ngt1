import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePostgresRuntime } from "../../scripts/postgres-runtime.mjs";

describe.skipIf(process.platform !== "win32")("PostgreSQL runtime", () => {
  it("uses a filesystem-safe cache name when no release manifest is present", async () => {
    const previousManagerRoot = process.env.NGT_MANAGER_ROOT;
    delete process.env.NGT_MANAGER_ROOT;

    try {
      const { cache } = await resolvePostgresRuntime();
      expect(basename(cache)).toMatch(/^ngt-pg-[a-f0-9]{10}-[a-f0-9]{12}$/i);
    } finally {
      if (previousManagerRoot === undefined)
        delete process.env.NGT_MANAGER_ROOT;
      else process.env.NGT_MANAGER_ROOT = previousManagerRoot;
    }
  });
});
