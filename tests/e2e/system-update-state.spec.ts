import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const screenshotDirectory = path.join(
  process.cwd(),
  ".local",
  "update-verification",
);

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
});

async function switchToItalian(page: Page) {
  const italianButton = page.getByRole("button", {
    name: "Italiano",
    exact: true,
  });
  if (await italianButton.isVisible()) await italianButton.click();
}

function availableRelease() {
  return {
    installed: true,
    currentVersion: "2.0.9",
    authRequired: false,
    updateAvailable: true,
    latestVersion: "2.0.10",
    releaseName: "NGT 2.0.10",
    releaseNotes: "Aggiornamenti affidabili e correzioni.",
    publishedAt: "2026-10-14T12:00:00Z",
    downloadSize: 240_000_000,
  };
}

async function mockAvailableCheck(page: Page) {
  await page.route("**/api/system-update", (route) =>
    route.fulfill({
      status: route.request().method() === "POST" ? 202 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        route.request().method() === "POST"
          ? {
              started: true,
              status: "starting",
              stage: "starting",
              updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
              targetVersion: "2.0.10",
              currentVersion: "2.0.9",
              createdAt: new Date().toISOString(),
            }
          : availableRelease(),
      ),
    }),
  );
}

async function mockIdleTask(page: Page) {
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "idle", currentVersion: "2.0.9" }),
    }),
  );
}

test("shows concise sidebar update-check statuses in both locales", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ngt-auto-update-check", "false");
  });
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "idle",
        currentVersion: "v2.0.13",
        installInstanceId: "sidebar-summary-test",
      }),
    }),
  );

  const checkResponses = [
    {
      status: 200,
      body: {
        installed: true,
        currentVersion: "2.0.13",
        authRequired: false,
        updateAvailable: false,
        latestVersion: "2.0.13",
        installInstanceId: "sidebar-summary-test",
      },
    },
    { status: 503, body: { error: "check_failed" } },
    {
      status: 200,
      body: {
        installed: true,
        currentVersion: "2.0.13",
        authRequired: false,
        updateAvailable: true,
        latestVersion: "v2.0.14",
        installInstanceId: "sidebar-summary-test",
      },
    },
    { status: 503, body: { error: "check_failed" } },
    {
      status: 200,
      body: {
        installed: true,
        currentVersion: "2.0.13",
        authRequired: false,
        updateAvailable: false,
        notInstallable: true,
        latestVersion: "2.0.14",
        installInstanceId: "sidebar-summary-test",
      },
    },
    {
      status: 200,
      body: {
        installed: true,
        currentVersion: "2.0.13",
        authRequired: true,
        updateAvailable: false,
        installInstanceId: "sidebar-summary-test",
      },
    },
  ];
  let checkRequests = 0;
  let releaseInitialCheck!: () => void;
  const initialCheckBlocked = new Promise<void>((resolve) => {
    releaseInitialCheck = resolve;
  });
  await page.route("**/api/system-update", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const index = checkRequests++;
    if (index === 0) await initialCheckBlocked;
    const response =
      checkResponses[index] || checkResponses[checkResponses.length - 1];
    return route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });

  await page.goto("/settings");
  await page.evaluate(() => {
    document.cookie = "ngt-locale=zh; Path=/; SameSite=Lax";
  });
  await page.reload();
  const summary = page.locator(".sidebar-update-copy small");
  await expect(summary).toHaveText("尚未检查");
  await expect(page.locator(".sidebar-update-copy strong")).toHaveText(
    "v2.0.13",
  );
  await expect(page.locator(".sidebar-update-entry")).toHaveAttribute(
    "aria-label",
    /^v2\.0\.13:/,
  );
  expect(checkRequests).toBe(0);

  await page.locator(".sidebar-update-entry").click();
  await expect(page).toHaveURL(/settings\/system-update/);
  await expect(summary).toHaveText("正在检查…");
  releaseInitialCheck();
  await expect(summary).toHaveText("已是最新");

  const chineseCheckButton = page.getByRole("button", {
    name: "检查更新",
    exact: true,
  });
  await chineseCheckButton.click();
  await expect(summary).toHaveText("检查失败");
  await chineseCheckButton.click();
  await expect(summary).toHaveText("发现 v2.0.14");
  await expect(page.locator(".sidebar-update-dot")).toBeVisible();
  await chineseCheckButton.click();
  await expect(summary).toHaveText("检查失败 · 上次发现 v2.0.14");
  await chineseCheckButton.click();
  await expect(summary).toHaveText("更新不可用");
  await chineseCheckButton.click();
  await expect(summary).toHaveText("需要授权");
});

