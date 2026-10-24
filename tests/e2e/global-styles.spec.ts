import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { seedTestDatabase } from "../../scripts/seed-test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

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
    className: "business-select-panel is-entering",
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

async function loadCompiledAppStyles(page: Page) {
  await page.goto("/orders", { waitUntil: "commit" });
  const bodyClass = (await page.locator("body").getAttribute("class")) ?? "";
  const datePickerScopeClass = await page
    .locator(".date-picker")
    .first()
    .evaluate((element) =>
      element.classList.item(element.classList.length - 1),
    );
  if (!datePickerScopeClass)
    throw new Error("The DatePicker CSS Module scope class was not rendered.");

  const nextDist = resolve(process.cwd(), process.env.NEXT_DIST_DIR || ".next");
  const compiledStylesheets = [
    resolve(nextDist, "dev", "static", "chunks"),
    resolve(nextDist, "static", "chunks"),
  ]
    .filter(existsSync)
    .flatMap((directory) =>
      readdirSync(directory)
        .filter((file) => file.endsWith(".css"))
        .map((file) => resolve(directory, file)),
    );
  const fallbackStylesheets = [
    resolve(nextDist, "dev", "static", "css", "app", "layout.css"),
    resolve(nextDist, "static", "css", "app", "layout.css"),
  ].filter(existsSync);
  const appStylesheets = [
    ...new Set([...compiledStylesheets, ...fallbackStylesheets]),
  ].filter((stylesheet) => {
    const css = readFileSync(stylesheet, "utf8");
    return (
      css.includes("--action-primary") ||
      css.includes(".button-primary") ||
      css.includes(".dialog-heading") ||
      css.includes(".date-picker-popover")
    );
  });

  expect(appStylesheets.length).toBeGreaterThan(0);
  expect(
    appStylesheets.some((stylesheet) =>
      readFileSync(stylesheet, "utf8").includes(".button-primary"),
    ),
  ).toBe(true);
  expect(
    appStylesheets.some((stylesheet) =>
      readFileSync(stylesheet, "utf8").includes(".dialog-heading"),
    ),
  ).toBe(true);
  expect(
    appStylesheets.some((stylesheet) =>
      readFileSync(stylesheet, "utf8").includes(".date-picker-popover"),
    ),
  ).toBe(true);
  await page.setContent("<main></main>");
  await page.locator("body").evaluate((body, className) => {
    body.setAttribute("class", className);
  }, bodyClass);
  for (const stylesheet of appStylesheets)
    await page.addStyleTag({ path: stylesheet });
  return datePickerScopeClass;
}

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

