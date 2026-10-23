import { requireActor } from "@/lib/session";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  saveCustomer,
  deleteCustomer,
  deleteCustomers,
  saveDevice,
  createDevice,
  deleteDevice,
  deletePriceRules,
  hideFault,
  restoreFault,
  saveFault,
  deleteFault,
  reorderFaults,
  addPayment,
  addWorkOrderProduct,
  checkoutWorkOrder,
  changeStatus,
  createProduct,
  createRetailSale,
  deleteRetailSale,
  adjustInventory,
  updateProduct,
  deleteProducts,
  completeInspection,
  createOrder,
  createUser,
  orderInclude,
  replaceQuote,
  savePriceRule,
  savePriceRuleOption,
  deletePriceRuleOption,
  setPaidTotal,
  removeWorkOrderProduct,
  setUserEnabled,
  updateOrder,
  updateDueDate,
  updateWarranty,
  updateBusinessClock,
  openAfterSales,
  refundOrder,
  deleteInventoryCategory,
  deleteDeviceCatalogOption,
  createQuickServiceOrder,
  updateQuickServiceOrder,
  deleteQuickService,
  deleteWorkOrder,
  renameDeviceModel,
  saveQuickService,
} from "@/lib/service";
import { balance, type Actor } from "@/lib/domain";
import { priceRuleViews } from "@/lib/price-rule-view";
import {
  clearBusinessData,
  exportBusinessData,
  importBusinessData,
} from "@/lib/data-transfer";
let owner: Actor;
let staff: Actor;
const testBusinessDay = "2026-10-01";
function input(patch: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    customerName: "Test Cliente",
    phone: "333 123 4567",
    privacyConsent: true,
    brand: "Apple",
    series: "iPhone",
    model: "iPhone 13",
    fault: "Display rotto",
    dueDate: testBusinessDay,
    items: [{ project: "Display", final: "100", adjustmentReason: "" }],
    deposit: "20",
    method: "CASH",
    ...patch,
  };
}
async function configureRepairOption(
  name: string,
  quantity = 1,
  suggested = "79",
) {
  const product = await createProduct(owner, {
    requestId: randomUUID(),
    name,
    category: "Ricambi",
    usage: "REPAIR",
    costPrice: "32",
    salePrice: "0",
    initialStock: 5,
    minStock: 0,
  });
  const rule = await db.priceRule.findFirstOrThrow({
    where: { project: "display" },
  });
  await savePriceRule(owner, rule.id, {
    category: rule.category,
    brand: rule.brand,
    series: rule.series,
    model: rule.model,
    project: rule.project,
    suggested,
    cost: "32",
    minutes: 60,
    enabled: true,
    notes: "",
    requiredProductId: product.id,
    requiredQuantity: quantity,
  });
  const option = await db.priceRuleOption.findUniqueOrThrow({
    where: { ruleId_productId: { ruleId: rule.id, productId: product.id } },
  });
  return { product, rule, option };
}
beforeAll(async () => {
  if (!new URL(process.env.DATABASE_URL || "").pathname.endsWith("_test"))
    throw new Error("Integration tests require an isolated *_test database.");
  await db.businessClock.deleteMany();
  await db.auditLog.deleteMany();
  await db.paymentAllocation.deleteMany();
  await db.payment.deleteMany();
  await db.retailServiceItem.deleteMany();
  await db.retailSaleItem.deleteMany();
  await db.retailSale.deleteMany();
  await db.inventoryMovement.deleteMany();
  await db.workOrderProduct.deleteMany();
  await db.reworkItem.deleteMany();
  await db.reworkSession.deleteMany();
  await db.workOrderItem.deleteMany();
  await db.priceRuleOption.deleteMany();
  await db.product.deleteMany();
  await db.inventoryCategory.deleteMany();
  await db.statusHistory.deleteMany();
  await db.workOrderDevice.deleteMany();
  await db.workOrder.deleteMany();
  await db.device.deleteMany();
  await db.customer.deleteMany();
  await db.priceRule.deleteMany();
  await db.quickService.deleteMany();
  await db.faultOption.deleteMany();
  await db.user.deleteMany();
  owner = await db.user.create({
    data: {
      name: "Titolare",
      email: "owner@test.it",
      passwordHash: "test-only",
      role: "OWNER",
    },
  });
  staff = await db.user.create({
    data: {
      name: "Tecnico",
      email: "staff@test.it",
      passwordHash: "test-only",
      role: "STAFF",
    },
  });
});
beforeEach(async () => {
  await db.businessClock.deleteMany();
  await db.businessClock.create({
    data: {
      id: "default",
      mode: "MANUAL",
      manualDate: testBusinessDay,
    },
  });
  await db.auditLog.deleteMany();
  await db.paymentAllocation.deleteMany();
  await db.payment.deleteMany();
  await db.retailServiceItem.deleteMany();
  await db.retailSaleItem.deleteMany();
  await db.retailSale.deleteMany();
  await db.inventoryMovement.deleteMany();
  await db.workOrderProduct.deleteMany();
  await db.reworkItem.deleteMany();
  await db.reworkSession.deleteMany();
  await db.workOrderItem.deleteMany();
  await db.priceRuleOption.deleteMany();
  await db.product.deleteMany();
  await db.inventoryCategory.deleteMany();
  await db.deviceCatalogDeletion.deleteMany();
  await db.statusHistory.deleteMany();
  await db.workOrderDevice.deleteMany();
  await db.workOrder.deleteMany();
  await db.device.deleteMany();
  await db.customer.deleteMany();
  await db.priceRule.deleteMany();
  await db.quickService.deleteMany();
  await db.faultOption.deleteMany();
  await db.user.updateMany({ data: { enabled: true } });
  await savePriceRule(owner, null, {
    brand: "Apple",
    model: "iPhone 13",
    project: "Display",
    suggested: "100",
    minutes: 60,
    enabled: true,
  });
});
afterEach(() => db.businessClock.deleteMany());
afterAll(() => db.$disconnect());
describe("PostgreSQL workflow", () => {
  it("keeps part-specific standard prices separate from work-order price snapshots", async () => {
    const lcd = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Display LCD standard",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "32",
      salePrice: "0",
      initialStock: 4,
      minStock: 0,
    });
    const oled = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Display OLED alta qualità",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "65",
      salePrice: "0",
      initialStock: 3,
      minStock: 0,
    });
    const rule = await db.priceRule.findFirstOrThrow({
      where: { project: "display" },
    });
    await savePriceRule(owner, rule.id, {
      category: rule.category,
      brand: rule.brand,
      series: rule.series,
      model: rule.model,
      project: rule.project,
      suggested: "79",
      cost: "32",
      minutes: 60,
      enabled: true,
      notes: "",
      requiredProductId: lcd.id,
      requiredQuantity: 1,
    });
    const lcdOption = await db.priceRuleOption.findUniqueOrThrow({
      where: {
        ruleId_productId: { ruleId: rule.id, productId: lcd.id },
      },
    });
    await db.priceRuleOption.update({
      where: { id: lcdOption.id },
      data: { warrantyDays: 90 },
    });
    const oledOption = await savePriceRuleOption(owner, rule.id, null, {
      productId: oled.id,
      name: oled.name,
      suggested: "119",
      cost: "65",
      quantity: 1,
      minutes: 75,
      warrantyDays: 180,
      enabled: true,
      isDefault: true,
      notes: "",
    });
    expect(
      await db.productCompatibility.count({
        where: {
          category: "PHONE",
          brand: "Apple",
          model: "iPhone 13",
          project: "display",
        },
      }),
    ).toBe(2);
    expect(
      await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } }),
    ).toMatchObject({
      requiredProductId: oled.id,
      requiredQuantity: 1,
    });

    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [
          {
            project: "Display",
            priceOptionId: lcdOption.id,
            final: "79",
            adjustmentReason: "",
          },
        ],
      }),
    );
    let item = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(item).toMatchObject({
      priceOptionId: lcdOption.id,
      priceOptionName: lcd.name,
      requiredProductId: lcd.id,
      requiredProductName: lcd.name,
      warrantyDays: 90,
    });
    expect(item.suggested?.toString()).toBe("79");
    expect(
      await db.workOrderProduct.findFirstOrThrow({
        where: {
          orderId: order.id,
          kind: "REPAIR_PART",
          productId: lcd.id,
        },
      }),
    ).toMatchObject({ quantity: 1, consumedAt: null });

    await replaceQuote(owner, order.id, {
      items: [
        {
          project: "Display",
          priceOptionId: lcdOption.id,
          final: "85",
          adjustmentReason: "Eccezione cliente",
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });
    item = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(item.final.toString()).toBe("85");
    expect(item.suggested?.toString()).toBe("79");
    expect(
      (
        await db.priceRuleOption.findUniqueOrThrow({
          where: { id: lcdOption.id },
        })
      ).suggested.toString(),
    ).toBe("79");
    const baseRule = await db.priceRule.findUniqueOrThrow({
      where: { id: rule.id },
    });
    expect(baseRule).toMatchObject({
      requiredProductId: oled.id,
      requiredQuantity: 1,
      minutes: 60,
    });
    expect(baseRule.suggested.toString()).toBe("79");
    expect(baseRule.cost?.toString()).toBe("32");

    await deletePriceRuleOption(owner, rule.id, lcdOption.id);
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: lcdOption.id },
      }),
    ).toMatchObject({ enabled: false, isDefault: false });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: oledOption.id },
      }),
    ).toMatchObject({ enabled: true, isDefault: true });

    await savePriceRule(owner, rule.id, {
      category: rule.category,
      brand: rule.brand,
      series: rule.series,
      model: rule.model,
      project: rule.project,
      suggested: "84",
      cost: "32",
      minutes: 60,
      enabled: true,
      notes: "",
      requiredProductId: oled.id,
      requiredQuantity: 1,
    });
    expect(
      (
        await db.priceRuleOption.findUniqueOrThrow({
          where: { id: oledOption.id },
        })
      ).suggested.toString(),
    ).toBe("119");
    expect(
      (
        await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } })
      ).suggested.toString(),
    ).toBe("84");
  });

  it("preserves referenced part-option history and requires a new option for another product", async () => {
    const { product, rule, option } = await configureRepairOption(
      "Referenced price option A",
      2,
      "79",
    );
    const replacement = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Referenced price option B",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "44",
      salePrice: "0",
      initialStock: 4,
      minStock: 0,
    });
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [
          {
            project: "Display",
            final: "85",
            adjustmentReason: "Eccezione cliente",
            priceOptionId: option.id,
          },
        ],
      }),
    );
    const oldItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    const reservationBefore = await db.workOrderProduct.findFirstOrThrow({
      where: {
        orderId: order.id,
        productId: product.id,
        kind: "REPAIR_PART",
        consumedAt: null,
      },
    });

    await expect(
      savePriceRuleOption(owner, rule.id, option.id, {
        productId: replacement.id,
        name: replacement.name,
        suggested: "119",
        cost: "44",
        quantity: 1,
        minutes: 75,
        warrantyDays: 90,
        enabled: true,
        isDefault: true,
        notes: "",
      }),
    ).rejects.toThrow("Crea una nuova opzione.");

    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: option.id },
      }),
    ).toMatchObject({
      productId: product.id,
      name: product.name,
      isDefault: true,
    });
    expect(
      await db.workOrderItem.findUniqueOrThrow({ where: { id: oldItem.id } }),
    ).toMatchObject({
      priceOptionId: option.id,
      priceOptionName: product.name,
      requiredProductId: product.id,
      requiredProductName: product.name,
      requiredQuantity: 2,
    });
    expect(oldItem.final.toString()).toBe("85");
    expect(
      await db.workOrderProduct.findUniqueOrThrow({
        where: { id: reservationBefore.id },
      }),
    ).toMatchObject({ productId: product.id, quantity: 2, consumedAt: null });

    const newOption = await savePriceRuleOption(owner, rule.id, null, {
      productId: replacement.id,
      name: replacement.name,
      suggested: "119",
      cost: "44",
      quantity: 1,
      minutes: 75,
      warrantyDays: 90,
      enabled: true,
      isDefault: false,
      notes: "",
    });
    expect(newOption).toMatchObject({
      productId: replacement.id,
      isDefault: false,
    });
    await savePriceRuleOption(owner, rule.id, option.id, {
      productId: product.id,
      name: "Updated option A",
      suggested: "84",
      cost: "34",
      quantity: 2,
      minutes: 70,
      warrantyDays: 120,
      enabled: true,
      isDefault: true,
      notes: "Updated metadata",
    });
    const preservedItem = await db.workOrderItem.findUniqueOrThrow({
      where: { id: oldItem.id },
    });
    expect(preservedItem).toMatchObject({
      priceOptionId: option.id,
      priceOptionName: product.name,
      requiredProductId: product.id,
      requiredProductName: product.name,
    });
    expect(preservedItem.suggested?.toString()).toBe("79");
    expect(preservedItem.final.toString()).toBe("85");
  });

  it("keeps the default option stable during compatibility edits and falls back when its product is retired", async () => {
    const {
      product: lcd,
      rule,
      option: lcdOption,
    } = await configureRepairOption("Compatibility default LCD", 1, "100");
    const oled = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Compatibility non-default OLED",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "65",
      salePrice: "0",
      initialStock: 4,
      minStock: 0,
    });
    const oledOption = await savePriceRuleOption(owner, rule.id, null, {
      productId: oled.id,
      name: oled.name,
      suggested: "119",
      cost: "65",
      quantity: 1,
      minutes: 75,
      warrantyDays: 90,
      enabled: true,
      isDefault: false,
      notes: "",
    });
    const retiredLater = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Compatibility disabled option",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "20",
      salePrice: "0",
      initialStock: 2,
      minStock: 0,
    });
    const disabledOption = await savePriceRuleOption(owner, rule.id, null, {
      productId: retiredLater.id,
      name: retiredLater.name,
      suggested: "59",
      cost: "20",
      quantity: 1,
      minutes: 40,
      warrantyDays: 0,
      enabled: false,
      isDefault: false,
      notes: "",
    });
    const updateCompatibility = (product: typeof lcd, models: string[]) =>
      updateProduct(owner, product.id, {
        name: product.name,
        category: product.category,
        usage: "REPAIR",
        costPrice: product.costPrice.toString(),
        salePrice: product.salePrice.toString(),
        stockQuantity: product.stockQuantity,
        minStock: product.minStock,
        favorite: product.favorite,
        compatibilities: models.map((model) => ({
          category: "PHONE",
          brand: "Apple",
          model,
          project: "Display",
        })),
      });

    await updateCompatibility(oled, ["iPhone 13", "iPhone 14"]);
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: lcdOption.id },
      }),
    ).toMatchObject({ isDefault: true, enabled: true });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: oledOption.id },
      }),
    ).toMatchObject({ isDefault: false, enabled: true });
    expect(
      await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } }),
    ).toMatchObject({ requiredProductId: lcd.id });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: disabledOption.id },
      }),
    ).toMatchObject({ enabled: false, isDefault: false });

    await updateCompatibility(lcd, ["iPhone 13", "iPhone 15"]);
    expect(
      await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } }),
    ).toMatchObject({ requiredProductId: lcd.id });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: lcdOption.id },
      }),
    ).toMatchObject({ isDefault: true, enabled: true });
    expect(
      (
        await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } })
      ).suggested.toString(),
    ).toBe("100");

    await savePriceRuleOption(owner, rule.id, oledOption.id, {
      productId: oled.id,
      name: oled.name,
      suggested: "119",
      cost: "65",
      quantity: 1,
      minutes: 75,
      warrantyDays: 90,
      enabled: true,
      isDefault: true,
      notes: "",
    });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: oledOption.id },
      }),
    ).toMatchObject({ isDefault: true, enabled: true });
    expect(
      await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } }),
    ).toMatchObject({ requiredProductId: oled.id });
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [
          { project: "Display", final: "119", priceOptionId: oledOption.id },
        ],
      }),
    );
    const historicalItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    const reservation = await db.workOrderProduct.findFirstOrThrow({
      where: {
        orderId: order.id,
        productId: oled.id,
        kind: "REPAIR_PART",
        consumedAt: null,
      },
    });

    await updateProduct(owner, oled.id, {
      name: oled.name,
      category: oled.category,
      usage: "RETAIL",
      costPrice: oled.costPrice.toString(),
      salePrice: oled.salePrice.toString(),
      stockQuantity: oled.stockQuantity,
      minStock: oled.minStock,
      favorite: oled.favorite,
      compatibilities: [],
    });

    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: oledOption.id },
      }),
    ).toMatchObject({ enabled: false, isDefault: false });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: lcdOption.id },
      }),
    ).toMatchObject({ enabled: true, isDefault: true });
    expect(
      await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } }),
    ).toMatchObject({ requiredProductId: lcd.id });
    expect(
      await db.workOrderItem.findUniqueOrThrow({
        where: { id: historicalItem.id },
      }),
    ).toMatchObject({
      priceOptionId: oledOption.id,
      priceOptionName: oled.name,
      requiredProductId: oled.id,
      requiredProductName: oled.name,
    });
    expect(historicalItem.final.toString()).toBe("119");
    expect(
      await db.workOrderProduct.findUniqueOrThrow({
        where: { id: reservation.id },
      }),
    ).toMatchObject({ productId: oled.id, quantity: 1, consumedAt: null });

    await savePriceRuleOption(owner, rule.id, lcdOption.id, {
      productId: lcd.id,
      name: lcd.name,
      suggested: "100",
      cost: "32",
      quantity: 1,
      minutes: 60,
      warrantyDays: 90,
      enabled: false,
      isDefault: true,
      notes: "",
    });
    await updateCompatibility(lcd, ["iPhone 16"]);
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: lcdOption.id },
      }),
    ).toMatchObject({ enabled: false, isDefault: false });
    expect(
      await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } }),
    ).toMatchObject({ requiredProductId: null, requiredQuantity: 1 });
    expect(
      (
        await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } })
      ).suggested.toString(),
    ).toBe("100");
  });

  it("keeps an explicit no-part choice after saving and allows a later selection", async () => {
    await configureRepairOption("No part default test");
    const order = await createOrder(staff, input({ deposit: "0" }));

    await replaceQuote(staff, order.id, {
      items: [
        {
          project: "Display",
          final: "100",
          requiredProductRemoved: true,
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });

    let saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(saved.items[0]).toMatchObject({
      requiredProductId: null,
      priceOptionId: null,
    });
    expect(
      saved.products.filter(
        (line) => line.kind === "REPAIR_PART" && !line.consumedAt,
      ),
    ).toHaveLength(0);

    await replaceQuote(staff, order.id, {
      items: [{ project: "Display", final: "100" }],
      orderDiscount: "0",
      includeVat: false,
    });
    saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(saved.items[0]).toMatchObject({
      requiredProductId: null,
      priceOptionId: null,
    });

    const manuallySelected = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Manual part after no part test",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "12",
      salePrice: "0",
      initialStock: 3,
      minStock: 0,
    });
    await replaceQuote(staff, order.id, {
      items: [
        {
          project: "Display",
          final: "100",
          requiredProductId: manuallySelected.id,
          requiredQuantity: 1,
          requiredProductRemoved: false,
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });

    saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(saved.items[0]).toMatchObject({
      requiredProductId: manuallySelected.id,
      requiredProductName: manuallySelected.name,
      priceOptionId: null,
    });
    expect(
      saved.products.find(
        (line) => line.kind === "REPAIR_PART" && !line.consumedAt,
      ),
    ).toMatchObject({ productId: manuallySelected.id, quantity: 1 });
  });

  it("uses the base price after removing a part without changing the price list", async () => {
    const { product, rule, option } = await configureRepairOption(
      "No-part base quote option",
      1,
      "30",
    );
    const updatedOption = await savePriceRuleOption(owner, rule.id, option.id, {
      productId: product.id,
      name: option.name,
      suggested: "119",
      cost: "32",
      quantity: 1,
      minutes: 60,
      warrantyDays: 0,
      enabled: true,
      isDefault: true,
      notes: "",
    });
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [
          {
            project: "Display",
            final: "119",
            priceOptionId: updatedOption.id,
          },
        ],
      }),
    );
    await replaceQuote(staff, order.id, {
      items: [
        {
          project: "Display",
          final: "30",
          requiredProductRemoved: true,
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });

    const savedItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(savedItem).toMatchObject({
      requiredProductId: null,
      priceOptionId: null,
    });
    expect(savedItem.suggested?.toString()).toBe("30");
    expect(savedItem.final.toString()).toBe("30");
    expect(
      await db.workOrderProduct.count({
        where: {
          orderId: order.id,
          kind: "REPAIR_PART",
          consumedAt: null,
        },
      }),
    ).toBe(0);
    expect(
      (
        await db.priceRule.findUniqueOrThrow({ where: { id: rule.id } })
      ).suggested.toString(),
    ).toBe("30");
    expect(
      (
        await db.priceRuleOption.findUniqueOrThrow({
          where: { id: updatedOption.id },
        })
      ).suggested.toString(),
    ).toBe("119");
  });

  it("allows unlinked quote items alongside required repair parts", async () => {
    const { product, option } = await configureRepairOption(
      "Mixed required and optional part test",
    );
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [
          {
            project: "Display",
            final: "79",
            priceOptionId: option.id,
            requiredProductId: product.id,
          },
          { project: "Optional cleaning", final: "10" },
        ],
      }),
    );
    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(saved.items).toHaveLength(2);
    expect(
      saved.products.filter((line) => line.kind === "REPAIR_PART"),
    ).toMatchObject([{ productId: product.id, quantity: 1 }]);
  });

  it("preserves a disabled price option's historical snapshot when editing its order", async () => {
    const { product, rule, option } = await configureRepairOption(
      "Historical part test",
    );
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [
          {
            project: "Display",
            final: "79",
            priceOptionId: option.id,
            requiredProductId: product.id,
          },
        ],
      }),
    );
    await db.priceRuleOption.update({
      where: { id: option.id },
      data: { name: "Current part label", suggested: "149", quantity: 2 },
    });
    await deletePriceRuleOption(owner, rule.id, option.id);

    await expect(
      replaceQuote(staff, order.id, {
        items: [
          {
            project: "Display",
            final: "85",
            priceOptionId: option.id,
            requiredProductId: product.id,
            requiredQuantity: 1,
          },
        ],
        orderDiscount: "0",
        includeVat: false,
      }),
    ).resolves.toBeUndefined();

    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(saved.items[0]).toMatchObject({
      priceOptionId: option.id,
      priceOptionName: "Historical part test",
      requiredProductId: product.id,
      requiredProductName: product.name,
      requiredQuantity: 1,
    });
    expect(saved.items[0].suggested?.toString()).toBe("79");
    expect(
      saved.products.find(
        (line) => line.kind === "REPAIR_PART" && !line.consumedAt,
      ),
    ).toMatchObject({ productId: product.id, quantity: 1 });
  });

  it("disables new choices for a removed part without dropping its existing reservation", async () => {
    const { product, rule, option } = await configureRepairOption(
      "Disabled stock part test",
    );
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [
          {
            project: "Display",
            final: "79",
            priceOptionId: option.id,
            requiredProductId: product.id,
          },
        ],
      }),
    );

    await deleteProducts(owner, [product.id]);
    expect(
      await db.priceRuleOption.findUniqueOrThrow({ where: { id: option.id } }),
    ).toMatchObject({ enabled: false, isDefault: false });
    await expect(
      createOrder(
        staff,
        input({
          phone: "3335554444",
          deposit: "0",
          items: [
            {
              project: "Display",
              final: "79",
              priceOptionId: option.id,
              requiredProductId: product.id,
            },
          ],
        }),
      ),
    ).rejects.toThrow();

    await replaceQuote(staff, order.id, {
      items: [
        {
          project: "Display",
          final: "85",
          priceOptionId: option.id,
          requiredProductId: product.id,
          requiredQuantity: 1,
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });

    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(saved.items[0]).toMatchObject({
      priceOptionId: option.id,
      requiredProductId: product.id,
    });
    expect(
      saved.products.filter(
        (line) => line.kind === "REPAIR_PART" && !line.consumedAt,
      ),
    ).toMatchObject([{ productId: product.id, quantity: 1 }]);
    expect(rule.id).toBe(saved.items[0].ruleId);
  });

  it("rejects a submitted part that does not belong to the selected option", async () => {
    const { option } = await configureRepairOption(
      "Selected option part test",
      2,
    );
    const unrelated = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Unrelated selected part test",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "20",
      salePrice: "0",
      initialStock: 5,
      minStock: 0,
    });

    await expect(
      createOrder(
        staff,
        input({
          deposit: "0",
          items: [
            {
              project: "Display",
              final: "79",
              priceOptionId: option.id,
              requiredProductId: unrelated.id,
              requiredQuantity: 8,
            },
          ],
        }),
      ),
    ).rejects.toThrow();
    expect(await db.workOrder.count()).toBe(0);
    expect(await db.workOrderProduct.count()).toBe(0);
  });

  it("uses the selected option quantity for its repair reservation", async () => {
    const { product, option } = await configureRepairOption(
      "Authoritative quantity part test",
      2,
    );
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [
          {
            project: "Display",
            final: "79",
            priceOptionId: option.id,
            requiredProductId: product.id,
            requiredQuantity: 1,
          },
        ],
      }),
    );
    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(saved.items[0].requiredQuantity).toBe(2);
    expect(
      saved.products.find(
        (line) => line.kind === "REPAIR_PART" && !line.consumedAt,
      ),
    ).toMatchObject({ productId: product.id, quantity: 2 });
  });

  it("registers, quotes, receives balance, delivers and audits every change", async () => {
    const created = await createOrder(staff, input());
    await updateDueDate(staff, created.id, "2099-12-31");
    await changeStatus(staff, created.id, { status: "READY" });
    await addPayment(staff, created.id, {
      requestId: randomUUID(),
      amount: "80",
      method: "CARD",
      kind: "BALANCE",
    });
    await changeStatus(staff, created.id, {
      status: "COMPLETED",
      pickedUpBy: "Cliente",
    });
    const order = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: orderInclude,
    });
    expect(order.status).toBe("COMPLETED");
    expect(order.pickedUpAt).not.toBeNull();
    expect(order.history).toHaveLength(3);
    expect(order.dueDate).toBe("2099-12-31");
    expect(order.payments).toHaveLength(2);
    expect(balance(order.items, order.payments)).toBe(0);
    expect(order.device.customer.phone).toBe("+393331234567");
    expect(order.device.customer.consentVersion).toBe("1.0");
    expect(order.items[0].matchLevel).toBe("MODEL");
    expect(
      await db.auditLog.count({
        where: { entityId: order.id, action: "ORDER_DELIVERED" },
      }),
    ).toBe(1);
  });
  it("preserves quote and operator snapshots after list and staff changes", async () => {
    const created = await createOrder(staff, input());
    await db.priceRule.updateMany({ data: { suggested: "150" } });
    await db.user.update({
      where: { id: staff.id },
      data: { name: "New name" },
    });
    const order = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: orderInclude,
    });
    expect(order.items[0].suggested?.toString()).toBe("100");
    expect(order.history[0].actorName).toBe("Tecnico");
    expect(order.payments[0].actorName).toBe("Tecnico");
    await db.user.update({
      where: { id: staff.id },
      data: { name: "Tecnico" },
    });
  });
  it("rolls back all customer and device changes on invalid deposit", async () => {
    await expect(createOrder(staff, input({ deposit: "101" }))).rejects.toThrow(
      "acconto",
    );
    expect(await db.customer.count()).toBe(0);
    expect(await db.device.count()).toBe(0);
    expect(await db.workOrder.count()).toBe(0);
    expect(await db.statusHistory.count()).toBe(0);
  });
  it("blocks delivery until the balance is zero", async () => {
    const created = await createOrder(staff, input());
    await changeStatus(staff, created.id, { status: "REPAIRING" });
    await changeStatus(staff, created.id, { status: "READY" });
    await expect(
      changeStatus(staff, created.id, {
        status: "COMPLETED",
        pickedUpBy: "Cliente",
        override: true,
      }),
    ).rejects.toThrow("zero");
    await expect(
      changeStatus(owner, created.id, {
        status: "COMPLETED",
        pickedUpBy: "Cliente",
      }),
    ).rejects.toThrow("zero");
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: created.id } }))
        .status,
    ).toBe("READY");
    await setPaidTotal(staff, created.id, {
      requestId: randomUUID(),
      amount: "100",
      method: "OTHER",
      adjustmentReason: "Saldo saldato manualmente",
    });
    await changeStatus(owner, created.id, {
      status: "COMPLETED",
      pickedUpBy: "Cliente",
    });
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: created.id } }))
        .status,
    ).toBe("COMPLETED");
  });
  it("splits a manually corrected paid total between repair and retail", async () => {
    const product = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Cover incassata",
      category: "Cover",
      usage: "RETAIL",
      costPrice: "3",
      salePrice: "20",
      initialStock: 3,
      minStock: 0,
    });
    const order = await createOrder(staff, input({ deposit: "0" }));
    await addWorkOrderProduct(staff, order.id, {
      productId: product.id,
      kind: "RETAIL_ADDON",
      quantity: 1,
    });

    await setPaidTotal(staff, order.id, {
      requestId: randomUUID(),
      amount: "110",
      method: "CARD",
      adjustmentReason: "Pagamento parziale registrato",
    });

    const payment = await db.payment.findFirstOrThrow({
      where: { orderId: order.id },
      include: { allocations: true },
    });
    expect(payment.method).toBe("CARD");
    expect(
      payment.allocations.map((line) => [line.source, line.amount.toString()]),
    ).toEqual(
      expect.arrayContaining([
        ["REPAIR", "91.67"],
        ["RETAIL", "18.33"],
      ]),
    );
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: order.id, action: "PAYMENT_TOTAL_SET" },
    });
    expect(audit.context).toMatchObject({
      reason: "Pagamento parziale registrato",
    });
  });
  it("locks delivered history and adds paid or free post-sale repairs independently", async () => {
    const created = await createOrder(staff, input({ deposit: "100" }));
    const originalItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: created.id },
    });
    await updateWarranty(staff, created.id, {
      items: [
        { id: originalItem.id, days: 90, notes: "Esclusi liquidi e urti" },
      ],
    });
    await changeStatus(staff, created.id, { status: "REPAIRING" });
    await changeStatus(staff, created.id, { status: "READY" });
    await changeStatus(staff, created.id, {
      status: "COMPLETED",
      pickedUpBy: "Cliente",
    });
    const delivered = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
    });
    await expect(
      updateWarranty(staff, created.id, {
        items: [{ id: originalItem.id, days: 365, notes: "" }],
      }),
    ).rejects.toThrow("chiusa");
    await expect(
      changeStatus(staff, created.id, { status: "REWORKING" }),
    ).rejects.toThrow("post-vendita");
    await openAfterSales(staff, created.id, {
      items: [
        {
          originalItemId: originalItem.id,
          treatment: "PAID",
          fee: "50",
          requiredProductId: "",
          requiredQuantity: 1,
        },
      ],
      notes: "Controllare il connettore",
      dueDate: "2099-12-31",
    });
    await updateDueDate(staff, created.id, "2099-12-30");
    let order = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: orderInclude,
    });
    expect(order).toMatchObject({
      status: "REWORKING",
      afterSalesOpen: true,
      afterSalesDueDate: "2099-12-30",
      dueDate: delivered.dueDate,
    });
    expect(order.items[0].warrantyDays).toBe(90);
    expect(order.afterSalesFee.toString()).toBe("50");
    const openedAudit = await db.auditLog.findFirstOrThrow({
      where: { entityId: created.id, action: "AFTER_SALES_OPENED" },
      orderBy: { createdAt: "desc" },
    });
    expect(openedAudit.context).toMatchObject({
      projects: [
        {
          originalItemId: originalItem.id,
          project: "Display",
          treatment: "PAID",
          fee: "50.00",
        },
      ],
      notes: "Controllare il connettore",
      fee: "50.00",
    });
    expect(balance(order.items, order.payments, order)).toBe(5000);
    await addPayment(staff, created.id, {
      requestId: randomUUID(),
      amount: "50",
      method: "CARD",
      kind: "BALANCE",
    });
    await changeStatus(staff, created.id, { status: "READY" });
    await changeStatus(staff, created.id, {
      status: "COMPLETED",
      pickedUpBy: "Altro nome",
    });
    order = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: orderInclude,
    });
    expect(order.pickedUpAt?.toISOString()).toBe(
      delivered.pickedUpAt?.toISOString(),
    );
    expect(order.pickedUpBy).toBe("Cliente");
    expect(order.payments.at(-1)?.kind).toBe("AFTER_SALES");
    await expect(
      openAfterSales(staff, created.id, {
        items: [
          {
            originalItemId: originalItem.id,
            treatment: "WARRANTY",
            fee: "0",
            requiredProductId: "",
            requiredQuantity: 1,
          },
        ],
        notes: "",
        dueDate: "",
      }),
    ).rejects.toThrow("già una riparazione");
    order = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: orderInclude,
    });
    expect(order.status).toBe("COMPLETED");
    expect(order.afterSalesFee.toString()).toBe("50");
    expect(balance(order.items, order.payments, order)).toBe(0);
    expect(
      await db.auditLog.count({
        where: { entityId: created.id, action: "AFTER_SALES_OPENED" },
      }),
    ).toBe(1);
  });
  it("shares one rework flow, restores rework status after parts arrive and keeps one chance per item", async () => {
    const part = await createProduct(staff, {
      requestId: randomUUID(),
      name: "Display rework",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "20",
      salePrice: "0",
      initialStock: 0,
      minStock: 0,
      favorite: false,
      enabled: true,
    });
    const created = await createOrder(
      staff,
      input({ deposit: "100", dueDate: "2099-12-31" }),
    );
    const item = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: created.id },
    });
    await updateWarranty(staff, created.id, {
      items: [{ id: item.id, days: 30, notes: "" }],
    });
    await changeStatus(staff, created.id, { status: "READY" });
    await changeStatus(staff, created.id, {
      status: "COMPLETED",
      pickedUpBy: "Cliente",
    });
    await openAfterSales(staff, created.id, {
      items: [
        {
          originalItemId: item.id,
          treatment: "WARRANTY",
          fee: "0",
          requiredProductId: part.id,
          requiredQuantity: 1,
        },
      ],
      notes: "",
      dueDate: "2099-12-31",
    });
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: created.id } }))
        .status,
    ).toBe("PARTS_MISSING");
    expect(
      await db.reworkSession.count({ where: { orderId: created.id } }),
    ).toBe(1);
    await expect(
      changeStatus(staff, created.id, { status: "REWORKING" }),
    ).rejects.toThrow("post-vendita");
    await adjustInventory(staff, part.id, {
      requestId: randomUUID(),
      quantity: 1,
      type: "STOCK_IN",
      note: "",
    });
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: created.id } }))
        .status,
    ).toBe("REWORKING");
    await changeStatus(staff, created.id, { status: "READY" });
    await expect(
      changeStatus(staff, created.id, { status: "REPAIRING" }),
    ).rejects.toThrow("Cambio di stato");
    await changeStatus(staff, created.id, { status: "REWORKING" });
    expect(
      await db.reworkSession.count({ where: { orderId: created.id } }),
    ).toBe(1);
    await changeStatus(staff, created.id, { status: "READY" });
    await changeStatus(staff, created.id, {
      status: "CANCELLED",
      note: "Cliente rinuncia al ritiro",
    });
    const cancelled = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: { history: { orderBy: { createdAt: "desc" } } },
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.history[0]).toMatchObject({
      from: "READY",
      to: "CANCELLED",
      note: "Cliente rinuncia al ritiro",
    });
  });
  it("refunds the full received amount without deleting original payments", async () => {
    const created = await createOrder(staff, input({ deposit: "100" }));
    await changeStatus(staff, created.id, { status: "REPAIRING" });
    await changeStatus(staff, created.id, { status: "READY" });
    await changeStatus(staff, created.id, {
      status: "COMPLETED",
      pickedUpBy: "Cliente",
    });
    const requestId = randomUUID();
    await refundOrder(staff, created.id, {
      requestId,
      method: "CASH",
      amount: "100",
      reason: "Cliente non soddisfatto",
    });
    await refundOrder(staff, created.id, {
      requestId,
      method: "CASH",
      amount: "100",
      reason: "Cliente non soddisfatto",
    });
    const order = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: orderInclude,
    });
    expect(order.status).toBe("REFUNDED");
    expect(order.payments).toHaveLength(2);
    expect(order.payments.map((payment) => payment.amount.toString())).toEqual([
      "100",
      "-100",
    ]);
    expect(order.payments.at(-1)?.kind).toBe("REFUND");
    expect(
      order.payments.reduce((sum, payment) => sum + Number(payment.amount), 0),
    ).toBe(0);
    expect(balance(order.items, order.payments, order)).toBe(0);
    await expect(
      openAfterSales(staff, created.id, {
        items: [
          {
            originalItemId: "missing",
            treatment: "PAID",
            fee: "0",
            requiredProductId: "",
            requiredQuantity: 1,
          },
        ],
        notes: "",
        dueDate: "",
      }),
    ).rejects.toThrow("consegnata");
    expect(
      await db.auditLog.count({
        where: { entityId: created.id, action: "REFUND_ISSUED" },
      }),
    ).toBe(1);
  });
  it("allows one partial refund and rejects a second refund request", async () => {
    const created = await createOrder(staff, input({ deposit: "100" }));
    await changeStatus(staff, created.id, { status: "REPAIRING" });
    await changeStatus(staff, created.id, { status: "READY" });
    await changeStatus(staff, created.id, {
      status: "COMPLETED",
      pickedUpBy: "Cliente",
    });

    await refundOrder(staff, created.id, {
      requestId: randomUUID(),
      amount: "35.50",
      method: "CARD",
      reason: "Rimborso parziale",
    });

    const order = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: orderInclude,
    });
    expect(order.status).toBe("REFUNDED");
    expect(order.payments.map((payment) => payment.amount.toString())).toEqual([
      "100",
      "-35.5",
    ]);
    expect(
      order.payments
        .at(-1)
        ?.allocations.reduce(
          (sum, allocation) => sum + Number(allocation.amount),
          0,
        ),
    ).toBe(-35.5);
    await expect(
      refundOrder(staff, created.id, {
        requestId: randomUUID(),
        amount: "1",
        method: "CASH",
        reason: "Secondo rimborso",
      }),
    ).rejects.toThrow("consegnata");
    expect(
      await db.payment.count({
        where: { orderId: created.id, kind: "REFUND" },
      }),
    ).toBe(1);
  });
  it("protects used inventory and device catalog values while allowing unused deletion", async () => {
    await createProduct(staff, {
      requestId: randomUUID(),
      name: "Ricambio usato",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "1",
      salePrice: "0",
      initialStock: 0,
      minStock: 0,
      favorite: false,
      enabled: true,
    });
    const ricambi = await db.inventoryCategory.findUniqueOrThrow({
      where: { name: "Ricambi" },
    });
    await expect(deleteInventoryCategory(owner, ricambi.id)).rejects.toThrow(
      "protetta",
    );
    await expect(
      deleteDeviceCatalogOption(owner, {
        category: "PHONE",
        kind: "BRAND",
        value: "Apple",
        brand: "",
      }),
    ).rejects.toThrow("associato");
    await deleteDeviceCatalogOption(owner, {
      category: "PHONE",
      kind: "BRAND",
      value: "Nothing",
      brand: "",
    });
    expect(
      await db.deviceCatalogDeletion.count({ where: { value: "Nothing" } }),
    ).toBe(1);
  });
  it("assigns stable daily repair and retail codes", async () => {
    const first = await createOrder(staff, input({ deposit: "0" }));
    const second = await createOrder(
      staff,
      input({ requestId: randomUUID(), deposit: "0" }),
    );
    expect(first.code).toMatch(/^R-\d{8}001$/);
    expect(second.code).toMatch(/^R-\d{8}002$/);
    const product = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Cavo USB",
      category: "Cavi",
      usage: "RETAIL",
      costPrice: "2",
      salePrice: "10",
      initialStock: 2,
      minStock: 0,
    });
    const sale = await createRetailSale(staff, {
      requestId: randomUUID(),
      items: [{ productId: product.id, quantity: 1 }],
      discount: "0",
      method: "CASH",
    });
    expect(sale.code).toMatch(/^V-\d{8}001$/);
  });
  it("uses the manually configured business date for codes and due dates", async () => {
    await updateBusinessClock(owner, {
      mode: "MANUAL",
      manualDate: "2030-05-06",
    });
    await expect(
      createOrder(staff, input({ dueDate: "2030-05-05", deposit: "0" })),
    ).rejects.toThrow("precedere oggi");
    const order = await createOrder(
      staff,
      input({ dueDate: "2030-05-06", deposit: "0" }),
    );
    expect(order.code).toBe("R-20300506001");
  });
  it("creates diagnostic orders without repair items and uses the editable fee", async () => {
    const order = await createOrder(
      staff,
      input({
        inspectionMode: true,
        faults: [],
        fault: "",
        items: [],
        diagnosticFee: "12.50",
        dueDate: "2099-12-31",
        deposit: "0",
      }),
    );
    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(saved.status).toBe("DIAGNOSING");
    expect(saved.inspectionMode).toBe(true);
    expect(saved.inspectionFee.toString()).toBe("12.5");
    expect(saved.items).toHaveLength(0);
    await expect(
      changeStatus(staff, order.id, { status: "REPAIRING" }),
    ).rejects.toThrow("Cambio di stato");
    const fault = await saveFault(owner, null, {
      category: "PHONE",
      name: "Display assembly damaged",
      note: "",
      hidden: false,
    });
    await completeInspection(staff, order.id, {
      standardFaultIds: [fault.id],
      faultNote: "Vetro e pannello danneggiati",
      items: [{ project: "Display", final: "100", adjustmentReason: "" }],
      orderDiscount: "0",
      includeVat: false,
      dueDate: "2099-12-31",
    });
    const quoted = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(quoted.status).toBe("REPAIRING");
    expect(quoted.inspectionMode).toBe(false);
    expect(quoted.inspectionFee.toString()).toBe("12.5");
    expect(quoted.fault).toBe("Display assembly damaged");
    expect(quoted.faultNote).toBe("Vetro e pannello danneggiati");
    expect(quoted.items).toHaveLength(1);
    await changeStatus(staff, order.id, { status: "READY" });
    await checkoutWorkOrder(staff, order.id, {
      requestId: randomUUID(),
      amount: "112.50",
      method: "CASH",
      pickedUpBy: "Test Cliente",
    });
    const completed = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: { include: { allocations: true } } },
    });
    expect(completed.status).toBe("COMPLETED");
    expect(
      completed.payments.at(-1)?.allocations.map((allocation) => ({
        source: allocation.source,
        amount: allocation.amount.toString(),
      })),
    ).toEqual([{ source: "REPAIR", amount: "112.5" }]);
  });
  it("allocates a diagnostic fee through the ordinary payment entry", async () => {
    const order = await createOrder(
      staff,
      input({
        inspectionMode: true,
        faults: [],
        fault: "",
        items: [],
        diagnosticFee: "12.50",
        deposit: "0",
      }),
    );

    await addPayment(staff, order.id, {
      requestId: randomUUID(),
      amount: "12.50",
      method: "CARD",
      kind: "BALANCE",
    });
    const payment = await db.payment.findFirstOrThrow({
      where: { orderId: order.id },
      include: { allocations: true },
    });

    expect(payment.allocations).toHaveLength(1);
    expect(payment.allocations[0].source).toBe("REPAIR");
    expect(payment.allocations[0].amount.toString()).toBe("12.5");
  });
  it("uses optional quote parts to drive missing-parts status", async () => {
    const part = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Display iPhone 13",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "40",
      salePrice: "0",
      initialStock: 0,
      minStock: 1,
    });
    const rule = await db.priceRule.findFirstOrThrow({
      where: { project: "display" },
    });
    await savePriceRule(owner, rule.id, {
      category: rule.category,
      brand: rule.brand,
      model: rule.model,
      project: rule.project,
      suggested: rule.suggested.toString(),
      requiredProductId: part.id,
      requiredQuantity: 1,
    });
    const order = await createOrder(staff, input({ deposit: "0" }));
    expect(order.status).toBe("PARTS_MISSING");
    await expect(
      changeStatus(staff, order.id, { status: "REPAIRING" }),
    ).rejects.toThrow("Cambio di stato");
    await adjustInventory(owner, part.id, {
      requestId: randomUUID(),
      quantity: 1,
      type: "STOCK_IN",
      note: "",
    });
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("REPAIRING");
  });
  it("saves a custom repair item's selected part as its default quote part", async () => {
    const part = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Scheda madre iPhone 11",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "45",
      salePrice: "0",
      initialStock: 2,
      minStock: 0,
    });
    await createOrder(
      staff,
      input({
        phone: "3335551111",
        deposit: "0",
        items: [
          {
            project: "Sostituzione scheda madre",
            final: "120",
            adjustmentReason: "",
            saveRule: true,
            requiredProductId: part.id,
            requiredQuantity: 1,
          },
        ],
      }),
    );

    const savedRule = await db.priceRule.findFirstOrThrow({
      where: { project: "sostituzione scheda madre" },
    });
    expect(savedRule.requiredProductId).toBe(part.id);
    expect(savedRule.requiredQuantity).toBe(1);

    const nextOrder = await createOrder(
      staff,
      input({
        phone: "3335552222",
        deposit: "0",
        items: [
          {
            project: "Sostituzione scheda madre",
            final: "120",
            adjustmentReason: "",
          },
        ],
      }),
    );
    const inheritedItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: nextOrder.id },
    });
    expect(inheritedItem.requiredProductId).toBe(part.id);

    await replaceQuote(staff, nextOrder.id, {
      items: [
        {
          project: "Sostituzione scheda madre",
          final: "120",
          requiredProductRemoved: true,
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });
    expect(
      (await db.priceRule.findUniqueOrThrow({ where: { id: savedRule.id } }))
        .requiredProductId,
    ).toBe(part.id);
  });
  it("preserves repricing history without a quote-confirmation state", async () => {
    const order = await createOrder(staff, input());
    await replaceQuote(staff, order.id, [
      { project: "Display", final: "90", adjustmentReason: "Sconto" },
    ]);
    const updated = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(updated.confirmedAt).toBeNull();
    expect(updated.items[0].final.toString()).toBe("90");
    await changeStatus(staff, order.id, { status: "READY" });
    const log = await db.auditLog.findFirstOrThrow({
      where: { action: "QUOTE_UPDATED" },
    });
    expect(log.context).toMatchObject({
      before: [{ final: "100" }],
      after: [{ final: "90.00" }],
    });
  });
  it("prevents quote below collected money", async () => {
    const order = await createOrder(staff, input());
    await expect(
      replaceQuote(staff, order.id, [
        { project: "Display", final: "10", adjustmentReason: "Sconto" },
      ]),
    ).rejects.toThrow("inferiore");
    expect(
      (
        await db.workOrderItem.findFirstOrThrow({
          where: { orderId: order.id },
        })
      ).final.toString(),
    ).toBe("100");
  });
  it("preserves warranty settings when replacing a quote", async () => {
    const order = await createOrder(staff, input({ deposit: "0" }));
    const item = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    await updateWarranty(staff, order.id, {
      items: [{ id: item.id, days: 365, notes: "Display escluso da urti" }],
    });

    await replaceQuote(staff, order.id, [
      { project: "Display", final: "95", adjustmentReason: "" },
    ]);

    const replacement = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(replacement.id).not.toBe(item.id);
    expect(replacement.warrantyDays).toBe(365);
    expect(replacement.warrantyNotes).toBe("Display escluso da urti");
  });
  it("does not overwrite the price list from an order-specific quote", async () => {
    const created = await createOrder(
      owner,
      input({
        items: [{ project: "Camera", final: "50", discount: "10" }],
        orderDiscount: "5",
      }),
    );
    expect(
      await db.priceRule.findFirst({ where: { project: "camera" } }),
    ).toBeNull();
    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: orderInclude,
    });
    expect(balance(saved.items, saved.payments, saved)).toBe(1500);
    await createOrder(
      owner,
      input({
        deposit: "0",
        items: [{ project: "Camera", final: "60", saveRule: true }],
      }),
    );
    expect(
      (
        await db.priceRule.findFirstOrThrow({ where: { project: "camera" } })
      ).suggested.toString(),
    ).toBe("60");
    expect(saved.items[0].final.toString()).toBe("50");
  });
  it("adds IVA only when selected and blocks later deposits", async () => {
    const created = await createOrder(
      owner,
      input({
        items: [
          { project: "Display", final: "100", discount: "10" },
          { project: "Camera", final: "50" },
        ],
        orderDiscount: "5",
        includeVat: true,
      }),
    );
    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: orderInclude,
    });
    expect(balance(saved.items, saved.payments, saved)).toBe(14470);
    await expect(
      addPayment(owner, created.id, {
        requestId: randomUUID(),
        amount: "1",
        method: "CASH",
        kind: "DEPOSIT",
      }),
    ).rejects.toThrow("solo alla creazione");
    await addPayment(owner, created.id, {
      requestId: randomUUID(),
      amount: "140",
      method: "CARD",
      kind: "BALANCE",
    });
    await expect(
      replaceQuote(owner, created.id, {
        items: [{ project: "Display", final: "150" }],
        orderDiscount: "15",
        includeVat: false,
      }),
    ).rejects.toThrow("inferiore");
    expect(
      (
        await db.priceRule.findFirstOrThrow({ where: { project: "display" } })
      ).suggested.toString(),
    ).toBe("100");
  });
  it("persists deduplicated faults only after a valid order and separates categories", async () => {
    await expect(
      createOrder(
        owner,
        input({
          faults: ["  Porta instabile  ", "porta instabile"],
          deposit: "999",
        }),
      ),
    ).rejects.toThrow();
    expect(await db.faultOption.count()).toBe(0);
    await createOrder(
      owner,
      input({ faults: ["  Porta instabile  ", "porta instabile"] }),
    );
    expect(await db.faultOption.count()).toBe(1);
    await createOrder(
      owner,
      input({ category: "LAPTOP", faults: ["Porta instabile"] }),
    );
    expect(await db.faultOption.count()).toBe(2);
  });
  it("rolls back discounts exceeding original quote including dictionary and prices", async () => {
    await expect(
      createOrder(
        owner,
        input({
          items: [{ project: "New repair", final: "20", discount: "21" }],
          faults: ["New fault"],
        }),
      ),
    ).rejects.toThrow("sconto");
    expect(await db.customer.count()).toBe(0);
    expect(await db.faultOption.count()).toBe(0);
    expect(await db.priceRule.count()).toBe(1);
  });
  it("records an initial full payment as repair payment instead of deposit", async () => {
    await createOrder(
      owner,
      input({ items: [{ project: "Check", final: "0" }], deposit: "0" }),
    );
    const created = await createOrder(owner, input({ deposit: "100" }));
    expect(
      (await db.payment.findFirstOrThrow({ where: { orderId: created.id } }))
        .kind,
    ).toBe("BALANCE");
  });
  it("does not replace newer list prices when only editing an old order discount", async () => {
    const old = await createOrder(owner, input({ deposit: "0" }));
    await createOrder(
      owner,
      input({
        deposit: "0",
        items: [{ project: "Display", final: "120", saveRule: true }],
      }),
    );
    await replaceQuote(owner, old.id, {
      items: [{ project: "Display", final: "100", discount: "10" }],
      orderDiscount: "5",
      includeVat: true,
    });
    expect(
      (
        await db.priceRule.findFirstOrThrow({ where: { project: "display" } })
      ).suggested.toString(),
    ).toBe("120");
    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: old.id },
      include: orderInclude,
    });
    expect(balance(saved.items, saved.payments, saved)).toBe(10370);
  });
  it("rejects conflicting prices for the same project atomically", async () => {
    await expect(
      createOrder(
        owner,
        input({
          items: [
            { project: "Display", final: "100" },
            { project: "display", final: "110" },
          ],
        }),
      ),
    ).rejects.toThrow("Prezzi diversi");
    expect(await db.workOrder.count()).toBe(0);
    expect(
      (
        await db.priceRule.findFirstOrThrow({ where: { project: "display" } })
      ).suggested.toString(),
    ).toBe("100");
  });
  it("blocks overpayment, zero and negative amounts", async () => {
    const order = await createOrder(staff, input());
    for (const amount of ["81", "0", "-1"])
      await expect(
        addPayment(staff, order.id, {
          requestId: randomUUID(),
          amount,
          kind: "BALANCE",
          method: "CASH",
        }),
      ).rejects.toThrow();
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
  });
  it("makes repeated payment requests idempotent and detects altered replay", async () => {
    const order = await createOrder(staff, input());
    const payment = {
      requestId: randomUUID(),
      amount: "20",
      kind: "BALANCE",
      method: "CASH",
    };
    const first = await addPayment(staff, order.id, payment);
    const second = await addPayment(staff, order.id, payment);
    expect(first.id).toBe(second.id);
    await expect(
      addPayment(staff, order.id, { ...payment, amount: "21" }),
    ).rejects.toThrow("già utilizzata");
    expect(await db.payment.count()).toBe(2);
  });
  it("serializes concurrent payments to prevent overcollection", async () => {
    const order = await createOrder(staff, input());
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        addPayment(staff, order.id, {
          requestId: randomUUID(),
          amount: "60",
          kind: "BALANCE",
          method: "CARD",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const updated = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: orderInclude,
    });
    expect(balance(updated.items, updated.payments)).toBe(2000);
  });
  it("reuses the customer and device and prevents attaching another customer's device", async () => {
    const one = await createOrder(staff, input());
    const first = await db.workOrder.findUniqueOrThrow({
      where: { id: one.id },
    });
    await createOrder(staff, input({ deviceId: first.deviceId }));
    expect(await db.customer.count()).toBe(1);
    expect(await db.device.count()).toBe(1);
    await expect(
      createOrder(
        staff,
        input({ phone: "3339876543", deviceId: first.deviceId }),
      ),
    ).rejects.toThrow("non appartiene");
    expect(await db.customer.count()).toBe(1);
  });
  it("retries order creation without duplicate order or deposit", async () => {
    const data = input();
    const one = await createOrder(staff, data);
    const two = await createOrder(staff, data);
    expect(one.id).toBe(two.id);
    expect(await db.payment.count()).toBe(1);
  });
  it("rejects invalid state changes without a history entry", async () => {
    const order = await createOrder(staff, input());
    await expect(
      changeStatus(staff, order.id, { status: "PARTS_MISSING" }),
    ).rejects.toThrow("Cambio di stato");
    await expect(
      changeStatus(staff, order.id, {
        status: "COMPLETED",
        pickedUpBy: "Cliente",
      }),
    ).rejects.toThrow();
    expect(await db.statusHistory.count()).toBe(1);
  });
  it("edits daily details and prohibits closed-order edits", async () => {
    const order = await createOrder(staff, input({ deposit: "0" }));
    await updateOrder(staff, order.id, {
      fault: "Nuovo problema",
      notes: "Note",
      dueDate: "2026-11-01",
    });
    await changeStatus(staff, order.id, { status: "CANCELLED" });
    await expect(
      updateOrder(staff, order.id, { fault: "Edit" }),
    ).rejects.toThrow("chiusa");
  });
  it("updates the customer snapshot and associated device when changing customer", async () => {
    const order = await createOrder(staff, input());
    const previous = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { device: true },
    });
    const nextCustomer = await saveCustomer(owner, null, {
      name: "Nuovo cliente",
      phone: "333 777 8888",
    });

    await updateOrder(staff, order.id, {
      customerId: nextCustomer.id,
      fault: "Display rotto",
    });

    const updated = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { device: true, relatedDevices: true },
    });
    expect(updated.customerName).toBe("Nuovo cliente");
    expect(updated.device.customerId).toBe(nextCustomer.id);
    expect(updated.deviceId).not.toBe(previous.deviceId);
    expect(updated.relatedDevices.map((device) => device.deviceId)).toEqual([
      updated.deviceId,
    ]);
    expect(
      (await db.device.findUniqueOrThrow({ where: { id: previous.deviceId } }))
        .customerId,
    ).not.toBe(nextCustomer.id);
  });
  it("cancels with retained payment history and zero current balance", async () => {
    const order = await createOrder(staff, input());
    await changeStatus(staff, order.id, {
      status: "CANCELLED",
      note: "Cliente rinuncia",
    });
    const cancelled = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, payments: true },
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.payments).toHaveLength(1);
    expect(balance(cancelled.items, cancelled.payments, cancelled)).toBe(0);
  });
});
describe("server-side access control", () => {
  it("rejects staff list and employee administration", async () => {
    await expect(
      savePriceRule(staff, null, {
        project: "Battery",
        suggested: "30",
        minutes: 30,
        enabled: true,
      }),
    ).rejects.toThrow("titolare");
    await expect(
      createUser(staff, {
        name: "Forbidden",
        email: "no@test.it",
        password: "test-password-123",
        role: "OWNER",
      }),
    ).rejects.toThrow("titolare");
    await expect(setUserEnabled(staff, owner.id, false)).rejects.toThrow(
      "titolare",
    );
  });
  it("checks fresh database roles instead of trusting supplied role", async () => {
    await expect(
      savePriceRule({ ...staff, role: "OWNER" }, null, {
        project: "Battery",
        suggested: "30",
        minutes: 30,
        enabled: true,
      }),
    ).rejects.toThrow("titolare");
  });
  it("revokes disabled staff immediately and prevents self-disable", async () => {
    await setUserEnabled(owner, staff.id, false);
    await expect(createOrder(staff, input())).rejects.toThrow("Sessione");
    await expect(setUserEnabled(owner, owner.id, false)).rejects.toThrow(
      "account",
    );
  });
  it("creates employees with hashed passwords only", async () => {
    const result = await createUser(owner, {
      name: "New",
      email: `new-${randomUUID()}@test.it`,
      password: "strong-test-password",
      role: "STAFF",
    });
    const user = await db.user.findUniqueOrThrow({ where: { id: result.id } });
    expect(user.passwordHash).not.toBe("strong-test-password");
    expect(user.passwordHash).toMatch(/^\$2/);
    const log = await db.auditLog.findFirstOrThrow({
      where: { entityId: result.id },
    });
    expect(JSON.stringify(log.context)).not.toContain("password");
  });
});