test("prioritizes active and failed update-task statuses in the sidebar", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ngt-auto-update-check", "false");
  });
  let taskStatus: Record<string, unknown> = {
    status: "idle",
    currentVersion: "2.0.13",
    installInstanceId: "sidebar-task-summary-test",
  };
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(taskStatus),
    }),
  );
  const checkResponses = [
    {
      status: 200,
      body: {
        installed: true,
        currentVersion: "2.0.13",
        authRequired: false,
        updateAvailable: true,
        latestVersion: "2.0.14",
        installInstanceId: "sidebar-task-summary-test",
      },
    },
    { status: 503, body: { error: "check_failed" } },
    {
      status: 200,
      body: {
        installed: true,
        currentVersion: "2.0.13",
        authRequired: false,
        updateAvailable: false,
        latestVersion: "2.0.13",
        installInstanceId: "sidebar-task-summary-test",
      },
    },
    { status: 503, body: { error: "check_failed" } },
  ];
  let checkRequests = 0;
  await page.route("**/api/system-update", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = checkResponses[checkRequests++];
    return route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });

  await page.goto("/settings");
  await switchToItalian(page);
  const summary = page.locator(".sidebar-update-copy small");
  await expect(summary).toHaveText("Non ancora controllato");

  await page.locator(".sidebar-update-entry").click();
  await expect(summary).toHaveText("Nuova versione v2.0.14");
  const italianCheckButton = page.getByRole("button", {
    name: "Controlla aggiornamenti",
    exact: true,
  });
  await italianCheckButton.click();
  await expect(summary).toHaveText(
    "Controllo non riuscito · già disponibile v2.0.14",
  );
  await italianCheckButton.click();
  await expect(summary).toHaveText("Aggiornato");
  await italianCheckButton.click();
  await expect(summary).toHaveText("Controllo non riuscito");
  await page.goto("/settings");

  taskStatus = {
    status: "running",
    stage: "checking",
    executorAlive: true,
    currentVersion: "2.0.13",
  };
  await page.reload();
  await expect(summary).toHaveText("Controllo in corso…");

  taskStatus = {
    status: "running",
    stage: "installing",
    executorAlive: true,
    currentVersion: "2.0.13",
  };
  await page.reload();
  await expect(summary).toHaveText("Aggiornamento in corso…");

  taskStatus = {
    status: "failed",
    currentVersion: "2.0.13",
  };
  await page.reload();
  await expect(summary).toHaveText("Aggiornamento non riuscito");

  taskStatus = {
    status: "failed",
    recoveryStatus: "succeeded",
    currentVersion: "2.0.13",
  };
  await page.reload();
  await expect(summary).toHaveText(
    "Aggiornamento non riuscito · versione ripristinata",
  );

  taskStatus = {
    status: "interrupted",
    currentVersion: "2.0.13",
  };
  await page.reload();
  await expect(summary).toHaveText("Aggiornamento interrotto");
});

test("ignores a stale active status when already current", async ({ page }) => {
  await page.route("**/api/system-update", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        currentVersion: "2.0.9",
        authRequired: false,
        updateAvailable: false,
        latestVersion: "2.0.9",
        status: { status: "checking", stage: "checking" },
      }),
    }),
  );
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "idle" }),
    }),
  );

  await page.goto("/settings/system-update");
  await switchToItalian(page);
  await expect(
    page.getByRole("button", { name: "Controlla aggiornamenti", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".update-progress-card")).toHaveCount(0);
});

test("stops monitoring when the updater becomes idle", async ({ page }) => {
  await page.route("**/api/system-update", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        currentVersion: "2.0.8",
        authRequired: false,
        updateAvailable: true,
        latestVersion: "2.0.9",
        status: {
          status: "checking",
          stage: "checking",
          latestVersion: "v2.0.9",
        },
      }),
    }),
  );
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "idle" }),
    }),
  );

  await page.goto("/settings/system-update");
  await switchToItalian(page);
  await expect(
    page.getByRole("button", { name: "Controlla aggiornamenti", exact: true }),
  ).toBeEnabled({ timeout: 5_000 });
  await expect(page.locator(".update-progress-card")).toHaveCount(0);
});

