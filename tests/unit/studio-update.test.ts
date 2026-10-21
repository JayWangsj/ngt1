import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkStudioUpdate,
  compareVersions,
  getGitHubLoginStatus,
  getStudioUpdateLog,
  getStudioUpdateStatus,
  startGitHubLogin,
  startStudioUpdate as startStudioUpdateWithOptions,
} from "../../src/lib/studio-update";

const temporaryRoots: string[] = [];

function authProcess() {
  const events = new EventEmitter();
  let input = "";
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      callback();
    },
  });
  return {
    process: {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      once: events.once.bind(events),
      kill: () => true,
      unref() {},
    },
    emit: events.emit.bind(events),
    input: () => input,
  };
}

function updateProcess() {
  const events = new EventEmitter();
  return {
    process: {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      unref() {},
      on: events.on.bind(events),
      once: events.once.bind(events),
    } as unknown as ChildProcess,
    emit: events.emit.bind(events),
  };
}

function updateRelease(tag = "v1.11.58") {
  return {
    tag_name: tag,
    assets: [
      { name: `ngt-studio-windows-${tag}.zip`, size: 240_000_000 },
      { name: `ngt-studio-windows-${tag}.zip.sha256`, size: 90 },
      { name: `ngt-studio-runtime-${tag}.zip`, size: 150_000_000 },
      { name: `ngt-studio-runtime-${tag}.zip.sha256`, size: 90 },
      { name: `ngt-studio-windows-setup-${tag}.exe`, size: 96_000_000 },
      { name: `ngt-studio-windows-setup-${tag}.exe.sha256`, size: 92 },
    ],
  };
}

function startStudioUpdate(
  options: Parameters<typeof startStudioUpdateWithOptions>[0] = {},
) {
  return startStudioUpdateWithOptions({
    ...options,
    fetchImpl:
      options.fetchImpl ||
      (async () =>
        new Response(JSON.stringify(updateRelease()), { status: 200 })),
  });
}

function launchUpdater(
  root: string,
  child: ReturnType<typeof updateProcess>,
  launches?: { executable: string; args: string[] }[],
) {
  return (executable: string, args: string[]) => {
    launches?.push({ executable, args });
    const updateId = args[args.indexOf("--update-id") + 1];
    const statusPath = path.join(root, "installed", "update-status.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        status: "checking",
        stage: "checking",
        operation: "online-update",
        updateId,
        targetVersion: args[args.indexOf("--target-version") + 1],
        previousVersion: "1.11.57",
        executorConfirmed: true,
        executorPid: child.process.pid,
        executorPath: executable,
        updatedAt: new Date().toISOString(),
      }),
    );
    return child.process;
  };
}

