import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { randomUUID } from "node:crypto";
const db = new PrismaClient();
async function main() {
  if (!new URL(process.env.DATABASE_URL || "").pathname.endsWith("_test"))
    throw new Error("This script only accepts *_test databases.");
  await db.businessClock.deleteMany();
  await db.auditLog.deleteMany();
  await db.paymentAllocation.deleteMany();
  await db.payment.deleteMany();
  await db.retailServiceItem.deleteMany();
  await db.reworkItem.deleteMany();
  await db.reworkSession.deleteMany();
  await db.retailSaleItem.deleteMany();
  await db.retailSale.deleteMany();
  await db.workOrderProduct.deleteMany();
  await db.statusHistory.deleteMany();
  await db.workOrderFault.deleteMany();
  await db.workOrderDevice.deleteMany();
  await db.workOrderItem.deleteMany();
  await db.priceRuleOption.deleteMany();
  await db.priceRule.deleteMany();
  await db.inventoryMovement.deleteMany();
  await db.product.deleteMany();
  await db.inventoryCategory.deleteMany();
  await db.workOrder.deleteMany();
  await db.device.deleteMany();
  await db.customer.deleteMany();
  await db.quickService.deleteMany();
  await db.deviceCatalogDeletion.deleteMany();
  await db.faultOption.deleteMany();
  await db.user.deleteMany();
  const customer = await db.customer.create({
    data: { name: "Cliente Playwright", phone: "+393331234567" },
  });
  await db.device.create({
    data: {
      customerId: customer.id,
      category: "PHONE",
      brand: "Apple",
      model: "iPhone 13",
    },
  });
  await db.faultOption.createMany({
    data: [
      {
        category: "PHONE",
        name: "Display rotto",
        key: "display rotto",
        sortOrder: 0,
      },
      {
        category: "PHONE",
        name: "Non si accende",
        key: "non si accende",
        sortOrder: 1,
      },
      {
        category: "PHONE",
        name: "Danno da liquido",
        key: "danno da liquido",
        sortOrder: 2,
      },
      {
        category: "PHONE",
        name: "Problema di ricarica",
        key: "problema di ricarica",
        sortOrder: 3,
      },
    ],
  });
  const passwordHash = await hash("Test-Only-Password-2026", 12);
  await db.user.createMany({
    data: [
      { email: "owner@test.it", name: "Titolare", role: "OWNER", passwordHash },
      { email: "staff@test.it", name: "Tecnico", role: "STAFF", passwordHash },
    ],
  });
  await db.priceRule.create({
    data: {
      category: "PHONE",
      brand: "Apple",
      model: "iPhone 13",
      project: "sostituzione display",
      suggested: "100",
      minutes: 60,
      enabled: true,
    },
  });
  await db.quickService.createMany({
    data: [
      {
        name: "Configurazione smartphone Test",
        defaultPrice: "19.90",
        notes: "Servizio rapido al banco",
        enabled: true,
      },
      {
        name: "Servizio sospeso Test",
        defaultPrice: "15.00",
        notes: "Servizio rapido disattivato",
        enabled: false,
      },
    ],
  });
  const actor = await db.user.findUniqueOrThrow({
    where: { email: "owner@test.it" },
  });
  const productsByName = new Map<string, string>();
  for (const product of [
    {
      name: "Cavo USB-C Test",
      category: "Ricarica",
      usage: "RETAIL" as const,
      costPrice: "4.00",
      salePrice: "12.00",
      stockQuantity: 10,
      minStock: 2,
      favorite: true,
    },
    {
      name: "Batteria Test",
      category: "Batterie",
      usage: "REPAIR" as const,
      costPrice: "35.00",
      salePrice: "80.00",
      stockQuantity: 3,
      minStock: 1,
      favorite: true,
    },
    {
      name: "Display LCD Test",
      category: "Schermi",
      usage: "REPAIR" as const,
      costPrice: "32.00",
      salePrice: "0.00",
      stockQuantity: 5,
      minStock: 1,
      favorite: true,
    },
    {
      name: "Display OLED Test",
      category: "Schermi",
      usage: "REPAIR" as const,
      costPrice: "65.00",
      salePrice: "0.00",
      stockQuantity: 2,
      minStock: 1,
      favorite: true,
    },
    {
      name: "Retirement fixture LCD Test",
      category: "Schermi",
      usage: "REPAIR" as const,
      costPrice: "32.00",
      salePrice: "0.00",
      stockQuantity: 5,
      minStock: 1,
      favorite: false,
    },
    {
      name: "Cover esaurita Test",
      category: "Cover",
      usage: "RETAIL" as const,
      costPrice: "3.00",
      salePrice: "15.00",
      stockQuantity: 0,
      minStock: 2,
      favorite: false,
    },
  ]) {
    await db.inventoryCategory.upsert({
      where: { name: product.category },
      create: {
        name: product.category,
        repairOnly: product.usage === "REPAIR",
      },
      update: {},
    });
    const created = await db.product.create({ data: product });
    productsByName.set(product.name, created.id);
    if (product.name === "Batteria Test") {
      const rule = await db.priceRule.create({
        data: {
          category: "PHONE",
          brand: "Apple",
          model: "iPhone 14",
          project: "sostituzione batteria",
          suggested: "120",
          minutes: 60,
          enabled: true,
          requiredProductId: created.id,
        },
      });
      await db.priceRuleOption.create({
        data: {
          ruleId: rule.id,
          productId: created.id,
          name: created.name,
          suggested: "120",
          cost: created.costPrice,
          quantity: 1,
          minutes: 60,
          enabled: true,
          isDefault: true,
        },
      });
    }
    if (product.stockQuantity > 0)
      await db.inventoryMovement.create({
        data: {
          requestId: randomUUID(),
          productId: created.id,
          quantity: product.stockQuantity,
          stockBefore: 0,
          stockAfter: product.stockQuantity,
          type: "INITIAL_STOCK",
          referenceType: "PRODUCT",
          referenceId: created.id,
          actorId: actor.id,
          actorName: actor.name,
        },
      });
  }
  const displayRule = await db.priceRule.findFirstOrThrow({
    where: {
      category: "PHONE",
      brand: "Apple",
      model: "iPhone 13",
      project: "sostituzione display",
    },
  });
  await db.priceRuleOption.createMany({
    data: [
      {
        ruleId: displayRule.id,
        productId: productsByName.get("Display LCD Test")!,
        name: "Display LCD standard",
        suggested: "100.00",
        cost: "32.00",
        quantity: 1,
        minutes: 60,
        warrantyDays: 90,
        enabled: true,
        isDefault: true,
        sortOrder: 0,
      },
      {
        ruleId: displayRule.id,
        productId: productsByName.get("Display OLED Test")!,
        name: "Display OLED alta qualità",
        suggested: "119.00",
        cost: "65.00",
        quantity: 1,
        minutes: 75,
        warrantyDays: 180,
        enabled: true,
        isDefault: false,
        sortOrder: 1,
      },
    ],
  });
  await db.productCompatibility.createMany({
    data: ["Display LCD Test", "Display OLED Test"].map((name) => ({
      productId: productsByName.get(name)!,
      category: "PHONE",
      brand: "Apple",
      model: "iPhone 13",
      project: "sostituzione display",
    })),
  });
  const retirementFixtureProject = "sostituzione display retirement fixture";
  const retirementFixtureProductId = productsByName.get(
    "Retirement fixture LCD Test",
  )!;
  const retirementFixtureRule = await db.priceRule.create({
    data: {
      category: "PHONE",
      brand: "Apple",
      model: "iPhone 13",
      project: retirementFixtureProject,
      suggested: "30.00",
      minutes: 60,
      enabled: true,
      requiredProductId: retirementFixtureProductId,
      requiredQuantity: 1,
    },
  });
  await db.priceRuleOption.create({
    data: {
      ruleId: retirementFixtureRule.id,
      productId: retirementFixtureProductId,
      name: "Retirement fixture LCD",
      suggested: "119.00",
      cost: "32.00",
      quantity: 1,
      minutes: 60,
      warrantyDays: 90,
      enabled: true,
      isDefault: true,
      sortOrder: 0,
    },
  });
  await db.productCompatibility.create({
    data: {
      productId: retirementFixtureProductId,
      category: "PHONE",
      brand: "Apple",
      model: "iPhone 13",
      project: retirementFixtureProject,
    },
  });
  await db.priceRule.update({
    where: { id: displayRule.id },
    data: {
      suggested: "100.00",
      cost: "32.00",
      minutes: 60,
      requiredProductId: productsByName.get("Display LCD Test")!,
      requiredQuantity: 1,
    },
  });
}
main().finally(() => db.$disconnect());