test("captures the checking state without a phantom install card", async ({
  page,
}) => {
  let releaseCheck!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseCheck = resolve;
  });
  await page.route("**/api/system-update", async (route) => {
    await blocked;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        currentVersion: "2.0.9",
        authRequired: false,
        updateAvailable: false,
        latestVersion: "2.0.9",
      }),
    });
  });
  await mockIdleTask(page);

  await page.goto("/settings/system-update");
  await expect(
    page.getByRole("button", { name: "Controllo…", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".update-progress-card")).toHaveCount(0);
  await expect(
    page.getByText("Il sistema è aggiornato.", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: path.join(screenshotDirectory, "03-checking-no-progress.png"),
    animations: "disabled",
  });
  releaseCheck();
  await expect(
    page.getByText("Il sistema è aggiornato.", { exact: true }),
  ).toBeVisible();
});

test("captures an available release in the expanded sidebar without progress", async ({
  page,
}) => {
  await mockAvailableCheck(page);
  await mockIdleTask(page);
  await page.goto("/settings");
  await switchToItalian(page);

  await expect(page.locator(".update-notification")).toContainText("2.0.10");
  await expect(page.locator(".sidebar-update-dot")).toBeVisible();
  await page.screenshot({
    path: path.join(screenshotDirectory, "01-expanded-sidebar-new-version.png"),
    animations: "disabled",
  });
  const laterButton = page.locator(".update-notification-later");
  await expect(laterButton).toHaveText("Più tardi");
  await laterButton.click();
  await expect(page.locator(".update-notification")).toHaveCount(0);
  await expect(page.locator(".sidebar-update-dot")).toBeVisible();
  await page.locator(".sidebar-update-entry").click();
  await expect(page).toHaveURL(/settings\/system-update/);
  await expect(page.locator(".update-release-card")).toContainText("2.0.10");
  await expect(page.locator(".update-progress-card")).toHaveCount(0);
  await page.screenshot({
    path: path.join(screenshotDirectory, "04-available-not-started.png"),
    animations: "disabled",
  });
});

test("shows a newer but incomplete release without offering installation", async ({
  page,
}) => {
  await page.route("**/api/system-update", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        currentVersion: "2.0.9",
        authRequired: false,
        updateAvailable: false,
        notInstallable: true,
        latestVersion: "2.0.10",
        releaseNotes: "Pacchetto non ancora completo.",
      }),
    }),
  );
  await mockIdleTask(page);
  await page.goto("/settings/system-update");
  await switchToItalian(page);

  await expect(page.locator(".update-version-block")).toContainText("2.0.10");
  await expect(page.locator(".update-release-card")).toContainText("2.0.10");
  await expect(page.locator(".update-release-card")).toContainText(
    "Pacchetto non ancora completo.",
  );
  await expect(
    page.locator(".update-release-card").getByRole("button"),
  ).toHaveCount(0);
});

test("localizes the manual-review guidance for an interrupted update", async ({
  page,
}) => {
  await mockAvailableCheck(page);
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "verifying-task",
        currentVersion: "2.0.9",
        manualReview: true,
        message: "The update lock and saved task do not match.",
      }),
    }),
  );

  await page.goto("/settings/system-update");
  await switchToItalian(page);
  await expect(page.locator(".update-task-compact")).toContainText(
    "Il ripristino dell'ultimo aggiornamento non è verificabile",
  );

  await page.evaluate(() => {
    document.cookie = "ngt-locale=zh; Path=/; SameSite=Lax";
  });
  await page.reload();
  await expect(page.locator(".update-task-compact")).toContainText(
    "上次更新的恢复状态无法确认，已阻止再次更新。",
  );
});

