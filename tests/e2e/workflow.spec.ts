import { test, expect, type Locator, type Page } from "@playwright/test";

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
  const combobox = scope.getByRole("combobox", { name: label, exact: true });
  const simpleSelect = scope.getByRole("button", { name: label, exact: true });
  await expect(combobox.or(simpleSelect).first()).toBeVisible();
  if (await combobox.isVisible()) {
    await combobox.click();
    await combobox.fill(option);
  } else await simpleSelect.click();
  const panel = page.locator(".business-select-panel.is-entering");
  const exact = panel.getByRole("option", { name: option, exact: true });
  if (await exact.count()) await exact.click();
  else
    await panel.getByRole("option").filter({ hasText: option }).first().click();
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
    await page.waitForTimeout(250);
    await openStep(page, 2);
  }
  const addProject = scope
    .locator(".quick-service-service-add:visible")
    .first();
  await addProject.click();
  const dialog = page.getByRole("dialog", {
    name: "Seleziona interventi",
  });
  for (const name of names) {
    await dialog
      .locator(".quick-service-picker-option")
      .filter({ hasText: name })
      .click();
  }
  await dialog
    .getByRole("button", { name: "Conferma selezione", exact: true })
    .click();
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
    phone?: string;
    name?: string;
  } = {},
) {
  await page.goto("/orders/new");
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
  else await page.getByLabel("Display rotto", { exact: true }).check();
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
  } else if (!options.manual)
    await expect(
      page.getByRole("button", {
        name: "Modifica dati Preventivo attuale",
        exact: true,
      }),
    ).toContainText("100,00");
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
}
async function openPayment(page: Page) {
  const step = page.locator(".order-step-card").filter({ hasText: /^04/ });
  await step.locator(".order-step-heading").click();
}
async function openStep(page: Page, index: number) {
  const card = page.locator(".order-step-card").nth(index);
  if (
    (await card
      .locator(".order-step-heading")
      .getAttribute("aria-expanded")) !== "true"
  )
    await card.locator(".order-step-heading").click();
}
async function state(page: Page, next: string) {
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
  const cards = page.locator(".order-step-card");
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toHaveClass(/is-selected/);
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
  await cards.nth(3).locator(".order-step-heading").click();
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
});

test("inputs and expanding controls scroll only when interaction space is tight", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/orders/new");
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
  await picker
    .locator(".quick-service-picker-option")
    .filter({ hasText: "sostituzione display" })
    .click();
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
  ).toBeVisible();
  await page.goto("/reports");
  await expect(page).toHaveURL(/\?stats=1/);
  await expect(
    page.getByRole("dialog", { name: "Andamento", exact: true }),
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
    .filter({ hasText: "sostituzione display" })
    .first();
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: "Gestisci opzioni ricambio", exact: true })
    .click();
  const options = page.getByRole("dialog", {
    name: /sostituzione display · Opzioni ricambio/,
  });
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
  await expect(
    newOption.getByRole("button", { name: "Ricambio", exact: true }),
  ).toBeVisible();
  await newOption
    .getByRole("button", { name: "Ricambio", exact: true })
    .click();
  const newPart = page.getByRole("dialog", {
    name: /Nuovo ricambio/,
  });
  await expect(
    newPart.getByLabel("Nome ricambio", { exact: true }),
  ).toBeVisible();
  await newPart.getByRole("button", { name: "Annulla", exact: true }).click();
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
  await oledOption.click();
  await expect(oledOption).toHaveClass(/is-selected/);
  await expect(optionSummary).toContainText("Display LCD standard");
  await optionPicker
    .getByRole("button", { name: "Annulla", exact: true })
    .click();
  await expect(optionSummary).toContainText("Display LCD standard");
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
  await choosePriceOption(page, "Display LCD standard");
  await expect(quote).toContainText("105,00");
  await expect(page.getByText(/nuovo suggerito è 100,00/)).toBeVisible();
  await page
    .getByRole("button", { name: "Usa il nuovo suggerito", exact: true })
    .click();
  await expect(quote).toContainText("100,00");
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

