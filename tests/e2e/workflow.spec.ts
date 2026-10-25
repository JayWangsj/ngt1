import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { seedTestDatabase } from "../../scripts/seed-test";

test.beforeEach(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))
    throw new Error("Workflow E2E requires a dedicated *_test database.");

  await seedTestDatabase();
});

async function seedDashboardReceipts() {
  const db = new PrismaClient();
  try {
    const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
    const sale = await db.retailSale.create({
      data: {
        code: "E2E-DASHBOARD-SALE",
        requestId: "e2e-dashboard-sale",
        subtotal: "140.00",
        total: "140.00",
        itemCount: 1,
        actorId: owner.id,
        actorName: owner.name,
        createdAt: new Date("2026-10-03T10:00:00Z"),
      },
    });
    await db.$transaction([
      db.payment.create({
        data: {
          requestId: "e2e-dashboard-previous-day",
          saleId: sale.id,
          amount: "40.00",
          method: "CASH",
          kind: "OTHER",
          receivedAt: new Date("2026-10-02T10:00:00Z"),
          actorId: owner.id,
          actorName: owner.name,
          allocations: {
            create: [{ source: "REPAIR", amount: "40.00" }],
          },
        },
      }),
      db.payment.create({
        data: {
          requestId: "e2e-dashboard-selected-day",
          saleId: sale.id,
          amount: "100.00",
          method: "CARD",
          kind: "OTHER",
          receivedAt: new Date("2026-10-03T10:00:00Z"),
          actorId: owner.id,
          actorName: owner.name,
          allocations: {
            create: [
              { source: "REPAIR", amount: "60.00" },
              { source: "RETAIL", amount: "30.00" },
              { source: "QUICK_SERVICE", amount: "10.00" },
            ],
          },
        },
      }),
      db.payment.create({
        data: {
          requestId: "e2e-dashboard-2025-october",
          saleId: sale.id,
          amount: "80.00",
          method: "CASH",
          kind: "OTHER",
          receivedAt: new Date("2025-10-03T10:00:00Z"),
          actorId: owner.id,
          actorName: owner.name,
        },
      }),
      db.payment.create({
        data: {
          requestId: "e2e-dashboard-2024-october",
          saleId: sale.id,
          amount: "40.00",
          method: "CASH",
          kind: "OTHER",
          receivedAt: new Date("2024-10-03T10:00:00Z"),
          actorId: owner.id,
          actorName: owner.name,
        },
      }),
      db.payment.create({
        data: {
          requestId: "e2e-dashboard-2025-september",
          saleId: sale.id,
          amount: "50.00",
          method: "CASH",
          kind: "OTHER",
          receivedAt: new Date("2025-09-30T10:00:00Z"),
          actorId: owner.id,
          actorName: owner.name,
        },
      }),
      db.payment.create({
        data: {
          requestId: "e2e-dashboard-2024-september",
          saleId: sale.id,
          amount: "25.00",
          method: "CASH",
          kind: "OTHER",
          receivedAt: new Date("2024-09-30T10:00:00Z"),
          actorId: owner.id,
          actorName: owner.name,
        },
      }),
    ]);
  } finally {
    await db.$disconnect();
  }
}

async function clearDashboardAttention() {
  const db = new PrismaClient();
  try {
    await db.$transaction([
      db.workOrder.updateMany({ data: { dueDate: null } }),
      db.product.updateMany({
        where: { enabled: true },
        data: { minStock: 0, stockQuantity: 1 },
      }),
    ]);
  } finally {
    await db.$disconnect();
  }
}

const retirementFixture = {
  productName: "Retirement fixture LCD Test",
  project: "sostituzione display retirement fixture",
  optionName: "Retirement fixture LCD",
};

async function resetRetirementFixture() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))
    throw new Error("The retirement fixture can only use a *_test database.");

  const db = new PrismaClient();
  try {
    const product = await db.product.findFirstOrThrow({
      where: { name: retirementFixture.productName },
    });
    const rule = await db.priceRule.findFirstOrThrow({
      where: {
        category: "PHONE",
        brand: "Apple",
        model: "iPhone 13",
        project: retirementFixture.project,
      },
    });
    const option = await db.priceRuleOption.findFirstOrThrow({
      where: { ruleId: rule.id, productId: product.id },
    });

    await db.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: product.id },
        data: { enabled: true, usage: "REPAIR" },
      });
      await tx.priceRuleOption.update({
        where: { id: option.id },
        data: { enabled: true, isDefault: true },
      });
      await tx.priceRule.update({
        where: { id: rule.id },
        data: {
          enabled: true,
          suggested: "30.00",
          requiredProductId: product.id,
          requiredQuantity: 1,
        },
      });
      await tx.productCompatibility.upsert({
        where: {
          productId_category_brand_model_project: {
            productId: product.id,
            category: "PHONE",
            brand: "Apple",
            model: "iPhone 13",
            project: retirementFixture.project,
          },
        },
        create: {
          productId: product.id,
          category: "PHONE",
          brand: "Apple",
          model: "iPhone 13",
          project: retirementFixture.project,
        },
        update: {},
      });
    });
  } finally {
    await db.$disconnect();
  }
}

async function expectMatchingColumn(
  header: Locator,
  cell: Locator,
  alignment: "left" | "right" | "center",
) {
  await expect(header).toHaveCSS("text-align", alignment);
  await expect(cell).toHaveCSS("text-align", alignment);
  const [headerMetrics, cellMetrics] = await Promise.all(
    [header, cell].map((locator) =>
      locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: box.x,
          width: box.width,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
        };
      }),
    ),
  );
  expect(Math.abs(headerMetrics.x - cellMetrics.x)).toBeLessThan(1);
  expect(Math.abs(headerMetrics.width - cellMetrics.width)).toBeLessThan(1);
  expect(headerMetrics.paddingLeft).toBe(cellMetrics.paddingLeft);
  expect(headerMetrics.paddingRight).toBe(cellMetrics.paddingRight);
}

async function chooseBusinessOption(
  page: Page,
  label: string,
  option: string,
  scope: Page | Locator = page,
) {
  await page.waitForLoadState("networkidle");
  const combobox = scope.getByRole("combobox", { name: label, exact: true });
  const simpleSelect = scope.getByRole("button", { name: label, exact: true });
  await expect(combobox.or(simpleSelect).first()).toBeVisible();
  if (await combobox.isVisible()) {
    if ((await combobox.inputValue()) === option) {
      const expand = combobox
        .locator(
          "xpath=ancestor::*[contains(@class, 'business-combobox-control')]",
        )
        .locator(".business-combobox-chevron");
      if ((await combobox.getAttribute("aria-expanded")) !== "true")
        await expand.click();
    } else await combobox.fill(option);
    await expect(combobox).toHaveAttribute("aria-expanded", "true");
  } else {
    if ((await simpleSelect.getAttribute("aria-expanded")) !== "true")
      await simpleSelect.click();
    await expect(simpleSelect).toHaveAttribute("aria-expanded", "true");
  }
  const panel = page.locator(".business-select-panel.is-entering:visible");
  await expect(panel).toHaveCount(1);
  const exact = panel.getByRole("option", { name: option, exact: true });
  if ((await exact.count()) === 1) return exact.click();
  const exactLabel = panel
    .locator(".business-select-option-copy")
    .getByText(option, { exact: true });
  await expect(exactLabel).toHaveCount(1);
  await exactLabel.click();
}

async function chooseRequiredPart(
  page: Page,
  option: string,
  scope: Page | Locator = page,
) {
  const priceOptionSummary = scope.locator(".price-option-picker-summary");
  const priceOptionAdd = scope.getByRole("button", {
    name: "Opzioni ricambio",
    exact: true,
  });
  if (
    (await priceOptionSummary.first().isVisible()) ||
    (await priceOptionAdd.first().isVisible())
  ) {
    if (await priceOptionSummary.first().isVisible())
      await priceOptionSummary.first().locator(".summary-action").click();
    else await priceOptionAdd.first().click();
    const picker = page
      .getByRole("dialog", { name: "Opzioni ricambio", exact: true })
      .last();
    await picker
      .locator(".price-option-choice")
      .filter({ hasText: option })
      .first()
      .click();
    await picker
      .getByRole("button", { name: "Conferma selezione", exact: true })
      .click();
    return;
  }
  const combobox = scope.getByRole("combobox", {
    name: "Ricambio richiesto 1",
    exact: true,
  });
  if (!(await combobox.isVisible())) {
    const summary = scope.locator(".selected-part-summary").first();
    if (await summary.isVisible()) await summary.click();
    else
      await scope
        .getByRole("button", { name: "Ricambio", exact: true })
        .first()
        .click();
  }
  await chooseBusinessOption(page, "Ricambio richiesto 1", option, scope);
}

async function choosePriceOption(
  page: Page,
  option: string,
  scope: Page | Locator = page,
) {
  let picker = page
    .getByRole("dialog", { name: "Opzioni ricambio", exact: true })
    .last();
  if (!(await picker.isVisible())) {
    const summary = scope.locator(
      ".price-option-picker-summary .summary-action",
    );
    if (await summary.first().isVisible()) await summary.first().click();
    else
      await scope
        .getByRole("button", { name: "Opzioni ricambio", exact: true })
        .first()
        .click();
    picker = page
      .getByRole("dialog", { name: "Opzioni ricambio", exact: true })
      .last();
  }
  await picker
    .locator(".price-option-choice")
    .filter({ hasText: option })
    .first()
    .click();
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
}

async function chooseRepairDevice(page: Page, name: string) {
  await page.getByRole("button", { name: "Dispositivo", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Dispositivo del cliente",
  });
  await expect(dialog).toHaveCSS("width", "900px");
  await dialog
    .locator(".customer-device-row")
    .filter({ hasText: name })
    .first()
    .click();
  await dialog
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
}

async function openNewRepairDeviceDialog(page: Page) {
  const change = page.getByRole("button", {
    name: "Cambia dispositivo",
    exact: true,
  });
  if (await change.isVisible()) await change.click();
  else
    await page
      .getByRole("button", { name: "Dispositivo", exact: true })
      .click();
  const picker = page.getByRole("dialog", {
    name: "Dispositivo del cliente",
  });
  await picker
    .getByRole("button", { name: "Dispositivo", exact: true })
    .click();
  return {
    picker,
    dialog: page.getByRole("dialog", { name: "Nuovo dispositivo" }),
  };
}

async function createRepairDevice(page: Page, brand: string, model: string) {
  await page.getByRole("button", { name: "Dispositivo", exact: true }).click();
  const picker = page.getByRole("dialog", {
    name: "Dispositivo del cliente",
  });
  await picker
    .getByRole("button", { name: "Dispositivo", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Nuovo dispositivo" });
  await chooseBusinessOption(page, "Marca", brand, dialog);
  await chooseBusinessOption(page, "Modello", model, dialog);
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    picker.locator(".customer-device-row.is-selected"),
  ).toContainText(`${brand} ${model}`);
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
}

async function chooseRepairProjects(
  page: Page,
  names: string[],
  scope: Page | Locator = page,
) {
  if (scope === page) {
    const quoteHeading = page
      .locator(".order-step-card")
      .nth(2)
      .locator(".order-step-heading");
    await expect(quoteHeading).toHaveAttribute("aria-expanded", "true");
  }
  const addProject = scope
    .locator(".quick-service-service-add:visible")
    .first();
  await addProject.click();
  const dialog = page.getByRole("dialog", {
    name: "Seleziona interventi",
  });
  for (const name of names) {
    const option = repairProjectOption(dialog, name);
    await expect(option).toHaveCount(1);
    await option.click();
  }
  await dialog
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
}

function repairProjectOption(dialog: Locator, name: string) {
  return dialog
    .locator(".quick-service-picker-option")
    .locator(".quick-service-picker-copy")
    .getByText(name, { exact: true });
}

async function createRepairProject(page: Page, name: string, price: string) {
  await page.getByRole("button", { name: "Intervento", exact: true }).click();
  const picker = page.getByRole("dialog", {
    name: "Seleziona interventi",
  });
  await picker.getByRole("button", { name: "Intervento", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Intervento personalizzato",
  });
  await dialog.getByLabel("Intervento *", { exact: true }).fill(name);
  await dialog
    .getByLabel("Prezzo originale (€) *", { exact: true })
    .fill(price);
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    picker
      .locator(".quick-service-picker-option.is-selected")
      .filter({ hasText: name }),
  ).toBeVisible();
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
}

async function enterBusinessValue(
  page: Page,
  label: string,
  value: string,
  scope: Page | Locator = page,
) {
  const combobox = scope.getByRole("combobox", { name: label, exact: true });
  await combobox.click();
  await combobox.fill(value);
  const panel = page.locator(".business-select-panel.is-entering");
  expect(
    await panel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    }),
  ).toBe(true);
  await combobox
    .locator("xpath=ancestor::*[contains(@class, 'business-combobox-control')]")
    .locator(".business-select-create")
    .click();
  await expect(panel).not.toBeVisible();
  await expect(combobox).toHaveValue(value);
  await combobox.press("Escape");
}
async function fillOrder(
  page: Page,
  options: {
    manual?: boolean;
    diagnosis?: boolean;
    discount?: boolean;
    fault?: string;
    phone?: string;
    name?: string;
  } = {},
) {
  await page.goto("/orders/new");
  await page.waitForLoadState("networkidle");
  const customerName = options.name ?? "Cliente Playwright";
  if (options.phone) {
    await page
      .getByRole("combobox", { name: "Cerca cliente", exact: true })
      .fill(options.phone);
    await page
      .getByRole("button", { name: "Nuovo cliente", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Nuovo cliente" });
    await dialog.getByLabel(/Nome e cognome/).fill(customerName);
    await dialog.getByLabel(/Telefono/).fill(options.phone);
    await dialog
      .getByRole("button", { name: "Salva cliente", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
  }
  if (!options.phone)
    await chooseBusinessOption(page, "Cerca cliente", customerName);
  if (options.phone) {
    await createRepairDevice(page, "Apple", "iPhone 13");
  } else {
    await chooseRepairDevice(page, "Apple iPhone 13");
  }
  if (options.diagnosis)
    await page
      .getByRole("button", { name: "Imposta diagnosi", exact: true })
      .click();
  else
    await page
      .getByLabel(options.fault ?? "Display rotto", { exact: true })
      .check();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  if (options.diagnosis) {
    await expect(
      page.getByRole("button", { name: "Intervento", exact: true }),
    ).toHaveCount(0);
  } else if (options.manual) {
    await createRepairProject(page, `Fotocamera ${Date.now()}`, "75");
  } else {
    await chooseRepairProjects(page, ["sostituzione display"]);
    await openStep(page, 2);
  }
  if (options.diagnosis) {
    // Diagnosis orders intentionally have no repair quote yet.
  } else if (!options.manual) {
    await choosePriceOption(page, "Display LCD standard");
    await expect(
      page.getByRole("button", {
        name: "Modifica dati Preventivo attuale",
        exact: true,
      }),
    ).toContainText("100,00");
  }
  if (options.discount && !options.diagnosis) {
    await page
      .getByRole("button", { name: "Aggiungi sconto intervento", exact: true })
      .click();
    await page
      .getByLabel("Sconto intervento (€) 1", { exact: true })
      .fill("10");
    await page
      .getByLabel("Sconto aggiuntivo sulla scheda (€)", { exact: true })
      .fill("5");
    await page
      .getByLabel("Includi IVA nel saldo da pagare", { exact: true })
      .check();
  }
  await expect(
    page.getByLabel("Preventivo confermato dal cliente", { exact: true }),
  ).toHaveCount(0);
}
async function save(page: Page) {
  await page
    .getByRole("button", { name: "Crea scheda di servizio", exact: true })
    .click();
  await expect(page).toHaveURL(/\/orders\/(?!new)[a-z0-9]+$/);
  await page.waitForLoadState("networkidle");
}
async function openPayment(page: Page) {
  const step = page.locator(".order-step-card").filter({ hasText: /^04/ });
  await step.locator(".order-step-heading").click();
}
async function openStep(page: Page, index: number) {
  const card = page.locator(".order-step-card").nth(index);
  const heading = card.locator(".order-step-heading");
  if ((await heading.getAttribute("aria-expanded")) !== "true")
    await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "true");
}
async function state(page: Page, next: string) {
  await page.waitForLoadState("networkidle");
  const label = next === "REPAIRING" ? "In riparazione" : "Da ritirare";
  const trigger = page.locator(".detail-status .status-dropdown-trigger");
  const option = page.getByRole("option", { name: label, exact: true });
  for (let attempt = 0; attempt < 3 && !(await option.isVisible()); attempt++) {
    await trigger.click({ delay: 100 });
    await page.waitForTimeout(250);
  }
  await expect(option).toBeVisible();
  await option.click({ delay: 100 });
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toBeEnabled();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toContainText(label);
}
test("new repair uses a single selected accordion step", async ({ page }) => {
  await page.goto("/orders/new");
  await page.waitForLoadState("networkidle");
  const cards = page.locator(".order-step-card");
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toHaveClass(/is-selected/);
  await expect(cards.nth(0)).toHaveCSS("border-color", "rgb(234, 216, 137)");
  await expect(cards.nth(0)).toHaveCSS(
    "background-color",
    "rgb(255, 254, 251)",
  );
  expect(
    await cards
      .nth(0)
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toContain("0.18s");
  await cards.nth(1).hover();
  await expect(cards.nth(1)).toHaveCSS("border-color", "rgb(231, 201, 90)");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(cards.nth(0)).toHaveCSS("transition-property", "none");
  await expect(cards.nth(0).locator(".order-step-collapse")).toHaveCSS(
    "transition-property",
    "none",
  );
  await expect(cards.nth(0).locator(".order-step-chevron")).toHaveCSS(
    "transition-property",
    "none",
  );
  await cards.nth(1).hover();
  await expect(cards.nth(1)).toHaveCSS("transform", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(cards.nth(0).locator(".order-step-state")).toContainText(
    "In corso",
  );
  await expect(page.locator(".order-step-title small")).toHaveCount(0);
  const incompleteReminder = page.locator(
    ".sticky-order-actions.needs-attention",
  );
  await expect(incompleteReminder).toContainText(
    "Completa: Cliente e contatto",
  );
  await expect(incompleteReminder).toHaveCSS(
    "background-color",
    "rgb(255, 248, 217)",
  );
  await expect(incompleteReminder).toHaveCSS(
    "border-color",
    "rgb(228, 182, 0)",
  );
  await expect(page.locator(".order-step-collapse.is-expanded")).toHaveCount(1);
  const cardGaps = async () =>
    cards.evaluateAll((elements) =>
      elements.slice(1).map((element, index) => {
        const previous = elements[index].getBoundingClientRect();
        return element.getBoundingClientRect().top - previous.bottom;
      }),
    );
  await expect(page.locator(".order-wizard")).toHaveCSS("row-gap", "22px");
  await expect
    .poll(async () => (await cardGaps()).every((gap) => gap > 0))
    .toBe(true);
  const paymentHeading = cards.nth(3).locator(".order-step-heading");
  await expect(paymentHeading).toHaveAttribute("aria-expanded", "false");
  await paymentHeading.click();
  await expect(paymentHeading).toHaveAttribute("aria-expanded", "true");
  await expect(cards.nth(3)).toHaveClass(/is-selected/);
  await expect(cards.nth(0)).not.toHaveClass(/is-selected/);
  await expect(page.locator(".order-step-collapse.is-expanded")).toHaveCount(1);
  await cards.nth(3).getByLabel("Incasso alla creazione (€)").fill("10");
  await expect(cards.nth(3)).toHaveClass(/is-selected/);
  expect((await cardGaps()).every((gap) => gap > 18)).toBe(true);
  const actionGap = await page
    .locator(".sticky-order-actions")
    .evaluate(
      (actions, card) =>
        actions.getBoundingClientRect().top -
        (card as Element).getBoundingClientRect().bottom,
      await cards.nth(3).elementHandle(),
    );
  expect(actionGap).toBeGreaterThanOrEqual(20);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cards.nth(0).locator(".order-step-heading")).toHaveCSS(
    "padding",
    "15px",
  );
  await expect(cards.nth(0).locator(".order-step-state")).toHaveCSS(
    "display",
    "none",
  );
});

test("inputs and expanding controls scroll only when interaction space is tight", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/orders/new");
  await page.waitForLoadState("networkidle");
  const customer = page.getByRole("combobox", {
    name: "Cerca cliente",
    exact: true,
  });
  await customer.focus();
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await customer.evaluate((element) => (element as HTMLElement).blur());
  await page.setViewportSize({ width: 1280, height: 450 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await customer.click();
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  const customerTop = await customer.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  expect(customerTop).toBeGreaterThanOrEqual(130);
  expect(customerTop).toBeLessThanOrEqual(210);

  const paymentHeading = page
    .locator(".order-step-card")
    .nth(3)
    .locator(".order-step-heading");
  await paymentHeading.evaluate((element) => {
    const box = element.getBoundingClientRect();
    window.scrollBy({ top: box.bottom - window.innerHeight + 8 });
  });
  await paymentHeading.evaluate((element) => (element as HTMLElement).click());
  await expect(paymentHeading).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      paymentHeading.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBeGreaterThan(120);
  await expect
    .poll(() =>
      paymentHeading.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBeLessThan(230);
});

test("device step gates faults and advances only after faults and due date", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  const card = page.locator(".order-step-card").nth(1);
  const dueDate = page.getByLabel("Consegna prevista", { exact: true });
  const inspection = card.locator(".inspection-choice button");
  const display = page.getByLabel("Display rotto", { exact: true });
  const power = page.getByLabel("Non si accende", { exact: true });
  const addDevice = page.getByRole("button", {
    name: "Dispositivo",
    exact: true,
  });

  await expect(addDevice).toBeEnabled();
  await expect(addDevice).toHaveClass(/add-device-action/);
  await expect(addDevice).toHaveCSS("border-top-style", "dashed");
  await addDevice.hover();
  await expect(addDevice).toHaveCSS("background-color", "rgb(255, 248, 217)");
  await chooseRepairDevice(page, "Apple iPhone 13");
  const deviceSummary = card.locator(".repair-device-summary");
  const changeDevice = deviceSummary.getByRole("button", {
    name: "Cambia dispositivo",
    exact: true,
  });
  await expect(deviceSummary).toContainText("Apple iPhone 13");
  await deviceSummary.hover();
  await expect(changeDevice).toHaveCSS("color", "rgb(160, 111, 0)");
  await expect
    .poll(() =>
      changeDevice
        .locator("span")
        .evaluate((element) => getComputedStyle(element, "::after").transform),
    )
    .toContain("1, 0, 0, 1");
  await expect
    .poll(() =>
      changeDevice
        .locator("svg")
        .evaluate((element) => getComputedStyle(element).transform),
    )
    .toContain("4, 0");
  await changeDevice.click();
  const picker = page.getByRole("dialog", {
    name: "Dispositivo del cliente",
  });
  await expect(
    picker.locator(".customer-device-row.is-selected"),
  ).toContainText("Apple iPhone 13");
  const selectedDeviceRow = picker.locator(".customer-device-row.is-selected");
  await expect(selectedDeviceRow.locator('input[type="checkbox"]')).toHaveCount(
    0,
  );
  await expect(selectedDeviceRow).toHaveCSS("border-radius", "10px");
  await expect(selectedDeviceRow).toHaveCSS(
    "border-top-color",
    "rgb(232, 187, 21)",
  );
  await selectedDeviceRow.hover();
  const editSelectedDevice = selectedDeviceRow.getByRole("button", {
    name: "Modifica dispositivo",
    exact: true,
  });
  await expect(editSelectedDevice).toBeVisible();
  await expect(
    selectedDeviceRow.getByRole("button", {
      name: "Elimina dispositivo",
      exact: true,
    }),
  ).toBeVisible();
  await editSelectedDevice.click();
  const editSelectedDeviceDialog = page.getByRole("dialog", {
    name: "Modifica dispositivo",
  });
  await editSelectedDeviceDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(editSelectedDeviceDialog).toHaveCount(0);
  await expect(picker).toBeVisible();
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await deviceSummary.hover();
  await changeDevice.click();
  await picker
    .getByRole("button", { name: "Dispositivo", exact: true })
    .click();
  const newDeviceDialog = page.getByRole("dialog", {
    name: "Nuovo dispositivo",
  });
  await chooseBusinessOption(page, "Marca", "Apple", newDeviceDialog);
  await chooseBusinessOption(page, "Modello", "iPhone 14", newDeviceDialog);
  await newDeviceDialog
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await expect(newDeviceDialog).toHaveCount(0);
  await expect(picker).toBeVisible();
  await expect(
    picker.locator(".customer-device-row.is-selected"),
  ).toContainText("Apple iPhone 14");
  await expect(picker.locator(".customer-device-row.is-selected")).toHaveCSS(
    "border-top-color",
    "rgb(232, 187, 21)",
  );
  const unselectedDeviceRow = picker
    .locator(".customer-device-row:not(.is-selected)")
    .first();
  await unselectedDeviceRow.hover();
  await expect(unselectedDeviceRow).toHaveCSS(
    "border-top-color",
    "rgb(232, 187, 21)",
  );
  await expect(unselectedDeviceRow).toHaveCSS(
    "border-left-color",
    "rgb(232, 187, 21)",
  );
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(deviceSummary).toContainText("Apple iPhone 14");
  await expect(display).toBeEnabled();
  await expect(inspection).toBeEnabled();
  await expect(dueDate).toHaveCount(0);

  await display.check();
  await power.check();
  await expect(card).toHaveClass(/is-selected/);
  await expect(dueDate).toBeEnabled();
  await inspection.click();
  await expect(display).toBeChecked();
  await expect(power).toBeChecked();
  await expect(display).toBeDisabled();
  await inspection.click();
  await expect(display).toBeEnabled();
  await expect(display).toBeChecked();

  await dueDate.fill("2099-12-31");
  await expect(card.locator(".order-step-state")).toHaveText("Completato");
  await expect(page.locator(".order-step-card").nth(2)).toHaveClass(
    /is-selected/,
  );
});

test("repair project picker selects multiple items and removes a summary on hover", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await chooseRepairDevice(page, "Apple iPhone 13");
  await page.getByLabel("Display rotto", { exact: true }).check();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  await expect(
    page.locator(".order-step-card").nth(2).locator(".order-step-heading"),
  ).toHaveAttribute("aria-expanded", "true");

  const addProject = page.getByRole("button", {
    name: "Intervento",
    exact: true,
  });
  await expect(addProject).toBeVisible();
  const [projectButtonWidth, projectEditorWidth] = await Promise.all([
    addProject.evaluate((element) => element.getBoundingClientRect().width),
    page
      .locator(".items-editor")
      .evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(Math.abs(projectButtonWidth - projectEditorWidth)).toBeLessThan(1);
  await addProject.hover();
  await expect(addProject).toHaveCSS("background-color", "rgb(255, 248, 217)");
  await addProject.click();
  const picker = page.getByRole("dialog", {
    name: "Seleziona interventi",
  });
  await expect(picker).toHaveCSS("width", "900px");
  const displayProject = repairProjectOption(picker, "sostituzione display");
  await expect(displayProject).toHaveCount(1);
  await displayProject.click();
  await picker.getByRole("button", { name: "Intervento", exact: true }).click();
  const customDialog = page.getByRole("dialog", {
    name: "Intervento personalizzato",
  });
  await customDialog
    .getByLabel("Intervento *", { exact: true })
    .fill("Pulizia completa");
  await customDialog
    .getByLabel("Prezzo originale (€) *", { exact: true })
    .fill("75");
  await customDialog
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await expect(customDialog).toHaveCount(0);
  await expect(
    picker.locator(".quick-service-picker-option.is-selected"),
  ).toHaveCount(2);
  await expect(picker).toContainText("2 interventi selezionati");
  const pickerListBox = await picker
    .locator(".quick-service-picker-list")
    .boundingBox();
  const firstSelectedBox = await picker
    .locator(".quick-service-picker-option.is-selected")
    .first()
    .boundingBox();
  expect(firstSelectedBox!.x).toBeGreaterThan(pickerListBox!.x);
  expect(firstSelectedBox!.y).toBeGreaterThan(pickerListBox!.y);
  expect(firstSelectedBox!.x + firstSelectedBox!.width).toBeLessThan(
    pickerListBox!.x + pickerListBox!.width,
  );
  const customProjectRow = picker
    .locator(".quick-service-picker-service")
    .filter({ hasText: "Pulizia completa" });
  await customProjectRow.hover();
  const editCustomProject = customProjectRow.getByRole("button", {
    name: "Modifica dati Pulizia completa",
    exact: true,
  });
  await expect(editCustomProject).toBeVisible();
  await expect(
    customProjectRow.getByRole("button", {
      name: "Rimuovi Pulizia completa",
      exact: true,
    }),
  ).toBeVisible();
  await editCustomProject.click();
  const editCustomProjectDialog = page.getByRole("dialog", {
    name: "Modifica dati",
  });
  await editCustomProjectDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(editCustomProjectDialog).toHaveCount(0);
  await expect(picker).toBeVisible();
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();

  const summaries = page.locator(".selected-project-summary");
  await expect(summaries).toHaveCount(2);
  await expect(addProject).toBeVisible();
  const catalogSummary = summaries.filter({
    hasText: "sostituzione display",
  });
  await expect(catalogSummary).toHaveCSS("display", "grid");
  const projectSummaryColumnCount = await catalogSummary.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  );
  expect(projectSummaryColumnCount).toBe(4);
  const removeCatalog = catalogSummary.getByRole("button", {
    name: "Rimuovi sostituzione display",
    exact: true,
  });
  await catalogSummary.locator(".summary-price-button").click();
  await expect(removeCatalog).toHaveCount(0);
  await catalogSummary.locator(".quote-summary-price").press("Enter");
  await catalogSummary.hover();
  await expect(removeCatalog).toHaveCSS("opacity", "1");
  await removeCatalog.click();
  await expect(summaries).toHaveCount(1);
  const customSummary = summaries.filter({ hasText: "Pulizia completa" });
  const remove = customSummary.getByRole("button", {
    name: "Rimuovi Pulizia completa",
    exact: true,
  });
  await expect(remove).toHaveCSS("opacity", "0");
  await page.mouse.move(0, 0);
  await customSummary.hover();
  await expect(remove).toHaveCSS("opacity", "1");
  await expect(remove).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(remove).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await remove.hover();
  await expect(remove).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(remove).toHaveCSS("background-color", "rgb(255, 240, 238)");
  await expect(remove).toHaveCSS("color", "rgb(166, 70, 66)");
  await remove.click();
  await expect(summaries).toHaveCount(0);
});

test("single operator opens every business page without login", async ({
  page,
}) => {
  for (const path of [
    "/",
    "/orders",
    "/retail",
    "/retail/sales",
    "/inventory",
    "/customers",
    "/prices",
    "/settings",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page).not.toHaveURL(/login/);
  }
  await expect(
    page.getByRole("link", { name: "Collaboratori", exact: true }),
  ).toHaveCount(0);
  await page.goto("/");
  await expect(
    page.getByRole("link", {
      name: "Nuova scheda di servizio",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Andamento", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Statistiche dettagliate", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Statistiche dettagliate", exact: true }),
  ).toHaveCount(0);
  await page.goto("/reports?day=2026-10-03");
  await expect(page).toHaveURL(/\/\?receipts=2026-10&day=2026-10-03$/);
  await expect(page.locator(".dashboard-receipts")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Incassi mensili" }),
  ).toBeVisible();
  await page.goto("/reports?month=2025-09");
  await expect(page).toHaveURL(/\/\?receipts=2025-09$/);
  await expect(
    page.getByRole("dialog", { name: "Incassi mensili" }),
  ).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /Lingua/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Dati / })).toBeVisible();
  await page.goto("/orders?month=");
  await expect(
    page.getByRole("link", {
      name: "Servizio di riparazione",
      exact: true,
    }),
  ).toHaveClass(/button-primary/);
  await expect(
    page.getByRole("link", { name: "Servizio rapido", exact: true }),
  ).toHaveClass(/button-primary/);
  for (const [path, name] of [
    ["/customers", "Nuovo cliente"],
    ["/prices", "Nuova regola"],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("button", { name, exact: true }).first(),
    ).toHaveClass(/button-primary/);
  }
  await page.goto("/login");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/team");
  await expect(page).toHaveURL(/\/$/);
});

test("uses part-specific prices without overwriting a manual quote", async ({
  page,
}) => {
  await page.goto("/prices");
  await page
    .getByRole("searchbox", { name: "Cerca" })
    .fill("sostituzione display");
  await page.getByRole("button", { name: "Apple", exact: true }).click();
  const row = page
    .locator(".price-rule-row")
    .filter({ has: page.getByText("sostituzione display", { exact: true }) })
    .first();
  await expect(row).toBeVisible();
  await row.hover();
  await row
    .getByRole("button", { name: "Modifica preventivo", exact: true })
    .click();
  const quoteDialog = page.getByRole("dialog", {
    name: "Modifica preventivo",
    exact: true,
  });
  const options = quoteDialog.locator(".price-rule-editor-options");
  await expect(
    options.getByText("Display LCD standard", { exact: true }),
  ).toBeVisible();
  await expect(
    options.getByText("Display OLED alta qualità", { exact: true }),
  ).toBeVisible();
  await expect(
    options.getByRole("button", { name: "Opzione ricambio", exact: true }),
  ).toBeVisible();
  await options
    .getByRole("button", { name: "Opzione ricambio", exact: true })
    .click();
  const newOption = page.getByRole("dialog", {
    name: "Nuova opzione ricambio",
    exact: true,
  });
  await expect(
    newOption.getByRole("combobox", {
      name: "Ricambio richiesto",
      exact: true,
    }),
  ).toBeVisible();
  const optionPartSearch = newOption.getByRole("combobox", {
    name: "Ricambio richiesto",
    exact: true,
  });
  await expect(
    newOption.getByRole("button", { name: "Ricambio", exact: true }),
  ).toHaveCount(0);
  const newPartName = `Ricambio opzione ${Date.now()}`;
  await optionPartSearch.fill(newPartName);
  const addPart = newOption.getByRole("button", {
    name: "Ricambio",
    exact: true,
  });
  await expect(addPart).toBeVisible();
  const createControlLayout = await newOption
    .locator(".business-combobox-control")
    .evaluate((control) => {
      const chevron = control
        .querySelector(".business-combobox-chevron")!
        .getBoundingClientRect();
      const create = control
        .querySelector(".business-select-create")!
        .getBoundingClientRect();
      return { chevronRight: chevron.right, createLeft: create.left };
    });
  expect(createControlLayout.createLeft).toBeGreaterThanOrEqual(
    createControlLayout.chevronRight,
  );
  await newOption
    .getByRole("button", { name: "Ricambio", exact: true })
    .click();
  const newPart = page.getByRole("dialog", {
    name: /Nuovo ricambio/,
  });
  await expect(
    newPart.getByLabel("Nome ricambio", { exact: true }),
  ).toHaveValue(newPartName);
  await newPart.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(newOption).toBeVisible();
  await chooseBusinessOption(
    page,
    "Ricambio richiesto",
    "Display OLED Test",
    newOption,
  );
  await expect(
    newOption.getByLabel("Nome opzione", { exact: true }),
  ).toHaveValue("Display OLED Test");
  await expect(
    newOption.getByRole("button", { name: "- Quantità ricambio" }),
  ).toBeVisible();
  await expect(
    newOption.getByRole("button", { name: "+ Quantità ricambio" }),
  ).toBeVisible();
  await newOption.getByRole("button", { name: "Annulla" }).click();

  await fillOrder(page);
  const optionSummary = page.locator(".price-option-picker-summary");
  await expect(optionSummary).toContainText("Prezzo di listino");
  await expect(optionSummary).toContainText("100,00 €");
  const optionSummaryLayout = await optionSummary.evaluate((summary) => {
    const value = summary
      .querySelector(".selection-summary-value")!
      .getBoundingClientRect();
    const actions = summary
      .querySelector(".selected-part-actions")!
      .getBoundingClientRect();
    return { valueTop: value.top, actionsTop: actions.top };
  });
  expect(
    Math.abs(optionSummaryLayout.valueTop - optionSummaryLayout.actionsTop),
  ).toBeLessThanOrEqual(8);
  const removeOption = optionSummary.getByRole("button", {
    name: "Rimuovi Display LCD Test",
    exact: true,
  });
  await optionSummary.evaluate((summary) => {
    const focused = summary.querySelector(":focus");
    if (focused instanceof HTMLElement) focused.blur();
  });
  await page.mouse.move(0, 0);
  await expect(removeOption).toHaveCSS("opacity", "0");
  await optionSummary.hover();
  await expect(removeOption).toHaveCSS("opacity", "1");
  await removeOption.click();
  await expect(page.locator(".selected-part-summary")).toContainText(
    "Nessun ricambio richiesto",
  );
  await choosePriceOption(page, "Display LCD standard");
  await choosePriceOption(page, "Display OLED alta qualità");
  const currentQuote = page.getByRole("button", {
    name: "Modifica dati Preventivo attuale",
    exact: true,
  });
  await expect(currentQuote).toContainText("119,00");
  const removeOled = optionSummary.getByRole("button", {
    name: "Rimuovi Display OLED Test",
    exact: true,
  });
  await optionSummary.hover();
  await removeOled.click();
  await expect(currentQuote).toContainText("100,00");
  await expect(optionSummary).toContainText("Nessun ricambio richiesto");
  await choosePriceOption(page, "Display LCD standard");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(optionSummary).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 844 });
  await optionSummary.locator(".summary-action").click();
  const optionPicker = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await expect(optionPicker.getByRole("checkbox")).toHaveCount(0);
  await expect(
    optionPicker.getByRole("button", {
      name: /Nessun ricambio richiesto/,
    }),
  ).toHaveClass(/price-option-card/);
  const oledOption = optionPicker
    .locator(".price-option-choice")
    .filter({ hasText: "Display OLED alta qualità" });
  const lcdOption = optionPicker
    .locator(".price-option-choice")
    .filter({ hasText: "Display LCD standard" });
  await expect(lcdOption).toHaveCSS("border-radius", "12px");
  await expect(lcdOption).toHaveCSS("padding", "14px");
  await expect(lcdOption).toHaveCSS(
    "transition-property",
    "background-color, box-shadow, transform",
  );
  await page.mouse.move(0, 0);
  await expect(lcdOption).toHaveCSS("background-color", "rgb(255, 250, 240)");
  await oledOption.hover();
  await expect(oledOption).toHaveCSS("background-color", "rgb(255, 249, 232)");
  await oledOption.click();
  await expect(oledOption).toHaveClass(/is-selected/);
  await expect(optionSummary).toContainText("Display LCD standard");
  await optionPicker
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(optionSummary).toContainText("Display LCD standard");
  await optionSummary.locator(".summary-action").click();
  await optionPicker
    .getByRole("button", { name: /^Nessun ricambio richiesto/ })
    .click();
  await optionPicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(optionSummary).toContainText("Nessun ricambio richiesto");
  await choosePriceOption(page, "Display LCD standard");
  await optionSummary.locator(".summary-action").click();
  await optionPicker
    .getByRole("button", { name: "Opzione ricambio", exact: true })
    .click();
  const newOrderOption = page.getByRole("dialog", {
    name: "Nuova opzione ricambio",
    exact: true,
  });
  await expect(
    newOrderOption.getByRole("combobox", {
      name: "Ricambio richiesto",
      exact: true,
    }),
  ).toBeVisible();
  await newOrderOption
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(optionPicker).toBeVisible();
  await optionPicker
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(optionSummary).toContainText("Display LCD standard");
  await choosePriceOption(page, "Display OLED alta qualità");
  const quote = page.getByRole("button", {
    name: "Modifica dati Preventivo attuale",
    exact: true,
  });
  await expect(quote).toContainText("119,00");
  await quote.click();
  const input = page.getByLabel("Prezzo originale (€) 1", { exact: true });
  await input.fill("105");
  await input.press("Enter");
  await optionSummary.locator(".summary-action").click();
  await optionPicker
    .getByRole("button", { name: /^Nessun ricambio richiesto/ })
    .click();
  await optionPicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(quote).toContainText("105,00");
  await expect(page.getByText(/nuovo suggerito è 100,00/)).toBeVisible();
  await page
    .getByRole("button", { name: "Usa il nuovo suggerito", exact: true })
    .click();
  await expect(quote).toContainText("100,00");
  await choosePriceOption(page, "Display LCD standard");
  await save(page);
  const details = page.getByTestId("details-card");
  await details.locator(".order-card-heading").click();
  const savedPart = details.locator(".selected-part-summary");
  await expect(savedPart).toContainText("Display LCD standard");
  await expect(savedPart).toContainText("Prezzo di listino");
  await expect(savedPart).toContainText("100,00 €");

  await state(page, "READY");
  await page.getByRole("button", { name: /Incassa e consegna/ }).click();
  await page
    .getByRole("button", { name: "Riparazione in garanzia", exact: true })
    .click();
  const rework = page.getByRole("dialog");
  await expect(rework.locator(".selected-part-summary")).toContainText(
    "Display LCD standard",
  );
  await expect(rework.locator(".selected-part-summary")).toContainText(
    "Prezzo di listino 100,00 €",
  );
  await choosePriceOption(page, "Display OLED alta qualità", rework);
  await expect(rework.locator(".selected-part-summary")).toContainText(
    "Display OLED alta qualità",
  );
});

test("creates a repair part and quote option directly from a new order", async ({
  page,
}) => {
  await fillOrder(page);
  const optionSummary = page.locator(".price-option-picker-summary");
  await optionSummary.locator(".summary-action").click();
  const optionPicker = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await optionPicker
    .getByRole("button", { name: "Opzione ricambio", exact: true })
    .click();
  const newOption = page.getByRole("dialog", {
    name: "Nuova opzione ricambio",
    exact: true,
  });
  const productName = `Ricambio ordine ${Date.now()}`;
  await newOption
    .getByRole("combobox", { name: "Ricambio richiesto", exact: true })
    .fill(productName);
  await newOption
    .getByRole("button", { name: "Ricambio", exact: true })
    .click();
  const productDialog = page.getByRole("dialog", {
    name: "Nuovo ricambio per riparazione",
    exact: true,
  });
  await expect(
    productDialog.getByLabel("Nome ricambio", { exact: true }),
  ).toHaveValue(productName);
  await productDialog.getByLabel("Costo (€)", { exact: true }).fill("12");
  await productDialog.getByLabel("Scorta iniziale", { exact: true }).fill("5");
  await productDialog.getByLabel("Scorta minima", { exact: true }).fill("1");
  await productDialog
    .getByRole("button", { name: "Crea e seleziona", exact: true })
    .click();
  await expect(productDialog).toHaveCount(0);
  await expect(
    newOption.getByLabel("Nome opzione", { exact: true }),
  ).toHaveValue(productName);
  await newOption
    .getByLabel("Prezzo suggerito (€)", { exact: true })
    .fill("127");
  await newOption.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(newOption).toHaveCount(0);
  await expect(optionPicker).toBeVisible();
  await expect(
    optionPicker
      .locator(".price-option-choice")
      .filter({ hasText: productName }),
  ).toBeVisible();
  await choosePriceOption(page, productName, optionPicker);
  await expect(optionSummary).toContainText(productName);
  await expect(optionSummary).toContainText("127,00 €");
  await expect(optionSummary).toHaveCSS("display", "grid");
  const partSummaryColumnCount = await optionSummary.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  );
  expect(partSummaryColumnCount).toBe(4);
  await expect(
    page.getByRole("button", {
      name: "Modifica dati Preventivo attuale",
      exact: true,
    }),
  ).toContainText("127,00");
  await save(page);

  const details = page.getByTestId("details-card");
  await details.locator(".order-card-heading").click();
  const savedPart = details.locator(".selected-part-summary");
  await expect(savedPart).toContainText(productName);
  await expect(savedPart).toContainText("Prezzo di listino");
  await expect(savedPart).toContainText("127,00 €");
  await expect(savedPart).toContainText("Impegnata 1");

  await page.goto("/inventory");
  const inventory = page.locator(".inventory-main");
  await inventory
    .getByLabel("Cerca prodotto, ricambio, marca o modello", { exact: true })
    .fill(productName);
  const productRow = inventory
    .locator(".inventory-table tbody tr")
    .filter({ hasText: productName });
  await expect(productRow).toContainText("Apple / Telefono / iPhone 13");
});

test("keeps a paid quote when its repair part is explicitly removed", async ({
  page,
}) => {
  await fillOrder(page);
  await choosePriceOption(page, "Display OLED alta qualità");
  await page.getByRole("button", { name: /^04 Pagamento/ }).click();
  await page
    .getByLabel("Incasso alla creazione (€)", { exact: true })
    .fill("20");
  await save(page);
  await expect(page.locator(".balance-card")).toContainText(
    "Incassato: 20,00 €",
  );

  const details = page.getByTestId("details-card");
  const detailsHeading = details.locator(".order-card-heading");
  if ((await detailsHeading.getAttribute("aria-expanded")) !== "true")
    await detailsHeading.click();
  await details.locator(".selected-part-summary .summary-action").click();
  const optionPicker = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await optionPicker
    .getByRole("button", { name: /^Nessun ricambio richiesto/ })
    .click();
  await optionPicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(optionPicker).toHaveCount(0);
  const summary = details.locator(".detail-repair-summaries");
  await expect(page.getByText(/nuovo suggerito è 100,00/)).toBeVisible();
  await expect(summary.locator(".selected-project-summary")).toContainText(
    "119,00 €",
  );
  await details.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(details).not.toHaveClass(/is-editing/);
  await expect(page.locator(".message.error")).toHaveCount(0);
  await page.reload();
  if ((await detailsHeading.getAttribute("aria-expanded")) !== "true")
    await detailsHeading.click();
  await expect(details.locator(".selected-project-summary")).toContainText(
    "119,00 €",
  );
  await expect(details.locator(".selected-part-summary")).toContainText(
    "Nessuno",
  );
});

test("returns an unpaid detail quote to its base price when the part is removed", async ({
  page,
}) => {
  await fillOrder(page);
  await choosePriceOption(page, "Display OLED alta qualità");
  await save(page);

  const details = page.getByTestId("details-card");
  const detailsHeading = details.locator(".order-card-heading");
  if ((await detailsHeading.getAttribute("aria-expanded")) !== "true")
    await detailsHeading.click();
  const quoteSummary = details.locator(".detail-repair-summaries");
  await expect(quoteSummary.locator(".selected-project-summary")).toContainText(
    "119,00 €",
  );
  await details.locator(".selected-part-summary .summary-action").click();

  const databaseUrl = process.env.DATABASE_URL;
  const orderId = new URL(page.url()).pathname.split("/").pop();
  if (
    !orderId ||
    !databaseUrl ||
    !new URL(databaseUrl).pathname.endsWith("_test")
  )
    throw new Error(
      "Repair detail E2E requires an order in a *_test database.",
    );
  const db = new PrismaClient();
  try {
    const originalItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId },
    });
    const productId = originalItem.requiredProductId;
    expect(productId).toBeTruthy();
    expect(originalItem.final.toString()).toBe("119");
    expect(
      await db.workOrderProduct.count({
        where: {
          orderId,
          productId: productId!,
          kind: "REPAIR_PART",
          consumedAt: null,
        },
      }),
    ).toBe(1);

    const optionPicker = page.getByRole("dialog", {
      name: "Opzioni ricambio",
      exact: true,
    });
    await optionPicker
      .getByRole("button", { name: /^Nessun ricambio richiesto/ })
      .click();
    await optionPicker
      .getByRole("button", { name: "Conferma selezione", exact: true })
      .click();
    await expect(optionPicker).toHaveCount(0);
    await expect(
      quoteSummary.locator(".selected-project-summary"),
    ).toContainText("100,00 €");
    await expect(quoteSummary.locator(".selected-part-summary")).toContainText(
      "Nessuno",
    );
    await details.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect(details).not.toHaveClass(/is-editing/);
    await expect(
      quoteSummary.locator(".selected-project-summary"),
    ).toContainText("119,00 €");
    await expect(quoteSummary.locator(".selected-part-summary")).toContainText(
      "Display OLED Test",
    );

    await details.locator(".selected-part-summary .summary-action").click();
    const savePicker = page.getByRole("dialog", {
      name: "Opzioni ricambio",
      exact: true,
    });
    await savePicker
      .getByRole("button", { name: /^Nessun ricambio richiesto/ })
      .click();
    await savePicker
      .getByRole("button", { name: "Conferma selezione", exact: true })
      .click();
    await expect(
      quoteSummary.locator(".selected-project-summary"),
    ).toContainText("100,00 €");

    await details.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(details).not.toHaveClass(/is-editing/);
    await expect(page.locator(".message.error")).toHaveCount(0);
    await page.reload();
    if ((await detailsHeading.getAttribute("aria-expanded")) !== "true")
      await detailsHeading.click();
    await expect(details.locator(".selected-project-summary")).toContainText(
      "100,00 €",
    );
    await expect(details.locator(".selected-part-summary")).toContainText(
      "Nessuno",
    );
    const savedItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId },
    });
    expect(savedItem).toMatchObject({
      requiredProductId: null,
      requiredProductName: "",
      priceOptionId: null,
    });
    expect(savedItem.final.toString()).toBe("100");
    expect(
      await db.workOrderProduct.count({
        where: {
          orderId,
          productId: productId!,
          kind: "REPAIR_PART",
          consumedAt: null,
        },
      }),
    ).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

test("shows a retired repair part in its historical order and hides it from new choices", async ({
  page,
}) => {
  await resetRetirementFixture();
  try {
    await page.goto("/orders/new");
    await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
    await chooseRepairDevice(page, "Apple iPhone 13");
    await page.getByLabel("Display rotto", { exact: true }).check();
    await page
      .getByLabel("Consegna prevista", { exact: true })
      .fill("2099-12-31");
    await chooseRepairProjects(page, [retirementFixture.project]);
    await choosePriceOption(page, retirementFixture.optionName);
    const currentQuote = page.getByRole("button", {
      name: "Modifica dati Preventivo attuale",
      exact: true,
    });
    await expect(currentQuote).toContainText("119,00");
    await save(page);
    const orderUrl = page.url();

    await page.goto("/inventory");
    const inventory = page.locator(".inventory-main");
    await inventory
      .getByLabel("Cerca prodotto, ricambio, marca o modello", {
        exact: true,
      })
      .fill(retirementFixture.productName);
    const productRow = inventory
      .locator(".inventory-table tbody tr[data-inventory-product]")
      .filter({ hasText: retirementFixture.productName });
    await expect(productRow).toBeVisible();
    const productId = await productRow.getAttribute("data-inventory-product");
    expect(productId).toBeTruthy();
    await productRow.click();
    const activeProductRow = inventory.locator(
      `tr[data-inventory-product="${productId}"]`,
    );
    const usage = activeProductRow.getByRole("button", {
      name: "Utilizzo",
      exact: true,
    });
    await expect(usage).toHaveCount(1);
    await usage.click();
    await page
      .locator(".business-select-panel.is-entering")
      .getByRole("option", { name: "Vendita", exact: true })
      .click();
    const updateResponse = page.waitForResponse(
      (response) => response.request().method() === "POST",
    );
    await page.getByRole("heading", { name: "Magazzino" }).click();
    await updateResponse;
    await page.reload();
    await inventory
      .getByLabel("Cerca prodotto, ricambio, marca o modello", { exact: true })
      .fill(retirementFixture.productName);
    await expect(productRow).toContainText("Vendita");

    await page.goto("/orders/new");
    await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
    await chooseRepairDevice(page, "Apple iPhone 13");
    await page.getByLabel("Display rotto", { exact: true }).check();
    await page
      .getByLabel("Consegna prevista", { exact: true })
      .fill("2099-12-31");
    await chooseRepairProjects(page, [retirementFixture.project]);
    const openOptions = page.getByRole("button", {
      name: "Opzioni ricambio",
      exact: true,
    });
    await expect(openOptions).toHaveCount(1);
    await openOptions.click();
    const optionPicker = page.getByRole("dialog", {
      name: "Opzioni ricambio",
      exact: true,
    });
    await expect(
      optionPicker.locator(".price-option-choice").filter({
        hasText: retirementFixture.optionName,
      }),
    ).toHaveCount(0);
    await optionPicker
      .getByRole("button", { name: "Annulla", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Modifica dati Preventivo attuale",
        exact: true,
      }),
    ).toContainText("30,00");

    await page.goto("/orders/new");
    await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
    await chooseRepairDevice(page, "Apple iPhone 13");
    await page.getByLabel("Display rotto", { exact: true }).check();
    await page
      .getByLabel("Consegna prevista", { exact: true })
      .fill("2099-12-31");
    await chooseRepairProjects(page, ["sostituzione display"]);
    await expect(page.locator(".price-option-picker-summary")).toContainText(
      "Display LCD standard",
    );
    await expect(
      page.getByRole("button", {
        name: "Modifica dati Preventivo attuale",
        exact: true,
      }),
    ).toContainText("100,00");

    await page.goto(orderUrl);
    const details = page.getByTestId("details-card");
    const detailsHeading = details.locator(".order-card-heading");
    if ((await detailsHeading.getAttribute("aria-expanded")) !== "true")
      await detailsHeading.click();
    const savedPart = details.locator(".selected-part-summary");
    await expect(savedPart).toContainText(retirementFixture.productName);
    await expect(savedPart).toContainText("Prezzo di listino");
    await expect(savedPart).toContainText("119,00 €");
    await expect(savedPart).not.toContainText("Nessun ricambio");
    await savedPart.locator(".summary-action").click();
    await page
      .getByRole("dialog", { name: "Opzioni ricambio", exact: true })
      .getByRole("button", { name: "Chiudi", exact: true })
      .click();
    await expect(savedPart).toContainText(retirementFixture.productName);
    await details.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect(details).not.toHaveClass(/is-editing/);
    await expect(details.locator(".selected-part-summary")).toContainText(
      retirementFixture.productName,
    );
  } finally {
    await resetRetirementFixture();
  }
});

test("switching repair and quick-service modes keeps both drafts", async ({
  page,
}) => {
  await fillOrder(page, { diagnosis: true });
  const quickMode = page.getByRole("button", {
    name: "Servizio rapido",
    exact: true,
  });
  await quickMode.click();
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  const expectedAt = page.locator(
    '.service-mode-form-quick input[type="datetime-local"]',
  );
  await expectedAt.fill("2099-12-30T17:45");
  await expectedAt.press("Enter");

  await page
    .getByRole("button", { name: "Servizio di riparazione", exact: true })
    .click();
  await expect(
    page
      .locator(".service-mode-form-repair")
      .getByLabel("Consegna prevista", { exact: true }),
  ).toHaveValue("2099-12-31");

  await quickMode.click();
  const quickForm = page.locator(".service-mode-form-quick");
  await expect(quickForm.locator(".selected-customer-summary")).toContainText(
    "Cliente Playwright",
  );
  await expect(quickForm.locator('input[type="datetime-local"]')).toHaveValue(
    "2099-12-30T17:45",
  );
});

test("removing a default repair part persists and allows later reselection", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await createRepairDevice(page, "Apple", "iPhone 14");
  await page.getByLabel("Display rotto", { exact: true }).check();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  await chooseRepairProjects(page, ["sostituzione batteria"]);

  const optionSummary = page.locator(".price-option-picker-summary");
  await expect(optionSummary).toContainText("Batteria Test");
  const removePart = optionSummary.getByRole("button", {
    name: "Rimuovi Batteria Test",
    exact: true,
  });
  await page.mouse.move(0, 0);
  await optionSummary.hover();
  await expect(removePart).toHaveCSS("opacity", "1");
  await removePart.click();
  await expect(page.locator(".selected-part-summary")).toContainText(
    "Nessun ricambio richiesto",
  );
  await save(page);

  const details = page.getByTestId("details-card");
  let savedPart = details.locator(".selected-part-summary");
  await expect(savedPart).toContainText("Nessuno");
  await page.reload();
  savedPart = page
    .getByTestId("details-card")
    .locator(".selected-part-summary");
  await expect(savedPart).toContainText("Nessuno");

  const editDetails = details.getByRole("button", {
    name: "Modifica dati",
    exact: true,
  });
  await details.hover();
  await expect(editDetails).toHaveCSS("opacity", "1");
  await editDetails.click();
  await savedPart.locator(".summary-action").click();
  await choosePriceOption(page, "Batteria Test");
  await details.getByRole("button", { name: "Salva", exact: true }).click();
  savedPart = page
    .getByTestId("details-card")
    .locator(".selected-part-summary");
  await expect(savedPart).toContainText("Batteria Test");
  await details.hover();
  await expect(editDetails).toHaveCSS("opacity", "1");
  await editDetails.click();
  await savedPart.locator(".summary-action").click();
  await choosePriceOption(page, "Nessun ricambio richiesto");
  await details.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(details.locator(".selected-part-summary")).toContainText(
    "Nessuno",
  );
});

test("quick service device cards fit a narrow grid and reveal removal on hover", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/orders/new?type=quick");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");

  const addDevice = page.getByRole("button", {
    name: "Dispositivo",
    exact: true,
  });
  await addDevice.click();
  const devicePicker = page.getByRole("dialog", {
    name: "Dispositivi associati",
  });
  const pickerBox = await devicePicker.boundingBox();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(pickerBox!.x).toBeGreaterThanOrEqual(16);
  expect(
    viewportWidth - (pickerBox!.x + pickerBox!.width),
  ).toBeGreaterThanOrEqual(16);
  const deviceRow = devicePicker
    .locator(".customer-device-row")
    .filter({ hasText: "Apple iPhone 13" });
  await deviceRow.locator('input[type="checkbox"]').check();
  await devicePicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();

  const deviceGrid = page.locator(
    ".service-mode-form-quick .quick-service-device-cards",
  );
  const deviceCard = deviceGrid.locator(
    ".quick-service-device-card:not(.is-add)",
  );
  const removeDevice = deviceCard.getByRole("button", {
    name: /Rimuovi Apple iPhone 13/,
  });
  await expect(deviceCard).toContainText("Apple iPhone 13");
  await expect(deviceGrid).toHaveCSS("display", "grid");
  await expect(deviceGrid).toHaveCSS("gap", "12px");
  await expect(deviceCard).toHaveCSS("min-height", "76px");
  await expect(deviceCard).toHaveCSS("padding", "13px 14px");
  await expect(removeDevice).toHaveCSS("width", "28px");
  await expect(removeDevice).toHaveCSS("border-radius", "50%");
  const narrowDeviceLayout = await deviceGrid.evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns,
    overflows: element.scrollWidth > element.clientWidth,
  }));
  expect(narrowDeviceLayout.columns.split(" ")).toHaveLength(1);
  expect(narrowDeviceLayout.overflows).toBe(false);
  await expect(removeDevice).toHaveCSS("opacity", "0");
  await deviceCard.hover();
  await expect(removeDevice).toHaveCSS("opacity", "1");
  const addDeviceBox = await addDevice.boundingBox();
  const deviceGridBox = await deviceGrid.boundingBox();
  expect(Math.abs(addDeviceBox!.width - deviceGridBox!.width)).toBeLessThan(1);
});

test("quick service device and service selectors retain the large dialog size", async ({
  page,
}) => {
  await page.goto("/orders/new?type=quick");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");

  await page.getByRole("button", { name: "Dispositivo", exact: true }).click();
  const devicePicker = page.getByRole("dialog", {
    name: "Dispositivi associati",
  });
  await expect(devicePicker).toHaveCSS("width", "900px");
  await devicePicker
    .getByRole("button", { name: "Annulla", exact: true })
    .click();

  await page.getByRole("button", { name: "Servizi", exact: true }).click();
  const servicePicker = page.getByRole("dialog", {
    name: "Seleziona servizi",
  });
  await expect(servicePicker).toHaveCSS("width", "900px");
  await servicePicker
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
});

test("manages one quick service for held service orders and retail checkout", async ({
  page,
}) => {
  const serviceName = `Migrazione rapida ${Date.now()}`;
  await page.goto("/orders");
  await page
    .getByRole("link", { name: "Servizio rapido", exact: true })
    .click();
  await expect(page).toHaveURL(/\/orders\/new\?type=quick$/);
  await expect(
    page.getByRole("button", { name: "Servizio rapido", exact: true }),
  ).toHaveClass(/active/);
  const repairMode = page.getByRole("button", {
    name: "Servizio di riparazione",
    exact: true,
  });
  await repairMode.hover();
  await expect(repairMode).toHaveCSS("background-color", "rgb(255, 248, 217)");
  await expect(repairMode).toHaveCSS("transform", "none");
  const modeSwitch = await page.locator(".service-mode-switch").boundingBox();
  expect(modeSwitch!.width).toBeLessThanOrEqual(410);
  await repairMode.click();
  const repairFormWidth = await page
    .locator(".order-wizard")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(repairFormWidth).toBeGreaterThan(0);
  await expect(page.locator(".quick-service-layout")).toBeHidden();
  await page
    .getByRole("button", { name: "Servizio rapido", exact: true })
    .click();
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await expect(page.locator(".selected-customer-summary")).toContainText(
    "Cliente Playwright",
  );
  await repairMode.click();
  await expect(page.locator(".quick-service-layout")).toBeHidden();
  await page
    .getByRole("button", { name: "Servizio rapido", exact: true })
    .click();
  await expect(page.locator(".selected-customer-summary")).toContainText(
    "Cliente Playwright",
  );
  const quickLayout = page.locator(".quick-service-layout");
  const layoutBeforeDialog = await quickLayout.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, width: rect.width };
  });
  const addQuickDevice = page.getByRole("button", {
    name: "Dispositivo",
    exact: true,
  });
  await expect(addQuickDevice).toHaveCount(1);
  await expect(addQuickDevice).toHaveClass(/add-device-action/);
  await expect(addQuickDevice).toHaveCSS("border-top-style", "dashed");
  await addQuickDevice.hover();
  await expect(addQuickDevice).toHaveCSS(
    "background-color",
    "rgb(255, 248, 217)",
  );
  await expect(addQuickDevice).toHaveCSS("transform", "none");
  await addQuickDevice.click();
  const devicePicker = page.getByRole("dialog", {
    name: "Dispositivi associati",
  });
  const layoutDuringDialog = await quickLayout.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, width: rect.width };
  });
  expect(Math.abs(layoutBeforeDialog.x - layoutDuringDialog.x)).toBeLessThan(1);
  expect(
    Math.abs(layoutBeforeDialog.width - layoutDuringDialog.width),
  ).toBeLessThan(1);
  await expect(
    devicePicker.getByRole("button", {
      name: "Dispositivo",
      exact: true,
    }),
  ).toBeVisible();
  const addPickerDevice = devicePicker.getByRole("button", {
    name: "Dispositivo",
    exact: true,
  });
  await expect(addPickerDevice).toHaveClass(/add-device-action/);
  await expect(addPickerDevice).toHaveCSS("border-top-style", "dashed");
  await addPickerDevice.hover();
  await expect(addPickerDevice).toHaveCSS(
    "background-color",
    "rgb(255, 248, 217)",
  );
  await addPickerDevice.click();
  const newDeviceDialog = page.getByRole("dialog", {
    name: "Nuovo dispositivo",
  });
  const brandCombobox = newDeviceDialog.getByRole("combobox", {
    name: "Marca",
    exact: true,
  });
  await brandCombobox.fill("Apple");
  await expect(
    newDeviceDialog.getByRole("button", {
      name: "Marca personalizzata",
      exact: true,
    }),
  ).toHaveCount(0);
  await brandCombobox.fill(`Marca prova ${Date.now()}`);
  const customBrandButton = newDeviceDialog.getByRole("button", {
    name: "Marca personalizzata",
    exact: true,
  });
  await expect(customBrandButton).toBeVisible();
  expect(
    await customBrandButton.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await chooseBusinessOption(page, "Marca", "Apple", newDeviceDialog);
  await chooseBusinessOption(page, "Modello", "iPhone 14", newDeviceDialog);
  await newDeviceDialog
    .getByLabel("IMEI (facoltativo)", { exact: true })
    .fill("QUICK-SERVICE-TEST");
  await newDeviceDialog
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await expect(newDeviceDialog).toHaveCount(0);
  await expect(devicePicker).toBeVisible();
  await expect(devicePicker).toContainText("QUICK-SERVICE-TEST");
  await expect(
    devicePicker
      .locator(".customer-device-row.is-selected")
      .filter({ hasText: "Apple iPhone 14" }),
  ).toHaveClass(/is-selected/);
  const createdDeviceRow = devicePicker
    .locator(".customer-device-row.is-selected")
    .filter({ hasText: "Apple iPhone 14" });
  await expect(createdDeviceRow).toHaveCSS("border-radius", "10px");
  await expect(createdDeviceRow).toHaveCSS(
    "border-top-color",
    "rgb(232, 187, 21)",
  );
  const editDevice = createdDeviceRow.getByRole("button", {
    name: "Modifica dispositivo",
    exact: true,
  });
  await createdDeviceRow.hover();
  await expect(editDevice).toBeVisible();
  await expect(
    createdDeviceRow.getByRole("button", {
      name: "Elimina dispositivo",
      exact: true,
    }),
  ).toBeVisible();
  await editDevice.click();
  const editDeviceDialog = page.getByRole("dialog", {
    name: "Modifica dispositivo",
  });
  await expect(editDeviceDialog).toBeVisible();
  await editDeviceDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(editDeviceDialog).toHaveCount(0);
  await expect(devicePicker).toBeVisible();
  await expect(
    devicePicker.getByRole("textbox", {
      name: "Cerca dispositivo (marca, modello o IMEI)",
      exact: true,
    }),
  ).toHaveCount(0);
  await devicePicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(
    page.locator(".service-mode-form-quick .quick-service-device-card").first(),
  ).toContainText("Apple iPhone 14");
  await page
    .locator(".service-mode-form-quick .quick-service-device-card.is-add")
    .click();
  const updatedDevicePicker = page.getByRole("dialog", {
    name: "Dispositivi associati",
  });
  const existingDeviceCheckbox = updatedDevicePicker
    .locator(".customer-device-row")
    .filter({ hasText: "Apple iPhone 13" })
    .locator('input[type="checkbox"]');
  await existingDeviceCheckbox.check();
  await expect(existingDeviceCheckbox).toHaveCSS(
    "background-color",
    "rgb(251, 215, 46)",
  );
  const checkboxBox = await existingDeviceCheckbox.boundingBox();
  expect(checkboxBox!.width).toBeLessThanOrEqual(18);
  expect(checkboxBox!.height).toBeLessThanOrEqual(18);
  await expect(
    updatedDevicePicker
      .locator(".customer-device-row")
      .filter({ hasText: "Apple iPhone 13" }),
  ).toHaveClass(/is-selected/);
  await updatedDevicePicker
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(
    page.locator(".service-mode-form-quick .quick-service-device-card"),
  ).toHaveCount(2);
  await page
    .locator(".service-mode-form-quick .quick-service-device-card.is-add")
    .click();
  const confirmedDevicePicker = page.getByRole("dialog", {
    name: "Dispositivi associati",
  });
  await confirmedDevicePicker
    .locator(".customer-device-row")
    .filter({ hasText: "Apple iPhone 13" })
    .locator('input[type="checkbox"]')
    .check();
  await confirmedDevicePicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(
    page.locator(".service-mode-form-quick .quick-service-device-card"),
  ).toHaveCount(3);
  const firstDeviceCard = page
    .locator(".service-mode-form-quick .quick-service-device-card:not(.is-add)")
    .first();
  const removeDevice = firstDeviceCard.getByRole("button", {
    name: /Rimuovi Apple iPhone/,
  });
  await expect(removeDevice).toHaveCSS("opacity", "0");
  await firstDeviceCard.hover();
  await expect(removeDevice).toHaveCSS("opacity", "1");
  const addQuickService = page.getByRole("button", {
    name: "Servizi",
    exact: true,
  });
  await addQuickService.hover();
  await expect(addQuickService).toHaveCSS(
    "background-color",
    "rgb(255, 248, 217)",
  );
  await addQuickService.click();
  const servicePicker = page.getByRole("dialog", {
    name: "Seleziona servizi",
  });
  await expect(
    servicePicker.getByRole("textbox", {
      name: "Cerca servizio",
      exact: true,
    }),
  ).toHaveCount(0);
  await servicePicker
    .getByRole("button", { name: "Servizi", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Nuovo servizio" });
  await editor.getByLabel("Nome servizio", { exact: true }).fill(serviceName);
  await editor.getByLabel("Prezzo predefinito", { exact: true }).fill("29.90");
  await editor.getByLabel("Note", { exact: true }).fill("Due dispositivi");
  await editor.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(servicePicker).toBeVisible();
  const createdService = servicePicker
    .locator(".quick-service-picker-service")
    .filter({ hasText: serviceName });
  await expect(createdService).toHaveClass(/is-selected/);
  await expect(createdService).toHaveClass(/business-list-row/);
  await createdService.hover();
  await expect(createdService).toHaveCSS(
    "background-color",
    "rgb(255, 249, 232)",
  );
  await expect(createdService).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, -1)",
  );
  expect(
    await createdService.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    ),
  ).toContain("rgba(128, 96, 0, 0.08)");
  const editService = createdService.getByRole("button", {
    name: `Modifica dati ${serviceName}`,
    exact: true,
  });
  await expect(editService).toBeVisible();
  await editService.click();
  const editServiceDialog = page.getByRole("dialog", {
    name: "Modifica dati",
  });
  await expect(editServiceDialog).toBeVisible();
  await editServiceDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(editServiceDialog).toHaveCount(0);
  await expect(servicePicker).toBeVisible();
  await servicePicker
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(page.locator(".selected-project-summary")).toHaveCount(0);
  await addQuickService.click();
  const confirmedServicePicker = page.getByRole("dialog", {
    name: "Seleziona servizi",
  });
  await confirmedServicePicker
    .locator(".quick-service-picker-service")
    .filter({ hasText: serviceName })
    .locator('input[type="checkbox"]')
    .check();
  await confirmedServicePicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(page.locator(".selected-project-summary")).toContainText(
    serviceName,
  );
  const removeService = page.getByRole("button", {
    name: `Rimuovi ${serviceName}`,
    exact: true,
  });
  await expect(removeService).toHaveCSS("opacity", "0");
  await page.locator(".selected-project-summary").hover();
  await expect(removeService).toHaveCSS("opacity", "1");
  await expect(
    page.locator(
      ".service-mode-form-quick .quick-service-device-card .quick-service-picker-icon",
    ),
  ).toHaveCount(2);
  const editQuote = page.getByRole("button", {
    name: "Modifica dati Preventivo attuale",
    exact: true,
  });
  await expect(editQuote).toContainText("29,90 €");
  await editQuote.click();
  await expect(removeService).toHaveCount(0);
  await expect(
    page.getByLabel(`${serviceName} Preventivo attuale`, { exact: true }),
  ).toHaveValue("29.90");
  await page
    .getByLabel(`${serviceName} Preventivo attuale`, { exact: true })
    .fill("34.50");
  await page
    .getByLabel(`${serviceName} Preventivo attuale`, { exact: true })
    .press("Enter");
  await expect(editQuote).toContainText("34,50 €");
  await page.locator(".selected-project-summary").hover();
  await expect(removeService).toHaveCSS("opacity", "1");
  const expectedAt = page.locator(
    '.service-mode-form-quick input[type="datetime-local"]',
  );
  await expect(expectedAt).toHaveCSS("cursor", "pointer");
  const expectedAtBox = await expectedAt.boundingBox();
  await expectedAt.click({
    position: { x: 8, y: expectedAtBox!.height / 2 },
  });
  const quickCalendar = page.getByRole("dialog", { name: "Scegli data" });
  await expect(quickCalendar).toBeVisible();
  await expect(quickCalendar.locator('input[type="time"]')).toBeVisible();
  await expect(
    quickCalendar.locator(".date-picker-days [role=gridcell]"),
  ).toHaveCount(42);
  await page.keyboard.press("Escape");
  await expectedAt.fill("2099-12-31T17:00");
  await expectedAt.press("Enter");
  await page.locator(".quick-service-schedule .date-picker-toggle").click();
  await quickCalendar.locator('input[type="time"]').fill("18:30");
  await quickCalendar
    .getByRole("button", { name: "Conferma", exact: true })
    .click();
  await expect(expectedAt).toHaveValue("2099-12-31T18:30");
  await page
    .getByRole("button", {
      name: "Crea scheda di servizio rapido",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/orders\/(?!new)[^/]+$/);
  const serviceCode = (await page.locator("h1").innerText()).trim();
  expect(serviceCode).toMatch(/^S-\d{8}\d{3}$/);
  await expect(page.locator(".page-header p")).toContainText("Servizio rapido");
  const statusAction = page.locator(
    ".detail-primary-actions .status-dropdown .status-dropdown-trigger",
  );
  const detailMoreActions = page.locator(
    ".detail-primary-actions .secondary-actions summary",
  );
  const statusBox = await statusAction.boundingBox();
  const moreBox = await detailMoreActions.boundingBox();
  expect(Math.abs(statusBox!.y - moreBox!.y)).toBeLessThan(1);
  expect(Math.abs(statusBox!.height - moreBox!.height)).toBeLessThan(1);
  await expect(detailMoreActions).toHaveClass(/status-received/);
  expect(
    await statusAction.evaluate((element) => getComputedStyle(element).color),
  ).toBe(
    await detailMoreActions.evaluate(
      (element) => getComputedStyle(element).color,
    ),
  );
  expect(
    await statusAction.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe(
    await detailMoreActions.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  );
  await expect(
    page.getByRole("button", { name: "Avvia servizio", exact: true }),
  ).toHaveCount(0);
  await page.locator(".detail-status .status-dropdown-trigger").click();
  await page.getByRole("option", { name: "In lavorazione" }).click();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toContainText("In lavorazione");
  await expect(
    page.getByRole("button", { name: "Completa servizio", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".quick-service-detail-list")).toContainText(
    serviceName,
  );
  await expect(
    page.getByRole("button", {
      name: "Modifica servizio rapido",
      exact: true,
    }),
  ).toHaveCount(0);
  const quickServiceColumns = await page
    .locator(".quick-service-detail-list > div")
    .first()
    .evaluate((row) => {
      const name = row.firstElementChild!.getBoundingClientRect();
      const price = row.lastElementChild!.getBoundingClientRect();
      return { nameRight: name.right, priceLeft: price.left };
    });
  expect(
    quickServiceColumns.priceLeft - quickServiceColumns.nameRight,
  ).toBeGreaterThanOrEqual(24);
  const serviceDetailUrl = page.url();
  await page.goto("/orders");
  await page.getByRole("link", { name: "In corso", exact: true }).click();
  await expect(page).toHaveURL(/view=active/);
  const activeQuickView = page.getByRole("link", {
    name: "In corso",
    exact: true,
  });
  await expect(activeQuickView).toHaveCSS(
    "background-color",
    "rgb(255, 237, 159)",
  );
  await expect(activeQuickView).toHaveCSS(
    "box-shadow",
    "rgb(228, 174, 0) 0px -3px 0px 0px inset",
  );
  const inactiveQuickView = page.getByRole("link", {
    name: "Da ritirare",
    exact: true,
  });
  await expect(inactiveQuickView).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await inactiveQuickView.hover();
  await expect(inactiveQuickView).toHaveCSS(
    "background-color",
    "rgb(255, 248, 217)",
  );
  await expect(page.getByLabel("Mese", { exact: true })).toHaveValue("");
  const filterHeights = await page
    .locator(
      ".filters > label > input, .filters > label .date-picker, .filters > label .business-select-trigger, .filters > .order-date-scope-toggle",
    )
    .evaluateAll((controls) =>
      controls.map((control) => control.getBoundingClientRect().height),
    );
  expect(Math.max(...filterHeights) - Math.min(...filterHeights)).toBeLessThan(
    1,
  );
  const quickOrderRow = page
    .locator(".order-list-body > tr")
    .filter({ hasText: serviceCode });
  await expect(
    quickOrderRow.locator(".order-type-quick-service"),
  ).toBeVisible();
  await expect(quickOrderRow.locator(".order-type-quick-service")).toHaveCSS(
    "background-color",
    "rgb(223, 245, 236)",
  );
  await quickOrderRow.getByRole("link", { name: serviceCode }).click();
  await page.locator(".back-link").click();
  await expect(page).toHaveURL(/view=active.*#order-/);
  await page
    .getByPlaceholder(
      "Numero, cliente, telefono, dispositivo, IMEI o intervento",
    )
    .fill(serviceCode);
  await expect(page.locator(".order-search-scope")).toContainText(
    "ignora il filtro mensile",
  );
  await expect(quickOrderRow).toBeVisible();
  await quickOrderRow.click();
  await expect(
    quickOrderRow.locator(".order-due-cell .order-static-value"),
  ).toContainText(/\d{4}-\d{2}-\d{2}/);
  await expect(quickOrderRow.locator(".order-due-cell input")).toHaveCount(0);
  await expect(quickOrderRow.locator(".order-due-cell button")).toHaveCount(0);
  await page.evaluate(() => {
    const tag = document.createElement("span");
    tag.className = "order-type-tag order-type-repair e2e-repair-tag";
    tag.textContent = "Servizio di riparazione";
    document.body.append(tag);
  });
  const repairTag = page.locator(".e2e-repair-tag");
  await expect(repairTag).toBeVisible();
  expect(
    await repairTag.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).not.toBe(
    await quickOrderRow
      .locator(".order-type-quick-service")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  await chooseBusinessOption(page, "Tipo di servizio", "Riparazione");
  await page.getByRole("button", { name: "Stato", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Ricevuto", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto(serviceDetailUrl);
  await expect(page.locator(".detail-status")).toContainText("31/12/99, 18:30");
  const secondaryActions = page.locator(".secondary-actions");
  const moreActions = secondaryActions.getByText("Altre azioni", {
    exact: true,
  });
  await expect(moreActions.locator("svg")).toHaveClass(
    /lucide-ellipsis-vertical/,
  );
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.printed = "true";
    };
  });
  await moreActions.click();
  const actionsMenu = secondaryActions.locator(".secondary-actions-menu");
  const [triggerBox, menuBox] = await Promise.all([
    moreActions.boundingBox(),
    actionsMenu.boundingBox(),
  ]);
  expect(Math.abs(triggerBox!.width - menuBox!.width)).toBeLessThanOrEqual(1);
  await actionsMenu.getByRole("button", { name: "Stampa" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", "true");
  await expect(secondaryActions).not.toHaveAttribute("open", "");
  await moreActions.click();
  await page
    .getByRole("button", {
      name: "Elimina definitivamente la scheda",
      exact: true,
    })
    .click();
  const deleteDialog = page.getByRole("dialog", {
    name: "Elimina definitivamente la scheda",
  });
  await deleteDialog
    .getByLabel("Numero scheda di servizio", { exact: true })
    .fill(serviceCode);
  await deleteDialog
    .getByRole("button", { name: "Elimina definitivamente", exact: true })
    .click();
  await expect(page).toHaveURL(/\/orders$/);

  await page.goto("/retail");
  await page
    .getByRole("button", { name: "Servizi rapidi", exact: true })
    .click();
  await expect(
    page.locator(".retail-service-card").filter({ hasText: serviceName }),
  ).toBeVisible();
  await expect(
    page.locator(".retail-product-card:not(.retail-service-card)"),
  ).toHaveCount(0);
  await page
    .locator(".retail-service-card")
    .filter({ hasText: serviceName })
    .click();
  const editServicePrice = page.getByRole("button", {
    name: `Modifica prezzo ${serviceName}`,
    exact: true,
  });
  await expect(editServicePrice).toContainText("29,90 €");
  await expect(editServicePrice).toHaveCSS("white-space", "nowrap");
  const servicePricePencil = editServicePrice.locator("svg");
  const servicePriceAmount = editServicePrice.locator("span");
  await page.mouse.move(0, 0);
  await expect(servicePricePencil).toHaveCSS("opacity", "0");
  const servicePriceAmountRestBox = await servicePriceAmount.boundingBox();
  await editServicePrice.hover();
  await expect(servicePricePencil).toHaveCSS("opacity", "1");
  const servicePriceAmountHoverBox = await servicePriceAmount.boundingBox();
  expect(servicePriceAmountHoverBox!.x).toBeLessThan(
    servicePriceAmountRestBox!.x,
  );
  const serviceRow = page
    .locator(".retail-cart-row")
    .filter({ hasText: serviceName });
  const serviceNameElement = serviceRow.locator(":scope > div > strong");
  const [serviceDisplayBox, serviceRowBox, serviceNameBox] = await Promise.all([
    editServicePrice.boundingBox(),
    serviceRow.boundingBox(),
    serviceNameElement.boundingBox(),
  ]);
  expect(
    Math.abs(
      servicePriceAmountRestBox!.x +
        servicePriceAmountRestBox!.width -
        (serviceRowBox!.x + serviceRowBox!.width),
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      serviceDisplayBox!.x +
        serviceDisplayBox!.width -
        (serviceRowBox!.x + serviceRowBox!.width),
    ),
  ).toBeLessThanOrEqual(1);
  await editServicePrice.click();
  const servicePrice = page.getByLabel(`${serviceName} Prezzo unitario`, {
    exact: true,
  });
  const priceField = page.locator(".retail-service-price-field");
  const cartRow = page
    .locator(".retail-cart-row")
    .filter({ hasText: serviceName });
  const priceFieldBox = await priceField.boundingBox();
  const cartRowBox = await cartRow.boundingBox();
  const editingServiceNameBox = await serviceNameElement.boundingBox();
  expect(editingServiceNameBox!.height).toBe(serviceNameBox!.height);
  expect(priceFieldBox!.width).toBe(serviceDisplayBox!.width);
  expect(priceFieldBox!.x).toBeGreaterThan(
    cartRowBox!.x + cartRowBox!.width / 2,
  );
  await expect(priceField).toHaveCSS("justify-self", "end");
  await expect(priceField).toHaveCSS("flex-direction", "row");
  const [serviceInputBox, currencyBox] = await Promise.all([
    servicePrice.boundingBox(),
    priceField.locator(":scope > span[aria-hidden='true']").boundingBox(),
  ]);
  expect(
    Math.abs(
      serviceInputBox!.y +
        serviceInputBox!.height / 2 -
        (currencyBox!.y + currencyBox!.height / 2),
    ),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(
      priceFieldBox!.x +
        priceFieldBox!.width -
        (cartRowBox!.x + cartRowBox!.width),
    ),
  ).toBeLessThanOrEqual(1);
  await expect(cartRow.locator(":scope > b")).toHaveCount(0);
  await servicePrice.fill("24.50");
  await page.getByRole("button", { name: /Conferma incasso 24,50 €/ }).click();
  await expect(
    page
      .getByRole("status")
      .getByRole("heading", { name: "Vendita completata", exact: true }),
  ).toBeVisible();
});

test("dashboard opens monthly receipts and keeps receipt charts", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seedDashboardReceipts();
  await page.goto("/?day=2026-10-03", { waitUntil: "commit" });
  const receipts = page.locator(".dashboard-receipts");
  await expect(receipts).toBeVisible();
  await expect(receipts.locator(".dashboard-date-filter")).toBeVisible();
  await expect(receipts.locator(".dashboard-date-filter > span")).toHaveCount(
    0,
  );
  await expect(receipts.getByText("Incassi del mese")).toBeVisible();
  await expect(receipts.locator(".monthly-receipt-comparison")).toHaveCount(0);
  const monthlyReceipts = receipts.getByRole("button", {
    name: "Incassi mensili",
    exact: true,
  });
  await expect(monthlyReceipts).not.toHaveCSS(
    "border-top-color",
    "rgba(0, 0, 0, 0)",
  );
  const monthlyReceiptsBackground = await monthlyReceipts.evaluate(
    (button) => getComputedStyle(button).backgroundColor,
  );
  await monthlyReceipts.hover();
  await expect(monthlyReceipts).not.toHaveCSS(
    "background-color",
    monthlyReceiptsBackground,
  );
  const charts = page.locator(".dashboard-charts");
  await expect(
    charts.getByRole("heading", { name: "Incassi degli ultimi 7 giorni" }),
  ).toBeVisible();
  await expect(
    charts.getByRole("heading", { name: "Composizione incassi di oggi" }),
  ).toBeVisible();
  await expect(charts.locator(".revenue-bar")).toHaveCount(21);
  await expect(charts.locator(".donut-segment")).toHaveCount(3);
  await expect(charts.locator(".revenue-source-card")).toContainText(
    "100,00 €",
  );
  await expect(page.locator(".dashboard-kpis .metric")).toHaveCount(4);
  await expect(page.locator(".dashboard-kpis .metric > small")).toHaveCount(0);
  await expect(page.locator(".dashboard-workflow")).toHaveCount(0);
  await expect(page.locator(".dashboard-lists > section")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Statistiche dettagliate", exact: true }),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 844 });
  const [
    headerBox,
    receiptBox,
    chartBox,
    kpiBox,
    listBox,
    prioritiesBox,
    recentOrdersBox,
  ] = await Promise.all([
    page.locator(".dashboard > .page-header").boundingBox(),
    receipts.boundingBox(),
    charts.boundingBox(),
    page.locator(".dashboard-kpis").boundingBox(),
    page.locator(".dashboard-lists").boundingBox(),
    page.locator(".attention-card").boundingBox(),
    page.locator(".dashboard-list-card").boundingBox(),
  ]);
  expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(kpiBox!.y);
  expect(kpiBox!.y + kpiBox!.height).toBeLessThanOrEqual(listBox!.y);
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(chartBox!.y);
  expect(recentOrdersBox!.width).toBeGreaterThan(prioritiesBox!.width);
  expect(receiptBox!.height).toBeLessThanOrEqual(192);
  expect(kpiBox!.height).toBeLessThanOrEqual(192);
  expect(chartBox!.height).toBeGreaterThanOrEqual(260);
  expect(
    (await page.locator(".dashboard").boundingBox())!.width,
  ).toBeLessThanOrEqual(1440);
  await expect(charts.locator(".revenue-bars")).toHaveCSS("height", "220px");
  await expect(page.locator(".dashboard")).not.toHaveClass(
    /dashboard-animating/,
  );
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.addStyleTag({
    content: "nextjs-portal { display: none !important; }",
  });
  await page.screenshot({
    path: "test-results/dashboard-redesign-desktop.png",
    fullPage: false,
  });

  await monthlyReceipts.click();
  await expect(page).toHaveURL(/day=2026-10-03.*receipts=2026-10/);
  const dialog = page.getByRole("dialog", { name: "Incassi mensili" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator(":scope > .dialog-body.monthly-receipt-dialog"),
  ).toBeVisible();
  await expect(dialog).toHaveCSS("width", "680px");
  await expect(dialog.locator(".monthly-receipt-total")).toContainText(
    "140,00 €",
  );
  await expect(dialog.locator(".monthly-receipt-comparison")).toHaveCount(3);
  await expect(
    dialog.locator(".monthly-receipt-comparison").filter({ hasText: "2025" }),
  ).toContainText("+75%");

  const monthInput = dialog.locator('input[type="month"]');
  await page.setViewportSize({ width: 1280, height: 900 });
  const monthControl = dialog.locator(".monthly-receipt-picker .date-picker");
  const monthPickerLayout = dialog.locator(".monthly-receipt-picker");
  const monthOverview = dialog.locator(".monthly-receipt-overview");
  const monthTotal = dialog.locator(".monthly-receipt-total");
  const monthPicker = dialog.locator(".date-picker-popover");
  const desktopLayoutBox = await monthPickerLayout.boundingBox();
  const desktopControlBox = await monthControl.boundingBox();
  const desktopTotalBox = await monthTotal.boundingBox();
  const monthLabelBox = await monthPickerLayout.locator("> span").boundingBox();
  expect(desktopControlBox!.width).toBeLessThanOrEqual(256);
  expect(
    Math.abs(desktopLayoutBox!.y - desktopTotalBox!.y),
  ).toBeLessThanOrEqual(1);
  expect(monthLabelBox!.y + monthLabelBox!.height).toBeLessThanOrEqual(
    desktopControlBox!.y,
  );
  await page.mouse.click(
    monthLabelBox!.x + monthLabelBox!.width / 2,
    monthLabelBox!.y + monthLabelBox!.height / 2,
  );
  await expect(monthPicker).toHaveCount(0);
  await monthInput.click();
  await expect(monthPicker).toBeVisible();
  await page.screenshot({
    path: "test-results/monthly-receipts-month-picker.png",
  });
  await monthInput.click();
  await expect(monthPicker).toHaveCount(0);
  await monthInput.fill("2025-09");
  await expect(page).toHaveURL(/day=2026-10-03.*receipts=2025-09/);
  await expect(dialog.locator(".monthly-receipt-total")).toContainText(
    "50,00 €",
  );
  await expect(
    dialog.locator(".monthly-receipt-comparison").filter({ hasText: "2024" }),
  ).toContainText("+100%");

  await page.setViewportSize({ width: 390, height: 844 });
  const [
    mobileOverviewBox,
    mobileLayoutBox,
    mobileLabelBox,
    mobileControlBox,
    mobileTotalBox,
  ] = await Promise.all([
    monthOverview.boundingBox(),
    monthPickerLayout.boundingBox(),
    monthPickerLayout.locator("> span").boundingBox(),
    monthControl.boundingBox(),
    monthTotal.boundingBox(),
  ]);
  expect(mobileLabelBox!.y + mobileLabelBox!.height).toBeLessThanOrEqual(
    mobileControlBox!.y,
  );
  expect(mobileLayoutBox!.x).toBeCloseTo(mobileTotalBox!.x, 0);
  expect(mobileTotalBox!.y).toBeGreaterThanOrEqual(
    mobileLayoutBox!.y + mobileLayoutBox!.height,
  );
  expect(mobileOverviewBox!.width).toBeLessThanOrEqual(342);
  await page.mouse.click(
    mobileLayoutBox!.x + 4,
    (mobileLabelBox!.y + mobileControlBox!.y) / 2,
  );
  await expect(monthPicker).toHaveCount(0);
  await monthInput.click();
  await expect(monthPicker).toBeVisible();
  const mobilePickerBox = await monthPicker.boundingBox();
  expect(mobilePickerBox!.x).toBeGreaterThanOrEqual(0);
  expect(mobilePickerBox!.x + mobilePickerBox!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/monthly-receipts-month-picker-mobile.png",
  });
  await monthInput.click();
  await expect(monthPicker).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "monthly receipt dialog overflows at 390px",
  ).toBe(true);
  await dialog.getByRole("button", { name: "Chiudi", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/\?day=2026-10-03$/);

  const mobileKpis = await page
    .locator(".dashboard-kpis .metric")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width };
      }),
    );
  const [mobileReceiptBox, mobileMonthlyEntryBox] = await Promise.all([
    receipts.boundingBox(),
    receipts.locator(".dashboard-month-entry").boundingBox(),
  ]);
  expect(
    mobileMonthlyEntryBox!.x + mobileMonthlyEntryBox!.width,
  ).toBeLessThanOrEqual(mobileReceiptBox!.x + mobileReceiptBox!.width);
  expect(new Set(mobileKpis.map(({ top }) => Math.round(top))).size).toBe(2);
  expect(Math.round(mobileKpis[0].top)).toBe(Math.round(mobileKpis[1].top));
  expect(mobileKpis[1].left).toBeGreaterThan(
    mobileKpis[0].left + mobileKpis[0].width - 1,
  );
  expect(mobileKpis[2].top).toBeGreaterThan(mobileKpis[0].top);
  expect(mobileKpis[2].left).toBeCloseTo(mobileKpis[0].left, 0);
  expect(mobileKpis[3].left).toBeCloseTo(mobileKpis[1].left, 0);

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `dashboard overflows at ${width}px`,
    ).toBe(true);
  }
  await expect(page.locator(".dashboard")).not.toHaveClass(
    /dashboard-animating/,
  );
  await page.addStyleTag({
    content: "nextjs-portal { display: none !important; }",
  });
  await page.locator(".dashboard").screenshot({
    path: "test-results/dashboard-redesign-mobile.png",
  });

  await page.evaluate(() => {
    const controls = document.createElement("div");
    controls.innerHTML =
      '<button id="primary-button-probe" class="button button-primary" type="button">Primary</button><button id="button-focus-before" type="button">Before</button><button id="secondary-button-probe" class="button button-outline" type="button">Secondary</button>';
    document.body.prepend(controls);
  });
  const primaryButton = page.locator("#primary-button-probe");
  await expect(primaryButton).toHaveCSS(
    "background-color",
    "rgb(244, 198, 45)",
  );
  await primaryButton.hover();
  await expect(primaryButton).toHaveCSS(
    "background-color",
    "rgb(228, 182, 25)",
  );
  const secondaryButton = page.locator("#secondary-button-probe");
  await expect(secondaryButton).not.toHaveCSS(
    "border-top-color",
    "rgba(0, 0, 0, 0)",
  );
  const secondaryBackground = await secondaryButton.evaluate(
    (button) => getComputedStyle(button).backgroundColor,
  );
  await secondaryButton.hover();
  await expect(secondaryButton).not.toHaveCSS(
    "background-color",
    secondaryBackground,
  );
  await page.locator("#button-focus-before").focus();
  await page.keyboard.press("Tab");
  await expect(secondaryButton).toBeFocused();
  await expect(secondaryButton).toHaveCSS(
    "background-color",
    "rgb(255, 248, 220)",
  );
});

test("staff cannot open receipt data from the dashboard or reports route", async ({
  page,
}) => {
  await page.goto("/");
  const db = new PrismaClient();
  try {
    await db.user.update({
      where: { email: "local-operator@ngt.invalid" },
      data: { role: "STAFF" },
    });
    await page.reload();
    await expect(page.locator(".dashboard-receipts")).toHaveCount(0);
    await expect(page.locator(".dashboard-kpis .metric")).toHaveCount(3);
    await expect(page.locator(".dashboard-charts")).toHaveCount(0);
    await expect(
      page.locator(".dashboard > .page-header .dashboard-date-filter"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Incassi mensili", exact: true }),
    ).toHaveCount(0);

    await page.goto("/reports?month=2025-09");
    await expect(page).toHaveURL(/\/$/);
    await expect(page).not.toHaveURL(/receipts=/);
  } finally {
    await db.user.update({
      where: { email: "local-operator@ngt.invalid" },
      data: { role: "OWNER" },
    });
    await db.$disconnect();
  }
});

test("reports route opens the requested monthly receipt dialog", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/reports?day=2026-10-03");
  await expect(page).toHaveURL(/\/\?receipts=2026-10&day=2026-10-03$/);
  const monthlyReceiptDialog = page.getByRole("dialog", {
    name: "Incassi mensili",
  });
  await expect(monthlyReceiptDialog).toBeVisible();
  await expect(monthlyReceiptDialog).toHaveCSS("width", "680px");

  await page.goto("/reports?month=2025-09");
  await expect(page).toHaveURL(/\/\?receipts=2025-09$/);
  await expect(monthlyReceiptDialog).toBeVisible();
  await expect(monthlyReceiptDialog).toHaveCSS("width", "680px");
  expect(pageErrors).toEqual([]);
});

test("workspace and print views use the shared NGT brand", async ({ page }) => {
  await page.goto("/");

  const sidebarLogo = page.locator(".sidebar .brand-logo-full");
  await expect(sidebarLogo).toBeVisible();
  await expect(sidebarLogo).toHaveAttribute(
    "src",
    /\/brand\/ngt-logo-horizontal\.svg$/,
  );
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute(
    "href",
    /\/brand\/ngt-app-icon/,
  );

  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".print-brand-header")).toBeVisible();
  await expect(page.locator(".sidebar")).toBeHidden();
});

test("desktop sidebar resizes, collapses and restores its saved width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("ngt-sidebar-width");
    localStorage.removeItem("ngt-sidebar-collapsed");
  });
  await page.reload();

  const sidebar = page.locator(".sidebar");
  const resizer = page.getByRole("separator", {
    name: "Ridimensiona barra laterale",
  });
  const handle = await resizer.boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + 4, handle!.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 64, handle!.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width || 0))
    .toBe(300);
  const brandBox = await page.locator(".brand").boundingBox();
  const toggleBox = await page
    .getByRole("button", { name: "Riduci barra laterale" })
    .boundingBox();
  expect(brandBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox!.x).toBeGreaterThanOrEqual(brandBox!.x + brandBox!.width);
  const collapse = page.getByRole("button", {
    name: "Riduci barra laterale",
  });
  await expect(collapse).toHaveAttribute("title", "Riduci barra laterale");
  await collapse.hover();
  await expect(collapse).toHaveCSS("background-color", "rgb(255, 248, 217)");
  await expect(collapse).toHaveCSS("transform", "none");
  const inventoryNav = page.getByRole("link", { name: "Magazzino" });
  await inventoryNav.hover();
  await expect(inventoryNav).toHaveCSS(
    "background-color",
    "rgb(255, 248, 217)",
  );
  await expect(inventoryNav).toHaveCSS("transform", "none");

  await collapse.click();
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width || 0))
    .toBe(64);
  await expect(page.locator(".nav-item-label").first()).toBeHidden();
  await page.reload();
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width || 0))
    .toBe(64);
  await page.getByRole("button", { name: "Espandi barra laterale" }).click();
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width || 0))
    .toBe(300);

  await page.setViewportSize({ width: 800, height: 800 });
  await expect(resizer).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Riduci barra laterale" }),
  ).toBeHidden();
  await expect
    .poll(async () => {
      const width = Math.round((await sidebar.boundingBox())?.width || 0);
      const shellWidth = await page
        .locator(".app-shell")
        .evaluate((element) =>
          Math.round(element.getBoundingClientRect().width),
        );
      return width === shellWidth;
    })
    .toBe(true);
});

test("settings cards use one scoped layout", async ({ page }) => {
  await page.goto("/settings/language");
  const languageCard = page.locator(".settings-card");
  await expect(languageCard).toHaveCSS("display", "grid");
  await expect(languageCard).toHaveCSS("gap", "18px");
  const cardTitle = languageCard.locator(".settings-card-title");
  await expect(cardTitle).toHaveCSS("display", "flex");
  await expect(cardTitle).toHaveCSS("gap", "9px");
  await expect(cardTitle.locator("h2")).toHaveCSS("margin", "0px");
  const languageSwitch = languageCard.locator(".language-switch");
  await expect(languageSwitch).toHaveCSS("display", "flex");
  await expect(languageSwitch).toHaveCSS("gap", "5px");
  await expect(languageSwitch).toHaveCSS("position", "static");
  await expect(languageSwitch).toHaveCSS("margin", "0px");
  await expect(languageSwitch.locator('button[aria-pressed="true"]')).toHaveCSS(
    "background-color",
    "rgb(244, 198, 45)",
  );
  await expect(
    languageSwitch.locator('button[aria-pressed="false"]'),
  ).toHaveCSS("border-radius", "8px");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    languageSwitch.locator('button[aria-pressed="false"]'),
  ).toHaveCSS("padding", "7px 9px");
  expect(
    await languageCard.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  await page.setViewportSize({ width: 1280, height: 844 });

  await page.goto("/settings");
  const settingsEntry = page.locator(".settings-entry").first();
  await expect(settingsEntry).toHaveCSS("display", "grid");
  await expect(settingsEntry).toHaveCSS("gap", "18px");

  await page.goto("/settings/test-tools");
  const testToolsCard = page.locator(".test-tools-settings");
  await expect(testToolsCard).toHaveCSS("display", "grid");
  await expect(testToolsCard).toHaveCSS("gap", "18px");
  await expect(testToolsCard.locator(".settings-card-title")).toHaveCSS(
    "display",
    "flex",
  );
  await expect(testToolsCard).toHaveCSS(
    "border-top-color",
    "rgba(31, 119, 103, 0.28)",
  );
  expect(
    await testToolsCard.evaluate(
      (element) => getComputedStyle(element).backgroundImage,
    ),
  ).toContain("linear-gradient");
  const testDataGenerator = testToolsCard.locator(".test-data-generator");
  await expect(testDataGenerator).toHaveCSS("gap", "12px");
  await expect(testDataGenerator.locator("p")).toHaveCSS("margin", "0px");
  await expect(testToolsCard.locator(".test-tools-badge")).toHaveCSS(
    "font-size",
    "10px",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await testToolsCard
      .locator(".test-motion-grid")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/)
            .length,
      ),
  ).toBe(1);
  expect(
    await testToolsCard.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
});

test("settings detail pages use a scoped shell layout", async ({ page }) => {
  await page.goto("/settings/language");
  const shell = page.locator(".settings-detail-page");
  await expect(shell).toHaveCSS("display", "grid");
  await expect(shell).toHaveCSS("gap", "14px");
  await expect(shell.locator(":scope > .back-link")).toHaveCSS(
    "justify-self",
    "start",
  );
  const header = shell.locator(":scope > .page-header");
  await expect(header).toHaveCSS("align-items", "flex-start");
  await expect(header).toHaveCSS("margin-bottom", "2px");
  await expect(shell.locator(":scope > .settings-card")).toHaveCSS(
    "padding",
    "20px",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await shell.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);

  await page.goto("/settings/system-update");
  const updatePanels = page.locator(".system-update-page > .panel");
  await expect(updatePanels).toHaveCount(2);
  expect(
    await updatePanels.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).padding),
    ),
  ).toEqual(["20px", "20px"]);
});

test("settings action rows keep shared layout and responsive behavior", async ({
  page,
}) => {
  await page.goto("/settings/system-update");
  const updateAction = page.locator(".update-preferences .settings-action");
  await expect(updateAction).toHaveCSS("display", "flex");
  await expect(updateAction).toHaveCSS("gap", "24px");
  await expect(updateAction).toHaveCSS("padding-bottom", "0px");
  await expect(page.locator(".update-preferences .motion-switch")).toHaveCSS(
    "width",
    "46px",
  );

  await page.goto("/settings/data");
  const actions = page.locator(".settings-action");
  await expect(actions).toHaveCount(3);
  const row = actions.first();
  await expect(row).toHaveCSS("gap", "24px");
  await expect(row).toHaveCSS("padding-top", "18px");
  await expect(row.locator("p")).toHaveCSS("margin-top", "5px");

  const clearRow = actions.nth(2);
  const clearButton = clearRow.locator(".button-danger");
  await expect(clearButton).toHaveCSS("opacity", "0");
  await expect(clearButton).toHaveCSS("pointer-events", "none");
  await clearRow.hover();
  await expect(clearButton).toHaveCSS("opacity", "1");
  await expect(clearButton).toHaveCSS("pointer-events", "auto");
  await clearButton.focus();
  await expect(clearButton).toHaveCSS("opacity", "1");
  await expect(clearButton).toHaveCSS("pointer-events", "auto");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row).toHaveCSS("flex-direction", "column");
  await expect(row).toHaveCSS("align-items", "stretch");
  expect(
    await row.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(false);
});

test("settings inline managers fill their content at desktop and mobile widths", async ({
  page,
}) => {
  const managerRoutes = [
    ["/settings/quick-services", ".catalog-manager.settings-inline-manager"],
    ["/settings/device-models", ".model-manager.settings-inline-manager"],
    ["/settings/fault-catalog", ".fault-manager.settings-inline-manager"],
  ];

  for (const [route, selector] of managerRoutes) {
    await page.goto(route);
    const manager = page.locator(selector);
    await expect(manager).toHaveCount(1);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await manager.evaluate((element) => {
        const parent = element.parentElement!;
        const parentStyle = getComputedStyle(parent);
        return {
          minWidth: getComputedStyle(element).minWidth,
          width: element.getBoundingClientRect().width,
          parentContentWidth:
            parent.clientWidth -
            parseFloat(parentStyle.paddingLeft) -
            parseFloat(parentStyle.paddingRight),
        };
      });
      expect(geometry.minWidth).toBe("0px");
      expect(
        Math.abs(geometry.width - geometry.parentContentWidth),
      ).toBeLessThanOrEqual(1);
    }
  }
});

test("settings opens system update as a separate page", async ({ page }) => {
  await page.goto("/settings");
  const settingsGrid = page.locator(".settings-grid");
  await expect(settingsGrid).toHaveCSS("display", "grid");
  await expect(settingsGrid).toHaveCSS("gap", "22px");
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await settingsGrid.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  if (desktopViewport) await page.setViewportSize(desktopViewport);

  const entries = page.locator(".settings-entry");
  await expect(entries).toHaveCount(9);
  await expect
    .poll(() =>
      entries.evaluateAll((items) =>
        items.map((item) => item.getAttribute("href")),
      ),
    )
    .toEqual([
      "/settings/language",
      "/settings/interface-motion",
      "/settings/test-tools",
      "/settings/business-date",
      "/settings/system-update",
      "/settings/quick-services",
      "/settings/device-models",
      "/settings/fault-catalog",
      "/settings/data",
    ]);
  const entry = page.locator(".system-update-entry");
  await expect(entry).toContainText("Versione corrente");
  const entryIcon = entry.locator(".settings-entry-icon");
  await expect(entryIcon).toHaveCSS("width", "38px");
  await expect(entryIcon).toHaveCSS("height", "38px");
  await expect(entry.locator(".settings-entry-copy")).toHaveCSS("gap", "5px");
  const label = entry.locator(".dashboard-link-label");
  const arrow = entry.locator("svg").last();
  await expect(label, "title underline starts collapsed").toHaveCSS(
    "position",
    "relative",
  );
  await expect
    .poll(() =>
      label.evaluate(
        (element) => getComputedStyle(element, "::after").transform,
      ),
    )
    .toBe("matrix(0, 0, 0, 1, 0, 0)");
  await entry.hover();
  await expect(entry).toHaveCSS("border-top-color", "rgb(231, 201, 90)");
  await expect(entry).toHaveCSS("transform", "none");
  await expect(entryIcon.locator("svg")).toHaveCSS("transform", "none");
  await expect
    .poll(() =>
      arrow.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe("none");
  await expect
    .poll(() =>
      label.evaluate(
        (element) => getComputedStyle(element, "::after").transform,
      ),
    )
    .toBe("matrix(1, 0, 0, 1, 0, 0)");
  await entry.click();
  await expect(page).toHaveURL(/\/settings\/system-update$/);
  const updatePreferences = page.locator(".update-preferences");
  await expect(updatePreferences).toHaveCSS("display", "grid");
  await expect(updatePreferences).toHaveCSS("gap", "18px");
  await expect(updatePreferences.locator(".settings-card-title")).toHaveCSS(
    "display",
    "flex",
  );
  const settingsHeader = page.locator(".settings-detail-page > .page-header");
  await expect
    .poll(() =>
      settingsHeader.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width),
      ),
    )
    .toBeLessThanOrEqual(920);
  await expect(
    page.getByRole("link", { name: "Torna alle impostazioni" }),
  ).toHaveClass(/back-link/);
  const back = page.getByRole("link", { name: "Torna alle impostazioni" });
  const content = page.locator(".settings-detail-page");
  expect((await back.boundingBox())!.x).toBe((await content.boundingBox())!.x);
  expect((await settingsHeader.boundingBox())!.x).toBeGreaterThan(
    (await back.boundingBox())!.x,
  );
  await back.hover();
  await expect(back).toHaveCSS("transform", "none");
});

test("service order print renders mirrored copies from live order data", async ({
  page,
}) => {
  await fillOrder(page);
  const extraProject = `Pulizia connettore ${Date.now()}`;
  await createRepairProject(page, extraProject, "25");
  await save(page);

  const code = (await page.locator(".page-header h1").innerText()).trim();
  const originalTitle = await page.title();
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.printTitle = document.title || "empty";
    };
  });
  await page.getByText("Altre azioni", { exact: true }).click();
  await page.getByRole("button", { name: "Stampa", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-print-title",
    "empty",
  );
  await expect(page).toHaveTitle(originalTitle);

  await page.evaluate(() => {
    document.cookie = "ngt-locale=zh; Path=/; SameSite=Lax";
  });
  await page.reload();

  const printView = page.getByTestId("service-order-print");
  const copies = printView.locator(".service-order-print-copy");
  await expect(copies).toHaveCount(2);
  await expect(copies.nth(0)).toContainText("COPIA CLIENTE");
  await expect(copies.nth(1)).toContainText("COPIA NEGOZIO");
  await expect(printView).toContainText("SCHEDA DI ASSISTENZA");
  await expect(printView).toContainText("FIRME");
  await expect(printView).not.toContainText("GARANZIA");
  await expect(printView).not.toContainText("Garanzia non impostata");
  await expect(printView).not.toContainText("维修管理系统");
  const printBrand = printView.locator(".service-order-print-brand").first();
  await expect(printBrand.locator("img")).toHaveAttribute(
    "src",
    /\/brand\/ngt-logo-horizontal\.svg$/,
  );
  await expect(copies.nth(0)).toContainText(code);
  await expect(copies.nth(1)).toContainText(code);
  await expect(copies.nth(0).locator(".service-order-print-line")).toHaveCount(
    2,
  );
  await expect(copies.nth(0)).toContainText("sostituzione display");
  await expect(copies.nth(0)).toContainText(extraProject);
  await expect(copies.nth(0).locator(".service-order-print-notes")).toHaveCount(
    0,
  );
  await expect(copies.nth(1).locator(".service-order-print-notes")).toHaveCount(
    1,
  );

  await page.emulateMedia({ media: "print" });
  expect(
    await printBrand.evaluate(
      (element) => getComputedStyle(element, "::after").content,
    ),
  ).not.toBe("none");
  await expect(printView).toBeVisible();
  await expect(page.locator(".detail-grid")).toBeHidden();
  await expect(page.locator(".print-brand-header")).toBeHidden();
  const [leftBox, rightBox] = await Promise.all([
    copies.nth(0).boundingBox(),
    copies.nth(1).boundingBox(),
  ]);
  expect(Math.abs(leftBox!.width - rightBox!.width)).toBeLessThanOrEqual(1);
  expect(rightBox!.x).toBeGreaterThan(leftBox!.x + leftBox!.width);
  const printSheet = printView.locator(".service-order-print-sheet");
  const printSheetBox = await printSheet.boundingBox();
  const printablePageWidth = (277 / 25.4) * 96;
  const printablePageHeight = (190 / 25.4) * 96;
  expect(printSheetBox!.width).toBeLessThanOrEqual(printablePageWidth + 1);
  expect(printSheetBox!.height).toBeLessThanOrEqual(printablePageHeight + 1);
  expect(Math.max(leftBox!.height, rightBox!.height)).toBeLessThanOrEqual(
    printablePageHeight + 1,
  );
  expect(
    await copies.evaluateAll((elements) =>
      elements.every(
        (element) => element.scrollHeight <= element.clientHeight + 1,
      ),
    ),
  ).toBe(true);
  const pdf = await page.pdf({
    format: "A4",
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true,
  });
  expect(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
});

test("dashboard animates on entry and data changes while respecting reduced motion", async ({
  page,
}) => {
  await seedDashboardReceipts();
  await page.goto("/?day=2026-10-03");
  const dashboard = page.getByTestId("dashboard-motion");
  await expect(dashboard).toBeVisible();
  await expect(dashboard).toHaveClass(/dashboard-animating/);
  await expect(dashboard).not.toHaveClass(/dashboard-animating/, {
    timeout: 2000,
  });
  await expect(page.locator(".dashboard-kpis .metric")).toHaveCount(4);
  await expect(page.locator(".dashboard-receipts")).toBeVisible();
  await expect(page.locator(".revenue-bar")).toHaveCount(21);
  await expect(page.locator(".donut-segment")).toHaveCount(3);
  await expect
    .poll(() =>
      page
        .locator(".revenue-bar")
        .last()
        .evaluate((element) => element.style.transform),
    )
    .toBe("scaleY(1)");
  await expect
    .poll(() =>
      page
        .locator(".donut-segment")
        .first()
        .evaluate((element) => element.style.strokeDasharray),
    )
    .toBe("60, 40");
  const dashboardActions = page.locator(".dashboard-action-link");
  await expect(dashboardActions).toHaveCount(1);
  await expect(dashboardActions.locator("svg")).toHaveCount(1);
  await expect(dashboardActions.locator("svg").first()).toHaveAttribute(
    "width",
    "15",
  );
  expect(
    await dashboardActions.evaluateAll((links) =>
      links.map((link) => getComputedStyle(link).textDecorationLine),
    ),
  ).toEqual(["none"]);
  const firstDashboardAction = dashboardActions.first();
  expect(
    await firstDashboardAction
      .locator(".dashboard-link-label")
      .evaluate((element) => ({
        height: getComputedStyle(element, "::after").height,
        opacity: getComputedStyle(element, "::after").opacity,
      })),
  ).toEqual({ height: "1px", opacity: "0" });
  await firstDashboardAction.hover();
  await expect
    .poll(() =>
      firstDashboardAction
        .locator("svg")
        .evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe("none");
  await expect
    .poll(() =>
      firstDashboardAction
        .locator(".dashboard-link-label")
        .evaluate((element) => ({
          height: getComputedStyle(element, "::after").height,
          opacity: getComputedStyle(element, "::after").opacity,
        })),
    )
    .toEqual({ height: "1px", opacity: "1" });
  await expect(page.locator(".attention-card")).toHaveClass(/is-active/);
  await expect(page.locator(".attention-card")).toHaveCSS(
    "border-color",
    "rgb(239, 210, 124)",
  );
  await firstDashboardAction.click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto("/orders");
  await page.goto("/");
  await expect(page.getByTestId("dashboard-motion")).toHaveClass(
    /dashboard-animating/,
  );
  await expect(page.getByTestId("dashboard-motion")).not.toHaveClass(
    /dashboard-animating/,
    { timeout: 2000 },
  );

  await page.evaluate(() => {
    (window as Window & { dashboardMarker?: string }).dashboardMarker =
      "preserved";
  });
  const dashboardDate = page.locator(
    '.dashboard-date-filter input[type="date"]',
  );
  const dashboardDateToggle = page.locator(
    ".dashboard-date-filter .date-picker-toggle",
  );
  await expect(page.locator(".dashboard-date-filter > span")).toHaveCount(0);
  const toggleBeforeHover = await dashboardDateToggle.boundingBox();
  await dashboardDateToggle.hover();
  const toggleAfterHover = await dashboardDateToggle.boundingBox();
  expect(toggleAfterHover?.y).toBeCloseTo(toggleBeforeHover!.y, 1);
  const dateBox = await dashboardDate.boundingBox();
  const datePickerBox = await page
    .locator(".dashboard-date-filter .date-picker")
    .boundingBox();
  expect(datePickerBox?.width).toBeCloseTo(dateBox!.width, 1);
  expect(toggleAfterHover!.y + toggleAfterHover!.height / 2).toBeCloseTo(
    dateBox!.y + dateBox!.height / 2,
    1,
  );
  expect(toggleAfterHover!.x).toBeGreaterThan(dateBox!.x);
  expect(toggleAfterHover!.x + toggleAfterHover!.width).toBeLessThanOrEqual(
    dateBox!.x + dateBox!.width,
  );
  await dashboardDate.click({
    position: { x: 8, y: dateBox!.height / 2 },
  });
  const dashboardCalendar = page.getByRole("dialog", {
    name: "Scegli data",
  });
  await expect(dashboardCalendar).toBeVisible();
  const calendarBox = await dashboardCalendar.boundingBox();
  expect(calendarBox?.width).toBeGreaterThanOrEqual(300);
  expect(calendarBox?.width).toBeLessThanOrEqual(330);
  expect(calendarBox?.x).toBeGreaterThanOrEqual(12);
  expect(calendarBox!.x + calendarBox!.width).toBeLessThanOrEqual(
    (await page.evaluate(() => window.innerWidth)) - 12,
  );
  await expect(
    dashboardCalendar.locator(".date-picker-days .is-selected"),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await dashboardDate.fill("2026-10-03");
  await expect(
    page.locator(".dashboard-date-filter .date-picker-toggle"),
  ).toHaveCount(1);
  await expect(dashboard).toHaveClass(/dashboard-updating/);
  await expect(page).toHaveURL(/day=2026-10-03/);
  await expect(page.getByTestId("dashboard-motion")).toHaveClass(
    /dashboard-animating/,
  );
  expect(
    await page.evaluate(
      () => (window as Window & { dashboardMarker?: string }).dashboardMarker,
    ),
  ).toBe("preserved");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.getByTestId("dashboard-motion")).not.toHaveClass(
    /dashboard-animating/,
  );

  await page.goto("/");
  const attentionCard = page.locator(".attention-card");
  await attentionCard.getByRole("link", { name: /Prodotti esauriti/ }).click();
  await expect(page).toHaveURL(/status=OUT_OF_STOCK/);
  await expect(
    page.getByRole("button", { name: "Stato scorte", exact: true }),
  ).toContainText("Esaurito");

  await page.goto("/");
  await attentionCard
    .getByRole("link", { name: /Prodotti con scorta bassa/ })
    .click();
  await expect(page).toHaveURL(/status=LOW_STOCK/);
  await expect(
    page.getByRole("button", { name: "Stato scorte", exact: true }),
  ).toContainText("Scorta bassa");

  await page.goto("/");
  await attentionCard.getByRole("link", { name: /In ritardo/ }).click();
  await expect(page).toHaveURL(/attention=overdue/);
  await expect(
    page.getByRole("button", { name: "Priorità", exact: true }),
  ).toContainText("In ritardo");
  await expect(page.locator('input[name="month"]')).toHaveValue("");
});

test("dashboard only emphasizes attention when issues exist", async ({
  page,
}) => {
  await page.goto("/");
  const attentionCard = page.locator(".attention-card");
  await expect(attentionCard).toHaveClass(/is-active/);

  await clearDashboardAttention();
  await page.reload();

  await expect(attentionCard).not.toHaveClass(/is-active/);
  await expect(attentionCard.getByRole("link")).toHaveCount(0);
  await expect(attentionCard.locator(".dashboard-empty")).toBeVisible();
  const emptyCharts = page.locator(".dashboard-charts");
  await expect(emptyCharts.locator(".dashboard-chart-empty")).toBeVisible();
  expect((await emptyCharts.boundingBox())!.height).toBeLessThanOrEqual(220);
});

test("dashboard hides its final state before client animation starts", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("dashboard-motion")).toHaveClass(
    /dashboard-animating/,
  );
  await expect(page.locator(".dashboard-kpis .metric").first()).toHaveCSS(
    "opacity",
    "0",
  );
  await context.close();
});

test("table columns keep matching alignment and geometry while editing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });

  await fillOrder(page, { manual: true });
  await openPayment(page);
  await page
    .getByLabel("Incasso alla creazione (€)", { exact: true })
    .fill("20");
  await save(page);
  const paymentRow = page.locator(".payments-card .payment-row").first();
  const paymentLayout = await paymentRow.evaluate((row) => {
    const label = row.querySelector("span")!.getBoundingClientRect();
    const amount = row.querySelector("strong")!.getBoundingClientRect();
    return {
      labelLeft: label.left,
      amountRight: amount.right,
      rowRight: row.getBoundingClientRect().right,
    };
  });
  expect(paymentLayout.amountRight).toBeGreaterThan(paymentLayout.labelLeft);
  expect(
    Math.abs(paymentLayout.rowRight - paymentLayout.amountRight),
  ).toBeLessThan(1);
  await expect(page.locator(".payments-card .payment-amount-input")).toHaveCSS(
    "text-align",
    "right",
  );

  await page.goto("/orders");
  const orderRow = page.locator(".order-list-body > tr").first();
  await expect(orderRow).toBeVisible();
  await expectMatchingColumn(
    page.locator("th.order-status-cell"),
    orderRow.locator("td.order-status-cell"),
    "center",
  );
  await expectMatchingColumn(
    page.locator("th.order-due-cell"),
    orderRow.locator("td.order-due-cell"),
    "left",
  );
  await expectMatchingColumn(
    page.locator("th.order-payment-cell"),
    orderRow.locator("td.order-payment-cell"),
    "right",
  );
  const orderColumnsBefore = await orderRow
    .locator("td.order-status-cell, td.order-due-cell, td.order-payment-cell")
    .evaluateAll((cells) =>
      cells.map((cell) => {
        const box = cell.getBoundingClientRect();
        return { x: box.x, width: box.width };
      }),
    );
  await orderRow.click();
  await expect(orderRow.locator(".status-dropdown-trigger")).toBeVisible();
  const orderColumnsAfter = await orderRow
    .locator("td.order-status-cell, td.order-due-cell, td.order-payment-cell")
    .evaluateAll((cells) =>
      cells.map((cell) => {
        const box = cell.getBoundingClientRect();
        return { x: box.x, width: box.width };
      }),
    );
  orderColumnsBefore.forEach((column, index) => {
    expect(Math.abs(column.x - orderColumnsAfter[index].x)).toBeLessThan(1);
    expect(
      Math.abs(column.width - orderColumnsAfter[index].width),
    ).toBeLessThan(1);
  });

  await page.goto("/customers");
  const customerRow = page.locator(".customer-table tbody tr").first();
  await expectMatchingColumn(
    page.locator("th.customer-device-heading"),
    customerRow.locator("td.customer-device-count"),
    "right",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(customerRow.locator("td.customer-device-count")).toHaveCSS(
    "text-align",
    "left",
  );
  await page.setViewportSize({ width: 1920, height: 1080 });

  await page.goto("/inventory");
  const inventoryRow = page.locator(".inventory-table tbody tr").first();
  await expect(inventoryRow).toBeVisible();
  await expect(page.locator(".inventory-table thead th").first()).toHaveClass(
    /inventory-status-cell/,
  );
  await expect(inventoryRow.locator("td").first()).toHaveClass(
    /inventory-status-cell/,
  );
  await expectMatchingColumn(
    page.locator("th.inventory-stepper-cell").first(),
    inventoryRow.locator("td.inventory-stepper-cell").first(),
    "center",
  );
  await expectMatchingColumn(
    page.locator("th.inventory-quantity-cell").first(),
    inventoryRow.locator("td.inventory-quantity-cell").first(),
    "center",
  );
  await expectMatchingColumn(
    page.locator("th.inventory-status-cell"),
    inventoryRow.locator("td.inventory-status-cell"),
    "center",
  );
  const stockCellBefore = await inventoryRow
    .locator("td.inventory-stepper-cell")
    .first()
    .boundingBox();
  await inventoryRow.click();
  const stockCell = inventoryRow.locator("td.inventory-stepper-cell").first();
  await expect(stockCell.locator(".number-stepper")).toBeVisible();
  const stockCellAfter = await stockCell.boundingBox();
  expect(Math.abs(stockCellBefore!.x - stockCellAfter!.x)).toBeLessThan(1);
  expect(Math.abs(stockCellBefore!.width - stockCellAfter!.width)).toBeLessThan(
    1,
  );
  await expect(stockCell.locator(".number-stepper input")).toHaveCSS(
    "text-align",
    "center",
  );
  const [stockHeaderBox, stockEditorBox] = await Promise.all([
    page.locator("th.inventory-stepper-cell").first().boundingBox(),
    stockCell.locator(".number-stepper").boundingBox(),
  ]);
  expect(
    Math.abs(
      stockHeaderBox!.x +
        stockHeaderBox!.width / 2 -
        (stockEditorBox!.x + stockEditorBox!.width / 2),
    ),
  ).toBeLessThan(1);

  await page.goto("/prices");
  await page.getByLabel("Cerca", { exact: true }).fill("iPhone 13");
  const priceHeader = page.locator(".price-rule-header").first();
  const priceRow = page.locator(".price-rule-row").first();
  await expect(priceRow).toBeVisible();
  await expectMatchingColumn(
    priceHeader.locator("strong").nth(1),
    priceRow.locator(".inline-rule-suggested"),
    "right",
  );
  await expect(priceHeader.locator("strong").nth(2)).toHaveText("N. opzioni");
  await expectMatchingColumn(
    priceHeader.locator("strong").nth(2),
    priceRow.locator(".price-option-count"),
    "right",
  );
  const readonlyPrice = await priceRow
    .locator(".inline-rule-suggested")
    .boundingBox();
  await priceRow.click({ position: { x: 3, y: 3 } });
  const priceInput = priceRow.locator("input.inline-rule-suggested");
  await expect(priceInput).toBeVisible();
  await expect(priceInput).toHaveCSS("text-align", "right");
  const editingPrice = await priceInput.boundingBox();
  expect(Math.abs(readonlyPrice!.x - editingPrice!.x)).toBeLessThan(1);
  expect(Math.abs(readonlyPrice!.width - editingPrice!.width)).toBeLessThan(1);
});

test("settings can force interface animations when Windows reduces motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings/interface-motion");
  const motionControls = page.locator(".motion-setting-control");
  await expect(motionControls).toHaveCount(2);
  const motionControl = motionControls.first();
  await expect(motionControl).toHaveCSS("display", "flex");
  await expect(motionControl).toHaveCSS("align-items", "center");
  await expect(motionControl).toHaveCSS("gap", "12px");
  await expect(motionControl.locator(":scope > span")).toHaveCSS(
    "font-size",
    "12px",
  );
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(motionControl).toHaveCSS("justify-content", "space-between");
  if (desktopViewport) await page.setViewportSize(desktopViewport);

  const motionSwitch = page.getByRole("switch", {
    name: "Riproduci sempre le animazioni",
  });
  const motionSwitchThumb = motionSwitch.locator(":scope > span");
  await expect(motionSwitch).toHaveAttribute("aria-checked", "false");
  await expect(motionSwitch).toHaveCSS("width", "46px");
  await expect(motionSwitch).toHaveCSS("height", "26px");
  await expect(motionSwitchThumb).toHaveCSS("transition-duration", "0s");

  await motionSwitch.click();
  await expect(motionSwitch).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "always");
  await expect(motionSwitchThumb).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 20, 0)",
  );
  expect(
    await motionSwitchThumb.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
  ).toContain("0.18s");

  await page.goto("/");
  await expect(page.getByTestId("dashboard-motion")).toHaveClass(
    /dashboard-animating/,
  );

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "always");
  await page.goto("/settings/interface-motion");
  await expect(motionSwitch).toHaveAttribute("aria-checked", "true");
  await motionSwitch.click();
  await expect(motionSwitch).toHaveAttribute("aria-checked", "false");

  await page.goto("/");
  await expect(page.getByTestId("dashboard-motion")).not.toHaveClass(
    /dashboard-animating/,
  );
});

test("inventory movement history uses the shared dialog body", async ({
  page,
}) => {
  await page.goto("/inventory");
  const stockBadge = page
    .locator(".inventory-table tbody .stock-badge")
    .first();
  await expect(stockBadge).toBeVisible();
  await expect(stockBadge).toHaveCSS("display", "inline-flex");
  await expect(stockBadge).toHaveCSS("padding-top", "4px");
  await expect(stockBadge).toHaveCSS("padding-left", "4px");
  await expect(stockBadge).toHaveCSS("border-radius", "999px");
  await expect(stockBadge).toHaveCSS("font-size", "11px");
  const historyCard = page.locator(".inventory-history-card");
  await expect(historyCard).toHaveCSS("position", "relative");
  await expect(historyCard).toHaveCSS("overflow", "hidden");
  const historyHeading = historyCard.locator(".inventory-history-card-heading");
  await expect(historyHeading).toHaveCSS("display", "flex");
  const historyPreview = historyCard.locator(".inventory-history-preview");
  await expect(historyPreview).toHaveCSS("display", "grid");
  await expect(historyPreview).toHaveCSS("gap", "10px");
  const historyUnderline = historyCard.locator(
    ".inventory-history-title-underline",
  );
  const historyArrow = historyCard.locator(".inventory-history-arrow");
  await historyCard.hover();
  await expect(historyUnderline).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );
  await expect(historyArrow).toHaveCSS("color", "rgb(238, 151, 0)");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(historyUnderline).toHaveCSS("transition-duration", "0s");
  await historyCard.click();
  const dialog = page.getByRole("dialog", { name: "Registro magazzino" });
  await expect(
    dialog.locator(":scope > .dialog-body.inventory-movements-dialog"),
  ).toBeVisible();
  const movementRow = dialog.locator(".movement-row").first();
  await expect(movementRow).toHaveCSS("display", "grid");
  await expect(movementRow).toHaveCSS(
    "grid-template-columns",
    /^40px \d+(\.\d+)?px \d+(\.\d+)?px$/,
  );
  await expect(movementRow.locator(":scope > span")).toHaveCSS(
    "font-weight",
    "700",
  );
  const movementAmount = Number(
    (await movementRow.locator(":scope > span").textContent())?.replace(
      "+",
      "",
    ),
  );
  await expect(movementRow.locator(":scope > span")).toHaveCSS(
    "color",
    movementAmount > 0 ? "rgb(39, 132, 74)" : "rgb(189, 66, 66)",
  );
  const monthPicker = dialog.locator(".retail-period-picker");
  await expect(monthPicker).toHaveCSS("position", "absolute");
  await expect(monthPicker).toHaveCSS("width", "180px");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(monthPicker).toHaveCSS("position", "relative");
  const [dialogBox, monthPickerBox] = await Promise.all([
    dialog.boundingBox(),
    monthPicker.boundingBox(),
  ]);
  expect(monthPickerBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
  expect(monthPickerBox!.x + monthPickerBox!.width).toBeLessThanOrEqual(
    dialogBox!.x + dialogBox!.width,
  );
  const firstMovementBox = await dialog
    .locator(".movement-row")
    .first()
    .boundingBox();
  expect(monthPickerBox!.y + monthPickerBox!.height).toBeLessThanOrEqual(
    firstMovementBox!.y,
  );
  await monthPicker.locator('input[type="month"]').fill("2099-12");
  const emptyState = dialog.locator(".inventory-empty");
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toHaveCSS("min-height", "112px");
  await expect(emptyState).toHaveCSS("padding", "24px 16px");
  await dialog.getByRole("button", { name: "Chiudi" }).click();
  await expect(dialog).toHaveCount(0);
});

test("inventory summary metrics adapt from desktop to mobile columns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/inventory");

  const metrics = page.locator(".inventory-metrics");
  await expect(metrics).toBeVisible();
  await expect(metrics.locator(":scope > .metric")).toHaveCount(6);
  await expect(metrics).toHaveCSS("gap", "14px");
  await expect(metrics.locator(":scope > .metric").first()).toHaveCSS(
    "padding",
    "16px",
  );
  expect(
    await metrics.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/)
          .length,
    ),
  ).toBe(6);

  await page.setViewportSize({ width: 1000, height: 1000 });
  expect(
    await metrics.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/)
          .length,
    ),
  ).toBe(3);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(metrics).toHaveCSS("gap", "10px");
  expect(
    await metrics.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/)
          .length,
    ),
  ).toBe(1);
});

test("keeps inventory row editor styles compact and scoped", async ({
  page,
}) => {
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "Magazzino" })).toBeVisible();
  const repairPartRow = page.getByRole("row", { name: /Batteria Test/ });
  await expect(repairPartRow).toContainText("Riparazione");
  await repairPartRow.click();

  const nameInput = repairPartRow.locator(".inventory-name-edit input");
  await expect(nameInput).toHaveCSS("min-height", "32px");
  await expect(nameInput).toHaveCSS("min-width", "180px");
  await expect(nameInput).toHaveCSS("padding", "4px 7px");
  await expect(nameInput).toHaveCSS("font-size", "11px");
  const favoriteToggle = repairPartRow.locator(".favorite-toggle");
  await expect(favoriteToggle).toHaveCSS("border-top-width", "0px");
  await expect(favoriteToggle).toHaveCSS("padding", "4px");
  await expect(favoriteToggle).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const priceInput = repairPartRow.locator(".price-input");
  await expect(priceInput).toHaveCSS("width", "76px");
  await expect(priceInput).toHaveCSS("text-align", "right");
  const tableStepper = repairPartRow
    .locator(".number-stepper.is-table")
    .first();
  await expect(tableStepper).toHaveCSS(
    "grid-template-columns",
    "32px 52px 32px",
  );
  await expect(tableStepper.locator("input")).toHaveCSS("min-height", "30px");
  await expect(tableStepper.locator("input")).toHaveCSS("padding", "3px");
  await expect(tableStepper.locator("input")).toHaveCSS("text-align", "center");
});

test("keeps inventory batch selection controls sized", async ({ page }) => {
  await page.goto("/inventory");
  const inventoryMain = page.locator(".inventory-main");
  await inventoryMain
    .getByRole("button", { name: "Gestisci selezione", exact: true })
    .click();
  const batchToolbar = inventoryMain.locator(".inventory-batch-controls");
  await expect(batchToolbar).toHaveCSS("display", "flex");
  await expect(batchToolbar).toHaveCSS("justify-content", "flex-end");
  await expect(batchToolbar).toHaveCSS("gap", "7px");
  await expect(batchToolbar.getByRole("status")).toHaveCSS("font-size", "12px");
  await expect(batchToolbar.getByRole("button").first()).toHaveCSS(
    "min-height",
    "40px",
  );

  const selectionHeader = inventoryMain.locator(
    ".inventory-table thead th.inventory-selection",
  );
  await expect(selectionHeader).toBeVisible();
  await expect(selectionHeader).toHaveCSS("width", "42px");
  await expect(selectionHeader).toHaveCSS("text-align", "center");
  const selectAll = selectionHeader.getByRole("checkbox");
  await expect(selectAll).toHaveCSS("width", "18px");
  await expect(selectAll).toHaveCSS("height", "18px");
  await expect(selectAll).toHaveCSS("padding", "0px");
  await selectAll.check();
  const deleteBatch = batchToolbar.getByRole("button", {
    name: "Elimina",
    exact: true,
  });
  await deleteBatch.hover();
  await expect(deleteBatch).toHaveCSS("background-color", "rgb(251, 233, 232)");
  const finishBatch = batchToolbar.getByRole("button", {
    name: "Fine",
    exact: true,
  });
  await finishBatch.hover();
  await expect(finishBatch).toHaveCSS("background-color", "rgb(255, 240, 238)");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(batchToolbar).toHaveCSS("justify-content", "flex-start");
  await expect(batchToolbar).toHaveCSS("flex-wrap", "wrap");
  await expect(batchToolbar).toHaveCSS("min-width", "0px");
});

test("keeps inventory compatibility editor and labels scoped", async ({
  page,
}) => {
  await page.goto("/inventory");
  const batteryRow = page.getByRole("row", { name: /Batteria Test/ });
  const compatibilityList = batteryRow.locator(".inventory-compatibility-list");
  await expect(compatibilityList).toBeVisible();
  await expect(compatibilityList).toHaveCSS("display", "grid");
  await expect(compatibilityList).toHaveCSS("gap", "3px");
  const compatibilityPath = compatibilityList.locator("> span").first();
  await expect(compatibilityPath).toHaveCSS("overflow", "hidden");
  await expect(compatibilityPath).toHaveCSS("text-overflow", "ellipsis");
  await expect(compatibilityPath).toHaveCSS("white-space", "nowrap");

  const universalLabel = page
    .getByRole("row", { name: /Cavo USB-C Test/ })
    .locator(".inventory-universal");
  await expect(universalLabel).toBeVisible();
  await batteryRow.click();
  const compatibilityEdit = batteryRow.getByRole("button", {
    name: "Modifica dispositivi compatibili",
  });
  await expect(compatibilityEdit).toHaveCSS("min-height", "30px");
  await expect(compatibilityEdit).toHaveCSS("padding", "5px 7px");
  await expect(compatibilityEdit).toHaveCSS("font-size", "12px");
  await expect(compatibilityEdit).toHaveCSS("white-space", "nowrap");
  await compatibilityEdit.hover();
  await expect(compatibilityEdit).toHaveCSS(
    "background-color",
    "rgb(255, 247, 214)",
  );
});

test("animates overflowing inventory names and respects reduced motion", async ({
  page,
}) => {
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "Magazzino" })).toBeVisible();
  const productName = `Cavo USB-C E2E con descrizione prodotto molto lunga ${Date.now()}`;
  await page.getByRole("button", { name: "Nuovo prodotto" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Prodotto", { exact: true }).fill(productName);
  await chooseBusinessOption(page, "Categoria", "Ricarica", dialog);
  await chooseBusinessOption(page, "Utilizzo", "Vendita", dialog);
  await dialog.getByLabel("Costo", { exact: true }).fill("4.50");
  await dialog.getByLabel("Prezzo", { exact: true }).fill("12");
  await dialog.getByRole("button", { name: "Salva prodotto" }).click();

  const row = page.locator(".inventory-table tbody tr").filter({
    hasText: productName,
  });
  await expect(row).toHaveCount(1);
  const viewport = row.locator(".product-name-viewport");
  await expect(viewport).toHaveAttribute("data-overflowing", "true");
  await viewport.hover();
  const scrollingName = viewport.locator("strong");
  await expect
    .poll(() =>
      scrollingName.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    )
    .toBe("product-name-scroll");
  await page.waitForTimeout(350);
  await expect
    .poll(() =>
      scrollingName.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe("none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(scrollingName).toHaveCSS("animation-name", "none");
});

test("creates and edits a product directly in the inventory row", async ({
  page,
}) => {
  const productName = `Cavo USB-C E2E con descrizione prodotto molto lunga ${Date.now()}`;
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "Magazzino" })).toBeVisible();
  const inventoryMain = page.locator(".inventory-main");
  const batchControls = inventoryMain.locator(".inventory-batch-controls");
  await expect(inventoryMain.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(inventoryMain.locator(".inventory-batch-toolbar")).toHaveCount(
    0,
  );
  const searchBox = inventoryMain.getByLabel(
    "Cerca prodotto, ricambio, marca o modello",
  );
  const manageBatch = batchControls.getByRole("button", {
    name: "Gestisci selezione",
    exact: true,
  });
  await expect(searchBox).toBeVisible();
  await expect(manageBatch).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Nuovo prodotto" }),
  ).toContainText("Prodotto");
  expect(
    Math.abs(
      (await searchBox.boundingBox())!.y - (await manageBatch.boundingBox())!.y,
    ),
  ).toBeLessThan(2);
  const repairPartRow = page.getByRole("row", { name: /Batteria Test/ });
  await expect(repairPartRow).toContainText("Riparazione");
  await expect(repairPartRow.locator(".product-name-viewport")).toHaveAttribute(
    "data-overflowing",
    "false",
  );
  await expect(
    repairPartRow.locator("td.inventory-price-cell").last(),
  ).toHaveText("—");
  await repairPartRow.click();
  await expect(
    repairPartRow.locator("td.inventory-price-cell").last().locator("input"),
  ).toHaveCount(0);
  const categoryTrigger = repairPartRow.locator(
    ".inventory-category-cell .business-select-trigger",
  );
  await expect(categoryTrigger).toBeVisible();
  await expect(categoryTrigger).toHaveCSS("min-width", "0px");
  await expect(
    repairPartRow.locator(".inventory-usage-cell .business-select-trigger"),
  ).toHaveCSS("min-width", "0px");
  await expect(
    repairPartRow.locator(".inventory-category-cell .business-select"),
  ).toHaveCSS("min-width", "0px");
  const [categoryCellBox, categorySelectBox] = await Promise.all([
    repairPartRow.locator("td.inventory-category-cell").boundingBox(),
    repairPartRow
      .locator(".inventory-category-cell .business-select")
      .boundingBox(),
  ]);
  expect(categorySelectBox!.x).toBeGreaterThanOrEqual(categoryCellBox!.x);
  expect(categorySelectBox!.x + categorySelectBox!.width).toBeLessThanOrEqual(
    categoryCellBox!.x + categoryCellBox!.width,
  );
  await expect(
    repairPartRow.locator(".inventory-category-cell .business-combobox-input"),
  ).toHaveCount(0);
  const categoryLabel = await categoryTrigger.innerText();
  const categoryAndUsage = await repairPartRow.evaluate((element) => {
    const category = element
      .querySelector(".inventory-category-cell .business-select-trigger")!
      .getBoundingClientRect();
    const usage = element
      .querySelector(".inventory-usage-cell .business-select-trigger")!
      .getBoundingClientRect();
    return { categoryRight: category.right, usageLeft: usage.left };
  });
  expect(categoryAndUsage.categoryRight).toBeLessThanOrEqual(
    categoryAndUsage.usageLeft,
  );
  await categoryTrigger.click();
  const currentCategoryOption = page.getByRole("option", {
    name: categoryLabel,
    exact: true,
  });
  await expect(currentCategoryOption).toBeVisible();
  await currentCategoryOption.click();
  const usageAndCompatibility = await repairPartRow.evaluate((element) => {
    const usage = element
      .querySelector(".inventory-usage-cell .business-select-trigger")!
      .getBoundingClientRect();
    const compatibility = element
      .querySelector(".inventory-compatible-cell")!
      .getBoundingClientRect();
    return { usageRight: usage.right, compatibilityLeft: compatibility.left };
  });
  expect(usageAndCompatibility.usageRight).toBeLessThanOrEqual(
    usageAndCompatibility.compatibilityLeft,
  );
  await page.getByRole("heading", { name: "Magazzino" }).click();

  await page.getByRole("button", { name: "Nuovo prodotto" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Prodotto", { exact: true }).fill(productName);
  await chooseBusinessOption(page, "Categoria", "Ricarica", dialog);
  await chooseBusinessOption(page, "Utilizzo", "Vendita", dialog);
  await dialog.getByLabel("Costo", { exact: true }).fill("4.50");
  await dialog.getByLabel("Prezzo", { exact: true }).fill("12");
  const initialStock = dialog.getByLabel("Scorta iniziale", { exact: true });
  const minimumStock = dialog.getByLabel("Scorta minima", { exact: true });
  await expect(dialog.locator(".number-stepper")).toHaveCount(2);
  await expect(
    dialog.getByRole("button", { name: "- Scorta iniziale", exact: true }),
  ).toBeDisabled();
  await initialStock.fill("");
  await expect(initialStock).toHaveValue("");
  await initialStock.fill("150");
  await initialStock.press("Tab");
  await expect(initialStock).toHaveValue("150");
  const initialPlus = dialog.getByRole("button", {
    name: "+ Scorta iniziale",
    exact: true,
  });
  await initialPlus.hover();
  await expect(initialPlus).toHaveCSS("background-color", "rgb(255, 247, 214)");
  expect((await initialPlus.boundingBox())!.width).toBeGreaterThanOrEqual(38);
  await initialPlus.click();
  await expect(initialStock).toHaveValue("151");
  await initialStock.fill("4");
  await minimumStock.fill("2");
  await dialog.getByLabel("Prodotto frequente", { exact: true }).check();
  await dialog.getByRole("button", { name: "Salva prodotto" }).click();

  const row = page.getByRole("row", { name: new RegExp(productName) });
  await expect(row).toContainText("Vendita");
  await expect(row).toContainText("4");
  const nameViewport = row.locator(".product-name-viewport");
  await expect(nameViewport).toHaveAttribute("data-overflowing", "true");
  await expect(nameViewport).toHaveAttribute("title", productName);
  await expect(row.locator(".inventory-product-cell")).toHaveCSS(
    "overflow",
    "hidden",
  );
  const productAndCategory = await row.evaluate((element) => {
    const name = element
      .querySelector(".product-name-viewport")!
      .getBoundingClientRect();
    const category = element
      .querySelector(".inventory-category-cell")!
      .getBoundingClientRect();
    return { nameRight: name.right, categoryLeft: category.left };
  });
  expect(productAndCategory.nameRight).toBeLessThanOrEqual(
    productAndCategory.categoryLeft,
  );
  await nameViewport.hover();
  const scrollingName = nameViewport.locator("strong");
  await expect(scrollingName).toHaveCSS(
    "animation-name",
    "product-name-scroll",
  );
  await expect
    .poll(() =>
      scrollingName.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe("none");
  await page.mouse.move(0, 0);
  await expect
    .poll(() =>
      scrollingName.evaluate((element) => getComputedStyle(element).transform),
    )
    .toBe("none");
  await expect(row.getByText("Cronologia", { exact: true })).toHaveCount(0);
  await expect(row.locator(".inventory-quantity-cell")).toHaveText(["0", "4"]);
  await expect(row.locator(".inventory-quantity-cell input")).toHaveCount(0);
  await row.click();
  await expect(row).toHaveClass(/order-row-active/);
  await expect(row).toHaveCSS("background-color", "rgb(255, 249, 232)");
  await expect(row).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(row.locator("td").first()).toHaveCSS(
    "box-shadow",
    /rgb\(228, 182, 0\)/,
  );
  await expect(row.locator("input")).not.toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(row).not.toHaveClass(/order-row-active/);
  await expect(row.locator("input")).toHaveCount(0);
  await row.click();
  await row.getByLabel("+ Disponibilità").click();
  await row.getByLabel("+ Disponibilità").click();
  await expect(row.getByLabel("Disponibilità", { exact: true })).toHaveValue(
    "6",
  );
  await expect(row.locator(".inventory-quantity-cell")).toHaveText(["0", "6"]);
  await row.getByLabel("Prodotto frequente", { exact: true }).click();
  const historyCard = page.locator(".inventory-history-card");
  await expect(historyCard).toContainText("0 → 4");
  const inventoryScroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("Enter");
  await expect(row.getByLabel("Disponibilità", { exact: true })).toHaveCount(0);
  await expect(historyCard).toContainText("4 → 6");
  expect(
    Math.abs((await page.evaluate(() => window.scrollY)) - inventoryScroll),
  ).toBeLessThanOrEqual(20);
  await expect(historyCard).toContainText(productName);
  await expect(historyCard).toHaveCSS("cursor", "pointer");
  await expect
    .poll(() =>
      historyCard
        .locator(".inventory-history-title-underline")
        .evaluate((element) => getComputedStyle(element).transform),
    )
    .toBe("matrix(0, 0, 0, 1, 0, 0)");
  await expect(historyCard.locator(".inventory-history-arrow")).toHaveCSS(
    "transform",
    "none",
  );
  await expect(historyCard.locator(".inventory-history-arrow")).toHaveCSS(
    "transition-delay",
    "0.24s, 0.24s",
  );
  const defaultBorderColor = await historyCard.evaluate(
    (element) => getComputedStyle(element).borderColor,
  );
  await historyCard.hover();
  await page.waitForTimeout(100);
  expect(
    await historyCard
      .locator(".inventory-history-arrow")
      .evaluate((element) => getComputedStyle(element).transform),
  ).toBe("matrix(1, 0, 0, 1, 0, 0)");
  await expect(historyCard).toHaveCSS("border-color", defaultBorderColor);
  await expect
    .poll(() =>
      historyCard
        .locator(".inventory-history-border-flow rect")
        .evaluate((element) => getComputedStyle(element).animationName),
    )
    .toBe("inventory-history-border-flow");
  await expect
    .poll(() =>
      historyCard
        .locator(".inventory-history-border-flow rect")
        .evaluate((element) => getComputedStyle(element).animationDuration),
    )
    .toBe("0.9s");
  await expect(
    historyCard.locator(".inventory-history-border-flow rect"),
  ).toHaveCSS("animation-iteration-count", "infinite");
  await expect(
    historyCard.locator(".inventory-history-border-flow rect"),
  ).toHaveCSS("animation-timing-function", "linear");
  await expect
    .poll(() =>
      historyCard
        .locator(".inventory-history-title-underline")
        .evaluate((element) => getComputedStyle(element).transform),
    )
    .toBe("matrix(1, 0, 0, 1, 0, 0)");
  await expect(historyCard.locator(".inventory-history-arrow")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 8, 0)",
  );
  await expect(historyCard.locator(".inventory-history-arrow")).toHaveCSS(
    "color",
    "rgb(238, 151, 0)",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      historyCard
        .locator(".inventory-history-border-flow rect")
        .evaluate((element) => getComputedStyle(element).animationDuration),
    )
    .toBe("1.4s");
  await expect(
    historyCard.locator(".inventory-history-title-underline"),
  ).toHaveCSS("transition-duration", "0s");
  await expect(
    historyCard.locator(".inventory-history-title-underline"),
  ).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(historyCard.locator(".inventory-history-arrow")).toHaveCSS(
    "transition-delay",
    "0.26s, 0.26s",
  );
  await expect(historyCard.locator(".inventory-history-arrow")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 8, 0)",
  );
  await historyCard.click();
  const movementDialog = page.getByRole("dialog", {
    name: "Registro magazzino",
  });
  const movementMonth = movementDialog.getByLabel("Mese", { exact: true });
  await expect(movementMonth).toHaveAttribute("type", "month");
  const movementClose = movementDialog.getByRole("button", { name: "Chiudi" });
  const [movementMonthBox, movementCloseBox] = await Promise.all([
    movementMonth.locator("..").boundingBox(),
    movementClose.boundingBox(),
  ]);
  expect(movementMonthBox!.width).toBeLessThanOrEqual(180);
  expect(movementMonthBox!.x + movementMonthBox!.width).toBeLessThan(
    movementCloseBox!.x,
  );
  expect(
    movementCloseBox!.x - (movementMonthBox!.x + movementMonthBox!.width),
  ).toBeLessThanOrEqual(16);
  await movementMonth.click({ position: { x: 8, y: 18 } });
  const movementCalendar = movementDialog.locator(".date-picker-popover");
  await expect(movementCalendar).toBeVisible();
  expect(
    await movementCalendar.evaluate(
      (element) => element.parentElement?.tagName,
    ),
  ).toBe("DIALOG");
  await page.keyboard.press("Escape");
  const currentMovementMonth = await movementMonth.inputValue();
  await expect(movementDialog).toContainText(productName);
  await expect(movementDialog).toContainText("4 → 6");
  await expect(
    movementDialog.locator(".movement-row").filter({ hasText: productName }),
  ).toHaveCount(2);
  await movementMonth.fill("2000-01");
  await expect(movementDialog.locator(".movement-row")).toHaveCount(0);
  await expect(movementDialog).toContainText("Nessun movimento registrato.");
  await movementMonth.fill(currentMovementMonth);
  await expect(
    movementDialog.locator(".movement-row").filter({ hasText: productName }),
  ).toHaveCount(2);
  await movementDialog.getByRole("button", { name: "Chiudi" }).click();

  await manageBatch.click();
  await expect(
    inventoryMain.locator(".inventory-table thead th").first(),
  ).toHaveClass(/inventory-selection/);
  await expect(row.locator("td").first()).toHaveClass(/inventory-selection/);
  await expect(
    inventoryMain.locator(".inventory-table thead th").nth(1),
  ).toHaveClass(/inventory-status-cell/);
  const deleteBatch = batchControls.getByRole("button", {
    name: "Elimina",
    exact: true,
  });
  await expect(batchControls).toContainText("0 selezionati");
  await expect(deleteBatch).toBeDisabled();
  await row.getByRole("checkbox").check();
  await expect(batchControls).toContainText("1 selezionati");
  await expect(deleteBatch).toBeEnabled();
  await batchControls
    .getByRole("button", { name: "Seleziona tutti", exact: true })
    .click();
  const tableCheckboxes = inventoryMain.locator(
    '.inventory-table input[type="checkbox"]',
  );
  await expect(tableCheckboxes.first()).toBeChecked();
  await expect(tableCheckboxes.last()).toBeChecked();
  await expect(tableCheckboxes.first()).toHaveCSS(
    "background-color",
    "rgb(251, 215, 46)",
  );
  const inventoryCheckboxBox = await tableCheckboxes.first().boundingBox();
  expect(inventoryCheckboxBox!.width).toBe(18);
  expect(inventoryCheckboxBox!.height).toBe(18);
  await batchControls
    .getByRole("button", { name: "Fine", exact: true })
    .click();
  await expect(inventoryMain.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(batchControls).not.toContainText("selezionati");
});

test("creates and sells a retail product with unlimited stock", async ({
  page,
}) => {
  const productName = `Accessorio illimitato E2E ${Date.now()}`;
  await page.goto("/inventory");
  await page.getByRole("button", { name: "Nuovo prodotto" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Prodotto", { exact: true }).fill(productName);
  await chooseBusinessOption(page, "Categoria", "Accessori", dialog);
  await dialog.getByLabel("Costo", { exact: true }).fill("2");
  await dialog.getByLabel("Prezzo", { exact: true }).fill("5");
  const unlimitedStockSwitch = dialog.getByRole("switch", {
    name: "Scorta illimitata",
    exact: true,
  });
  await expect(unlimitedStockSwitch).toHaveCSS("width", "46px");
  await unlimitedStockSwitch.click();
  await expect(
    dialog.getByLabel("Scorta iniziale", { exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByLabel("Scorta minima", { exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole("button", { name: "Salva prodotto" }).click();

  const row = page.getByRole("row", { name: new RegExp(productName) });
  await expect(row).toContainText("∞");
  await page.goto("/retail");
  const card = page
    .locator(".retail-product-card:not(.retail-service-card)")
    .filter({ hasText: productName });
  await expect(card).toBeVisible();
  await expect(card).toBeEnabled();
  await card.click();
  await page.getByRole("button", { name: /Conferma incasso.*5,00/ }).click();
  const saleDialog = page.getByRole("dialog");
  await expect(saleDialog.getByRole("status")).toContainText(
    "Vendita completata",
  );
});

test("filters inventory by compatible device and exposes compatibility", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/inventory");
  const inventoryMain = page.locator(".inventory-main");
  const filters = inventoryMain.locator(".inventory-filters");
  const search = inventoryMain.getByLabel(
    "Cerca prodotto, ricambio, marca o modello",
  );
  const battery = inventoryMain.getByRole("row", { name: /Batteria Test/ });
  const cable = inventoryMain.getByRole("row", { name: /Cavo USB-C Test/ });
  const tableScroll = inventoryMain.locator(".inventory-table-scroll");
  const inventoryTable = inventoryMain.locator(".inventory-table");
  await expect(inventoryMain).toHaveCSS("min-width", "0px");
  await expect(inventoryMain).toHaveCSS("overflow", "hidden");
  await expect(inventoryTable).toHaveCSS("min-width", "1380px");
  await expect(inventoryTable).toHaveCSS("table-layout", "fixed");
  await expect(inventoryTable.locator("th.inventory-product-cell")).toHaveCSS(
    "padding",
    "12px 14px",
  );
  for (const [selector, minWidth] of [
    ["th.inventory-product-cell", "210px"],
    ["th.inventory-category-cell", "150px"],
    ["th.inventory-usage-cell", "110px"],
    ["th.inventory-compatible-cell", "220px"],
    ["th.inventory-price-cell", "82px"],
    ["th.inventory-stepper-cell", "146px"],
    ["th.inventory-quantity-cell", "70px"],
    ["th.inventory-status-cell", "80px"],
  ]) {
    await expect(inventoryTable.locator(selector).first()).toHaveCSS(
      "min-width",
      minWidth,
    );
  }
  await expect(inventoryTable.locator("th.inventory-status-cell")).toHaveCSS(
    "padding",
    "12px 6px",
  );
  await expect(filters).toHaveCSS("display", "grid");
  await expect(filters).toHaveCSS("gap", "10px");
  await expect(filters).toHaveCSS("padding", "12px 16px");
  await expect(search).toHaveCSS("height", "42px");
  await expect(search).toHaveCSS("border-radius", "10px");
  await expect(search).toHaveCSS("padding", "10px 12px");
  expect(
    await tableScroll.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  const filterControls = [
    search,
    inventoryMain.getByRole("button", { name: "Categoria", exact: true }),
    inventoryMain.getByRole("button", { name: "Utilizzo", exact: true }),
    inventoryMain.getByRole("button", { name: "Stato scorte", exact: true }),
    inventoryMain.getByRole("button", {
      name: "Dispositivi compatibili",
      exact: true,
    }),
    inventoryMain.getByRole("button", {
      name: "Gestisci selezione",
      exact: true,
    }),
  ];
  const categoryFilter = inventoryMain.getByRole("button", {
    name: "Categoria",
    exact: true,
  });
  await expect(categoryFilter).toHaveCSS("height", "42px");
  await expect(categoryFilter).toHaveCSS("min-height", "42px");
  await expect(categoryFilter.locator(":scope > span")).toHaveCSS(
    "text-overflow",
    "ellipsis",
  );
  const filterBoxes = await Promise.all(
    filterControls.map((control) => control.boundingBox()),
  );
  expect(
    Math.max(...filterBoxes.map((box) => box!.y)) -
      Math.min(...filterBoxes.map((box) => box!.y)),
  ).toBeLessThan(2);
  expect(filterBoxes.map((box) => box!.x)).toEqual(
    [...filterBoxes].map((box) => box!.x).sort((left, right) => left - right),
  );
  const deviceFilterTrigger = inventoryMain.getByRole("button", {
    name: "Dispositivi compatibili",
    exact: true,
  });
  await expect(deviceFilterTrigger).toHaveCSS("display", "grid");
  await expect(deviceFilterTrigger).toHaveCSS("height", "40px");
  await expect(deviceFilterTrigger).toHaveCSS("border-radius", "8px");
  await expect(deviceFilterTrigger).toHaveCSS("border-top-width", "0px");
  await expect(deviceFilterTrigger).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );

  await expect(battery).toContainText("Apple / Telefono / iPhone 14");
  await expect(cable).toContainText("Universale");

  await search.fill("Apple");
  await expect(battery).toBeVisible();
  await expect(cable).toHaveCount(0);
  await search.fill("iPhone 14");
  await expect(battery).toBeVisible();
  await search.fill("");

  const trigger = deviceFilterTrigger;
  await trigger.click();
  let popover = page.getByRole("dialog", {
    name: "Dispositivi compatibili",
  });
  await expect(popover).toHaveCSS("position", "fixed");
  await expect(popover).toHaveCSS("width", "290px");
  await expect(popover).toHaveCSS("padding", "16px");
  await expect(popover).toHaveCSS("border-radius", "13px");
  const popoverUsesShadowToken = await popover.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--shadow-4)";
    element.parentElement?.append(probe);
    const expected = getComputedStyle(probe).boxShadow;
    const actual = getComputedStyle(element).boxShadow;
    probe.remove();
    return actual !== "none" && actual === expected;
  });
  expect(popoverUsesShadowToken).toBe(true);
  await expect(popover.locator(".business-select-trigger").first()).toHaveCSS(
    "min-height",
    "39px",
  );
  await chooseBusinessOption(page, "Marca", "Apple", popover);
  await chooseBusinessOption(page, "Tipo dispositivo", "Telefono", popover);
  expect(
    await popover.evaluate(
      (element) => element.parentElement === document.body,
    ),
  ).toBe(true);
  const popoverBox = await popover.boundingBox();
  const viewport = page.viewportSize();
  expect(popoverBox!.y).toBeGreaterThanOrEqual(12);
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(
    viewport!.height - 12,
  );
  await expect(
    popover.getByRole("button", { name: "Modello", exact: true }),
  ).toContainText("Tutti i modelli");
  await chooseBusinessOption(
    page,
    "Ricambio / intervento",
    "sostituzione batteria",
    popover,
  );
  await popover.getByRole("button", { name: "Applica", exact: true }).click();

  await expect(trigger).toHaveClass(/is-active/);
  await expect(battery).toBeVisible();
  await expect(cable).toHaveCount(0);

  await trigger.click();
  popover = page.getByRole("dialog", { name: "Dispositivi compatibili" });
  await chooseBusinessOption(page, "Modello", "iPhone 14", popover);
  await popover.getByRole("button", { name: "Applica", exact: true }).click();
  await expect(battery).toBeVisible();

  await trigger.click();
  popover = page.getByRole("dialog", { name: "Dispositivi compatibili" });
  await popover.getByRole("button", { name: "Cancella", exact: true }).click();
  await expect(trigger).not.toHaveClass(/is-active/);
  await expect(cable).toBeVisible();

  const filterColumnCount = () =>
    filters.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
  expect(await filterColumnCount()).toBe(6);
  for (const [width, columns] of [
    [1100, 3],
    [900, 2],
    [390, 1],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await filterColumnCount()).toBe(columns);
  }
  expect(
    await filters.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
});

test("repair list exposes month, status, due-date and payment controls", async ({
  page,
}) => {
  await fillOrder(page, { manual: true });
  await save(page);
  await page.goto("/orders");
  await expect(
    page.getByRole("columnheader", { name: "Ultima operazione", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".order-updated-cell").nth(1)).toContainText(
    /\d{2}\/\d{2}\/\d{2}, \d{2}:\d{2}/,
  );
  const month = page.locator('input[name="month"]');
  await expect(month).toHaveValue(/^\d{4}-\d{2}$/);
  const monthPicker = month.locator("..");
  await expect(monthPicker).toHaveCSS("width", "170px");
  const monthBox = await month.boundingBox();
  await month.click({ position: { x: 8, y: monthBox!.height / 2 } });
  const monthCalendar = page.getByRole("dialog", { name: "Scegli mese" });
  await expect(monthCalendar).toBeVisible();
  await expect(monthCalendar.locator(".date-picker-months button")).toHaveCount(
    12,
  );
  const monthCalendarBox = await monthCalendar.boundingBox();
  expect(monthCalendarBox!.width).toBeLessThanOrEqual(330);
  await page.keyboard.press("Escape");
  const currentMonth = await month.inputValue();
  await page.goto("/orders?month=not-a-month");
  await expect(page.locator('input[name="month"]')).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Schede di servizio" }),
  ).toBeVisible();
  await page.goto(`/orders?month=${currentMonth}`);
  await expect(
    page.getByRole("button", { name: "Filtra", exact: true }),
  ).toHaveCount(0);
  const search = page.getByPlaceholder(
    "Numero, cliente, telefono, dispositivo, IMEI o intervento",
    { exact: true },
  );
  const orderCode = await page.locator(".order-code-link").first().innerText();
  await search.fill(orderCode);
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("q") === orderCode,
  );
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await search.fill("");
  await expect(page).toHaveURL((url) => !url.searchParams.has("q"));
  await month.fill("2000-01");
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("month") === "2000-01",
  );
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await month.fill(currentMonth);
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("month") === currentMonth,
  );
  await chooseBusinessOption(page, "Stato", "In riparazione");
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("status") === "REPAIRING",
  );
  await chooseBusinessOption(page, "Priorità", "Saldo aperto");
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("attention") === "unpaid",
  );
  const row = page.locator("tbody tr").first();
  await expect(row.locator("td").first()).toHaveClass(/order-type-cell/);
  await expect(row.locator("td").first()).toHaveText("Riparazione");
  await expect(row.locator(".order-code-link")).not.toContainText(
    "Riparazione",
  );
  await expect(page.locator("thead th").first()).toHaveText("");
  await row.hover();
  await expect(row).toHaveCSS("background-color", "rgb(255, 249, 232)");
  await expect(row).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, -1\)/);

  const orderLink = row.locator(".order-code-link");
  await orderLink.hover();
  await expect(orderLink).toHaveCSS("color", "rgb(84, 62, 0)");
  await expect(orderLink.locator("svg")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 4, 0)",
  );
  expect(
    await orderLink
      .locator("span")
      .evaluate((text) => getComputedStyle(text, "::after").transform),
  ).toBe("matrix(1, 0, 0, 1, 0, 0)");
  await orderLink.evaluate((link) =>
    link.addEventListener("click", (event) => event.preventDefault()),
  );
  await orderLink.click();
  await expect(row).not.toHaveClass(/order-row-active/);

  const customerLink = row.locator(".order-customer-link");
  const customerUnderline = customerLink.locator("span");
  await expect(customerUnderline).toHaveCSS("overflow-x", "clip");
  await expect(customerUnderline).toHaveCSS("overflow-y", "visible");
  expect(
    await customerUnderline.evaluate(
      (text) => getComputedStyle(text, "::after").transform,
    ),
  ).toBe("matrix(0, 0, 0, 1, 0, 0)");
  await customerLink.hover();
  await expect(customerLink.locator("svg")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 4, 0)",
  );
  expect(
    await customerUnderline.evaluate(
      (text) => getComputedStyle(text, "::after").transform,
    ),
  ).toBe("matrix(1, 0, 0, 1, 0, 0)");
  await customerLink.evaluate((link) =>
    link.addEventListener("click", (event) => event.preventDefault()),
  );
  await customerLink.click();
  await expect(row).not.toHaveClass(/order-row-active/);

  await row.click();
  await expect(row).toHaveClass(/order-row-active/);
  await expect(row).toHaveCSS("background-color", "rgb(255, 249, 232)");
  await expect(row).toHaveCSS("box-shadow", "none");
  await expect(row).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(row.locator(".order-inline-edit-cell > *").first()).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );
  await expect(
    row.locator(".order-due-cell .order-static-value"),
  ).toContainText(/2099-12-31|31\/12\/2099/);
  await expect(row.locator(".order-due-cell input")).toHaveCount(0);
  await expect(row.locator(".order-due-cell button")).toHaveCount(0);
  const status = row.locator(".status-dropdown-trigger");
  await expect(status).toBeVisible();
  await expect(row.locator("select.status-select")).toHaveCount(0);
  const currentStatus = (await status.textContent())?.trim() ?? "";
  const rowHeight = await row.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await status.click();
  await expect(page.locator(".status-dropdown-menu")).toHaveCSS(
    "position",
    "fixed",
  );
  await expect(
    page
      .locator(".status-dropdown-menu")
      .getByRole("option", { name: currentStatus, exact: true }),
  ).toHaveCount(0);
  expect(
    await row.evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(rowHeight);
  await expect(
    page
      .locator(".status-dropdown-menu")
      .getByRole("option", { name: "Ricambio mancante", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    row.getByLabel("Consegna prevista", { exact: true }),
  ).toHaveCount(0);
  await expect(
    row.locator(".order-due-cell .order-static-value"),
  ).toContainText("31/12/2099");
  await expect(row.locator(".order-due-cell .date-picker-toggle")).toHaveCount(
    0,
  );
  await expect(
    row.getByRole("button", { name: "Registra incasso", exact: true }),
  ).toBeVisible();

  await page.goto("/settings/language");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.goto("/orders");
  const localizedRow = page
    .locator(".order-list-body > tr")
    .filter({ hasText: orderCode });
  await expect(localizedRow.locator(".order-updated-cell")).toContainText(
    /\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/,
  );
  await localizedRow.click();
  await expect(
    localizedRow.getByLabel("预计交付日期", { exact: true }),
  ).toHaveCount(0);
  await expect(
    localizedRow.locator(".order-due-cell .order-static-value"),
  ).toContainText("31/12/2099");
});
test("repair list separates explicit collection from payment correction", async ({
  page,
}) => {
  await fillOrder(page, { manual: true });
  await save(page);
  const orderPath = new URL(page.url()).pathname;
  await page.goto("/orders");
  const row = page.locator(`tbody tr:has(a[href^="${orderPath}"])`);
  await row.click();
  await row
    .getByRole("button", { name: "Registra incasso", exact: true })
    .click();
  const paymentDialog = page.getByRole("dialog", {
    name: "Registra incasso",
    exact: true,
  });
  await paymentDialog.getByLabel("Importo (€)", { exact: true }).fill("15");
  await paymentDialog
    .getByRole("button", { name: "Registra incasso", exact: true })
    .click();
  await expect(paymentDialog).toHaveCount(0);
  await expect(row.locator(".order-payment-values")).toContainText("15,00 €");

  await row
    .getByRole("button", { name: "Correggi totale incassato", exact: true })
    .click();
  const paid = row.getByLabel("Incassato", { exact: true });
  await paid.fill("10");
  await paid.press("Tab");
  await expect(row.locator(".inline-control-error")).toHaveCount(0);
  await row
    .getByLabel("Metodo di pagamento", { exact: true })
    .selectOption("CARD");
  await row
    .getByLabel("Motivo della modifica", { exact: true })
    .fill("Rettifica test");
  await row.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(row.locator(".order-payment-values")).toContainText("10,00 €");
});

test("repair list animates a row reordered by a local status change", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "ngt-order-motion",
      JSON.stringify({
        lift: 30,
        rise: 560,
        hold: 150,
        glide: 600,
        land: 180,
        shadowY: 18,
        shadowBlur: 30,
        shadowSpread: -14,
        shadowOpacity: 55,
      }),
    );
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fillOrder(page, { manual: true });
  await save(page);
  const olderOrderPath = new URL(page.url()).pathname;
  await page.waitForTimeout(50);
  await fillOrder(page, { manual: true });
  await save(page);
  const newerOrderPath = new URL(page.url()).pathname;
  await page.goto("/orders");

  const olderRow = page.locator(`tbody tr:has(a[href^="${olderOrderPath}"])`);
  const initialOrder = await page
    .locator(".order-code-link")
    .evaluateAll((links) =>
      links.map(
        (link) =>
          new URL(link.getAttribute("href") ?? "", location.href).pathname,
      ),
    );
  expect(initialOrder.indexOf(olderOrderPath)).toBeGreaterThan(
    initialOrder.indexOf(newerOrderPath),
  );
  await page
    .locator("tbody tr")
    .first()
    .evaluate((element) => (element.style.height = "520px"));
  await olderRow.scrollIntoViewIfNeeded();
  await olderRow.click();
  await page.waitForTimeout(220);
  expect(
    await olderRow
      .locator(".order-inline-edit-cell > *")
      .evaluateAll((elements) =>
        elements.every((element) => {
          const transform = new DOMMatrixReadOnly(
            getComputedStyle(element).transform,
          );
          return Math.abs(transform.m11 - 1) < 0.001;
        }),
      ),
  ).toBe(true);
  await olderRow.locator(".status-dropdown-trigger").click();
  await page
    .locator(".status-dropdown-menu")
    .getByRole("option", { name: "Annullato", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Annulla scheda" });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    document.body.style.minHeight = "2000px";
    document.body.style.overflow = "auto";
  });
  await page.evaluate((changedHref) => {
    document.body.dataset.orderAnimationMax = "0";
    document.body.dataset.changedOrderAnimationObserved = "false";
    document.body.dataset.displacedOrderAnimationObserved = "false";
    document.body.dataset.displacedOrderHoldObserved = "false";
    document.body.dataset.changedOrderLiftObserved = "false";
    document.body.dataset.changedOrderAirborneObserved = "false";
    document.body.dataset.changedOrderScaleStable = "false";
    document.body.dataset.changedOrderDescentObserved = "false";
    document.body.dataset.changedOrderLandingScaleStable = "false";
    document.body.dataset.changedOrderHandoffObserved = "false";
    document.body.dataset.changedOrderMaximumHeightDifference = "0";
    document.body.dataset.changedOrderCameraObserved = "false";
    document.body.dataset.changedOrderVisibleDuringGlide = "false";
    document.body.dataset.changedOrderAlignedBeforeRemoval = "false";
    document.body.dataset.changedOrderLandingColorObserved = "false";
    document.body.dataset.changedOrderLandingShadowObserved = "false";
    document.body.dataset.changedOrderOuterShadowObserved = "false";
    document.body.dataset.changedOrderMovingStyleObserved = "false";
    document.body.dataset.unexpectedOrderOverflowObserved = "false";
    document.body.dataset.orderAnimationInitialScroll = String(window.scrollY);
    const started = performance.now();
    const sample = () => {
      let maximum = Number(document.body.dataset.orderAnimationMax ?? "0");
      const floating = document.querySelector<HTMLElement>(
        `.order-floating-table[data-floating-order-id]`,
      );
      if (floating) {
        document.body.dataset.changedOrderMovingStyleObserved = "true";
        const transform = getComputedStyle(floating).transform;
        if (transform !== "none")
          maximum = Math.max(
            maximum,
            Math.abs(new DOMMatrixReadOnly(transform).m42),
          );
        const animation = floating.getAnimations()[0];
        const duration = animation?.effect?.getTiming().duration;
        const currentTime = Number(animation?.currentTime ?? 0);
        const frames = (animation?.effect as KeyframeEffect)?.getKeyframes();
        const landingCellAnimation = floating
          .querySelector("td")
          ?.getAnimations()[0];
        const landingCellFrames = (
          landingCellAnimation?.effect as KeyframeEffect | undefined
        )?.getKeyframes();
        const finalCellFrame = landingCellFrames?.at(-1);
        if (
          finalCellFrame &&
          ["#fff5ca", "rgb(255, 245, 202)"].includes(
            String(finalCellFrame.backgroundColor),
          )
        )
          document.body.dataset.changedOrderLandingColorObserved = "true";
        const floatingRect = floating.getBoundingClientRect();
        if (
          currentTime >= 350 &&
          currentTime <= 950 &&
          floatingRect.bottom > 0 &&
          floatingRect.top < window.innerHeight
        )
          document.body.dataset.changedOrderVisibleDuringGlide = "true";
        if (
          Math.abs(
            window.scrollY -
              Number(document.body.dataset.orderAnimationInitialScroll),
          ) > 5
        )
          document.body.dataset.changedOrderCameraObserved = "true";
        const changedRow = document
          .querySelector(`a[href^="${changedHref}"]`)
          ?.closest("tr");
        if (changedRow) {
          document.body.dataset.changedOrderMaximumHeightDifference = String(
            Math.max(
              Number(
                document.body.dataset.changedOrderMaximumHeightDifference ??
                  "0",
              ),
              Math.abs(
                floatingRect.height - changedRow.getBoundingClientRect().height,
              ),
            ),
          );
        }
        if (
          changedRow &&
          !changedRow.classList.contains("order-row-floating-placeholder") &&
          Number(getComputedStyle(floating).opacity) > 0 &&
          Number(getComputedStyle(floating).opacity) < 1
        )
          document.body.dataset.changedOrderHandoffObserved = "true";
        if (
          currentTime >= 1100 &&
          changedRow &&
          Math.abs(changedRow.getBoundingClientRect().top - floatingRect.top) <
            6
        )
          document.body.dataset.changedOrderAlignedBeforeRemoval = "true";
        if (duration === 1490 && frames?.length === 5) {
          const [startFrame, liftFrame, holdFrame, glideFrame, landFrame] =
            frames;
          if (startFrame?.transform)
            document.body.dataset.changedOrderAnimationObserved = "true";
          if (
            startFrame?.transform &&
            liftFrame?.transform &&
            new DOMMatrixReadOnly(String(startFrame.transform)).m42 -
              new DOMMatrixReadOnly(String(liftFrame.transform)).m42 >=
              29
          )
            document.body.dataset.changedOrderLiftObserved = "true";
          if (
            liftFrame?.transform === holdFrame?.transform &&
            glideFrame?.transform &&
            String(glideFrame.boxShadow).includes("18px 30px -14px")
          )
            document.body.dataset.changedOrderAirborneObserved = "true";
          if (
            frames.every(
              (frame) =>
                frame.transform &&
                new DOMMatrixReadOnly(String(frame.transform)).m11 === 1,
            )
          )
            document.body.dataset.changedOrderScaleStable = "true";
          if (
            glideFrame?.transform &&
            landFrame?.transform &&
            new DOMMatrixReadOnly(String(landFrame.transform)).m42 -
              new DOMMatrixReadOnly(String(glideFrame.transform)).m42 >=
              29 &&
            new DOMMatrixReadOnly(String(glideFrame.transform)).m11 === 1 &&
            new DOMMatrixReadOnly(String(landFrame.transform)).m11 === 1
          )
            document.body.dataset.changedOrderDescentObserved = "true";
          if (
            glideFrame?.transform &&
            landFrame?.transform &&
            new DOMMatrixReadOnly(String(glideFrame.transform)).m11 === 1 &&
            new DOMMatrixReadOnly(String(landFrame.transform)).m11 === 1
          )
            document.body.dataset.changedOrderLandingScaleStable = "true";
          if (
            frames.some((frame) =>
              String(frame.boxShadow).includes("18px 30px -14px"),
            )
          )
            document.body.dataset.changedOrderOuterShadowObserved = "true";
          if (
            String(landFrame?.boxShadow).includes("rgba(74, 54, 0, 0)") ||
            String(landFrame?.boxShadow).includes("/ 0%)")
          )
            document.body.dataset.changedOrderLandingShadowObserved = "true";
        }
        const scroll = document.querySelector<HTMLElement>(
          ".order-table-scroll",
        );
        if (
          scroll &&
          (getComputedStyle(scroll).overflowY !== "hidden" ||
            scroll.scrollWidth > scroll.clientWidth + 1)
        )
          document.body.dataset.unexpectedOrderOverflowObserved = "true";
      }
      document
        .querySelectorAll(".order-list-body > tr > td")
        .forEach((cell) => {
          const transform = getComputedStyle(cell).transform;
          if (transform === "none") return;
          maximum = Math.max(
            maximum,
            Math.abs(new DOMMatrixReadOnly(transform).m42),
          );
          const changed = cell
            .closest("tr")
            ?.querySelector(`a[href^="${changedHref}"]`);
          const moving =
            changed &&
            cell.closest("tr")?.classList.contains("order-row-status-moving");
          if (moving) {
            document.body.dataset.changedOrderMovingStyleObserved = "true";
            const scroll = document.querySelector<HTMLElement>(
              ".order-table-scroll",
            );
            if (
              scroll &&
              (getComputedStyle(scroll).overflowY !== "hidden" ||
                scroll.scrollWidth > scroll.clientWidth + 1)
            )
              document.body.dataset.unexpectedOrderOverflowObserved = "true";
          }
          for (const animation of cell.getAnimations()) {
            const duration = animation.effect?.getTiming().duration;
            const frames = (animation.effect as KeyframeEffect).getKeyframes();
            if (changed && duration === 1490) {
              const [startFrame, liftFrame, , glideFrame] = frames;
              if (startFrame?.transform)
                document.body.dataset.changedOrderAnimationObserved = "true";
              if (
                startFrame?.transform &&
                liftFrame?.transform &&
                new DOMMatrixReadOnly(String(startFrame.transform)).m42 -
                  new DOMMatrixReadOnly(String(liftFrame.transform)).m42 >=
                  29
              )
                document.body.dataset.changedOrderLiftObserved = "true";
              if (
                glideFrame?.transform &&
                new DOMMatrixReadOnly(String(glideFrame.transform)).m42 <= -29
              )
                document.body.dataset.changedOrderAirborneObserved = "true";
              if (
                frames.some((frame) =>
                  String(frame.boxShadow).includes("18px 30px -14px"),
                )
              )
                document.body.dataset.changedOrderOuterShadowObserved = "true";
            }
            if (!changed && duration === 1310) {
              document.body.dataset.displacedOrderAnimationObserved = "true";
              const [startFrame, holdFrame] = frames;
              if (
                startFrame?.transform &&
                holdFrame?.transform === startFrame.transform
              )
                document.body.dataset.displacedOrderHoldObserved = "true";
            }
          }
        });
      document.body.dataset.orderAnimationMax = String(maximum);
      if (performance.now() - started < 5000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, olderOrderPath);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(0);
  await dialog
    .getByRole("button", { name: "Conferma annullamento" })
    .click({ delay: 150 });
  await expect(dialog).not.toBeVisible();
  await expect(olderRow).toHaveClass(/order-row-status-moving/);
  await expect(
    page.locator(
      `.order-floating-table[data-floating-order-id]:has-text("${await olderRow.locator(".order-code-link").innerText()}")`,
    ),
  ).toBeVisible();

  await expect(page.locator("tbody tr").first()).toContainText(
    await olderRow.locator(".order-code-link").innerText(),
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-animation-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-displaced-order-animation-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-displaced-order-hold-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-lift-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-airborne-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-scale-stable",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-descent-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-landing-scale-stable",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-handoff-observed",
    "true",
  );
  expect(
    Number(
      await page
        .locator("body")
        .getAttribute("data-changed-order-maximum-height-difference"),
    ),
  ).toBeLessThan(0.5);
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-camera-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-visible-during-glide",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-aligned-before-removal",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-landing-color-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-landing-shadow-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-outer-shadow-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-changed-order-moving-style-observed",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-unexpected-order-overflow-observed",
    "false",
  );
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.orderAnimationMax ?? "0"),
    ),
  ).toBeGreaterThan(1);
  await expect(olderRow).toHaveClass(/order-row-status-highlight/, {
    timeout: 2000,
  });
  expect(
    await olderRow.evaluate((element) =>
      element
        .getAnimations()
        .flatMap((animation) =>
          (animation.effect as KeyframeEffect).getKeyframes(),
        )
        .map((frame) => frame.backgroundColor)
        .filter(Boolean),
    ),
  ).toEqual(["rgb(255, 245, 202)", "rgb(255, 245, 202)", "rgba(0, 0, 0, 0)"]);
  await expect(olderRow).not.toHaveClass(/order-row-status-highlight/, {
    timeout: 2000,
  });
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(scrollBefore);
  await expect(olderRow).toBeInViewport();

  await page.reload();
  await expect(olderRow).not.toHaveClass(/order-row-status-highlight/);

  await page.goto("/settings/interface-motion");
  const viewportFollowSwitch = page.getByRole("switch", {
    name: "Segui lo spostamento della riparazione",
  });
  await expect(viewportFollowSwitch).toHaveAttribute("aria-checked", "true");
  await viewportFollowSwitch.click();
  await expect(viewportFollowSwitch).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(viewportFollowSwitch).toHaveAttribute("aria-checked", "false");

  await page.goto("/orders");
  const fixedViewportRow = page.locator(
    `tbody tr:has(a[href^="${newerOrderPath}"])`,
  );
  await page
    .locator("tbody tr")
    .first()
    .evaluate((element) => (element.style.height = "520px"));
  await fixedViewportRow.scrollIntoViewIfNeeded();
  await fixedViewportRow.click();
  await fixedViewportRow.locator(".status-dropdown-trigger").click();
  await page
    .locator(".status-dropdown-menu")
    .getByRole("option", { name: "Annullato", exact: true })
    .click();
  const fixedViewportDialog = page.getByRole("dialog", {
    name: "Annulla scheda",
  });
  await expect(fixedViewportDialog).toBeVisible();
  await fixedViewportDialog
    .getByRole("button", { name: "Conferma annullamento" })
    .click({ delay: 150 });
  await expect(fixedViewportRow).toHaveClass(/order-row-status-moving/);
  const fixedViewportScroll = await page.evaluate(() => window.scrollY);
  await expect(page.locator(".order-floating-table")).toBeVisible();
  await expect(fixedViewportRow).toHaveClass(/order-row-status-highlight/, {
    timeout: 2000,
  });
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBe(fixedViewportScroll);
});
test("repair list skips movement animation when the row stays in place", async ({
  page,
}) => {
  await fillOrder(page, { manual: true });
  await save(page);
  const orderPath = new URL(page.url()).pathname;
  const code = (await page.locator("h1").innerText()).trim();
  await page.goto(`/orders?q=${encodeURIComponent(code)}`);
  const row = page.locator(`tbody tr:has(a[href^="${orderPath}"])`);
  await expect(row).toBeVisible();
  await row.evaluate((element) => {
    document.body.dataset.samePositionAnimationObserved = "false";
    const observer = new MutationObserver(() => {
      if (element.classList.contains("order-row-status-moving"))
        document.body.dataset.samePositionAnimationObserved = "true";
    });
    observer.observe(element, { attributes: true, attributeFilter: ["class"] });
    window.setTimeout(() => observer.disconnect(), 3000);
  });
  await row.click();
  await row.locator(".status-dropdown-trigger").click();
  await page
    .locator(".status-dropdown-menu")
    .getByRole("option", { name: "Da ritirare", exact: true })
    .click();
  await expect(row.locator(".badge")).toContainText("Da ritirare");
  await expect(row).not.toHaveClass(/order-row-status-moving/);
  await expect(page.locator(".order-floating-table")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-same-position-animation-observed",
    "false",
  );
});
test("repair list delivery uses the shared checkout and refreshes the row", async ({
  page,
}) => {
  await fillOrder(page);
  await save(page);
  await state(page, "READY");
  const orderPath = new URL(page.url()).pathname;
  await page.goto("/orders");
  const row = page.locator(`tbody tr:has(a[href^="${orderPath}"])`);
  await row.click();
  await row.locator(".status-dropdown-trigger").click();
  await page
    .locator(".status-dropdown-menu")
    .getByRole("option", { name: "Consegnato", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Incassa e consegna" });
  await expect(dialog.getByLabel("Importo (€)", { exact: true })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("button", { name: /Incassa e consegna/ })
    .click({ delay: 150 });
  await expect(dialog).toHaveCount(0);
  await expect(row).not.toHaveClass(/order-row-active/);
  await expect(row.locator(".badge")).toContainText("Consegnato");
  await expect(row).toContainText("Consegnato");
  await expect(row).toContainText("0,00 €");
  await row.locator("td").nth(2).click();
  await expect(
    page.getByRole("dialog", { name: "Incassa e consegna" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(row.locator(".badge")).toContainText("Consegnato");
  await expect(row).toContainText("0,00 €");
});

test("repair list cancellation uses the shared confirmation and locks the row", async ({
  page,
}) => {
  await fillOrder(page);
  await save(page);
  const orderPath = new URL(page.url()).pathname;
  await page.goto("/orders");
  const row = page.locator(`tbody tr:has(a[href^="${orderPath}"])`);
  await row.click();
  await row.locator(".status-dropdown-trigger").click();
  await page
    .locator(".status-dropdown-menu")
    .getByRole("option", { name: "Annullato", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Annulla scheda" });
  await dialog
    .getByLabel("Motivo dell'annullamento (facoltativo)")
    .fill("Cliente rinuncia");
  await dialog
    .getByRole("button", { name: "Conferma annullamento" })
    .click({ delay: 150 });
  await expect(dialog).toHaveCount(0);
  await expect(row).not.toHaveClass(/order-row-active/);
  await expect(row).toContainText("Annullato");
  await expect(row).toContainText("0,00 €");
  await expect(row.getByLabel("Incassato", { exact: true })).toHaveCount(0);
  await row.locator("td").nth(2).click();
  await expect(
    page.getByRole("dialog", { name: "Annulla scheda" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(row.locator(".badge")).toContainText("Annullato");
  await expect(row).toContainText("0,00 €");
});

test("service order deletion uses the shared dialog form layout", async ({
  page,
}) => {
  await fillOrder(page);
  await save(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const actions = page.locator(".secondary-actions");
  const trigger = actions.locator("summary");
  await trigger.click();
  await actions.locator(".danger-text").click();

  const dialog = page.getByRole("dialog");
  const form = dialog.locator(":scope > .dialog-form-layout");
  const body = form.locator(":scope > .dialog-body");
  const footer = form.locator(":scope > .dialog-footer");
  await expect(body).toHaveCount(1);
  await expect(footer).toBeInViewport();
  await expect(footer).toHaveCSS("flex-direction", "column");

  await footer.locator(".button-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeVisible();
});

test("service order cancellation uses the shared dialog form layout", async ({
  page,
}) => {
  await fillOrder(page);
  await save(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const status = page.locator(".detail-status .status-dropdown-trigger");
  const initialStatus = (await status.innerText()).trim();
  await status.click();
  await page.getByRole("option", { name: "Annullato", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Annulla scheda" });
  const form = dialog.locator(":scope > .dialog-form-layout");
  const body = form.locator(":scope > .dialog-body");
  const footer = form.locator(":scope > .dialog-footer");
  await expect(body).toBeVisible();
  await expect(footer).toBeInViewport();
  await expect(footer).toHaveCSS("flex-direction", "column");
  await body
    .getByLabel("Motivo dell'annullamento (facoltativo)")
    .fill("Bozza non salvata");

  await footer.locator(".button-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(status).toBeVisible();
  expect((await status.innerText()).trim()).toBe(initialStatus);
});

test("repair detail cancellation persists after a reload", async ({ page }) => {
  await fillOrder(page);
  await save(page);
  await page.locator(".detail-status .status-dropdown-trigger").click();
  await page.getByRole("option", { name: "Annullato", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Annulla scheda" });
  await dialog.getByRole("button", { name: "Conferma annullamento" }).click();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toContainText("Annullato");
  await page.reload();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toContainText("Annullato");
});

test("diagnostic cancellation can collect the remaining diagnostic fee", async ({
  page,
}) => {
  await fillOrder(page, { diagnosis: true });
  await save(page);
  await page.locator(".detail-status .status-dropdown-trigger").click();
  await page.getByRole("option", { name: "Annullato", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Annulla scheda" });
  await dialog
    .getByLabel("Incassa il costo diagnosi prima di annullare", {
      exact: true,
    })
    .check();
  const amount = dialog.getByLabel("Costo diagnosi ancora da incassare", {
    exact: true,
  });
  await expect(amount).not.toHaveValue("0.00");
  await dialog
    .getByRole("button", { name: "Conferma annullamento", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toContainText("Annullato");
  await expect(page.locator(".payments-card")).toContainText("Contanti");
  const cancelledOrderPath = new URL(page.url()).pathname;
  await page.goto("/orders");
  const cancelledRow = page.locator(
    `tbody tr:has(a[href^="${cancelledOrderPath}"])`,
  );
  await expect(cancelledRow.locator(".order-payment-values")).toContainText(
    "30,00 €",
  );
  await cancelledRow.locator(".order-code-link").click();
  await page.getByText("Altre azioni", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Elimina definitivamente la scheda",
      exact: true,
    })
    .click();
  const deleteDialog = page.getByRole("dialog", {
    name: "Elimina definitivamente la scheda",
  });
  await expect(deleteDialog).toContainText("contiene incassi o rimborsi");
  await expect(
    deleteDialog.getByLabel("Numero scheda di servizio", { exact: true }),
  ).toHaveCount(0);
});

test("diagnostic order saves faults, date and quote in one progressive flow", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await chooseRepairDevice(page, "Apple iPhone 13");
  await page
    .getByRole("button", { name: "Imposta diagnosi", exact: true })
    .click();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  await expect(
    page.getByLabel("Costo diagnosi (€) *", { exact: true }),
  ).toHaveValue("30");
  await expect(page.getByLabel("Intervento 1", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Completati 3/3 passaggi obbligatori").first(),
  ).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/new-order-inspection-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await save(page);
  const orderPath = new URL(page.url()).pathname;
  const status = page.locator(".detail-status .status-dropdown-trigger");
  await expect(status).toContainText("In diagnosi");
  const completeInspection = page.getByRole("button", {
    name: "Completa diagnosi e crea preventivo",
    exact: true,
  });
  await expect(completeInspection).toHaveClass(/status-action-trigger/);
  expect(
    await status.evaluate((element) => getComputedStyle(element).color),
  ).toBe(
    await completeInspection.evaluate(
      (element) => getComputedStyle(element).color,
    ),
  );
  expect(
    await status.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe(
    await completeInspection.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  );
  const quote = page.getByTestId("quote-card");
  const details = page.getByTestId("details-card");
  await expect(quote).toContainText("Dispositivo in diagnosi");
  await expect(quote).toContainText("30,00 €");
  await expect(quote).toContainText("6,60 €");
  await expect(quote.getByRole("row")).toHaveCount(0);
  await details.locator(".order-card-heading").click();
  await expect(details.locator(".detail-repair-summaries")).toHaveCount(0);
  await details.locator(".order-card-heading").click();

  await status.click();
  const statusMenu = page.locator(".status-dropdown-menu");
  await expect(
    statusMenu.getByRole("option", { name: "In riparazione", exact: true }),
  ).toHaveCount(0);
  await expect(
    statusMenu.getByRole("option", { name: "Da ritirare", exact: true }),
  ).toHaveCount(0);
  await expect(
    statusMenu.getByRole("option", { name: "Consegnato", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto("/orders");
  const listRow = page.locator(`tbody tr:has(a[href^="${orderPath}"])`);
  await expect(listRow).toContainText("In diagnosi");
  await expect(listRow).toContainText("Problema da diagnosticare");
  await listRow.getByRole("link").first().click();

  await quote.getByRole("button", { name: "Diagnosi e preventivo" }).click();
  await page
    .getByRole("button", {
      name: "Completa diagnosi e crea preventivo",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Completa diagnosi e crea preventivo",
  });
  const inspectionForm = dialog.locator(":scope > .dialog-form-layout");
  const inspectionFooter = inspectionForm.locator(":scope > .dialog-footer");
  await expect(inspectionForm.locator(":scope > .dialog-body")).toBeVisible();
  await expect(inspectionFooter).toBeInViewport();
  await expect(dialog.locator(".quote-item")).toHaveCount(0);
  const saveInspection = dialog.getByRole("button", {
    name: "Salva",
    exact: true,
  });
  await expect(saveInspection).toBeDisabled();
  await dialog.getByLabel("Display rotto", { exact: true }).check();
  const result = "Display danneggiato, necessaria la sostituzione";
  await dialog.getByLabel(/Descrizione aggiuntiva/).fill(result);
  await dialog
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  const addInspectionProject = dialog.getByRole("button", {
    name: "Intervento",
    exact: true,
  });
  await expect(addInspectionProject).toBeVisible();
  await addInspectionProject.hover();
  await expect(addInspectionProject).toHaveCSS(
    "background-color",
    "rgb(255, 248, 217)",
  );
  await chooseRepairProjects(page, ["sostituzione display"], dialog);
  await expect(dialog.locator(".selected-project-summary")).toContainText(
    "100,00 €",
  );
  await expect(dialog.locator(".price-option-picker-summary")).toContainText(
    "Prezzo di listino",
  );
  await expect(dialog.locator(".price-option-picker-summary")).toContainText(
    "Display LCD standard",
  );
  await expect(dialog.locator(".quote-item")).toHaveCount(1);
  await dialog.locator(".selected-project-summary").hover();
  await expect(
    dialog.locator(".selected-project-summary .summary-action"),
  ).toBeVisible();
  await choosePriceOption(page, "Display OLED alta qualità", dialog);
  await expect(dialog.locator(".price-option-picker-summary")).toContainText(
    "119,00 €",
  );
  const projectActions = dialog.locator(
    ".selected-project-summary .selected-part-actions",
  );
  const changeProject = projectActions.locator(".summary-action");
  const removeProject = projectActions.locator(".quick-service-remove");
  await dialog.locator(".selected-project-summary").hover();
  await expect(removeProject).toBeVisible();
  const [changeBox, removeBox] = await Promise.all([
    changeProject.boundingBox(),
    removeProject.boundingBox(),
  ]);
  expect(changeBox!.x).toBeLessThan(removeBox!.x);
  expect(
    Math.abs(
      changeBox!.y +
        changeBox!.height / 2 -
        (removeBox!.y + removeBox!.height / 2),
    ),
  ).toBeLessThanOrEqual(1);
  await expect(saveInspection).toBeEnabled();
  await expect(inspectionFooter).toBeInViewport();
  await saveInspection.dblclick();
  await expect(dialog).toHaveCount(0);
  await expect(status).toContainText("In riparazione");
  await expect(details).toContainText("Display rotto");
  await expect(details).toContainText(result);
  await expect(details.locator(".detail-repair-summaries")).toBeVisible();
  await expect(details.locator(".selected-project-summary")).toContainText(
    "sostituzione display",
  );
  await expect(details.locator(".selected-part-summary")).toContainText(
    "Display OLED alta qualità",
  );
  await details.locator(".selected-part-summary .summary-action").click();
  await expect(
    page.getByRole("dialog", { name: "Opzioni ricambio", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Opzioni ricambio", exact: true })
    .getByRole("button", { name: "Chiudi", exact: true })
    .click();
  await details.getByRole("button", { name: "Annulla", exact: true }).click();
  await quote.locator(".order-card-heading").click();
  await expect(quote).toContainText("Costo diagnosi (IVA esclusa)");
  const history = page.getByTestId("history-card");
  await expect(
    page.locator(".detail-primary-actions button.stage-primary-action"),
  ).toHaveCount(0);
  await history.locator(".order-card-heading").click();
  await expect(history).toContainText("Diagnosi avviata");
  await expect(history).toContainText("Diagnosi completata");
  await expect(history).toContainText("Preventivo creato");
  await expect(history).toContainText("Stato aggiornato: In riparazione");
  const balanceCard = page.locator(".balance-card");
  await expect(balanceCard).toContainText("Riparazione: 119,00 €");
  await expect(balanceCard).toContainText("Diagnosi: 30,00 €");
  await expect(balanceCard).toContainText("Totale: 149,00 €");
  await state(page, "READY");
  await page.getByRole("button", { name: /Incassa e consegna/ }).click();
  await expect(page.locator(".message.error")).toHaveCount(0);
  await expect(status).toContainText("Consegnato");
});

test("sales history uses a monthly filter", async ({ page }) => {
  await page.goto("/retail");
  await page.getByRole("button", { name: /Cavo USB-C Test/ }).click();
  await page.getByRole("button", { name: /Conferma incasso.*12,00/ }).click();
  const saleSuccess = page.getByRole("dialog");
  await expect(saleSuccess.getByRole("status")).toContainText(
    "Vendita completata",
  );
  await saleSuccess.getByRole("button", { name: "Prossima vendita" }).click();
  await expect(saleSuccess).toHaveCount(0);
  await page.getByRole("button", { name: "Vendite", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator(":scope > .dialog-body.retail-history-dialog"),
  ).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox?.width).toBe(880);
  expect(dialogBox?.height).toBe(680);
  const periodPicker = dialog.locator(".retail-period-picker");
  await expect(periodPicker).toHaveCSS("position", "absolute");
  await expect(periodPicker).toHaveCSS("width", "180px");
  const period = dialog.getByLabel("Mese", { exact: true });
  await expect(period).toHaveAttribute("type", "month");
  await expect(period).toHaveCSS("cursor", "pointer");
  const close = dialog.getByRole("button", { name: "Chiudi" });
  const [periodBox, closeBox] = await Promise.all([
    period.boundingBox(),
    close.boundingBox(),
  ]);
  expect(periodBox!.width).toBeLessThanOrEqual(180);
  expect(periodBox!.x + periodBox!.width).toBeLessThan(closeBox!.x);
  expect(closeBox!.x - (periodBox!.x + periodBox!.width)).toBeLessThanOrEqual(
    16,
  );
  const currentMonth = await period.inputValue();
  await period.fill("2025-01");
  const emptyState = dialog.locator(".inventory-empty");
  await expect(emptyState).toContainText("Nessuna vendita registrata.");
  await expect(emptyState).toHaveCSS("min-height", "128px");
  await expect(emptyState).toHaveCSS("padding", "32px 24px");
  await period.fill(currentMonth);
  const historyRow = dialog.locator("tbody tr").first();
  await expect(historyRow).toBeVisible();
  const deleteAction = historyRow.locator(
    ".sale-actions-cell .record-icon-delete",
  );
  await expect(deleteAction).toHaveCSS("opacity", "0");
  await expect(deleteAction).toHaveCSS("pointer-events", "none");
  await historyRow.hover();
  await expect(deleteAction).toHaveCSS("opacity", "1");
  await expect(deleteAction).toHaveCSS("pointer-events", "auto");
  const saleNumber = historyRow.locator(".sale-number-button");
  const saleNumberLabel = saleNumber.locator(":scope > span");
  await expect(saleNumber).toHaveCSS("color", "rgb(113, 83, 0)");
  await saleNumber.hover();
  await expect(saleNumber).toHaveCSS("color", "rgb(84, 62, 0)");
  await expect
    .poll(() =>
      saleNumberLabel.evaluate(
        (element) => getComputedStyle(element, "::after").opacity,
      ),
    )
    .toBe("1");
  await saleNumber.click();
  await expect(
    dialog.locator(":scope > .dialog-body.retail-sale-dialog"),
  ).toBeVisible();
  const detailBody = dialog.locator(":scope > .dialog-body.retail-sale-dialog");
  await expect(detailBody).toHaveCSS("display", "grid");
  await expect(detailBody).toHaveCSS("gap", "16px");
  await expect(dialog.locator(".dialog-heading h2 > span")).toHaveCSS(
    "gap",
    "8px",
  );
  await expect(
    dialog.getByRole("button", { name: /Storico vendite/ }),
  ).toHaveCSS("margin", "0px");
  const detailDialogBox = await dialog.boundingBox();
  expect(detailDialogBox?.width).toBe(880);
  expect(detailDialogBox?.height).toBe(680);
  await dialog.getByRole("button", { name: /Storico vendite/ }).click();
  await expect(
    dialog.locator(":scope > .dialog-body.retail-history-dialog"),
  ).toBeVisible();
  await historyRow.hover();
  await historyRow.getByRole("button", { name: /Elimina vendita V-/ }).click();
  const deleteDialog = page.getByRole("dialog", {
    name: "Elimina vendita",
  });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toHaveCSS("width", "460px");
  await expect(deleteDialog).toContainText(
    "Eliminare definitivamente questa vendita e ripristinare le scorte?",
  );
  await expect(page.getByRole("dialog")).toHaveCount(2);
  await deleteDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(page.locator('select[name="mode"]')).toHaveCount(0);
  await expect(page).toHaveURL(/\/retail$/);
  await dialog.getByRole("button", { name: "Chiudi" }).click();

  await page.goto("/retail/sales");
  await expect(page).toHaveURL(/\/retail\?view=sales$/);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Chiudi" }).click();
  await expect(page).toHaveURL(/\/retail$/);
});

test("completes a retail sale and opens its immutable receipt", async ({
  page,
}) => {
  await page.goto("/");
  const readCents = async (amount: Locator) => {
    if (!(await amount.count())) return 0;
    const text = await amount.innerText();
    const value = text.match(/-?[\d.]+,\d{2}/)?.[0];
    expect(value).toBeDefined();
    return Math.round(
      Number(value!.replaceAll(".", "").replace(",", ".")) * 100,
    );
  };
  const initialDay = page.locator(".revenue-day").last();
  const initialDayRetail = await readCents(
    initialDay
      .locator(".revenue-tooltip span")
      .filter({ hasText: "Vendita prodotti" })
      .locator("b"),
  );
  const initialRetail = await readCents(
    page
      .locator(".revenue-source-legend p")
      .filter({ hasText: "Vendita prodotti" })
      .locator("strong"),
  );
  const initialCard = await readCents(
    page
      .locator(".payment-method-row")
      .filter({ hasText: "Carta" })
      .locator("strong"),
  );
  await page.goto("/retail");
  const products = page.locator(".retail-product-grid");
  const cable = products.getByRole("button", { name: /Cavo USB-C Test/ });
  await expect(cable.locator("[data-category-icon='cable']")).toBeVisible();
  await cable.click();
  await cable.click();
  const cartRow = page.locator(".retail-cart-row");
  const retailQuantity = cartRow.getByRole("spinbutton", {
    name: "Quantità Cavo USB-C Test",
    exact: true,
  });
  await expect(retailQuantity).toHaveValue("2");
  await expect(retailQuantity).toHaveCSS("text-align", "center");
  const clearCart = page.getByRole("button", { name: "Svuota", exact: true });
  const [clearCartBox, productTotalBox] = await Promise.all([
    clearCart.boundingBox(),
    cartRow.locator(":scope > b").boundingBox(),
  ]);
  expect(
    Math.abs(
      clearCartBox!.x +
        clearCartBox!.width -
        (productTotalBox!.x + productTotalBox!.width),
    ),
  ).toBeLessThanOrEqual(1);
  await expect(clearCart).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(clearCart).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await clearCart.hover();
  await expect(clearCart).toHaveCSS("background-color", "rgb(255, 240, 238)");
  await expect(clearCart).toHaveCSS("transform", "none");
  await cartRow.hover();
  const removeProduct = cartRow.getByRole("button", {
    name: "Rimuovi Cavo USB-C Test",
    exact: true,
  });
  const removeProductBox = await removeProduct.boundingBox();
  expect(removeProductBox!.width).toBe(28);
  expect(removeProductBox!.height).toBe(28);
  await removeProduct.hover();
  await expect(removeProduct).toHaveCSS(
    "background-color",
    "rgb(255, 240, 238)",
  );
  await expect(removeProduct).toHaveCSS("transform", "none");
  await retailQuantity.fill("");
  await expect(retailQuantity).toHaveValue("");
  await retailQuantity.fill("5");
  await retailQuantity.press("Tab");
  await expect(retailQuantity).toHaveValue("5");
  await retailQuantity.fill("10");
  await retailQuantity.press("Enter");
  await expect(
    cartRow.getByRole("button", { name: "+ Cavo USB-C Test", exact: true }),
  ).toBeDisabled();
  await retailQuantity.fill("2");
  await retailQuantity.press("Enter");
  await expect(retailQuantity).toHaveValue("2");
  await expect(
    products.getByRole("button", { name: /Cover esaurita Test/ }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Bonifico" })).toHaveCount(0);
  const subtotalAmount = page
    .locator(".retail-totals > div")
    .first()
    .locator("strong");
  const [productTotalAlignedBox, subtotalAlignedBox] = await Promise.all([
    cartRow.locator(":scope > b").boundingBox(),
    subtotalAmount.boundingBox(),
  ]);
  expect(
    Math.abs(
      productTotalAlignedBox!.x +
        productTotalAlignedBox!.width -
        (subtotalAlignedBox!.x + subtotalAlignedBox!.width),
    ),
  ).toBeLessThanOrEqual(1);
  const discountButton = page.getByRole("button", {
    name: "Modifica sconto",
    exact: true,
  });
  const discountPencil = discountButton.locator("svg");
  const discountAmount = discountButton.locator("span");
  await page.mouse.move(0, 0);
  await expect(discountPencil).toHaveCSS("opacity", "0");
  const [subtotalBox, discountAmountBox] = await Promise.all([
    subtotalAmount.boundingBox(),
    discountAmount.boundingBox(),
  ]);
  expect(
    Math.abs(
      subtotalBox!.x +
        subtotalBox!.width -
        (discountAmountBox!.x + discountAmountBox!.width),
    ),
  ).toBeLessThanOrEqual(1);
  await discountButton.hover();
  await expect(discountPencil).toHaveCSS("opacity", "1");
  await discountButton.click();
  const discountInput = page.getByLabel("Sconto", { exact: true });
  await expect(discountInput).toBeVisible();
  await discountInput.fill("0");
  await discountInput.press("Tab");
  await expect(discountButton).toBeVisible();
  const cardMethod = page.getByRole("button", { name: "Carta", exact: true });
  await expect(cardMethod.locator("svg")).toBeVisible();
  await cardMethod.click();
  await expect(cardMethod).toHaveClass(/active/);
  await page.getByRole("button", { name: /Conferma incasso.*24,00/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText("Vendita completata");
  await expect(dialog.getByRole("status")).toContainText("24,00 €");
  await dialog.getByRole("button", { name: "Vedi vendita" }).click();
  await expect(page).toHaveURL(/\/retail$/);
  await expect(dialog.getByText(/Dettaglio vendita · V-/)).toBeVisible();
  await expect(dialog.getByText("Cavo USB-C Test")).toBeVisible();
  await dialog.getByRole("button", { name: /Vendita completata/ }).click();
  await dialog.getByRole("button", { name: "Prossima vendita" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".retail-empty-cart")).toBeVisible();

  await page.getByRole("button", { name: "Vendite", exact: true }).click();
  const historyDialog = page.getByRole("dialog");
  const salesMonth = historyDialog.getByLabel("Mese", { exact: true });
  await salesMonth.click({ position: { x: 8, y: 18 } });
  const salesCalendar = historyDialog.locator(".date-picker-popover");
  await expect(salesCalendar).toBeVisible();
  expect(
    await salesCalendar.evaluate((element) => element.parentElement?.tagName),
  ).toBe("DIALOG");
  await page.keyboard.press("Escape");
  const saleNumber = historyDialog
    .getByRole("button", { name: /^V-\d{8}\d{3}$/ })
    .first();
  await expect(saleNumber).toHaveClass(/order-code-link/);
  const historyRow = saleNumber.locator("xpath=ancestor::tr");
  await historyRow.hover();
  await expect(
    historyRow.getByRole("button", { name: /Elimina vendita V-/ }),
  ).toBeVisible();
  await expectMatchingColumn(
    historyDialog.locator("th").nth(2),
    historyRow.locator("td").nth(2),
    "right",
  );
  await expectMatchingColumn(
    historyDialog.locator("th").nth(4),
    historyRow.locator("td").nth(4),
    "right",
  );
  await expect(historyDialog.locator("th")).toHaveCount(6);
  await expect(
    historyRow
      .locator("td")
      .nth(5)
      .getByRole("button", {
        name: /Elimina vendita V-/,
      }),
  ).toBeVisible();
  await saleNumber.click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(historyDialog).toContainText("Cavo USB-C Test");
  const backToHistory = historyDialog.getByRole("button", {
    name: /Storico vendite/,
  });
  await expect(backToHistory).toHaveClass(/back-link/);
  await backToHistory.click();
  await expect(historyDialog.getByText("Numero vendita")).toBeVisible();
  await historyDialog.getByRole("button", { name: "Chiudi" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/retail$/);

  await page.goto("/");
  await page.waitForTimeout(500);
  const motionProgress = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(
      ".revenue-day:last-child .revenue-bar.retail",
    );
    const payment = document.querySelector<HTMLElement>(
      ".payment-method-row:nth-of-type(2) i",
    );
    return {
      bar: bar ? new DOMMatrixReadOnly(getComputedStyle(bar).transform).d : 1,
      payment: payment
        ? new DOMMatrixReadOnly(getComputedStyle(payment).transform).a
        : 1,
    };
  });
  expect(motionProgress.bar).toBeGreaterThan(0);
  expect(motionProgress.bar).toBeLessThan(1);
  expect(motionProgress.payment).toBeGreaterThan(0);
  expect(motionProgress.payment).toBeLessThan(1);
  await page.waitForTimeout(750);
  await expect(page.locator(".revenue-bar")).toHaveCount(21);
  const latestDay = page.locator(".revenue-day").last();
  await latestDay.hover();
  await expect(latestDay.locator(".revenue-tooltip")).toHaveCSS("opacity", "1");
  expect(
    await readCents(
      latestDay
        .locator(".revenue-tooltip span")
        .filter({ hasText: "Vendita prodotti" })
        .locator("b"),
    ),
  ).toBe(initialDayRetail + 2400);
  await expect(page.locator(".donut-segment")).toHaveCount(3);
  expect(
    await readCents(
      page
        .locator(".revenue-source-legend p")
        .filter({ hasText: "Vendita prodotti" })
        .locator("strong"),
    ),
  ).toBe(initialRetail + 2400);
  expect(
    await readCents(
      page
        .locator(".payment-method-row")
        .filter({ hasText: "Carta" })
        .locator("strong"),
    ),
  ).toBe(initialCard + 2400);
});
test("creates automatic quote, receives payment and delivers", async ({
  page,
}) => {
  await fillOrder(page);
  await openPayment(page);
  await page
    .getByLabel("Incasso alla creazione (€)", { exact: true })
    .fill("20");
  await save(page);
  const productForm = page.locator(".order-product-form");
  await page
    .getByTestId("products-card")
    .locator(".order-card-heading")
    .click();
  await productForm
    .getByRole("combobox", { name: "Prodotto", exact: true })
    .click();
  await expect(page.getByRole("option", { name: /Batteria Test/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("option", { name: /Cover esaurita Test/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("other-information-card")).toHaveCount(0);
  await expect(page.locator(".status-operation-card")).toHaveCount(0);
  await expect(page.locator(".balance-card>strong")).toContainText("80,00");
  await state(page, "READY");
  await expect(page.locator(".status-operation-card")).toHaveCount(1);
  await expect(page.locator(".secondary-status-action")).toHaveCount(0);
  await expect(page.locator('select[name="kind"]')).toHaveCount(0);
  await page.getByLabel("Importo (€)", { exact: true }).fill("80");
  await page.getByRole("button", { name: /Incassa e consegna/ }).click();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Consegnato/);
  await page
    .getByRole("link", { name: "Cliente Playwright", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Storico schede di servizio" }),
  ).toBeVisible();
});
test("discount and IVA persist without polluting historical prices", async ({
  page,
}) => {
  await fillOrder(page, { discount: true });
  await expect(page.locator(".price-breakdown")).toContainText("103,70");
  await openPayment(page);
  await page
    .getByLabel("Incasso alla creazione (€)", { exact: true })
    .fill("20");
  await save(page);
  await expect(page.locator(".balance-card>strong")).toContainText("83,70");
  await page.reload();
  await expect(page.locator(".balance-card>strong")).toContainText("83,70");
  const detailUrl = page.url();
  await page.goto("/settings/language");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.goto(detailUrl);
  await expect(
    page.getByRole("heading", { name: "报价", exact: true }),
  ).toBeVisible();
  await page.getByLabel("金额（€）", { exact: true }).fill("84");
  await page.getByRole("button", { name: "登记收款", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "超过待收余额",
  );
  await page.goto("/settings/language");
  await page.getByRole("button", { name: "Italiano", exact: true }).click();
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await chooseRepairDevice(page, "Apple iPhone 13");
  await page.getByLabel("Display rotto", { exact: true }).check();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  await expect(
    page.locator(".order-step-card").nth(2).locator(".order-step-heading"),
  ).toHaveAttribute("aria-expanded", "true");
  await chooseRepairProjects(page, ["sostituzione display"]);
  await openStep(page, 2);
  await expect(
    page.getByRole("button", {
      name: "Modifica dati Preventivo attuale",
      exact: true,
    }),
  ).toContainText("100,00");
});
test("language switching from settings persists across business pages", async ({
  page,
}) => {
  await page.goto("/settings/language");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "语言", exact: true }).first(),
  ).toBeVisible();
  await page.goto("/orders/new");
  await expect(
    page.getByRole("heading", { name: "新建服务单", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.goto("/settings/language");
  await page.getByRole("button", { name: "Italiano", exact: true }).click();
  await page.goto("/orders/new");
  await expect(
    page.getByRole("heading", {
      name: "Nuova scheda di servizio",
      exact: true,
    }),
  ).toBeVisible();
});

test("business date settings form fits a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/business-date");
  const dateSettings = page.locator(".business-date-settings");
  await chooseBusinessOption(
    page,
    "Modalità data",
    "Imposta manualmente",
    dateSettings,
  );
  await dateSettings
    .getByLabel("Imposta manualmente", { exact: true })
    .fill("2031-04-12");

  const dateForm = dateSettings.locator(".settings-date-form");
  await expect(dateForm).toHaveCSS("display", "grid");
  await expect(dateForm).toHaveCSS("gap", "14px");
  const mobileLayout = await dateForm.evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns,
    overflows: element.scrollWidth > element.clientWidth,
  }));
  expect(mobileLayout.columns.split(" ")).toHaveLength(1);
  expect(mobileLayout.overflows).toBe(false);
});

test("settings applies a manual business date and can return to system time", async ({
  page,
}) => {
  await page.goto("/settings/business-date");
  const dateSettings = page.locator(".business-date-settings");
  await chooseBusinessOption(
    page,
    "Modalità data",
    "Imposta manualmente",
    dateSettings,
  );
  await dateSettings
    .getByLabel("Imposta manualmente", { exact: true })
    .fill("2031-04-12");
  const modeSelect = dateSettings.getByRole("button", {
    name: "Modalità data",
  });
  const manualDate = dateSettings.getByLabel("Imposta manualmente", {
    exact: true,
  });
  const saveClock = dateSettings.getByRole("button", {
    name: "Salva",
    exact: true,
  });
  const dateForm = dateSettings.locator(".settings-date-form");
  await expect(dateForm).toHaveCSS("display", "grid");
  await expect(dateForm).toHaveCSS("gap", "14px");
  expect(
    await dateForm.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length,
    ),
  ).toBe(4);
  await expect(dateSettings.locator(".business-date-current")).toHaveCSS(
    "gap",
    "4px",
  );
  await expect(saveClock).toHaveCSS("min-width", "128px");
  await saveClock.hover();
  await expect(saveClock).toHaveCSS("transform", "none");
  await page.mouse.move(0, 0);
  await expect(saveClock).toBeEnabled();
  const boxesBefore = await Promise.all([
    modeSelect.boundingBox(),
    manualDate.boundingBox(),
    saveClock.boundingBox(),
  ]);
  await page.route("**/settings/business-date", async (route) => {
    if (route.request().method() === "POST")
      await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await saveClock.click();
  await expect(saveClock).toBeDisabled();
  await expect(dateSettings.getByText("Salvataggio…")).toHaveCount(0);
  const boxesDuring = await Promise.all([
    modeSelect.boundingBox(),
    manualDate.boundingBox(),
    saveClock.boundingBox(),
  ]);
  await expect(
    page.locator(".message.success", {
      hasText: "Data corrente aggiornata.",
    }),
  ).toBeVisible();
  await expect(dateSettings).toContainText("12/04/2031");
  await expect(saveClock).toBeDisabled();
  const boxesAfter = await Promise.all([
    modeSelect.boundingBox(),
    manualDate.boundingBox(),
    saveClock.boundingBox(),
  ]);
  for (let index = 0; index < boxesBefore.length; index += 1) {
    expect(boxesBefore[index]).not.toBeNull();
    expect(boxesDuring[index]).not.toBeNull();
    expect(boxesAfter[index]).not.toBeNull();
    expect(boxesDuring[index]!.x).toBeCloseTo(boxesBefore[index]!.x, 0);
    expect(boxesDuring[index]!.width).toBeCloseTo(boxesBefore[index]!.width, 0);
    expect(boxesAfter[index]!.x).toBeCloseTo(boxesBefore[index]!.x, 0);
    expect(boxesAfter[index]!.width).toBeCloseTo(boxesBefore[index]!.width, 0);
  }
  await page.unroute("**/settings/business-date");

  await page.goto("/");
  await expect(
    page.locator('.dashboard-date-filter input[type="date"]'),
  ).toHaveValue("2031-04-12");

  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await chooseRepairDevice(page, "Apple iPhone 13");
  await page.getByLabel("Display rotto", { exact: true }).check();
  await expect(
    page.getByLabel("Consegna prevista", { exact: true }),
  ).toHaveAttribute("min", "2031-04-12");

  await page.goto("/settings/business-date");
  const resetSettings = page.locator(".business-date-settings");
  await expect(
    resetSettings.getByRole("button", { name: "Salva", exact: true }),
  ).toBeDisabled();
  await chooseBusinessOption(
    page,
    "Modalità data",
    "Segui la data di sistema",
    resetSettings,
  );
  const resetClock = resetSettings.getByRole("button", {
    name: "Salva",
    exact: true,
  });
  await expect(resetClock).toBeEnabled();
  await resetClock.click();
  await expect(
    page.locator(".message.success", {
      hasText: "Data corrente aggiornata.",
    }),
  ).toBeVisible();
  await expect(resetClock).toBeDisabled();
});
test("system update page checks a private release and shows real progress", async ({
  page,
}) => {
  let updateStarted = false;
  let statusPolls = 0;
  const updateId = "0bd7d5ac-4cd6-4a7e-9fd4-d11c136caf16";
  await page.route("**/api/system-update", async (route) => {
    if (route.request().method() === "POST") {
      updateStarted = true;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          started: true,
          status: "starting",
          stage: "starting",
          updateId,
          targetVersion: "1.11.58",
          currentVersion: "1.11.57",
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        currentVersion: "1.11.57",
        authRequired: false,
        updateAvailable: true,
        latestVersion: "1.11.58",
        releaseNotes: "Correzioni e miglioramenti",
        publishedAt: "2026-10-04T12:00:00Z",
        downloadSize: 240000000,
      }),
    });
  });
  await page.route("**/api/system-update/status", (route) => {
    if (!updateStarted)
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "idle", currentVersion: "1.11.57" }),
      });
    statusPolls += 1;
    const shared = {
      updateId,
      targetVersion: "1.11.58",
      previousVersion: "1.11.57",
      currentVersion: "1.11.57",
      actualVersion: "1.11.57",
      executorAlive: true,
      executorConfirmed: true,
    };
    const nextStatus =
      statusPolls === 1
        ? { ...shared, status: "starting", stage: "starting" }
        : statusPolls === 2
          ? {
              ...shared,
              status: "downloading",
              stage: "downloading",
              completedStages: ["reading-release"],
              bytesDownloaded: 120000000,
              totalBytes: 240000000,
              bytesPerSecond: 8000000,
              etaSeconds: 15,
              progressKnown: true,
            }
          : {
              ...shared,
              status: "failed",
              stage: "validating",
              failedStage: "validating",
              recoveryStatus: "succeeded",
              completedStages: [
                "reading-release",
                "downloading",
                "verifying",
                "backing-up",
                "installing",
              ],
              message: "Aggiornamento di prova interrotto.",
              recoveryMessage:
                "La versione precedente è stata ripristinata e verificata.",
            };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(nextStatus),
    });
  });
  await page.route("**/api/system-update/status/log", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        log: "Rollback verificato in ambiente di prova.",
      }),
    }),
  );

  await page.goto("/settings/system-update");
  const italianButton = page.getByRole("button", {
    name: "Italiano",
    exact: true,
  });
  if (await italianButton.isVisible()) await italianButton.click();
  await expect(
    page.getByRole("link", { name: "Torna alle impostazioni" }),
  ).toBeVisible();
  const releaseCard = page.locator(".update-release-card");
  await expect(releaseCard).toContainText("v1.11.58");
  await expect(releaseCard).toContainText("Correzioni e miglioramenti");

  await releaseCard
    .getByRole("button", { name: "Aggiorna ora", exact: true })
    .click();
  const confirmation = page.getByRole("dialog");
  await expect(confirmation).toContainText("Conferma aggiornamento");
  await expect(confirmation).toContainText("1.11.58");
  const confirmationForm = confirmation.locator(":scope > .dialog-form-layout");
  await expect(
    confirmationForm.locator(":scope > .dialog-body.confirm-update-dialog"),
  ).toBeVisible();
  await expect(
    confirmationForm.locator(":scope > .dialog-footer"),
  ).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  expect(updateStarted).toBe(false);
  await releaseCard
    .getByRole("button", { name: "Aggiorna ora", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Aggiorna ora", exact: true })
    .click();
  await expect.poll(() => updateStarted).toBe(true);
  await expect(page.locator(".update-progress-track")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await expect(page.locator(".download-progress-meta")).toContainText(
    "7.6 MB/s",
  );
  await expect(page.locator(".download-progress-meta")).toContainText("15 s");
  await expect(page.locator(".update-result-card")).toContainText(
    "Aggiornamento non riuscito; la versione precedente è stata ripristinata e verificata.",
    { timeout: 10_000 },
  );
  await page.locator(".update-diagnostics-toggle").click();
  await expect(
    page.locator(".update-stage-list li").filter({
      hasText: "Avvio e verifica database",
    }),
  ).toHaveClass(/failed/);
  await expect(page.locator(".update-diagnostics")).toContainText(
    "Aggiornamento di prova interrotto.",
  );
  await expect(page.locator(".update-diagnostics")).toContainText(
    "Rollback verificato in ambiente di prova.",
  );
});
test("system update keeps the check action visible when an old run completed", async ({
  page,
}) => {
  await page.route("**/api/system-update", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        currentVersion: "1.11.57",
        authRequired: false,
        updateAvailable: true,
        latestVersion: "1.11.58",
        status: { status: "complete", latestVersion: "v1.11.57" },
      }),
    }),
  );

  await page.goto("/settings/system-update");
  const italianButton = page.getByRole("button", {
    name: "Italiano",
    exact: true,
  });
  if (await italianButton.isVisible()) await italianButton.click();
  await expect(
    page.getByRole("button", { name: "Controlla aggiornamenti", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".update-release-card")).toContainText("v1.11.58");
  await expect(page.locator(".update-progress-card")).toHaveCount(0);
});
test("system update page offers browser fallback and confirms authorization", async ({
  page,
}) => {
  let authorizationStarts = 0;
  let authorizationPolls = 0;
  let githubAuthorized = false;
  await page.route("**/api/system-update", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        currentVersion: "1.11.57",
        authRequired: !githubAuthorized,
        updateAvailable: false,
      }),
    }),
  );
  await page.route("**/api/system-update/auth", (route) => {
    if (route.request().method() === "POST") {
      authorizationStarts += 1;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          started: true,
          status: "opening",
          verificationUrl: "https://github.com/login/device",
        }),
      });
    }
    authorizationPolls += 1;
    if (authorizationPolls >= 3) githubAuthorized = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        authorizationPolls < 3
          ? {
              status: "waiting",
              verificationUrl: "https://github.com/login/device",
              userCode: "ABCD-1234",
            }
          : { status: "success" },
      ),
    });
  });

  await page.goto("/settings/system-update");
  const italianButton = page.getByRole("button", {
    name: "Italiano",
    exact: true,
  });
  if (await italianButton.isVisible()) await italianButton.click();
  await expect(page.locator(".system-update-page")).toContainText(
    "Per controllare gli aggiornamenti, autorizza GitHub una sola volta.",
  );
  await page
    .getByRole("button", { name: "Autorizza GitHub", exact: true })
    .click();
  await expect.poll(() => authorizationStarts).toBe(1);
  await expect(page.locator(".github-auth-fallback")).toContainText(
    "ABCD-1234",
  );
  await expect(
    page.getByRole("link", { name: "Apri autorizzazione" }),
  ).toHaveAttribute("href", "https://github.com/login/device");
  await expect(page.locator(".system-update-page")).toContainText(
    "Il sistema è aggiornato.",
  );
  await expect.poll(() => authorizationStarts).toBe(1);
  await expect(page.locator(".github-auth-fallback")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Autorizza GitHub", exact: true }),
  ).toHaveCount(0);
});
test("quick service editor uses the shared dialog form layout", async ({
  page,
}) => {
  await page.goto("/settings/quick-services");
  await page.waitForLoadState("networkidle");
  await page.locator(".catalog-manager .quick-service-service-add").click();

  const dialog = page.getByRole("dialog");
  const form = dialog.locator(":scope > .dialog-form-layout");
  const body = form.locator(":scope > .dialog-body");
  const footer = form.locator(":scope > .dialog-footer");
  await expect(body).toBeVisible();
  await expect(footer).toBeVisible();
  await expect(form.locator("input[required]")).toHaveCount(2);
  expect(
    await footer.evaluate((element) => {
      const dialogBox = element.closest("dialog")!.getBoundingClientRect();
      const footerBox = element.getBoundingClientRect();
      return dialogBox.right - footerBox.right;
    }),
  ).toBeLessThanOrEqual(32);

  await footer.locator("button[type=button]").click();
  await expect(dialog).toHaveCount(0);
});

test("settings catalogs reuse stable inline and dialog interactions", async ({
  page,
}) => {
  await page.goto("/settings/language");

  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.goto("/settings/quick-services");
  const chineseServiceManager = page.locator(".catalog-manager");
  await expect(chineseServiceManager).toBeVisible();
  await expect(page.locator(".settings-card > h2")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "无法加载数据", exact: true }),
  ).toHaveCount(0);
  await page.goto("/settings/language");
  await page.getByRole("button", { name: "Italiano", exact: true }).click();
  await page.goto("/settings/quick-services");

  const serviceManager = page.locator(".catalog-manager");
  await expect(serviceManager).toBeVisible();
  const firstServiceRow = serviceManager
    .locator(".catalog-manager-row")
    .first();
  const serviceEdit = firstServiceRow.getByRole("button", {
    name: /Modifica/,
  });
  const serviceDelete = firstServiceRow.getByRole("button", {
    name: /Elimina servizio/,
  });
  await page.mouse.move(0, 0);
  await expect(serviceEdit).toHaveCSS("opacity", "0");
  await expect(serviceDelete).toHaveCSS("opacity", "0");
  await firstServiceRow.hover();
  await expect(serviceEdit).toHaveCSS("opacity", "1");
  await expect(serviceDelete).toHaveCSS("opacity", "1");
  await expect(serviceEdit).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(serviceEdit).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await serviceEdit.hover();
  await expect(serviceEdit).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(serviceEdit).toHaveCSS("background-color", "rgb(255, 247, 214)");
  await expect(serviceDelete).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await serviceDelete.hover();
  await expect(serviceDelete).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(serviceDelete).toHaveCSS(
    "background-color",
    "rgb(255, 240, 238)",
  );
  const serviceDeleteWidth = (await serviceDelete.boundingBox())!.width;
  await serviceDelete.click();
  const serviceDeleteDialog = page.getByRole("dialog", {
    name: "Elimina servizio",
  });
  await expect(serviceDeleteDialog).toContainText(
    "Le vendite e le schede esistenti conserveranno nome e prezzo.",
  );
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await serviceDeleteDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(serviceDeleteDialog).toHaveCount(0);
  const serviceSwitch = firstServiceRow.locator(
    '.fault-enabled-switch input[type="checkbox"]',
  );
  const serviceTrack = firstServiceRow.locator(".toggle-switch-track");
  await expect(serviceTrack).toHaveCSS("width", "40px");
  await expect(serviceTrack).toHaveCSS("height", "20px");
  expect(
    await firstServiceRow
      .locator(".toggle-switch-thumb")
      .evaluate((thumb) => getComputedStyle(thumb).transitionDuration),
  ).toBe("0.28s");
  const serviceInitiallyEnabled = await serviceSwitch.isChecked();
  await serviceSwitch.click();
  await expect(serviceSwitch).toBeChecked({
    checked: !serviceInitiallyEnabled,
  });
  await serviceSwitch.click();
  await expect(serviceSwitch).toBeChecked({ checked: serviceInitiallyEnabled });
  const addService = serviceManager.getByRole("button", {
    name: "Nuovo servizio",
    exact: true,
  });
  await expect(addService).toHaveClass(/quick-service-service-add/);
  await addService.hover();
  await expect(addService).toHaveCSS("background-color", "rgb(255, 248, 217)");
  await addService.click();
  const serviceEditor = page.getByRole("dialog", { name: "Nuovo servizio" });
  await expect(serviceEditor.locator('input[type="checkbox"]')).toHaveCount(0);
  await serviceEditor
    .getByRole("button", { name: "Annulla", exact: true })
    .click();

  await page.goto("/settings/device-models");
  const modelManager = page.locator(".model-manager");
  await expect(modelManager).toBeVisible();
  const firstGroup = modelManager.locator("section").first();
  const firstHeading = firstGroup.locator(".model-group-heading");
  await expect(firstHeading).toHaveAttribute("aria-expanded", "true");
  await expect(firstHeading.locator("small")).toHaveCount(0);
  await firstHeading.click();
  await expect(firstHeading).toHaveAttribute("aria-expanded", "false");
  await expect(firstGroup.locator(".model-group-items")).toHaveCount(0);
  await firstHeading.click();

  const groups = modelManager.locator("section");
  let editableGroup: Locator | null = null;
  for (let index = 0; index < (await groups.count()); index += 1) {
    const group = groups.nth(index);
    if ((await group.locator(".model-name-button").count()) >= 2) {
      editableGroup = group;
      break;
    }
  }
  expect(editableGroup).not.toBeNull();
  const modelButtons = editableGroup!.locator(".model-name-button");
  const originalModel = (await modelButtons.nth(0).textContent())!.trim();
  const duplicateModel = (await modelButtons.nth(1).textContent())!.trim();
  await modelButtons.nth(0).click();
  const modelInput = editableGroup!.getByLabel("Nuovo nome", { exact: true });
  await expect(modelInput).toBeFocused();
  await modelInput.fill(duplicateModel);
  await page.locator(".page-header h1").click();
  await expect(modelManager.getByRole("alert")).toContainText("esiste già");
  const temporaryModel = "iPhone 18 Pro Max";
  await modelInput.fill("iphone18promax");
  await page.locator(".page-header h1").click();
  await expect(
    editableGroup!.getByRole("button", {
      name: temporaryModel,
      exact: true,
    }),
  ).toBeVisible();
  await editableGroup!
    .getByRole("button", { name: temporaryModel, exact: true })
    .click();
  await editableGroup!
    .getByLabel("Nuovo nome", { exact: true })
    .fill(originalModel);
  await page.locator(".page-header h1").click();
  await expect(
    editableGroup!.getByRole("button", { name: originalModel, exact: true }),
  ).toBeVisible();
  await page.goto("/settings/fault-catalog");
  const faultManager = page.locator(".fault-manager");
  await expect(faultManager).toBeVisible();
  await expect(
    faultManager.getByRole("button", { name: "Tipo dispositivo" }),
  ).toBeVisible();
  const rows = faultManager.locator(".fault-manager-row");
  await page.mouse.move(0, 0);
  const otherDelete = rows.nth(1).locator(".fault-delete-button");
  await expect(otherDelete).toHaveCSS("opacity", "0");
  await rows.nth(0).hover();
  const faultDelete = rows.nth(0).locator(".fault-delete-button");
  await expect(faultDelete).toHaveCSS("opacity", "1");
  await faultDelete.hover();
  await expect(faultDelete).toHaveCSS("background-color", "rgb(255, 240, 238)");
  await expect(faultDelete).toHaveCSS("border-top-width", "0px");
  expect((await faultDelete.boundingBox())!.width).toBeLessThan(
    serviceDeleteWidth,
  );
  const faultSwitch = rows
    .nth(0)
    .locator('.fault-enabled-switch input[type="checkbox"]');
  const initiallyEnabled = await faultSwitch.isChecked();
  await faultSwitch.click();
  await expect(otherDelete).toHaveCSS("opacity", "0");
  await expect(faultManager.locator(".dialog-actions")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  await faultSwitch.click();
  await expect(faultSwitch).toBeChecked({ checked: initiallyEnabled });
});
test("manual quote saves automatically and rejects overpayment", async ({
  page,
}) => {
  await fillOrder(page, { manual: true });
  await save(page);
  await expect(page.locator(".balance-card>strong")).toContainText("75,00");
  await page.getByLabel("Importo (€)", { exact: true }).fill("76");
  await page
    .getByRole("button", { name: "Registra incasso", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "supera il saldo",
  );
  await page.goto("/prices");
  await page.getByLabel("Cerca", { exact: true }).fill("fotocamera");
  await expect(page.getByText(/fotocamera/i).first()).toBeVisible();
});
test("partial collection stays separate from delivery checkout", async ({
  page,
}) => {
  await fillOrder(page);
  await save(page);
  await state(page, "READY");
  const paymentCard = page.locator(".payments-card");
  await page.getByLabel("Importo (€)", { exact: true }).fill("99");
  await paymentCard
    .getByRole("button", { name: "Registra incasso", exact: true })
    .click();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Da ritirare/);
  await expect(page.locator(".balance-card>strong")).toContainText("1,00");
  await page.reload();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Da ritirare/);
  await page.locator(".detail-status .status-dropdown-trigger").click();
  await page.getByRole("option", { name: "Consegnato", exact: true }).click();
  const checkout = page.getByRole("dialog", { name: "Incassa e consegna" });
  await expect(checkout.getByLabel("Importo (€)", { exact: true })).toHaveCount(
    0,
  );
  await checkout.getByRole("button", { name: /Incassa e consegna/ }).click();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Consegnato/);
  await page.reload();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Consegnato/);
  await expect(page.locator(".balance-card>strong")).toContainText("0,00");
});
test("zero balance delivery uses the lightweight confirmation form", async ({
  page,
}) => {
  await fillOrder(page);
  await openPayment(page);
  await page
    .getByLabel("Incasso alla creazione (€)", { exact: true })
    .fill("100");
  await save(page);
  await state(page, "READY");
  const checkout = page.locator(".checkout-form");
  await expect(checkout).toBeVisible();
  await expect(checkout.getByLabel("Importo (€)", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    checkout.getByLabel("Nome di chi ritira", { exact: true }),
  ).toHaveValue("Cliente Playwright");
  await checkout.getByRole("button", { name: "Conferma consegna" }).click();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Consegnato/);
});

test("detail edits save on outside click and protect navigation", async ({
  page,
}) => {
  await fillOrder(page, { fault: "Non si accende" });
  await save(page);
  const orderPath = new URL(page.url()).pathname;
  const details = page.getByTestId("details-card");
  await details.locator(".order-card-heading").click();
  await details
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
  const saveDetails = details
    .locator(".order-card-edit-actions")
    .getByRole("button", { name: "Salva", exact: true });
  await expect(saveDetails).toBeDisabled();
  await details
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-30");
  await expect(saveDetails).toBeEnabled();

  await page.getByTestId("history-card").locator(".order-card-heading").click();
  await expect(details).not.toHaveClass(/is-editing/);
  await expect(details.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(details.locator(".order-card-summary")).toContainText(
    "Cliente Playwright",
  );
  await page.goto("/orders");
  const row = page.locator(`tbody tr:has(a[href^="${orderPath}"])`);
  await expect(row).toContainText("30/12/2099");

  await page.goto(orderPath);
  await details.locator(".order-card-heading").click();
  await details
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
  await details
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-29");
  await page.locator(".back-link").click();
  const leaveDialog = page.getByRole("dialog", {
    name: "Modifiche non salvate",
    exact: true,
  });
  await leaveDialog
    .getByRole("button", { name: "Continua a modificare", exact: true })
    .click();
  await expect(details).toHaveClass(/is-editing/);
  await page.locator(".back-link").click();
  await page
    .getByRole("dialog", { name: "Modifiche non salvate", exact: true })
    .getByRole("button", { name: "Salva ed esci", exact: true })
    .click();
  await expect(page).toHaveURL(/\/orders(?:#.*)?$/);
  await expect(row).toContainText("29/12/2099");
});

test("order edit customer dialog keeps its body and actions separated", async ({
  page,
}) => {
  await fillOrder(page);
  await save(page);
  const details = page.getByTestId("details-card");
  await details.hover();
  await details
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();

  const customer = details.getByRole("combobox", {
    name: "Cerca cliente",
    exact: true,
  });
  await customer.fill(`cliente-dialog-${Date.now()}`);
  await details
    .getByRole("button", { name: "Nuovo cliente", exact: true })
    .click();

  const dialog = page.getByRole("dialog", {
    name: "Nuovo cliente",
    exact: true,
  });
  const form = dialog.locator(":scope > .dialog-form-layout");
  await expect(form.locator(":scope > .dialog-body")).toBeVisible();
  await expect(form.locator(":scope > .dialog-footer")).toBeVisible();
  await dialog.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(customer).toBeVisible();
});

test("repair detail part option dialog keeps its save button and warranty field", async ({
  page,
}) => {
  await fillOrder(page, { manual: true });
  await chooseRequiredPart(page, "Batteria Test");
  await save(page);

  const details = page.getByTestId("details-card");
  await expect(details).toBeVisible();
  await details.hover();
  await details
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
  await details
    .locator(".detail-repair-summary .selected-part-summary .summary-action")
    .click();
  const optionPicker = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await optionPicker.locator(".price-option-add").click();
  const newPartOption = page.getByRole("dialog", {
    name: "Nuova opzione ricambio",
    exact: true,
  });
  await expect(newPartOption).toBeVisible();
  await expect(
    newPartOption.getByRole("button", { name: "Salva", exact: true }),
  ).toBeVisible();
  await expect(
    newPartOption.getByText("Tempo previsto (minuti)", { exact: true }),
  ).toHaveCount(0);
  await expect(
    newPartOption.getByText("Giorni di garanzia", { exact: true }),
  ).toBeVisible();
  await newPartOption.locator(".dialog-close").click();
  await optionPicker.locator(".dialog-close").click();
});

test("repair detail cards lock history and keep post-sale finance auditable", async ({
  page,
}) => {
  await fillOrder(page, { manual: true });
  await chooseRequiredPart(page, "Batteria Test");
  await openPayment(page);
  await page
    .getByLabel("Incasso alla creazione (€)", { exact: true })
    .fill("75");
  await save(page);
  await page.waitForLoadState("networkidle");

  const details = page.getByTestId("details-card");
  const products = page.getByTestId("products-card");
  const quote = page.getByTestId("quote-card");
  const warranty = page.getByTestId("warranty-card");
  const history = page.getByTestId("history-card");
  const cardExpandIcons = [details, products, quote, warranty, history].map(
    (card) => card.getByTestId("order-card-expand-icon"),
  );
  const iconBounds = await Promise.all(
    cardExpandIcons.map((icon) => icon.boundingBox()),
  );
  expect(iconBounds.every(Boolean)).toBe(true);
  const iconRightEdges = iconBounds.map((bounds) => bounds!.x + bounds!.width);
  expect(
    Math.max(...iconRightEdges) - Math.min(...iconRightEdges),
  ).toBeLessThanOrEqual(1);
  await expect(details.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(products.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(quote.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(warranty.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(products.locator(".order-card-summary")).toContainText(
    "Nessun prodotto collegato",
  );
  await quote.locator(".order-card-heading").click();
  await expect(quote.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(quote.locator(".order-card-summary")).toContainText(
    "Fotocamera",
  );
  await quote.locator(".order-card-heading").click();
  await expect(quote.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(warranty.locator(".order-card-summary")).toContainText(
    "Fotocamera",
  );
  await expect(history.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(history.locator(".order-card-summary")).not.toBeEmpty();
  await expect(page.getByTestId("other-information-card")).toHaveCount(0);
  await details.locator(".order-card-heading").click();
  await page.waitForTimeout(250);
  await expect(details.locator(".order-card-summary")).toContainText(
    "Cliente Playwright",
  );
  await page.mouse.move(0, 0);
  await expect(
    details.getByRole("button", { name: "Modifica dati", exact: true }),
  ).toHaveCSS("opacity", "0");
  await details.locator(".order-card-heading").click();
  await page.waitForTimeout(250);
  const repairSummary = details.locator(".detail-repair-summary");
  await expect(
    repairSummary.locator(".selected-project-summary"),
  ).toContainText("Fotocamera");
  const requiredPartSummary = repairSummary.locator(".selected-part-summary");
  await expect(requiredPartSummary).toContainText("Batteria Test");
  await expect(requiredPartSummary).toContainText("Scorta reale 3");
  await expect(requiredPartSummary).toContainText("Impegnata 1");
  await expect(requiredPartSummary).toContainText("Disponibile 2");
  await expect(requiredPartSummary).toContainText("● Disponibile");
  const viewRemovePart = requiredPartSummary.getByRole("button", {
    name: "Rimuovi Batteria Test",
    exact: true,
  });
  await page.mouse.move(0, 0);
  await expect(viewRemovePart).toHaveCSS("opacity", "0");
  await requiredPartSummary.hover();
  await expect(viewRemovePart).toHaveCSS("opacity", "1");
  await expect(requiredPartSummary.locator(".summary-action span")).toHaveCSS(
    "color",
    "rgb(160, 111, 0)",
  );
  await viewRemovePart.click();
  await expect(details).toHaveClass(/is-editing/);
  await expect(
    details.locator(".detail-repair-summary .selected-part-summary"),
  ).toContainText("Nessuno");
  await details.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(details).not.toHaveClass(/is-editing/);
  await expect(requiredPartSummary).toContainText("Batteria Test");
  await repairSummary
    .locator(".selected-project-summary .summary-action")
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(details).toHaveClass(/is-editing/);
  await expect(details.locator(".order-card-actions")).toContainText(
    "Modifica in corso",
  );
  await expect(
    details.getByRole("combobox", { name: "Cerca cliente", exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole("combobox", { name: "Intervento 1", exact: true }),
  ).toBeFocused();
  await expect(
    details.locator(".detail-repair-summary .selected-project-summary"),
  ).toHaveCount(0);
  await expect(
    details.locator(".detail-repair-summary .selected-part-summary"),
  ).toBeVisible();
  await expect(details.locator(".detail-repair-editor .message")).toHaveCount(
    0,
  );
  await expect(
    details.locator(".detail-repair-editor .quote-total"),
  ).toHaveCount(0);
  await expect(
    details.getByRole("button", { name: "Annulla", exact: true }),
  ).toHaveCount(1);
  await expect(
    details.getByRole("button", { name: "Salva", exact: true }),
  ).toHaveCount(1);
  await chooseBusinessOption(
    page,
    "Intervento 1",
    "sostituzione display",
    details,
  );
  await expect(
    details.getByRole("combobox", { name: "Intervento 1", exact: true }),
  ).toHaveCount(0);
  await expect(
    details.locator(".detail-repair-summary .selected-project-summary"),
  ).toContainText("sostituzione display");
  await expect(details).toHaveClass(/is-editing/);
  const editableProject = details.locator(
    ".detail-repair-summary .selected-project-summary",
  );
  const removeProject = editableProject.getByRole("button", {
    name: "Rimuovi sostituzione display",
    exact: true,
  });
  await page.mouse.move(0, 0);
  await expect(removeProject).toHaveCSS("opacity", "0");
  await editableProject.hover();
  await expect(removeProject).toHaveCSS("opacity", "1");
  await removeProject.click();
  await expect(details.locator(".message.warning")).toContainText(
    "La scheda deve conservare almeno un intervento.",
  );
  await expect(
    details.locator(".detail-repair-summary .selected-project-summary"),
  ).toHaveCount(1);
  await expect(
    details.getByRole("button", { name: "Intervento", exact: true }),
  ).toBeVisible();
  await details.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(details).not.toHaveClass(/is-editing/);
  await expect(
    details.locator(".detail-repair-summary .selected-project-summary"),
  ).toContainText("Fotocamera");
  await details.locator(".selected-part-summary .summary-action").click();
  await expect(
    page.getByRole("dialog", { name: "Opzioni ricambio", exact: true }),
  ).toBeVisible();
  await expect(
    details.locator(".detail-repair-summary .selected-project-summary"),
  ).toBeVisible();
  await expect(details.locator(".price-option-picker-summary")).toBeVisible();
  await expect(details.locator(".quote-required-part-label")).toHaveCount(1);
  await choosePriceOption(page, "Batteria Test", details);
  await expect(
    page.getByRole("dialog", { name: "Opzioni ricambio", exact: true }),
  ).toHaveCount(0);
  await expect(
    details.locator(".detail-repair-summary .selected-part-summary"),
  ).toContainText("Batteria Test");
  await expect(details).toHaveClass(/is-editing/);
  const editablePart = details.locator(
    ".detail-repair-summary .selected-part-summary",
  );
  await editablePart.locator(".summary-action").click();
  const optionPicker = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await optionPicker
    .getByRole("button", { name: /^Nessun ricambio richiesto/ })
    .click();
  await optionPicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(
    details.locator(".detail-repair-summary .selected-part-summary"),
  ).toContainText("Nessuno");
  await history.locator(".order-card-heading").click();
  await expect(details).not.toHaveClass(/is-editing/);
  await expect(details.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await details.locator(".order-card-heading").click();
  await expect(
    details.locator(".detail-repair-summary .selected-part-summary"),
  ).toContainText("Nessuno");
  await details
    .locator(".detail-repair-summary .selected-part-summary .summary-action")
    .click();
  await choosePriceOption(page, "Batteria Test", details);
  await details.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(
    details.locator(".detail-repair-summary .selected-part-summary"),
  ).toContainText("Batteria Test");
  await details
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
  await details
    .getByLabel("Note interne", { exact: true })
    .fill("Test salvataggio unico");
  await details.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(details).not.toHaveClass(/is-editing/);
  await expect(details.locator(".detail-repair-editor")).toHaveCount(0);
  await expect(
    details.locator(".detail-repair-summary .selected-project-summary"),
  ).toBeVisible();
  await expect(
    details.locator(".detail-repair-summary .selected-part-summary"),
  ).toContainText("Batteria Test");
  await expect(details).toContainText("Test salvataggio unico");
  await expect(
    products
      .locator(".order-product-line")
      .filter({ hasText: "Batteria Test" }),
  ).toHaveCount(0);
  const productsTop = await products.evaluate(
    (element) => element.getBoundingClientRect().top + window.scrollY,
  );
  const detailsEdit = details.getByRole("button", {
    name: "Modifica dati",
    exact: true,
  });
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.mouse.move(0, 0);
  await expect(detailsEdit).toHaveCSS("opacity", "0");
  await details.hover();
  await expect(detailsEdit).toHaveCSS("opacity", "1");
  const customerLink = details.locator(".order-customer-link");
  await customerLink.hover();
  await expect(customerLink).toHaveCSS("transform", "none");
  await expect(customerLink.locator("svg")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 4, 0)",
  );
  await details.hover();
  await expect(details).toHaveCSS(
    "transform",
    /matrix\(1\.003, 0, 0, 1\.003, 0, -1\)/,
  );
  expect(
    await products.evaluate(
      (element) => element.getBoundingClientRect().top + window.scrollY,
    ),
  ).toBe(productsTop);
  await products.locator(".order-card-heading").click();
  await expect(products.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  const addProduct = products.getByRole("button", {
    name: "Aggiungi prodotto",
    exact: true,
  });
  const addonQuantity = products.getByRole("spinbutton", {
    name: "Quantità",
    exact: true,
  });
  const addonStepper = products.locator(".order-product-form .number-stepper");
  const addonPlus = products.getByRole("button", {
    name: "+ Quantità",
    exact: true,
  });
  await expect(addonQuantity).toHaveCount(0);
  await expect(addProduct).toHaveCount(0);
  await products.getByRole("combobox", { name: "Prodotto" }).fill("Cavo");
  await expect(addonQuantity).toHaveCount(0);
  await expect(addProduct).toHaveCount(0);
  await chooseBusinessOption(page, "Prodotto", "Cavo USB-C Test", products);
  const productControls = products.locator(
    ".order-product-form .business-combobox-control, .order-product-form .number-stepper, .order-product-form .button",
  );
  const productBoxes = await productControls.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { bottom: box.bottom, height: box.height };
    }),
  );
  expect(new Set(productBoxes.map(({ bottom }) => bottom)).size).toBe(1);
  expect(new Set(productBoxes.map(({ height }) => height)).size).toBe(1);
  await expect(addonPlus).toBeVisible();
  const stepperBox = await addonStepper.boundingBox();
  const plusBox = await addonPlus.boundingBox();
  expect(plusBox!.x + plusBox!.width).toBeLessThanOrEqual(
    stepperBox!.x + stepperBox!.width + 1,
  );
  await addonQuantity.fill("");
  await expect(addonQuantity).toHaveValue("");
  await addonQuantity.fill("150");
  await expect(addonQuantity).toHaveValue("150");
  const addonMaximum = await addonQuantity.getAttribute("max");
  await addonQuantity.press("Tab");
  await expect(addonQuantity).toHaveValue(addonMaximum!);
  await expect(addonPlus).toBeDisabled();
  await addonQuantity.fill("1");
  await addonQuantity.press("Tab");
  await expect(addProduct).toBeEnabled();

  await details
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
  await expect(details).toHaveClass(/is-editing/);
  await expect(details.locator(".order-card-heading")).toBeEnabled();
  await details
    .getByLabel("Descrizione aggiuntiva")
    .fill("Fotocamera non funziona");
  await history.locator(".order-card-heading").click();
  await expect(details).not.toHaveClass(/is-editing/);
  await expect(details.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await details.locator(".order-card-heading").click();
  await expect(details).toContainText("Fotocamera non funziona");
  await details
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
  await details
    .getByLabel("Descrizione aggiuntiva")
    .fill("Fotocamera non funziona ancora");
  await quote.hover();
  await quote
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
  await expect(details).not.toHaveClass(/is-editing/);
  await expect(details).toContainText("Fotocamera non funziona");
  await expect(quote).toHaveClass(/is-editing/);
  await quote.getByRole("button", { name: "Annulla" }).click();

  await expect(details).toContainText("Fotocamera non funziona ancora");

  await quote.locator(".order-card-heading").click();
  await expect(quote.locator(".quote-summary")).toBeHidden();
  await quote.locator(".order-card-heading").click();
  await expect(quote.locator(".quote-summary")).toBeVisible();
  await quote
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
  await expect(quote.locator(".items-editor")).toHaveCount(0);
  await expect(quote.locator(".message.warning")).toHaveCount(0);
  await expect(quote.locator(".quote-total")).toBeVisible();
  await expect(quote.locator(".quote-adjustments")).toBeVisible();
  await expect(quote.locator(".quote-summary")).toBeVisible();
  await expect(
    quote.getByRole("button", { name: "Aggiungi intervento" }),
  ).toHaveCount(0);
  await quote.getByRole("button", { name: "Annulla" }).click();
  const editWarranty = warranty.getByRole("button", {
    name: "Modifica dati",
    exact: true,
  });
  await warranty.locator(".order-card-heading").hover();
  await expect(editWarranty).toHaveCSS("pointer-events", "auto");
  await expect(warranty).toHaveCSS(
    "transform",
    "matrix(1.003, 0, 0, 1.003, 0, -1)",
  );
  await editWarranty.click();
  const warrantyProject = await warranty
    .locator(".project-warranty-editor section strong")
    .textContent();
  const duration = warranty.getByRole("button", {
    name: `Durata garanzia ${warrantyProject}`,
    exact: true,
  });
  await duration.click();
  await page
    .locator(".business-select-panel.is-entering")
    .getByRole("option", { name: "90 giorni", exact: true })
    .click();
  await expect(duration).toContainText("90 giorni");
  await warranty
    .getByLabel("Note garanzia")
    .fill("Solo il componente sostituito");
  await warranty.getByRole("button", { name: "Salva" }).click();
  await expect(warranty).not.toHaveClass(/is-editing/);
  await expect(warranty).toContainText("90 giorni");
  await page.reload();
  await expect(warranty.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await warranty.click({ position: { x: 12, y: 12 } });
  await expect(warranty.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(warranty.locator(".warranty-progress-panel")).toContainText(
    "90 giorni",
  );

  await state(page, "READY");
  await page.getByLabel("Nome di chi ritira", { exact: true }).fill("Cliente");
  await page.getByRole("button", { name: /Conferma consegna/ }).click();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Consegnato/);
  const firstDelivery = await details.getByText(/Ritirato da/).textContent();
  await expect(
    details.getByRole("button", { name: "Modifica dati", exact: true }),
  ).toHaveCount(0);
  await expect(
    quote.getByRole("button", { name: "Modifica dati", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".order-product-form")).toHaveCount(0);
  await details.hover();
  await expect(details).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");

  await page
    .getByRole("button", { name: "Riparazione in garanzia", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Apri riparazione post-vendita",
  });
  await expect(dialog).toContainText(
    "Avvia una nuova lavorazione per il dispositivo",
  );
  await expect(dialog.locator(".warranty-progress-panel")).toContainText(
    "ancora in garanzia",
  );
  await expect(
    dialog.getByRole("checkbox", { name: /Fotocamera/ }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("radio", { name: /Riparazione in garanzia/ }),
  ).toBeChecked();
  const dialogPartSummary = dialog.locator(".selected-part-summary");
  await expect(dialogPartSummary).toContainText("Batteria Test");
  await expect(dialogPartSummary).toContainText("Disponibile");
  await dialog.locator(".after-sales-part-field > span").click();
  await expect(
    dialog.getByRole("combobox", { name: /Ricambio richiesto/ }),
  ).toHaveCount(0);
  await dialogPartSummary.hover();
  await expect(dialogPartSummary.locator(".summary-action svg")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 4, 0)",
  );
  expect(
    await dialog.locator(".after-sales-notes").evaluate((notes) => {
      const list = notes.closest("form")?.querySelector(".rework-project-list");
      return list
        ? notes.getBoundingClientRect().top -
            list.getBoundingClientRect().bottom
        : 0;
    }),
  ).toBeGreaterThanOrEqual(18);
  await dialogPartSummary.locator(".selection-summary-copy").click();
  const partOptions = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await expect(partOptions).toContainText("Prezzo suggerito");
  await expect(partOptions).toContainText("Disponibile");
  await expect(
    partOptions.getByRole("button", {
      name: "Opzione ricambio",
      exact: true,
    }),
  ).toBeVisible();
  await partOptions
    .getByRole("button", { name: /^Nessun ricambio richiesto/ })
    .click();
  await partOptions
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(dialogPartSummary).toContainText("Nessun ricambio richiesto");
  await expect(dialog.getByLabel("Costo aggiuntivo (€)")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Chiudi", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Annulla", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Chiudi", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Consegnato/);

  await page
    .getByRole("button", { name: "Riparazione in garanzia", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Apri riparazione post-vendita",
  });
  await dialog.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Consegnato/);

  await page
    .getByRole("button", { name: "Riparazione in garanzia", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Apri riparazione post-vendita",
  });
  await dialog.getByRole("radio", { name: /Riparazione a pagamento/ }).check();
  await dialog.locator(".selected-part-summary .summary-action").click();
  const paidPartOptions = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await paidPartOptions
    .getByRole("button", { name: /^Nessun ricambio richiesto/ })
    .click();
  await paidPartOptions
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(dialog.locator(".selected-part-summary")).toContainText(
    "Nessun ricambio richiesto",
  );
  await dialog
    .getByLabel("Note post-vendita (facoltative)")
    .fill("Difetto ricomparso");
  await dialog.getByLabel("Costo aggiuntivo (€)").fill("50");
  await dialog
    .getByRole("button", { name: "Apri riparazione post-vendita", exact: true })
    .click();
  const reworkStatus = page.locator(".detail-status .status-dropdown-trigger");
  await expect(reworkStatus).toHaveText(/In riparazione post-vendita/);
  expect(
    await reworkStatus.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(reworkStatus).toHaveCSS("color", "rgb(190, 24, 93)");
  await expect(reworkStatus).toHaveCSS(
    "background-color",
    "rgb(252, 231, 243)",
  );
  const listPage = await page.context().newPage();
  await listPage.goto("/orders");
  const reworkRow = listPage.locator(
    `tbody tr:has(a[href^="${new URL(page.url()).pathname}"])`,
  );
  await expect(reworkRow).toBeVisible();
  expect(
    await listPage
      .locator(".table-scroll")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const reworkBadge = reworkRow.locator(".badge");
  await expect(reworkBadge).toContainText("In riparazione post-vendita");
  expect(
    await reworkBadge.evaluate(
      (element) =>
        element.scrollWidth <= element.clientWidth &&
        element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);
  await reworkRow.click();
  const reworkListTrigger = reworkRow.locator(".status-dropdown-trigger");
  await expect(reworkListTrigger).toContainText("In riparazione post-vendita");
  expect(
    await reworkListTrigger.evaluate(
      (element) =>
        element.scrollWidth <= element.clientWidth &&
        element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);
  await listPage.close();
  await expect(warranty.locator(".order-card-heading")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  for (const card of [details, products, quote, history]) {
    await expect(card.locator(".order-card-heading")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  }
  await expect(page.locator(".balance-card>strong")).toContainText("50,00");
  await expect(page.getByTestId("history-card")).toContainText(
    "Riparazione post-vendita aperta",
  );
  await expect(page.getByTestId("history-card")).toContainText("Fotocamera");
  await expect(page.getByTestId("history-card")).toContainText(
    "Riparazione a pagamento · 50,00 €",
  );
  await expect(page.getByTestId("history-card")).toContainText(
    "Note post-vendita (facoltative): Difetto ricomparso",
  );
  await expect(warranty.locator(".project-warranty-list > section")).toHaveCSS(
    "padding",
    "18px",
  );
  await expect(warranty.locator(".active-rework-summary")).toHaveCSS(
    "row-gap",
    "12px",
  );
  const emptyReworkPart = warranty.locator(
    ".active-rework-summary .price-option-picker-summary",
  );
  await expect(emptyReworkPart).toContainText("Nessun ricambio richiesto");
  await emptyReworkPart.locator(".summary-action").click();
  const reworkOptions = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await expect(reworkOptions).toBeVisible();
  await reworkOptions.getByRole("button", { name: "Chiudi" }).click();
  await choosePriceOption(page, "Batteria Test", warranty);
  const detailPartSummary = warranty.locator(
    ".active-rework-summary .selected-part-summary",
  );
  await expect(detailPartSummary).toContainText("Batteria Test");
  await detailPartSummary.locator(".summary-action").click();
  const detailPartOptions = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await detailPartOptions
    .getByRole("button", { name: /^Nessun ricambio richiesto/ })
    .click();
  await detailPartOptions
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(emptyReworkPart).toContainText("Nessun ricambio richiesto");
  await expect(
    details.getByRole("button", { name: "Modifica dati", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Importo (€)", { exact: true }).fill("50");
  await page.getByRole("button", { name: "Registra incasso" }).click();
  await expect(page.locator(".balance-card>strong")).toContainText("0,00");
  await state(page, "READY");
  await reworkStatus.click();
  const reworkReadyMenu = page.locator(".status-dropdown-menu");
  await expect(
    reworkReadyMenu.getByRole("option", { name: "Annullato", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByLabel("Nome di chi ritira", { exact: true })
    .fill("Altro nome");
  await page.getByRole("button", { name: /Conferma consegna/ }).click();
  await expect(details.getByText(/Ritirato da/)).toHaveText(
    firstDelivery ?? "",
  );

  await page.getByRole("button", { name: "Rimborso", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Motivo / note").fill("Cliente non soddisfatto");
  await dialog
    .getByRole("button", { name: "Conferma rimborso totale", exact: true })
    .click();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Rimborsato/);
  await expect(page.locator(".balance-card>strong")).toContainText("0,00");
  await expect(page.locator(".balance-card")).toContainText("Totale: 0,00 €");
  await expect(page.locator(".balance-card")).toContainText(
    "Incassato: 0,00 €",
  );
  await expect(page.locator(".balance-card")).toContainText(
    "Riparazione: 0,00 €",
  );
  await expect(page.locator(".payments-card")).toContainText("-125,00");
  await expect(page.getByTestId("history-card")).toContainText(
    "Rimborso 125,00",
  );
  await expect(page.getByText("Rimborsato · contenuti bloccati")).toBeVisible();

  const refundedCode = await page.locator("h1").textContent();
  await page.goto("/orders");
  const refundedRow = page
    .locator("tbody tr")
    .filter({ hasText: refundedCode ?? "" });
  await refundedRow.click();
  await expect(
    refundedRow.getByLabel("Consegna prevista", { exact: true }),
  ).toHaveCount(0);
  await expect(
    refundedRow.getByLabel("Incassato", { exact: true }),
  ).toHaveCount(0);
  await expect(refundedRow.locator(".order-payment-values")).toContainText(
    "Totale0,00 €",
  );
  await expect(refundedRow.locator(".order-payment-values")).toContainText(
    "Incassato0,00 €",
  );
  await expect(refundedRow.locator(".order-payment-values")).toContainText(
    "Da pagare0,00 €",
  );
});
test("price editor and mobile yellow layout support both languages", async ({
  page,
}) => {
  await page.goto("/prices");
  await page
    .getByRole("button", { name: "Nuova regola", exact: true })
    .first()
    .click();
  const form = page.getByRole("dialog");
  await expect(form).toHaveCSS("width", "920px");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDialogBox = await form.boundingBox();
  expect(mobileDialogBox).not.toBeNull();
  expect(mobileDialogBox!.x).toBeGreaterThanOrEqual(16);
  expect(mobileDialogBox!.x + mobileDialogBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width - 16,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(form).toHaveCSS("width", "920px");
  const testProject = `pulizia ${Date.now()}`;
  await chooseBusinessOption(page, "Marca", "Apple", form);
  await chooseBusinessOption(page, "Modello", "iPhone 13", form);
  await enterBusinessValue(page, "Intervento", testProject, form);
  const baseSuggested = form.locator('input[name="suggested"]');
  await expect(baseSuggested).toHaveCount(1);
  await baseSuggested.fill("15");
  await expect(baseSuggested).toHaveValue("15");
  await expect(form.locator(".price-rule-editor-options")).toBeVisible();
  const footer = form.locator(".dialog-actions");
  await expect(
    footer.getByRole("button", { name: "Salva ed esci" }),
  ).toBeVisible();
  await form
    .locator(".price-rule-editor-section")
    .first()
    .evaluate((section) => section.parentElement?.scrollTo(0, 0));
  expect(
    await footer.evaluate((element) => {
      const footer = element.getBoundingClientRect();
      const scroller = element
        .closest(".price-rule-editor")!
        .getBoundingClientRect();
      return footer.top >= scroller.top && footer.bottom <= scroller.bottom;
    }),
  ).toBe(true);
  await form
    .getByRole("button", { name: "Opzione ricambio", exact: true })
    .click();
  const newPriceOption = page.getByRole("dialog", {
    name: "Nuova opzione ricambio",
    exact: true,
  });
  await expect(newPriceOption).toBeVisible();
  const optionFlags = newPriceOption.locator(".price-option-flags");
  const enabledFlag = newPriceOption.getByRole("checkbox", {
    name: "Attiva",
    exact: true,
  });
  const defaultFlag = newPriceOption.getByRole("checkbox", {
    name: "Opzione consigliata predefinita",
    exact: true,
  });
  const [optionFlagsBox, enabledLabelBox] = await Promise.all([
    optionFlags.boundingBox(),
    enabledFlag.locator("..").boundingBox(),
  ]);
  expect(enabledLabelBox!.width).toBeLessThan(optionFlagsBox!.width);
  await page.mouse.click(
    optionFlagsBox!.x + optionFlagsBox!.width - 4,
    enabledLabelBox!.y + enabledLabelBox!.height / 2,
  );
  await expect(enabledFlag).toBeChecked();
  await expect(defaultFlag).not.toBeChecked();
  await chooseBusinessOption(
    page,
    "Ricambio richiesto",
    "Batteria Test",
    newPriceOption,
  );
  const optionQuantity = newPriceOption.getByRole("spinbutton", {
    name: "Quantità ricambio",
    exact: true,
  });
  await optionQuantity.fill("12");
  await optionQuantity.press("Tab");
  await expect(optionQuantity).toHaveValue("12");
  await newPriceOption
    .getByLabel("Prezzo suggerito (€)", { exact: true })
    .fill("18");
  await newPriceOption
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await expect(newPriceOption).toHaveCount(0);
  await expect(form.locator(".price-option-card")).toContainText(
    "Batteria Test",
  );
  const batteryOption = form
    .locator(".price-option-card")
    .filter({ hasText: "Batteria Test" });
  const batterySwitch = batteryOption.getByRole("switch", {
    name: "Batteria Test: Disattiva",
  });
  await expect(batterySwitch).toBeChecked();
  const readSwitchThumb = () =>
    batteryOption.locator(".toggle-switch-thumb").evaluate((element) => {
      const thumb = getComputedStyle(element);
      return {
        width: thumb.width,
        transform: thumb.transform,
        background: thumb.backgroundColor,
        transition: thumb.transitionDuration,
      };
    });
  const enabledThumb = await readSwitchThumb();
  expect(enabledThumb.width).toBe("16px");
  expect(enabledThumb.background).toBe("rgb(255, 255, 255)");
  expect(enabledThumb.transition).toBe("0.28s");
  await batterySwitch.click();
  await expect(batteryOption).toHaveClass(/is-disabled/);
  await expect(batteryOption).toHaveCSS("opacity", "0.58");
  const enableBatterySwitch = batteryOption.getByRole("switch", {
    name: "Batteria Test: Attiva",
  });
  await expect(enableBatterySwitch).not.toBeChecked();
  const disabledThumb = await readSwitchThumb();
  expect(disabledThumb.width).toBe("16px");
  expect(disabledThumb.transform).not.toBe(enabledThumb.transform);
  await enableBatterySwitch.click();
  await expect(batteryOption).not.toHaveClass(/is-disabled/);
  await expect(batteryOption).toHaveCSS("opacity", "1");

  await form
    .getByRole("button", { name: "Opzione ricambio", exact: true })
    .click();
  const secondPriceOption = page.getByRole("dialog", {
    name: "Nuova opzione ricambio",
    exact: true,
  });
  await chooseBusinessOption(
    page,
    "Ricambio richiesto",
    "Display LCD Test",
    secondPriceOption,
  );
  await secondPriceOption
    .getByLabel("Prezzo suggerito (€)", { exact: true })
    .fill("19");
  await secondPriceOption
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  const lcdOption = form
    .locator(".price-option-card")
    .filter({ hasText: "Display LCD Test" });
  const cardHeading = lcdOption.locator(".price-option-card-heading");
  await expect(cardHeading).toHaveCSS("display", "flex");
  await expect(cardHeading).toHaveCSS("align-items", "flex-start");
  await expect(lcdOption.locator(".price-option-card-title-row")).toHaveCSS(
    "flex-wrap",
    "wrap",
  );
  const optionData = lcdOption.locator(".price-option-data");
  const gridColumnCount = () =>
    optionData.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/)
          .length,
    );
  expect(await gridColumnCount()).toBe(6);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(gridColumnCount).toBe(2);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(gridColumnCount).toBe(6);
  const setLcdDefault = lcdOption.getByRole("button", {
    name: "Imposta predefinita",
  });
  const optionCards = form.locator(".price-option-card");
  await expect(optionCards.nth(0)).toContainText("Batteria Test");
  await expect(optionCards.nth(1)).toContainText("Display LCD Test");
  await expect(
    lcdOption.locator(".price-option-card-title-row .price-option-actions"),
  ).toBeVisible();
  const optionActions = lcdOption.locator(".price-option-actions");
  await expect(optionActions).toHaveCSS("display", "flex");
  await expect(optionActions).toHaveCSS("gap", "7px");
  await expect(lcdOption.locator(".price-option-enabled-switch")).toHaveCSS(
    "gap",
    "5px",
  );
  await expect(setLcdDefault.locator("svg")).toBeVisible();
  await setLcdDefault.click();
  await expect(lcdOption).toContainText("Opzione consigliata predefinita");
  await expect(lcdOption.locator(".price-option-default-action")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(optionCards.nth(0)).toContainText("Batteria Test");
  await expect(optionCards.nth(1)).toContainText("Display LCD Test");
  await form.getByRole("button", { name: "Salva ed esci" }).click();
  await expect(form).not.toBeVisible();
  await expect(page.getByRole("main").getByRole("status")).toBeVisible();
  await page.locator(".price-filters input[type=search]").fill(testProject);
  const createdRow = page
    .locator(".price-rule-row")
    .filter({ hasText: testProject });
  await expect(createdRow).toHaveCount(1);
  await page.getByRole("button", { name: "Gestisci selezione" }).click();
  await createdRow.getByRole("checkbox").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: /Elimina preventivi selezionati/ })
    .click();
  await expect(createdRow).toHaveCount(0);
  await page
    .getByRole("button", { name: "Nuova regola", exact: true })
    .first()
    .click();
  const existingProjectForm = page.getByRole("dialog");
  await chooseBusinessOption(page, "Marca", "Apple", existingProjectForm);
  await chooseBusinessOption(page, "Modello", "iPhone 13", existingProjectForm);
  await chooseBusinessOption(
    page,
    "Intervento",
    "sostituzione display",
    existingProjectForm,
  );
  await expect(
    existingProjectForm.locator(".price-option-card").filter({
      hasText: "Display LCD Test",
    }),
  ).toHaveCount(1);
  await existingProjectForm
    .getByRole("button", { name: "Opzione ricambio", exact: true })
    .click();
  const existingOptionDialog = page.getByRole("dialog", {
    name: "Nuova opzione ricambio",
  });
  await expect(existingOptionDialog).toBeVisible();
  await existingOptionDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await existingProjectForm
    .locator(".dialog-actions")
    .getByRole("button", { name: "Chiudi", exact: true })
    .click();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Oggi in laboratorio", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/desktop-dashboard.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/language");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今日工作台" })).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole("main")
        .evaluate((main) => main.scrollWidth <= main.clientWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: "test-results/mobile-dashboard.png",
    fullPage: true,
  });
  await page.goto("/orders/new");
  await expect(
    page.getByRole("heading", { name: "新建服务单", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-new-order.png",
    fullPage: true,
  });
});

test("creates a customer and selects it without another search", async ({
  page,
}) => {
  const phone = "336" + Date.now().toString().slice(-10);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/orders/new");
  await page.waitForLoadState("networkidle");
  await page
    .getByRole("combobox", { name: "Cerca cliente", exact: true })
    .fill(phone);
  await page
    .getByRole("button", { name: "Nuovo cliente", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Nuovo cliente" });
  const form = dialog.locator(":scope > .dialog-form-layout");
  const footer = form.locator(":scope > .dialog-footer");
  await expect(form.locator(":scope > .dialog-body")).toBeVisible();
  await expect(footer).toBeInViewport();
  await expect(footer).toHaveCSS("flex-direction", "column");
  await dialog.getByLabel(/Nome e cognome/).fill("Tre telefoni");
  const phoneInput = dialog.getByLabel(/Telefono/);
  await phoneInput.fill(phone);
  await phoneInput.press("Enter");
  await expect(dialog).toHaveCount(0);
  const customerSummary = page.locator(".selected-customer-summary");
  await expect(customerSummary).toContainText("Tre telefoni");
  await expect(customerSummary).toContainText("+39" + phone);
  await expect(customerSummary).toHaveCSS("display", "grid");
  const customerSummaryColumnCount = await customerSummary.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  );
  expect(customerSummaryColumnCount).toBe(3);
  const customerSummaryBox = await customerSummary.boundingBox();
  expect(customerSummaryBox!.x + customerSummaryBox!.width).toBeLessThanOrEqual(
    391,
  );
  await expect(
    page.locator(".order-step-card").nth(1).locator(".order-step-heading"),
  ).toHaveAttribute("aria-expanded", "true");
  await openStep(page, 0);
  await customerSummary.hover();
  await expect(customerSummary.locator(".summary-action svg")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 4, 0)",
  );
  await customerSummary.locator(".selection-summary-copy").click();
  await expect(
    page.getByRole("combobox", { name: "Cerca cliente", exact: true }),
  ).toBeVisible();
  await expect(customerSummary).toHaveCount(0);
});

test("searchable combobox keeps search, create and chevron as independent controls", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await page.waitForLoadState("networkidle");
  const customer = page.getByRole("combobox", {
    name: "Cerca cliente",
    exact: true,
  });
  const createCustomer = page.getByRole("button", {
    name: "Nuovo cliente",
    exact: true,
  });
  const customerControl = customer.locator(
    "xpath=ancestor::*[contains(@class, 'business-combobox-control')]",
  );
  const expand = customerControl.getByRole("button", {
    name: "Apri opzioni",
    exact: true,
  });

  await expect(customer).toBeVisible();
  await expect(createCustomer).toHaveCount(0);
  await expand.click();
  await expect(customer).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.locator(".business-select-panel.is-entering").getByRole("option"),
  ).not.toHaveCount(0);
  await customerControl.locator(".business-combobox-chevron").click();
  await expect(customer).toHaveAttribute("aria-expanded", "false");

  await customer.fill("Cliente");
  await expect(createCustomer).toHaveCount(0);

  await customer.fill("cliente-in-trovabile");
  const panel = page.locator(".business-select-panel.is-entering");
  await expect(panel).toContainText(
    "Nessun risultato. Usa «+Nuovo cliente» a destra per crearne uno.",
  );
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(createCustomer).toBeEnabled();
  await createCustomer.click();
  const dialog = page.getByRole("dialog", { name: "Nuovo cliente" });
  await expect(dialog.getByLabel(/Nome e cognome/)).toHaveValue(
    "cliente-in-trovabile",
  );
  await expect(dialog.getByLabel(/Telefono/)).toBeFocused();
  await dialog.getByRole("button", { name: "Chiudi", exact: true }).click();
  await expect(customer).toHaveValue("cliente-in-trovabile");
  await customerControl
    .getByRole("button", { name: "Cancella selezione", exact: true })
    .click();
  await expect(customer).toHaveValue("");
  await expect(createCustomer).toHaveCount(0);

  await customer.fill("3391234567");
  await createCustomer.click();
  await expect(dialog.getByLabel(/Telefono/)).toHaveValue("3391234567");
  await expect(dialog.getByLabel(/Nome e cognome/)).toBeFocused();
  await dialog.getByRole("button", { name: "Chiudi", exact: true }).click();
  await customerControl
    .getByRole("button", { name: "Cancella selezione", exact: true })
    .click();

  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  const customerStepHeading = page
    .locator(".order-step-card")
    .first()
    .locator(".order-step-heading");
  await expect(customerStepHeading).toHaveAttribute("aria-expanded", "false");
  await customerStepHeading.click();
  await expect(customerStepHeading).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Cambia", exact: true }).click();
  await expect(customer).toHaveValue("");
  await expect(page.locator(".order-step-heading").first()).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator(".order-step-state").first()).toContainText(
    "In corso",
  );

  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  const deviceStepHeading = page
    .locator(".order-step-card")
    .nth(1)
    .locator(".order-step-heading");
  await expect(deviceStepHeading).toHaveAttribute("aria-expanded", "true");
  const { dialog: deviceDialog } = await openNewRepairDeviceDialog(page);
  const brand = deviceDialog.getByRole("combobox", {
    name: "Marca",
    exact: true,
  });
  const brandControl = brand.locator(
    "xpath=ancestor::*[contains(@class, 'business-combobox-control')]",
  );
  await brandControl.locator(".business-combobox-chevron").click();
  await page
    .locator(".business-select-panel.is-entering")
    .getByRole("option", { name: "Apple", exact: true })
    .click();
  await expect(brand).toHaveValue("Apple");
  const model = deviceDialog.getByRole("combobox", {
    name: "Modello",
    exact: true,
  });
  await model.fill("13");
  await page
    .locator(".business-select-panel.is-entering")
    .getByRole("option", { name: "iPhone 13", exact: true })
    .click();
  await expect(model).toHaveValue("iPhone 13");
  await brand.fill("");
  await expect(brand).toHaveValue("");
  await expect(
    deviceDialog.getByRole("combobox", { name: "Modello", exact: true }),
  ).toBeDisabled();
});

test("new repair devices normalize custom models and remain selectable after changes", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await chooseRepairDevice(page, "Apple iPhone 13");
  const summary = page.locator(".repair-device-summary");
  await expect(summary).toContainText("Apple iPhone 13");

  const { picker, dialog } = await openNewRepairDeviceDialog(page);
  await chooseBusinessOption(page, "Marca", "Apple", dialog);
  const newModel = dialog.getByRole("combobox", {
    name: "Modello",
    exact: true,
  });
  await newModel.fill("modello non registrato");
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Seleziona il modello del dispositivo.",
  );
  await expect(dialog).toBeVisible();
  await expect(
    picker
      .locator(".customer-device-row")
      .filter({ hasText: "Apple Modello Non Registrato" }),
  ).toHaveCount(0);
  await newModel.fill("modello non registrato");
  await dialog
    .getByRole("button", { name: "Modello personalizzato", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    picker.locator(".customer-device-row.is-selected"),
  ).toContainText("Apple Modello Non Registrato");
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(summary).toContainText("Apple Modello Non Registrato");
  await summary
    .getByRole("button", { name: "Cambia dispositivo", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Dispositivo del cliente" })
      .locator(".customer-device-row.is-selected"),
  ).toContainText("Apple Modello Non Registrato");
});

test("native quote choices populate prices, clear on model changes and discounts are optional", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  const { picker, dialog: deviceDialog } =
    await openNewRepairDeviceDialog(page);
  const deviceType = deviceDialog.getByRole("button", {
    name: "Tipo dispositivo",
    exact: true,
  });
  await expect(async () => {
    await chooseBusinessOption(
      page,
      "Tipo dispositivo",
      "Tablet",
      deviceDialog,
    );
    await expect(deviceType).toContainText("Tablet");
  }).toPass();
  await chooseBusinessOption(page, "Marca", "Apple", deviceDialog);
  await deviceDialog
    .getByRole("combobox", { name: "Modello", exact: true })
    .fill("iPad");
  await expect(page.getByRole("option", { name: /^iPad/ })).not.toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "iPhone 13", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await chooseBusinessOption(
    page,
    "Tipo dispositivo",
    "Telefono",
    deviceDialog,
  );
  await expect(deviceType).toContainText("Telefono");
  await chooseBusinessOption(page, "Marca", "Apple", deviceDialog);
  await chooseBusinessOption(page, "Modello", "iPhone 13", deviceDialog);
  await deviceDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await picker
    .locator(".customer-device-row")
    .filter({ hasText: "Apple iPhone 13" })
    .first()
    .click();
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await page.getByLabel("Display rotto", { exact: true }).check();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  const quoteHeading = page
    .locator(".order-step-card")
    .nth(2)
    .locator(".order-step-heading");
  await expect(quoteHeading).toHaveAttribute("aria-expanded", "true");
  const projectPrice = page.getByLabel("Prezzo originale (€) 1", {
    exact: true,
  });
  const createProject = page.getByRole("button", {
    name: "Intervento personalizzato",
    exact: true,
  });
  await expect(projectPrice).toHaveCount(0);
  await expect(createProject).toHaveCount(0);
  await chooseRepairProjects(page, ["sostituzione display"]);
  await openStep(page, 2);
  const projectSummary = page.locator(".selected-project-summary");
  await expect(projectSummary).toContainText("sostituzione display");
  await expect(projectSummary).toContainText("100,00 €");
  await expect(
    page.getByLabel("Prezzo originale (€) 1", { exact: true }),
  ).toHaveCount(0);
  await projectSummary.locator(".summary-price-button").click();
  await expect(
    page.getByRole("combobox", { name: "Intervento 1", exact: true }),
  ).toHaveCount(0);
  const inlinePrice = page.getByLabel("Prezzo originale (€) 1", {
    exact: true,
  });
  await expect(inlinePrice).toHaveValue("100");
  await inlinePrice.fill("0");
  await inlinePrice.press("Enter");
  await expect(inlinePrice).toBeVisible();
  await expect(
    inlinePrice.locator("xpath=..//*[@class='field-error']"),
  ).toHaveText("Il prezzo deve essere maggiore di 0.");
  await inlinePrice.fill("105");
  await inlinePrice.press("Enter");
  await expect(projectSummary).toContainText("105,00 €");
  await expect(
    page.getByLabel("Sconto intervento (€) 1", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Sconto aggiuntivo sulla scheda (€)", { exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Aggiungi sconto intervento", exact: true })
    .click();
  await page.getByLabel("Sconto intervento (€) 1", { exact: true }).fill("10");
  await page
    .getByRole("button", { name: "Rimuovi sconto", exact: true })
    .click();
  await expect(
    page.getByLabel("Sconto intervento (€) 1", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".price-breakdown")).toContainText("105,00");
  await projectSummary.getByRole("button", { name: "Cambia" }).click();
  const customName = `Intervento temporaneo ${Date.now()}`;
  let projectPicker = page.getByRole("dialog", {
    name: "Seleziona interventi",
  });
  const displayProject = repairProjectOption(
    projectPicker,
    "sostituzione display",
  );
  await expect(displayProject).toHaveCount(1);
  await displayProject.click();
  await projectPicker.locator(".quick-service-picker-add").click();
  const customProjectDialog = page.getByRole("dialog", {
    name: "Intervento personalizzato",
  });
  await customProjectDialog
    .getByLabel("Intervento *", { exact: true })
    .fill(customName);
  const customProjectPrice = customProjectDialog.getByLabel(
    "Prezzo originale (€) *",
    { exact: true },
  );
  await customProjectPrice.fill("0");
  await expect(
    customProjectDialog.getByRole("button", { name: "Salva", exact: true }),
  ).toBeDisabled();
  await customProjectPrice.fill("99");
  await customProjectDialog
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await projectPicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(projectSummary).toContainText(customName);
  await expect(projectSummary).toContainText(
    "Intervento personalizzato temporaneo",
  );
  await expect(projectSummary).toContainText("99,00 €");
  await projectSummary.locator(".summary-price-button").click();
  const customInlinePrice = page.getByLabel("Prezzo originale (€) 1", {
    exact: true,
  });
  await customInlinePrice.fill("+");
  await customInlinePrice.press("Enter");
  await expect(projectSummary).toBeVisible();
  await expect(customInlinePrice).toBeVisible();
  await expect(
    page.getByText("Il prezzo deve essere maggiore di 0."),
  ).toBeVisible();
  await customInlinePrice.fill("99");
  await customInlinePrice.press("Enter");
  await expect(projectSummary).toContainText("99,00 €");
  const catalogPage = await page.context().newPage();
  await catalogPage.goto("/prices");
  await catalogPage.getByLabel("Cerca", { exact: true }).fill(customName);
  await expect(catalogPage.locator(".price-rule-row")).toHaveCount(0);
  await catalogPage.close();
  await projectSummary.getByRole("button", { name: "Cambia" }).click();
  projectPicker = page.getByRole("dialog", { name: "Seleziona interventi" });
  const temporaryOption = projectPicker
    .locator(".quick-service-picker-option")
    .filter({ hasText: customName });
  await expect(temporaryOption).toContainText(
    "Intervento personalizzato temporaneo",
  );
  await expect(temporaryOption.locator('input[type="checkbox"]')).toBeChecked();
  await projectPicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(projectSummary).toContainText("99,00 €");
  await openStep(page, 1);
  await page
    .locator(".repair-device-summary")
    .getByRole("button", { name: "Cambia dispositivo", exact: true })
    .click();
  const devicePicker = page.getByRole("dialog", {
    name: "Dispositivo del cliente",
  });
  await devicePicker
    .getByRole("button", { name: "Dispositivo", exact: true })
    .click();
  const replacementDevice = page.getByRole("dialog", {
    name: "Nuovo dispositivo",
  });
  await chooseBusinessOption(page, "Marca", "Apple", replacementDevice);
  await chooseBusinessOption(page, "Modello", "iPhone 14", replacementDevice);
  await replacementDevice
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await devicePicker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await page.getByLabel("Display rotto", { exact: true }).check();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  await openStep(page, 2);
  await expect(projectSummary).toHaveCount(0);
  await expect(createProject).toHaveCount(0);
  await page.locator(".quick-service-service-add:visible").click();
  projectPicker = page.getByRole("dialog", { name: "Seleziona interventi" });
  await expect(projectPicker).toContainText("sostituzione batteria");
  await expect(projectPicker).toContainText("120,00 €");
  await expect(projectPicker).not.toContainText(customName);
  await projectPicker
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(
    page.getByText("Altri dettagli (facoltativi)", { exact: true }),
  ).toHaveCount(0);
  await openStep(page, 1);
  const customDevice = await openNewRepairDeviceDialog(page);
  await chooseBusinessOption(page, "Marca", "Apple", customDevice.dialog);
  const customModel = customDevice.dialog.getByRole("combobox", {
    name: "Modello",
    exact: true,
  });
  await customModel.fill("iphone18promax");
  await customDevice.dialog
    .getByRole("button", { name: "Modello personalizzato", exact: true })
    .click();
  await customDevice.dialog
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await expect(customDevice.dialog).toHaveCount(0);
  await customDevice.picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(page.locator(".repair-device-summary")).toContainText(
    "iPhone 18 Pro Max",
  );
});

test("selects and reserves a non-default repair part option from a quote", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await chooseRepairDevice(page, "Apple iPhone 13");
  await page.getByLabel("Display rotto", { exact: true }).check();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  await chooseRepairProjects(page, ["sostituzione display"]);
  await openStep(page, 2);

  const optionSummary = page.locator(".price-option-picker-summary");
  await expect(optionSummary).toContainText("Display LCD standard");
  await choosePriceOption(page, "Display OLED alta qualità");
  await expect(optionSummary).toContainText("Display OLED Test");
  await expect(optionSummary).toContainText("119,00 €");
  await save(page);
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toContainText("In riparazione");
  await expect(
    page.getByTestId("details-card").locator(".selected-part-summary"),
  ).toContainText("Display OLED Test");
});

test("removing the last compatible repair project removes its device row", async ({
  page,
}) => {
  await page.goto("/inventory");
  const productRow = page.getByRole("row", { name: /Display LCD Test/ });
  await expect(productRow).toHaveCount(1);
  const productId = await productRow.getAttribute("data-inventory-product");
  expect(productId).toBeTruthy();
  await productRow.click();
  const activeProductRow = page.locator(
    `tr[data-inventory-product="${productId}"]`,
  );
  const editCompatibilities = activeProductRow.getByRole("button", {
    name: "Modifica dispositivi compatibili",
  });
  await expect(editCompatibilities).toHaveCount(1);
  await editCompatibilities.click();
  const dialog = page.getByRole("dialog", {
    name: "Modifica dispositivi compatibili",
  });
  await expect(dialog).toHaveCSS("width", "920px");
  const deviceRow = dialog.locator(".compatibility-device-row").first();
  await expect(deviceRow).toHaveCSS("display", "grid");
  await expect(deviceRow).toHaveCSS("gap", "8px");
  const deviceSummary = deviceRow.locator(".compatibility-device-summary");
  await expect(deviceSummary).toHaveCSS("display", "grid");
  await expect(deviceSummary).toHaveCSS("gap", "14px");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await deviceSummary.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length,
    ),
  ).toBe(1);
  const deviceModel = await deviceRow
    .locator(".compatibility-device-summary strong")
    .innerText();
  const projectCount = await deviceRow
    .locator(".compatibility-project-label")
    .count();
  expect(projectCount).toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "Annulla" }).focus();
  await page.mouse.move(0, 0);
  for (let index = 0; index < projectCount; index += 1) {
    const project = deviceRow.locator(".compatibility-project-label").first();
    const remove = project.getByRole("button", { name: /Rimuovi/ });
    if (index === 0) await expect(remove).toHaveCSS("opacity", "0");
    await project.hover();
    await expect(remove).toHaveCSS("opacity", "1");
    await remove.click();
    if (index < projectCount - 1) await expect(deviceRow).toBeVisible();
  }
  await expect(
    dialog
      .locator(".compatibility-device-row")
      .filter({ hasText: deviceModel }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Annulla" }).click();
});

test("inventory repair products retain their compatibility editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/inventory");
  const productRow = page.getByRole("row", { name: /Batteria Test/ });
  await productRow.click();
  await productRow
    .getByRole("button", { name: "Modifica dispositivi compatibili" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Modifica dispositivi compatibili",
  });
  await expect(
    dialog.locator(":scope > .dialog-body[data-product-compatibility-dialog]"),
  ).toBeVisible();
  const overview = dialog.locator(".compatibility-overview");
  await expect(overview).toHaveCSS("display", "grid");
  await expect(overview).toHaveCSS("gap", "10px");
  await expect(dialog.locator(".compatibility-product-summary")).toHaveCSS(
    "padding",
    "10px 12px",
  );
  await expect(dialog.locator(":scope > .dialog-footer")).toBeVisible();
  const compatibilityAdd = dialog.getByRole("button", {
    name: "Compatibilità",
    exact: true,
  });
  await expect(dialog.locator(".compatibility-product-summary")).toContainText(
    "Batteria Test",
  );
  await expect(dialog.locator(".compatibility-device-list")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Salva", exact: true }),
  ).toBeDisabled();
  await compatibilityAdd.click();
  const editorDialog = page.getByRole("dialog", {
    name: "Aggiungi dispositivo compatibile",
  });
  await expect(editorDialog).toHaveCSS("width", "920px");
  await expect(
    editorDialog.locator(
      ":scope > .dialog-body[data-product-compatibility-dialog]",
    ),
  ).toBeVisible();
  await expect(editorDialog.locator(":scope > .dialog-footer")).toBeVisible();
  await expect(editorDialog.locator(".compatibility-device-fields")).toHaveCSS(
    "grid-template-columns",
    /.+ .+ .+/,
  );
  const brand = editorDialog
    .getByRole("combobox", { name: "Marca", exact: true })
    .first();
  await brand.fill("App");
  const appleOption = page
    .locator(".business-select-panel.is-entering")
    .getByRole("option")
    .filter({ hasText: "Apple" })
    .first();
  await appleOption.click();
  const model = editorDialog
    .getByRole("combobox", { name: "Modello", exact: true })
    .first();
  await model.fill("iPhone");
  const iphoneOption = page
    .locator(".business-select-panel.is-entering")
    .getByRole("option")
    .filter({ hasText: "iPhone 14" })
    .first();
  await iphoneOption.click();
  const openProjects = editorDialog.getByRole("button", {
    name: "Intervento",
    exact: true,
  });
  await expect(openProjects).toBeEnabled();
  await openProjects.click();
  await expect(
    editorDialog.locator(".compatibility-project-selector"),
  ).toHaveCSS("border-top-width", "0px");
  const projectPicker = page.getByRole("dialog", {
    name: "Seleziona interventi",
  });
  await expect(
    projectPicker.locator(":scope > .dialog-body.compatibility-project-picker"),
  ).toBeVisible();
  await expect(projectPicker.locator(":scope > .dialog-footer")).toBeVisible();
  const batteryProject = projectPicker.getByRole("button", {
    name: "sostituzione batteria",
    exact: true,
  });
  if (await batteryProject.count()) await batteryProject.click();
  else
    await expect(
      editorDialog.locator(".compatibility-project-chip"),
    ).toContainText("sostituzione batteria");
  await expect(
    projectPicker.getByRole("button", {
      name: "sostituzione display",
      exact: true,
    }),
  ).toHaveCount(0);
  await projectPicker
    .getByRole("button", { name: "Conferma selezione" })
    .click();
  await expect(editorDialog.locator(".compatibility-project-chip")).toHaveText([
    "sostituzione batteria",
  ]);
  await expect(editorDialog.locator(".compatibility-project-chip")).toHaveCSS(
    "display",
    "flex",
  );
  await expect(editorDialog.locator(".compatibility-project-chip")).toHaveCSS(
    "min-height",
    "30px",
  );
  await openProjects.click();
  await expect(
    page
      .getByRole("dialog", { name: "Seleziona interventi" })
      .getByRole("button", {
        name: "sostituzione batteria",
        exact: true,
      }),
  ).toHaveCount(0);
  await page
    .getByRole("dialog", { name: "Seleziona interventi" })
    .getByRole("button", { name: "Annulla" })
    .click();
  await editorDialog
    .getByRole("button", { name: "Conferma", exact: true })
    .click();
  const summary = dialog.locator(".compatibility-device-row", {
    hasText: "iPhone 14",
  });
  await expect(summary).toContainText("sostituzione batteria");
  await expect(summary).not.toContainText("sostituzione display");
  await expect(
    dialog.getByRole("button", { name: "Salva", exact: true }),
  ).toBeEnabled();
  await compatibilityAdd.click();
  const existingModelDialog = page.getByRole("dialog", {
    name: "Aggiungi dispositivo compatibile",
  });
  await chooseBusinessOption(page, "Marca", "Apple", existingModelDialog);
  await chooseBusinessOption(page, "Modello", "iPhone 14", existingModelDialog);
  await expect(
    existingModelDialog.locator(".compatibility-project-chip"),
  ).toHaveText(["sostituzione batteria"]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await existingModelDialog
      .locator(".compatibility-device-fields")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/)
            .length,
      ),
  ).toBe(1);
});

test("new repair products add compatible devices in a modal", async ({
  page,
}) => {
  await page.goto("/inventory");
  await page
    .getByRole("button", { name: "Nuovo prodotto", exact: true })
    .click();
  const productDialog = page.getByRole("dialog");
  await chooseBusinessOption(page, "Utilizzo", "Riparazione", productDialog);
  const addCompatibility = productDialog.getByRole("button", {
    name: "Compatibilità",
    exact: true,
  });
  await expect(addCompatibility).toBeDisabled();
  await productDialog
    .getByLabel("Prodotto", { exact: true })
    .fill("Prodotto di prova");
  await expect(addCompatibility).toBeDisabled();
  await chooseBusinessOption(page, "Categoria", "Ricambi", productDialog);
  await productDialog.getByLabel("Costo", { exact: true }).fill("12");
  await expect(addCompatibility).toBeEnabled();
  await addCompatibility.click();
  const compatibilityDialog = page.getByRole("dialog", {
    name: "Aggiungi dispositivo compatibile",
    exact: true,
  });
  await expect(compatibilityDialog).toHaveCSS("width", "920px");
  await expect(
    compatibilityDialog.locator(
      ":scope > .dialog-body[data-product-compatibility-dialog]",
    ),
  ).toBeVisible();
  await expect(
    compatibilityDialog.locator(":scope > .dialog-footer"),
  ).toBeVisible();
  await compatibilityDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(compatibilityDialog).toHaveCount(0);
  await expect(addCompatibility).toBeVisible();
  await expect(productDialog.locator(".compatibility-device-row")).toHaveCount(
    0,
  );

  await addCompatibility.click();
  const reopenedDialog = page.getByRole("dialog", {
    name: "Aggiungi dispositivo compatibile",
    exact: true,
  });
  await expect(
    reopenedDialog.locator(".compatibility-device-fields"),
  ).toBeVisible();
  await chooseBusinessOption(page, "Marca", "Apple", reopenedDialog);
  await chooseBusinessOption(page, "Modello", "iPhone 13", reopenedDialog);
  await reopenedDialog
    .getByRole("button", { name: "Intervento", exact: true })
    .click();
  const projectPicker = page.getByRole("dialog", {
    name: "Seleziona interventi",
  });
  await expect(
    projectPicker.locator(":scope > .dialog-body.compatibility-project-picker"),
  ).toBeVisible();
  await expect(
    projectPicker.locator(":scope > .dialog-body.compatibility-project-picker"),
  ).toHaveCSS("gap", "10px");
  await expect(projectPicker.locator(":scope > .dialog-footer")).toBeVisible();
  const projectChoice = projectPicker.getByRole("button", {
    name: "sostituzione display",
    exact: true,
  });
  await expect(projectChoice).toHaveCSS("display", "flex");
  await expect(projectChoice).toHaveCSS("border-radius", "12px");
  await projectChoice.click();
  await page.mouse.move(0, 0);
  await expect(projectChoice).toHaveCSS(
    "background-color",
    "rgb(255, 250, 240)",
  );
  const newProject = `progetto compatibilita ${Date.now()}`;
  await projectPicker.getByRole("button", { name: "Nuovo intervento" }).click();
  let newProjectDialog = page.getByRole("dialog", {
    name: "Nuovo intervento",
  });
  await expect(newProjectDialog).toHaveCSS("width", "520px");
  await expect(
    newProjectDialog.locator(
      ":scope > .dialog-body.compatibility-new-project-dialog",
    ),
  ).toBeVisible();
  await expect(
    newProjectDialog.locator(".compatibility-new-project"),
  ).toHaveCSS("display", "grid");
  await expect(
    newProjectDialog.locator(".compatibility-new-project"),
  ).toHaveCSS("gap", "10px");
  await expect(
    newProjectDialog.locator(":scope > .dialog-footer"),
  ).toBeVisible();
  await newProjectDialog.getByRole("button", { name: "Annulla" }).click();
  await expect(newProjectDialog).toHaveCount(0);
  await expect(projectPicker).toBeVisible();
  await projectPicker.getByRole("button", { name: "Nuovo intervento" }).click();
  newProjectDialog = page.getByRole("dialog", { name: "Nuovo intervento" });
  await expect(newProjectDialog).toHaveCSS("width", "520px");
  await newProjectDialog
    .getByLabel("Intervento", { exact: true })
    .fill(newProject);
  await newProjectDialog.getByLabel("Prezzo suggerito (€)").fill("49");
  await expect(
    newProjectDialog.getByLabel("Costo (€), facoltativo"),
  ).toHaveValue("12");
  await newProjectDialog
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await expect(newProjectDialog).toHaveCount(0);
  await expect(
    projectPicker.getByRole("button", { name: newProject }),
  ).toBeVisible();
  await projectPicker
    .getByRole("button", { name: "Conferma selezione" })
    .click();
  await reopenedDialog
    .getByRole("button", { name: "Conferma", exact: true })
    .click();
  await expect(reopenedDialog).toHaveCount(0);
  await expect(addCompatibility).toBeVisible();
  await expect(
    productDialog.locator(".compatibility-device-row"),
  ).toContainText("Apple iPhone 13");
  await expect(
    productDialog.locator(".compatibility-device-row"),
  ).toContainText("sostituzione display");
  await expect(
    productDialog.locator(".compatibility-device-row"),
  ).toContainText(newProject);
  const projectChip = productDialog.locator(".compatibility-projects > span", {
    hasText: newProject,
  });
  await projectChip.hover();
  await projectChip
    .getByRole("button", { name: `Rimuovi ${newProject}` })
    .click();
  await expect(
    productDialog.locator(".compatibility-device-row"),
  ).toContainText("sostituzione display");
  await expect(
    productDialog.locator(".compatibility-device-row"),
  ).not.toContainText(newProject);
  await productDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await page.goto("/prices");
  await page.locator(".price-filters input[type=search]").fill(newProject);
  const createdRow = page
    .locator(".price-rule-row")
    .filter({ hasText: newProject });
  await expect(createdRow).toHaveCount(1);
  await createdRow.hover();
  await createdRow.getByRole("button", { name: "Modifica preventivo" }).click();
  const savedRule = page.getByRole("dialog", { name: "Modifica preventivo" });
  await expect(savedRule.getByLabel("Costo (€), facoltativo")).toHaveValue(
    "12",
  );
  await savedRule.locator(".dialog-close").click();
  await page.getByRole("button", { name: "Gestisci selezione" }).click();
  await createdRow.getByRole("checkbox").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: /Elimina preventivi selezionati/ })
    .click();
  await expect(createdRow).toHaveCount(0);
});

test("legacy repair rules use the shared part option dialog", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await createRepairDevice(page, "Apple", "iPhone 14");
  await page.getByLabel("Display rotto", { exact: true }).check();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  await chooseRepairProjects(page, ["sostituzione batteria"]);
  const summary = page.locator(".price-option-picker-summary");
  await expect(summary).toContainText("Batteria Test");
  await summary.locator(".summary-action").click();
  await expect(
    page.getByRole("combobox", {
      name: "Ricambio richiesto 1",
      exact: true,
    }),
  ).toHaveCount(0);
  const picker = page.getByRole("dialog", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await expect(picker).toBeVisible();
  const defaultStatus = picker.locator(".price-option-card-status").first();
  await expect(defaultStatus).toBeVisible();
  await expect(defaultStatus).toHaveCSS("color", "rgb(128, 96, 0)");
  await expect(
    picker.locator(".price-option-choice").filter({
      hasText: "Batteria Test",
    }),
  ).toHaveClass(/is-selected/);
  await expect(
    picker.getByText("Display LCD Test", { exact: true }),
  ).toHaveCount(0);
  await expect(
    picker.getByText("Display OLED Test", { exact: true }),
  ).toHaveCount(0);
  await expect(
    picker.getByRole("button", {
      name: "Opzione ricambio",
      exact: true,
    }),
  ).toBeVisible();
  await picker
    .getByRole("button", { name: /^Nessun ricambio richiesto/ })
    .click();
  await picker.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(summary).toContainText("Batteria Test");
  await summary.locator(".summary-action").click();
  await picker
    .getByRole("button", { name: /^Nessun ricambio richiesto/ })
    .click();
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(summary).toContainText("Nessun ricambio richiesto");
  await expect(
    page.getByRole("button", { name: "Opzioni ricambio", exact: true }),
  ).toHaveCount(0);
  await summary.locator(".summary-action").click();
  await expect(picker).toBeVisible();
  await picker
    .getByRole("button", { name: "Opzione ricambio", exact: true })
    .click();
  const newOption = page.getByRole("dialog", {
    name: "Nuova opzione ricambio",
    exact: true,
  });
  await chooseBusinessOption(
    page,
    "Ricambio richiesto",
    "Display OLED Test",
    newOption,
  );
  await expect(
    newOption.getByLabel("Nome opzione", { exact: true }),
  ).toHaveValue("Display OLED Test");
  await newOption
    .getByLabel("Prezzo suggerito (€)", { exact: true })
    .fill("120");
  await newOption.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(newOption).toHaveCount(0);
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(
    page.getByRole("combobox", {
      name: "Ricambio richiesto 1",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("replaces a repair item with a custom item without submitting the order", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await chooseRepairDevice(page, "Apple iPhone 13");
  await page.getByLabel("Display rotto", { exact: true }).check();
  await page
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  await page.waitForTimeout(250);
  await openStep(page, 2);

  const name = `Intervento diretto ${Date.now()}`;
  await chooseRepairProjects(page, ["sostituzione display"]);
  const projectSummary = page.locator(".selected-project-summary");
  await expect(projectSummary).toContainText("100,00 €");
  await projectSummary
    .getByRole("button", { name: "Cambia", exact: true })
    .click();
  const picker = page.getByRole("dialog", { name: "Seleziona interventi" });
  const displayProject = repairProjectOption(picker, "sostituzione display");
  await expect(displayProject).toHaveCount(1);
  await displayProject.click();
  await picker.locator(".quick-service-picker-add").click();
  const customDialog = page.getByRole("dialog", {
    name: "Intervento personalizzato",
  });
  await customDialog.getByLabel("Intervento *", { exact: true }).fill(name);
  await customDialog
    .getByLabel("Prezzo originale (€) *", { exact: true })
    .fill("85");
  await customDialog
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await expect(customDialog).toHaveCount(0);
  await picker
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
  await expect(projectSummary).toContainText(name);
  await expect(projectSummary).toContainText("85,00 €");
  await expect(page.locator(".order-step-card").nth(2)).toHaveClass(
    /is-completed/,
  );
  await expect(page).toHaveURL(/\/orders\/new$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await chooseRequiredPart(page, "Batteria Test");
  await save(page);
  await page.goto("/prices");
  await page.getByLabel("Cerca", { exact: true }).fill(name);
  const rule = page.locator(".price-rule-row").filter({ hasText: name });
  await expect(rule).toHaveCount(1);
  await rule.hover();
  await rule.getByRole("button", { name: "Modifica preventivo" }).click();
  const editDialog = page.getByRole("dialog", { name: "Modifica preventivo" });
  await expect(editDialog.locator(".price-rule-editor-options")).toBeVisible();
  await expect(
    editDialog.locator(".price-option-card").filter({
      hasText: "Batteria Test",
    }),
  ).toBeVisible();
});

test("customer detail adds a device from a dialog below existing devices", async ({
  page,
}) => {
  await page.goto("/customers");
  await page.getByLabel("Cerca", { exact: true }).fill("Cliente Playwright");
  await page
    .getByRole("link", { name: "Cliente Playwright", exact: true })
    .first()
    .click();
  const detailDialog = page.getByRole("dialog", { name: "Dettagli cliente" });
  const detailBody = detailDialog.locator(
    ":scope > .dialog-body.customer-detail-dialog",
  );
  await expect(detailBody).toHaveCSS("display", "grid");
  await expect(detailDialog.locator(".customer-summary")).toHaveCSS(
    "box-shadow",
    "none",
  );
  await expect(detailDialog.locator(".customer-device-list")).toHaveCSS(
    "border-radius",
    "9px",
  );
  const deviceRow = detailDialog.locator(".customer-device-row").first();
  await expect(deviceRow).toBeVisible();
  const addDevice = detailDialog.getByRole("button", {
    name: "Dispositivo",
    exact: true,
  });
  expect((await addDevice.boundingBox())!.y).toBeGreaterThan(
    (await deviceRow.boundingBox())!.y,
  );
  await addDevice.click();
  const createDialog = page.getByRole("dialog", { name: "Nuovo dispositivo" });
  await expect(createDialog).toBeVisible();
  await expect(detailDialog.locator(".customer-device-editor")).toHaveCount(0);
  await createDialog.getByRole("button", { name: "Annulla" }).click();
  await expect(createDialog).toHaveCount(0);
});

test("customer list searches instantly, preserves navigation and supports compact editing", async ({
  page,
}) => {
  const phone = "336" + Date.now().toString().slice(-7);
  const extra = "337" + Date.now().toString().slice(-7);
  const name =
    "Cliente interfaccia molto lungo per verifica della disposizione";
  await fillOrder(page, { phone, name, manual: true });
  await save(page);
  await page.goto("/customers");
  await page.getByLabel("Cerca", { exact: true }).fill(phone);
  const row = page.locator(".customer-table tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(name);
  await expect(page).toHaveURL(new RegExp("q=" + phone + "$"));
  await row.getByRole("link", { name, exact: true }).click();
  let detailDialog = page.getByRole("dialog", {
    name: "Dettagli cliente",
    exact: true,
  });
  await expect(detailDialog).toBeVisible();
  await expect(detailDialog).toHaveClass(/form-dialog/);
  await expect(detailDialog.locator(".customer-device-row")).toHaveCount(1);
  const customerAddDevice = detailDialog.getByRole("button", {
    name: "Dispositivo",
    exact: true,
  });
  await expect(customerAddDevice).toHaveClass(/add-device-action/);
  await expect(customerAddDevice).toHaveCSS("border-top-style", "dashed");
  await customerAddDevice.hover();
  await expect(customerAddDevice).toHaveCSS(
    "background-color",
    "rgb(255, 248, 217)",
  );
  await expect(
    detailDialog.getByRole("heading", { name: "Storico schede di servizio" }),
  ).toBeVisible();
  await detailDialog.locator(".customer-summary").hover();
  await detailDialog
    .getByRole("button", { name: "Modifica cliente", exact: true })
    .click();
  let dialog = detailDialog;
  await dialog.getByLabel("Telefono", { exact: true }).fill("bad");
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByLabel("Telefono", { exact: true }).fill(phone);
  await dialog
    .getByRole("button", { name: "Aggiungi telefono", exact: true })
    .click();
  await dialog.getByLabel("Telefono 2", { exact: true }).fill(extra);
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(
    detailDialog.getByLabel("Telefono", { exact: true }),
  ).toHaveCount(0);
  await expect(
    detailDialog.locator(".customer-summary .customer-phone"),
  ).toHaveCount(2);
  const firstPhone = detailDialog
    .locator(".customer-summary .customer-phone")
    .first();
  const storedPhone = await firstPhone.locator("a").innerText();
  await expect(firstPhone.locator("a")).toHaveAttribute(
    "href",
    "tel:" + storedPhone,
  );
  await expect(firstPhone.getByRole("button")).toHaveCount(0);
  await detailDialog.locator(".customer-device-row").hover();
  await detailDialog
    .getByRole("button", { name: "Modifica dispositivo", exact: true })
    .click();
  dialog = detailDialog;
  await enterBusinessValue(page, "Modello", "Unsaved Model", dialog);
  await dialog.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(detailDialog.locator(".customer-device-row")).not.toContainText(
    "Unsaved Model",
  );
  await detailDialog.locator(".customer-device-row").hover();
  await detailDialog
    .getByRole("button", { name: "Modifica dispositivo", exact: true })
    .click();
  await dialog
    .getByLabel("IMEI (facoltativo)", { exact: true })
    .fill("123456789012345");
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(
    detailDialog.getByLabel("IMEI (facoltativo)", { exact: true }),
  ).toHaveCount(0);
  await expect(detailDialog.locator(".customer-device-row")).toContainText(
    "123456789012345",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/customer-detail-mobile.png",
    fullPage: true,
  });
  await detailDialog.getByRole("button", { name: "Chiudi" }).click();
  await expect(detailDialog).toHaveCount(0);
  await expect(page.getByLabel("Cerca", { exact: true })).toHaveValue(phone);
  await expect(row).toHaveCount(1);
  await page.getByLabel("Cerca", { exact: true }).fill(extra);
  await expect(row).toHaveCount(1);
  await expect(row.locator(".customer-phone")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/customer-list-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("Cerca", { exact: true }).fill("no matching customer");
  await expect(
    page.getByText("Nessun cliente corrispondente", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancella ricerca", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Cerca", { exact: true })).toHaveValue("");
  await page.getByLabel("Cerca", { exact: true }).fill(extra);
  await page.reload();
  await expect(page.getByLabel("Cerca", { exact: true })).toHaveValue(extra);
  await expect(row).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.screenshot({
    path: "test-results/customer-list-desktop.png",
    fullPage: true,
  });
  await row.getByRole("link", { name, exact: true }).click();
  detailDialog = page.getByRole("dialog", {
    name: "Dettagli cliente",
    exact: true,
  });
  const device = detailDialog.locator(".customer-device-row");
  await device.hover();
  await device
    .getByRole("button", { name: "Elimina dispositivo", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Eliminare il dispositivo?", exact: true })
    .getByRole("button", { name: "Elimina dispositivo", exact: true })
    .click();
  await expect(device).toHaveCount(0);
  await expect(
    detailDialog.getByText("Nessun dispositivo registrato", { exact: true }),
  ).toBeVisible();
  await expect(detailDialog.locator(".table-panel tbody tr")).toHaveCount(1);
  await detailDialog.getByRole("button", { name: "Chiudi" }).click();
  await expect(row.locator(".customer-device-count")).toContainText("0");
  await expect(page.getByLabel("Cerca", { exact: true })).toHaveValue(extra);
});

test("customer page adds, edits and deletes a customer", async ({ page }) => {
  const phone = "339" + Date.now().toString().slice(-7);
  await page.goto("/customers");
  await page
    .getByRole("button", { name: "Nuovo cliente", exact: true })
    .click();
  await page
    .getByLabel("Nome e cognome", { exact: true })
    .fill("Da modificare");
  await page.getByLabel("Telefono", { exact: true }).fill(phone);
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page).toHaveURL(/customers$/);
  await page.getByRole("link", { name: "Da modificare", exact: true }).click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);
  const detailDialog = page.getByRole("dialog", {
    name: "Dettagli cliente",
    exact: true,
  });
  await expect(detailDialog).toBeVisible();
  const summary = detailDialog.locator(".customer-summary");
  await summary.hover();
  await summary
    .getByRole("button", { name: "Modifica cliente", exact: true })
    .click();
  const saveCustomer = detailDialog.getByRole("button", {
    name: "Salva",
    exact: true,
  });
  await expect(saveCustomer).toBeDisabled();
  await page
    .getByLabel("Nome e cognome", { exact: true })
    .fill("Cliente modificato");
  await expect(saveCustomer).toBeEnabled();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  const updatedDetailDialog = page.getByRole("dialog", {
    name: "Dettagli cliente",
    exact: true,
  });
  await expect(updatedDetailDialog).toBeVisible();
  const updatedSummary = updatedDetailDialog.locator(".customer-summary");
  await updatedSummary.hover();
  await updatedSummary
    .getByRole("button", { name: "Elimina cliente", exact: true })
    .click();
  const deleteCustomerDialog = page.getByRole("dialog", {
    name: "Eliminare il cliente?",
    exact: true,
  });
  await expect(deleteCustomerDialog).toHaveCSS("width", "460px");
  await deleteCustomerDialog
    .getByRole("button", { name: "Elimina cliente", exact: true })
    .click();
  await expect(page).toHaveURL(/customers$/);
  await expect(
    page.getByRole("link", { name: "Cliente modificato", exact: true }),
  ).toHaveCount(0);
});
test("quick service editor saves only changed content", async ({ page }) => {
  await page.goto("/settings/quick-services");
  await page.waitForLoadState("networkidle");
  await page.locator(".catalog-manager-row").first().click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox").first();
  const original = await name.inputValue();
  const save = dialog.getByRole("button", { name: "Salva", exact: true });
  await expect(save).toBeDisabled();
  await name.fill(`${original} test`);
  await expect(save).toBeEnabled();
  await name.fill(original);
  await expect(save).toBeDisabled();
  await dialog.getByRole("button", { name: "Annulla", exact: true }).click();
});
test("quick service delete confirmation uses the shared dialog layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/quick-services");
  const row = page.locator(".catalog-manager-row").first();
  await row.hover();
  await row.getByRole("button", { name: /Elimina servizio/ }).click();

  const dialog = page.getByRole("dialog", { name: "Elimina servizio" });
  const body = dialog.locator(":scope > .dialog-body.confirm-delete-dialog");
  const footer = dialog.locator(":scope > .dialog-footer");
  await expect(body).toBeVisible();
  const left = await dialog.evaluate(
    (element) => element.getBoundingClientRect().left,
  );
  const right = await dialog.evaluate(
    (element) => element.getBoundingClientRect().right,
  );
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(left).toBeGreaterThanOrEqual(16);
  expect(viewportWidth - right).toBeGreaterThanOrEqual(16);
  await expect(footer).toBeInViewport();
  await expect(footer).toHaveCSS("flex-direction", "column");
  await expect(
    footer.getByRole("button", { name: "Annulla", exact: true }),
  ).toBeEnabled();
  await footer.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();
});
test("customer dialog keeps filters and inputs on errors and allows deleted numbers again", async ({
  page,
}) => {
  const phone = "335" + Date.now().toString().slice(-7);
  await page.goto("/customers?q=ModalCustomer");
  const open = () =>
    page.getByRole("button", { name: "Nuovo cliente", exact: true }).click();
  await open();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Nome e cognome", { exact: true })
    .fill("ModalCustomer");
  await dialog.getByLabel("Telefono", { exact: true }).fill("bad");
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByLabel("Nome e cognome", { exact: true }),
  ).toHaveValue("ModalCustomer");
  await dialog.getByLabel("Telefono", { exact: true }).fill(phone);
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/customers\?q=ModalCustomer$/);
  await page.getByRole("link", { name: "ModalCustomer", exact: true }).click();
  const detailDialog = page.getByRole("dialog", {
    name: "Dettagli cliente",
    exact: true,
  });
  await expect(detailDialog).toBeVisible();
  await detailDialog.locator(".customer-summary").hover();
  await detailDialog
    .getByRole("button", { name: "Elimina cliente", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Eliminare il cliente?", exact: true })
    .getByRole("button", { name: "Elimina cliente", exact: true })
    .click();
  await expect(page).toHaveURL(/customers\?q=ModalCustomer$/);
  await open();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Nome e cognome", { exact: true })
    .fill("ModalCustomer");
  await dialog.getByLabel("Telefono", { exact: true }).fill(phone);
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("link", { name: "ModalCustomer", exact: true }),
  ).toBeVisible();
  await open();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Nuovo cliente", exact: true }),
  ).toBeFocused();
});

test("quote tree supports contextual dialogs, search, editing and empty branch removal", async ({
  page,
}) => {
  await page.goto("/prices");
  await page
    .getByRole("button", { name: "Nuova regola", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog");
  await chooseBusinessOption(page, "Tipo dispositivo", "Smartwatch", dialog);
  await chooseBusinessOption(page, "Marca", "Apple", dialog);
  await enterBusinessValue(page, "Modello", "Watch Modal", dialog);
  await enterBusinessValue(page, "Intervento", "Test battery", dialog);
  const suggestedPrice = dialog.getByLabel("Prezzo suggerito (€)", {
    exact: true,
  });
  await suggestedPrice.fill("bad");
  await expect(suggestedPrice).toHaveValue("bad");
  expect(
    await suggestedPrice.evaluate((input) =>
      (input as HTMLInputElement).checkValidity(),
    ),
  ).toBe(true);
  await dialog
    .getByRole("button", { name: "Salva ed esci", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Modello", exact: true }),
  ).toHaveValue("Watch Modal");
  await suggestedPrice.fill("40");
  await expect(suggestedPrice).toHaveValue("40");
  expect(
    await suggestedPrice.evaluate((input) =>
      (input as HTMLInputElement).checkValidity(),
    ),
  ).toBe(true);
  const saveResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/prices" &&
      Boolean(response.request().headers()["next-action"]),
    { timeout: 12000 },
  );
  await dialog
    .getByRole("button", { name: "Salva ed esci", exact: true })
    .click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.status()).toBe(200);
  const priceRuleDb = new PrismaClient();
  let savedSuggested: string[];
  try {
    savedSuggested = (
      await priceRuleDb.priceRule.findMany({
        where: {
          brand: "Apple",
          model: "Watch Modal",
          project: "test battery",
        },
        select: { suggested: true },
      })
    ).map((savedRule) => savedRule.suggested.toString());
  } finally {
    await priceRuleDb.$disconnect();
  }
  try {
    await expect(dialog).not.toBeVisible();
  } catch (error) {
    let responseBody: string;
    try {
      responseBody = await saveResponse.text();
    } catch (bodyError) {
      responseBody =
        bodyError instanceof Error ? bodyError.message : String(bodyError);
    }
    console.error(
      `Quote save diagnostic: ${JSON.stringify({
        responseStatus: saveResponse.status(),
        responseBody,
        savedSuggested,
        visibleErrors: await dialog
          .getByRole("alert")
          .allTextContents()
          .catch(() => []),
      })}`,
    );
    throw error;
  }
  expect(savedSuggested).toHaveLength(1);
  expect(Number(savedSuggested[0])).toBe(40);
  await expect(page).toHaveURL(/prices$/);
  const model = page
    .locator("section.price-tree-level")
    .filter({ has: page.locator(".price-toggle", { hasText: "Watch Modal" }) })
    .last();
  await expect(model.locator("article")).toBeVisible();
  const firstRule = model.locator(".price-rule-row").first();
  await firstRule.hover();
  await firstRule
    .getByRole("button", { name: "Modifica preventivo", exact: true })
    .click();
  const editQuote = page.getByRole("dialog", {
    name: "Modifica preventivo",
    exact: true,
  });
  const saveQuote = editQuote.getByRole("button", {
    name: "Salva ed esci",
    exact: true,
  });
  const basePrice = editQuote.getByLabel("Prezzo suggerito (€)", {
    exact: true,
  });
  const originalPrice = await basePrice.inputValue();
  await expect(saveQuote).toBeDisabled();
  await basePrice.fill("987");
  await expect(saveQuote).toBeEnabled();
  await basePrice.fill(originalPrice);
  await expect(saveQuote).toBeDisabled();
  await editQuote
    .getByRole("button", { name: "Chiudi", exact: true })
    .last()
    .click();
  await model.getByRole("button", { name: "Intervento", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Tipo dispositivo", exact: true }),
  ).toContainText("Smartwatch");
  await expect(
    dialog.getByRole("combobox", { name: "Marca", exact: true }),
  ).toHaveValue("Apple");
  await expect(
    dialog.getByRole("combobox", { name: "Modello", exact: true }),
  ).toHaveValue("Watch Modal");
  await enterBusinessValue(page, "Intervento", "Test screen", dialog);
  const secondSuggestedPrice = dialog.getByLabel("Prezzo suggerito (€)", {
    exact: true,
  });
  await secondSuggestedPrice.fill("70");
  await expect(secondSuggestedPrice).toHaveValue("70");
  expect(
    await secondSuggestedPrice.evaluate((input) =>
      (input as HTMLInputElement).checkValidity(),
    ),
  ).toBe(true);
  const secondSaveResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/prices" &&
      Boolean(response.request().headers()["next-action"]),
    { timeout: 12000 },
  );
  await dialog
    .getByRole("button", { name: "Salva ed esci", exact: true })
    .click();
  const secondSaveResponse = await secondSaveResponsePromise;
  expect(secondSaveResponse.status()).toBe(200);
  const savedSecondRuleDb = new PrismaClient();
  let savedSecondSuggested: string[];
  try {
    savedSecondSuggested = (
      await savedSecondRuleDb.priceRule.findMany({
        where: {
          brand: "Apple",
          model: "Watch Modal",
          project: "test screen",
        },
        select: { suggested: true },
      })
    ).map((savedRule) => savedRule.suggested.toString());
  } finally {
    await savedSecondRuleDb.$disconnect();
  }
  await expect(dialog).not.toBeVisible();
  expect(savedSecondSuggested).toEqual(["70"]);
  await expect(model.locator("article")).toHaveCount(2);
  await page.getByLabel("Cerca", { exact: true }).fill("Test battery");
  await expect(page.locator(".rule-list > article")).toHaveCount(1);
  const directPrice = page.locator(".price-rule-row").first();
  await directPrice.locator("button.inline-rule-suggested").click();
  await expect(directPrice.locator("input.inline-rule-project")).toBeVisible();
  await directPrice
    .locator("input.inline-rule-project")
    .fill("Test battery updated");
  await directPrice.locator("input.inline-rule-suggested").fill("45");
  await directPrice.locator("input.inline-rule-suggested").press("Enter");
  await expect(
    directPrice.locator("button.inline-rule-suggested"),
  ).toContainText("45,00");
  await expect(directPrice.locator("button.inline-rule-project")).toContainText(
    "Test battery updated",
  );
  await expect(page.getByLabel("Cerca", { exact: true })).toHaveValue(
    "Test battery",
  );
  await page.getByLabel("Cerca", { exact: true }).fill("Watch Modal");
  await page
    .getByRole("button", { name: "Gestisci selezione", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Seleziona Watch Modal", exact: true })
    .check();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: /Elimina preventivi selezionati/ })
    .click();
  await expect(page.locator(".rule-list > article")).toHaveCount(0);
  await page.getByLabel("Cerca", { exact: true }).fill("");
  await expect(
    page.locator(".price-toggle", { hasText: "Watch Modal" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Nuova regola", exact: true })
    .first()
    .click();
  await chooseBusinessOption(
    page,
    "Tipo dispositivo",
    "Smartband",
    page.getByRole("dialog"),
  );
  expect(
    await page
      .getByRole("dialog")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-quote-dialog.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("hides managed faults without changing historical records", async ({
  page,
}) => {
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await expect(
    page.getByRole("button", { name: "Gestisci problemi", exact: true }),
  ).toHaveCount(0);
  await chooseRepairDevice(page, "Apple iPhone 13");
  await page
    .getByRole("button", { name: "Gestisci problemi", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Gestisci problemi" });
  await expect(
    dialog.locator(":scope > .dialog-body.fault-manager"),
  ).toBeVisible();
  await expect(dialog.locator(":scope > .dialog-footer")).toBeVisible();
  await expect(dialog).toContainText(
    "Problemi frequenti per nuove schede · Telefono",
  );
  await expect(dialog.locator(".fault-manager-header")).toContainText(
    "Nome problema",
  );
  await expect(dialog.locator(".fault-manager-header")).toContainText("Stato");
  await expect(dialog.locator(".fault-manager-header")).not.toContainText(
    "Azioni",
  );
  const sharedColumns = await dialog.evaluate(() => {
    const header = document.querySelector(".fault-manager-header");
    const row = document.querySelector(".fault-manager-row");
    return [header, row].map(
      (element) => getComputedStyle(element!).gridTemplateColumns,
    );
  });
  expect(sharedColumns[0]).toBe(sharedColumns[1]);
  await expect(dialog.locator(".fault-drag-hint")).toBeVisible();
  const faultSearch = dialog.locator(".fault-search");
  const addFault = dialog.getByRole("button", {
    name: "Aggiungi problema",
    exact: true,
  });
  await expect(addFault).toBeDisabled();
  await expect(addFault).toHaveCSS("background-color", "rgb(241, 243, 242)");
  await expect(addFault).toHaveCSS("border-color", "rgb(225, 229, 227)");
  await expect(addFault).toHaveCSS("color", "rgb(154, 162, 159)");
  await expect(addFault).toHaveCSS("cursor", "not-allowed");
  await expect(addFault).toHaveCSS("opacity", "1");
  await expect(addFault).toHaveCSS("transform", "none");
  await addFault.hover();
  await expect(addFault).toHaveCSS("transform", "none");
  const aligned = await Promise.all([
    faultSearch.boundingBox(),
    addFault.boundingBox(),
  ]);
  expect(
    Math.abs((aligned[0]?.height ?? 0) - (aligned[1]?.height ?? 0)),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs((aligned[0]?.y ?? 0) - (aligned[1]?.y ?? 0)),
  ).toBeLessThanOrEqual(2);
  let row = dialog.locator(".fault-manager-row").filter({
    hasText: "Display rotto",
  });
  expect(
    await row.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(52);
  expect(
    await row.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(56);
  const centers = await row.evaluate((element) =>
    [
      element.querySelector(".fault-drag-handle"),
      element.querySelector(".fault-name-button"),
      element.querySelector(".fault-enabled-switch"),
      element.querySelector(".fault-delete-button"),
    ].map((node) => {
      const box = node!.getBoundingClientRect();
      return box.top + box.height / 2;
    }),
  );
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
  const statusCenters = await dialog.evaluate(() => {
    const header = document
      .querySelector(".fault-manager-header .fault-manager-status")!
      .getBoundingClientRect();
    const status = document
      .querySelector(".fault-manager-row .fault-enabled-switch")!
      .getBoundingClientRect();
    return [header.left + header.width / 2, status.left + status.width / 2];
  });
  expect(Math.abs(statusCenters[0] - statusCenters[1])).toBeLessThanOrEqual(1);
  await expect(row.locator(".fault-enabled-switch")).toHaveCSS("gap", "8px");
  await expect(row.locator(".fault-delete-button")).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(row.locator(".fault-delete-button")).toHaveCSS("opacity", "1");

  await row.locator(".fault-name-button").click();
  const inlineName = dialog.locator(".fault-inline-name");
  await inlineName.fill("Display rotto test");
  await inlineName.press("Escape");
  await expect(row.locator(".fault-name-button")).toHaveText("Display rotto");

  await row.locator(".fault-enabled-switch input").uncheck();
  const closeManager = dialog.locator(".dialog-actions button");
  await expect(closeManager).toBeEnabled();
  await closeManager.click();
  await page
    .getByRole("button", { name: "Gestisci problemi", exact: true })
    .click();
  row = page
    .getByRole("dialog", { name: "Gestisci problemi" })
    .locator(".fault-manager-row")
    .filter({ hasText: "Display rotto" });
  await expect(row.locator(".fault-enabled-switch input")).not.toBeChecked();
  const createdName = `Problema inline ${Date.now()}`;
  const searchInput = dialog.locator(".fault-search input");
  await expect(dialog.locator(".fault-manager")).toHaveCSS(
    "overflow-y",
    "visible",
  );
  await expect(faultSearch).toHaveCSS("flex-direction", "row");
  const searchLayout = await faultSearch.evaluate((element) => {
    const wrapper = element.getBoundingClientRect();
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    const input = element.querySelector("input")!.getBoundingClientRect();
    return {
      iconInside:
        icon.top >= wrapper.top + 1 && icon.bottom <= wrapper.bottom - 1,
      inputInside:
        input.top >= wrapper.top + 1 && input.bottom <= wrapper.bottom - 1,
    };
  });
  expect(searchLayout).toEqual({ iconInside: true, inputInside: true });
  await searchInput.fill("Display");
  await expect(addFault).toBeDisabled();
  for (const state of ["default", "hover", "focus"] as const) {
    if (state === "hover") await faultSearch.hover();
    if (state === "focus") await searchInput.focus();
    const borders = await faultSearch.evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ];
    });
    expect(borders).toEqual(["1px", "1px", "1px", "1px"]);
  }
  await searchInput.fill(createdName);
  await expect(addFault).toBeEnabled();
  await addFault.evaluate((button) => {
    const states: boolean[] = [];
    const observer = new MutationObserver(() => {
      states.push((button as HTMLButtonElement).disabled);
    });
    observer.observe(button, {
      attributes: true,
      attributeFilter: ["disabled"],
    });
    Object.assign(window, {
      __faultButtonStates: states,
      __faultButtonObserver: observer,
    });
  });
  await searchInput.press("End");
  await searchInput.type(" xyz", { delay: 30 });
  await expect(addFault).toBeEnabled();
  expect(
    await page.evaluate(() => {
      const target = window as typeof window & {
        __faultButtonStates?: boolean[];
        __faultButtonObserver?: MutationObserver;
      };
      target.__faultButtonObserver?.disconnect();
      return target.__faultButtonStates ?? [];
    }),
  ).not.toContain(true);
  const finalCreatedName = `${createdName} xyz`;
  await addFault.click();
  await expect(searchInput).toHaveValue("");
  const createdRow = dialog.locator(".fault-manager-row").filter({
    hasText: finalCreatedName,
  });
  await expect(createdRow).toBeVisible();
  await createdRow.locator(".fault-name-button").click();
  const createdInlineName = dialog.locator(".fault-inline-name");
  await createdInlineName.fill(`${finalCreatedName} modificato`);
  await createdInlineName.press("Enter");
  await expect(
    dialog.locator(".fault-manager-row").filter({
      hasText: `${finalCreatedName} modificato`,
    }),
  ).toBeVisible();
  await dialog.locator(".dialog-actions button").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Display rotto", { exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await chooseRepairDevice(page, "Apple iPhone 13");
  await expect(page.getByLabel("Display rotto", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Gestisci problemi", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Gestisci problemi" })
      .locator(".fault-manager-row")
      .filter({ hasText: "Display rotto" }),
  ).toContainText("Disattivato");
});

test("quote hierarchy supports stable hover editing and linked batch selection", async ({
  page,
}) => {
  await page.goto("/prices");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByLabel("Cerca", { exact: true }).fill("iPhone 13");
  const rows = page.locator(".price-rule-row");
  await expect(
    page
      .locator(".price-tree-heading-brand")
      .filter({ hasText: "Apple" })
      .locator('[data-brand-icon="logo"]'),
  ).toHaveAttribute("aria-label", "Apple");
  const addProject = page
    .getByRole("button", { name: "Intervento", exact: true })
    .last();
  await expect(addProject).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(addProject).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await addProject.hover();
  await expect(addProject).toHaveCSS("background-color", "rgb(255, 241, 182)");
  await addProject.click();
  const createDialog = page.getByRole("dialog");
  await enterBusinessValue(
    page,
    "Intervento",
    `Verifica selezione parziale ${Date.now()}`,
    createDialog,
  );
  await createDialog
    .getByLabel("Prezzo suggerito (€)", { exact: true })
    .fill("35");
  await createDialog
    .getByRole("button", { name: "Salva ed esci", exact: true })
    .click();
  await expect(createDialog).not.toBeVisible();
  await page.getByLabel("Cerca", { exact: true }).fill("iPhone 13");
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
  const searchBox = page.getByLabel("Cerca", { exact: true });
  const batchButton = page.getByRole("button", {
    name: "Gestisci selezione",
    exact: true,
  });
  const searchBoxPosition = await searchBox.boundingBox();
  const batchButtonPosition = await batchButton.boundingBox();
  expect(Math.abs(searchBoxPosition!.y - batchButtonPosition!.y)).toBeLessThan(
    8,
  );
  await expect(batchButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(batchButton).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await batchButton.hover();
  await expect(batchButton).toHaveCSS("background-color", "rgb(255, 241, 182)");
  const ruleListPosition = await page
    .locator(".rule-list")
    .first()
    .boundingBox();
  const modelHeadingPosition = await page
    .locator(".price-tree-heading-model")
    .first()
    .boundingBox();
  expect(
    Math.abs(ruleListPosition!.width - modelHeadingPosition!.width),
  ).toBeLessThan(2);
  const row = rows.first();
  await expect(row).toBeVisible();
  const desktopColumnCount = await row.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  );
  expect(desktopColumnCount).toBe(4);
  const rowPosition = await row.boundingBox();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "Elimina preventivo", exact: true }),
  ).toHaveCount(0);
  const actions = row.locator(".price-row-actions");
  const projectPosition = await row
    .locator("button.inline-rule-project")
    .boundingBox();
  const pricePosition = await row
    .locator("button.inline-rule-suggested")
    .boundingBox();
  const actionsPosition = await actions.boundingBox();
  expect(pricePosition!.x).toBeGreaterThan(
    projectPosition!.x + projectPosition!.width,
  );
  expect(pricePosition!.x + pricePosition!.width).toBeLessThanOrEqual(
    actionsPosition!.x + 1,
  );
  await page.mouse.move(0, 0);
  await expect(
    actions.getByRole("button", { name: "Modifica preventivo" }),
  ).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(row).toHaveClass(/business-list-row/);
  await expect(row).toHaveCSS("background-color", "rgb(255, 251, 234)");
  await expect(row).toHaveCSS("transform", "none");
  await expect(
    actions.getByRole("button", { name: "Modifica preventivo" }),
  ).toHaveCSS("opacity", "1");
  const hoveredProjectPosition = await row
    .locator("button.inline-rule-project")
    .boundingBox();
  const hoveredPricePosition = await row
    .locator("button.inline-rule-suggested")
    .boundingBox();
  expect(hoveredProjectPosition!.x).toBe(projectPosition!.x);
  expect(hoveredProjectPosition!.width).toBe(projectPosition!.width);
  expect(hoveredPricePosition!.x).toBe(pricePosition!.x);
  expect(hoveredPricePosition!.width).toBe(pricePosition!.width);
  await row.click({ position: { x: 3, y: 3 } });
  await expect(row).toHaveClass(/order-row-active/);
  await expect(row).toHaveCSS("transform", "none");
  await expect(row.locator("input.inline-rule-project")).toBeVisible();
  await expect(row.locator("input.inline-rule-suggested")).toBeVisible();
  const activeRowPosition = await row.boundingBox();
  expect(activeRowPosition!.width).toBe(rowPosition!.width);
  expect(activeRowPosition!.height).toBe(rowPosition!.height);
  const nextRow = rows.nth(1);
  await nextRow.click({ position: { x: 3, y: 3 } });
  await expect(nextRow).toHaveClass(/order-row-active/);
  await expect(row).not.toHaveClass(/order-row-active/);
  await nextRow.locator("input.inline-rule-suggested").fill("88");
  await searchBox.click();
  await expect(nextRow).not.toHaveClass(/order-row-active/);
  await expect(nextRow.locator("button.inline-rule-suggested")).toContainText(
    "88,00",
  );
  await nextRow.click({ position: { x: 3, y: 3 } });
  await expect(nextRow).toHaveClass(/order-row-active/);
  const originalProject = await nextRow
    .locator("input.inline-rule-project")
    .inputValue();
  await nextRow.locator("input.inline-rule-project").fill("annullato");
  await nextRow.locator("input.inline-rule-project").press("Escape");
  await expect(nextRow).not.toHaveClass(/order-row-active/);
  await expect(nextRow.locator("button.inline-rule-project")).toHaveText(
    originalProject,
  );
  await nextRow.click({ position: { x: 3, y: 3 } });
  await expect(nextRow).toHaveClass(/order-row-active/);
  await expect(row.locator(".price-rule-header")).toHaveCount(0);
  await expect(page.locator(".price-rule-header").first()).toContainText(
    "Intervento",
  );
  await expect(page.locator(".price-rule-header").first()).toContainText(
    "Preventivo",
  );
  await expect(
    page.getByRole("button", { name: "Nuova regola", exact: true }),
  ).toHaveCount(1);
  const changed = row;
  await expect(page.getByLabel("Cerca", { exact: true })).toHaveValue(
    "iPhone 13",
  );
  await expect(
    changed.getByRole("button", { name: "Modifica preventivo", exact: true }),
  ).toBeVisible();
  await expect(
    changed.getByRole("button", { name: /^Altre azioni/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Gestisci selezione", exact: true })
    .click();
  const batchColumnCount = await changed.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  );
  expect(batchColumnCount).toBe(5);
  await expect(nextRow).not.toHaveClass(/order-row-active/);
  const modelSelection = page.getByRole("checkbox", {
    name: "Seleziona iPhone 13",
    exact: true,
  });
  const brandSelection = page.getByRole("checkbox", {
    name: "Seleziona Apple",
    exact: true,
  });
  const categorySelection = page.getByRole("checkbox", {
    name: "Seleziona Telefono",
    exact: true,
  });
  await changed.getByRole("checkbox").check();
  await expect(modelSelection).toHaveJSProperty("indeterminate", true);
  await expect(categorySelection).toHaveJSProperty("indeterminate", true);
  await expect(brandSelection).toHaveJSProperty("indeterminate", true);
  await expect(brandSelection).toHaveAttribute("aria-checked", "mixed");
  await expect(brandSelection).toHaveCSS(
    "background-color",
    "rgb(251, 215, 46)",
  );
  expect(
    await brandSelection.evaluate(
      (checkbox) => getComputedStyle(checkbox, "::before").transform,
    ),
  ).toBe("matrix(1, 0, 0, 1, 0, 0)");
  await expect(page.locator(".price-batch-toolbar")).toContainText(
    "1 interventi selezionati",
  );
  await modelSelection.check();
  expect(
    await page
      .locator('.price-rule-row > input[type="checkbox"]')
      .evaluateAll((checkboxes) =>
        checkboxes.every((checkbox) => (checkbox as HTMLInputElement).checked),
      ),
  ).toBe(true);
  await expect(modelSelection).toBeChecked();
  await expect(brandSelection).toBeChecked();
  await page
    .getByRole("button", { name: "Fine selezione", exact: true })
    .click();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await changed.scrollIntoViewIfNeeded();
  const mobileColumnCount = await changed.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  );
  expect(mobileColumnCount).toBe(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(changed.locator("button.inline-rule-project")).toBeInViewport();
  await page.screenshot({
    path: "test-results/compact-prices-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Gestisci selezione", exact: true })
    .click();
  const mobileBatchColumnCount = await changed.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  );
  expect(mobileBatchColumnCount).toBe(5);
  await expect(changed.getByRole("checkbox")).not.toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("checkbox", { name: "Seleziona iPhone 13", exact: true })
    .check();
  await page.getByLabel("Cerca", { exact: true }).fill("no-such-project");
  await expect(
    page.getByRole("button", { name: /Elimina preventivi selezionati/ }),
  ).toBeDisabled();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("part plan management stays in the quote editor and supports creating a new part", async ({
  page,
}) => {
  await page.goto("/prices");
  await page.getByLabel("Cerca", { exact: true }).fill("iPhone 14");
  const row = page
    .locator(".price-rule-row")
    .filter({ hasText: "sostituzione batteria" });
  const optionCount = Number(
    await row.locator(".price-option-count").innerText(),
  );
  expect(optionCount).toBeGreaterThan(0);
  await expect(row.locator(".price-option-summary")).toHaveCount(0);
  await row.hover();
  await row
    .getByRole("button", { name: "Modifica preventivo", exact: true })
    .click();

  const editDialog = page.getByRole("dialog", {
    name: "Modifica preventivo",
    exact: true,
  });
  await expect(
    editDialog.getByRole("button", { name: "Tipo dispositivo", exact: true }),
  ).toBeVisible();
  const optionSection = editDialog.locator(".price-rule-editor-options");
  await expect(optionSection).toBeVisible();
  await expect(optionSection.locator(".price-rule-editor-count")).toHaveText(
    String(optionCount),
  );
  await expect(
    optionSection.locator(".price-option-card").filter({
      hasText: "Batteria Test",
    }),
  ).toBeVisible();
  await optionSection
    .getByRole("button", { name: "Opzione ricambio", exact: true })
    .click();
  const newOption = page.getByRole("dialog", {
    name: "Nuova opzione ricambio",
    exact: true,
  });
  const partSearch = newOption.getByRole("combobox", {
    name: "Ricambio richiesto",
    exact: true,
  });
  const productName = `Ricambio preventivo ${Date.now()}`;
  await partSearch.fill(productName);
  const newPart = newOption.locator(".business-select-create");
  await expect(newPart).toContainText("Ricambio");
  await expect(newPart).toBeEnabled();
  await newPart.click();
  const productDialog = page.getByRole("dialog", {
    name: "Nuovo ricambio per riparazione",
    exact: true,
  });
  await expect(
    productDialog.getByLabel("Nome ricambio", { exact: true }),
  ).toHaveValue(productName);
  await expect(productDialog).toContainText(
    "Utilizzo: Apple · iPhone 14 · sostituzione batteria",
  );
  await productDialog.getByLabel("Costo (€)", { exact: true }).fill("12");
  await productDialog.getByLabel("Scorta minima", { exact: true }).fill("1");
  await productDialog
    .getByRole("button", { name: "Crea e seleziona", exact: true })
    .click();
  await expect(productDialog).toHaveCount(0);
  await expect(partSearch).toHaveValue(productName);
  await expect(
    newOption.getByLabel("Nome opzione", { exact: true }),
  ).toHaveValue(productName);
  await newOption
    .getByLabel("Prezzo suggerito (€)", { exact: true })
    .fill("95");
  await newOption.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(newOption).toHaveCount(0);
  await expect(editDialog).toBeVisible();
  await expect(
    optionSection.locator(".price-option-card").filter({
      hasText: productName,
    }),
  ).toBeVisible();
  await editDialog.locator(".dialog-actions button").first().click();
  await expect(editDialog).not.toBeVisible();

  await row.hover();
  await row
    .getByRole("button", { name: "Modifica preventivo", exact: true })
    .click();
  const reopenedDialog = page.getByRole("dialog", {
    name: "Modifica preventivo",
    exact: true,
  });
  await expect(
    reopenedDialog.locator(".price-option-card").filter({
      hasText: productName,
    }),
  ).toBeVisible();
  await reopenedDialog.locator(".dialog-actions button").first().click();
  await expect(reopenedDialog).not.toBeVisible();
});

test("new quotes show the selected repair project's part plans", async ({
  page,
}) => {
  await page.goto("/prices");
  await page.getByRole("button", { name: "Nuova regola", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Nuova regola",
    exact: true,
  });
  await chooseBusinessOption(page, "Marca", "Apple", dialog);
  await chooseBusinessOption(page, "Modello", "iPhone 14", dialog);
  await chooseBusinessOption(
    page,
    "Intervento",
    "sostituzione batteria",
    dialog,
  );
  const optionSection = dialog.locator(".price-rule-editor-options");
  await expect(optionSection).toContainText("Batteria Test");
  await expect(
    optionSection.getByRole("button", {
      name: "Opzione ricambio",
      exact: true,
    }),
  ).toBeEnabled();
  await dialog.locator(".dialog-close").click();
});

test("price batch selection count uses shared status styles", async ({
  page,
}) => {
  await page.goto("/prices");
  const manageSelection = page.getByRole("button", {
    name: "Gestisci selezione",
    exact: true,
  });
  await expect(manageSelection).toHaveCSS("min-height", "36px");
  await manageSelection.click();

  const toolbar = page.locator(".price-batch-toolbar");
  await expect(toolbar).toHaveCSS("justify-content", "flex-start");
  await expect(toolbar).toHaveCSS("flex-wrap", "wrap");
  const selectedCount = toolbar.getByRole("status");
  await expect(selectedCount).toBeVisible();
  await expect(selectedCount).toHaveCSS("font-size", "12px");
  await expect(selectedCount).toHaveCSS("font-weight", "650");
  await expect(selectedCount).toHaveCSS("white-space", "nowrap");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(selectedCount).toHaveCSS("flex-basis", "100%");
  await expect(toolbar.getByRole("button").first()).toHaveCSS(
    "flex-basis",
    "130px",
  );
  await expect(toolbar.getByRole("button").first()).toHaveCSS(
    "white-space",
    "normal",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("price editor keeps deletion inside batch management", async ({
  page,
}) => {
  await page.goto("/prices");
  await page.getByRole("button", { name: "Apple", exact: true }).click();
  await page.getByRole("button", { name: "Telefono", exact: true }).click();
  const modelToggle = page.getByRole("button", {
    name: "iPhone 13",
    exact: true,
  });
  const modelSection = modelToggle.locator(
    "xpath=ancestor::section[contains(@class, 'price-tree-level')][1]",
  );
  await modelToggle.click();
  await modelSection
    .getByRole("button", { name: "Intervento", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await enterBusinessValue(page, "Intervento", "Da eliminare", dialog);
  const suggestedPrice = dialog.getByLabel("Prezzo suggerito (€)", {
    exact: true,
  });
  await suggestedPrice.fill("25");
  await expect(suggestedPrice).toHaveValue("25");
  await dialog
    .getByRole("button", { name: "Salva ed esci", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const removable = page
    .locator(".price-rule-row")
    .filter({ hasText: "Da eliminare" });
  await expect(removable).toBeVisible();
  await removable.hover();
  await expect(
    removable.getByRole("button", {
      name: "Elimina preventivo",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Gestisci selezione", exact: true })
    .click();
  await removable.getByRole("checkbox").check();
  await expect(page.locator(".price-batch-toolbar")).toContainText(
    "1 interventi selezionati",
  );
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: /Elimina preventivi selezionati/ })
    .click();
  await expect(removable).toHaveCount(0);
});

test("settings exports data and re-import skips existing records", async ({
  page,
}) => {
  await page.goto("/settings/data");
  await page.evaluate(() =>
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    }),
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Esporta dati", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^ngt-backup-.*\.json$/);
  const sameOriginHeaders = {
    Origin: new URL(page.url()).origin,
    "Sec-Fetch-Site": "same-origin",
  };
  const exported = await page.request.get("/api/data/export", {
    headers: sameOriginHeaders,
  });
  expect(exported.ok()).toBe(true);
  expect(exported.headers()["content-disposition"]).toContain("ngt-backup-");
  const backup = await exported.json();
  expect(backup).toMatchObject({
    format: "ngt-repair-data",
    version: 10,
  });
  const imported = await page.request.post("/api/data/import", {
    data: backup,
    headers: sameOriginHeaders,
  });
  expect(imported.ok()).toBe(true);
  const result = await imported.json();
  expect(result.imported).toBe(0);
  expect(result.skipped).toBeGreaterThan(0);
});

for (const width of [1280, 390]) {
  test(`creation buttons and dialog actions stay consistent at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const [path, name, cancelLabel, saveLabel] of [
      ["/customers", "Nuovo cliente", "Annulla", "Salva"],
      ["/prices", "Nuova regola", "Chiudi", "Salva ed esci"],
    ]) {
      await page.goto(path);
      const trigger = page
        .locator(".page-header")
        .getByRole("button", { name, exact: true });
      await expect(trigger).toBeVisible();
      if (width === 1280) {
        const heading = await page.locator("h1").boundingBox();
        const button = await trigger.boundingBox();
        expect(button!.x).toBeGreaterThan(heading!.x + heading!.width);
      }
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator(":focus")).toHaveCount(1);
      const cancel = dialog.locator(".dialog-actions").getByRole("button", {
        name: cancelLabel,
        exact: true,
      });
      const saveButton = dialog.getByRole("button", {
        name: saveLabel,
        exact: true,
      });
      const lastInput = dialog.locator("input").last();
      await lastInput.scrollIntoViewIfNeeded();
      await expect(lastInput).toBeInViewport();
      const cancelBox = await cancel.boundingBox();
      const saveBox = await saveButton.boundingBox();
      const footer = await dialog.locator(".dialog-actions").boundingBox();
      const lastInputBox = await lastInput.boundingBox();
      expect(cancelBox!.x + cancelBox!.width).toBeLessThan(saveBox!.x);
      expect(Math.abs(cancelBox!.y - saveBox!.y)).toBeLessThan(2);
      expect(
        Math.abs(saveBox!.x + saveBox!.width - footer!.x - footer!.width),
      ).toBeLessThan(2);
      expect(lastInputBox!.y + lastInputBox!.height).toBeLessThanOrEqual(
        footer!.y,
      );
      expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `test-results/creation-${path.slice(1)}-${width}.png`,
      });
      await cancel.click();
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
    }
  });
}

test("shared action affordances, price search and delivery date limit", async ({
  page,
}) => {
  await page.goto("/prices");
  const search = page.getByRole("searchbox", { name: "Cerca", exact: true });
  await expect(search).toHaveAttribute(
    "placeholder",
    "Cerca marca, modello o intervento",
  );
  await expect(page.locator(".filters").filter({ has: search })).toBeVisible();
  await page.goto("/orders/new");
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await chooseRepairDevice(page, "Apple iPhone 13");
  await page.locator(".fault-choice input").first().check();
  const date = page.locator('input[name="dueDate"]');
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  await expect(date).toHaveAttribute("min", today);
  await date.fill("2000-01-01");
  expect(
    await date.evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow),
  ).toBe(true);
  await date.fill(today);
  expect(await date.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(
    true,
  );
  await page.goto("/customers");
  await page.locator(".customer-table .order-link").first().click();
  const customerDetail = page.getByRole("dialog");
  await expect(customerDetail).toHaveClass(/form-dialog/);
  await expect(customerDetail).toHaveCSS("width", "1000px");
  const dialogBox = await customerDetail.boundingBox();
  expect(dialogBox?.width).toBeGreaterThanOrEqual(900);
  expect(dialogBox?.width).toBeLessThanOrEqual(1100);
  await expect(customerDetail.locator(".customer-detail-dialog")).toHaveCSS(
    "overflow-y",
    "auto",
  );
});

test("customer batch deletion keeps selection scoped and confirms the count", async ({
  page,
}) => {
  const prefix = "Batch-" + Date.now();
  for (let i = 0; i < 2; i++) {
    await page.goto("/customers");
    await page
      .getByRole("button", { name: "Nuovo cliente", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Nome e cognome", { exact: true })
      .fill(prefix + "-" + i);
    await dialog
      .getByLabel("Telefono", { exact: true })
      .fill("334" + String(Date.now()).slice(-6) + i);
    await dialog.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  const search = page.getByLabel("Cerca", { exact: true });
  await search.fill(prefix);
  await expect(page.locator(".customer-table tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Elimina clienti selezionati" }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Gestisci selezione", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Seleziona tutti", exact: true })
    .check();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("2 clienti");
    await dialog.dismiss();
  });
  await page
    .getByRole("button", { name: "Elimina clienti selezionati" })
    .click();
  await expect(page.locator(".customer-table tbody tr")).toHaveCount(2);
  await search.fill(prefix + "-0");
  await expect(
    page.getByRole("button", { name: "Elimina clienti selezionati" }),
  ).toBeDisabled();
  await search.fill(prefix);
  await page
    .getByRole("checkbox", { name: "Seleziona tutti", exact: true })
    .check();
  await page.setViewportSize({ width: 390, height: 844 });
  const customerToolbar = page.locator(".customer-batch-toolbar");
  await expect(customerToolbar).toHaveCSS("justify-content", "flex-start");
  await expect(customerToolbar).toHaveCSS("flex-wrap", "wrap");
  await expect(customerToolbar).toHaveCSS("margin-left", "0px");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/customer-batch-mobile.png",
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Elimina clienti selezionati" })
    .click();
  await expect(page.locator(".customer-table tbody tr")).toHaveCount(0);
  await expect(search).toHaveValue(prefix);
});

test("customer detail removes duplicate actions and supports keyboard icon editing", async ({
  page,
}) => {
  await page.goto("/customers");
  await page.waitForLoadState("networkidle");
  await page.locator(".customer-name .order-link").first().click();
  const customerDialog = page.getByRole("dialog");
  await expect(customerDialog.locator(".customer-summary")).toBeVisible();
  const dialogClose = customerDialog.locator(".dialog-close");
  await dialogClose.hover();
  await expect(dialogClose).toHaveCSS("background-color", "rgb(255, 240, 238)");
  await expect(dialogClose).toHaveCSS("color", "rgb(166, 70, 66)");
  await expect(
    customerDialog.locator(".eyebrow").filter({ hasText: "Area di lavoro" }),
  ).toHaveCount(0);
  await expect(
    customerDialog.getByRole("columnheader", { name: "Cliente", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".table-action")).toHaveCount(0);
  const edit = page
    .locator(".customer-detail-dialog .customer-summary")
    .getByRole("button", { name: "Modifica cliente", exact: true });
  await expect(edit).toHaveCSS("opacity", "0");
  await customerDialog.locator(".customer-summary").hover();
  await expect(edit).toHaveCSS("opacity", "1");
  const remove = customerDialog
    .locator(".customer-summary")
    .getByRole("button", { name: "Elimina cliente", exact: true });
  await remove.hover();
  await expect(remove).toHaveCSS("background-color", "rgb(255, 240, 238)");
  await expect(remove).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await edit.focus();
  await page.keyboard.press("Enter");
  await expect(
    customerDialog.getByLabel("Nome e cognome", { exact: true }),
  ).toBeVisible();
  await customerDialog
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(edit).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/customer-detail-" + width + ".png",
      fullPage: false,
    });
  }
});

for (const width of [1280, 390]) {
  test(`customer batch mode is opt-in and resets at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/customers");
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Gestisci selezione", exact: true })
      .click();
    const selection =
      width === 390
        ? page
            .getByRole("checkbox", { name: /Seleziona Cliente Playwright/ })
            .first()
        : page.getByRole("checkbox", {
            name: "Seleziona tutti",
            exact: true,
          });
    await selection.check();
    await expect(
      page.getByRole("button", { name: /Elimina clienti selezionati/ }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Fine selezione", exact: true })
      .click();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Gestisci selezione", exact: true })
      .click();
    await expect(
      page.locator('.customer-table input[type="checkbox"]').first(),
    ).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: /Elimina clienti selezionati/ }),
    ).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("closing customer detail preserves list scroll and batch state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto("/customers");
  await page
    .getByRole("button", { name: "Gestisci selezione", exact: true })
    .click();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(0);
  await page.locator(".customer-name .order-link").last().click();
  const detailDialog = page.getByRole("dialog");
  await expect(
    detailDialog.locator(":scope > .dialog-body.customer-detail-dialog"),
  ).toBeVisible();
  await detailDialog.getByRole("button", { name: "Chiudi" }).click();
  await expect(detailDialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Fine selezione", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.customer-table input[type="checkbox"]'),
  ).not.toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
});

test("customer name and customer row reuse the repair list hover", async ({
  page,
}) => {
  await page.goto("/customers");
  const link = page.locator(".customer-name .order-link").first();
  const row = page.locator(".customer-table tbody tr").first();
  await expect(row).toBeVisible();
  await link.hover();
  await expect(link).toHaveCSS("transform", "none");
  await expect(link.locator("svg")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 4, 0)",
  );
  await expect(row).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -1)");
  expect(
    await link
      .locator("span")
      .evaluate((element) => getComputedStyle(element, "::after").transform),
  ).toBe("matrix(1, 0, 0, 1, 0, 0)");
});

test("customer detail stays in one dialog and exposes inline device actions", async ({
  page,
}) => {
  const suffix = Date.now().toString().slice(-7);
  const name = `Cliente dialogo ${suffix}`;
  await fillOrder(page, { name, phone: `336${suffix}`, diagnosis: true });
  await save(page);
  await page.goto("/customers");

  const search = page.getByLabel("Cerca", { exact: true });
  const manage = page.getByRole("button", {
    name: "Gestisci selezione",
    exact: true,
  });
  await expect(search).toBeVisible();
  await expect(manage).toBeVisible();
  expect(
    Math.abs((await search.boundingBox())!.y - (await manage.boundingBox())!.y),
  ).toBeLessThan(2);
  await expect(
    page.getByRole("columnheader", { name: "Ultima riparazione" }),
  ).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Azioni" })).toHaveCount(
    0,
  );

  await manage.click();
  const selectAll = page.getByRole("checkbox", {
    name: "Seleziona tutti",
    exact: true,
  });
  await selectAll.check();
  await expect(
    page.getByRole("button", { name: /Elimina clienti selezionati/ }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Fine selezione", exact: true })
    .click();

  await search.fill(name);
  await page.getByRole("link", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Dettagli cliente",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("columnheader", {
      name: "Ultima operazione",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.locator(".order-list-body .order-updated-cell").first(),
  ).not.toBeEmpty();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await dialog.locator(".customer-summary").hover();
  await dialog
    .getByRole("button", { name: "Modifica cliente", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await dialog
    .getByLabel("Nome e cognome", { exact: true })
    .fill(`${name} non salvato`);
  await dialog.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(dialog).toContainText(name);
  await expect(dialog).not.toContainText("non salvato");

  await dialog
    .getByRole("button", { name: "Dispositivo", exact: true })
    .click();
  const deviceDialog = page.getByRole("dialog", {
    name: "Nuovo dispositivo",
    exact: true,
  });
  await chooseBusinessOption(page, "Marca", "Apple", deviceDialog);
  await chooseBusinessOption(page, "Modello", "iPhone 13", deviceDialog);
  await deviceDialog
    .getByLabel("IMEI (facoltativo)", { exact: true })
    .fill(suffix);
  await deviceDialog
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  const added = dialog
    .locator(".customer-device-row")
    .filter({ hasText: suffix });
  await expect(added).toContainText(suffix);
  await added.hover();
  await added
    .getByRole("button", { name: "Elimina dispositivo", exact: true })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Eliminare il dispositivo?",
    exact: true,
  });
  await expect(confirm).toContainText("Apple iPhone 13");
  await confirm
    .getByRole("button", { name: "Elimina dispositivo", exact: true })
    .click();
  await expect(added).toHaveCount(0);
});

test("customer links from repair list and detail open the shared dialog", async ({
  page,
}) => {
  const suffix = Date.now().toString().slice(-7);
  const name = `Cliente link ${suffix}`;
  await fillOrder(page, { name, phone: `337${suffix}`, diagnosis: true });
  await save(page);
  await page.goto("/orders");
  const row = page.locator(".order-list-body tr").filter({ hasText: name });
  const orderCode = await row.locator(".order-code-link").innerText();
  await row.locator(".order-customer-link").click();
  let dialog = page.getByRole("dialog", {
    name: "Dettagli cliente",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Chiudi" }).click();
  await expect(page).toHaveURL(/\/orders/);

  await row.locator(".order-code-link").click();
  const detailCustomerLink = page.locator(
    ".order-detail-card .order-customer-link",
  );
  await expect(detailCustomerLink).toBeVisible();
  await detailCustomerLink.click();
  dialog = page.getByRole("dialog", {
    name: "Dettagli cliente",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".order-detail-card").first()).toBeVisible();

  const historyRow = dialog
    .locator(".order-list-body tr")
    .filter({ hasText: orderCode });
  await historyRow.click();
  await expect(
    historyRow.locator(".order-due-cell .order-static-value"),
  ).toContainText(/2099-12-31|31\/12\/2099/);
  await expect(historyRow.locator(".order-due-cell input")).toHaveCount(0);
  await expect(historyRow.locator(".order-due-cell button")).toHaveCount(0);
  await historyRow.click();
  await expect(historyRow.locator(".order-due-cell input")).toHaveCount(0);
  await expect(historyRow.locator(".order-due-cell button")).toHaveCount(0);

  await historyRow.click();
  await expect(historyRow).toHaveClass(/order-row-active/);
  await expect(historyRow).toHaveCSS("background-color", "rgb(255, 249, 232)");
  await expect(historyRow.locator("td").first()).toHaveCSS(
    "box-shadow",
    /rgb\(228, 182, 0\)/,
  );
  await historyRow.locator(".status-dropdown-trigger").click();
  const menu = dialog.locator(".status-dropdown-menu");
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    }),
  ).toBe(true);
  await historyRow.evaluate((element) => {
    element.dataset.statusHighlightObserved = "false";
    new MutationObserver(() => {
      if (element.classList.contains("order-row-status-highlight"))
        element.dataset.statusHighlightObserved = "true";
    }).observe(element, { attributes: true, attributeFilter: ["class"] });
  });
  await menu.getByRole("option", { name: "Annullato", exact: true }).click();
  const cancelDialog = page.getByRole("dialog", {
    name: "Annulla scheda di servizio",
    exact: true,
  });
  await cancelDialog
    .getByRole("button", { name: "Conferma annullamento", exact: true })
    .click();
  await expect(cancelDialog).toHaveCount(0);
  await expect(historyRow).not.toHaveClass(/order-row-active/);
  await expect(historyRow).toHaveClass(/order-row-hover-suppressed/);
  await expect(historyRow.locator(".badge")).toContainText("Annullato");
  await historyRow.hover();
  await expect(historyRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.waitForTimeout(1500);
  await expect(historyRow).toHaveAttribute(
    "data-status-highlight-observed",
    "false",
  );
  const loadingObserved = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        let observed = Boolean(
          document.querySelector('.standalone[role="status"]'),
        );
        const observer = new MutationObserver(() => {
          if (document.querySelector('.standalone[role="status"]'))
            observed = true;
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        window.setTimeout(() => {
          observer.disconnect();
          resolve(observed);
        }, 700);
      }),
  );
  await dialog.getByRole("button", { name: "Chiudi", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toContainText("Annullato");
  expect(await loadingObserved).toBe(false);
});

test("new product identifies the missing required field", async ({ page }) => {
  await page.goto("/inventory");
  await page.getByRole("button", { name: "Nuovo prodotto" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Prodotto", { exact: true })
    .fill("Prodotto senza categoria");
  await dialog.getByLabel("Costo", { exact: true }).fill("1");
  await dialog.getByLabel("Prezzo", { exact: true }).fill("2");
  await dialog
    .getByRole("button", { name: "Salva prodotto", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Categoria");
});

test("test tools generate linked data and persist repair motion tuning", async ({
  page,
}) => {
  await page.goto("/settings/test-tools");
  const tools = page.locator(".test-tools-settings");
  await expect(
    tools.getByRole("heading", { name: "Strumenti di test" }),
  ).toBeVisible();
  await expect(tools).toContainText("ngt_test");
  expect(
    await tools.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);

  await page.goto("/orders?month=");
  const existingTestRows = page.locator(
    '.order-list-body tr:has(.order-customer-link[href*="TEST-"])',
  );
  let existingTestOrderCount = 0;
  while (true) {
    existingTestOrderCount += await existingTestRows.count();
    const pagination = page.getByRole("navigation", {
      name: "Paginazione delle schede",
    });
    const nextPage = pagination.getByRole("link", {
      name: "Successiva",
      exact: true,
    });
    if (!(await nextPage.count())) break;
    const currentPage = Number(
      new URL(page.url()).searchParams.get("page") || "1",
    );
    await nextPage.click();
    await expect(page).toHaveURL(
      (url) => Number(url.searchParams.get("page") || "1") === currentPage + 1,
    );
    await expect(pagination).toContainText(`Pagina ${currentPage + 1} di`);
  }
  await page.goto("/settings/test-tools");
  await expect(tools).toBeVisible();

  const lift = tools
    .locator(".test-motion-control")
    .filter({ hasText: "Altezza sollevamento" })
    .locator('input[type="range"]');
  const glide = tools
    .locator(".test-motion-control")
    .filter({ hasText: "Tempo di scorrimento" })
    .locator('input[type="range"]');
  const shadow = tools
    .locator(".test-motion-control")
    .filter({ hasText: "Intensità ombra" })
    .locator('input[type="range"]');
  await lift.fill("32");
  await glide.fill("680");
  await shadow.fill("58");
  await expect(lift).toHaveValue("32");
  await expect(glide).toHaveValue("680");
  await expect(shadow).toHaveValue("58");
  await page.reload();
  await expect(lift).toHaveValue("32");
  await expect(glide).toHaveValue("680");
  await expect(shadow).toHaveValue("58");

  await chooseBusinessOption(page, "Quantità dati di test", "50 schede", tools);
  await tools
    .getByRole("button", { name: "Genera dati di test", exact: true })
    .click();
  await expect(tools.locator(".message.success")).toContainText(
    "Creati 50 clienti, 10 prodotti, 20 preventivi, 50 schede, 4 servizi rapidi e 5 vendite di test.",
  );
  await tools
    .getByRole("button", {
      name: "Apri elenco schede di servizio",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/orders/);
  await page.goto("/orders?month=");
  const generatedRows = page.locator(
    '.order-list-body tr:has(.order-customer-link[href*="TEST-"])',
  );
  const codes: string[] = [];
  const rowTexts: string[] = [];
  const customerNames: string[] = [];
  while (true) {
    codes.push(
      ...(await generatedRows
        .locator(".order-code-link span")
        .allTextContents()),
    );
    rowTexts.push(...(await generatedRows.allTextContents()));
    customerNames.push(
      ...(await generatedRows
        .locator(".order-customer-link span")
        .allTextContents()),
    );
    const pagination = page.getByRole("navigation", {
      name: "Paginazione delle schede",
    });
    const nextPage = pagination.getByRole("link", {
      name: "Successiva",
      exact: true,
    });
    if (!(await nextPage.count())) break;
    const currentPage = Number(
      new URL(page.url()).searchParams.get("page") || "1",
    );
    await nextPage.click();
    await expect(page).toHaveURL(
      (url) => Number(url.searchParams.get("page") || "1") === currentPage + 1,
    );
    await expect(pagination).toContainText(`Pagina ${currentPage + 1} di`);
  }
  expect(codes).toHaveLength(existingTestOrderCount + 50);
  expect(codes.every((code) => /^[RS]-\d{11}$/.test(code.trim()))).toBe(true);
  expect(codes.some((code) => code.trim().startsWith("R-"))).toBe(true);
  expect(codes.some((code) => code.trim().startsWith("S-"))).toBe(true);
  expect(
    rowTexts.some(
      (text) => text.includes("Riparazione") && text.includes("Ricevuto"),
    ),
  ).toBe(false);
  expect(customerNames.every((name) => !name.includes("TEST"))).toBe(true);

  await page
    .getByPlaceholder(
      "Numero, cliente, telefono, dispositivo, IMEI o intervento",
      { exact: true },
    )
    .fill("Galaxy S24 Ultra");
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("q") === "Galaxy S24 Ultra",
  );
  const diagnosticRow = generatedRows
    .filter({ hasText: "Samsung Galaxy S24 Ultra" })
    .filter({ hasText: "In diagnosi" });
  await expect(diagnosticRow.first()).toBeVisible();
  await diagnosticRow.first().locator(".order-code-link").click();
  const status = page.locator(".detail-status .status-dropdown-trigger");
  await expect(status).toContainText("In diagnosi");
  await page.waitForLoadState("networkidle");
  const quote = page.getByTestId("quote-card");
  await quote.getByRole("button", { name: "Diagnosi e preventivo" }).click();
  await page
    .getByRole("button", {
      name: "Completa diagnosi e crea preventivo",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Completa diagnosi e crea preventivo",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".quote-item")).toHaveCount(0);
  await dialog.getByLabel("Non si accende", { exact: true }).check();
  await dialog
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-31");
  await chooseRepairProjects(page, ["sostituzione display"], dialog);
  const requiredPart = dialog.locator(".selected-part-summary");
  await expect(requiredPart).toContainText(
    "Display Dynamic AMOLED Galaxy S24 Ultra",
  );
  await expect(requiredPart).not.toContainText("iPhone 15 Pro Max");
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".message.error")).toHaveCount(0);
  await expect(status).toContainText("In riparazione");

  await page.goto("/prices");
  await page.getByLabel("Cerca", { exact: true }).fill("iPhone 15 Pro Max");
  await expect(page.locator(".price-rule-row")).toHaveCount(4);
  await expect(page.locator(".price-rule-row").first()).not.toContainText(
    "TEST",
  );

  await page.goto("/inventory");
  await page
    .getByLabel("Cerca prodotto, ricambio, marca o modello", { exact: true })
    .fill("Cover silicone MagSafe iPhone 15 Pro Max");
  const product = page.locator(".inventory-table tbody tr").first();
  await expect(product).toContainText(
    "Cover silicone MagSafe iPhone 15 Pro Max",
  );
  await expect(product).toContainText("7,50 €");
  await expect(product).toContainText("19,90 €");
});

test("Production Standalone serves pages and assets without E2E interception", async ({
  page,
}) => {
  await page.context().unroute("**/_next/static/**");
  await page.context().unroute("**/brand/**");

  const assetResponses: Promise<{
    url: string;
    status: number;
    contentType: string;
  }>[] = [];
  const failedAssets: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      !url.pathname.startsWith("/_next/static/") &&
      !url.pathname.startsWith("/brand/")
    )
      return;
    assetResponses.push(
      response.allHeaders().then((headers) => ({
        url: url.pathname,
        status: response.status(),
        contentType: headers["content-type"] ?? "",
      })),
    );
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/brand/")
    )
      failedAssets.push(`${url.pathname}: ${request.failure()?.errorText}`);
  });

  const visit = async (path: string) => {
    await page.goto(path);
    await expect(
      page.getByRole("img", { name: "NGT NEXT GEN TECH", exact: true }).first(),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "NGT NEXT GEN TECH", exact: true })
          .first()
          .evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    await page.waitForLoadState("networkidle");
  };

  await visit("/orders/new");
  await fillOrder(page);
  await save(page);
  const orderPath = new URL(page.url()).pathname;

  await visit("/prices");
  await expect(
    page.getByRole("button", { name: "Nuova regola", exact: true }).first(),
  ).toBeVisible();

  await visit(orderPath);
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toBeVisible();

  const assets = await Promise.all(assetResponses);
  expect(failedAssets).toEqual([]);
  expect(
    assets.some(
      (asset) =>
        asset.url.startsWith("/_next/static/") &&
        asset.url.endsWith(".css") &&
        asset.status === 200,
    ),
  ).toBe(true);
  expect(
    assets.some(
      (asset) =>
        asset.url.startsWith("/_next/static/") &&
        asset.url.endsWith(".js") &&
        asset.status === 200,
    ),
  ).toBe(true);
  expect(
    assets.some(
      (asset) =>
        asset.url === "/brand/ngt-logo-horizontal.svg" &&
        asset.status === 200 &&
        asset.contentType.includes("image/svg+xml"),
    ),
  ).toBe(true);
  expect(
    assets.every((asset) => asset.status === 200 || asset.status === 304),
  ).toBe(true);
});
