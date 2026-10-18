import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import sharp from "sharp";

test.beforeAll(async () => {
  await mkdir(".local/date-picker-evidence", { recursive: true });
});

async function expectNoBlueSelection(
  picker: import("@playwright/test").Locator,
) {
  const { data, info } = await sharp(await picker.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let longestBlueRun = 0;
  for (let row = 0; row < info.height; row++) {
    let run = 0;
    for (let column = 0; column < info.width; column++) {
      const index = (row * info.width + column) * info.channels;
      const [red, green, blue] = data.subarray(index, index + info.channels);
      run = blue > 150 && blue > red * 1.3 && blue > green * 1.15 ? run + 1 : 0;
      longestBlueRun = Math.max(longestBlueRun, run);
    }
  }
  expect(longestBlueRun).toBeLessThan(10);
}

test("shared picker jumps directly to years and months without early filtering", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/orders?month=2026-10");

  const monthInput = page.locator('.order-month-filter input[type="month"]');
  const monthValueLabel = page.locator(
    ".order-month-filter .date-picker-month-value",
  );
  await expect(monthValueLabel).toHaveText("ottobre 2026");
  await expect(monthValueLabel).toBeVisible();
  const originalMonth = await monthInput.inputValue();
  await monthInput.click();
  await expect(monthValueLabel).toBeVisible();
  await expect(monthInput).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  await expect(monthInput).not.toBeFocused();
  await page.locator(".order-month-filter .date-picker").screenshot({
    path: ".local/date-picker-evidence/month-value-italian.png",
  });
  const picker = page.locator(".date-picker-popover");
  const yearButton = picker.getByRole("button", {
    name: "Scegli anno",
    exact: true,
  });
  await yearButton.hover();
  await expect(yearButton).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
  await expect(yearButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(
    picker.locator(".date-picker-months [role=gridcell]"),
  ).toHaveCount(12);
  const clearButton = picker.locator(".date-picker-clear");
  await clearButton.hover();
  await expect(clearButton).toHaveCSS("color", "rgb(163, 56, 42)");
  await expect(clearButton).toHaveCSS("background-color", "rgb(255, 240, 238)");
  await picker
    .getByRole("button", { name: "Scegli anno", exact: true })
    .click();
  await expect(
    picker.locator(".date-picker-years [role=gridcell]"),
  ).toHaveCount(12);
  await picker.screenshot({
    path: ".local/date-picker-evidence/year-panel.png",
  });
  await picker.locator(".date-picker-year-input").fill("2020");
  await expect(
    picker.locator(".date-picker-months [role=gridcell]"),
  ).toHaveCount(12);
  await expect(monthInput).toHaveValue(originalMonth);
  await expect(page).toHaveURL(/month=2026-10/);
  await picker.screenshot({
    path: ".local/date-picker-evidence/month-panel.png",
  });
  await picker.locator('[data-month="2020-05"]').click();
  await expect(monthInput).toHaveValue("2020-05");
  await expect(page).toHaveURL(/month=2020-05/);
  await expect(monthInput).not.toBeFocused();
  await page.locator(".order-month-filter .date-picker").screenshot({
    path: ".local/date-picker-evidence/month-after-selection.png",
  });
  await expectNoBlueSelection(page.locator(".order-month-filter .date-picker"));

  await page.goto("/");
  const dayInput = page.locator('.dashboard-date-filter input[type="date"]');
  const originalDay = await dayInput.inputValue();
  await page.locator(".dashboard-date-filter .date-picker-toggle").click();
  const dayPicker = page.locator(".date-picker-popover");
  await dayPicker
    .getByRole("button", { name: "Scegli anno", exact: true })
    .click();
  await dayPicker.locator(".date-picker-year-input").fill("2020");
  await dayPicker
    .getByRole("button", { name: "Scegli mese", exact: true })
    .click();
  await dayPicker.locator('[data-month="2020-04"]').click();
  await expect(
    dayPicker.locator(".date-picker-days [role=gridcell]"),
  ).toHaveCount(42);
  await expect(dayInput).toHaveValue(originalDay);
  await expect(page).toHaveURL(/\/$/);
  await dayPicker.locator('[data-date="2020-04-15"]').click();
  await expect(page).toHaveURL(/day=2020-04-15/);

  await dayInput.click();
  await expect(dayInput).not.toBeFocused();
  await expect(page.locator(".date-picker-popover")).toBeVisible();
});

for (const locale of ["it", "zh"] as const) {
  test(`inventory history month picker has no native selection in ${locale}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .context()
      .addCookies([{ name: "ngt-locale", value: locale, url: page.url() }]);
    await page.goto("/inventory");
    await page.locator(".inventory-history-card").click();
    const dialog = page.getByRole("dialog");
    const monthInput = dialog.locator('input[type="month"]');
    await expect(monthInput).toBeVisible();
    const monthLabel = dialog.locator(".date-picker-month-value");
    await expect(monthLabel).toBeVisible();
    await expect(monthLabel).toContainText(locale === "zh" ? "年" : " ");
    await monthInput.click();
    await expect(monthInput).toHaveCSS("color", "rgba(0, 0, 0, 0)");
    await expect(monthInput).not.toBeFocused();
    await expect(dialog.locator(".date-picker-popover")).toBeVisible();
    await dialog.locator(".retail-period-picker").screenshot({
      path: ".local/date-picker-evidence/inventory-month-value.png",
    });
    await dialog
      .locator(`[data-month="${await monthInput.inputValue()}"]`)
      .click();
    await expect(dialog.locator(".date-picker-toggle")).toBeFocused();
    await expectNoBlueSelection(dialog.locator(".retail-period-picker"));
    await dialog.locator(".retail-period-picker").screenshot({
      path: `.local/date-picker-evidence/inventory-month-after-selection-${locale}.png`,
    });
  });
}

test("quick service selects date and time in one picker", async ({ page }) => {
  await page.goto("/orders/new?type=quick");
  const quickForm = page.locator(".service-mode-form-quick");
  const expectedAt = quickForm.locator('input[type="datetime-local"]');
  await expect(expectedAt).toHaveCount(1);
  await expect(quickForm.locator('input[type="time"]')).toHaveCount(0);
  const day = (await expectedAt.getAttribute("min"))!.slice(0, 10);
  await expectedAt.click();
  const picker = page.getByRole("dialog", { name: "Scegli data" });
  const timeInput = picker.locator('input[type="time"]');
  await expect(timeInput).toBeEnabled();
  await expect(picker.locator(".date-picker-time-control svg")).toBeVisible();
  await timeInput.fill("18:30");
  await expect(expectedAt).toHaveValue("");
  await picker.screenshot({
    path: ".local/date-picker-evidence/quick-service-time-before-date.png",
  });
  await picker.locator(`[data-date="${day}"]`).click();
  await expect(timeInput).toHaveValue("18:30");
  await picker.getByRole("button", { name: "Conferma", exact: true }).click();
  await expect(expectedAt).toHaveValue(`${day}T18:30`);
  await expect(quickForm.locator(".date-picker-toggle")).toBeFocused();
  await expectNoBlueSelection(quickForm.locator(".date-picker"));
  await quickForm.locator(".date-picker").screenshot({
    path: ".local/date-picker-evidence/quick-service-datetime.png",
  });
  await page
    .getByRole("button", { name: "Servizio di riparazione", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Servizio rapido", exact: true })
    .click();
  await expect(expectedAt).toHaveValue(`${day}T18:30`);
});