async function studioRoot(repository = "JayWangsj/ngt1") {
  const root = await mkdtemp(path.join(tmpdir(), "ngt-studio-update-"));
  temporaryRoots.push(root);
  const installRoot = path.join(root, "installed");
  await Promise.all([
    mkdir(path.join(root, "runtime"), { recursive: true }),
    mkdir(path.join(root, ".local"), { recursive: true }),
    mkdir(path.join(root, "scripts"), { recursive: true }),
    mkdir(path.join(root, "tools"), { recursive: true }),
    mkdir(installRoot, { recursive: true }),
  ]);
  await mkdir(path.join(installRoot, ".local"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(root, "studio-release.json"),
      JSON.stringify({ version: "1.11.57" }),
    ),
    writeFile(path.join(root, "runtime", "gh.exe"), "test"),
    writeFile(path.join(root, "tools", "NGTUpdater.exe"), "test binary"),
    writeFile(
      path.join(root, ".local", "studio.json"),
      JSON.stringify({
        installRoot,
        activeRelease: root,
        repository,
      }),
    ),
  ]);
  return { root, installRoot };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("studio update", () => {
  it("compares release versions numerically", () => {
    expect(compareVersions("v1.11.58", "1.11.57")).toBe(1);
    expect(compareVersions("1.11.57", "v1.11.57")).toBe(0);
    expect(compareVersions("1.9.9", "1.10.0")).toBe(-1);
  });

  it("requires GitHub authorization before reading a private release", async () => {
    const { root } = await studioRoot("example/private");
    const result = await checkStudioUpdate({
      root,
      run: async () => {
        throw new Error("You are not logged into any GitHub hosts.");
      },
    });
    expect(result).toMatchObject({
      installed: true,
      currentVersion: "1.11.57",
      authRequired: true,
      updateAvailable: false,
    });
  });

  it("reads Windows PowerShell JSON files with a UTF-8 BOM", async () => {
    const { root, installRoot } = await studioRoot();
    await Promise.all([
      writeFile(
        path.join(root, "studio-release.json"),
        `\uFEFF${JSON.stringify({ version: "1.11.57" })}`,
      ),
      writeFile(
        path.join(root, ".local", "studio.json"),
        `\uFEFF${JSON.stringify({
          installRoot,
          repository: "JayWangsj/ngt-repair-system",
        })}`,
      ),
      writeFile(
        path.join(installRoot, "update-status.json"),
        `\uFEFF${JSON.stringify({ status: "checking", stage: "checking" })}`,
      ),
    ]);

    const result = await checkStudioUpdate({
      root,
      inspect: async () => true,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(
          "https://api.github.com/repos/JayWangsj/ngt1/releases/latest",
        );
        expect(init?.headers).not.toHaveProperty("Authorization");
        return new Response(
          JSON.stringify({
            tag_name: "v1.11.58",
            name: "NGT 1.11.58",
            body: "Correzioni e miglioramenti",
            html_url: "https://github.com/JayWangsj/ngt1/releases/tag/v1.11.58",
            published_at: "2026-10-17T00:00:00Z",
            assets: [
              { name: "ngt-studio-windows-v1.11.58.zip", size: 240_000_000 },
              { name: "ngt-studio-windows-v1.11.58.zip.sha256" },
              { name: "ngt-studio-runtime-v1.11.58.zip" },
              { name: "ngt-studio-runtime-v1.11.58.zip.sha256" },
              {
                name: "ngt-studio-windows-setup-v1.11.58.exe",
                size: 96_000_000,
              },
              { name: "ngt-studio-windows-setup-v1.11.58.exe.sha256" },
            ],
          }),
          { status: 200 },
        );
      },
    });

    expect(result).toMatchObject({
      installed: true,
      currentVersion: "1.11.57",
      authRequired: false,
      updateAvailable: true,
      latestVersion: "1.11.58",
      releaseUrl: "https://github.com/JayWangsj/ngt1/releases/tag/v1.11.58",
      status: { status: "checking" },
    });
  });

  it("uses the installed studio root after the standalone server changes directories", async () => {
    const { root } = await studioRoot("example/private");
    const previousRoot = process.env.NGT_STUDIO_ROOT;
    process.env.NGT_STUDIO_ROOT = root;
    try {
      const result = await checkStudioUpdate({
        run: async () => {
          throw new Error("You are not logged into any GitHub hosts.");
        },
      });
      expect(result).toMatchObject({
        installed: true,
        currentVersion: "1.11.57",
        authRequired: true,
      });
    } finally {
      if (previousRoot === undefined) delete process.env.NGT_STUDIO_ROOT;
      else process.env.NGT_STUDIO_ROOT = previousRoot;
    }
  });

  it("detects a newer private release after authorization", async () => {
    const { root } = await studioRoot("example/private");
    const calls: string[][] = [];
    const result = await checkStudioUpdate({
      root,
      run: async (_executable, args) => {
        calls.push(args);
        return {
          stdout:
            args[0] === "release"
              ? JSON.stringify({
                  tagName: "v1.11.58",
                  name: "NGT 1.11.58",
                  body: "Correzioni e miglioramenti",
                  url: "https://github.com/example/release",
                  publishedAt: "2026-10-04T12:00:00Z",
                  assets: [
                    {
                      name: "ngt-studio-windows-v1.11.58.zip",
                      size: 240_000_000,
                    },
                    { name: "ngt-studio-windows-v1.11.58.zip.sha256" },
                    { name: "ngt-studio-runtime-v1.11.58.zip" },
                    { name: "ngt-studio-runtime-v1.11.58.zip.sha256" },
                    {
                      name: "ngt-studio-windows-setup-v1.11.58.exe",
                      size: 96_000_000,
                    },
                    { name: "ngt-studio-windows-setup-v1.11.58.exe.sha256" },
                  ],
                })
              : "",
          stderr: "",
        };
      },
    });
    expect(calls[0]).toEqual([
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--active",
    ]);
    expect(calls[1]).toContain("example/private");
    expect(result).toMatchObject({
      authRequired: false,
      updateAvailable: true,
      latestVersion: "1.11.58",
      releaseName: "NGT 1.11.58",
      releaseNotes: "Correzioni e miglioramenti",
      downloadSize: 96_000_000,
    });
    expect(calls[1]).toContain("tagName,name,body,url,publishedAt,assets");
  });

  it("does not offer a release without both the archive and checksum", async () => {
    const { root } = await studioRoot();
    const result = await checkStudioUpdate({
      root,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            tag_name: "v1.11.58",
            assets: [
              { name: "ngt-studio-windows-v1.11.58.zip" },
              { name: "ngt-studio-windows-v1.11.58.zip.sha256" },
            ],
          }),
          { status: 200 },
        ),
    });
    expect(result).toMatchObject({ updateAvailable: false });
  });

  it("reports public Release API network errors", async () => {
    const { root } = await studioRoot();
    await expect(
      checkStudioUpdate({
        root,
        fetchImpl: async () => {
          throw new Error("connection timed out");
        },
      }),
    ).rejects.toThrow("connection timed out");
  });

  it("shows an unreadable saved state as requiring verification", async () => {
    const { root, installRoot } = await studioRoot();
    await writeFile(path.join(installRoot, "update-status.json"), "{broken");

    await expect(getStudioUpdateStatus(root)).resolves.toMatchObject({
      status: "verifying-task",
      manualReview: true,
    });
  });

  it("does not trust an old checking task when its identified process is gone", async () => {
    const { root, installRoot } = await studioRoot();
    await writeFile(
      path.join(installRoot, "update-status.json"),
      JSON.stringify({
        status: "checking",
        stage: "checking",
        updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
        executorPid: 4242,
        executorConfirmed: true,
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    await expect(
      getStudioUpdateStatus(root, { inspect: async () => false }),
    ).resolves.toMatchObject({
      status: "interrupted",
      previousStatus: "checking",
      currentVersion: "1.11.57",
      manualReview: true,
    });
  });

  it("allows retry after a verified pre-mutation interruption", async () => {
    const { root, installRoot } = await studioRoot();
    const updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    const lockFile = path.join(installRoot, "update.lock");
    await Promise.all([
      writeFile(
        lockFile,
        JSON.stringify({
          updateId,
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      ),
      writeFile(
        path.join(installRoot, "update-status.json"),
        JSON.stringify({
          status: "downloading",
          stage: "downloading",
          updateId,
          previousVersion: "1.11.57",
          executorConfirmed: true,
          updatedAt: "2020-01-01T00:00:00.000Z",
        }),
      ),
    ]);

    const child = updateProcess();
    await expect(
      startStudioUpdate({
        root,
        inspect: async () => false,
        launch: launchUpdater(root, child),
      }),
    ).resolves.toMatchObject({ status: "checking" });
    const nextLock = JSON.parse(await readFile(lockFile, "utf8")) as {
      updateId: string;
    };
    expect(nextLock.updateId).not.toBe(updateId);
  });

  it("blocks retry after an interrupted installation stage", async () => {
    const { root, installRoot } = await studioRoot();
    await writeFile(
      path.join(installRoot, "update-status.json"),
      JSON.stringify({
        status: "installing",
        stage: "installing",
        updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
        previousVersion: "1.11.57",
        executorConfirmed: true,
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    await expect(
      startStudioUpdate({ root, inspect: async () => false }),
    ).rejects.toThrow("studio_update_needs_manual_review");
    await expect(
      getStudioUpdateStatus(root, { inspect: async () => false }),
    ).resolves.toMatchObject({
      status: "interrupted",
      manualReview: true,
    });
  });

  it("blocks retry when the maintenance marker is damaged or belongs to another task", async () => {
    const { root, installRoot } = await studioRoot();
    const updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    await Promise.all([
      writeFile(
        path.join(installRoot, "update-status.json"),
        JSON.stringify({
          status: "downloading",
          stage: "downloading",
          updateId,
          previousVersion: "1.11.57",
        }),
      ),
      writeFile(
        path.join(installRoot, ".local", "update-maintenance.json"),
        JSON.stringify({ updateId: "ba4e7a2e-5d35-4f8f-9f64-084d254c660a" }),
      ),
    ]);

    await expect(
      startStudioUpdate({ root, inspect: async () => false }),
    ).rejects.toThrow("studio_update_needs_manual_review");
    await expect(getStudioUpdateStatus(root)).resolves.toMatchObject({
      status: "verifying-task",
      manualReview: true,
    });
  });

  it("does not treat a reported completion as success unless the running version matches", async () => {
    const { root, installRoot } = await studioRoot();
    await writeFile(
      path.join(installRoot, "update-status.json"),
      JSON.stringify({
        status: "complete",
        updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
        targetVersion: "1.11.58",
        latestVersion: "v1.11.58",
      }),
    );

    await expect(getStudioUpdateStatus(root)).resolves.toMatchObject({
      status: "interrupted",
      actualVersion: "1.11.57",
      manualReview: true,
    });
  });

  it("does not report completion until the updater lock is released", async () => {
    const { root, installRoot } = await studioRoot();
    const updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    await Promise.all([
      writeFile(
        path.join(installRoot, "update.lock"),
        JSON.stringify({
          updateId,
          executorPid: 4242,
          executorPath: path.join(root, "tools", "NGTUpdater.exe"),
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      ),
      writeFile(
        path.join(installRoot, "update-status.json"),
        JSON.stringify({
          status: "complete",
          updateId,
          targetVersion: "1.11.58",
          actualVersion: "1.11.58",
        }),
      ),
      writeFile(
        path.join(root, "studio-release.json"),
        JSON.stringify({ version: "1.11.58" }),
      ),
    ]);

    await expect(
      getStudioUpdateStatus(root, { inspect: async () => true }),
    ).resolves.toMatchObject({
      status: "verifying-task",
      manualReview: false,
    });
    await expect(
      getStudioUpdateStatus(root, { inspect: async () => false }),
    ).resolves.toMatchObject({ status: "complete" });
    await expect(
      readFile(path.join(installRoot, "update.lock")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not claim a rollback is verified without a recorded previous version", async () => {
    const { root, installRoot } = await studioRoot();
    await writeFile(
      path.join(installRoot, "update-status.json"),
      JSON.stringify({
        status: "failed",
        recoveryStatus: "succeeded",
        updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
      }),
    );

    await expect(getStudioUpdateStatus(root)).resolves.toMatchObject({
      status: "failed",
      recoveryStatus: "failed",
      currentVersion: "1.11.57",
      actualVersion: "1.11.57",
      manualReview: true,
      recoveryMessage:
        "The previous version was not recorded, so the rollback cannot be verified.",
    });
  });

  it("keeps a verified manual-install supersession informational and opens the old task log", async () => {
    const { root, installRoot } = await studioRoot();
    const previousUpdateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    await mkdir(path.join(installRoot, "logs"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(installRoot, "update-status.json"),
        JSON.stringify({
          status: "superseded",
          updateId: previousUpdateId,
          previousUpdateId,
          previousStatus: "queued",
          manualInstallId: "ce931cdf-1b06-40a2-a356-14c17e08dfb2",
          currentVersion: "1.11.57",
          actualVersion: "1.11.57",
        }),
      ),
      writeFile(
        path.join(installRoot, "logs", `update-${previousUpdateId}.log`),
        "old queued task was superseded after a verified manual install",
      ),
    ]);

    await expect(getStudioUpdateStatus(root)).resolves.toMatchObject({
      status: "superseded",
      previousStatus: "queued",
      currentVersion: "1.11.57",
    });
    await expect(getStudioUpdateLog(root)).resolves.toContain(
      "old queued task was superseded",
    );
  });

  it("keeps a stale lock while its updater identity is still alive", async () => {
    const { root, installRoot } = await studioRoot();
    const updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    const lockFile = path.join(installRoot, "update.lock");
    await writeFile(
      lockFile,
      JSON.stringify({
        updateId,
        executorPid: 4242,
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    await writeFile(
      path.join(installRoot, "update-status.json"),
      JSON.stringify({ status: "running", updateId, executorPid: 4242 }),
    );

    await expect(
      startStudioUpdate({ root, inspect: async () => true }),
    ).rejects.toThrow("studio_update_in_progress");
    await expect(readFile(lockFile, "utf8")).resolves.toContain(updateId);
  });

  it("fails closed on a queued v2.0.11-era task after the active release advances", async () => {
    const { root, installRoot } = await studioRoot();
    const updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    await Promise.all([
      writeFile(
        path.join(root, "studio-release.json"),
        JSON.stringify({ version: "2.0.15" }),
      ),
      writeFile(
        path.join(installRoot, "update-status.json"),
        JSON.stringify({
          status: "queued",
          updateId,
          previousVersion: "2.0.11",
          targetVersion: "2.0.12",
        }),
      ),
    ]);

    await expect(
      getStudioUpdateStatus(root, { inspect: async () => false }),
    ).resolves.toMatchObject({
      status: "interrupted",
      stage: "queued",
      currentVersion: "2.0.15",
      previousVersion: "2.0.11",
      manualReview: true,
    });
  });

  it("starts only one updater when concurrent requests reclaim the same stale lock", async () => {
    const { root, installRoot } = await studioRoot();
    const updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    const lockFile = path.join(installRoot, "update.lock");
    await writeFile(
      lockFile,
      JSON.stringify({
        updateId,
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    await writeFile(
      path.join(installRoot, "update-status.json"),
      JSON.stringify({
        status: "downloading",
        stage: "downloading",
        updateId,
        previousVersion: "1.11.57",
        executorConfirmed: true,
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    let launchCount = 0;
    const inspect = async () => false;
    const launch = (executable: string, args: string[]) => {
      launchCount += 1;
      return launchUpdater(root, updateProcess())(executable, args);
    };

    const results = await Promise.allSettled([
      startStudioUpdate({ root, inspect, launch }),
      startStudioUpdate({ root, inspect, launch }),
    ]);

    expect(launchCount).toBe(1);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("starts only one updater when concurrent requests find no prior lock", async () => {
    const { root } = await studioRoot();
    let launchCount = 0;
    const results = await Promise.allSettled([
      startStudioUpdate({
        root,
        inspect: async () => false,
        launch: (executable, args) => {
          launchCount += 1;
          return launchUpdater(root, updateProcess())(executable, args);
        },
      }),
      startStudioUpdate({
        root,
        inspect: async () => false,
        launch: (executable, args) => {
          launchCount += 1;
          return launchUpdater(root, updateProcess())(executable, args);
        },
      }),
    ]);

    expect(launchCount).toBe(1);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("does not let a late old executor callback overwrite a newer task", async () => {
    const { root, installRoot } = await studioRoot();
    const child = updateProcess();
    await startStudioUpdate({ root, launch: launchUpdater(root, child) });
    const nextId = "ce931cdf-1b06-40a2-a356-14c17e08dfb2";
    await Promise.all([
      writeFile(
        path.join(installRoot, "update.lock"),
        JSON.stringify({
          updateId: nextId,
          createdAt: new Date().toISOString(),
        }),
      ),
      writeFile(
        path.join(installRoot, "update-status.json"),
        JSON.stringify({
          status: "starting",
          updateId: nextId,
          message: "new task",
        }),
      ),
    ]);

    child.emit("close", 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      readFile(path.join(installRoot, "update-status.json"), "utf8"),
    ).resolves.toContain(nextId);
    await expect(
      readFile(path.join(installRoot, "update.lock"), "utf8"),
    ).resolves.toContain(nextId);
  });

  it("treats a legacy lock as inactive when no updater process is found", async () => {
    const { root, installRoot } = await studioRoot();
    await writeFile(
      path.join(installRoot, "update.lock"),
      "2020-01-01T00:00:00.000Z",
    );

    const result = await getStudioUpdateStatus(root, {
      inspect: async () => false,
    });

    expect(result.status).toBe("interrupted");
    expect(result.executorAlive).not.toBe(true);
  });

  it("clears only the matching maintenance marker after verified completion", async () => {
    const { root, installRoot } = await studioRoot();
    const updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    const localState = path.join(installRoot, ".local");
    await mkdir(localState, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(installRoot, "update-status.json"),
        JSON.stringify({
          status: "complete",
          updateId,
          targetVersion: "1.11.57",
          actualVersion: "1.11.57",
        }),
      ),
      writeFile(
        path.join(localState, "update-maintenance.json"),
        JSON.stringify({ updateId }),
      ),
    ]);

    await expect(getStudioUpdateStatus(root)).resolves.toMatchObject({
      status: "complete",
      actualVersion: "1.11.57",
    });
    await expect(
      readFile(path.join(localState, "update-maintenance.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records an asynchronous process start failure as a terminal task result", async () => {
    const { root, installRoot } = await studioRoot();
    const child = updateProcess();
    await expect(
      startStudioUpdate({
        root,
        inspect: async () => false,
        launch: () => {
          setTimeout(
            () => child.emit("error", new Error("simulated spawn failure")),
            0,
          );
          return child.process;
        },
      }),
    ).rejects.toThrow(
      "Unable to start the Rust updater: simulated spawn failure",
    );
    await expect
      .poll(async () => {
        const status = JSON.parse(
          await readFile(path.join(installRoot, "update-status.json"), "utf8"),
        ) as { status: string };
        return status.status;
      })
      .toBe("failed");
    await expect(
      readFile(path.join(installRoot, "update.lock"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves the Rust updater's installer failure stage and diagnostics", async () => {
    const { root, installRoot } = await studioRoot();
    const child = updateProcess();
    const installerFailure =
      "Inno Setup exited with code 23. See update-setup.inno.log and install-preflight.log.";
    await expect(
      startStudioUpdate({
        root,
        inspect: async () => false,
        launch: (executable, args) => {
          const updateId = args[args.indexOf("--update-id") + 1];
          writeFileSync(
            path.join(installRoot, "update-status.json"),
            JSON.stringify({
              status: "failed",
              stage: "installing",
              failedStage: "installing",
              updateId,
              message: installerFailure,
              executorConfirmed: true,
              executorPid: child.process.pid,
              executorPath: executable,
            }),
          );
          return child.process;
        },
      }),
    ).rejects.toThrow(installerFailure);

    const saved = JSON.parse(
      await readFile(path.join(installRoot, "update-status.json"), "utf8"),
    ) as {
      status: string;
      stage: string;
      failedStage: string;
      message: string;
    };
    expect(saved).toMatchObject({
      status: "failed",
      stage: "installing",
      failedStage: "installing",
      message: installerFailure,
    });
  });

  it("redacts tokens from diagnostic logs read from an isolated install root", async () => {
    const { root, installRoot } = await studioRoot();
    const updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    await mkdir(path.join(installRoot, "logs"));
    await writeFile(
      path.join(installRoot, "update-status.json"),
      JSON.stringify({
        status: "complete",
        updateId,
        targetVersion: "1.11.57",
        latestVersion: "1.11.57",
        actualVersion: "1.11.57",
      }),
    );
    await writeFile(
      path.join(installRoot, "logs", `update-${updateId}.log`),
      "failed request token: ghp_123456789012345678901234567890123456\n",
    );

    const log = await getStudioUpdateLog(root);
    expect(log).toContain("[redacted]");
    expect(log).not.toContain("ghp_");
  });

  it("advances browser authorization and verifies private release access", async () => {
    const { root, installRoot } = await studioRoot();
    const child = authProcess();
    const launches: { executable: string; args: string[] }[] = [];
    const calls: string[][] = [];
    await startGitHubLogin({
      root,
      checkCredentialStore: async () => undefined,
      launch: (executable, args) => {
        launches.push({ executable, args });
        return child.process;
      },
      run: async (_executable, args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
    });
    expect(launches[0].executable).toBe(path.join(root, "runtime", "gh.exe"));
    expect(launches[0].args).toContain("--clipboard");
    expect(launches[0].args).toContain("--web");
    expect(launches[0].args).not.toContain("--scopes");
    expect(child.input()).toBe("\n\n");

    child.process.stderr.write(
      "First copy your one-time code: ABCD-1234\nPress Enter to open https://github.com/login/device in your browser...",
    );
    await expect
      .poll(() => getGitHubLoginStatus(root))
      .toMatchObject({
        status: "waiting",
        userCode: "ABCD-1234",
        verificationUrl: "https://github.com/login/device",
      });
    child.emit("close", 0);
    await expect
      .poll(() => getGitHubLoginStatus(root))
      .toMatchObject({
        status: "success",
      });
    expect(calls[0]).toEqual([
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--active",
    ]);
    expect(calls[1]).toContain("JayWangsj/ngt1");

    const updateLaunches: { executable: string; args: string[] }[] = [];
    const updateChild = updateProcess();
    await startStudioUpdate({
      root,
      launch: launchUpdater(root, updateChild, updateLaunches),
    });
    expect(updateLaunches[0].executable).toBe(
      path.join(root, "tools", "NGTUpdater.exe"),
    );
    expect(updateLaunches[0].args).toContain("--update-id");
    const status = JSON.parse(
      await readFile(path.join(installRoot, "update-status.json"), "utf8"),
    ) as { status: string };
    expect(status.status).toBe("checking");
    await expect(startStudioUpdate({ root })).rejects.toThrow(
      "studio_update_in_progress",
    );
  });

  it("reports the GitHub CLI reason when authorization fails", async () => {
    const { root } = await studioRoot();
    const child = authProcess();
    await startGitHubLogin({
      root,
      checkCredentialStore: async () => undefined,
      launch: () => child.process,
    });
    child.process.stderr.write("failed to open browser: no default app\n");
    child.emit("close", 1);

    await expect
      .poll(() => getGitHubLoginStatus(root))
      .toMatchObject({
        status: "failed",
        message: "failed to open browser: no default app",
        verificationUrl: "https://github.com/login/device",
      });
  });

  it("does not start browser authorization when credential storage is unavailable", async () => {
    const { root } = await studioRoot();
    let launchCount = 0;

    await expect(
      startGitHubLogin({
        root,
        checkCredentialStore: async () => {
          throw new Error("Windows Credential Manager is unavailable.");
        },
        launch: () => {
          launchCount += 1;
          return authProcess().process;
        },
      }),
    ).rejects.toThrow("Windows Credential Manager is unavailable.");
    expect(launchCount).toBe(0);
  });

  it("accepts an externally managed fine-grained token after verifying release read access", async () => {
    const { root } = await studioRoot();
    const previousToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "test-only-token";
    const calls: string[][] = [];
    try {
      const status = await startGitHubLogin({
        root,
        checkCredentialStore: async () => {
          throw new Error("Should not access the credential store.");
        },
        launch: () => {
          throw new Error("Should not open browser authorization.");
        },
        run: async (_executable, args) => {
          calls.push(args);
          return { stdout: "", stderr: "" };
        },
      });
      expect(status.status).toBe("success");
      expect(calls[0]).toEqual([
        "auth",
        "status",
        "--hostname",
        "github.com",
        "--active",
      ]);
      expect(calls[1]).toContain("JayWangsj/ngt1");
    } finally {
      if (previousToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousToken;
    }
  });

  it("does not report success without private repository access", async () => {
    const { root } = await studioRoot();
    const child = authProcess();
    await startGitHubLogin({
      root,
      checkCredentialStore: async () => undefined,
      launch: () => child.process,
      run: async (_executable, args) => {
        if (args[0] === "release") throw new Error("HTTP 404: Not Found");
        return { stdout: "", stderr: "" };
      },
    });
    child.emit("close", 0);

    await expect
      .poll(() => getGitHubLoginStatus(root))
      .toMatchObject({
        status: "failed",
        message:
          "GitHub authorization completed, but the private repository is not accessible: HTTP 404: Not Found",
      });
  });
});