describe("single operator initialization", () => {
  it("initializes exactly one audit actor during concurrent first requests", async () => {
    const actors = await Promise.all(
      Array.from({ length: 8 }, () => requireActor()),
    );
    expect(new Set(actors.map((actor) => actor.id)).size).toBe(1);
    expect(
      actors.every((actor) => actor.role === "OWNER" && actor.enabled),
    ).toBe(true);
    expect(
      await db.user.count({ where: { email: "local-operator@ngt.invalid" } }),
    ).toBe(1);
  });
});

describe("1.2 customer and catalog management", () => {
  it("saves three numbers, resolves secondary phones and rejects cross-customer conflicts atomically", async () => {
    const c = await saveCustomer(owner, null, {
      name: "Multi",
      phone: "3331111111",
      additionalPhones: ["3332222222", "3333333333"],
    });
    const order = await createOrder(
      owner,
      input({ phone: "3332222222", customerName: "Multi" }),
    );
    const full = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: orderInclude,
    });
    expect(full.device.customerId).toBe(c.id);
    expect(await db.customer.count()).toBe(1);
    await expect(
      saveCustomer(owner, null, {
        name: "Conflict",
        phone: "3334444444",
        additionalPhones: ["3333333333"],
      }),
    ).rejects.toThrow("altro cliente");
    expect(await db.customer.count()).toBe(1);
    await expect(
      createOrder(
        owner,
        input({ phone: "3331111111", additionalPhones: ["3335555555"] }),
      ),
    ).rejects.toThrow("tre telefoni");
    expect(await db.workOrder.count()).toBe(1);
    await saveCustomer(owner, c.id, {
      name: "Edited",
      phone: "3332222222",
      additionalPhones: ["3335555555"],
    });
    expect(
      (await db.customerPhone.findMany({ where: { customerId: c.id } }))
        .map((p) => p.phone)
        .sort(),
    ).toEqual(["+393332222222", "+393335555555"]);
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .customerName,
    ).toBe("Multi");
  });
  it("edits and removes customer devices without deleting historical orders or receipts", async () => {
    const order = await createOrder(owner, input());
    const full = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: orderInclude,
    });
    await saveDevice(owner, full.deviceId, {
      category: "PHONE",
      brand: "Samsung",
      model: "S24",
      imei: "123456",
    });
    expect(
      (await db.device.findUniqueOrThrow({ where: { id: full.deviceId } }))
        .model,
    ).toBe("S24");
    await deleteDevice(owner, full.deviceId);
    await expect(
      createOrder(owner, input({ deviceId: full.deviceId })),
    ).rejects.toThrow("dispositivo");
    await deleteCustomer(owner, full.device.customerId);
    expect(await db.customer.count({ where: { deletedAt: null } })).toBe(0);
    expect(await db.device.count({ where: { deletedAt: null } })).toBe(0);
    expect(await db.workOrder.count()).toBe(1);
    expect(await db.payment.count()).toBe(1);
    const replacement = await createOrder(owner, input());
    const replacementDevice = await db.device.findUniqueOrThrow({
      where: { id: replacement.deviceId },
    });
    expect(replacementDevice.customerId).not.toBe(full.device.customerId);
  });
  it("adds a device to an active customer", async () => {
    const customer = await saveCustomer(owner, null, {
      name: "Device owner",
      phone: "3331010101",
      additionalPhones: [],
    });
    const added = await createDevice(owner, customer.id, {
      category: "PHONE",
      brand: "apple",
      model: "iphone 15",
      imei: "",
    });
    const device = await db.device.findUniqueOrThrow({
      where: { id: added.id },
    });
    expect(device.customerId).toBe(customer.id);
    expect(device.brand).toBe("Apple");
    expect(device.model).toBe("iPhone 15");
  });
  it("deletes single and multiple quotes while preserving historical amounts", async () => {
    const order = await createOrder(owner, input());
    const before = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    const second = await savePriceRule(owner, null, {
      brand: "Apple",
      model: "iPhone 14",
      project: "Battery",
      suggested: "45",
    });
    await deletePriceRules(owner, [before.ruleId!, second.id]);
    expect(await db.priceRule.count()).toBe(0);
    const after = await db.workOrderItem.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.ruleId).toBeNull();
    expect(after.final.toString()).toBe(before.final.toString());
    expect(after.project).toBe(before.project);
    const manual = await savePriceRule(owner, null, {
      brand: "New",
      model: "Model",
      project: "Project",
      suggested: "25",
    });
    await deletePriceRules(owner, [manual.id]);
    expect(await db.priceRule.count()).toBe(0);
  });
  it("deletes a price rule without losing an order's part quote snapshot", async () => {
    const { product, rule, option } = await configureRepairOption(
      "Deleted rule part test",
    );
    const order = await createOrder(
      owner,
      input({
        deposit: "0",
        items: [
          {
            project: "Display",
            final: "79",
            priceOptionId: option.id,
            requiredProductId: product.id,
          },
        ],
      }),
    );

    await deletePriceRules(owner, [rule.id]);

    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(saved.items[0]).toMatchObject({
      ruleId: null,
      priceOptionId: null,
      priceOptionName: "Deleted rule part test",
      requiredProductId: product.id,
      requiredProductName: product.name,
      requiredQuantity: 1,
    });
    expect(saved.items[0].suggested?.toString()).toBe("79");
    expect(saved.items[0].final.toString()).toBe("79");
    expect(
      saved.products.find(
        (line) => line.kind === "REPAIR_PART" && !line.consumedAt,
      ),
    ).toMatchObject({ productId: product.id, quantity: 1 });
  });
  it("persists fault deletion for presets and saved faults without changing existing orders", async () => {
    const order = await createOrder(
      owner,
      input({ faults: ["Display rotto"], fault: "" }),
    );
    await hideFault(owner, "PHONE", "Display rotto");
    await hideFault(owner, "PHONE", "Non si accende");
    expect(await db.faultOption.count({ where: { hidden: true } })).toBe(2);
    await restoreFault(owner, "PHONE", "Display rotto");
    expect(await db.faultOption.count({ where: { hidden: true } })).toBe(1);
    expect(
      await db.faultOption.findUniqueOrThrow({
        where: {
          category_key: { category: "PHONE", key: "display rotto" },
        },
      }),
    ).toMatchObject({ hidden: false });
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: order.id } })).fault,
    ).toBe("Display rotto");
  });
  it("manages ordered fault catalog entries without rewriting historical snapshots", async () => {
    const first = await saveFault(owner, null, {
      category: "PHONE",
      name: "Schermo intermittente",
      note: "",
      hidden: false,
    });
    const second = await saveFault(owner, null, {
      category: "PHONE",
      name: "Audio debole",
      note: "",
      hidden: false,
    });
    const order = await createOrder(
      owner,
      input({
        fault: "",
        faults: [],
        standardFaultIds: [first.id],
        customFaults: ["Il difetto compare solo a caldo"],
      }),
    );
    await saveFault(owner, first.id, {
      category: "PHONE",
      name: "Schermo lampeggiante",
      note: "",
      hidden: true,
    });
    await reorderFaults(owner, "PHONE", [second.id, first.id]);
    const snapshots = await db.workOrderFault.findMany({
      where: { orderId: order.id },
      orderBy: { custom: "asc" },
    });
    expect(snapshots.map((fault) => fault.nameSnapshot)).toEqual([
      "Schermo intermittente",
      "Il difetto compare solo a caldo",
    ]);
    await expect(deleteFault(owner, first.id)).rejects.toThrow("già usato");
    await deleteFault(owner, second.id);
    expect(
      await db.faultOption.findUnique({ where: { id: second.id } }),
    ).toBeNull();
  });
  it("normalizes brand and model names and isolates identical quotes by device type", async () => {
    const phone = await createOrder(
      owner,
      input({
        brand: "apple",
        model: "iphone 16 pro max",
        items: [{ project: "Camera", final: "80", saveRule: true }],
      }),
    );
    const storedPhone = await db.workOrder.findUniqueOrThrow({
      where: { id: phone.id },
      include: { device: true },
    });
    expect(storedPhone.device.brand).toBe("Apple");
    expect(storedPhone.device.model).toBe("iPhone 16 Pro Max");
    const compact = await createOrder(
      owner,
      input({
        phone: "3338888888",
        model: "iphone18promax",
        items: [{ project: "Battery", final: "60" }],
      }),
    );
    expect(
      (
        await db.workOrder.findUniqueOrThrow({
          where: { id: compact.id },
          include: { device: true },
        })
      ).device.model,
    ).toBe("iPhone 18 Pro Max");
    const tablet = await savePriceRule(owner, null, {
      category: "TABLET",
      brand: "APPLE",
      model: "iphone 16 pro max",
      project: "Camera",
      suggested: "90",
    });
    expect(tablet).toMatchObject({
      category: "TABLET",
      brand: "Apple",
      model: "iPhone 16 Pro Max",
    });
    expect(
      await db.priceRule.count({
        where: {
          brand: "Apple",
          model: "iPhone 16 Pro Max",
          project: "camera",
        },
      }),
    ).toBe(2);
  });
  it("failed order creation does not write a new model or price", async () => {
    await expect(
      createOrder(
        owner,
        input({
          model: "Never Saved",
          items: [{ project: "Brand New", final: "10" }],
          deposit: "11",
        }),
      ),
    ).rejects.toThrow("supera");
    expect(await db.priceRule.count({ where: { model: "Never Saved" } })).toBe(
      0,
    );
    expect(await db.device.count()).toBe(0);
  });
});

