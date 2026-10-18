import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("shared picker jumps directly to years and months without early filtering", async ({
  page,
}) => {
  await mkdir(".local/date-picker-evidence", { recursive: true });
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

test("inventory history month picker shows one label without native selection", async ({
  page,
}) => {
  await page.goto("/inventory");
  await page.locator(".inventory-history-card").click();
  const dialog = page.getByRole("dialog");
  const monthInput = dialog.locator('input[type="month"]');
  await expect(monthInput).toBeVisible();
  await expect(dialog.locator(".date-picker-month-value")).toBeVisible();
  await monthInput.click();
  await expect(monthInput).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  await expect(monthInput).not.toBeFocused();
  await expect(dialog.locator(".date-picker-popover")).toBeVisible();
  await dialog.locator(".retail-period-picker").screenshot({
    path: ".local/date-picker-evidence/inventory-month-value.png",
  });
});