async function expectDocumentToFitViewport(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
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

  const datePickerScopeClass = await page
    .locator(".date-picker")
    .first()
    .evaluate((element) =>
      element.classList.item(element.classList.length - 1),
    );
  if (!datePickerScopeClass)
    throw new Error("The DatePicker CSS Module scope was not rendered.");

  const selectTrigger = page.locator(".business-select-trigger").first();
  const selectRoot = selectTrigger.locator("xpath=..");
  await expect(selectTrigger).toHaveCSS("display", "flex");
  await expect(selectTrigger).toHaveCSS("border-radius", "8px");
  await expect(selectTrigger).toHaveCSS("min-height", "41px");
  await selectTrigger.focus();
  await expect(selectTrigger).toHaveCSS("outline-style", "solid");
  await selectTrigger.click();
  const selectPanel = page.locator(
    ".business-select-panel.is-entering:visible",
  );
  await expect(selectPanel).toHaveCount(1);
  await expect(selectPanel).toHaveCSS("position", "fixed");
  await expect(selectPanel).toHaveCSS("border-radius", "9px");
  const businessSelectScopeClass = await selectPanel.evaluate((element) =>
    element.classList.item(element.classList.length - 1),
  );
  if (!businessSelectScopeClass)
    throw new Error("The business-select CSS Module scope was not rendered.");
  await expect(selectRoot).toHaveClass(new RegExp(businessSelectScopeClass));
  await expect(selectTrigger).toHaveAttribute("aria-expanded", "true");
  const openTriggerShadow = await selectTrigger.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(openTriggerShadow).not.toBe("none");
  await selectTrigger.click();
  await expect(selectPanel).toHaveCount(0);

  await page.evaluate(() => {
    const controls = document.createElement("div");
    controls.id = "global-form-controls";
    controls.innerHTML = `
      <select aria-label="Control select"><option>Option</option></select>
      <textarea aria-label="Control textarea"></textarea>
      <input type="checkbox" aria-label="Control checkbox" checked />
    `;
    document.body.append(controls);
  });

  const select = page.getByRole("combobox", { name: "Control select" });
  await expect(select).toHaveCSS("min-height", "41px");
  await expect(select).toHaveCSS("font-size", "14px");

  const textarea = page.getByRole("textbox", { name: "Control textarea" });
  await expect(textarea).toHaveCSS("min-height", "75px");
  await expect(textarea).toHaveCSS("resize", "vertical");

  const checkbox = page.getByRole("checkbox", { name: "Control checkbox" });
  await expect(checkbox).toHaveCSS("width", "16px");
  await expect(checkbox).toHaveCSS("height", "16px");
  await expect(checkbox).toHaveCSS("background-color", "rgb(251, 215, 46)");

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
  await expect(primaryButton).toHaveCSS("min-height", "40px");
  await expect(primaryButton).toHaveCSS("font-size", "13px");
  expect(await computedContrast(primaryButton, "color")).toBeGreaterThanOrEqual(
    4.5,
  );

  await page.evaluate(
    ({ surfaces, businessSelectScopeClass, datePickerScopeClass }) => {
      const fixture = document.createElement("div");
      fixture.id = "global-shadow-fixtures";
      fixture.style.cssText =
        "position: absolute; left: -10000px; top: 0; visibility: hidden";
      for (const surface of surfaces) {
        const element = document.createElement("div");
        element.id = `global-shadow-${surface.id}`;
        element.className = surface.className;
        if (surface.id === "business-select")
          element.classList.add(businessSelectScopeClass);
        if (surface.id === "date-picker")
          element.classList.add(datePickerScopeClass);
        fixture.append(element);
      }
      document.body.append(fixture);
    },
    {
      surfaces: elevationSurfaces,
      businessSelectScopeClass,
      datePickerScopeClass,
    },
  );

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

  await page.evaluate((scopeClass) => {
    const panel = document.createElement("div");
    panel.id = "business-select-hover-fixture";
    panel.className = `business-select-panel ${scopeClass}`;
    panel.style.cssText =
      "position: fixed; top: 24px; left: 24px; width: 240px; z-index: 2000";
    panel.innerHTML = `
      <div class="business-select-options">
        <div class="business-select-option">
          <span>Option</span><button class="option-delete" type="button">Delete</button>
        </div>
      </div>
    `;
    document.body.append(panel);
  }, businessSelectScopeClass);
  const deleteOption = page.locator(
    "#business-select-hover-fixture .business-select-option",
  );
  const deleteButton = deleteOption.locator(".option-delete");
  await expect(deleteButton).toHaveCSS("opacity", "0");
  await deleteOption.hover();
  await expect(deleteButton).toHaveCSS("opacity", "1");
  await expect(deleteButton).toHaveCSS("pointer-events", "auto");

  const panelFixture = page.locator("#global-shadow-business-select");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panelFixture).toHaveCSS("max-width", "374px");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(panelFixture).toHaveCSS("animation-name", "none");
});

test("searchable business select keeps its scoped control styles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/orders/new", { waitUntil: "domcontentloaded" });

  const customerSearch = page.getByRole("combobox", {
    name: "Cerca cliente",
    exact: true,
  });
  await expect(customerSearch).toBeVisible();
  const searchBox = customerSearch.locator("xpath=..");
  const searchableSelectRoot = customerSearch.locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' business-select ')]",
  );
  await customerSearch.fill("NGT-CSS-CREATE-NO-MATCH-7391");
  await expect(customerSearch).toHaveValue("NGT-CSS-CREATE-NO-MATCH-7391");
  const createAction = searchableSelectRoot.locator(".business-select-create");
  await expect(createAction).toBeVisible();
  await expect(createAction).toHaveCSS("width", "38px");
  await expect(createAction.locator("span")).toHaveCSS("position", "absolute");
  await expect(searchBox).toHaveCSS("display", "flex");
  await expect(searchBox).toHaveCSS("min-height", "38px");
  await expect(searchBox).toHaveCSS("border-radius", "8px");
  await expect(searchBox.locator("xpath=..")).toHaveCSS("display", "grid");
  await customerSearch.focus();
  await expect(searchBox).not.toHaveCSS("box-shadow", "none");

  const chevron = customerSearch
    .locator("xpath=../..")
    .locator(".business-combobox-chevron");
  await expect(chevron).toHaveCSS("display", "flex");
  await expect(chevron).toHaveCSS("width", "36px");
  await expect(chevron).toHaveCSS("min-height", "38px");
  await chevron.focus();
  await expect(chevron).toHaveCSS("outline-style", "solid");
  const panel = page.locator(".business-select-panel.is-entering:visible");
  await expect(panel).toHaveCount(1);
  await expect(chevron.locator("svg")).toHaveCSS(
    "transform",
    "matrix(-1, 0, 0, -1, 0, 0)",
  );
  const scopeClass = await panel.evaluate((element) =>
    element.classList.item(element.classList.length - 1),
  );
  if (!scopeClass)
    throw new Error("The searchable business-select scope was not rendered.");
  await expect(searchableSelectRoot).toHaveClass(new RegExp(scopeClass));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(chevron.locator("svg")).toHaveCSS("transition-property", "none");
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