describe("unified product inventory", () => {
  it("updates product fields and stock atomically, then archives batch deletions", async () => {
    const product = await createProduct(staff, {
      requestId: randomUUID(),
      name: "Cavo USB",
      category: "Cavi",
      usage: "RETAIL",
      costPrice: "2.50",
      salePrice: "8",
      initialStock: 4,
      minStock: 1,
    });
    await updateProduct(staff, product.id, {
      name: "Cavo USB-C",
      category: "Accessori",
      usage: "RETAIL",
      costPrice: "3",
      salePrice: "10",
      stockQuantity: 7,
      minStock: 2,
      favorite: true,
    });
    expect(
      await db.product.findUniqueOrThrow({ where: { id: product.id } }),
    ).toMatchObject({
      name: "Cavo USB-C",
      category: "Accessori",
      usage: "RETAIL",
      stockQuantity: 7,
      minStock: 2,
      favorite: true,
    });
    expect(
      await db.inventoryMovement.findFirstOrThrow({
        where: { productId: product.id, type: "MANUAL_ADJUSTMENT" },
      }),
    ).toMatchObject({ quantity: 3, stockBefore: 4, stockAfter: 7 });
    await deleteProducts(staff, [product.id]);
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: product.id } }))
        .enabled,
    ).toBe(false);
  });

  it("retires repair options when a product changes usage without changing history", async () => {
    const {
      product: retiring,
      rule,
      option: retiringOption,
    } = await configureRepairOption("Retired usage option", 2, "79");
    const fallback = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Fallback usage option",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "44",
      salePrice: "0",
      initialStock: 7,
      minStock: 0,
    });
    const fallbackOption = await savePriceRuleOption(owner, rule.id, null, {
      productId: fallback.id,
      name: "Fallback usage option",
      suggested: "119",
      cost: "44",
      quantity: 3,
      minutes: 75,
      warrantyDays: 90,
      enabled: true,
      isDefault: false,
      notes: "",
    });
    const manuallyDisabled = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Manually disabled usage option",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "22",
      salePrice: "0",
      initialStock: 2,
      minStock: 0,
    });
    const disabledOption = await savePriceRuleOption(owner, rule.id, null, {
      productId: manuallyDisabled.id,
      name: "Manually disabled usage option",
      suggested: "59",
      cost: "22",
      quantity: 1,
      minutes: 40,
      warrantyDays: 0,
      enabled: false,
      isDefault: false,
      notes: "",
    });
    const order = await createOrder(
      staff,
      input({ deposit: "0", items: [{ project: "Display", final: "79" }] }),
    );
    const before = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(before.items[0]).toMatchObject({
      priceOptionId: retiringOption.id,
      requiredProductId: retiring.id,
      requiredProductName: retiring.name,
      requiredQuantity: 2,
    });
    expect(before.products).toContainEqual(
      expect.objectContaining({
        productId: retiring.id,
        quantity: 2,
        kind: "REPAIR_PART",
      }),
    );

    await updateProduct(owner, retiring.id, {
      name: retiring.name,
      category: retiring.category,
      usage: "RETAIL",
      costPrice: retiring.costPrice.toString(),
      salePrice: retiring.salePrice.toString(),
      stockQuantity: retiring.stockQuantity,
      minStock: retiring.minStock,
      favorite: retiring.favorite,
      compatibilities: [],
    });

    const retiredOption = await db.priceRuleOption.findUniqueOrThrow({
      where: { id: retiringOption.id },
    });
    const remainingOption = await db.priceRuleOption.findUniqueOrThrow({
      where: { id: fallbackOption.id },
    });
    expect(retiredOption).toMatchObject({ enabled: false, isDefault: false });
    expect(remainingOption).toMatchObject({ enabled: true, isDefault: true });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: disabledOption.id },
      }),
    ).toMatchObject({ enabled: false, isDefault: false });
    const savedRule = await db.priceRule.findUniqueOrThrow({
      where: { id: rule.id },
    });
    expect(savedRule).toMatchObject({
      requiredProductId: fallback.id,
      requiredQuantity: 3,
      minutes: 60,
    });
    expect(savedRule.suggested.toString()).toBe("79");
    expect(savedRule.cost?.toString()).toBe("32");
    const priceRuleView = priceRuleViews([
      await db.priceRule.findUniqueOrThrow({
        where: { id: rule.id },
        include: { options: { include: { product: true } } },
      }),
    ]).find((candidate) => candidate.id === rule.id);
    expect(
      priceRuleView?.options
        ?.filter((candidate) => candidate.enabled)
        .map(({ id }) => id),
    ).toEqual([fallbackOption.id]);
    await expect(
      createOrder(
        staff,
        input({
          deposit: "0",
          items: [
            {
              project: "Display",
              final: "79",
              priceOptionId: retiringOption.id,
              requiredProductId: retiring.id,
              requiredQuantity: 2,
            },
          ],
        }),
      ),
    ).rejects.toThrow();

    await replaceQuote(staff, order.id, {
      items: [
        {
          project: before.items[0].project,
          final: before.items[0].final.toString(),
          priceOptionId: before.items[0].priceOptionId ?? undefined,
          requiredProductId: before.items[0].requiredProductId ?? undefined,
          requiredQuantity: before.items[0].requiredQuantity,
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });
    const afterEdit = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, products: true },
    });
    expect(afterEdit.items[0]).toMatchObject({
      priceOptionId: retiringOption.id,
      priceOptionName: retiringOption.name,
      suggested: retiringOption.suggested,
      requiredProductId: retiring.id,
      requiredProductName: retiring.name,
      requiredQuantity: 2,
    });
    expect(afterEdit.products).toContainEqual(
      expect.objectContaining({
        productId: retiring.id,
        quantity: 2,
        kind: "REPAIR_PART",
        consumedAt: null,
      }),
    );

    await updateProduct(owner, retiring.id, {
      name: retiring.name,
      category: retiring.category,
      usage: "REPAIR",
      costPrice: retiring.costPrice.toString(),
      salePrice: retiring.salePrice.toString(),
      stockQuantity: retiring.stockQuantity,
      minStock: retiring.minStock,
      favorite: retiring.favorite,
      compatibilities: [],
    });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: retiringOption.id },
      }),
    ).toMatchObject({ enabled: false, isDefault: false });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: disabledOption.id },
      }),
    ).toMatchObject({ enabled: false, isDefault: false });
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: fallbackOption.id },
      }),
    ).toMatchObject({ enabled: true, isDefault: true });
  });

  it("creates initial stock and records idempotent stock changes", async () => {
    const product = await createProduct(staff, {
      requestId: randomUUID(),
      name: "Batteria iPhone 15",
      category: "Batterie",
      usage: "REPAIR",
      costPrice: "32.50",
      salePrice: "65",
      initialStock: 8,
      minStock: 3,
      favorite: true,
      enabled: true,
    });
    const requestId = randomUUID();
    const adjustment = {
      requestId,
      quantity: 5,
      type: "STOCK_IN",
      note: "Consegna fornitore",
    };
    await adjustInventory(staff, product.id, adjustment);
    await adjustInventory(staff, product.id, adjustment);

    expect(
      await db.product.findUniqueOrThrow({ where: { id: product.id } }),
    ).toMatchObject({
      stockQuantity: 13,
      minStock: 3,
    });
    expect(
      await db.inventoryMovement.findMany({
        where: { productId: product.id },
        orderBy: { createdAt: "asc" },
      }),
    ).toMatchObject([
      { quantity: 8, stockBefore: 0, stockAfter: 8, type: "INITIAL_STOCK" },
      { quantity: 5, stockBefore: 8, stockAfter: 13, type: "STOCK_IN" },
    ]);
  });

  it("prevents negative stock under concurrent adjustments", async () => {
    const product = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Display OLED",
      category: "Schermi",
      usage: "REPAIR",
      costPrice: "80",
      salePrice: "150",
      initialStock: 10,
      minStock: 2,
    });
    const results = await Promise.allSettled([
      adjustInventory(staff, product.id, {
        requestId: randomUUID(),
        quantity: -8,
        type: "MANUAL_ADJUSTMENT",
        note: "Verifica concorrenza A",
      }),
      adjustInventory(staff, product.id, {
        requestId: randomUUID(),
        quantity: -8,
        type: "MANUAL_ADJUSTMENT",
        note: "Verifica concorrenza B",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stockQuantity,
    ).toBe(2);
    expect(
      await db.inventoryMovement.count({ where: { productId: product.id } }),
    ).toBe(2);
  });
});

