import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { runProbe } = require("../../scripts/windows-studio-business-probe.cjs");

function createDatabase() {
  const names = [
    "customer",
    "device",
    "user",
    "product",
    "productCompatibility",
    "priceRule",
    "priceRuleOption",
    "workOrder",
    "workOrderItem",
    "workOrderProduct",
    "payment",
    "paymentAllocation",
    "statusHistory",
    "inventoryMovement",
  ];
  const tables = Object.fromEntries(names.map((name) => [name, []]));
  const uniqueFields = {
    user: [["email"]],
    priceRule: [["category", "brand", "series", "model", "project"]],
    priceRuleOption: [["ruleId", "productId"]],
    workOrder: [["code"]],
    payment: [["requestId"]],
    paymentAllocation: [["paymentId", "source"]],
    workOrderProduct: [["orderId", "productId", "kind", "contextKey"]],
    inventoryMovement: [["requestId"]],
  };
  let nextId = 0;
  let nextOrderNumber = 0;
  const matches = (record, where = {}) =>
    Object.entries(where).every(([key, expected]) => {
      if (expected && typeof expected === "object" && "in" in expected)
        return expected.in.includes(record[key]);
      return record[key] === expected;
    });

  const db = Object.fromEntries(
    names.map((name) => [
      name,
      {
        async create({ data }) {
          for (const fields of uniqueFields[name] ?? []) {
            if (
              tables[name].some((record) =>
                fields.every((field) => record[field] === data[field]),
              )
            ) {
              const error = new Error(
                `Unique constraint failed on ${name}.${fields.join("+")}`,
              );
              error.code = "P2002";
              throw error;
            }
          }
          const record = { ...data, id: data.id ?? `${name}-${++nextId}` };
          if (name === "workOrder") record.number = ++nextOrderNumber;
          tables[name].push(record);
          return record;
        },
        async findUnique({ where }) {
          return tables[name].find((record) => matches(record, where)) ?? null;
        },
        async findFirst({ where }) {
          return tables[name].find((record) => matches(record, where)) ?? null;
        },
        async findMany({ where }) {
          return tables[name].filter((record) => matches(record, where));
        },
        async count({ where }) {
          return tables[name].filter((record) => matches(record, where)).length;
        },
        async update({ where, data }) {
          const record = tables[name].find((entry) => matches(entry, where));
          if (!record) throw new Error(`Missing ${name} record`);
          Object.assign(record, data);
          return record;
        },
      },
    ]),
  );
  return { db, tables };
}

async function applyV2019LegacyRuleMigration(db, tables) {
  const rule = tables.priceRule[0];
  const product = tables.product[0];
  const option = {
    id: `legacy_${rule.id}_${product.id}`,
    ruleId: rule.id,
    productId: product.id,
    name: product.name,
    suggested: rule.suggested,
    cost: rule.cost ?? product.costPrice,
    quantity: rule.requiredQuantity,
    minutes: rule.minutes,
    warrantyDays: 0,
    enabled: rule.enabled && product.enabled,
    isDefault: true,
    sortOrder: 0,
    notes: rule.notes,
  };
  await db.priceRuleOption.create({ data: option });
  for (const item of tables.workOrderItem) {
    if (item.ruleId === rule.id && item.requiredProductId === product.id) {
      item.priceOptionId = option.id;
      item.priceOptionName = option.name;
      item.requiredProductName = product.name;
    }
  }
}

test("release data probe preserves a v2.0.18 payment, stock and legacy quote fixture", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const migration = await readFile(
    "prisma/migrations/20261018180000_multi_part_price_options/migration.sql",
    "utf8",
  );
  const acceptanceScript = await readFile(
    "scripts/test-windows-studio-online-update.ps1",
    "utf8",
  );
  assert.match(schema, /model PriceRuleOption\s*\{/);
  assert.match(schema, /model PaymentAllocation\s*\{/);
  assert.match(schema, /model WorkOrderProduct\s*\{/);
  assert.match(migration, /INSERT INTO "PriceRuleOption"/);
  assert.match(migration, /rule\."requiredProductId"/);
  assert.match(acceptanceScript, /releases\\\$oldTag/);
  assert.match(acceptanceScript, /runtime\\node\.exe/);
  assert.match(acceptanceScript, /standalone\\node_modules\\@prisma\\client/);

  const { db, tables } = createDatabase();
  const code = "CI-TEST-LEGACY-FIXTURE";
  let snapshot = await runProbe(db, "seed", code);
  assert.equal(Object.hasOwn(snapshot.data.device, "createdAt"), false);
  assert.equal(snapshot.data.rule.suggested, "100.00");
  assert.equal(snapshot.data.product.stockQuantity, 6);
  assert.equal(snapshot.data.rule.requiredQuantity, 2);
  const paidCents = snapshot.data.payments.reduce(
    (sum, payment) => sum + BigInt(payment.amount.replace(".", "")),
    0n,
  );
  assert.equal(paidCents, 10000n);
  assert.equal(
    snapshot.data.orderProducts.filter((line) => line.consumedAt).length,
    1,
  );
  assert.equal(
    snapshot.data.orderProducts.filter((line) => !line.consumedAt).length,
    1,
  );
  assert.equal(
    snapshot.data.orderProducts.find((line) => !line.consumedAt).quantity,
    2,
  );
  assert.equal(snapshot.data.product.stockQuantity - 2, 4);
  assert.equal(snapshot.data.movements.length, 2);
  await assert.rejects(
    runProbe(db, "seed", code),
    /Unique constraint failed on user.email/,
  );

  await applyV2019LegacyRuleMigration(db, tables);
  snapshot = await runProbe(db, "verify-and-write", code, snapshot);
  snapshot = await runProbe(db, "verify-and-write", code, snapshot);

  assert.equal(tables.priceRuleOption.length, 1);
  assert.equal(tables.workOrder.length, 3);
  assert.equal(tables.workOrderItem.length, 3);
  assert.equal(tables.workOrderProduct.length, 3);
  assert.equal(tables.inventoryMovement.length, 2);
  assert.equal(
    tables.customer.filter((customer) => customer.phone === "390000000001")
      .length,
    1,
  );
  assert.equal(tables.product[0].stockQuantity, 6);
  assert.ok(snapshot.postUpgrade.optionId);
  assert.ok(snapshot.postUpgrade.orderId);
  assert.ok(snapshot.postUpgrade.itemId);
  assert.ok(snapshot.postUpgrade.productLineId);

  tables.paymentAllocation[0].amount = "39.00";
  await assert.rejects(
    runProbe(db, "verify-and-write", code, snapshot),
    /Historical business data changed during upgrade/,
  );
});

test("release probe rejects invalid actions and requires snapshot for migration verification", async () => {
  const { db } = createDatabase();
  await assert.rejects(
    runProbe(db, "invalid", "CI-TEST"),
    /Unknown business probe action/,
  );
  await assert.rejects(
    runProbe(db, "verify-and-write", "CI-TEST", undefined),
    /Business snapshot version is invalid/,
  );
  const cli = spawnSync(
    process.execPath,
    [require.resolve("../../scripts/windows-studio-business-probe.cjs")],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /Usage: business-probe/);
});