test("keeps queued task stages separate from the installed version", async ({
  page,
}) => {
  await page.route("**/api/system-update", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        currentVersion: "2.0.15",
        authRequired: false,
        updateAvailable: false,
        latestVersion: "2.0.15",
      }),
    }),
  );
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "interrupted",
        stage: "queued",
        previousStatus: "queued",
        currentVersion: "2.0.15",
        manualReview: true,
      }),
    }),
  );

  await page.goto("/settings/system-update");
  await page.evaluate(() => {
    document.cookie = "ngt-locale=zh; Path=/; SameSite=Lax";
  });
  await page.reload();
  const version = page.locator(".update-version-block strong");
  await expect(version).toHaveText("v2.0.15");
  await expect(page.locator(".update-task-compact")).toContainText(
    "上次更新的恢复状态无法确认",
  );
  await expect(page.locator(".update-task-compact")).not.toContainText(
    "当前版本: queued",
  );
});

test("shows a superseded task as informational and keeps its diagnostics", async ({
  page,
}) => {
  await page.route("**/api/system-update", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        currentVersion: "2.0.15",
        authRequired: false,
        updateAvailable: false,
        latestVersion: "2.0.15",
      }),
    }),
  );
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "superseded",
        currentVersion: "2.0.15",
        actualVersion: "2.0.15",
        previousStatus: "queued",
        previousUpdateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
      }),
    }),
  );
  await page.route("**/api/system-update/status/log", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ log: "Previous queued update diagnostic." }),
    }),
  );

  await page.goto("/settings/system-update");
  await page.evaluate(() => {
    document.cookie = "ngt-locale=zh; Path=/; SameSite=Lax";
  });
  await page.reload();
  const notice = page.locator(".update-task-compact");
  await expect(notice).toContainText("历史更新任务已由经过验证的安装替代");
  await expect(notice).toHaveAttribute("role", "status");
  await expect(page.locator('.system-update-page [role="alert"]')).toHaveCount(
    0,
  );
  await notice.getByRole("button", { name: "诊断详情" }).click();
  await expect(notice).toContainText("Previous queued update diagnostic.");

  await page.evaluate(() => {
    document.cookie = "ngt-locale=it; Path=/; SameSite=Lax";
  });
  await page.reload();
  await expect(notice).toContainText("La vecchia attività è stata sostituita");
});

test("keeps the version link and red dot usable when the sidebar is collapsed", async ({
  page,
}) => {
  await mockAvailableCheck(page);
  await mockIdleTask(page);
  await page.goto("/settings");
  await switchToItalian(page);
  await expect(page.locator(".sidebar-update-dot")).toBeVisible();
  await page.locator(".sidebar-toggle").click();
  await expect(page.locator(".sidebar-update-copy")).toBeHidden();
  await expect(page.locator(".sidebar-update-entry")).toHaveAttribute(
    "aria-label",
    /2\.0\.9/,
  );
  await page.screenshot({
    path: path.join(screenshotDirectory, "02-collapsed-sidebar-red-dot.png"),
    animations: "disabled",
  });
  await page.locator(".sidebar-update-entry").click();
  await expect(page).toHaveURL(/settings\/system-update/);
});

test("shows progress only after the executor reports a real stage", async ({
  page,
}) => {
  await mockAvailableCheck(page);
  let started = false;
  let polls = 0;
  await page.route("**/api/system-update/status", (route) => {
    if (!started)
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "idle", currentVersion: "2.0.9" }),
      });
    polls += 1;
    const status =
      polls === 1
        ? {
            status: "starting",
            stage: "starting",
            updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
            targetVersion: "2.0.10",
            executorAlive: true,
          }
        : {
            status: "running",
            stage: "downloading",
            updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
            targetVersion: "2.0.10",
            executorAlive: true,
            executorConfirmed: true,
            completedStages: ["reading-release"],
            bytesDownloaded: 120_000_000,
            totalBytes: 240_000_000,
            progressKnown: true,
          };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(status),
    });
  });
  await page.route("**/api/system-update", async (route) => {
    if (route.request().method() === "POST") {
      started = true;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          started: true,
          status: "starting",
          stage: "starting",
          updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
          targetVersion: "2.0.10",
          currentVersion: "2.0.9",
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(availableRelease()),
    });
  });

  await page.goto("/settings/system-update");
  await switchToItalian(page);
  const releaseCard = page.locator(".update-release-card");
  await releaseCard.getByRole("button", { name: "Aggiorna ora" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Aggiorna ora" })
    .click();
  await expect(page.locator(".update-task-compact")).toContainText(
    "Avvio dell'attività di aggiornamento",
  );
  await expect(page.locator(".update-progress-card")).toHaveCount(0);
  await expect(page.locator(".update-progress-track")).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.locator(".update-progress-track")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await page.screenshot({
    path: path.join(screenshotDirectory, "05-confirmed-download-progress.png"),
    animations: "disabled",
  });
});