describe("work order products and combined checkout", () => {
  it("reserves repair stock in order and releases it after cancellation", async () => {
    const part = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Batteria prenotata test",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "20",
      salePrice: "0",
      initialStock: 1,
      minStock: 0,
    });
    await savePriceRule(owner, null, {
      brand: "Apple",
      model: "iPhone 13",
      project: "Batteria reservation",
      suggested: "60",
      minutes: 30,
      enabled: true,
      requiredProductId: part.id,
      requiredQuantity: 1,
    });
    const first = await createOrder(
      staff,
      input({
        phone: "3331111111",
        deposit: "0",
        items: [
          {
            project: "Batteria reservation",
            final: "60",
            adjustmentReason: "",
          },
        ],
      }),
    );
    const second = await createOrder(
      staff,
      input({
        phone: "3332222222",
        deposit: "0",
        items: [
          {
            project: "Batteria reservation",
            final: "60",
            adjustmentReason: "",
          },
        ],
      }),
    );
    expect(first.status).toBe("REPAIRING");
    expect(second.status).toBe("PARTS_MISSING");
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: part.id } }))
        .stockQuantity,
    ).toBe(1);
    expect(
      await db.workOrderProduct.aggregate({
        where: { productId: part.id, consumedAt: null },
        _sum: { quantity: true },
      }),
    ).toMatchObject({ _sum: { quantity: 2 } });

    await changeStatus(staff, first.id, {
      status: "CANCELLED",
      note: "Cliente rinuncia",
    });
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: second.id } }))
        .status,
    ).toBe("REPAIRING");

    await changeStatus(staff, second.id, { status: "READY" });
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: part.id } }))
        .stockQuantity,
    ).toBe(0);
    expect(
      await db.workOrderProduct.count({
        where: { orderId: second.id, consumedAt: { not: null } },
      }),
    ).toBe(1);
  });

  it("releases a repair reservation when the quote removes the part", async () => {
    const part = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Ricambio rimosso test",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "10",
      salePrice: "0",
      initialStock: 1,
      minStock: 0,
    });
    await savePriceRule(owner, null, {
      brand: "Apple",
      model: "iPhone 13",
      project: "Rimozione reservation",
      suggested: "40",
      minutes: 30,
      enabled: true,
      requiredProductId: part.id,
      requiredQuantity: 1,
    });
    const first = await createOrder(
      staff,
      input({
        phone: "3333333333",
        deposit: "0",
        items: [{ project: "Rimozione reservation", final: "40" }],
      }),
    );
    const second = await createOrder(
      staff,
      input({
        phone: "3334444444",
        deposit: "0",
        items: [{ project: "Rimozione reservation", final: "40" }],
      }),
    );
    const third = await createOrder(
      staff,
      input({
        phone: "3335555555",
        deposit: "0",
        items: [{ project: "Rimozione reservation", final: "40" }],
      }),
    );
    expect(second.status).toBe("PARTS_MISSING");
    expect(third.status).toBe("PARTS_MISSING");

    await replaceQuote(staff, third.id, {
      items: [
        {
          project: "Rimozione reservation",
          final: "40",
          requiredProductRemoved: true,
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });

    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: third.id } }))
        .status,
    ).toBe("REPAIRING");
    expect(
      await db.workOrderProduct.count({
        where: {
          orderId: third.id,
          kind: "REPAIR_PART",
          consumedAt: null,
        },
      }),
    ).toBe(0);

    await replaceQuote(owner, first.id, {
      items: [
        {
          project: "Rimozione reservation",
          final: "40",
          requiredProductRemoved: true,
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });

    expect(
      await db.workOrderProduct.count({
        where: { orderId: first.id, kind: "REPAIR_PART", consumedAt: null },
      }),
    ).toBe(0);
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: second.id } }))
        .status,
    ).toBe("REPAIRING");
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: part.id } }))
        .stockQuantity,
    ).toBe(1);
  });

  it("recreates a repair reservation after the previous part was consumed", async () => {
    const part = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Ricambio riaperto test",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "10",
      salePrice: "0",
      initialStock: 2,
      minStock: 0,
    });
    await savePriceRule(owner, null, {
      brand: "Apple",
      model: "iPhone 13",
      project: "Riapertura reservation",
      suggested: "40",
      minutes: 30,
      enabled: true,
      requiredProductId: part.id,
      requiredQuantity: 1,
    });
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        dueDate: "2026-10-02",
        items: [{ project: "Riapertura reservation", final: "40" }],
      }),
    );

    await changeStatus(staff, order.id, { status: "READY" });
    await changeStatus(staff, order.id, { status: "REPAIRING" });
    await replaceQuote(owner, order.id, {
      items: [
        {
          project: "Riapertura reservation",
          final: "40",
          requiredProductId: part.id,
          requiredQuantity: 1,
        },
      ],
      orderDiscount: "0",
      includeVat: false,
    });

    const lines = await db.workOrderProduct.findMany({
      where: { orderId: order.id, productId: part.id, kind: "REPAIR_PART" },
      orderBy: { createdAt: "asc" },
    });
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.consumedAt)).toHaveLength(1);
    expect(lines.filter((line) => !line.consumedAt)).toHaveLength(1);
    expect(new Set(lines.map((line) => line.contextKey)).size).toBe(2);
  });

  it("does not add new repair-part reservations to a READY order", async () => {
    const firstPart = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Ricambio iniziale",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "10",
      salePrice: "0",
      initialStock: 2,
      minStock: 0,
    });
    const replacementPart = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Ricambio nuovo",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "12",
      salePrice: "0",
      initialStock: 2,
      minStock: 0,
    });
    await savePriceRule(owner, null, {
      brand: "Apple",
      model: "iPhone 13",
      project: "READY ricambio",
      suggested: "40",
      minutes: 30,
      enabled: true,
      requiredProductId: firstPart.id,
      requiredQuantity: 1,
    });
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [{ project: "READY ricambio", final: "40" }],
      }),
    );
    await changeStatus(staff, order.id, { status: "READY" });

    await expect(
      replaceQuote(staff, order.id, {
        items: [
          {
            project: "READY ricambio",
            final: "45",
            requiredProductId: replacementPart.id,
            requiredQuantity: 1,
          },
        ],
        orderDiscount: "0",
        includeVat: false,
      }),
    ).rejects.toThrow("riaprire");
    expect(
      await db.workOrderProduct.count({
        where: {
          orderId: order.id,
          productId: replacementPart.id,
          consumedAt: null,
        },
      }),
    ).toBe(0);
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("READY");
  });

  it("blocks delivery while a repair part remains unconsumed", async () => {
    const part = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Ricambio da verificare",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "10",
      salePrice: "0",
      initialStock: 2,
      minStock: 0,
    });
    const order = await createOrder(staff, input({ deposit: "0" }));
    await changeStatus(staff, order.id, { status: "READY" });
    await db.workOrderProduct.create({
      data: {
        orderId: order.id,
        productId: part.id,
        productName: part.name,
        category: part.category,
        kind: "REPAIR_PART",
        unitPrice: "0",
        quantity: 1,
      },
    });

    await expect(
      checkoutWorkOrder(staff, order.id, {
        requestId: randomUUID(),
        amount: "0",
        method: "CASH",
        pickedUpBy: "Test Cliente",
      }),
    ).rejects.toThrow("non registrati");
    await expect(
      changeStatus(staff, order.id, {
        status: "COMPLETED",
        pickedUpBy: "Test Cliente",
      }),
    ).rejects.toThrow("non registrati");
  });

  it("keeps partial payments separate from delivery checkout", async () => {
    const order = await createOrder(staff, input({ deposit: "20" }));
    await changeStatus(staff, order.id, { status: "REPAIRING" });
    await changeStatus(staff, order.id, { status: "READY" });

    await expect(
      checkoutWorkOrder(staff, order.id, {
        requestId: randomUUID(),
        amount: "79",
        method: "CASH",
        pickedUpBy: "Test Cliente",
      }),
    ).rejects.toThrow("saldare tutto il saldo");

    await addPayment(staff, order.id, {
      requestId: randomUUID(),
      amount: "79",
      method: "CASH",
      kind: "BALANCE",
    });

    const partial = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: true },
    });
    expect(partial.status).toBe("READY");
    expect(
      partial.payments.map((payment) => payment.amount.toString()),
    ).toEqual(expect.arrayContaining(["20", "79"]));
    expect(
      await db.auditLog.count({
        where: { entityId: order.id, action: "PAYMENT_ADDED" },
      }),
    ).toBe(2);

    const deliveredAt = "2026-09-27T12:30:00.000Z";
    await checkoutWorkOrder(staff, order.id, {
      requestId: randomUUID(),
      amount: "1",
      method: "CARD",
      pickedUpBy: "Test Cliente",
      pickedUpAt: deliveredAt,
    });
    const completed = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.pickedUpAt?.toISOString()).toBe(deliveredAt);
  });

  it("deducts repair parts at READY once and allocates combined payment", async () => {
    const part = await createProduct(staff, {
      requestId: randomUUID(),
      name: "Display OLED test",
      category: "Schermi",
      usage: "REPAIR",
      costPrice: "40",
      salePrice: "80",
      initialStock: 3,
      minStock: 1,
    });
    const addon = await createProduct(staff, {
      requestId: randomUUID(),
      name: "Vetro aggiuntivo test",
      category: "Pellicole",
      usage: "RETAIL",
      costPrice: "2",
      salePrice: "15",
      initialStock: 5,
      minStock: 1,
    });
    const order = await createOrder(staff, input());
    await addWorkOrderProduct(staff, order.id, {
      productId: part.id,
      kind: "REPAIR_PART",
      quantity: 1,
    });
    await addWorkOrderProduct(staff, order.id, {
      productId: addon.id,
      kind: "RETAIL_ADDON",
      quantity: 1,
    });
    await changeStatus(staff, order.id, { status: "REPAIRING" });
    await changeStatus(staff, order.id, { status: "READY" });
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: part.id } }))
        .stockQuantity,
    ).toBe(2);
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: addon.id } }))
        .stockQuantity,
    ).toBe(5);

    await changeStatus(staff, order.id, { status: "REPAIRING" });
    await changeStatus(staff, order.id, { status: "READY" });
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: part.id } }))
        .stockQuantity,
    ).toBe(2);

    await checkoutWorkOrder(staff, order.id, {
      requestId: randomUUID(),
      amount: "95",
      method: "CARD",
      pickedUpBy: "Test Cliente",
    });
    const completed = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: { include: { allocations: true } } },
    });
    expect(completed.status).toBe("COMPLETED");
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: addon.id } }))
        .stockQuantity,
    ).toBe(4);
    const allocations = completed.payments
      .flatMap((payment) => payment.allocations)
      .map((allocation) => [allocation.source, allocation.amount.toString()]);
    expect(allocations).toEqual(
      expect.arrayContaining([
        ["REPAIR", "20"],
        ["REPAIR", "80"],
        ["RETAIL", "15"],
      ]),
    );
    expect(
      await db.inventoryMovement.count({
        where: { referenceType: "WORK_ORDER", referenceId: order.id },
      }),
    ).toBe(2);
  });

  it("prevents removing an add-on after its value has been collected", async () => {
    const addon = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Cover già pagata",
      category: "Cover",
      usage: "RETAIL",
      costPrice: "3",
      salePrice: "20",
      initialStock: 2,
      minStock: 0,
    });
    const order = await createOrder(staff, input({ deposit: "0" }));
    const line = await addWorkOrderProduct(staff, order.id, {
      productId: addon.id,
      kind: "RETAIL_ADDON",
      quantity: 1,
    });
    await setPaidTotal(staff, order.id, {
      requestId: randomUUID(),
      amount: "120",
      method: "CASH",
      adjustmentReason: "Pagamento completo",
    });

    await expect(
      removeWorkOrderProduct(staff, order.id, line.id),
    ).rejects.toThrow("incassato");
    expect(await db.workOrderProduct.count({ where: { id: line.id } })).toBe(1);
  });

  it("reserves add-on stock across open work orders", async () => {
    const addon = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Cover prenotata test",
      category: "Cover",
      usage: "RETAIL",
      costPrice: "3",
      salePrice: "15",
      initialStock: 10,
      minStock: 0,
    });
    const firstOrder = await createOrder(
      staff,
      input({ dueDate: "2099-12-31" }),
    );
    const secondOrder = await createOrder(
      staff,
      input({
        requestId: randomUUID(),
        phone: "333 765 4321",
        dueDate: "2099-12-31",
      }),
    );
    await addWorkOrderProduct(staff, firstOrder.id, {
      productId: addon.id,
      kind: "RETAIL_ADDON",
      quantity: 10,
    });
    await expect(
      addWorkOrderProduct(staff, secondOrder.id, {
        productId: addon.id,
        kind: "RETAIL_ADDON",
        quantity: 1,
      }),
    ).rejects.toThrow("insufficienti");
    await expect(
      addWorkOrderProduct(staff, firstOrder.id, {
        productId: addon.id,
        kind: "RETAIL_ADDON",
        quantity: 10,
      }),
    ).resolves.toMatchObject({ quantity: 10 });
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: addon.id } }))
        .stockQuantity,
    ).toBe(10);
  });

  it("rolls back checkout when reserved add-on stock later becomes insufficient", async () => {
    const addon = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Cover insufficiente test",
      category: "Cover",
      usage: "RETAIL",
      costPrice: "3",
      salePrice: "15",
      initialStock: 2,
      minStock: 0,
    });
    const order = await createOrder(staff, input({ dueDate: "2099-12-31" }));
    await addWorkOrderProduct(staff, order.id, {
      productId: addon.id,
      kind: "RETAIL_ADDON",
      quantity: 2,
    });
    await adjustInventory(staff, addon.id, {
      requestId: randomUUID(),
      quantity: -1,
      type: "MANUAL_ADJUSTMENT",
      note: "Rettifica dopo prenotazione",
    });
    await changeStatus(staff, order.id, { status: "REPAIRING" });
    await changeStatus(staff, order.id, { status: "READY" });
    await expect(
      checkoutWorkOrder(staff, order.id, {
        requestId: randomUUID(),
        amount: "110",
        method: "CASH",
        pickedUpBy: "Test Cliente",
      }),
    ).rejects.toThrow("insufficienti");
    expect(
      (await db.workOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("READY");
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: addon.id } }))
        .stockQuantity,
    ).toBe(1);
  });
});

