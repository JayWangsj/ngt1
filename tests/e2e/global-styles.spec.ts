import { expect, test } from "./fixtures";
import type { Locator } from "@playwright/test";
import { seedTestDatabase } from "../../scripts/seed-test";

const elevationSurfaces = [
  { id: "dialog", className: "form-dialog", token: "--shadow-5" },
  {
    id: "status-menu",
    className: "status-dropdown-menu",
    token: "--shadow-3",
  },
  {
    id: "action-menu",
    className: "secondary-actions-menu",
    token: "--shadow-3",
  },
  {
    id: "business-select",
    className: "business-select-panel",
    token: "--shadow-3",
  },
  {
    id: "date-picker",
    className: "date-picker-popover",
    token: "--shadow-4",
  },
  {
    id: "inventory-filter",
    className: "inventory-device-popover",
    token: "--shadow-4",
  },
  { id: "chart-tooltip", className: "revenue-tooltip", token: "--shadow-3" },
  {
    id: "update-notification",
    className: "update-notification",
    token: "--shadow-2",
  },
] as const;

test.beforeEach(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))
    throw new Error("Global style E2E requires a dedicated *_test database.");

  await seedTestDatabase();
});

async function computedContrast(
  locator: Locator,
  foreground: "color" | "borderTopColor" | "outlineColor",
  pseudo?: string,
) {
  const [foregroundColor, backgroundColor] = await locator.evaluate(
    (element, options) => {
      function opaqueColor(node: Element | null): string {
        while (node) {
          const color = getComputedStyle(node).backgroundColor;
          if (!color.startsWith("rgba(") || !color.endsWith(", 0)"))
            return color;
          node = node.parentElement;
        }
        return "rgb(255, 255, 255)";
      }

      const style = getComputedStyle(element, options.pseudo);
      return [style[options.foreground], opaqueColor(element)];
    },
    { foreground, pseudo },
  );

  function luminance(color: string) {
    const values = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    if (!values || values.length !== 3)
      throw new Error(`Unsupported computed CSS color: ${color}`);
    const channels = values.map((value) => {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  const [light, dark] = [
    luminance(foregroundColor),
    luminance(backgroundColor),
  ].sort((left, right) => right - left);
  return (light + 0.05) / (dark + 0.05);
}

test("shared controls keep readable text, borders, and keyboard focus", async ({
  page,
}) => {
  await page.goto("/orders", { waitUntil: "commit" });

  const search = page.locator('.filters input[name="q"]');
  await expect(search).toBeVisible();
  await expect(search).toHaveCSS("font-size", "14px");
  expect(
    await computedContrast(search, "color", "::placeholder"),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    await computedContrast(search, "borderTopColor"),
  ).toBeGreaterThanOrEqual(3);

  await search.focus();
  await expect(search).toHaveCSS("outline-style", "solid");
  expect(await computedContrast(search, "outlineColor")).toBeGreaterThanOrEqual(
    3,
  );

  // The seeded test database has no orders, so create a DOM fixture for the
  // shared table rules while keeping the application data untouched.
  await page.evaluate(() => {
    const table = document.createElement("table");
    table.id = "global-style-table-fixture";
    table.innerHTML =
      "<thead><tr><th>Heading</th></tr></thead><tbody><tr><td><small>Metadata</small></td></tr></tbody>";
    document.body.append(table);
  });

  const heading = page.locator("#global-style-table-fixture th");
  await expect(heading).toHaveCSS("font-size", "12px");
  expect(await computedContrast(heading, "color")).toBeGreaterThanOrEqual(4.5);

  const metadata = page.locator("#global-style-table-fixture td small");
  await expect(metadata).toBeVisible();
  await expect(metadata).toHaveCSS("font-size", "12px");
  expect(await computedContrast(metadata, "color")).toBeGreaterThanOrEqual(4.5);

  const primaryButton = page.locator(".button-primary").first();
  await expect(primaryButton).toBeVisible();
  expect(await computedContrast(primaryButton, "color")).toBeGreaterThanOrEqual(
    4.5,
  );

  await page.evaluate((surfaces) => {
    const fixture = document.createElement("div");
    fixture.id = "global-shadow-fixtures";
    fixture.style.cssText =
      "position: absolute; left: -10000px; top: 0; visibility: hidden";
    for (const surface of surfaces) {
      const element = document.createElement("div");
      element.id = `global-shadow-${surface.id}`;
      element.className = surface.className;
      fixture.append(element);
    }
    document.body.append(fixture);
  }, elevationSurfaces);

  for (const surface of elevationSurfaces) {
    const usesToken = await page
      .locator(`#global-shadow-${surface.id}`)
      .evaluate((element, token) => {
        const probe = document.createElement("div");
        probe.style.boxShadow = `var(${token})`;
        element.parentElement?.append(probe);
        const expected = getComputedStyle(probe).boxShadow;
        const actual = getComputedStyle(element).boxShadow;
        probe.remove();
        return actual !== "none" && actual === expected;
      }, surface.token);
    expect(usesToken, `${surface.className} uses ${surface.token}`).toBe(true);
  }
});

test("sidebar resize handle uses the defined action color", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/orders", { waitUntil: "commit" });

  const resizer = page.getByRole("separator", {
    name: "Ridimensiona barra laterale",
  });
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 4, box!.y + 200);
  await expect
    .poll(() =>
      resizer.evaluate(
        (element) => getComputedStyle(element, "::after").backgroundColor,
      ),
    )
    .toBe("rgb(128, 96, 0)");
});
