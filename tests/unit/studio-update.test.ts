import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
  startStudioUpdate,
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
      unref() {},
      once: events.once.bind(events),
    } as unknown as ChildProcess,
    emit: events.emit.bind(events),
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
    mkdir(installRoot, { recursive: true }),
  ]);
  await mkdir(path.join(installRoot, ".local"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(root, "studio-release.json"),
      JSON.stringify({ version: "1.11.57" }),
    ),
    writeFile(path.join(root, "runtime", "gh.exe"), "test"),
    writeFile(path.join(root, "scripts", "update-windows-studio.ps1"), ""),
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
      downloadSize: 240_000_000,
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
        launch: () => child.process,
      }),
    ).resolves.toMatchObject({ status: "starting" });
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
          executorScriptPath: path.join(
            root,
            "scripts",
            "update-windows-studio.ps1",
          ),
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

    let inspectionCount = 0;
    let releaseFirstInspection!: () => void;
    const firstInspection = new Promise<void>((resolve) => {
      releaseFirstInspection = resolve;
    });
    let launchCount = 0;
    const inspect = async () => {
      inspectionCount += 1;
      if (inspectionCount <= 2) return false;
      if (inspectionCount === 3) await firstInspection;
      return false;
    };
    const launch = () => {
      launchCount += 1;
      if (launchCount === 1) releaseFirstInspection();
      return updateProcess().process;
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
        launch: () => {
          launchCount += 1;
          return updateProcess().process;
        },
      }),
      startStudioUpdate({
        root,
        inspect: async () => false,
        launch: () => {
          launchCount += 1;
          return updateProcess().process;
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
    await startStudioUpdate({ root, launch: () => child.process });
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
    await startStudioUpdate({ root, launch: () => child.process });
    child.emit("error", new Error("simulated spawn failure"));

    await expect
      .poll(
        async () => {
          const status = JSON.parse(
            await readFile(
              path.join(installRoot, "update-status.json"),
              "utf8",
            ),
          ) as { status: string; message?: string };
          return status;
        },
        { timeout: 5_000 },
      )
      .toMatchObject({
        status: "failed",
        message: "Unable to start the update executor: simulated spawn failure",
      });
    await expect(
      readFile(path.join(installRoot, "update.lock"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const launchLog = await readFile(
      path.join(
        installRoot,
        "logs",
        `update-launch-${
          JSON.parse(
            await readFile(
              path.join(installRoot, "update-status.json"),
              "utf8",
            ),
          ).updateId
        }.jsonl`,
      ),
      "utf8",
    );
    expect(launchLog).toContain('"event":"process-error"');
    expect(launchLog).toContain('"error":"simulated spawn failure"');
  });

  it("fails when PowerShell exits with code zero before confirming script startup", async () => {
    const { root, installRoot } = await studioRoot();
    const child = updateProcess();
    const initial = await startStudioUpdate({
      root,
      launch: () => child.process,
    });
    child.emit("spawn");
    child.emit("close", 0, null);

    await expect
      .poll(async () => {
        const status = JSON.parse(
          await readFile(path.join(installRoot, "update-status.json"), "utf8"),
        );
        return status;
      })
      .toMatchObject({
        status: "failed",
        stage: "starting",
        failedStage: "starting",
        executorConfirmed: false,
        message:
          "The PowerShell executor exited before confirming script startup (code 0).",
      });
    const log = await getStudioUpdateLog(root);
    expect(initial.logAvailable).toBe(true);
    expect(log).toContain('"event":"process-created"');
    expect(log).toContain('"event":"process-exited"');
    expect(log).toContain('"event":"failure-status-persisted"');
    await expect(
      readFile(path.join(installRoot, "update.lock"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a confirmed executor that exits with code zero without terminal status", async () => {
    const { root, installRoot } = await studioRoot();
    const child = updateProcess();
    await startStudioUpdate({ root, launch: () => child.process });
    const statusPath = path.join(installRoot, "update-status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    await writeFile(
      statusPath,
      JSON.stringify({
        ...status,
        status: "running",
        stage: "reading-release",
        executorConfirmed: true,
      }),
    );

    child.emit("close", 0, null);
    await expect
      .poll(async () => JSON.parse(await readFile(statusPath, "utf8")))
      .toMatchObject({
        status: "failed",
        stage: "reading-release",
        failedStage: "reading-release",
        executorConfirmed: true,
        message:
          "The update executor exited without recording a final result (code 0).",
      });
  });

  it("records a starting-status write failure and does not launch PowerShell", async () => {
    const { root, installRoot } = await studioRoot();
    const statusPath = path.join(installRoot, "update-status.json");
    await writeFile(statusPath, JSON.stringify({ status: "idle" }));
    await chmod(statusPath, 0o444);
    let launchCount = 0;
    try {
      await expect(
        startStudioUpdate({
          root,
          launch: () => {
            launchCount += 1;
            return updateProcess().process;
          },
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(statusPath, 0o666);
    }

    expect(launchCount).toBe(0);
    await expect(
      readFile(path.join(installRoot, "update.lock"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const logNames = await readdir(path.join(installRoot, "logs"));
    const launchLogName = logNames.find((name) =>
      name.startsWith("update-launch-"),
    );
    expect(launchLogName).toBeDefined();
    const launchLog = await readFile(
      path.join(installRoot, "logs", launchLogName!),
      "utf8",
    );
    expect(launchLog).toContain('"event":"request-accepted"');
    expect(launchLog).toContain('"event":"process-launch-failed"');
  });

  it("keeps startup diagnostics readable after the API process restarts", async () => {
    const { root, installRoot } = await studioRoot();
    await startStudioUpdate({ root, launch: () => updateProcess().process });
    const statusPath = path.join(installRoot, "update-status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    await writeFile(
      statusPath,
      JSON.stringify({
        ...status,
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    await expect(
      getStudioUpdateStatus(root, { inspect: async () => false }),
    ).resolves.toMatchObject({ status: "interrupted" });
    const log = await getStudioUpdateLog(root);
    expect(log).toContain('"event":"request-accepted"');
    expect(log).toContain("Node launcher");
  });

  it("rejects a status and lock that identify different update tasks", async () => {
    const { root, installRoot } = await studioRoot();
    const oldId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
    await Promise.all([
      writeFile(
        path.join(installRoot, "update-status.json"),
        JSON.stringify({ status: "starting", updateId: oldId }),
      ),
      writeFile(
        path.join(installRoot, "update.lock"),
        JSON.stringify({
          updateId: "ce931cdf-1b06-40a2-a356-14c17e08dfb2",
          createdAt: new Date().toISOString(),
        }),
      ),
    ]);

    await expect(getStudioUpdateStatus(root)).resolves.toMatchObject({
      status: "verifying-task",
      manualReview: true,
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
    await writeFile(
      path.join(installRoot, "logs", `update-launch-${updateId}.jsonl`),
      'postgresql://ngt:secret@localhost/ngt token=ghp_123456789012345678901234567890123456 Authorization: Bearer private-auth-secret {"password":"private phrase","api_key":"private-key"}\n',
    );

    const log = await getStudioUpdateLog(root);
    expect(log).toContain("[redacted]");
    expect(log).toContain("[redacted connection string]");
    expect(log).not.toContain("ghp_");
    expect(log).not.toContain("postgresql://ngt:secret");
    expect(log).not.toContain("private-auth-secret");
    expect(log).not.toContain("private phrase");
    expect(log).not.toContain("private-key");
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
      launch: (executable, args) => {
        updateLaunches.push({ executable, args });
        return updateChild.process;
      },
    });
    expect(updateLaunches[0].executable).toBe("powershell.exe");
    expect(
      updateLaunches[0].args.some((argument) =>
        argument.endsWith("update-windows-studio.ps1"),
      ),
    ).toBe(true);
    const status = JSON.parse(
      await readFile(path.join(installRoot, "update-status.json"), "utf8"),
    ) as { status: string };
    expect(status.status).toBe("starting");
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