test("switching repair and quick-service modes keeps both drafts", async ({
  page,
}) => {
  await fillOrder(page);
  const quickMode = page.getByRole("button", {
    name: "Servizio rapido",
    exact: true,
  });
  await quickMode.click();
  await chooseBusinessOption(page, "Cerca cliente", "Cliente Playwright");
  await page.getByLabel("Data", { exact: true }).fill("2099-12-30");
  await page.getByLabel("Ora", { exact: true }).fill("17:45");

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
  await expect(quickForm.getByLabel("Data", { exact: true })).toHaveValue(
    "2099-12-30",
  );
  await expect(quickForm.getByLabel("Ora", { exact: true })).toHaveValue(
    "17:45",
  );
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
  const expectedDate = page.getByLabel("Data", { exact: true });
  await expect(expectedDate).toHaveCSS("cursor", "pointer");
  const expectedDateBox = await expectedDate.boundingBox();
  await expectedDate.click({
    position: { x: 8, y: expectedDateBox!.height / 2 },
  });
  const quickCalendar = page.getByRole("dialog", { name: "Scegli data" });
  await expect(quickCalendar).toBeVisible();
  await expect(
    quickCalendar.locator(".date-picker-days [role=gridcell]"),
  ).toHaveCount(42);
  await page.keyboard.press("Escape");
  await expectedDate.fill("2099-12-31");
  await page.getByLabel("Ora", { exact: true }).fill("18:30");
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
  const statusBox = await page
    .locator(".detail-primary-actions .status-dropdown-trigger")
    .boundingBox();
  const moreBox = await page
    .locator(".detail-primary-actions .secondary-actions summary")
    .boundingBox();
  expect(Math.abs(statusBox!.y - moreBox!.y)).toBeLessThan(1);
  expect(Math.abs(statusBox!.height - moreBox!.height)).toBeLessThan(1);
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

test("business statistics keeps the open balance summary without the unpaid list", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".dashboard-action-link").first().click();

  const statsDialog = page.getByRole("dialog", {
    name: "Andamento",
    exact: true,
  });
  await expect(statsDialog).toBeVisible();
  await expect(statsDialog.getByText("Totale da incassare")).toBeVisible();
  await expect(statsDialog.locator(".order-table")).toHaveCount(0);
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

test("settings opens system update as a separate page", async ({ page }) => {
  await page.goto("/settings");
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
  await page.goto("/");
  const dashboard = page.getByTestId("dashboard-motion");
  await expect(dashboard).toBeVisible();
  await expect(dashboard).toHaveClass(/dashboard-animating/);
  await expect(dashboard).not.toHaveClass(/dashboard-animating/, {
    timeout: 2000,
  });
  await expect(page.locator(".dashboard-kpis .metric")).toHaveCount(7);
  await expect(page.locator(".payment-method-row")).toHaveCount(3);
  const dashboardActions = page.locator(".dashboard-action-link");
  await expect(dashboardActions).toHaveCount(4);
  await expect(dashboardActions.locator("svg")).toHaveCount(4);
  await expect(dashboardActions.locator("svg").first()).toHaveAttribute(
    "width",
    "15",
  );
  expect(
    await dashboardActions.evaluateAll((links) =>
      links.map((link) => getComputedStyle(link).textDecorationLine),
    ),
  ).toEqual(["none", "none", "none", "none"]);
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
  await firstDashboardAction.click();
  const statsDialog = page.getByRole("dialog", {
    name: "Andamento",
    exact: true,
  });
  await expect(statsDialog).toBeVisible();
  await expect(statsDialog.getByText("Incassi del giorno")).toBeVisible();
  await statsDialog
    .getByRole("button", { name: "Chiudi", exact: true })
    .click();
  await expect(statsDialog).toHaveCount(0);
  await expect(page.locator(".attention-card")).toHaveCSS(
    "border-color",
    "rgb(239, 210, 124)",
  );

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
  await expect(page.locator(".dashboard-date-filter > span").nth(1)).toHaveCSS(
    "white-space",
    "nowrap",
  );
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
  const motionSwitch = page.getByRole("switch", {
    name: "Riproduci sempre le animazioni",
  });
  await expect(motionSwitch).toHaveAttribute("aria-checked", "false");

  await motionSwitch.click();
  await expect(motionSwitch).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "always");

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

test("filters inventory by compatible device and exposes compatibility", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/inventory");
  const inventoryMain = page.locator(".inventory-main");
  const search = inventoryMain.getByLabel(
    "Cerca prodotto, ricambio, marca o modello",
  );
  const battery = inventoryMain.getByRole("row", { name: /Batteria Test/ });
  const cable = inventoryMain.getByRole("row", { name: /Cavo USB-C Test/ });
  const tableScroll = inventoryMain.locator(".inventory-table-scroll");
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
  await page.getByRole("button", { name: "Vendite", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox?.width).toBeGreaterThan(800);
  expect(dialogBox?.height).toBeGreaterThan(600);
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
  await period.fill("2025-01");
  await expect(dialog).toContainText("Nessuna vendita registrata.");
  await period.fill(new Date().toISOString().slice(0, 7));
  const historyRow = dialog.locator("tbody tr").first();
  await historyRow.hover();
  await historyRow.getByRole("button", { name: /Elimina vendita V-/ }).click();
  const deleteDialog = page.getByRole("dialog", {
    name: "Elimina vendita",
  });
  await expect(deleteDialog).toBeVisible();
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
  await openStep(page, 2);
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
  await expect(serviceSwitch).toHaveCSS("width", "32px");
  await expect(serviceSwitch).toHaveCSS("height", "18px");
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
  const serviceActions = serviceEditor.locator(".dialog-actions");
  expect(
    await serviceActions.evaluate((actions) => {
      const dialogBox = actions.closest("dialog")!.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      return dialogBox.right - actionsBox.right;
    }),
  ).toBeLessThanOrEqual(32);
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
test("zero balance delivery uses the lightweight confirmation dialog", async ({
  page,
}) => {
  await fillOrder(page);
  await openPayment(page);
  await page
    .getByLabel("Incasso alla creazione (€)", { exact: true })
    .fill("100");
  await save(page);
  await state(page, "READY");
  await page.locator(".detail-status .status-dropdown-trigger").click();
  await page.getByRole("option", { name: "Consegnato", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Conferma consegna" });
  await expect(dialog.getByLabel("Importo (€)", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByLabel("Nome di chi ritira", { exact: true }),
  ).toHaveValue("Cliente Playwright");
  await dialog.getByRole("button", { name: "Conferma consegna" }).click();
  await expect(
    page.locator(".detail-status .status-dropdown-trigger"),
  ).toHaveText(/Consegnato/);
});

test("detail edits save on outside click and protect navigation", async ({
  page,
}) => {
  await fillOrder(page);
  await save(page);
  const orderPath = new URL(page.url()).pathname;
  const details = page.getByTestId("details-card");
  await details.locator(".order-card-heading").click();
  await details
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
  await details
    .getByLabel("Consegna prevista", { exact: true })
    .fill("2099-12-30");

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
  await warranty.hover();
  await warranty
    .getByRole("button", { name: "Modifica dati", exact: true })
    .click();
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
  await expect(
    dialog.getByRole("button", { name: "Opzioni ricambio", exact: true }),
  ).toBeVisible();
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
  await expect(
    dialog.getByRole("button", { name: "Opzioni ricambio", exact: true }),
  ).toBeVisible();
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
  const emptyReworkPart = warranty.getByRole("button", {
    name: "Opzioni ricambio",
    exact: true,
  });
  await expect(emptyReworkPart).toBeVisible();
  await emptyReworkPart.click();
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
  await expect(emptyReworkPart).toBeVisible();
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
  await enterBusinessValue(page, "Intervento", `pulizia ${Date.now()}`, form);
  await form.getByLabel("Prezzo suggerito (€)", { exact: true }).fill("15");
  await chooseBusinessOption(page, "Ricambio richiesto", "Batteria Test", form);
  const requiredQuantity = form.getByRole("spinbutton", {
    name: "Quantità",
    exact: true,
  });
  await requiredQuantity.fill("");
  await expect(requiredQuantity).toHaveValue("");
  await requiredQuantity.fill("12");
  await requiredQuantity.press("Tab");
  await expect(requiredQuantity).toHaveValue("12");
  await form.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(page.getByRole("main").getByRole("status")).toBeVisible();
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
  const phone = "336" + Date.now().toString().slice(-7);
  await page.goto("/orders/new");
  await page
    .getByRole("combobox", { name: "Cerca cliente", exact: true })
    .fill(phone);
  await page
    .getByRole("button", { name: "Nuovo cliente", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Nuovo cliente" });
  await dialog.getByLabel(/Nome e cognome/).fill("Tre telefoni");
  await dialog.getByLabel(/Telefono/).fill(phone);
  await dialog
    .getByRole("button", { name: "Salva cliente", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".selected-customer-summary")).toContainText(
    "Tre telefoni",
  );
  await expect(page.locator(".selected-customer-summary")).toContainText(
    "+39" + phone,
  );
  await expect(
    page.locator(".order-step-card").nth(1).locator(".order-step-heading"),
  ).toHaveAttribute("aria-expanded", "true");
  await openStep(page, 0);
  const customerSummary = page.locator(".selected-customer-summary");
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
  await openStep(page, 1);
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
  await openStep(page, 2);
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
  await projectPicker
    .locator(".quick-service-picker-option")
    .filter({ hasText: "sostituzione display" })
    .click();
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

test("creates a repair part from the quote and selects it immediately", async ({
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

  const addPart = page.getByRole("button", {
    name: "Ricambio",
    exact: true,
  });
  await expect(addPart).toBeVisible();
  await expect(page.locator(".selected-part-summary")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", {
      name: "Ricambio richiesto 1",
      exact: true,
    }),
  ).toHaveCount(0);
  await addPart.click();
  const partSearch = page.getByRole("combobox", {
    name: "Ricambio richiesto 1",
    exact: true,
  });
  const newPart = page.getByRole("button", { name: "Nuovo ricambio" });
  await expect(newPart).toHaveCount(0);
  await partSearch.fill("Batteria");
  await expect(newPart).toHaveCount(0);
  const productName = `Ricambio E2E ${Date.now()}`;
  await partSearch.fill(productName);
  await expect(newPart).toBeEnabled();
  await newPart.click();
  const dialog = page.getByRole("dialog", {
    name: "Nuovo ricambio per riparazione",
  });
  await expect(dialog.getByLabel("Nome ricambio", { exact: true })).toHaveValue(
    productName,
  );
  await expect(dialog.getByRole("button", { name: "Categoria" })).toHaveCount(
    0,
  );
  await expect(dialog.getByRole("button", { name: "Utilizzo" })).toHaveCount(0);
  await expect(dialog.getByLabel("Costo (€)", { exact: true })).toBeFocused();
  await expect(dialog).toContainText(
    "Utilizzo: Apple · iPhone 13 · sostituzione display",
  );
  await expect(dialog.locator(".product-compatibility-editor")).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Marca" })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Modello" })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("combobox", { name: /Intervento/ }),
  ).toHaveCount(0);
  const formGrid = dialog.locator(".form-grid");
  await expect(formGrid.locator(":scope > *")).toHaveCount(4);
  expect(
    await formGrid.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length,
    ),
  ).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await formGrid.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length,
    ),
  ).toBe(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByLabel("Costo (€)", { exact: true }).fill("12");
  await dialog.getByLabel("Scorta iniziale", { exact: true }).fill("0");
  await dialog.getByLabel("Scorta minima", { exact: true }).fill("1");
  await dialog
    .getByLabel("Imposta come ricambio frequente", { exact: true })
    .check();
  await dialog.getByRole("button", { name: "Crea e seleziona" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".selected-part-summary")).toContainText(
    productName,
  );
  await expect(
    page.getByText(
      "Il ricambio selezionato non è sufficiente: dopo la creazione la scheda passerà automaticamente a «Ricambio mancante».",
      { exact: true },
    ),
  ).toBeVisible();

  await page.goto("/inventory");
  const inventorySearch = page.getByLabel(
    "Cerca prodotto, ricambio, marca o modello",
    { exact: true },
  );
  await inventorySearch.fill(productName);
  const createdPart = page.getByRole("row", { name: new RegExp(productName) });
  await expect(createdPart).toContainText("Apple / Telefono / iPhone 13");
  await createdPart.click();
  await createdPart
    .getByRole("button", { name: "Modifica dispositivi compatibili" })
    .click();
  const compatibilityDialog = page.getByRole("dialog", {
    name: "Modifica dispositivi compatibili",
  });
  const compatibilityRow = compatibilityDialog.locator(
    ".compatibility-device-row",
  );
  await expect(compatibilityRow).toContainText("iPhone 13");
  await expect(compatibilityRow).toContainText("sostituzione display");
  await expect(compatibilityRow).not.toContainText("Apple");
  await expect(
    compatibilityDialog.locator(".compatibility-list-heading small"),
  ).toHaveCount(0);
  await expect(
    compatibilityDialog.getByRole("combobox", { name: "Marca" }),
  ).toHaveCount(0);
  const removeCompatibility = compatibilityRow.getByRole("button", {
    name: "Rimuovi Apple iPhone 13",
    exact: true,
  });
  await expect(removeCompatibility).toHaveCSS("opacity", "0");
  await compatibilityRow.hover();
  await expect(compatibilityRow).toHaveCSS(
    "background-color",
    "rgb(255, 249, 232)",
  );
  await expect(removeCompatibility).toHaveCSS("opacity", "1");
  await removeCompatibility.click();
  await expect(
    compatibilityDialog.locator(".compatibility-device-row"),
  ).toHaveCount(0);
  await compatibilityDialog
    .getByRole("button", { name: "Salva", exact: true })
    .click();
  await expect(compatibilityDialog).toHaveCount(0);
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
  const compatibilityAdd = dialog.getByRole("button", {
    name: "Compatibilità",
    exact: true,
  });
  await expect(dialog.locator(".compatibility-product-summary")).toContainText(
    "Batteria Test",
  );
  await expect(dialog.locator(".compatibility-device-list")).toBeVisible();
  await compatibilityAdd.click();
  const editorDialog = page.getByRole("dialog", {
    name: "Aggiungi dispositivo compatibile",
  });
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
  const projects = editorDialog.getByRole("combobox", {
    name: "Intervento",
    exact: true,
  });
  await expect(projects).toBeEnabled();
  const openProjects = editorDialog.locator(
    ".compatibility-project-selector .business-combobox-chevron",
  );
  await openProjects.click();
  await page
    .locator(".business-select-panel.is-entering")
    .getByRole("option", { name: "sostituzione batteria", exact: true })
    .click();
  await openProjects.click();
  await page
    .locator(".business-select-panel.is-entering")
    .getByRole("option", { name: "sostituzione display", exact: true })
    .click();
  await expect(editorDialog.locator(".compatibility-project-chip")).toHaveText([
    "sostituzione batteria",
    "sostituzione display",
  ]);
  await editorDialog.getByRole("button", { name: "Conferma" }).click();
  const summary = dialog.locator(".compatibility-device-row", {
    hasText: "iPhone 14",
  });
  await expect(summary).toContainText("sostituzione batteria");
  await expect(summary).toContainText("sostituzione display");
});

test("changing a selected repair part focuses its current name and preserves it on cancel", async ({
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
  await chooseRequiredPart(page, "Batteria Test");
  const summary = page.locator(".selected-part-summary");
  await expect(summary).toContainText("Batteria Test");
  const projectSummary = page.locator(".selected-project-summary");
  expect(
    await projectSummary.or(summary).evaluateAll((elements) => {
      const [project, part] = elements;
      return Math.abs(
        project.getBoundingClientRect().width -
          part.getBoundingClientRect().width,
      );
    }),
  ).toBeLessThanOrEqual(1);
  expect(
    await summary.evaluate((part) => {
      const label = part.parentElement?.querySelector(
        ".quote-required-part-label",
      );
      return label
        ? part.getBoundingClientRect().top -
            label.getBoundingClientRect().bottom
        : 0;
    }),
  ).toBeGreaterThanOrEqual(12);
  expect(
    await page.locator(".quote-required-part-label").evaluate((label) => {
      const project = label
        .closest(".quote-item")
        ?.querySelector(".selected-project-summary");
      return project
        ? label.getBoundingClientRect().top -
            project.getBoundingClientRect().bottom
        : 0;
    }),
  ).toBeGreaterThanOrEqual(18);
  expect(
    await summary.locator(".selection-summary-icon").evaluate((icon) => {
      const iconBox = icon.getBoundingClientRect();
      const svgBox = icon.querySelector("svg")!.getBoundingClientRect();
      return Math.abs(
        iconBox.left + iconBox.width / 2 - (svgBox.left + svgBox.width / 2),
      );
    }),
  ).toBeLessThanOrEqual(1);
  const removePart = summary.getByRole("button", {
    name: "Rimuovi Batteria Test",
    exact: true,
  });
  await page.mouse.move(0, 0);
  await expect(removePart).toHaveCSS("opacity", "0");
  await summary.hover();
  await expect(removePart).toHaveCSS("opacity", "1");
  await expect(summary.locator(".summary-action svg")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 4, 0)",
  );
  await summary.locator(".selection-summary-copy").click();
  const search = page.getByRole("combobox", {
    name: "Ricambio richiesto 1",
    exact: true,
  });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Batteria Test");
  expect(
    await search.evaluate(
      (input) =>
        (input as HTMLInputElement).selectionStart === 0 &&
        (input as HTMLInputElement).selectionEnd ===
          (input as HTMLInputElement).value.length,
    ),
  ).toBe(true);
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await search.press("Escape");
  await expect(summary).toContainText("Batteria Test");
  await summary.locator(".summary-action").click();
  await search.fill("");
  await expect(search).toBeVisible();
  await search.press("Escape");
  await expect(summary).toContainText("Batteria Test");
  await summary.locator(".summary-action").click();
  await search.fill("");
  await expect(search).toBeVisible();
  await expect(search).toHaveValue("");
  await page.locator(".quote-required-part-label").click();
  await expect(search).toHaveCount(0);
  await expect(summary).toContainText("Nessuno");
  await chooseRequiredPart(page, "Batteria Test");
  await summary.locator(".summary-action").click();
  await search.fill("");
  await expect(search).toHaveValue("");
  await search.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(summary).toContainText("Nessuno");
  await chooseRequiredPart(page, "Batteria Test");
  await summary.locator(".summary-action").click();
  await expect(search).toBeFocused();
  await search.fill(`Ricambio stile ${Date.now()}`);
  const newPart = page.getByRole("button", {
    name: "Nuovo ricambio",
    exact: true,
  });
  await expect(newPart).toBeEnabled();
  await expect(newPart).toHaveCSS("font-weight", "650");
  expect(
    await newPart.evaluate(
      (button) => button.scrollWidth <= button.clientWidth + 1,
    ),
  ).toBe(true);
  await expect(newPart.locator("span")).toHaveCSS("text-overflow", "clip");
  await search.press("Escape");
  await summary.hover();
  await removePart.click();
  await expect(summary).toContainText("Nessuno");
  await expect(removePart).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Ricambio", exact: true }),
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
  await picker
    .locator(".quick-service-picker-option")
    .filter({ hasText: "sostituzione display" })
    .click();
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
  await expect(
    editDialog.getByRole("combobox", {
      name: "Ricambio richiesto",
      exact: true,
    }),
  ).toHaveValue("Batteria Test");
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
  await page
    .getByLabel("Nome e cognome", { exact: true })
    .fill("Cliente modificato");
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
  await page
    .getByRole("dialog", { name: "Eliminare il cliente?", exact: true })
    .getByRole("button", { name: "Elimina cliente", exact: true })
    .click();
  await expect(page).toHaveURL(/customers$/);
  await expect(
    page.getByRole("link", { name: "Cliente modificato", exact: true }),
  ).toHaveCount(0);
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
  await dialog.getByLabel("Prezzo suggerito (€)", { exact: true }).fill("bad");
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Modello", exact: true }),
  ).toHaveValue("Watch Modal");
  await dialog.getByLabel("Prezzo suggerito (€)", { exact: true }).fill("40");
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/prices$/);
  const model = page
    .locator("section.price-tree-level")
    .filter({ has: page.locator(".price-toggle", { hasText: "Watch Modal" }) })
    .last();
  await expect(model.locator("article")).toBeVisible();
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
  await dialog.getByLabel("Prezzo suggerito (€)", { exact: true }).fill("70");
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).not.toBeVisible();
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
  await expect(addProject).toHaveCSS("background-color", "rgb(255, 245, 201)");
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
    .getByRole("button", { name: "Salva", exact: true })
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
  await expect(batchButton).toHaveCSS("background-color", "rgb(255, 245, 201)");
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

test("quote repair part waits for commit and supports creating a new part", async ({
  page,
}) => {
  await page.goto("/prices");
  await page.getByLabel("Cerca", { exact: true }).fill("iPhone 14");
  const row = page
    .locator(".price-rule-row")
    .filter({ hasText: "sostituzione batteria" });
  await row.hover();
  await row
    .getByRole("button", { name: "Modifica preventivo", exact: true })
    .click();

  let editDialog = page.getByRole("dialog", {
    name: "Modifica preventivo",
    exact: true,
  });
  let partSearch = editDialog.getByRole("combobox", {
    name: "Ricambio richiesto",
    exact: true,
  });
  await expect(partSearch).toHaveValue("Batteria Test");
  await partSearch.fill("");
  await expect(partSearch).toHaveValue("");
  await expect(
    editDialog.getByLabel("Quantità", { exact: true }),
  ).toBeVisible();

  await editDialog.locator('input[name="notes"]').click();
  await expect(partSearch).toHaveValue("Nessun ricambio richiesto");
  await expect(editDialog.getByLabel("Quantità", { exact: true })).toHaveCount(
    0,
  );

  const productName = `Ricambio preventivo ${Date.now()}`;
  await partSearch.fill(productName);
  const newPart = editDialog.getByRole("button", {
    name: "Nuovo ricambio per riparazione",
    exact: true,
  });
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
    editDialog.getByLabel("Quantità", { exact: true }),
  ).toBeVisible();

  await partSearch.fill("");
  await editDialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(editDialog).toHaveCount(0);

  await row.hover();
  await row
    .getByRole("button", { name: "Modifica preventivo", exact: true })
    .click();
  editDialog = page.getByRole("dialog", {
    name: "Modifica preventivo",
    exact: true,
  });
  partSearch = editDialog.getByRole("combobox", {
    name: "Ricambio richiesto",
    exact: true,
  });
  await expect(partSearch).toHaveValue("Nessun ricambio richiesto");
  await expect(editDialog.getByLabel("Quantità", { exact: true })).toHaveCount(
    0,
  );
});

test("price editor keeps deletion inside batch management", async ({
  page,
}) => {
  await page.goto("/prices");
  await page.getByRole("button", { name: "Apple", exact: true }).click();
  await page.getByRole("button", { name: "Telefono", exact: true }).click();
  await page.getByRole("button", { name: "iPhone 13", exact: true }).click();
  await page
    .getByRole("button", { name: "Intervento", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog");
  await enterBusinessValue(page, "Intervento", "Da eliminare", dialog);
  await dialog.getByLabel("Prezzo suggerito (€)", { exact: true }).fill("25");
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
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
    for (const [path, name] of [
      ["/customers", "Nuovo cliente"],
      ["/prices", "Nuova regola"],
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
      const cancel = dialog.getByRole("button", {
        name: "Annulla",
        exact: true,
      });
      const saveButton = dialog.getByRole("button", {
        name: "Salva",
        exact: true,
      });
      await saveButton.scrollIntoViewIfNeeded();
      const cancelBox = await cancel.boundingBox();
      const saveBox = await saveButton.boundingBox();
      const footer = await dialog.locator(".dialog-actions").boundingBox();
      const lastInput = await dialog.locator("input").last().boundingBox();
      expect(cancelBox!.x + cancelBox!.width).toBeLessThan(saveBox!.x);
      expect(Math.abs(cancelBox!.y - saveBox!.y)).toBeLessThan(2);
      expect(
        Math.abs(saveBox!.x + saveBox!.width - footer!.x - footer!.width),
      ).toBeLessThan(2);
      expect(saveBox!.y).toBeGreaterThan(lastInput!.y + lastInput!.height);
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
  await expect(detailDialog.locator(".customer-detail-dialog")).toBeVisible();
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
  await chooseBusinessOption(page, "Marca", "Apple", dialog);
  await chooseBusinessOption(page, "Modello", "iPhone 13", dialog);
  await dialog.getByLabel("IMEI (facoltativo)", { exact: true }).fill(suffix);
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
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