test("shows rollback as a result instead of a normal upgrade step", async ({
  page,
}) => {
  await mockAvailableCheck(page);
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "failed",
        stage: "validating",
        failedStage: "validating",
        updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
        targetVersion: "2.0.10",
        previousVersion: "2.0.9",
        currentVersion: "2.0.9",
        actualVersion: "2.0.9",
        executorConfirmed: true,
        recoveryStatus: "succeeded",
        completedStages: [
          "reading-release",
          "downloading",
          "verifying",
          "backing-up",
          "installing",
        ],
        message: "The new release failed its health check.",
        recoveryMessage: "The previous version was restored and verified.",
      }),
    }),
  );
  await page.route("**/api/system-update/status/log", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ log: "Health check failed; rollback verified." }),
    }),
  );

  await page.goto("/settings/system-update");
  await switchToItalian(page);
  await expect(page.locator(".update-result-card")).toContainText(
    "Aggiornamento non riuscito; la versione precedente è stata ripristinata e verificata.",
  );
  await expect(page.locator(".update-stage-list li")).toHaveCount(0);
  await page.locator(".update-diagnostics-toggle").click();
  await expect(
    page
      .locator(".update-stage-list li")
      .filter({ hasText: "Avvio e verifica database" }),
  ).toHaveClass(/failed/);
  await expect(page.locator(".update-diagnostics")).toContainText(
    "The new release failed its health check.",
  );
  await expect(page.locator(".update-diagnostics")).toContainText(
    "Health check failed; rollback verified.",
  );
  await page.screenshot({
    path: path.join(screenshotDirectory, "06-failed-restored-result.png"),
    animations: "disabled",
  });
});

test("retries the first status read automatically and keeps the update page as a manual check entry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ngt-auto-update-check", "false");
  });
  let statusReads = 0;
  let updateChecks = 0;
  await page.route("**/api/system-update/status", (route) => {
    statusReads += 1;
    return route.fulfill({
      status: statusReads === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        statusReads === 1
          ? { status: "verifying-task", message: "temporary failure" }
          : {
              status: "idle",
              currentVersion: "2.0.9",
              installInstanceId: "test-install-a",
            },
      ),
    });
  });
  await page.route("**/api/system-update", (route) => {
    updateChecks += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...availableRelease(),
        updateAvailable: false,
        latestVersion: "2.0.9",
        installInstanceId: "test-install-a",
        status: { status: "idle", currentVersion: "2.0.9" },
      }),
    });
  });

  await page.goto("/settings");
  await expect.poll(() => statusReads).toBeGreaterThan(1);
  expect(updateChecks).toBe(0);

  await page.goto("/settings/system-update");
  await expect(
    page.getByRole("button", { name: "Controlla aggiornamenti", exact: true }),
  ).toBeEnabled();
  expect(updateChecks).toBe(1);
  await page
    .getByRole("button", { name: "Controlla aggiornamenti", exact: true })
    .click();
  await expect.poll(() => updateChecks).toBe(2);
});

test("reuses a recent install-scoped update result after a page reload", async ({
  page,
}) => {
  let updateChecks = 0;
  await page.route("**/api/system-update/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "idle",
        currentVersion: "2.0.9",
        installInstanceId: "test-install-cache",
      }),
    }),
  );
  await page.route("**/api/system-update", (route) => {
    updateChecks += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...availableRelease(),
        updateAvailable: false,
        latestVersion: "2.0.9",
        installInstanceId: "test-install-cache",
        status: { status: "idle", currentVersion: "2.0.9" },
      }),
    });
  });

  await page.goto("/settings/system-update");
  await expect(
    page.getByText("Il sistema è aggiornato.", { exact: true }),
  ).toBeVisible();
  expect(updateChecks).toBe(1);
  await page.reload();
  await expect(
    page.getByText("Il sistema è aggiornato.", { exact: true }),
  ).toBeVisible();
  expect(updateChecks).toBe(1);
});