describe("retail checkout", () => {
  it("creates sale, payment, allocation and stock movements atomically", async () => {
    const cable = await createProduct(staff, {
      requestId: randomUUID(),
      name: "Cavo USB-C",
      category: "Ricarica",
      usage: "RETAIL",
      costPrice: "4",
      salePrice: "12",
      initialStock: 10,
      minStock: 2,
    });
    const glass = await createProduct(staff, {
      requestId: randomUUID(),
      name: "Vetro iPhone",
      category: "Pellicole",
      usage: "RETAIL",
      costPrice: "2",
      salePrice: "10",
      initialStock: 6,
      minStock: 2,
    });
    const requestId = randomUUID();
    const input = {
      requestId,
      items: [
        { productId: cable.id, quantity: 2 },
        { productId: glass.id, quantity: 1 },
      ],
      discount: "4",
      method: "CARD",
    };
    const first = await createRetailSale(staff, input);
    const second = await createRetailSale(staff, input);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ itemCount: 3 });
    expect(first.total.toString()).toBe("30");
    expect(await db.retailSaleItem.count({ where: { saleId: first.id } })).toBe(
      2,
    );
    const payment = await db.payment.findFirstOrThrow({
      where: { saleId: first.id },
      include: { allocations: true },
    });
    expect(payment).toMatchObject({ method: "CARD", kind: "SALE" });
    expect(payment.allocations).toMatchObject([
      { source: "RETAIL", amount: expect.objectContaining({}) },
    ]);
    expect(payment.allocations[0].amount.toString()).toBe("30");
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: cable.id } }))
        .stockQuantity,
    ).toBe(8);
    expect(
      await db.inventoryMovement.count({
        where: { referenceType: "RETAIL_SALE", referenceId: first.id },
      }),
    ).toBe(2);
  });

  it("rolls back the whole sale when any product lacks stock", async () => {
    const product = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Cover limitata",
      category: "Cover",
      usage: "RETAIL",
      costPrice: "3",
      salePrice: "15",
      initialStock: 1,
      minStock: 0,
    });
    await expect(
      createRetailSale(staff, {
        requestId: randomUUID(),
        items: [{ productId: product.id, quantity: 2 }],
        discount: "0",
        method: "CASH",
      }),
    ).rejects.toThrow("insufficienti");
    expect(await db.retailSale.count()).toBe(0);
    expect(await db.payment.count()).toBe(0);
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stockQuantity,
    ).toBe(1);
  });

  it("does not let a retail sale consume stock reserved by an open work order", async () => {
    const product = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Pellicola riservata",
      category: "Pellicole",
      usage: "RETAIL",
      costPrice: "2",
      salePrice: "10",
      initialStock: 2,
      minStock: 0,
    });
    const order = await createOrder(staff, input({ deposit: "0" }));
    await addWorkOrderProduct(staff, order.id, {
      productId: product.id,
      kind: "RETAIL_ADDON",
      quantity: 2,
    });

    await expect(
      createRetailSale(staff, {
        requestId: randomUUID(),
        items: [{ productId: product.id, quantity: 1 }],
        discount: "0",
        method: "CASH",
      }),
    ).rejects.toThrow("insufficienti");
    expect(await db.retailSale.count()).toBe(0);
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stockQuantity,
    ).toBe(2);
  });

  it("deletes a retail sale and restores its stock", async () => {
    const product = await createProduct(staff, {
      requestId: randomUUID(),
      name: "Prodotto da annullare",
      category: "Cover",
      usage: "RETAIL",
      costPrice: "3",
      salePrice: "15",
      initialStock: 5,
      minStock: 0,
    });
    const sale = await createRetailSale(staff, {
      requestId: randomUUID(),
      items: [{ productId: product.id, quantity: 2 }],
      services: [],
      discount: "0",
      method: "CASH",
    });

    await deleteRetailSale(staff, sale.id);

    expect(await db.retailSale.count({ where: { id: sale.id } })).toBe(0);
    expect(await db.payment.count({ where: { saleId: sale.id } })).toBe(0);
    expect(
      await db.inventoryMovement.count({
        where: { referenceType: "RETAIL_SALE", referenceId: sale.id },
      }),
    ).toBe(0);
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stockQuantity,
    ).toBe(5);
    expect(
      await db.auditLog.count({
        where: { entityId: sale.id, action: "RETAIL_SALE_DELETED" },
      }),
    ).toBe(1);
    expect(
      await db.auditLog.count({
        where: { entityId: sale.id, action: "RETAIL_SALE_COMPLETED" },
      }),
    ).toBe(1);
  });

  it("classifies quick services separately without changing inventory", async () => {
    const service = await saveQuickService(owner, null, {
      name: "Trasferimento dati",
      defaultPrice: "30",
      notes: "",
      enabled: true,
    });
    const sale = await createRetailSale(staff, {
      requestId: randomUUID(),
      items: [],
      services: [{ serviceId: service.id, price: "25", quantity: 1 }],
      discount: "0",
      method: "CARD",
    });
    expect(sale.code).toMatch(/^V-\d{8}001$/);
    expect(sale.serviceItems).toMatchObject([
      { serviceName: "Trasferimento dati", quantity: 1 },
    ]);
    expect(await db.inventoryMovement.count()).toBe(0);
    const allocations = await db.paymentAllocation.findMany({
      where: { payment: { saleId: sale.id } },
    });
    expect(allocations.map((entry) => entry.source)).toEqual(["QUICK_SERVICE"]);
    expect(allocations[0].amount.toString()).toBe("25");
  });

  it("deletes quick services without changing retail history", async () => {
    const service = await saveQuickService(owner, null, {
      name: "Servizio eliminabile",
      defaultPrice: "30",
      notes: "Snapshot storico",
      enabled: true,
    });
    const sale = await createRetailSale(staff, {
      requestId: randomUUID(),
      items: [],
      services: [{ serviceId: service.id, price: "25", quantity: 1 }],
      discount: "0",
      method: "CARD",
    });

    await deleteQuickService(owner, service.id);

    expect(await db.quickService.count({ where: { id: service.id } })).toBe(0);
    const historicalItem = await db.retailServiceItem.findFirstOrThrow({
      where: { saleId: sale.id },
    });
    expect(historicalItem).toMatchObject({
      quickServiceId: null,
      serviceName: "Servizio eliminabile",
    });
    expect(historicalItem.unitPrice.toString()).toBe("25");
    expect(
      await db.auditLog.count({
        where: { entityId: service.id, action: "QUICK_SERVICE_DELETED" },
      }),
    ).toBe(1);
  });
});