test("shared actions keep visible focus, stable hover, and clear disabled feedback", async ({
  page,
}) => {
  await page.goto("/orders", { waitUntil: "commit" });

  const primaryButton = page.locator(".button-primary").first();
  await expect(primaryButton).toBeVisible();

  await primaryButton.focus();
  await expect(primaryButton).toHaveCSS("outline-style", "solid");
  expect(
    await computedContrast(primaryButton, "outlineColor"),
  ).toBeGreaterThanOrEqual(3);

  const restingBox = await primaryButton.boundingBox();
  await primaryButton.hover();
  const hoverBox = await primaryButton.boundingBox();
  expect(hoverBox).toEqual(restingBox);

  await page.evaluate(() => {
    const fixture = document.createElement("button");
    fixture.id = "global-disabled-button-fixture";
    fixture.className = "button button-primary";
    fixture.disabled = true;
    fixture.textContent = "Disabled";
    document.body.append(fixture);
  });

  const disabledButton = page.locator("#global-disabled-button-fixture");
  await expect(disabledButton).toHaveCSS("cursor", "not-allowed");
  await expect(disabledButton).toHaveCSS("box-shadow", "none");
  await expect(disabledButton).toHaveCSS("transform", "none");
});

test("dialog and record actions keep clear spacing and hover feedback", async ({
  page,
}) => {
  await loadCompiledAppStyles(page);
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "global-action-fixture";
    fixture.className = "form-dialog";
    fixture.setAttribute("open", "");
    fixture.innerHTML = `
      <div class="dialog-heading">
        <div><h2>Choose an option</h2><p>Dialog description</p></div>
        <button class="dialog-close icon-button" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <div class="dialog-body price-option-dialog" data-form-dialog-body>
        <div class="price-option-list" style="height: 900px"></div>
        <button class="quick-service-picker-add price-option-add">Add</button>
        <textarea aria-label="Focused field"></textarea>
      </div>
      <div class="dialog-footer price-option-picker-footer">
        <div class="dialog-actions"><button class="button button-cancel">Cancel</button><button class="button button-outline">Outline action</button></div>
      </div>
    `;
    document.body.append(fixture);
    const embeddedActions = document.createElement("div");
    embeddedActions.className = "standalone-actions";
    embeddedActions.innerHTML = `
      <button class="button button-cancel">Standalone cancel</button>
      <button class="button button-ghost record-icon record-icon-edit" aria-label="Edit">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4l11-11-4-4L4 16v4Z" /></svg>
      </button>
      <button class="button button-ghost record-icon record-icon-delete" aria-label="Delete">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 7h12M9 7V4h6v3m-8 0 1 13h8l1-13" /></svg>
      </button>
    `;
    document.body.append(embeddedActions);
  });

  const close = page.getByRole("button", { name: "Close" });
  await expect(close).toHaveCSS("display", "grid");
  await expect(close).toHaveCSS("width", "40px");
  await expect(close).toHaveCSS("height", "40px");
  await expect(close).toHaveCSS("padding", "0px");
  await expect(close).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  expect(
    await close.evaluate((button) => {
      const buttonBox = button.getBoundingClientRect();
      const iconBox = button.querySelector("svg")!.getBoundingClientRect();
      return Math.max(
        Math.abs(
          buttonBox.left +
            buttonBox.width / 2 -
            (iconBox.left + iconBox.width / 2),
        ),
        Math.abs(
          buttonBox.top +
            buttonBox.height / 2 -
            (iconBox.top + iconBox.height / 2),
        ),
      );
    }),
  ).toBeLessThanOrEqual(0.5);
  await close.hover();
  await expect(close).toHaveCSS("background-color", "rgb(255, 240, 238)");

  const addPartOption = page.locator(".price-option-add");
  await expect(addPartOption).toHaveCSS("margin-top", "12px");

  const optionFooter = page.locator(".price-option-picker-footer");
  await expect(optionFooter).toHaveCSS("margin-top", "24px");
  await expect(optionFooter).toHaveCSS("padding-top", "16px");
  await expect(optionFooter).not.toHaveCSS(
    "border-top-color",
    "rgba(0, 0, 0, 0)",
  );
  const footerActions = optionFooter.locator(".dialog-actions");
  await expect(footerActions).toHaveCSS("padding-top", "0px");
  await expect(footerActions).toHaveCSS("border-top-width", "0px");
  const [headingBox, footerBox] = await Promise.all([
    page.locator(".dialog-heading").boundingBox(),
    optionFooter.boundingBox(),
  ]);
  expect(Math.abs(headingBox!.x - footerBox!.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(headingBox!.width - footerBox!.width)).toBeLessThanOrEqual(
    0.5,
  );

  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(cancel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const cancelBox = await cancel.boundingBox();
  await cancel.hover();
  await expect(cancel).toHaveCSS("background-color", "rgb(255, 247, 214)");
  const hoveredCancelBox = await cancel.boundingBox();
  expect(hoveredCancelBox!.width).toBe(cancelBox!.width);
  expect(hoveredCancelBox!.height).toBe(cancelBox!.height);

  const standaloneCancel = page.getByRole("button", {
    name: "Standalone cancel",
  });
  await expect(standaloneCancel).toHaveCSS(
    "border-top-color",
    "rgba(0, 0, 0, 0)",
  );
  await standaloneCancel.focus();
  await expect(standaloneCancel).toHaveCSS("outline-style", "solid");
  expect(
    await computedContrast(standaloneCancel, "outlineColor"),
  ).toBeGreaterThanOrEqual(3);
  await standaloneCancel.hover();
  await expect(standaloneCancel).toHaveCSS(
    "background-color",
    "rgb(255, 247, 214)",
  );

  const outlineAction = page.getByRole("button", { name: "Outline action" });
  await expect(outlineAction).not.toHaveCSS(
    "border-top-color",
    "rgba(0, 0, 0, 0)",
  );

  const dialogBody = page.locator(".form-dialog > .dialog-body");
  const focusedField = page.getByRole("textbox", { name: "Focused field" });
  await expect(optionFooter).toBeInViewport();
  expect(
    await dialogBody.evaluate((body) => body.scrollHeight > body.clientHeight),
  ).toBe(true);
  await expect(dialogBody).toHaveCSS("padding-left", "4px");
  await expect(dialogBody).toHaveCSS("padding-right", "4px");
  await focusedField.focus();
  const [bodyBox, fieldBox] = await Promise.all([
    dialogBody.boundingBox(),
    focusedField.boundingBox(),
  ]);
  expect(fieldBox!.x - bodyBox!.x).toBeGreaterThanOrEqual(4);
  expect(
    bodyBox!.x + bodyBox!.width - fieldBox!.x - fieldBox!.width,
  ).toBeGreaterThanOrEqual(4);

  const edit = page.getByRole("button", { name: "Edit" });
  await expect(edit).toBeVisible();
  await edit.hover();
  await expect(edit).toHaveCSS("background-color", "rgb(255, 237, 170)");

  const remove = page.getByRole("button", { name: "Delete" });
  await expect(remove).toBeVisible();
  await remove.hover();
  await expect(remove).toHaveCSS("background-color", "rgb(251, 233, 232)");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(optionFooter).toHaveCSS("flex-direction", "column");
  const [mobileFooterBox, mobileActionsBox] = await Promise.all([
    optionFooter.boundingBox(),
    footerActions.boundingBox(),
  ]);
  expect(
    Math.abs(mobileFooterBox!.width - mobileActionsBox!.width),
  ).toBeLessThanOrEqual(0.5);
  expect(
    await page
      .locator("#global-action-fixture")
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  ).toBe(true);
});