test("continues monitoring an active update beyond the previous four-minute limit", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-15T12:00:00.000Z") });
  let started = false;
  let statusReads = 0;
  let completedStatusReads = 0;
  const monitoringRequestTimes: number[] = [];
  await page.route("**/api/system-update/status", async (route) => {
    statusReads += 1;
    if (started) {
      monitoringRequestTimes.push(await page.evaluate(() => Date.now()));
    }
    const status = started
      ? {
          status: "running",
          stage: "installing",
          updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
          targetVersion: "2.0.10",
          currentVersion: "2.0.9",
          executorAlive: true,
          executorConfirmed: true,
          updatedAt: "2026-10-15T12:00:00.000Z",
        }
      : { status: "idle", currentVersion: "2.0.9" };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(status),
    });
    completedStatusReads += 1;
  });
  await page.route("**/api/system-update", (route) => {
    if (route.request().method() === "POST") {
      started = true;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          status: "starting",
          stage: "starting",
          updateId: "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16",
          targetVersion: "2.0.10",
          currentVersion: "2.0.9",
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(availableRelease()),
    });
  });

  await page.goto("/settings/system-update");
  await expect.poll(() => completedStatusReads).toBeGreaterThan(0);
  const updateStartedAt = await page.evaluate(() => Date.now());
  const updateStartResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/system-update") &&
      response.request().method() === "POST",
  );
  await page
    .locator(".update-release-card")
    .getByRole("button", { name: "Aggiorna ora" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Aggiorna ora" })
    .click();
  expect((await updateStartResponse).status()).toBe(202);
  expect(started).toBe(true);
  await page.clock.runFor(1_000);
  await expect.poll(() => monitoringRequestTimes.length).toBeGreaterThan(0);
  await page.clock.runFor(5 * 60_000);
  await expect.poll(() => completedStatusReads).toBe(statusReads);
  expect(monitoringRequestTimes.length).toBeGreaterThan(0);
  expect(
    monitoringRequestTimes[monitoringRequestTimes.length - 1],
  ).toBeGreaterThan(updateStartedAt + 4 * 60_000);
  await expect(page.locator(".update-progress-card")).toContainText(
    "Installazione",
  );
});