describe("quick service orders", () => {
  it("creates an S order with multiple devices and an independent sequence", async () => {
    const customer = await saveCustomer(owner, null, {
      name: "Migrazione cliente",
      phone: "3331010123",
      additionalPhones: [],
    });
    const firstDevice = await createDevice(owner, customer.id, {
      category: "PHONE",
      brand: "Samsung",
      model: "galaxya265g",
      imei: "",
    });
    const secondDevice = await createDevice(owner, customer.id, {
      category: "PHONE",
      brand: "Samsung",
      model: "Galaxy S24",
      imei: "",
    });
    const service = await saveQuickService(owner, null, {
      name: "Migrazione completa",
      defaultPrice: "40",
      notes: "Due telefoni",
      enabled: true,
    });
    const repair = await createOrder(owner, input({ deposit: "0" }));
    const order = await createQuickServiceOrder(staff, {
      requestId: randomUUID(),
      customerId: customer.id,
      deviceIds: [firstDevice.id, secondDevice.id],
      services: [{ serviceId: service.id, price: "35" }],
      expectedAt: "2099-12-31T18:30",
    });
    expect(repair.code).toBe("R-20261001001");
    expect(order.code).toBe("S-20261001001");
    const saved = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { relatedDevices: true, items: true },
    });
    expect(saved).toMatchObject({
      type: "QUICK_SERVICE",
      status: "RECEIVED",
      expectedAt: "2099-12-31T18:30",
    });
    await updateDueDate(staff, order.id, "2099-12-30T17:45");
    const rescheduled = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(rescheduled).toMatchObject({
      expectedAt: "2099-12-30T17:45",
      dueDate: "2099-12-30",
    });
    expect(saved.relatedDevices).toHaveLength(2);
    expect(saved.items[0].final.toString()).toBe("35");
    await updateQuickServiceOrder(staff, order.id, {
      expectedAt: "2099-12-29T18:00",
      notes: "Nota aggiornata",
      items: [
        {
          id: saved.items[0].id,
          project: "Migrazione completata",
          final: "40",
        },
      ],
    });
    const edited = await db.workOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(edited).toMatchObject({
      expectedAt: "2099-12-29T18:00",
      dueDate: "2099-12-29",
      notes: "Nota aggiornata",
    });
    expect(edited.items[0]).toMatchObject({ project: "Migrazione completata" });
    expect(edited.items[0].final.toString()).toBe("40");
    expect(
      (await db.device.findUniqueOrThrow({ where: { id: firstDevice.id } }))
        .model,
    ).toBe("Galaxy A26 5G");
    await deleteWorkOrder(owner, order.id, { code: order.code });
    expect(await db.workOrder.count({ where: { id: order.id } })).toBe(0);

    const paidOrder = await createQuickServiceOrder(staff, {
      requestId: randomUUID(),
      customerId: customer.id,
      deviceIds: [firstDevice.id],
      services: [{ serviceId: service.id, price: "35" }],
      expectedAt: "2099-12-31T18:30",
    });
    const paidItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: paidOrder.id },
    });
    await addPayment(staff, paidOrder.id, {
      requestId: randomUUID(),
      amount: "20",
      method: "CASH",
      kind: "BALANCE",
    });
    await expect(
      updateQuickServiceOrder(staff, paidOrder.id, {
        expectedAt: "2099-12-31T18:30",
        notes: "",
        items: [
          { id: paidItem.id, project: "Migrazione completa", final: "19.99" },
        ],
      }),
    ).rejects.toThrow("inferiore agli incassi");
  });
});

