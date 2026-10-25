/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");

const paidAt = new Date("2026-01-10T10:00:00.000Z");
const balanceAt = new Date("2026-01-11T10:00:00.000Z");
const receivedAt = new Date("2026-01-09T10:00:00.000Z");
const reservationCreatedAt = new Date("2026-01-10T10:30:00.000Z");
const repairingAt = new Date("2026-01-10T11:00:00.000Z");
const readyAt = new Date("2026-01-11T11:00:00.000Z");
const completedAt = new Date("2026-01-11T12:00:00.000Z");
const consumedAt = new Date("2026-01-11T11:30:00.000Z");
const initialStockAt = new Date("2026-01-08T10:00:00.000Z");

function money(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.toFixed === "function") return value.toFixed(2);
  throw new TypeError("Expected a Prisma decimal or decimal string.");
}

function cents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(money(value));
  assert.ok(match, "Expected a non-negative amount with at most two decimals.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function byId(rows) {
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

async function assertUniqueConstraint(operation, description) {
  let error;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  assert.equal(
    error?.code,
    "P2002",
    `${description} did not enforce its Prisma unique key.`,
  );
}

async function createLegacyOrder(db, data) {
  const order = await db.workOrder.create({
    data: {
      code: data.code,
      status: data.status,
      customerName: data.customerName,
      deviceId: data.deviceId,
      fault: data.fault,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      ...(data.pickedUpAt
        ? { pickedUpAt: data.pickedUpAt, pickedUpBy: data.pickedUpBy }
        : {}),
      orderDiscount: "0.00",
      includeVat: false,
    },
  });
  const item = await db.workOrderItem.create({
    data: {
      orderId: order.id,
      ruleId: data.ruleId,
      project: "Display",
      suggested: "100.00",
      discount: "0.00",
      final: "100.00",
      matchLevel: "EXACT",
      minutes: 60,
      requiredProductId: data.productId,
      requiredQuantity: data.requiredQuantity,
    },
  });
  const productLine = await db.workOrderProduct.create({
    data: {
      orderId: order.id,
      productId: data.productId,
      productName: data.productName,
      category: "Ricambi",
      kind: "REPAIR_PART",
      contextKey: "ORIGINAL",
      unitPrice: "0.00",
      discount: "0.00",
      quantity: data.requiredQuantity,
      consumedAt: data.consumedAt,
      createdAt: data.createdAt,
    },
  });
  return { order, item, productLine };
}

async function seedFixture(db, code) {
  const actor = await db.user.create({
    data: {
      email: `${code.toLowerCase()}@example.test`,
      name: "Release acceptance actor",
      passwordHash: "release-acceptance-placeholder",
      role: "OWNER",
      createdAt: initialStockAt,
    },
  });
  const customer = await db.customer.create({
    data: {
      name: "Upgrade acceptance customer",
      phone: "390000000000",
      createdAt: receivedAt,
    },
  });
  const device = await db.device.create({
    data: {
      customerId: customer.id,
      category: "PHONE",
      brand: "NGT",
      series: "",
      model: "Upgrade acceptance phone",
    },
  });
  const product = await db.product.create({
    data: {
      name: `${code} LCD repair part`,
      category: "Ricambi",
      usage: "REPAIR",
      costPrice: "30.00",
      salePrice: "100.00",
      stockQuantity: 8,
      minStock: 0,
      enabled: true,
      createdAt: initialStockAt,
      updatedAt: initialStockAt,
    },
  });
  const compatibility = await db.productCompatibility.create({
    data: {
      productId: product.id,
      category: "PHONE",
      brand: device.brand,
      model: device.model,
      project: "Display",
    },
  });
  const rule = await db.priceRule.create({
    data: {
      category: device.category,
      brand: device.brand,
      series: device.series,
      model: device.model,
      project: "Display",
      suggested: "100.00",
      cost: "30.00",
      minutes: 60,
      enabled: true,
      notes: "v2.0.18 single-product default quote",
      requiredProductId: product.id,
      requiredQuantity: 2,
      updatedAt: initialStockAt,
    },
  });
  const initialMovement = await db.inventoryMovement.create({
    data: {
      requestId: `initial-stock:${code}`,
      productId: product.id,
      quantity: 8,
      stockBefore: 0,
      stockAfter: 8,
      type: "INITIAL_STOCK",
      referenceType: "PRODUCT",
      referenceId: product.id,
      note: "Release acceptance opening stock",
      actorId: actor.id,
      actorName: actor.name,
      createdAt: initialStockAt,
    },
  });

  const paid = await createLegacyOrder(db, {
    code: `${code}-PAID`,
    status: "COMPLETED",
    customerName: customer.name,
    deviceId: device.id,
    fault: "Historical paid LCD repair",
    ruleId: rule.id,
    productId: product.id,
    productName: product.name,
    requiredQuantity: rule.requiredQuantity,
    consumedAt,
    createdAt: receivedAt,
    updatedAt: completedAt,
    pickedUpAt: completedAt,
    pickedUpBy: "Release acceptance customer",
  });
  const stockAfterUse = await db.product.update({
    where: { id: product.id },
    data: { stockQuantity: 6, updatedAt: consumedAt },
  });
  assert.equal(stockAfterUse.stockQuantity, 6);
  const repairMovement = await db.inventoryMovement.create({
    data: {
      requestId: `work-order-product:${paid.productLine.id}`,
      productId: product.id,
      quantity: -2,
      stockBefore: 8,
      stockAfter: 6,
      type: "REPAIR_USE",
      referenceType: "WORK_ORDER",
      referenceId: paid.order.id,
      note: "Consumed during v2.0.18 repair",
      actorId: actor.id,
      actorName: actor.name,
      createdAt: consumedAt,
    },
  });
  const reservation = await createLegacyOrder(db, {
    code: `${code}-RESERVED`,
    status: "REPAIRING",
    customerName: customer.name,
    deviceId: device.id,
    fault: "Open repair with reserved LCD",
    ruleId: rule.id,
    productId: product.id,
    productName: product.name,
    requiredQuantity: rule.requiredQuantity,
    consumedAt: null,
    createdAt: reservationCreatedAt,
    updatedAt: repairingAt,
  });

  const payments = [];
  for (const entry of [
    { suffix: "DEPOSIT", amount: "40.00", kind: "DEPOSIT", at: paidAt },
    { suffix: "BALANCE", amount: "60.00", kind: "BALANCE", at: balanceAt },
  ]) {
    const payment = await db.payment.create({
      data: {
        requestId: `${code}-${entry.suffix}`,
        orderId: paid.order.id,
        amount: entry.amount,
        method: "CARD",
        kind: entry.kind,
        receivedAt: entry.at,
        actorId: actor.id,
        actorName: actor.name,
      },
    });
    const allocation = await db.paymentAllocation.create({
      data: {
        paymentId: payment.id,
        source: "REPAIR",
        amount: entry.amount,
      },
    });
    payments.push({ payment, allocation });
  }

  const statusRows = [];
  for (const entry of [
    {
      orderId: paid.order.id,
      from: null,
      to: "RECEIVED",
      note: "Accepted",
      at: receivedAt,
    },
    {
      orderId: paid.order.id,
      from: "RECEIVED",
      to: "READY",
      note: "Repair complete",
      at: readyAt,
    },
    {
      orderId: paid.order.id,
      from: "READY",
      to: "COMPLETED",
      note: "Paid and delivered",
      at: completedAt,
    },
    {
      orderId: reservation.order.id,
      from: "RECEIVED",
      to: "REPAIRING",
      note: "Part reserved",
      at: repairingAt,
    },
  ]) {
    statusRows.push(
      await db.statusHistory.create({
        data: {
          orderId: entry.orderId,
          from: entry.from,
          to: entry.to,
          note: entry.note,
          actorId: actor.id,
          actorName: actor.name,
          createdAt: entry.at,
        },
      }),
    );
  }

  const refs = {
    customerId: customer.id,
    deviceId: device.id,
    actorId: actor.id,
    productId: product.id,
    ruleId: rule.id,
    compatibilityId: compatibility.id,
    paidOrderId: paid.order.id,
    paidItemId: paid.item.id,
    paidProductLineId: paid.productLine.id,
    reservationOrderId: reservation.order.id,
    reservationItemId: reservation.item.id,
    reservationProductLineId: reservation.productLine.id,
    paymentIds: payments.map(({ payment }) => payment.id),
    allocationIds: payments.map(({ allocation }) => allocation.id),
    historyIds: statusRows.map((entry) => entry.id),
    movementIds: [initialMovement.id, repairMovement.id],
    postOrderCode: `${code}-POST-OPTION`,
  };
  return { version: 1, code, refs, data: await captureSnapshot(db, refs) };
}

const decimalFields = new Set([
  "suggested",
  "discount",
  "final",
  "cost",
  "amount",
  "unitPrice",
  "costPrice",
  "salePrice",
  "orderDiscount",
]);
const dateFields = new Set([
  "receivedAt",
  "createdAt",
  "updatedAt",
  "consumedAt",
  "pickedUpAt",
]);

function project(record, fields) {
  assert.ok(record, "A pre-upgrade business record is missing.");
  return Object.fromEntries(
    fields.split(" ").map((field) => {
      const value = record[field];
      if (decimalFields.has(field))
        return [field, value == null ? null : money(value)];
      if (dateFields.has(field)) return [field, iso(value)];
      return [field, value];
    }),
  );
}

async function readRecord(delegate, id, fields) {
  return project(await delegate.findUnique({ where: { id } }), fields);
}

async function readRecords(delegate, ids, fields) {
  return byId(
    await Promise.all(ids.map((id) => readRecord(delegate, id, fields))),
  );
}

async function captureSnapshot(db, refs) {
  const [
    customer,
    device,
    actor,
    product,
    rule,
    compatibility,
    paidOrder,
    reservationOrder,
    paidItem,
    reservationItem,
    payments,
    allocations,
    histories,
    orderProducts,
    movements,
  ] = await Promise.all([
    readRecord(db.customer, refs.customerId, "id name phone"),
    readRecord(
      db.device,
      refs.deviceId,
      "id customerId category brand series model",
    ),
    readRecord(db.user, refs.actorId, "id email name role"),
    readRecord(
      db.product,
      refs.productId,
      "id name category usage costPrice salePrice stockQuantity minStock favorite enabled createdAt updatedAt",
    ),
    readRecord(
      db.priceRule,
      refs.ruleId,
      "id category brand series model project suggested cost minutes enabled notes requiredProductId requiredQuantity updatedAt",
    ),
    readRecord(
      db.productCompatibility,
      refs.compatibilityId,
      "id productId category brand model project",
    ),
    readRecord(
      db.workOrder,
      refs.paidOrderId,
      "id number code status customerName deviceId fault orderDiscount includeVat createdAt updatedAt pickedUpAt pickedUpBy",
    ),
    readRecord(
      db.workOrder,
      refs.reservationOrderId,
      "id number code status customerName deviceId fault orderDiscount includeVat createdAt updatedAt pickedUpAt pickedUpBy",
    ),
    readRecord(
      db.workOrderItem,
      refs.paidItemId,
      "id orderId ruleId project suggested discount final matchLevel adjustmentReason minutes requiredProductId requiredQuantity warrantyDays warrantyNotes",
    ),
    readRecord(
      db.workOrderItem,
      refs.reservationItemId,
      "id orderId ruleId project suggested discount final matchLevel adjustmentReason minutes requiredProductId requiredQuantity warrantyDays warrantyNotes",
    ),
    readRecords(
      db.payment,
      refs.paymentIds,
      "id requestId orderId amount method kind receivedAt actorId actorName",
    ),
    readRecords(
      db.paymentAllocation,
      refs.allocationIds,
      "id paymentId source amount",
    ),
    readRecords(
      db.statusHistory,
      refs.historyIds,
      "id orderId from to actorId actorName note createdAt",
    ),
    readRecords(
      db.workOrderProduct,
      [refs.paidProductLineId, refs.reservationProductLineId],
      "id orderId productId productName category kind contextKey unitPrice discount quantity consumedAt createdAt",
    ),
    readRecords(
      db.inventoryMovement,
      refs.movementIds,
      "id requestId productId quantity stockBefore stockAfter type referenceType referenceId note actorId actorName createdAt",
    ),
  ]);

  return {
    customer,
    device,
    actor,
    product,
    rule,
    compatibility,
    orders: [paidOrder, reservationOrder],
    items: [paidItem, reservationItem],
    payments,
    allocations,
    histories,
    orderProducts,
    movements,
  };
}

async function verifyMigratedFixture(db, code, snapshot) {
  assert.equal(snapshot?.version, 1, "Business snapshot version is invalid.");
  assert.equal(
    snapshot.code,
    code,
    "Business snapshot belongs to another run.",
  );
  const { refs, data } = snapshot;
  assert.deepEqual(
    await captureSnapshot(db, refs),
    data,
    "Historical business data changed during upgrade.",
  );
  const paidTotal = data.payments.reduce(
    (sum, payment) => sum + cents(payment.amount),
    0n,
  );
  const allocatedTotal = data.allocations.reduce(
    (sum, allocation) => sum + cents(allocation.amount),
    0n,
  );
  assert.equal(
    paidTotal,
    cents(data.items[0].final),
    "Historical order balance changed.",
  );
  assert.equal(
    allocatedTotal,
    paidTotal,
    "Historical payment allocation total changed.",
  );
  for (const payment of data.payments) {
    const paymentAllocations = data.allocations.filter(
      (allocation) => allocation.paymentId === payment.id,
    );
    assert.equal(paymentAllocations.length, 1);
    assert.equal(paymentAllocations[0].source, "REPAIR");
    assert.equal(
      cents(paymentAllocations[0].amount),
      cents(payment.amount),
      "A receipt no longer matches its repair allocation.",
    );
  }

  const allPayments = await db.payment.findMany({
    where: { orderId: refs.paidOrderId },
  });
  assert.equal(
    allPayments.length,
    2,
    "Upgrade duplicated a historical payment.",
  );
  const allAllocations = await db.paymentAllocation.findMany({
    where: { paymentId: { in: refs.paymentIds } },
  });
  assert.equal(
    allAllocations.length,
    2,
    "Upgrade duplicated a payment allocation.",
  );
  const allHistory = await db.statusHistory.findMany({
    where: { orderId: { in: [refs.paidOrderId, refs.reservationOrderId] } },
  });
  assert.deepEqual(
    allHistory.map((entry) => entry.id).sort(),
    [...refs.historyIds].sort(),
    "Upgrade duplicated or removed order history.",
  );

  const product = await db.product.findUnique({
    where: { id: refs.productId },
  });
  assert.equal(
    product.stockQuantity,
    6,
    "Upgrade changed the historical on-hand stock.",
  );
  const reservation = await db.workOrderProduct.findUnique({
    where: { id: refs.reservationProductLineId },
  });
  assert.equal(reservation.quantity, 2);
  assert.equal(
    reservation.consumedAt,
    null,
    "Upgrade consumed the open reservation.",
  );
  const consumed = await db.workOrderProduct.findUnique({
    where: { id: refs.paidProductLineId },
  });
  assert.ok(
    consumed.consumedAt,
    "Historical consumed part became an open reservation.",
  );

  const options = await db.priceRuleOption.findMany({
    where: { ruleId: refs.ruleId },
  });
  assert.equal(
    options.length,
    1,
    "The legacy rule must migrate to exactly one option.",
  );
  const option = options[0];
  assert.equal(option.productId, refs.productId);
  assert.equal(option.name, data.product.name);
  assert.equal(money(option.suggested), "100.00");
  assert.equal(money(option.cost), "30.00");
  assert.equal(option.quantity, 2);
  assert.equal(option.minutes, 60);
  assert.equal(option.warrantyDays, 0);
  assert.equal(option.enabled, true);
  assert.equal(option.isDefault, true);
  assert.equal(option.sortOrder, 0);
  assert.equal(option.notes, data.rule.notes);
  assert.equal(
    (
      await db.productCompatibility.findMany({
        where: { productId: refs.productId },
      })
    ).length,
    1,
    "The legacy product compatibility was duplicated.",
  );

  for (const id of [refs.paidItemId, refs.reservationItemId]) {
    const item = await db.workOrderItem.findUnique({ where: { id } });
    assert.equal(item.priceOptionId, option.id);
    assert.equal(item.priceOptionName, option.name);
    assert.equal(item.requiredProductName, option.name);
    assert.equal(money(item.suggested), "100.00");
    assert.equal(money(item.final), "100.00");
  }

  const postOrder =
    (await db.workOrder.findUnique({ where: { code: refs.postOrderCode } })) ??
    (await createPostMigrationOrder(db, refs, data, option));
  assert.equal(postOrder.status, "REPAIRING");
  assert.equal(postOrder.deviceId, refs.deviceId);
  assert.equal(postOrder.fault, "Post-upgrade option acceptance");
  const postItems = await db.workOrderItem.findMany({
    where: { orderId: postOrder.id },
  });
  assert.equal(
    postItems.length,
    1,
    "The post-upgrade option order was duplicated.",
  );
  assert.equal(postItems[0].priceOptionId, option.id);
  assert.equal(postItems[0].priceOptionName, option.name);
  assert.equal(postItems[0].requiredProductId, refs.productId);
  assert.equal(postItems[0].requiredProductName, option.name);
  assert.equal(postItems[0].requiredQuantity, option.quantity);
  assert.equal(money(postItems[0].suggested), "100.00");
  assert.equal(money(postItems[0].final), "100.00");

  const postLines = await db.workOrderProduct.findMany({
    where: { orderId: postOrder.id },
  });
  assert.equal(
    postLines.length,
    1,
    "The post-upgrade part reservation was duplicated.",
  );
  assert.equal(postLines[0].productId, refs.productId);
  assert.equal(postLines[0].quantity, 2);
  assert.equal(postLines[0].consumedAt, null);
  const postUpgrade = {
    optionId: option.id,
    orderId: postOrder.id,
    orderNumber: postOrder.number,
    itemId: postItems[0].id,
    productLineId: postLines[0].id,
  };
  if (snapshot.postUpgrade) {
    assert.deepEqual(
      postUpgrade,
      snapshot.postUpgrade,
      "Post-upgrade option records changed after the subsequent repair check.",
    );
  }

  await assertUniqueConstraint(
    () =>
      db.user.create({
        data: {
          email: data.actor.email,
          name: data.actor.name,
          passwordHash: "duplicate-key-probe",
          role: data.actor.role,
        },
      }),
    "User email",
  );
  await assertUniqueConstraint(
    () =>
      db.priceRuleOption.create({
        data: {
          ruleId: refs.ruleId,
          productId: refs.productId,
          name: option.name,
          suggested: option.suggested,
          cost: option.cost,
          quantity: option.quantity,
          minutes: option.minutes,
          warrantyDays: option.warrantyDays,
          enabled: option.enabled,
          isDefault: false,
        },
      }),
    "Price rule option rule/product pair",
  );
  await assertUniqueConstraint(
    () =>
      db.paymentAllocation.create({
        data: {
          paymentId: refs.paymentIds[0],
          source: "REPAIR",
          amount: "40.00",
        },
      }),
    "Payment allocation payment/source pair",
  );
  await assertUniqueConstraint(
    () =>
      db.workOrderProduct.create({
        data: {
          orderId: refs.reservationOrderId,
          productId: refs.productId,
          productName: data.product.name,
          category: "Ricambi",
          kind: "REPAIR_PART",
          contextKey: "ORIGINAL",
          unitPrice: "0.00",
          discount: "0.00",
          quantity: 2,
        },
      }),
    "Work order/product reservation pair",
  );

  const allLines = await db.workOrderProduct.findMany({
    where: { productId: refs.productId },
  });
  assert.equal(
    allLines.length,
    3,
    "Upgrade or repair duplicated a part record.",
  );
  assert.equal(
    allLines
      .filter((line) => line.consumedAt == null)
      .reduce((sum, line) => sum + line.quantity, 0),
    4,
    "Open repair reservations changed or were duplicated.",
  );
  const movements = await db.inventoryMovement.findMany({
    where: { productId: refs.productId },
  });
  assert.equal(
    movements.length,
    2,
    "Upgrade or repair duplicated an inventory movement.",
  );
  const allItems = await db.workOrderItem.findMany({
    where: {
      orderId: {
        in: [refs.paidOrderId, refs.reservationOrderId, postOrder.id],
      },
    },
  });
  assert.equal(
    allItems.length,
    3,
    "A historical or new quote line was duplicated.",
  );
  assert.equal(
    product.stockQuantity - 4,
    2,
    "Available stock changed after reservation checks.",
  );

  const writePhone = "390000000001";
  const priorWrite = await db.customer.findFirst({
    where: { phone: writePhone },
  });
  const written = priorWrite
    ? await db.customer.update({
        where: { id: priorWrite.id },
        data: { name: "Post update write" },
      })
    : await db.customer.create({
        data: { name: "Post update write", phone: writePhone },
      });
  assert.equal(
    (await db.customer.findUnique({ where: { id: written.id } }))?.name,
    "Post update write",
    "Database writes failed after migration.",
  );
  assert.equal(
    await db.customer.count({ where: { phone: writePhone } }),
    1,
    "Repeated post-upgrade verification duplicated its write probe.",
  );
  return { ...snapshot, postUpgrade };
}

async function verifySeedFixture(db, code, snapshot) {
  assert.equal(snapshot?.version, 1, "Business snapshot version is invalid.");
  assert.equal(
    snapshot.code,
    code,
    "Business snapshot belongs to another run.",
  );
  assert.deepEqual(
    await captureSnapshot(db, snapshot.refs),
    snapshot.data,
    "Business data changed during failed update rollback.",
  );
  return snapshot;
}

async function createPostMigrationOrder(db, refs, data, option) {
  const order = await db.workOrder.create({
    data: {
      code: refs.postOrderCode,
      status: "REPAIRING",
      customerName: data.customer.name,
      deviceId: refs.deviceId,
      fault: "Post-upgrade option acceptance",
      orderDiscount: "0.00",
      includeVat: false,
    },
  });
  await db.workOrderItem.create({
    data: {
      orderId: order.id,
      ruleId: refs.ruleId,
      priceOptionId: option.id,
      priceOptionName: option.name,
      project: "Display",
      suggested: "100.00",
      discount: "0.00",
      final: "100.00",
      matchLevel: "EXACT",
      minutes: option.minutes,
      requiredProductId: refs.productId,
      requiredProductName: option.name,
      requiredQuantity: option.quantity,
    },
  });
  await db.workOrderProduct.create({
    data: {
      orderId: order.id,
      productId: refs.productId,
      productName: option.name,
      category: "Ricambi",
      kind: "REPAIR_PART",
      contextKey: "ORIGINAL",
      unitPrice: "0.00",
      discount: "0.00",
      quantity: option.quantity,
      consumedAt: null,
    },
  });
  return order;
}

async function runProbe(db, action, code, snapshot) {
  if (action === "seed") return seedFixture(db, code);
  if (action === "verify") return verifySeedFixture(db, code, snapshot);
  if (action === "verify-and-write")
    return verifyMigratedFixture(db, code, snapshot);
  throw new Error("Unknown business probe action: " + action);
}

module.exports = { runProbe };

if (require.main === module) {
  const [action, envFile, clientPath, code, snapshotPath] =
    process.argv.slice(2);
  if (!action || !envFile || !clientPath || !code || !snapshotPath) {
    console.error(
      "Usage: business-probe <seed|verify|verify-and-write> <env> <client> <code> <snapshot>",
    );
    process.exitCode = 2;
  } else {
    process.loadEnvFile(envFile);
    const { PrismaClient } = require(clientPath);
    const db = new PrismaClient();
    const snapshot =
      action === "verify-and-write"
        ? JSON.parse(readFileSync(snapshotPath, "utf8"))
        : undefined;
    runProbe(db, action, code, snapshot)
      .then((result) => {
        if (result) writeFileSync(snapshotPath, JSON.stringify(result));
      })
      .catch((error) => {
        const message = String(error?.message ?? error).replace(
          /postgres(?:ql)?:\/\/[^\s"']+/gi,
          "[redacted database URL]",
        );
        console.error(message);
        process.exitCode = 1;
      })
      .finally(() => db.$disconnect());
  }
}