test("sidebar version entry hover stays contained and collapses cleanly", async ({
  page,
}) => {
  await mockAvailableCheck(page);
  await mockIdleTask(page);
  await page.goto("/settings");
  await expect
    .poll(() =>
      page
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(255, 255, 255)");
  await switchToItalian(page);

  const entry = page.locator(".sidebar-update-entry");
  const icon = entry.locator(".sidebar-update-icon svg");
  const version = entry.locator(".sidebar-update-copy strong");
  const summary = entry.locator(".sidebar-update-copy small");
  const arrow = entry.locator(".sidebar-update-arrow");
  await expect(icon).toHaveClass(/lucide-refresh-cw/);
  await expect(icon).toHaveAttribute("width", "19");
  await expect(arrow).toBeVisible();
  const initialBackground = await entry.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  const initialIconColor = await icon.evaluate(
    (node) => getComputedStyle(node).color,
  );

  const initialGeometry = await Promise.all(
    [icon, version, summary].map((node) => node.boundingBox()),
  );
  await version.hover();
  await expect
    .poll(() =>
      arrow.evaluate(
        (node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41,
      ),
    )
    .toBeCloseTo(3, 0);
  await expect
    .poll(() =>
      entry.evaluate((node) => getComputedStyle(node).backgroundColor),
    )
    .not.toBe(initialBackground);
  await expect
    .poll(() => icon.evaluate((node) => getComputedStyle(node).color))
    .not.toBe(initialIconColor);
  expect(
    await version.evaluate((node) => getComputedStyle(node).overflow),
  ).toBe("visible");
  expect(
    await entry.evaluate((node) => {
      const style = getComputedStyle(node);
      return [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ];
    }),
  ).toEqual(["8px", "8px", "8px", "8px"]);
  const underlineGeometry = await version.evaluate((node) => {
    const style = getComputedStyle(node, "::after");
    return {
      opacity: Number.parseFloat(style.opacity),
      scaleX: new DOMMatrixReadOnly(style.transform).m11,
      underlineWidth: Number.parseFloat(style.width),
      textWidth: node.getBoundingClientRect().width,
      bottom: style.bottom,
    };
  });
  expect(underlineGeometry.opacity).toBeGreaterThan(0.9);
  expect(underlineGeometry.scaleX).toBeGreaterThan(0.9);
  expect(underlineGeometry.bottom).toBe("2px");
  expect(
    Math.abs(underlineGeometry.underlineWidth - underlineGeometry.textWidth),
  ).toBeLessThanOrEqual(1);
  await expect
    .poll(async () => {
      const currentGeometry = await Promise.all(
        [icon, version, summary].map((node) => node.boundingBox()),
      );
      return currentGeometry.every((box, index) => {
        const initial = initialGeometry[index];
        return Boolean(
          box &&
          initial &&
          Math.abs(box.x - initial.x) <= 1 &&
          Math.abs(box.y - initial.y) <= 1 &&
          Math.abs(box.width - initial.width) <= 1 &&
          Math.abs(box.height - initial.height) <= 1,
        );
      });
    })
    .toBe(true);
  await entry.screenshot({
    path: path.join(screenshotDirectory, "07-sidebar-update-entry-hover.png"),
  });

  await page.mouse.move(0, 0);
  await expect
    .poll(() => entry.evaluate((node) => node.matches(":hover")))
    .toBe(false);
  await expect
    .poll(() =>
      entry.evaluate((node) => getComputedStyle(node).backgroundColor),
    )
    .toBe(initialBackground);
  await expect
    .poll(() => icon.evaluate((node) => getComputedStyle(node).color))
    .toBe(initialIconColor);
  await expect
    .poll(() =>
      arrow.evaluate(
        (node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41,
      ),
    )
    .toBeCloseTo(0, 0);
  await expect
    .poll(() =>
      version.evaluate(
        (node) =>
          new DOMMatrixReadOnly(getComputedStyle(node, "::after").transform)
            .m11,
      ),
    )
    .toBeCloseTo(0, 0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await entry.hover();
  await expect
    .poll(() =>
      arrow.evaluate((node) => {
        const transform = getComputedStyle(node).transform;
        return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
      }),
    )
    .toBeCloseTo(0, 0);
  await expect
    .poll(() =>
      version.evaluate(
        (node) =>
          new DOMMatrixReadOnly(getComputedStyle(node, "::after").transform)
            .m11,
      ),
    )
    .toBeGreaterThan(0.9);
  await page.mouse.move(0, 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.keyboard.press("Tab");
  await entry.focus();
  await expect
    .poll(() => entry.evaluate((node) => node.matches(":focus-visible")))
    .toBe(true);
  await expect
    .poll(() =>
      version.evaluate(
        (node) =>
          new DOMMatrixReadOnly(getComputedStyle(node, "::after").transform)
            .m11,
      ),
    )
    .toBeGreaterThan(0.9);

  await page.getByRole("button", { name: "Riduci barra laterale" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-sidebar-collapsed",
    "true",
  );
  await expect(icon).toBeVisible();
  await expect(version).toBeHidden();
  await expect(arrow).toBeHidden();
  const collapsedBackground = await entry.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  const collapsedSpacing = await entry.evaluate((node) => {
    const entryBounds = node.getBoundingClientRect();
    const iconBounds = node
      .querySelector(".sidebar-update-icon")!
      .getBoundingClientRect();
    return {
      iconCenterOffset: Math.abs(
        iconBounds.top +
          iconBounds.height / 2 -
          (entryBounds.top + entryBounds.height / 2),
      ),
    };
  });
  expect(collapsedSpacing.iconCenterOffset).toBeLessThanOrEqual(1);
  expect(
    await page
      .locator(".sidebar")
      .evaluate((node) => node.scrollWidth - node.clientWidth),
  ).toBeLessThanOrEqual(1);
  await entry.hover();
  await expect
    .poll(() =>
      entry.evaluate((node) => getComputedStyle(node).backgroundColor),
    )
    .not.toBe(collapsedBackground);
  await entry.screenshot({
    path: path.join(
      screenshotDirectory,
      "08-sidebar-update-entry-collapsed.png",
    ),
  });
});