describe("service order safety", () => {
  it("can charge the diagnostic fee while cancelling and then blocks deletion", async () => {
    const order = await createOrder(
      staff,
      input({
        inspectionMode: true,
        faults: [],
        fault: "",
        items: [],
        diagnosticFee: "12.50",
        deposit: "0",
      }),
    );
    await changeStatus(staff, order.id, {
      status: "CANCELLED",
      note: "Cliente rinuncia",
      cancelPayment: {
        requestId: randomUUID(),
        amount: "12.50",
        method: "CASH",
      },
    });
    const payment = await db.payment.findFirstOrThrow({
      where: { orderId: order.id },
      include: { allocations: true },
    });
    expect(payment.amount.toString()).toBe("12.5");
    expect(payment.allocations).toMatchObject([{ source: "REPAIR" }]);
    await expect(
      deleteWorkOrder(owner, order.id, { code: order.code }),
    ).rejects.toThrow("incassi");
  });

  it("renames devices, quotes and compatible parts while merging duplicates", async () => {
    const product = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Display A26",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "20",
      salePrice: "0",
      initialStock: 2,
      minStock: 0,
    });
    const customer = await saveCustomer(owner, null, {
      name: "Modello errato",
      phone: "3331010456",
      additionalPhones: [],
    });
    await db.device.create({
      data: {
        customerId: customer.id,
        category: "PHONE",
        brand: "Samsung",
        model: "A265G",
      },
    });
    await db.priceRule.create({
      data: {
        category: "PHONE",
        brand: "Samsung",
        model: "A265G",
        project: "Display",
        suggested: "90",
        requiredProductId: product.id,
      },
    });
    await savePriceRule(owner, null, {
      category: "PHONE",
      brand: "Samsung",
      model: "A26 5G",
      project: "Display",
      suggested: "95",
      requiredProductId: product.id,
      requiredQuantity: 1,
    });
    await db.productCompatibility.create({
      data: {
        productId: product.id,
        category: "PHONE",
        brand: "Samsung",
        model: "A265G",
        project: "display",
      },
    });
    await renameDeviceModel(owner, {
      category: "PHONE",
      brand: "Samsung",
      from: "A265G",
      to: "A26 5G",
    });
    expect(
      await db.device.count({ where: { brand: "Samsung", model: "A26 5G" } }),
    ).toBe(1);
    expect(
      await db.priceRule.count({
        where: { brand: "Samsung", model: "A26 5G", project: "Display" },
      }),
    ).toBe(1);
    expect(
      await db.productCompatibility.count({
        where: { productId: product.id, model: "A26 5G" },
      }),
    ).toBe(1);
  });
});