test("monthly receipt dialog uses a compact responsive overview", async ({
  page,
}) => {
  const datePickerScopeClass = await loadCompiledAppStyles(page);
  await page.evaluate((scopeClass) => {
    const dialog = document.createElement("div");
    dialog.className = "form-dialog";
    dialog.innerHTML = `
      <div class="dialog-heading"><div><h2>Monthly receipts</h2><p>Description</p></div></div>
      <div data-form-dialog-body class="monthly-receipt-dialog">
        <div class="monthly-receipt-overview">
          <div class="monthly-receipt-picker">
            <span>Month</span>
            <div class="date-picker"><input type="month" value="2026-10" /></div>
          </div>
          <div class="monthly-receipt-total">
            <span>Total</span><strong>119,00 €</strong><small>1–23 October</small>
          </div>
        </div>
        <section class="monthly-receipt-comparisons">
          <h3>Previous years</h3>
          <div class="monthly-receipt-comparison"><span>2025</span><strong>100,00 €</strong><small>+19%</small></div>
        </section>
      </div>
    `;
    dialog
      .querySelector(".monthly-receipt-picker .date-picker")!
      .classList.add(scopeClass);
    document.body.append(dialog);
  }, datePickerScopeClass);

  const dialog = page.locator(".form-dialog");
  const overview = page.locator(".monthly-receipt-overview");
  const picker = page.locator(".monthly-receipt-picker");
  const control = picker.locator(".date-picker");
  const total = page.locator(".monthly-receipt-total");
  const amount = page.locator(".monthly-receipt-comparison > strong");

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(dialog).toHaveCSS("width", "680px");
  const [desktopPicker, desktopControl, desktopTotal] = await Promise.all([
    picker.boundingBox(),
    control.boundingBox(),
    total.boundingBox(),
  ]);
  expect(desktopControl!.width).toBeLessThanOrEqual(256);
  expect(desktopPicker!.y).toBeCloseTo(desktopTotal!.y, 0);
  await expect(amount).toHaveCSS("text-align", "right");

  await page.setViewportSize({ width: 390, height: 844 });
  const [mobileOverview, mobilePicker, mobileTotal] = await Promise.all([
    overview.boundingBox(),
    picker.boundingBox(),
    total.boundingBox(),
  ]);
  expect(mobilePicker!.x).toBeCloseTo(mobileTotal!.x, 0);
  expect(mobileTotal!.y).toBeGreaterThanOrEqual(
    mobilePicker!.y + mobilePicker!.height,
  );
  expect(mobileOverview!.width).toBeLessThanOrEqual(342);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("price option flags only toggle from their compact labels", async ({
  page,
}) => {
  await page.setContent("<main></main>");
  await page.addStyleTag({
    path: resolve(process.cwd(), "src/app/globals.css"),
  });
  await page.evaluate(() => {
    const flags = document.createElement("div");
    flags.className = "form-row price-option-flags";
    flags.innerHTML = `
      <label class="checkbox"><input type="checkbox" checked />Enabled</label>
      <label class="checkbox"><input type="checkbox" />Default option</label>
    `;
    document.body.append(flags);
  });

  const flags = page.locator(".price-option-flags");
  const enabled = page.getByRole("checkbox", { name: "Enabled" });
  const defaultOption = page.getByRole("checkbox", {
    name: "Default option",
  });
  const enabledLabel = enabled.locator("..");
  const [flagsBox, labelBox] = await Promise.all([
    flags.boundingBox(),
    enabledLabel.boundingBox(),
  ]);
  expect(labelBox!.width).toBeLessThan(flagsBox!.width);

  await page.mouse.click(
    flagsBox!.x + flagsBox!.width - 4,
    labelBox!.y + labelBox!.height / 2,
  );
  await expect(enabled).toBeChecked();
  await expect(defaultOption).not.toBeChecked();

  await enabledLabel.click();
  await expect(enabled).not.toBeChecked();
});

test("workspace list pages fit desktop, tablet, and mobile viewports", async ({
  page,
}) => {
  const viewports = [
    { width: 1280, height: 800 },
    { width: 900, height: 800 },
    { width: 390, height: 844 },
  ];
  const routes = ["/orders", "/inventory", "/customers"];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route, { waitUntil: "commit" });
      await expect(page.locator(".workspace-list-page")).toBeVisible();
      await expectDocumentToFitViewport(page);
    }
  }

  await page.goto("/customers", { waitUntil: "networkidle" });
  await expect(
    page.locator(".customer-last-repair .mobile-label").first(),
  ).toHaveCSS("margin-right", "4px");
  await page.locator(".page-header .button-primary").click();

  const dialog = page.locator(".form-dialog");
  await expect(dialog).toBeVisible();
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return Boolean(
        box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= 390 &&
        box.y + box.height <= 844,
      );
    })
    .toBe(true);
  await expectDocumentToFitViewport(page);
});