describe("versioned data backup and merge import", () => {
  it("exports, clears, restores and skips an identical second import", async () => {
    const usersBefore = await db.user.count();
    const product = await createProduct(owner, {
      requestId: randomUUID(),
      name: "Vetro backup",
      category: "Pellicole",
      usage: "RETAIL",
      costPrice: "2",
      salePrice: "10",
      initialStock: 6,
      minStock: 2,
    });
    const repairProduct = await createProduct(owner, {
      requestId: randomUUID(),
      name: "OLED backup",
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "45",
      salePrice: "0",
      initialStock: 3,
      minStock: 1,
    });
    const displayRule = await db.priceRule.findFirstOrThrow({
      where: { project: "display" },
    });
    const priceOption = await savePriceRuleOption(owner, displayRule.id, null, {
      productId: repairProduct.id,
      name: "OLED backup",
      suggested: "119",
      cost: "45",
      quantity: 1,
      minutes: 75,
      warrantyDays: 180,
      enabled: true,
      isDefault: true,
      notes: "Backup option",
    });
    await createRetailSale(owner, {
      requestId: randomUUID(),
      items: [{ productId: product.id, quantity: 2 }],
      discount: "0",
      method: "CASH",
    });
    const order = await createOrder(
      owner,
      input({
        model: "iphone18promax",
        faults: ["Backup fault"],
        deposit: "100",
      }),
    );
    await addWorkOrderProduct(owner, order.id, {
      productId: product.id,
      kind: "RETAIL_ADDON",
      quantity: 1,
    });
    const backup = await exportBusinessData();
    expect(backup).toMatchObject({
      format: "ngt-repair-data",
      version: 10,
    });
    expect(backup.data.orders).toHaveLength(1);
    expect(backup.data.payments.map((payment) => payment.kind).sort()).toEqual([
      "BALANCE",
      "SALE",
    ]);
    expect(backup.data.products).toHaveLength(2);
    expect(backup.data.priceOptions).toHaveLength(1);
    expect(backup.data.inventoryMovements).toHaveLength(3);
    expect(backup.data.retailSales).toHaveLength(1);
    expect(backup.data.retailSaleItems).toHaveLength(1);
    expect(backup.data.paymentAllocations).toHaveLength(2);
    expect(backup.data.workOrderProducts).toHaveLength(1);
    expect(backup.data.inventoryCategories).toHaveLength(2);
    expect(backup.data.businessClock).toMatchObject({
      mode: "MANUAL",
      manualDate: testBusinessDay,
    });

    const conflict = structuredClone(backup);
    const originalOrderId = conflict.data.orders[0].id;
    const conflictingOrderId = randomUUID();
    conflict.data.orders[0].id = conflictingOrderId;
    for (const item of conflict.data.items) {
      if (item.orderId === originalOrderId) {
        item.id = randomUUID();
        item.orderId = conflictingOrderId;
      }
    }
    for (const payment of conflict.data.payments) {
      if (payment.orderId === originalOrderId) {
        payment.id = randomUUID();
        payment.requestId = randomUUID();
        payment.orderId = conflictingOrderId;
      }
    }
    for (const history of conflict.data.histories) {
      if (history.orderId === originalOrderId) {
        history.id = randomUUID();
        history.orderId = conflictingOrderId;
      }
    }
    for (const audit of conflict.data.audits) {
      if (audit.entityId === originalOrderId) {
        audit.id = randomUUID();
        audit.entityId = conflictingOrderId;
      }
    }
    const conflictResult = await importBusinessData(owner, conflict);
    expect(conflictResult.imported).toBe(0);
    expect(await db.workOrder.count()).toBe(1);
    expect(await db.workOrderItem.count()).toBe(1);

    await clearBusinessData(owner);
    expect(await db.workOrder.count()).toBe(0);
    expect(await db.customer.count()).toBe(0);
    expect(await db.product.count()).toBe(0);
    expect(await db.retailSale.count()).toBe(0);
    expect(await db.inventoryCategory.count()).toBe(0);
    expect(await db.businessClock.count()).toBe(0);
    expect(await db.user.count()).toBe(usersBefore);

    const first = await importBusinessData(owner, backup);
    expect(first.imported).toBeGreaterThan(0);
    expect(await db.workOrder.count()).toBe(1);
    expect(await db.customer.count()).toBe(1);
    expect(
      await db.product.findUniqueOrThrow({ where: { id: product.id } }),
    ).toMatchObject({ stockQuantity: 4 });
    expect(await db.inventoryMovement.count()).toBe(3);
    expect(await db.retailSale.count()).toBe(1);
    expect(await db.paymentAllocation.count()).toBe(2);
    expect(await db.workOrderProduct.count()).toBe(1);
    expect(await db.inventoryCategory.count()).toBe(2);
    expect(
      await db.priceRuleOption.findUniqueOrThrow({
        where: { id: priceOption.id },
      }),
    ).toMatchObject({
      productId: repairProduct.id,
      name: "OLED backup",
      warrantyDays: 180,
      isDefault: true,
    });
    expect(
      await db.businessClock.findUniqueOrThrow({ where: { id: "default" } }),
    ).toMatchObject({ mode: "MANUAL", manualDate: testBusinessDay });
    expect((await db.device.findFirstOrThrow()).model).toBe(
      "iPhone 18 Pro Max",
    );

    const second = await importBusinessData(owner, backup);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(await db.workOrder.count()).toBe(1);
    expect(await db.customer.count()).toBe(1);
  });

  it("restores a v9 legacy part rule and preserves its order and reservation through v10", async () => {
    const { product, rule, option } = await configureRepairOption(
      "V9 legacy LCD",
      2,
      "100",
    );
    const order = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [{ project: "Display", final: "100", priceOptionId: option.id }],
      }),
    );
    const beforeItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    const backup = await exportBusinessData();
    const legacy = structuredClone(backup) as unknown as {
      version: number;
      data: {
        priceOptions?: unknown;
        items: Record<string, unknown>[];
      };
    };
    legacy.version = 9;
    delete legacy.data.priceOptions;
    for (const item of legacy.data.items) {
      delete item.priceOptionId;
      delete item.priceOptionName;
      delete item.requiredProductName;
    }

    await clearBusinessData(owner);
    const firstImport = await importBusinessData(owner, legacy);
    expect(firstImport.imported).toBeGreaterThan(0);
    const restoredRule = await db.priceRule.findUniqueOrThrow({
      where: { id: rule.id },
      include: { options: { include: { product: true } } },
    });
    const convertedOption = restoredRule.options.find(
      (candidate) => candidate.productId === product.id,
    );
    expect(convertedOption).toMatchObject({
      enabled: true,
      isDefault: true,
      quantity: 2,
      name: product.name,
    });
    expect(convertedOption?.suggested.toString()).toBe("100");
    expect(
      priceRuleViews([restoredRule])[0].options?.find(
        (candidate) => candidate.productId === product.id,
      ),
    ).toMatchObject({ enabled: true, isDefault: true, suggested: "100" });
    const restoredItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(restoredItem).toMatchObject({
      ruleId: rule.id,
      priceOptionId: convertedOption?.id,
      priceOptionName: product.name,
      requiredProductId: product.id,
      requiredProductName: product.name,
      requiredQuantity: 2,
    });
    expect(restoredItem.suggested?.toString()).toBe(
      beforeItem.suggested?.toString(),
    );
    expect(restoredItem.final.toString()).toBe(beforeItem.final.toString());
    expect(
      await db.workOrderProduct.findFirstOrThrow({
        where: {
          orderId: order.id,
          productId: product.id,
          kind: "REPAIR_PART",
          consumedAt: null,
        },
      }),
    ).toMatchObject({ quantity: 2 });
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stockQuantity,
    ).toBe(5);
    expect(
      await db.inventoryMovement.count({ where: { productId: product.id } }),
    ).toBe(1);

    const secondImport = await importBusinessData(owner, legacy);
    expect(secondImport.imported).toBe(0);
    expect(
      await db.priceRuleOption.count({
        where: { ruleId: rule.id, productId: product.id },
      }),
    ).toBe(1);
    expect(
      await db.workOrderProduct.count({
        where: {
          orderId: order.id,
          productId: product.id,
          kind: "REPAIR_PART",
          consumedAt: null,
        },
      }),
    ).toBe(1);
    expect(
      await db.inventoryMovement.count({ where: { productId: product.id } }),
    ).toBe(1);

    const newOrder = await createOrder(
      staff,
      input({
        deposit: "0",
        items: [
          {
            project: "Display",
            final: "100",
            priceOptionId: convertedOption!.id,
          },
        ],
      }),
    );
    expect(
      await db.workOrderItem.findFirstOrThrow({
        where: { orderId: newOrder.id },
      }),
    ).toMatchObject({
      priceOptionId: convertedOption!.id,
      requiredProductId: product.id,
      requiredProductName: product.name,
    });

    const v10 = await exportBusinessData();
    expect(v10.version).toBe(10);
    expect(v10.data.priceOptions).toHaveLength(1);
    await clearBusinessData(owner);
    await importBusinessData(owner, v10);
    const finalItem = await db.workOrderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(finalItem).toMatchObject({
      priceOptionId: convertedOption!.id,
      requiredProductId: product.id,
      requiredProductName: product.name,
      requiredQuantity: 2,
    });
    expect(finalItem.suggested?.toString()).toBe(
      beforeItem.suggested?.toString(),
    );
    expect(finalItem.final.toString()).toBe(beforeItem.final.toString());
    expect(
      await db.workOrderProduct.count({
        where: {
          orderId: order.id,
          productId: product.id,
          kind: "REPAIR_PART",
          consumedAt: null,
        },
      }),
    ).toBe(1);
    expect(
      await db.priceRuleOption.count({
        where: { ruleId: rule.id, productId: product.id },
      }),
    ).toBe(1);
  });

  it("does not append stale quote lines when merging a backup into an existing order", async () => {
    const order = await createOrder(owner, input({ deposit: "0" }));
    const backup = await exportBusinessData();
    await replaceQuote(owner, order.id, [
      {
        project: "Display",
        final: "120",
        adjustmentReason: "Prezzo aggiornato",
      },
    ]);

    await importBusinessData(owner, backup);

    const currentItems = await db.workOrderItem.findMany({
      where: { orderId: order.id },
    });
    expect(currentItems).toHaveLength(1);
    expect(currentItems[0].final.toString()).toBe("120");
  });

  it("continues to accept version 1 backups without inventory arrays", async () => {
    const backup = await exportBusinessData();
    const legacy = structuredClone(backup) as unknown as {
      version: number;
      data: Record<string, unknown>;
    };
    legacy.version = 1;
    delete legacy.data.products;
    delete legacy.data.workOrderProducts;
    delete legacy.data.inventoryMovements;
    delete legacy.data.retailSales;
    delete legacy.data.retailSaleItems;
    delete legacy.data.paymentAllocations;
    await expect(importBusinessData(owner, legacy)).resolves.toEqual({
      imported: 0,
      skipped: expect.any(Number),
    });
  });
});

it("reuses deleted primary and extra numbers while retaining history and backup identity", async () => {
  const data = {
    name: "Customer A",
    phone: "3331234567",
    additionalPhones: ["3331234568", "3331234569"],
  };
  const original = await saveCustomer(owner, null, data);
  const order = await createOrder(owner, input());
  await deleteCustomer(owner, original.id);
  const replacement = await saveCustomer(owner, null, data);
  expect(replacement.id).not.toBe(original.id);
  expect(
    await db.customerPhone.count({ where: { customerId: original.id } }),
  ).toBe(3);
  expect(
    await db.customerPhone.count({ where: { customerId: replacement.id } }),
  ).toBe(3);
  await expect(saveCustomer(owner, null, data)).rejects.toThrow();
  await expect(
    saveCustomer(owner, null, {
      name: "Conflict",
      phone: "3339999999",
      additionalPhones: [data.additionalPhones[0]],
    }),
  ).rejects.toThrow("altro cliente");
  const historical = await db.workOrder.findUniqueOrThrow({
    where: { id: order.id },
    include: orderInclude,
  });
  expect(historical.device.customerId).toBe(original.id);
  const backup = await exportBusinessData();
  await clearBusinessData(owner);
  await importBusinessData(owner, backup);
  expect(await db.customer.count()).toBe(2);
  expect(
    (await db.customer.findUniqueOrThrow({ where: { id: original.id } }))
      .deletedAt,
  ).not.toBeNull();
  expect(
    (await db.customer.findUniqueOrThrow({ where: { id: replacement.id } }))
      .deletedAt,
  ).toBeNull();
  expect(
    (
      await db.workOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: orderInclude,
      })
    ).device.customerId,
  ).toBe(original.id);
});
it.each(["SMARTWATCH", "SMARTBAND"])(
  "saves %s quotes and devices",
  async (category) => {
    const quote = await savePriceRule(owner, null, {
      category,
      brand: "Apple",
      model: "Wearable",
      project: "Battery",
      suggested: "40",
    });
    expect(
      (await db.priceRule.findUniqueOrThrow({ where: { id: quote.id } }))
        .category,
    ).toBe(category);
    const order = await createOrder(
      owner,
      input({ category, model: "Wearable" }),
    );
    expect(
      (await db.device.findUniqueOrThrow({ where: { id: order.deviceId } }))
        .category,
    ).toBe(category);
  },
);

it("does not import an extra phone already owned by another active customer", async () => {
  const first = await saveCustomer(owner, null, {
    name: "First",
    phone: "3330000001",
  });
  const second = await saveCustomer(owner, null, {
    name: "Second",
    phone: "3330000002",
  });
  const backup = await exportBusinessData();
  backup.data.phones.push({ customerId: second.id, phone: "+393330000001" });
  await clearBusinessData(owner);
  await importBusinessData(owner, backup);
  expect(
    await db.customerPhone.findMany({ where: { phone: "+393330000001" } }),
  ).toEqual([{ phone: "+393330000001", customerId: first.id }]);
});

it("batch customer deletion is atomic and retains orders, payments and per-customer audit", async () => {
  const order = await createOrder(owner, input());
  const device = await db.device.findUniqueOrThrow({
    where: { id: order.deviceId },
  });
  const extra = await saveCustomer(owner, null, {
    name: "Batch extra",
    phone: "3339988776",
    additionalPhones: [],
  });
  await expect(
    deleteCustomers(owner, [device.customerId, "missing"]),
  ).rejects.toThrow("Clienti non disponibili");
  expect(await db.customer.count({ where: { deletedAt: null } })).toBe(2);
  expect(await db.device.count({ where: { deletedAt: null } })).toBe(1);
  await expect(deleteCustomers(owner, [])).rejects.toThrow();
  await expect(
    deleteCustomers(owner, Array(501).fill(extra.id)),
  ).rejects.toThrow();
  await db.user.update({ where: { id: staff.id }, data: { enabled: false } });
  await expect(deleteCustomers(staff, [extra.id])).rejects.toThrow("Sessione");
  await deleteCustomers(owner, [device.customerId, extra.id, extra.id]);
  expect(await db.customer.count({ where: { deletedAt: null } })).toBe(0);
  expect(await db.device.count({ where: { deletedAt: null } })).toBe(0);
  expect(await db.workOrder.count()).toBe(1);
  expect(await db.payment.count()).toBe(1);
  expect(
    await db.auditLog.count({ where: { action: "CUSTOMER_DELETED" } }),
  ).toBe(2);
});
