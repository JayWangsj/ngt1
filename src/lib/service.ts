import { Prisma, type PrismaClient } from "@prisma/client";
import { db } from "./db";
import {
  assertDelivery,
  assertOwner,
  assertTransition,
  balance,
  allocatePayment,
  BusinessError,
  cents,
  decimal,
  isDiagnosticFault,
  matchRule,
  romeDay,
  settlement,
  type Actor,
} from "./domain";
import {
  customerInput,
  amountInput,
  deviceInput,
  dueDateInput,
  editInput,
  itemInput,
  quoteInput,
  inspectionQuoteInput,
  faultCatalogInput,
  orderInput,
  paymentInput,
  paidTotalInput,
  quickServiceExpectedAtInput,
  productInput,
  productUpdateInput,
  inventoryAdjustmentInput,
  retailSaleInput,
  workOrderProductInput,
  checkoutInput,
  ruleInput,
  priceRuleOptionInput,
  statusInput,
  warrantyInput,
  afterSalesInput,
  businessClockInput,
  refundInput,
  userInput,
  quickServiceInput,
  quickServiceOrderInput,
  quickServiceOrderEditInput,
  renameDeviceModelInput,
  deleteWorkOrderInput,
} from "./validation";
import { z } from "zod";
import { hash } from "bcryptjs";
import {
  normalizeBrand,
  normalizeDeviceModel,
  normalizeModel,
} from "./catalog";
import { getBusinessDay } from "./business-date";
import { assertStudioWritesAvailable } from "./studio-maintenance";

type Tx = Prisma.TransactionClient;
type Amount = string | { toString(): string };
type PaymentOrder = {
  type: string;
  items: { final: Amount; discount?: Amount }[];
  orderDiscount: Amount;
  includeVat: boolean;
  inspectionFee: Amount;
  afterSalesFee: Amount;
  products: { unitPrice: Amount; quantity: number; discount?: Amount }[];
  payments: {
    allocations: { source: string; amount: Amount }[];
  }[];
};
function paymentBuckets(order: PaymentOrder) {
  const repairSource =
    order.type === "QUICK_SERVICE" ? "QUICK_SERVICE" : "REPAIR";
  const repairDue = settlement(order.items, {
    orderDiscount: order.orderDiscount,
    includeVat: order.includeVat,
    inspectionFee: order.inspectionFee,
    afterSalesFee: order.afterSalesFee,
  }).due;
  const retailDue = settlement([], { products: order.products }).productTotal;
  const allocations = order.payments.flatMap((payment) => payment.allocations);
  const repairPaid = allocations
    .filter((allocation) => allocation.source === repairSource)
    .reduce((sum, allocation) => sum + cents(allocation.amount), 0);
  const retailPaid = allocations
    .filter((allocation) => allocation.source === "RETAIL")
    .reduce((sum, allocation) => sum + cents(allocation.amount), 0);
  return { repairDue, retailDue, repairPaid, retailPaid };
}
const lockedOrderStatuses = ["COMPLETED", "REWORKING", "REFUNDED", "CANCELLED"];
function originalOrderLocked(order: {
  status: string;
  afterSalesOpen?: boolean;
}) {
  return lockedOrderStatuses.includes(order.status) || order.afterSalesOpen;
}
export const orderInclude = {
  device: { include: { customer: true } },
  relatedDevices: { include: { device: true } },
  items: {
    include: {
      requiredProduct: true,
      priceOption: true,
      reworkItem: true,
      quickService: true,
    },
  },
  faults: { include: { catalog: true } },
  products: true,
  payments: {
    orderBy: { receivedAt: "asc" as const },
    include: { allocations: true },
  },
  history: { orderBy: { createdAt: "asc" as const } },
  reworks: {
    include: {
      items: { include: { originalItem: true, requiredProduct: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
};
async function nextDailyCode(
  tx: Tx,
  kind: "order" | "service" | "sale",
  day: string,
) {
  const prefix = `${kind === "order" ? "R" : kind === "service" ? "S" : "V"}-${day.replaceAll("-", "")}`;
  const latest =
    kind !== "sale"
      ? await tx.workOrder.findFirst({
          where: { code: { startsWith: prefix } },
          orderBy: { code: "desc" },
          select: { code: true },
        })
      : await tx.retailSale.findFirst({
          where: { code: { startsWith: prefix } },
          orderBy: { code: "desc" },
          select: { code: true },
        });
  const sequence = latest ? Number(latest.code.slice(-3)) + 1 : 1;
  if (sequence > 999) throw new BusinessError("Limite giornaliero raggiunto.");
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

async function assertDueDate(tx: Tx, value: string) {
  if (value && value < (await getBusinessDay(tx)))
    throw new BusinessError("La consegna non può precedere oggi.");
}

export async function updateBusinessClock(actorInput: Actor, raw: unknown) {
  const data = businessClockInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const clock = await tx.businessClock.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        mode: data.mode,
        manualDate: data.mode === "MANUAL" ? data.manualDate : null,
      },
      update: {
        mode: data.mode,
        manualDate: data.mode === "MANUAL" ? data.manualDate : null,
      },
    });
    await audit(tx, actor, clock.id, "BUSINESS_CLOCK_UPDATED", {
      mode: clock.mode,
      manualDate: clock.manualDate,
    });
    return clock;
  });
}

type SnapshotItem = Awaited<ReturnType<typeof snapshots>>[number];
async function requiredPartLines(
  tx: Tx,
  items: SnapshotItem[],
  allowInactiveProductIds = new Set<string>(),
) {
  const productIds = items.flatMap((item) =>
    item.requiredProductId ? [item.requiredProductId] : [],
  );
  if (!productIds.length) return [];
  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
  });
  const quantities = new Map<
    string,
    {
      product: (typeof products)[number];
      quantity: number;
    }
  >();
  for (const item of items) {
    if (!item.requiredProductId) continue;
    const product = products.find(
      (candidate) => candidate.id === item.requiredProductId,
    );
    if (
      !product ||
      ((!product.enabled || product.usage !== "REPAIR") &&
        !allowInactiveProductIds.has(product.id))
    )
      throw new BusinessError("Ricambio non disponibile.");
    const current = quantities.get(product.id);
    quantities.set(product.id, {
      product,
      quantity: (current?.quantity ?? 0) + item.requiredQuantity,
    });
  }
  return [...quantities.values()];
}

const reservationStatuses = [
  "RECEIVED",
  "DIAGNOSING",
  "REPAIRING",
  "PARTS_MISSING",
  "REWORKING",
] as const;

async function newLinesNeedParts(
  tx: Tx,
  lines: { quantity: number; product: { id: string; stockQuantity: number } }[],
  excludeOrderId?: string,
) {
  if (!lines.length) return false;
  const reservations = await tx.workOrderProduct.findMany({
    where: {
      productId: { in: lines.map((line) => line.product.id) },
      consumedAt: null,
      ...(excludeOrderId ? { orderId: { not: excludeOrderId } } : {}),
      order: { status: { in: [...reservationStatuses] } },
    },
    select: { productId: true, quantity: true },
  });
  const reserved = new Map<string, number>();
  for (const line of reservations)
    reserved.set(
      line.productId,
      (reserved.get(line.productId) ?? 0) + line.quantity,
    );
  return lines.some(
    (line) =>
      line.quantity >
      Math.max(
        0,
        line.product.stockQuantity - (reserved.get(line.product.id) ?? 0),
      ),
  );
}

async function orderNeedsParts(tx: Tx, orderId: string) {
  const target = await tx.workOrderProduct.findMany({
    where: { orderId, kind: "REPAIR_PART", consumedAt: null },
    select: { productId: true },
  });
  if (!target.length) return false;
  const lines = await tx.workOrderProduct.findMany({
    where: {
      productId: { in: target.map((line) => line.productId) },
      consumedAt: null,
      order: { status: { in: [...reservationStatuses] } },
    },
    include: { product: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const allocated = new Map<string, number>();
  for (const line of lines) {
    const total = (allocated.get(line.productId) ?? 0) + line.quantity;
    allocated.set(line.productId, total);
    if (line.orderId === orderId && total > line.product.stockQuantity)
      return true;
  }
  return false;
}

async function refreshPartStatuses(tx: Tx, actor: Actor, productId: string) {
  const orders = await tx.workOrder.findMany({
    where: {
      status: { in: ["REPAIRING", "PARTS_MISSING"] },
      products: { some: { productId, kind: "REPAIR_PART", consumedAt: null } },
    },
    include: { products: { include: { product: true } } },
  });
  for (const order of orders) {
    const next = (await orderNeedsParts(tx, order.id))
      ? "PARTS_MISSING"
      : order.afterSalesOpen
        ? "REWORKING"
        : "REPAIRING";
    if (next === order.status) continue;
    await tx.workOrder.update({
      where: { id: order.id },
      data: { status: next },
    });
    await tx.statusHistory.create({
      data: {
        orderId: order.id,
        from: order.status,
        to: next,
        actorId: actor.id,
        actorName: actor.name,
        note: "",
      },
    });
    await audit(tx, actor, order.id, "STATUS_CHANGED", {
      from: order.status,
      to: next,
      reason: "INVENTORY_AVAILABILITY",
    });
  }
}
export async function transact<T>(
  work: (tx: Tx) => Promise<T>,
  client: PrismaClient = db,
): Promise<T> {
  await assertStudioWritesAvailable();
  for (let i = 0; i < 4; i++) {
    try {
      return await client.$transaction(work, {
        isolationLevel: "Serializable",
        maxWait: 10000,
        timeout: 15000,
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034" ||
        i === 3
      )
        throw error;
    }
  }
  throw new BusinessError("Riprovare l'operazione.");
}
async function currentActor(tx: Tx, actor: Actor) {
  const user = await tx.user.findUnique({ where: { id: actor.id } });
  if (!user?.enabled)
    throw new BusinessError("Sessione non valida. Accedi di nuovo.");
  return { id: user.id, name: user.name, role: user.role };
}
async function audit(
  tx: Tx,
  actor: Actor,
  entityId: string,
  action: string,
  context: Prisma.InputJsonValue = {},
) {
  await tx.auditLog.create({
    data: {
      entityId,
      action,
      actorId: actor.id,
      actorName: actor.name,
      context,
    },
  });
}
async function snapshots(
  tx: Tx,
  actor: Actor,
  device: { category: string; brand: string; series: string; model: string },
  input: z.infer<typeof itemInput>[],
  previousItems?: {
    project: string;
    final: { toString(): string };
    ruleId: string | null;
    priceOptionId: string | null;
    priceOptionName: string;
    suggested: { toString(): string } | null;
    matchLevel: string;
    minutes: number;
    requiredProductId: string | null;
    requiredProductName: string;
    requiredQuantity: number;
    warrantyStart: Date | null;
    warrantyDays: number;
    warrantyExpiresAt: Date | null;
    warrantyNotes: string;
  }[],
) {
  const rules = await tx.priceRule.findMany({
    where: { enabled: true },
    include: {
      options: {
        where: { enabled: true },
        include: { product: true },
        orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
      },
    },
    orderBy: { id: "asc" },
  });
  const results = [];
  const projectPrices = new Map<string, number>();
  for (const item of input) {
    const match = matchRule(rules, device, item.project);
    const final = cents(item.final);
    const projectKey = item.project.trim().toLowerCase();
    if (
      projectPrices.has(projectKey) &&
      projectPrices.get(projectKey) !== final
    )
      throw new BusinessError(
        "Prezzi diversi per lo stesso intervento: distingui la specifica del ricambio.",
      );
    projectPrices.set(projectKey, final);
    const key = {
      category: device.category,
      brand: normalizeBrand(device.brand),
      series: "",
      model: normalizeDeviceModel(device.brand, device.model),
      project: item.project.trim().toLowerCase(),
    };
    const oldItem = previousItems?.find(
      (i) => i.project.trim().toLowerCase() === key.project,
    );
    let effectiveRule = match?.rule ?? null;
    if (item.saveRule) {
      const previous = await tx.priceRule.findUnique({
        where: { category_brand_series_model_project: key },
      });
      const savedRule = await tx.priceRule.upsert({
        where: { category_brand_series_model_project: key },
        create: {
          ...key,
          suggested: decimal(final),
          minutes: match?.rule.minutes ?? 60,
          requiredProductId: item.saveRule
            ? item.requiredProductId || null
            : null,
          requiredQuantity: item.saveRule ? item.requiredQuantity : 1,
        },
        update: {
          suggested: decimal(final),
          enabled: true,
          requiredProductId: item.requiredProductId || null,
          requiredQuantity: item.requiredQuantity,
        },
      });
      await audit(
        tx,
        actor,
        savedRule.id,
        previous ? "PRICE_RULE_UPDATED" : "PRICE_RULE_CREATED",
        {
          before: previous?.suggested.toString() ?? null,
          after: decimal(final),
        },
      );
      if (item.requiredProductId) {
        const product = await tx.product.findFirst({
          where: { id: item.requiredProductId, enabled: true, usage: "REPAIR" },
        });
        if (!product) throw new BusinessError("Ricambio non disponibile.");
        await tx.priceRuleOption.updateMany({
          where: { ruleId: savedRule.id, isDefault: true },
          data: { isDefault: false },
        });
        await tx.priceRuleOption.upsert({
          where: {
            ruleId_productId: {
              ruleId: savedRule.id,
              productId: product.id,
            },
          },
          create: {
            ruleId: savedRule.id,
            productId: product.id,
            name: product.name,
            suggested: decimal(final),
            cost: product.costPrice,
            quantity: item.requiredQuantity,
            minutes: savedRule.minutes,
            isDefault: true,
          },
          update: {
            suggested: decimal(final),
            quantity: item.requiredQuantity,
            enabled: true,
            isDefault: true,
          },
        });
      }
      effectiveRule = await tx.priceRule.findUniqueOrThrow({
        where: { id: savedRule.id },
        include: {
          options: {
            where: { enabled: true },
            include: { product: true },
            orderBy: [
              { isDefault: "desc" },
              { sortOrder: "asc" },
              { id: "asc" },
            ],
          },
        },
      });
    }
    const options = (effectiveRule?.options ?? []).filter(
      (option) => option.product.enabled && option.product.usage === "REPAIR",
    );
    const historicalOption =
      oldItem?.priceOptionId && oldItem.ruleId
        ? await tx.priceRuleOption.findFirst({
            where: {
              id: oldItem.priceOptionId,
              ruleId: oldItem.ruleId,
            },
            include: { product: true },
          })
        : null;
    const preservesHistoricalOption = Boolean(
      historicalOption &&
      !item.requiredProductRemoved &&
      (item.priceOptionId === oldItem?.priceOptionId ||
        (!item.priceOptionId &&
          item.requiredProductId === oldItem?.requiredProductId)),
    );
    const preservesHistoricalPart = Boolean(
      oldItem?.requiredProductId &&
      !oldItem.priceOptionId &&
      !item.requiredProductRemoved &&
      item.requiredProductId === oldItem.requiredProductId,
    );
    const preservesHistoricalNoPart = Boolean(
      oldItem &&
      !oldItem.requiredProductId &&
      !oldItem.priceOptionId &&
      !item.requiredProductId &&
      !item.priceOptionId,
    );
    const preservesHistoricalSelection =
      preservesHistoricalOption ||
      preservesHistoricalPart ||
      preservesHistoricalNoPart;
    if (
      item.requiredProductRemoved &&
      (item.priceOptionId || item.requiredProductId)
    )
      throw new BusinessError("Selezione ricambio non valida.");
    let selectedOption = item.requiredProductRemoved
      ? null
      : item.priceOptionId
        ? options.find((option) => option.id === item.priceOptionId)
        : item.requiredProductId
          ? options.find(
              (option) => option.productId === item.requiredProductId,
            )
          : (options.find((option) => option.isDefault) ?? options[0]);
    if (preservesHistoricalOption)
      selectedOption = historicalOption ?? undefined;
    else if (preservesHistoricalNoPart) selectedOption = null;
    if (item.priceOptionId && !selectedOption)
      throw new BusinessError(
        "L'opzione ricambio non appartiene all'intervento selezionato.",
      );
    if (
      selectedOption &&
      item.requiredProductId &&
      item.requiredProductId !== selectedOption.productId
    )
      throw new BusinessError(
        "Il ricambio non corrisponde all'opzione selezionata.",
      );
    const requiredProductId =
      item.requiredProductRemoved || preservesHistoricalNoPart
        ? null
        : selectedOption?.productId ||
          item.requiredProductId ||
          effectiveRule?.requiredProductId ||
          null;
    const requiredProduct = requiredProductId
      ? await tx.product.findUnique({ where: { id: requiredProductId } })
      : null;
    if (
      requiredProductId &&
      (!requiredProduct ||
        ((!requiredProduct.enabled || requiredProduct.usage !== "REPAIR") &&
          !preservesHistoricalSelection))
    )
      throw new BusinessError("Ricambio non disponibile.");
    results.push({
      project: item.project,
      final: decimal(final),
      discount: decimal(cents(item.discount)),
      suggested: preservesHistoricalSelection
        ? oldItem?.suggested
          ? decimal(cents(oldItem.suggested.toString()))
          : null
        : (selectedOption?.suggested ?? effectiveRule?.suggested ?? null),
      ruleId: preservesHistoricalSelection
        ? oldItem?.ruleId
        : (effectiveRule?.id ?? oldItem?.ruleId ?? null),
      priceOptionId: preservesHistoricalOption
        ? oldItem?.priceOptionId
        : (selectedOption?.id ?? null),
      priceOptionName: preservesHistoricalSelection
        ? (oldItem?.priceOptionName ?? "")
        : (selectedOption?.name ?? ""),
      matchLevel: preservesHistoricalSelection
        ? (oldItem?.matchLevel ?? "MANUAL")
        : (match?.level ?? "MANUAL"),
      adjustmentReason: item.adjustmentReason,
      minutes: preservesHistoricalSelection
        ? (oldItem?.minutes ?? 0)
        : (selectedOption?.minutes ?? effectiveRule?.minutes ?? 0),
      requiredProductId,
      requiredProductName: preservesHistoricalSelection
        ? (oldItem?.requiredProductName ?? "")
        : (requiredProduct?.name ?? ""),
      requiredQuantity: preservesHistoricalSelection
        ? (oldItem?.requiredQuantity ?? 1)
        : selectedOption
          ? selectedOption.quantity
          : item.requiredProductId || !effectiveRule?.requiredProductId
            ? item.requiredQuantity
            : effectiveRule.requiredQuantity,
      warrantyStart: oldItem?.warrantyStart ?? null,
      warrantyDays: preservesHistoricalSelection
        ? (oldItem?.warrantyDays ?? 0)
        : (selectedOption?.warrantyDays ?? oldItem?.warrantyDays ?? 0),
      warrantyExpiresAt: oldItem?.warrantyExpiresAt ?? null,
      warrantyNotes: oldItem?.warrantyNotes ?? "",
    });
  }
  return results;
}
export async function createOrder(actorInput: Actor, raw: unknown) {
  const data = orderInput.parse(raw);
  return transact(async (tx) => {
    await assertDueDate(tx, data.dueDate);
    const actor = await currentActor(tx, actorInput);
    const previous = await tx.auditLog.findFirst({
      where: {
        action: "ORDER_CREATED",
        context: { path: ["requestId"], equals: data.requestId },
      },
    });
    if (previous)
      return tx.workOrder.findUniqueOrThrow({
        where: { id: previous.entityId },
      });
    let customer = await tx.customer.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { phone: data.phone },
          { phones: { some: { phone: data.phone } } },
        ],
      },
    });
    if (!customer) {
      customer = await tx.customer.create({
        data: {
          name: data.customerName,
          phone: data.phone,
          consentAt: data.privacyConsent ? new Date() : null,
          consentVersion: data.privacyConsent ? "1.0" : null,
        },
      });
    } else if (data.privacyConsent && !customer.consentAt) {
      customer = await tx.customer.update({
        where: { id: customer.id },
        data: { consentAt: new Date(), consentVersion: "1.0" },
      });
    }
    if (customer.deletedAt)
      throw new BusinessError("Cliente eliminato: usa un altro telefono.");
    await syncPhones(
      tx,
      customer.id,
      customer.phone,
      data.additionalPhones,
      true,
    );
    const device = data.deviceId
      ? await tx.device.findFirst({
          where: {
            id: data.deviceId,
            customerId: customer.id,
            deletedAt: null,
          },
        })
      : await tx.device.create({
          data: {
            customerId: customer.id,
            category: data.category,
            brand: normalizeBrand(data.brand),
            series: normalizeModel(data.series),
            model: normalizeDeviceModel(data.brand, data.model),
            imei: data.imei || null,
            appearance: data.appearance,
            accessories: data.accessories,
          },
        });
    if (!device)
      throw new BusinessError(
        "Il dispositivo non appartiene al cliente selezionato.",
      );
    const diagnostic =
      data.inspectionMode || isDiagnosticFault([...data.faults, data.fault]);
    const items = diagnostic
      ? []
      : await snapshots(tx, actor, device, data.items);
    const requiredParts = await requiredPartLines(tx, items);
    const initialStatus = diagnostic
      ? "DIAGNOSING"
      : (await newLinesNeedParts(tx, requiredParts))
        ? "PARTS_MISSING"
        : "REPAIRING";
    const quote = settlement(items, {
      ...data,
      inspectionFee: diagnostic ? data.diagnosticFee : "0",
    });
    if (cents(data.deposit) > quote.due)
      throw new BusinessError("L'acconto supera il totale.");
    const legacyFaults = [
      ...new Map(
        data.faults
          .filter((name) => !isDiagnosticFault([name]))
          .map((name) => [name.trim().toLowerCase(), name.trim()]),
      ).values(),
    ];
    const selectedCatalog = await tx.faultOption.findMany({
      where: {
        id: { in: data.standardFaultIds },
        category: device.category,
        hidden: false,
      },
    });
    if (selectedCatalog.length !== data.standardFaultIds.length)
      throw new BusinessError(
        "Uno dei problemi selezionati non è disponibile.",
      );
    for (const name of legacyFaults) {
      const key = name.toLowerCase();
      const fault = await tx.faultOption.upsert({
        where: { category_key: { category: device.category, key } },
        create: { category: device.category, name, key },
        update: {},
      });
      if (!selectedCatalog.some((item) => item.id === fault.id))
        selectedCatalog.push(fault);
    }
    const customFaults = [
      ...new Set(data.customFaults.map((name) => name.trim())),
    ];
    const faultNote = data.faultNote || (data.inspectionMode ? data.fault : "");
    if (
      !diagnostic &&
      !selectedCatalog.length &&
      !customFaults.length &&
      !data.fault
    )
      throw new BusinessError("Indica il problema segnalato.");
    const faultSnapshot = diagnostic
      ? "Da diagnosticare"
      : [
          ...selectedCatalog.map((item) => item.name),
          ...customFaults,
          data.fault,
        ]
          .filter(Boolean)
          .join("; ");
    const order = await tx.workOrder.create({
      data: {
        code: await nextDailyCode(tx, "order", await getBusinessDay(tx)),
        deviceId: device.id,
        customerName: customer.name,
        fault: faultSnapshot,
        faultNote,
        inspectionMode: diagnostic,
        inspectionFee: decimal(diagnostic ? cents(data.diagnosticFee) : 0),
        orderDiscount: decimal(cents(data.orderDiscount)),
        includeVat: data.includeVat,
        appearance: data.appearance,
        accessories: data.accessories,
        dueDate: data.dueDate || null,
        notes: data.notes,
        status: initialStatus,
        type: "REPAIR",
        relatedDevices: { create: { deviceId: device.id } },
        items: { create: items },
        faults: diagnostic
          ? undefined
          : {
              create: [
                ...selectedCatalog.map((item) => ({
                  catalogId: item.id,
                  nameSnapshot: item.name,
                  custom: false,
                })),
                ...customFaults.map((name) => ({
                  nameSnapshot: name,
                  custom: true,
                })),
              ],
            },
        products: requiredParts.length
          ? {
              create: requiredParts.map(({ product, quantity }) => ({
                productId: product.id,
                productName: product.name,
                category: product.category,
                kind: "REPAIR_PART" as const,
                unitPrice: decimal(0),
                quantity,
              })),
            }
          : undefined,
        history: {
          create: {
            to: initialStatus,
            actorId: actor.id,
            actorName: actor.name,
          },
        },
        payments:
          cents(data.deposit) > 0
            ? {
                create: {
                  requestId: data.requestId,
                  amount: decimal(cents(data.deposit)),
                  method: data.method,
                  kind:
                    cents(data.deposit) === quote.due
                      ? "BALANCE"
                      : data.paymentKind,
                  actorId: actor.id,
                  actorName: actor.name,
                  allocations: {
                    create: {
                      source: "REPAIR",
                      amount: decimal(cents(data.deposit)),
                    },
                  },
                },
              }
            : undefined,
      },
    });
    await audit(tx, actor, order.id, "ORDER_CREATED", {
      requestId: data.requestId,
      total: decimal(quote.due),
      initialStatus,
      inspectionMode: diagnostic,
    });
    if (diagnostic)
      await audit(tx, actor, order.id, "INSPECTION_STARTED", {
        fee: decimal(cents(data.diagnosticFee)),
      });
    if (cents(data.deposit) > 0)
      await audit(tx, actor, order.id, "PAYMENT_ADDED", {
        amount: decimal(cents(data.deposit)),
        method: data.method,
        kind: cents(data.deposit) === quote.due ? "BALANCE" : data.paymentKind,
      });
    return order;
  });
}
export async function updateOrder(actorInput: Actor, id: string, raw: unknown) {
  const data = editInput.parse(raw);
  return transact(async (tx) => {
    await assertDueDate(tx, data.dueDate);
    const actor = await currentActor(tx, actorInput);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: {
        faults: true,
        device: true,
        relatedDevices: { include: { device: true } },
      },
    });
    if (originalOrderLocked(order))
      throw new BusinessError("La scheda è chiusa.");
    const { customFaults, standardFaultIds, customerId, ...fields } = data;
    let deviceId = order.deviceId;
    let customerName = order.customerName;
    if (customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, deletedAt: null },
      });
      if (!customer) throw new BusinessError("Cliente non disponibile.");
      const associatedDevices = [
        ...order.relatedDevices.map((related) => related.device),
        order.device,
      ];
      const devices = [
        ...new Map(
          associatedDevices.map((device) => [device.id, device]),
        ).values(),
      ];
      const replacementIds = new Map<string, string>();
      for (const device of devices) {
        if (device.customerId === customer.id) {
          replacementIds.set(device.id, device.id);
          continue;
        }
        const clone = await tx.device.create({
          data: {
            customerId: customer.id,
            category: device.category,
            brand: device.brand,
            series: device.series,
            model: device.model,
            imei: device.imei,
            appearance: device.appearance,
            accessories: device.accessories,
          },
        });
        replacementIds.set(device.id, clone.id);
      }
      deviceId = replacementIds.get(order.deviceId)!;
      customerName = customer.name;
      const previousRelatedIds = new Set(
        order.relatedDevices.map((related) => related.deviceId),
      );
      const nextRelatedIds = new Set(
        [...previousRelatedIds, order.deviceId].map(
          (relatedId) => replacementIds.get(relatedId) ?? relatedId,
        ),
      );
      if (
        nextRelatedIds.size !== previousRelatedIds.size ||
        [...nextRelatedIds].some(
          (relatedId) => !previousRelatedIds.has(relatedId),
        )
      ) {
        await tx.workOrderDevice.deleteMany({ where: { orderId: id } });
        await tx.workOrderDevice.createMany({
          data: [...nextRelatedIds].map((relatedId) => ({
            orderId: id,
            deviceId: relatedId,
          })),
        });
      }
    }
    if (standardFaultIds) {
      const device = await tx.device.findUniqueOrThrow({
        where: { id: deviceId },
      });
      const selected = await tx.faultOption.findMany({
        where: {
          id: { in: standardFaultIds },
          category: device.category,
          hidden: false,
        },
      });
      if (selected.length !== standardFaultIds.length)
        throw new BusinessError(
          "Uno dei problemi selezionati non è disponibile.",
        );
      await tx.workOrderFault.deleteMany({
        where: { orderId: id, custom: false },
      });
      if (selected.length)
        await tx.workOrderFault.createMany({
          data: selected.map((fault) => ({
            orderId: id,
            catalogId: fault.id,
            nameSnapshot: fault.name,
            custom: false,
          })),
        });
    }
    if (customFaults) {
      await tx.workOrderFault.deleteMany({
        where: { orderId: id, custom: true },
      });
      if (customFaults.length)
        await tx.workOrderFault.createMany({
          data: customFaults.map((nameSnapshot) => ({
            orderId: id,
            nameSnapshot,
            custom: true,
          })),
        });
    }
    const standardSnapshots = standardFaultIds
      ? (
          await tx.workOrderFault.findMany({
            where: { orderId: id, custom: false },
          })
        ).map((fault) => fault.nameSnapshot)
      : order.faults
          .filter((fault) => !fault.custom)
          .map((fault) => fault.nameSnapshot);
    const customSnapshots =
      customFaults ??
      order.faults
        .filter((fault) => fault.custom)
        .map((fault) => fault.nameSnapshot);
    await tx.workOrder.update({
      where: { id },
      data: {
        ...fields,
        deviceId,
        customerName,
        ...(customFaults || standardFaultIds
          ? { fault: [...standardSnapshots, ...customSnapshots].join("; ") }
          : {}),
        dueDate: data.dueDate || null,
      },
    });
    await audit(tx, actor, id, "ORDER_UPDATED", { fields: Object.keys(data) });
  });
}

export async function completeInspection(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  const data = inspectionQuoteInput.parse(raw);
  return transact(async (tx) => {
    await assertDueDate(tx, data.dueDate);
    const actor = await currentActor(tx, actorInput);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: orderInclude,
    });
    if (order.status !== "DIAGNOSING" || !order.inspectionMode)
      throw new BusinessError("La scheda non è in diagnosi.");
    const items = await snapshots(tx, actor, order.device, data.items);
    const requiredParts = await requiredPartLines(tx, items);
    const faults = await tx.faultOption.findMany({
      where: {
        id: { in: data.standardFaultIds },
        category: order.device.category,
        hidden: false,
      },
    });
    if (faults.length !== data.standardFaultIds.length)
      throw new BusinessError("Seleziona almeno un problema valido.");
    if (
      balance(items, order.payments, {
        ...data,
        inspectionFee: order.inspectionFee,
        products: order.products,
      }) < 0
    )
      throw new BusinessError(
        "Il nuovo totale è inferiore agli incassi già registrati.",
      );
    await tx.workOrderProduct.deleteMany({
      where: { orderId: id, kind: "REPAIR_PART", consumedAt: null },
    });
    await tx.workOrderItem.deleteMany({ where: { orderId: id } });
    await tx.workOrderFault.deleteMany({ where: { orderId: id } });
    const nextStatus = (await newLinesNeedParts(tx, requiredParts, id))
      ? "PARTS_MISSING"
      : "REPAIRING";
    await tx.workOrder.update({
      where: { id },
      data: {
        inspectionResult: "",
        inspectionMode: false,
        faultNote: data.faultNote,
        fault: faults.map((fault) => fault.name).join("; "),
        faults: {
          create: faults.map((fault) => ({
            catalogId: fault.id,
            nameSnapshot: fault.name,
            custom: false,
          })),
        },
        items: { create: items },
        orderDiscount: decimal(cents(data.orderDiscount)),
        includeVat: data.includeVat,
        dueDate: data.dueDate || null,
        status: nextStatus,
        products: requiredParts.length
          ? {
              create: requiredParts.map(({ product, quantity }) => ({
                productId: product.id,
                productName: product.name,
                category: product.category,
                kind: "REPAIR_PART" as const,
                unitPrice: decimal(0),
                quantity,
              })),
            }
          : undefined,
      },
    });
    await tx.statusHistory.create({
      data: {
        orderId: id,
        from: "DIAGNOSING",
        to: nextStatus,
        actorId: actor.id,
        actorName: actor.name,
      },
    });
    await audit(tx, actor, id, "INSPECTION_COMPLETED", {
      faults: faults.map((fault) => fault.name),
      faultNote: data.faultNote,
    });
    await audit(tx, actor, id, "QUOTE_CREATED", {
      items: items.map((item) => ({
        project: item.project,
        final: item.final,
      })),
    });
    for (const productId of new Set([
      ...order.products
        .filter((line) => line.kind === "REPAIR_PART" && !line.consumedAt)
        .map((line) => line.productId),
      ...requiredParts.map((line) => line.product.id),
    ]))
      await refreshPartStatuses(tx, actor, productId);
  });
}
export async function updateDueDate(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  return transact(async (tx) => {
    const order = await tx.workOrder.findUniqueOrThrow({ where: { id } });
    const expectedAt =
      order.type === "QUICK_SERVICE"
        ? quickServiceExpectedAtInput.parse(raw)
        : null;
    const dueDate =
      order.type === "QUICK_SERVICE"
        ? (expectedAt?.slice(0, 10) ?? "")
        : dueDateInput.parse(raw);
    await assertDueDate(tx, dueDate);
    const actor = await currentActor(tx, actorInput);
    if (originalOrderLocked(order) && !order.afterSalesOpen)
      throw new BusinessError("La scheda è chiusa.");
    const data = order.afterSalesOpen
      ? { afterSalesDueDate: dueDate || null }
      : order.type === "QUICK_SERVICE"
        ? { dueDate: dueDate || null, expectedAt: expectedAt || null }
        : { dueDate: dueDate || null };
    await tx.workOrder.update({
      where: { id },
      data,
    });
    await audit(tx, actor, id, "ORDER_DUE_DATE_UPDATED", {
      dueDate,
      expectedAt,
      afterSales: Boolean(order.afterSalesOpen),
    });
  });
}
export async function replaceQuote(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  const parsed = Array.isArray(raw) ? null : quoteInput.parse(raw);
  const itemsInput =
    parsed?.items ?? z.array(itemInput).min(1).max(30).parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: orderInclude,
    });
    if (originalOrderLocked(order))
      throw new BusinessError("La scheda è chiusa.");
    if (order.status === "DIAGNOSING")
      throw new BusinessError(
        "Completa prima la diagnosi e crea il preventivo.",
      );
    const items = await snapshots(
      tx,
      actor,
      order.device,
      itemsInput,
      order.items,
    );
    const options = parsed ?? order;
    const unchangedRequirements = new Map<string, number>();
    for (const item of items) {
      const previous = order.items.find(
        (candidate) =>
          candidate.project.trim().toLowerCase() ===
          item.project.trim().toLowerCase(),
      );
      if (
        previous &&
        previous.requiredProductId === item.requiredProductId &&
        previous.priceOptionId === item.priceOptionId
      )
        unchangedRequirements.set(
          item.requiredProductId ?? "",
          (unchangedRequirements.get(item.requiredProductId ?? "") ?? 0) +
            item.requiredQuantity,
        );
    }
    const itemRequirements = new Map<string, number>();
    for (const item of items)
      if (item.requiredProductId)
        itemRequirements.set(
          item.requiredProductId,
          (itemRequirements.get(item.requiredProductId) ?? 0) +
            item.requiredQuantity,
        );
    const requiredProducts = itemRequirements.size
      ? await tx.product.findMany({
          where: { id: { in: [...itemRequirements.keys()] } },
        })
      : [];
    const preservedInactiveProductIds = new Set<string>();
    for (const product of requiredProducts) {
      if (product.enabled && product.usage === "REPAIR") continue;
      const quantity = itemRequirements.get(product.id) ?? 0;
      if (unchangedRequirements.get(product.id) !== quantity)
        throw new BusinessError("Ricambio non disponibile.");
      if (order.status !== "READY") {
        const reservedQuantity = order.products
          .filter(
            (line) =>
              line.kind === "REPAIR_PART" &&
              line.productId === product.id &&
              !line.consumedAt,
          )
          .reduce((sum, line) => sum + line.quantity, 0);
        if (reservedQuantity !== quantity)
          throw new BusinessError("Ricambio non disponibile.");
      }
      preservedInactiveProductIds.add(product.id);
    }
    const requiredParts = await requiredPartLines(
      tx,
      items,
      preservedInactiveProductIds,
    );
    if (order.status === "READY") {
      const previousRequirements = new Map<string, number>();
      for (const item of order.items)
        if (item.requiredProductId)
          previousRequirements.set(
            item.requiredProductId,
            (previousRequirements.get(item.requiredProductId) ?? 0) +
              item.requiredQuantity,
          );
      const nextRequirements = new Map(
        requiredParts.map(({ product, quantity }) => [product.id, quantity]),
      );
      if (
        previousRequirements.size !== nextRequirements.size ||
        [...previousRequirements].some(
          ([productId, quantity]) =>
            nextRequirements.get(productId) !== quantity,
        )
      )
        throw new BusinessError(
          "Per modificare i ricambi richiesti, riaprire prima la riparazione.",
        );
      if (
        order.products.some(
          (line) => line.kind === "REPAIR_PART" && !line.consumedAt,
        )
      )
        throw new BusinessError(
          "Verifica i ricambi non contabilizzati prima di modificare il preventivo.",
        );
    }
    if (
      balance(items, order.payments, {
        ...options,
        inspectionFee: order.inspectionFee,
        products: order.products,
      }) < 0
    )
      throw new BusinessError(
        "Il nuovo totale è inferiore agli incassi già registrati.",
      );
    await audit(tx, actor, id, "QUOTE_UPDATED", {
      beforeOptions: {
        orderDiscount: order.orderDiscount.toString(),
        includeVat: order.includeVat,
      },
      afterOptions: {
        orderDiscount: options.orderDiscount.toString(),
        includeVat: options.includeVat,
      },
      before: order.items.map((i) => ({
        project: i.project,
        priceOptionId: i.priceOptionId,
        priceOptionName: i.priceOptionName,
        suggested: i.suggested?.toString() ?? null,
        final: i.final.toString(),
        discount: i.discount.toString(),
        matchLevel: i.matchLevel,
        adjustmentReason: i.adjustmentReason,
      })),
      after: items.map((i) => ({
        project: i.project,
        priceOptionId: i.priceOptionId,
        priceOptionName: i.priceOptionName,
        suggested: i.suggested?.toString() ?? null,
        final: i.final,
        discount: i.discount,
        matchLevel: i.matchLevel,
        adjustmentReason: i.adjustmentReason,
      })),
    });
    await tx.workOrderItem.deleteMany({ where: { orderId: id } });
    await tx.workOrderProduct.deleteMany({
      where: {
        orderId: id,
        kind: "REPAIR_PART",
        consumedAt: null,
        ...(preservedInactiveProductIds.size
          ? { productId: { notIn: [...preservedInactiveProductIds] } }
          : {}),
      },
    });
    const existingPartContexts = requiredParts.length
      ? await tx.workOrderProduct.findMany({
          where: {
            orderId: id,
            kind: "REPAIR_PART",
            productId: { in: requiredParts.map((line) => line.product.id) },
          },
          select: { productId: true, contextKey: true },
        })
      : [];
    const requiredPartContexts = new Map<string, string>();
    for (const { product } of requiredParts) {
      if (preservedInactiveProductIds.has(product.id)) continue;
      const used = new Set(
        existingPartContexts
          .filter((line) => line.productId === product.id)
          .map((line) => line.contextKey),
      );
      let sequence = 1;
      let contextKey = "ORIGINAL";
      while (used.has(contextKey)) {
        sequence += 1;
        contextKey = `ORIGINAL:${sequence}`;
      }
      requiredPartContexts.set(product.id, contextKey);
    }
    const nextStatus = (await newLinesNeedParts(tx, requiredParts, id))
      ? "PARTS_MISSING"
      : "REPAIRING";
    await tx.workOrder.update({
      where: { id },
      data: {
        items: { create: items },
        orderDiscount: decimal(cents(options.orderDiscount)),
        includeVat: options.includeVat,
        confirmedAt: null,
        confirmationNote: "",
        ...(order.status === "READY" ? {} : { status: nextStatus }),
        products:
          order.status !== "READY" &&
          requiredParts.some(
            ({ product }) => !preservedInactiveProductIds.has(product.id),
          )
            ? {
                create: requiredParts
                  .filter(
                    ({ product }) =>
                      !preservedInactiveProductIds.has(product.id),
                  )
                  .map(({ product, quantity }) => ({
                    productId: product.id,
                    productName: product.name,
                    category: product.category,
                    kind: "REPAIR_PART" as const,
                    contextKey: requiredPartContexts.get(product.id),
                    unitPrice: decimal(0),
                    quantity,
                  })),
              }
            : undefined,
      },
    });
    if (order.status !== "READY" && order.status !== nextStatus)
      await tx.statusHistory.create({
        data: {
          orderId: id,
          from: order.status,
          to: nextStatus,
          actorId: actor.id,
          actorName: actor.name,
          note: "",
        },
      });
    for (const productId of new Set([
      ...order.products
        .filter((line) => line.kind === "REPAIR_PART" && !line.consumedAt)
        .map((line) => line.productId),
      ...requiredParts.map((line) => line.product.id),
    ]))
      await refreshPartStatuses(tx, actor, productId);
  });
}
export async function addPayment(actorInput: Actor, id: string, raw: unknown) {
  const data = paymentInput.parse(raw);
  if (data.kind === "DEPOSIT")
    throw new BusinessError(
      "Acconto consentito solo alla creazione della scheda.",
    );
  const amount = cents(data.amount);
  if (amount <= 0)
    throw new BusinessError("L'importo deve essere maggiore di zero.");
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const existing = await tx.payment.findUnique({
      where: { requestId: data.requestId },
    });
    if (existing) {
      if (
        existing.orderId !== id ||
        cents(existing.amount) !== amount ||
        (existing.kind !== data.kind && existing.kind !== "AFTER_SALES") ||
        existing.method !== data.method
      )
        throw new BusinessError("Richiesta di pagamento già utilizzata.");
      return existing;
    }
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: {
        items: true,
        products: true,
        payments: { include: { allocations: true } },
      },
    });
    if (["COMPLETED", "REFUNDED", "CANCELLED"].includes(order.status))
      throw new BusinessError("La scheda è chiusa.");
    if (amount > balance(order.items, order.payments, order))
      throw new BusinessError("L'importo supera il saldo da pagare.");
    const buckets = paymentBuckets(order);
    const allocation = allocatePayment(
      amount,
      Math.max(0, buckets.repairDue - buckets.repairPaid),
      Math.max(0, buckets.retailDue - buckets.retailPaid),
    );
    const kind = order.afterSalesOpen ? "AFTER_SALES" : data.kind;
    const rework = order.afterSalesOpen
      ? await tx.reworkSession.findFirst({
          where: { orderId: id, open: true },
          orderBy: { createdAt: "desc" },
        })
      : null;
    const payment = await tx.payment.create({
      data: {
        ...data,
        kind,
        amount: decimal(amount),
        orderId: id,
        reworkSessionId: rework?.id ?? null,
        actorId: actor.id,
        actorName: actor.name,
        allocations: {
          create: [
            ...(allocation.repair
              ? [
                  {
                    source:
                      order.type === "QUICK_SERVICE"
                        ? ("QUICK_SERVICE" as const)
                        : ("REPAIR" as const),
                    amount: decimal(allocation.repair),
                  },
                ]
              : []),
            ...(allocation.retail
              ? [
                  {
                    source: "RETAIL" as const,
                    amount: decimal(allocation.retail),
                  },
                ]
              : []),
          ],
        },
      },
    });
    await audit(tx, actor, id, "PAYMENT_ADDED", {
      paymentId: payment.id,
      amount: decimal(amount),
      kind,
      method: data.method,
    });
    return payment;
  });
}

export async function setPaidTotal(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  const data = paidTotalInput.parse(raw);
  const target = cents(data.amount);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const existing = await tx.auditLog.findFirst({
      where: {
        action: "PAYMENT_TOTAL_SET",
        context: { path: ["requestId"], equals: data.requestId },
      },
    });
    if (existing) return;
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: {
        items: true,
        products: true,
        payments: { include: { allocations: true } },
      },
    });
    if (originalOrderLocked(order))
      throw new BusinessError("La scheda è chiusa.");
    const due = settlement(order.items, order).due;
    if (target > due) throw new BusinessError("L'incassato supera il totale.");
    const current = order.payments.reduce(
      (sum, payment) => sum + cents(payment.amount),
      0,
    );
    const delta = target - current;
    if (!delta) return;
    const buckets = paymentBuckets(order);
    const split =
      delta > 0
        ? allocatePayment(
            delta,
            Math.max(0, buckets.repairDue - buckets.repairPaid),
            Math.max(0, buckets.retailDue - buckets.retailPaid),
          )
        : allocatePayment(
            -delta,
            Math.max(0, buckets.repairPaid),
            Math.max(0, buckets.retailPaid),
          );
    const payment = await tx.payment.create({
      data: {
        requestId: data.requestId,
        orderId: id,
        amount: decimal(delta),
        method: data.method,
        kind: "OTHER",
        actorId: actor.id,
        actorName: actor.name,
        allocations: {
          create: [
            ...(split.repair
              ? [
                  {
                    source:
                      order.type === "QUICK_SERVICE"
                        ? ("QUICK_SERVICE" as const)
                        : ("REPAIR" as const),
                    amount: decimal(delta > 0 ? split.repair : -split.repair),
                  },
                ]
              : []),
            ...(split.retail
              ? [
                  {
                    source: "RETAIL" as const,
                    amount: decimal(delta > 0 ? split.retail : -split.retail),
                  },
                ]
              : []),
          ],
        },
      },
    });
    await audit(tx, actor, id, "PAYMENT_TOTAL_SET", {
      requestId: data.requestId,
      paymentId: payment.id,
      before: decimal(current),
      after: decimal(target),
      difference: decimal(delta),
      method: data.method,
      reason: data.adjustmentReason,
    });
  });
}
export async function changeStatus(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  const data = statusInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: {
        items: true,
        products: { include: { product: true } },
        payments: true,
      },
    });
    if (order.status === data.status) return order;
    if (data.status === "REFUNDED")
      throw new BusinessError("Usa l'operazione post-vendita dedicata.");
    const resumeRework =
      order.status === "READY" &&
      data.status === "REWORKING" &&
      order.afterSalesOpen;
    if (data.status === "REWORKING" && !resumeRework)
      throw new BusinessError("Usa l'operazione post-vendita dedicata.");
    if (order.type === "QUICK_SERVICE") {
      const transitions: Record<string, string[]> = {
        RECEIVED: ["REPAIRING", "CANCELLED"],
        REPAIRING: ["READY", "CANCELLED"],
        READY: ["COMPLETED", "REPAIRING", "CANCELLED"],
      };
      if (!(transitions[order.status] ?? []).includes(data.status))
        throw new BusinessError("Passaggio di stato non consentito.");
    } else {
      assertTransition(order.status, data.status, order.afterSalesOpen);
    }

    if (
      data.status === "COMPLETED" &&
      order.products.some(
        (line) => line.kind === "REPAIR_PART" && !line.consumedAt,
      )
    )
      throw new BusinessError(
        "Ricambi non registrati: completa prima il controllo di magazzino.",
      );

    if (data.cancelPayment) {
      if (order.status !== "DIAGNOSING" || data.status !== "CANCELLED")
        throw new BusinessError(
          "Il costo diagnosi può essere incassato solo durante l'annullamento della diagnosi.",
        );
      const amount = cents(data.cancelPayment.amount);
      const remaining = balance(order.items, order.payments, order);
      if (amount <= 0 || amount > remaining)
        throw new BusinessError("Importo diagnosi non valido.");
      const existing = await tx.payment.findUnique({
        where: { requestId: data.cancelPayment.requestId },
      });
      if (!existing) {
        const payment = await tx.payment.create({
          data: {
            requestId: data.cancelPayment.requestId,
            orderId: id,
            amount: decimal(amount),
            method: data.cancelPayment.method,
            kind: "BALANCE",
            actorId: actor.id,
            actorName: actor.name,
            allocations: {
              create: { source: "REPAIR", amount: decimal(amount) },
            },
          },
        });
        order.payments.push(payment);
        await audit(tx, actor, id, "PAYMENT_ADDED", {
          paymentId: payment.id,
          amount: decimal(amount),
          kind: "BALANCE",
          method: data.cancelPayment.method,
          cancellation: true,
        });
      }
    }

    if (data.status === "REPAIRING" && (await orderNeedsParts(tx, id)))
      throw new BusinessError(
        "Ricambi insufficienti: rifornisci il magazzino prima di avviare la riparazione.",
      );
    if (data.status === "READY" && (await orderNeedsParts(tx, id)))
      throw new BusinessError(
        "Ricambi insufficienti: rifornisci il magazzino prima di completare la riparazione.",
      );

    if (data.status === "COMPLETED") {
      if (!data.pickedUpBy)
        throw new BusinessError("Indica chi ritira il dispositivo.");
      assertDelivery(balance(order.items, order.payments, order));
    }
    if (data.status === "READY")
      await consumeWorkOrderProducts(tx, actor, id, "REPAIR_PART");
    if (data.status === "COMPLETED")
      await consumeWorkOrderProducts(tx, actor, id, "RETAIL_ADDON");
    await tx.workOrder.update({
      where: { id },
      data: {
        status: data.status,
        ...(data.status === "COMPLETED"
          ? {
              pickedUpAt: order.pickedUpAt ?? new Date(),
              pickedUpBy: order.pickedUpBy ?? data.pickedUpBy,
              afterSalesOpen: false,
              afterSalesDueDate: null,
            }
          : {}),
      },
    });
    if (data.status === "COMPLETED" && !order.pickedUpAt) {
      const start = new Date();
      for (const item of order.items)
        if (item.warrantyDays > 0) {
          const expires = new Date(start);
          expires.setUTCDate(expires.getUTCDate() + item.warrantyDays);
          await tx.workOrderItem.update({
            where: { id: item.id },
            data: { warrantyStart: start, warrantyExpiresAt: expires },
          });
        }
    }
    if (data.status === "COMPLETED" && order.afterSalesOpen)
      await tx.reworkSession.updateMany({
        where: { orderId: id, open: true },
        data: { open: false },
      });
    if (data.status === "CANCELLED")
      for (const productId of new Set(
        order.products
          .filter((line) => line.kind === "REPAIR_PART" && !line.consumedAt)
          .map((line) => line.productId),
      ))
        await refreshPartStatuses(tx, actor, productId);
    await tx.statusHistory.create({
      data: {
        orderId: id,
        from: order.status,
        to: data.status,
        actorId: actor.id,
        actorName: actor.name,
        note: data.note,
      },
    });
    await audit(
      tx,
      actor,
      id,
      data.status === "COMPLETED" ? "ORDER_DELIVERED" : "STATUS_CHANGED",
      {
        from: order.status,
        to: data.status,
        ...(data.status === "CANCELLED"
          ? {
              originalDue: decimal(settlement(order.items, order).due),
              originalReceived: decimal(
                order.payments.reduce(
                  (sum, payment) => sum + cents(payment.amount),
                  0,
                ),
              ),
              reason: data.note,
            }
          : {}),
        unpaidOverride:
          data.status === "COMPLETED" &&
          balance(order.items, order.payments, order) > 0,
        balance: decimal(balance(order.items, order.payments, order)),
      },
    );
    return tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: { items: true, products: true, payments: true },
    });
  });
}
export async function savePriceRule(
  actorInput: Actor,
  id: string | null,
  raw: unknown,
) {
  const input = ruleInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    assertOwner(actor);
    const data = {
      ...input,
      category: input.category,
      brand: normalizeBrand(input.brand),
      series: normalizeModel(input.series),
      model: normalizeDeviceModel(input.brand, input.model),
      project: input.project.toLowerCase(),
      suggested: decimal(cents(input.suggested)),
      cost: input.cost ? decimal(cents(input.cost)) : null,
      requiredProductId: input.requiredProductId || null,
    };
    const before = id
      ? await tx.priceRule.findUniqueOrThrow({ where: { id } })
      : null;
    const rule = id
      ? await tx.priceRule.update({ where: { id }, data })
      : await tx.priceRule.create({ data });
    if (
      input.requiredProductId &&
      (!before || before.requiredProductId !== input.requiredProductId)
    ) {
      const product = await tx.product.findFirst({
        where: {
          id: input.requiredProductId,
          enabled: true,
          usage: "REPAIR",
        },
      });
      if (!product) throw new BusinessError("Ricambio non disponibile.");
      await tx.priceRuleOption.updateMany({
        where: { ruleId: rule.id, isDefault: true },
        data: { isDefault: false },
      });
      await tx.priceRuleOption.upsert({
        where: {
          ruleId_productId: {
            ruleId: rule.id,
            productId: product.id,
          },
        },
        create: {
          ruleId: rule.id,
          productId: product.id,
          name: product.name,
          suggested: data.suggested,
          cost: data.cost ?? product.costPrice,
          quantity: input.requiredQuantity,
          minutes: input.minutes,
          isDefault: true,
        },
        update: {
          suggested: data.suggested,
          cost: data.cost ?? product.costPrice,
          quantity: input.requiredQuantity,
          minutes: input.minutes,
          enabled: true,
          isDefault: true,
        },
      });
      await syncPriceOptionCompatibility(tx, rule, product.id);
    }
    await syncLegacyDefaultPriceOption(tx, rule.id);
    await audit(
      tx,
      actor,
      rule.id,
      id ? "PRICE_RULE_UPDATED" : "PRICE_RULE_CREATED",
      {
        before: before ? JSON.parse(JSON.stringify(before)) : null,
        after: data,
      },
    );
    return rule;
  });
}

async function syncPriceOptionCompatibility(
  tx: Tx,
  rule: {
    category: string;
    brand: string;
    series: string;
    model: string;
    project: string;
  },
  productId: string,
) {
  const model = rule.model || rule.series;
  if (!rule.brand || !model) return;
  const key = {
    productId,
    category: rule.category,
    brand: normalizeBrand(rule.brand),
    model: normalizeDeviceModel(rule.brand, model),
    project: rule.project.trim().toLowerCase(),
  };
  await tx.productCompatibility.upsert({
    where: { productId_category_brand_model_project: key },
    create: key,
    update: {},
  });
}

export async function syncLegacyDefaultPriceOption(tx: Tx, ruleId: string) {
  const fallback = await tx.priceRuleOption.findFirst({
    where: {
      ruleId,
      enabled: true,
      product: { enabled: true, usage: "REPAIR" },
    },
    orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
  });
  if (!fallback) {
    await tx.priceRuleOption.updateMany({
      where: { ruleId, isDefault: true },
      data: { isDefault: false },
    });
    await tx.priceRule.update({
      where: { id: ruleId },
      data: { requiredProductId: null, requiredQuantity: 1 },
    });
    return;
  }
  await tx.priceRuleOption.updateMany({
    where: { ruleId, isDefault: true, id: { not: fallback.id } },
    data: { isDefault: false },
  });
  if (!fallback.isDefault)
    await tx.priceRuleOption.update({
      where: { id: fallback.id },
      data: { isDefault: true },
    });
  await tx.priceRule.update({
    where: { id: ruleId },
    data: {
      requiredProductId: fallback.productId,
      requiredQuantity: fallback.quantity,
    },
  });
}

export async function savePriceRuleOption(
  actorInput: Actor,
  ruleId: string,
  id: string | null,
  raw: unknown,
) {
  const input = priceRuleOptionInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    assertOwner(actor);
    const [rule, product, existingCount] = await Promise.all([
      tx.priceRule.findUniqueOrThrow({ where: { id: ruleId } }),
      tx.product.findFirst({
        where: { id: input.productId, enabled: true, usage: "REPAIR" },
      }),
      tx.priceRuleOption.count({ where: { ruleId, enabled: true } }),
    ]);
    if (!product) throw new BusinessError("Ricambio non disponibile.");
    const before = id
      ? await tx.priceRuleOption.findFirstOrThrow({ where: { id, ruleId } })
      : null;
    if (before && before.productId !== product.id) {
      const usedByWorkOrders = await tx.workOrderItem.count({
        where: {
          OR: [
            { priceOptionId: before.id },
            {
              ruleId,
              priceOptionId: null,
              requiredProductId: before.productId,
            },
          ],
        },
      });
      if (usedByWorkOrders)
        throw new BusinessError(
          "Non puoi cambiare il ricambio di un'opzione già usata in una scheda. Crea una nuova opzione.",
        );
    }
    const isDefault = input.isDefault || existingCount === 0;
    if (isDefault)
      await tx.priceRuleOption.updateMany({
        where: { ruleId, isDefault: true, ...(id ? { id: { not: id } } : {}) },
        data: { isDefault: false },
      });
    const data = {
      productId: product.id,
      name: input.name,
      suggested: decimal(cents(input.suggested)),
      cost: input.cost ? decimal(cents(input.cost)) : product.costPrice,
      quantity: input.quantity,
      minutes: input.minutes,
      warrantyDays: input.warrantyDays,
      enabled: input.enabled,
      isDefault,
      notes: input.notes,
    };
    const option = id
      ? await tx.priceRuleOption.update({ where: { id }, data })
      : await tx.priceRuleOption.create({
          data: {
            ...data,
            ruleId,
            sortOrder: await tx.priceRuleOption.count({ where: { ruleId } }),
          },
        });
    await syncPriceOptionCompatibility(tx, rule, product.id);
    await syncLegacyDefaultPriceOption(tx, ruleId);
    await audit(
      tx,
      actor,
      option.id,
      before ? "PRICE_RULE_OPTION_UPDATED" : "PRICE_RULE_OPTION_CREATED",
      {
        ruleId,
        before: before ? JSON.parse(JSON.stringify(before)) : null,
        after: data,
      },
    );
    return option;
  });
}

export async function deletePriceRuleOption(
  actorInput: Actor,
  ruleId: string,
  id: string,
) {
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    assertOwner(actor);
    const option = await tx.priceRuleOption.findFirstOrThrow({
      where: { id, ruleId },
    });
    await tx.priceRuleOption.update({
      where: { id },
      data: { enabled: false, isDefault: false },
    });
    await syncLegacyDefaultPriceOption(tx, ruleId);
    await audit(tx, actor, id, "PRICE_RULE_OPTION_DELETED", {
      ruleId,
      productId: option.productId,
      disabled: true,
    });
  });
}

export async function updatePriceRuleFields(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  const input = z
    .object({
      project: z.string().trim().min(1).max(120),
      suggested: amountInput,
    })
    .parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    assertOwner(actor);
    await tx.priceRule.update({
      where: { id },
      data: {
        project: input.project,
        suggested: decimal(cents(input.suggested)),
      },
    });
    await audit(tx, actor, id, "PRICE_RULE_UPDATED", {
      fields: ["project", "suggested"],
    });
  });
}

export async function applyInventoryMovement(
  tx: Tx,
  actor: Actor,
  input: {
    requestId: string;
    productId: string;
    quantity: number;
    type:
      | "INITIAL_STOCK"
      | "STOCK_IN"
      | "RETAIL_SALE"
      | "REPAIR_USE"
      | "SALE_RETURN"
      | "MANUAL_ADJUSTMENT";
    referenceType?: string;
    referenceId?: string;
    note?: string;
  },
) {
  const existing = await tx.inventoryMovement.findUnique({
    where: { requestId: input.requestId },
  });
  if (existing) {
    if (
      existing.productId !== input.productId ||
      existing.quantity !== input.quantity ||
      existing.type !== input.type
    )
      throw new BusinessError("Richiesta di magazzino già utilizzata.");
    return existing;
  }
  if (!Number.isSafeInteger(input.quantity) || input.quantity === 0)
    throw new BusinessError("Variazione di magazzino non valida.");
  const updated = await tx.product.updateMany({
    where: {
      id: input.productId,
      ...(input.quantity < 0
        ? { stockQuantity: { gte: -input.quantity } }
        : {}),
    },
    data: { stockQuantity: { increment: input.quantity } },
  });
  if (updated.count !== 1)
    throw new BusinessError("Scorte insufficienti o prodotto non disponibile.");
  const product = await tx.product.findUniqueOrThrow({
    where: { id: input.productId },
  });
  return tx.inventoryMovement.create({
    data: {
      requestId: input.requestId,
      productId: input.productId,
      quantity: input.quantity,
      stockBefore: product.stockQuantity - input.quantity,
      stockAfter: product.stockQuantity,
      type: input.type,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      note: input.note ?? "",
      actorId: actor.id,
      actorName: actor.name,
    },
  });
}

async function consumeWorkOrderProducts(
  tx: Tx,
  actor: Actor,
  orderId: string,
  kind: "REPAIR_PART" | "RETAIL_ADDON",
) {
  const lines = await tx.workOrderProduct.findMany({
    where: { orderId, kind, consumedAt: null },
  });
  const consumedAt = new Date();
  for (const line of lines) {
    await applyInventoryMovement(tx, actor, {
      requestId: `work-order-product:${line.id}`,
      productId: line.productId,
      quantity: -line.quantity,
      type: kind === "REPAIR_PART" ? "REPAIR_USE" : "RETAIL_SALE",
      referenceType: "WORK_ORDER",
      referenceId: orderId,
    });
    await tx.workOrderProduct.update({
      where: { id: line.id },
      data: { consumedAt },
    });
  }
  for (const productId of new Set(lines.map((line) => line.productId)))
    await refreshPartStatuses(tx, actor, productId);
}

type CompatibilityInput = {
  category: string;
  brand: string;
  model: string;
  project: string;
};

async function syncProductCompatibilities(
  tx: Tx,
  productId: string,
  usage: "RETAIL" | "REPAIR",
  input: CompatibilityInput[],
) {
  const normalized = [
    ...new Map(
      (usage === "REPAIR" ? input : []).map((entry) => {
        const value = {
          category: entry.category,
          brand: normalizeBrand(entry.brand),
          model: normalizeDeviceModel(entry.brand, entry.model),
          project: entry.project.trim().toLocaleLowerCase("it"),
        };
        return [
          [value.category, value.brand, value.model, value.project]
            .map((part) => part.toLocaleLowerCase("it"))
            .join("\u0000"),
          value,
        ];
      }),
    ).values(),
  ];
  await tx.productCompatibility.deleteMany({ where: { productId } });
  if (normalized.length)
    await tx.productCompatibility.createMany({
      data: normalized.map((entry) => ({ ...entry, productId })),
      skipDuplicates: true,
    });
}

export async function createProduct(actorInput: Actor, raw: unknown) {
  const data = productInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const previous = await tx.auditLog.findFirst({
      where: {
        action: "PRODUCT_CREATED",
        context: { path: ["requestId"], equals: data.requestId },
      },
    });
    if (previous)
      return tx.product.findUniqueOrThrow({ where: { id: previous.entityId } });
    const product = await tx.product.create({
      data: {
        name: data.name,
        category: data.category,
        usage: data.usage,
        costPrice: decimal(cents(data.costPrice)),
        salePrice: decimal(cents(data.salePrice)),
        minStock: data.minStock,
        favorite: data.favorite,
        enabled: data.enabled,
      },
    });
    await tx.inventoryCategory.upsert({
      where: { name: data.category },
      create: {
        name: data.category,
        repairOnly: data.usage === "REPAIR",
      },
      update: { deletedAt: null },
    });
    if (data.initialStock > 0)
      await applyInventoryMovement(tx, actor, {
        requestId: data.requestId,
        productId: product.id,
        quantity: data.initialStock,
        type: "INITIAL_STOCK",
        referenceType: "PRODUCT",
        referenceId: product.id,
      });
    await syncProductCompatibilities(
      tx,
      product.id,
      data.usage,
      data.compatibilities,
    );
    await audit(tx, actor, product.id, "PRODUCT_CREATED", {
      requestId: data.requestId,
      initialStock: data.initialStock,
    });
    return product;
  });
}

export async function saveInventoryCategory(actorInput: Actor, raw: unknown) {
  const data = z
    .object({
      name: z.string().trim().min(1).max(120),
      repairOnly: z.boolean().default(false),
    })
    .parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const category = await tx.inventoryCategory.upsert({
      where: { name: data.name },
      create: data,
      update: { repairOnly: data.repairOnly, deletedAt: null },
    });
    await audit(tx, actor, category.id, "INVENTORY_CATEGORY_SAVED", data);
    return category;
  });
}

export async function deleteInventoryCategory(actorInput: Actor, id: string) {
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const category = await tx.inventoryCategory.findUniqueOrThrow({
      where: { id },
    });
    if (category.name.toLocaleLowerCase("it") === "ricambi")
      throw new BusinessError("La categoria Ricambi è protetta.");
    const used = await tx.product.count({
      where: {
        category: { equals: category.name, mode: "insensitive" },
        enabled: true,
      },
    });
    if (used > 0)
      throw new BusinessError(
        "Questa categoria è già utilizzata da prodotti e non può essere eliminata.",
      );
    await tx.inventoryCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, actor, category.id, "INVENTORY_CATEGORY_DELETED");
  });
}

export async function deleteDeviceCatalogOption(
  actorInput: Actor,
  raw: unknown,
) {
  const data = z
    .object({
      category: z.string().min(1).max(30),
      kind: z.enum(["BRAND", "MODEL"]),
      brand: z.string().trim().max(120).default(""),
      value: z.string().trim().min(1).max(120),
    })
    .parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const deviceReference = await tx.device.count({
      where: {
        category: data.category,
        ...(data.kind === "BRAND"
          ? { brand: { equals: data.value, mode: "insensitive" } }
          : {
              brand: { equals: data.brand, mode: "insensitive" },
              model: { equals: data.value, mode: "insensitive" },
            }),
      },
    });
    const ruleReference = await tx.priceRule.count({
      where: {
        category: data.category,
        ...(data.kind === "BRAND"
          ? { brand: { equals: data.value, mode: "insensitive" } }
          : {
              brand: { equals: data.brand, mode: "insensitive" },
              model: { equals: data.value, mode: "insensitive" },
            }),
      },
    });
    if (deviceReference + ruleReference > 0)
      throw new BusinessError(
        data.kind === "BRAND"
          ? "Il marchio è associato a dati aziendali e non può essere eliminato."
          : "Il modello è associato a dati aziendali e non può essere eliminato.",
      );
    const record = await tx.deviceCatalogDeletion.upsert({
      where: { category_kind_brand_value: data },
      create: data,
      update: {},
    });
    await audit(tx, actor, record.id, "DEVICE_CATALOG_OPTION_DELETED", data);
  });
}

export async function adjustInventory(
  actorInput: Actor,
  productId: string,
  raw: unknown,
) {
  const data = inventoryAdjustmentInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const movement = await applyInventoryMovement(tx, actor, {
      ...data,
      productId,
      referenceType: "PRODUCT",
      referenceId: productId,
    });
    await audit(tx, actor, productId, "INVENTORY_ADJUSTED", {
      movementId: movement.id,
      quantity: movement.quantity,
      type: movement.type,
    });
    await refreshPartStatuses(tx, actor, productId);
    return movement;
  });
}

export async function updateProduct(
  actorInput: Actor,
  productId: string,
  raw: unknown,
) {
  const data = productUpdateInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const current = await tx.product.findUniqueOrThrow({
      where: { id: productId },
    });
    const usageChanged = current.usage !== data.usage;
    const affectedRuleIds = new Set<string>();
    if (usageChanged || data.compatibilities) {
      const [options, rules] = await Promise.all([
        tx.priceRuleOption.findMany({
          where: { productId },
          select: { ruleId: true },
        }),
        tx.priceRule.findMany({
          where: { requiredProductId: productId },
          select: { id: true },
        }),
      ]);
      for (const { ruleId } of options) affectedRuleIds.add(ruleId);
      for (const { id } of rules) affectedRuleIds.add(id);
    }
    const stockChange = data.stockQuantity - current.stockQuantity;
    await tx.product.update({
      where: { id: productId },
      data: {
        name: data.name,
        category: data.category,
        usage: data.usage,
        costPrice: decimal(cents(data.costPrice)),
        salePrice: decimal(cents(data.salePrice)),
        minStock: data.minStock,
        favorite: data.favorite,
      },
    });
    if (current.usage === "REPAIR" && data.usage === "RETAIL")
      await tx.priceRuleOption.updateMany({
        where: { productId, enabled: true },
        data: { enabled: false, isDefault: false },
      });
    if (data.compatibilities)
      await syncProductCompatibilities(
        tx,
        productId,
        data.usage,
        data.compatibilities,
      );
    for (const ruleId of affectedRuleIds)
      await syncLegacyDefaultPriceOption(tx, ruleId);
    if (stockChange)
      await applyInventoryMovement(tx, actor, {
        requestId: crypto.randomUUID(),
        productId,
        quantity: stockChange,
        type: "MANUAL_ADJUSTMENT",
        referenceType: "PRODUCT",
        referenceId: productId,
      });
    await audit(tx, actor, productId, "PRODUCT_UPDATED", {
      stockChange,
      before: {
        costPrice: current.costPrice.toString(),
        salePrice: current.salePrice.toString(),
        stockQuantity: current.stockQuantity,
      },
      after: {
        costPrice: decimal(cents(data.costPrice)),
        salePrice: decimal(cents(data.salePrice)),
        stockQuantity: data.stockQuantity,
      },
      fields: [
        "name",
        "category",
        "usage",
        "costPrice",
        "salePrice",
        "minStock",
        "favorite",
      ],
    });
    await refreshPartStatuses(tx, actor, productId);
  });
}

export async function deleteProducts(actorInput: Actor, raw: unknown) {
  const ids = z.array(z.string().min(1)).min(1).max(500).parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const affectedOptions = await tx.priceRuleOption.findMany({
      where: { productId: { in: ids }, enabled: true },
      select: { ruleId: true },
    });
    await tx.product.updateMany({
      where: { id: { in: ids } },
      data: { enabled: false },
    });
    await tx.priceRuleOption.updateMany({
      where: { productId: { in: ids }, enabled: true },
      data: { enabled: false, isDefault: false },
    });
    for (const ruleId of new Set(affectedOptions.map(({ ruleId }) => ruleId)))
      await syncLegacyDefaultPriceOption(tx, ruleId);
    for (const id of ids) await audit(tx, actor, id, "PRODUCT_DELETED");
  });
}

export async function addWorkOrderProduct(
  actorInput: Actor,
  orderId: string,
  raw: unknown,
) {
  const data = workOrderProductInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (originalOrderLocked(order))
      throw new BusinessError("La scheda è chiusa.");
    if (data.kind === "REPAIR_PART" && order.status === "READY")
      throw new BusinessError("I ricambi sono già stati contabilizzati.");
    const product = await tx.product.findFirst({
      where: {
        id: data.productId,
        enabled: true,
        usage: data.kind === "REPAIR_PART" ? "REPAIR" : "RETAIL",
      },
    });
    if (!product) throw new BusinessError("Prodotto non disponibile.");
    const existing = await tx.workOrderProduct.findUnique({
      where: {
        orderId_productId_kind_contextKey: {
          orderId,
          productId: product.id,
          kind: data.kind,
          contextKey: "ORIGINAL",
        },
      },
    });
    if (existing?.consumedAt)
      throw new BusinessError("Il movimento di magazzino è già registrato.");
    const reserved = await tx.workOrderProduct.aggregate({
      where: {
        productId: product.id,
        consumedAt: null,
        ...(existing ? { id: { not: existing.id } } : {}),
        order: {
          status: { notIn: ["COMPLETED", "REFUNDED", "CANCELLED"] },
        },
      },
      _sum: { quantity: true },
    });
    const available = Math.max(
      0,
      product.stockQuantity - (reserved._sum.quantity ?? 0),
    );
    if (data.quantity > available)
      throw new BusinessError(
        "Scorte insufficienti o prodotto non disponibile.",
      );
    const line = await tx.workOrderProduct.upsert({
      where: {
        orderId_productId_kind_contextKey: {
          orderId,
          productId: product.id,
          kind: data.kind,
          contextKey: "ORIGINAL",
        },
      },
      create: {
        orderId,
        productId: product.id,
        productName: product.name,
        category: product.category,
        kind: data.kind,
        contextKey: "ORIGINAL",
        unitPrice:
          data.kind === "RETAIL_ADDON" ? product.salePrice : decimal(0),
        quantity: data.quantity,
      },
      update: {
        quantity: data.quantity,
        productName: product.name,
        category: product.category,
        unitPrice:
          data.kind === "RETAIL_ADDON" ? product.salePrice : decimal(0),
      },
    });
    await audit(tx, actor, orderId, "WORK_ORDER_PRODUCT_SAVED", {
      lineId: line.id,
      productId: product.id,
      kind: data.kind,
      quantity: data.quantity,
    });
    if (data.kind === "REPAIR_PART")
      await refreshPartStatuses(tx, actor, product.id);
    return line;
  });
}

export async function removeWorkOrderProduct(
  actorInput: Actor,
  orderId: string,
  lineId: string,
) {
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const line = await tx.workOrderProduct.findFirstOrThrow({
      where: { id: lineId, orderId },
      include: {
        order: { include: { items: true, products: true, payments: true } },
      },
    });
    if (line.consumedAt)
      throw new BusinessError("Il movimento di magazzino è già registrato.");
    if (originalOrderLocked(line.order))
      throw new BusinessError("La scheda è chiusa.");
    if (line.kind === "RETAIL_ADDON") {
      const remainingProducts = line.order.products.filter(
        (product) => product.id !== line.id,
      );
      if (
        balance(line.order.items, line.order.payments, {
          ...line.order,
          products: remainingProducts,
        }) < 0
      )
        throw new BusinessError(
          "L'incassato supera il nuovo totale: registra prima il rimborso.",
        );
    }
    await tx.workOrderProduct.delete({ where: { id: line.id } });
    await audit(tx, actor, orderId, "WORK_ORDER_PRODUCT_REMOVED", {
      lineId,
      productId: line.productId,
    });
    if (line.kind === "REPAIR_PART")
      await refreshPartStatuses(tx, actor, line.productId);
  });
}

export async function checkoutWorkOrder(
  actorInput: Actor,
  orderId: string,
  raw: unknown,
) {
  const data = checkoutInput.parse(raw);
  const amount = cents(data.amount);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const previousCheckout = await tx.auditLog.findFirst({
      where: {
        action: "ORDER_CHECKED_OUT",
        context: { path: ["requestId"], equals: data.requestId },
      },
    });
    if (previousCheckout) {
      if (previousCheckout.entityId !== orderId)
        throw new BusinessError("Richiesta di pagamento già utilizzata.");
      return tx.workOrder.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true, products: true, payments: true },
      });
    }
    const existing = await tx.payment.findUnique({
      where: { requestId: data.requestId },
    });
    if (existing) {
      if (existing.orderId !== orderId || cents(existing.amount) !== amount)
        throw new BusinessError("Richiesta di pagamento già utilizzata.");
      return tx.workOrder.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true, products: true, payments: true },
      });
    }
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: true,
        products: true,
        payments: { include: { allocations: true } },
      },
    });
    if (order.status !== "READY")
      throw new BusinessError("La riparazione non è pronta per la consegna.");
    if (
      order.products.some(
        (line) => line.kind === "REPAIR_PART" && !line.consumedAt,
      )
    )
      throw new BusinessError(
        "Ricambi non registrati: completa prima il controllo di magazzino.",
      );
    const remaining = balance(order.items, order.payments, order);
    if (amount !== remaining)
      throw new BusinessError(
        "Per consegnare è necessario saldare tutto il saldo residuo.",
      );
    if (amount > 0) {
      const rework = order.afterSalesOpen
        ? await tx.reworkSession.findFirst({
            where: { orderId, open: true },
            orderBy: { createdAt: "desc" },
          })
        : null;
      const buckets = paymentBuckets(order);
      const allocation = allocatePayment(
        amount,
        Math.max(0, buckets.repairDue - buckets.repairPaid),
        Math.max(0, buckets.retailDue - buckets.retailPaid),
      );
      const payment = await tx.payment.create({
        data: {
          requestId: data.requestId,
          orderId,
          reworkSessionId: rework?.id ?? null,
          amount: decimal(amount),
          method: data.method,
          kind: order.afterSalesOpen ? "AFTER_SALES" : "BALANCE",
          actorId: actor.id,
          actorName: actor.name,
          allocations: {
            create: [
              ...(allocation.repair
                ? [
                    {
                      source:
                        order.type === "QUICK_SERVICE"
                          ? ("QUICK_SERVICE" as const)
                          : ("REPAIR" as const),
                      amount: decimal(allocation.repair),
                    },
                  ]
                : []),
              ...(allocation.retail
                ? [
                    {
                      source: "RETAIL" as const,
                      amount: decimal(allocation.retail),
                    },
                  ]
                : []),
            ],
          },
        },
      });
      await audit(tx, actor, orderId, "PAYMENT_ADDED", {
        paymentId: payment.id,
        amount: decimal(amount),
        kind: order.afterSalesOpen ? "AFTER_SALES" : "BALANCE",
        method: data.method,
      });
    }
    assertDelivery(remaining - amount);
    const deliveredAt = data.pickedUpAt
      ? new Date(data.pickedUpAt)
      : new Date();
    await consumeWorkOrderProducts(tx, actor, orderId, "RETAIL_ADDON");
    await tx.workOrder.update({
      where: { id: orderId },
      data: {
        status: "COMPLETED",
        pickedUpAt: order.pickedUpAt ?? deliveredAt,
        pickedUpBy: order.pickedUpBy ?? data.pickedUpBy,
        afterSalesOpen: false,
        afterSalesDueDate: null,
      },
    });
    if (!order.pickedUpAt)
      for (const item of order.items)
        if (item.warrantyDays > 0) {
          const expires = new Date(deliveredAt);
          expires.setUTCDate(expires.getUTCDate() + item.warrantyDays);
          await tx.workOrderItem.update({
            where: { id: item.id },
            data: { warrantyStart: deliveredAt, warrantyExpiresAt: expires },
          });
        }
    if (order.afterSalesOpen)
      await tx.reworkSession.updateMany({
        where: { orderId, open: true },
        data: { open: false },
      });
    await tx.statusHistory.create({
      data: {
        orderId,
        from: "READY",
        to: "COMPLETED",
        actorId: actor.id,
        actorName: actor.name,
        note: "",
        createdAt: deliveredAt,
      },
    });
    await audit(tx, actor, orderId, "ORDER_CHECKED_OUT", {
      amount: decimal(amount),
      requestId: data.requestId,
      method: amount > 0 ? data.method : null,
      unpaidOverride: remaining - amount > 0,
      deliveredAt: deliveredAt.toISOString(),
      pickedUpBy: data.pickedUpBy,
    });
    return tx.workOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, products: true, payments: true },
    });
  });
}

export async function updateWarranty(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  const data = warrantyInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
    if (originalOrderLocked(order))
      throw new BusinessError("La scheda è chiusa.");
    if (
      data.items.some(
        (item) => !order.items.some((current) => current.id === item.id),
      )
    )
      throw new BusinessError("Intervento non valido.");
    for (const item of data.items) {
      const start = order.pickedUpAt;
      const expires = start && item.days > 0 ? new Date(start) : null;
      if (expires) expires.setUTCDate(expires.getUTCDate() + item.days);
      await tx.workOrderItem.update({
        where: { id: item.id },
        data: {
          warrantyDays: item.days,
          warrantyNotes: item.notes,
          warrantyStart: item.days > 0 ? start : null,
          warrantyExpiresAt: expires,
        },
      });
    }
    await tx.workOrder.update({
      where: { id },
      data: { updatedAt: new Date() },
    });
    await audit(tx, actor, id, "WARRANTY_UPDATED", data);
  });
}

export async function openAfterSales(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  const data = afterSalesInput.parse(raw);
  return transact(async (tx) => {
    await assertDueDate(tx, data.dueDate);
    const actor = await currentActor(tx, actorInput);
    const today = await getBusinessDay(tx);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { reworkItem: true } } },
    });
    if (order.status !== "COMPLETED")
      throw new BusinessError(
        "Il post-vendita richiede una scheda consegnata.",
      );
    const selected = data.items.map((input) => {
      const item = order.items.find(
        (candidate) => candidate.id === input.originalItemId,
      );
      if (!item) throw new BusinessError("Intervento non valido.");
      if (item.reworkItem)
        throw new BusinessError(
          "Questo intervento ha già una riparazione post-vendita.",
        );
      return {
        input,
        item,
        fee: input.treatment === "WARRANTY" ? 0 : cents(input.fee),
      };
    });
    const session = await tx.reworkSession.create({
      data: {
        orderId: id,
        dueDate: data.dueDate || null,
        notes: data.notes,
        items: {
          create: selected.map(({ input, item, fee }) => ({
            originalItemId: item.id,
            warrantyState:
              item.warrantyExpiresAt && romeDay(item.warrantyExpiresAt) >= today
                ? "ACTIVE"
                : item.warrantyDays > 0
                  ? "EXPIRED"
                  : "NONE",
            treatment: input.treatment,
            fee: decimal(fee),
            requiredProductId: input.requiredProductId || null,
            requiredQuantity: input.requiredQuantity,
          })),
        },
      },
      include: { items: true },
    });
    for (const reworkItem of session.items) {
      if (!reworkItem.requiredProductId) continue;
      const product = await tx.product.findFirst({
        where: {
          id: reworkItem.requiredProductId,
          enabled: true,
          usage: "REPAIR",
        },
      });
      if (!product) throw new BusinessError("Ricambio non disponibile.");
      await tx.workOrderProduct.create({
        data: {
          orderId: id,
          productId: product.id,
          productName: product.name,
          category: product.category,
          kind: "REPAIR_PART",
          contextKey: `REWORK:${reworkItem.id}`,
          unitPrice: decimal(0),
          quantity: reworkItem.requiredQuantity,
        },
      });
    }
    const fee = selected.reduce((sum, item) => sum + item.fee, 0);
    await tx.workOrder.update({ where: { id }, data: { status: "REWORKING" } });
    const missing = await orderNeedsParts(tx, id);
    const nextStatus = missing ? "PARTS_MISSING" : "REWORKING";
    await tx.workOrder.update({
      where: { id },
      data: {
        status: nextStatus,
        afterSalesFee: { increment: decimal(fee) },
        afterSalesDueDate: data.dueDate || null,
        afterSalesOpen: true,
      },
    });
    await tx.statusHistory.create({
      data: {
        orderId: id,
        from: "COMPLETED",
        to: nextStatus,
        actorId: actor.id,
        actorName: actor.name,
        note: selected.map(({ item }) => item.project).join(", "),
      },
    });
    await audit(tx, actor, id, "AFTER_SALES_OPENED", {
      sessionId: session.id,
      projects: selected.map(({ input, item, fee }) => ({
        originalItemId: item.id,
        project: item.project,
        treatment: input.treatment,
        fee: decimal(fee),
        requiredProductId: input.requiredProductId || null,
      })),
      notes: data.notes,
      fee: decimal(fee),
      dueDate: data.dueDate || null,
    });
  });
}

export async function updateReworkPart(
  actorInput: Actor,
  orderId: string,
  reworkItemId: string,
  raw: unknown,
) {
  const data = z
    .object({
      productId: z.string().max(100).default(""),
      quantity: z.coerce.number().int().min(1).max(999).default(1),
    })
    .parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (
      !order.afterSalesOpen ||
      !["REWORKING", "PARTS_MISSING"].includes(order.status)
    )
      throw new BusinessError(
        "La riparazione post-vendita non è modificabile.",
      );
    const item = await tx.reworkItem.findFirstOrThrow({
      where: { id: reworkItemId, session: { orderId, open: true } },
    });
    const contextKey = `REWORK:${item.id}`;
    const oldLine = await tx.workOrderProduct.findFirst({
      where: { orderId, contextKey },
    });
    if (oldLine?.consumedAt)
      throw new BusinessError("Il ricambio è già stato utilizzato.");
    if (oldLine)
      await tx.workOrderProduct.delete({ where: { id: oldLine.id } });
    let product = null;
    if (data.productId) {
      product = await tx.product.findFirst({
        where: {
          id: data.productId,
          enabled: true,
          usage: "REPAIR",
        },
      });
      if (!product) throw new BusinessError("Ricambio non disponibile.");
      await tx.workOrderProduct.create({
        data: {
          orderId,
          productId: product.id,
          productName: product.name,
          category: product.category,
          kind: "REPAIR_PART",
          contextKey,
          unitPrice: decimal(0),
          quantity: data.quantity,
        },
      });
    }
    await tx.reworkItem.update({
      where: { id: item.id },
      data: {
        requiredProductId: product?.id ?? null,
        requiredQuantity: data.quantity,
      },
    });
    const nextStatus = (await orderNeedsParts(tx, orderId))
      ? "PARTS_MISSING"
      : "REWORKING";
    await tx.workOrder.update({
      where: { id: orderId },
      data: { status: nextStatus },
    });
    await audit(tx, actor, orderId, "AFTER_SALES_PART_CHANGED", {
      reworkItemId,
      beforeProductId: item.requiredProductId,
      productId: product?.id ?? null,
      productName: product?.name ?? null,
      quantity: data.quantity,
      status: nextStatus,
    });
    for (const productId of new Set(
      [oldLine?.productId, product?.id].filter(Boolean) as string[],
    ))
      await refreshPartStatuses(tx, actor, productId);
  });
}

export async function refundOrder(actorInput: Actor, id: string, raw: unknown) {
  const data = refundInput.parse(raw);
  const refundAmount = cents(data.amount);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const existing = await tx.payment.findUnique({
      where: { requestId: data.requestId },
    });
    if (existing) {
      if (existing.orderId !== id || existing.kind !== "REFUND")
        throw new BusinessError("Richiesta di rimborso già utilizzata.");
      return existing;
    }
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: { payments: { include: { allocations: true } } },
    });
    if (order.status !== "COMPLETED")
      throw new BusinessError("Il rimborso richiede una scheda consegnata.");
    const received = order.payments.reduce(
      (sum, payment) => sum + cents(payment.amount),
      0,
    );
    if (received <= 0)
      throw new BusinessError("Non ci sono incassi da rimborsare.");
    if (refundAmount <= 0 || refundAmount > received)
      throw new BusinessError(
        "L'importo del rimborso deve essere maggiore di zero e non superare l'incassato.",
      );
    const allocations = new Map<string, number>();
    for (const allocation of order.payments.flatMap(
      (payment) => payment.allocations,
    ))
      allocations.set(
        allocation.source,
        (allocations.get(allocation.source) ?? 0) + cents(allocation.amount),
      );
    const sourceAllocations = [...allocations.entries()].filter(
      ([, amount]) => amount > 0,
    );
    const allocatedTotal = sourceAllocations.reduce(
      (sum, [, amount]) => sum + amount,
      0,
    );
    let allocatedRefund = 0;
    const refundAllocations = sourceAllocations.length
      ? sourceAllocations.map(([source, sourceAmount], index) => {
          const amount =
            index === sourceAllocations.length - 1
              ? refundAmount - allocatedRefund
              : Math.floor((refundAmount * sourceAmount) / allocatedTotal);
          allocatedRefund += amount;
          return { source, amount };
        })
      : [
          {
            source: order.type === "QUICK_SERVICE" ? "QUICK_SERVICE" : "REPAIR",
            amount: refundAmount,
          },
        ];
    const payment = await tx.payment.create({
      data: {
        requestId: data.requestId,
        orderId: id,
        amount: decimal(-refundAmount),
        method: data.method,
        kind: "REFUND",
        actorId: actor.id,
        actorName: actor.name,
        allocations: {
          create: refundAllocations.map(({ source, amount }) => ({
            source: source as "REPAIR" | "RETAIL" | "QUICK_SERVICE",
            amount: decimal(-amount),
          })),
        },
      },
    });
    await tx.workOrder.update({
      where: { id },
      data: { status: "REFUNDED", afterSalesOpen: false },
    });
    await tx.statusHistory.create({
      data: {
        orderId: id,
        from: "COMPLETED",
        to: "REFUNDED",
        actorId: actor.id,
        actorName: actor.name,
        note: data.reason,
      },
    });
    await audit(tx, actor, id, "REFUND_ISSUED", {
      paymentId: payment.id,
      amount: decimal(refundAmount),
      method: data.method,
      originalMethods: [...new Set(order.payments.map((item) => item.method))],
      reason: data.reason,
    });
    await audit(tx, actor, id, "STATUS_CHANGED", {
      from: "COMPLETED",
      to: "REFUNDED",
    });
    return payment;
  });
}

export async function createRetailSale(actorInput: Actor, raw: unknown) {
  const data = retailSaleInput.parse(raw);
  const uniqueItems = new Map<string, number>();
  for (const item of data.items)
    uniqueItems.set(
      item.productId,
      (uniqueItems.get(item.productId) ?? 0) + item.quantity,
    );
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const existing = await tx.retailSale.findUnique({
      where: { requestId: data.requestId },
      include: {
        items: true,
        serviceItems: true,
        payments: { orderBy: { receivedAt: "asc" } },
      },
    });
    if (existing) return existing;
    const products = await tx.product.findMany({
      where: {
        id: { in: [...uniqueItems.keys()] },
        enabled: true,
        usage: "RETAIL",
      },
    });
    if (products.length !== uniqueItems.size)
      throw new BusinessError("Uno o più prodotti non sono disponibili.");
    const lines = products.map((product) => {
      const quantity = uniqueItems.get(product.id) ?? 0;
      const unitPrice = cents(product.salePrice);
      return {
        product,
        quantity,
        unitPrice,
        subtotal: unitPrice * quantity,
      };
    });
    const reservations = await tx.workOrderProduct.findMany({
      where: {
        productId: { in: products.map((product) => product.id) },
        consumedAt: null,
        order: { status: { notIn: ["COMPLETED", "REFUNDED", "CANCELLED"] } },
      },
      select: { productId: true, quantity: true },
    });
    const reservedByProduct = new Map<string, number>();
    for (const reservation of reservations)
      reservedByProduct.set(
        reservation.productId,
        (reservedByProduct.get(reservation.productId) ?? 0) +
          reservation.quantity,
      );
    if (
      lines.some(
        ({ product, quantity }) =>
          quantity >
          Math.max(
            0,
            product.stockQuantity - (reservedByProduct.get(product.id) ?? 0),
          ),
      )
    )
      throw new BusinessError(
        "Scorte insufficienti o prodotto non disponibile.",
      );
    const quickServices = await tx.quickService.findMany({
      where: {
        id: { in: [...new Set(data.services.map((line) => line.serviceId))] },
        enabled: true,
      },
    });
    if (
      quickServices.length !==
      new Set(data.services.map((line) => line.serviceId)).size
    )
      throw new BusinessError("Uno o più servizi non sono disponibili.");
    const serviceLines = data.services.map((line) => {
      const service = quickServices.find(
        (entry) => entry.id === line.serviceId,
      )!;
      const unitPrice = cents(line.price);
      return {
        service,
        quantity: line.quantity,
        unitPrice,
        subtotal: unitPrice * line.quantity,
      };
    });
    const productSubtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
    const serviceSubtotal = serviceLines.reduce(
      (sum, line) => sum + line.subtotal,
      0,
    );
    const subtotal = productSubtotal + serviceSubtotal;
    const discount = cents(data.discount);
    if (discount >= subtotal)
      throw new BusinessError("Lo sconto deve essere inferiore al subtotale.");
    const totalAmount = subtotal - discount;
    const itemCount =
      lines.reduce((sum, line) => sum + line.quantity, 0) +
      serviceLines.reduce((sum, line) => sum + line.quantity, 0);
    const retailAmount = subtotal
      ? Math.round((totalAmount * productSubtotal) / subtotal)
      : 0;
    const serviceAmount = totalAmount - retailAmount;
    const sale = await tx.retailSale.create({
      data: {
        code: await nextDailyCode(tx, "sale", await getBusinessDay(tx)),
        requestId: data.requestId,
        subtotal: decimal(subtotal),
        discount: decimal(discount),
        total: decimal(totalAmount),
        itemCount,
        actorId: actor.id,
        actorName: actor.name,
        items: {
          create: lines.map((line) => ({
            productId: line.product.id,
            productName: line.product.name,
            category: line.product.category,
            unitPrice: decimal(line.unitPrice),
            quantity: line.quantity,
            subtotal: decimal(line.subtotal),
          })),
        },
        serviceItems: {
          create: serviceLines.map((line) => ({
            quickServiceId: line.service.id,
            serviceName: line.service.name,
            notes: line.service.notes,
            unitPrice: decimal(line.unitPrice),
            quantity: line.quantity,
            subtotal: decimal(line.subtotal),
          })),
        },
      },
    });
    const payment = await tx.payment.create({
      data: {
        requestId: data.requestId,
        saleId: sale.id,
        amount: decimal(totalAmount),
        method: data.method,
        kind: "SALE",
        actorId: actor.id,
        actorName: actor.name,
        allocations: {
          create: [
            ...(retailAmount
              ? [{ source: "RETAIL" as const, amount: decimal(retailAmount) }]
              : []),
            ...(serviceAmount
              ? [
                  {
                    source: "QUICK_SERVICE" as const,
                    amount: decimal(serviceAmount),
                  },
                ]
              : []),
          ],
        },
      },
    });
    for (const line of lines)
      await applyInventoryMovement(tx, actor, {
        requestId: `${data.requestId}:${line.product.id}`,
        productId: line.product.id,
        quantity: -line.quantity,
        type: "RETAIL_SALE",
        referenceType: "RETAIL_SALE",
        referenceId: sale.id,
      });
    await audit(tx, actor, sale.id, "RETAIL_SALE_COMPLETED", {
      paymentId: payment.id,
      total: decimal(totalAmount),
      itemCount,
      method: data.method,
    });
    return tx.retailSale.findUniqueOrThrow({
      where: { id: sale.id },
      include: {
        items: true,
        serviceItems: true,
        payments: { orderBy: { receivedAt: "asc" } },
      },
    });
  });
}

export async function deleteRetailSale(actorInput: Actor, id: string) {
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const sale = await tx.retailSale.findUniqueOrThrow({
      where: { id },
      include: { items: true, payments: true },
    });
    const movements = await tx.inventoryMovement.findMany({
      where: { referenceType: "RETAIL_SALE", referenceId: id },
    });
    const soldByProduct = new Map<string, number>();
    for (const item of sale.items)
      soldByProduct.set(
        item.productId,
        (soldByProduct.get(item.productId) ?? 0) + item.quantity,
      );
    const movedByProduct = new Map<string, number>();
    for (const movement of movements)
      movedByProduct.set(
        movement.productId,
        (movedByProduct.get(movement.productId) ?? 0) - movement.quantity,
      );
    if (
      soldByProduct.size !== movedByProduct.size ||
      [...soldByProduct].some(
        ([productId, quantity]) => movedByProduct.get(productId) !== quantity,
      )
    )
      throw new BusinessError(
        "I movimenti di magazzino della vendita non sono coerenti.",
      );
    for (const [productId, quantity] of soldByProduct)
      await tx.product.update({
        where: { id: productId },
        data: { stockQuantity: { increment: quantity } },
      });
    const paymentIds = sale.payments.map((payment) => payment.id);
    await tx.paymentAllocation.deleteMany({
      where: { paymentId: { in: paymentIds } },
    });
    await tx.payment.deleteMany({ where: { saleId: id } });
    await tx.inventoryMovement.deleteMany({
      where: { referenceType: "RETAIL_SALE", referenceId: id },
    });
    await tx.retailServiceItem.deleteMany({ where: { saleId: id } });
    await tx.retailSaleItem.deleteMany({ where: { saleId: id } });
    await tx.retailSale.delete({ where: { id } });
    await audit(tx, actor, id, "RETAIL_SALE_DELETED", {
      code: sale.code,
      total: sale.total.toString(),
      itemCount: sale.itemCount,
    });
    return { id };
  });
}

export async function saveQuickService(
  actorInput: Actor,
  id: string | null,
  raw: unknown,
) {
  const data = quickServiceInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const duplicate = await tx.quickService.findFirst({
      where: {
        name: { equals: data.name, mode: "insensitive" },
        ...(id ? { id: { not: id } } : {}),
      },
    });
    if (duplicate)
      throw new BusinessError("Esiste già un servizio con questo nome.");
    const service = id
      ? await tx.quickService.update({
          where: { id },
          data: {
            name: data.name,
            defaultPrice: decimal(cents(data.defaultPrice)),
            notes: data.notes,
            enabled: data.enabled,
          },
        })
      : await tx.quickService.create({
          data: {
            name: data.name,
            defaultPrice: decimal(cents(data.defaultPrice)),
            notes: data.notes,
            enabled: data.enabled,
          },
        });
    await audit(
      tx,
      actor,
      service.id,
      id ? "QUICK_SERVICE_UPDATED" : "QUICK_SERVICE_CREATED",
    );
    return service;
  });
}

export async function deleteQuickService(actorInput: Actor, id: string) {
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const service = await tx.quickService.findUniqueOrThrow({ where: { id } });
    await tx.quickService.delete({ where: { id } });
    await audit(tx, actor, id, "QUICK_SERVICE_DELETED", {
      name: service.name,
      defaultPrice: service.defaultPrice.toString(),
    });
    return { id };
  });
}

export async function createQuickServiceOrder(actorInput: Actor, raw: unknown) {
  const data = quickServiceOrderInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const previous = await tx.auditLog.findFirst({
      where: {
        action: "QUICK_SERVICE_ORDER_CREATED",
        context: { path: ["requestId"], equals: data.requestId },
      },
    });
    if (previous)
      return tx.workOrder.findUniqueOrThrow({
        where: { id: previous.entityId },
      });
    const customer = await tx.customer.findFirstOrThrow({
      where: { id: data.customerId, deletedAt: null },
    });
    const deviceIds = [...new Set(data.deviceIds)];
    const devices = await tx.device.findMany({
      where: {
        id: { in: deviceIds },
        customerId: customer.id,
        deletedAt: null,
      },
    });
    if (devices.length !== deviceIds.length)
      throw new BusinessError("Uno o più dispositivi non sono disponibili.");
    const serviceIds = [
      ...new Set(data.services.map((line) => line.serviceId)),
    ];
    const services = await tx.quickService.findMany({
      where: { id: { in: serviceIds }, enabled: true },
    });
    if (services.length !== serviceIds.length)
      throw new BusinessError("Uno o più servizi non sono disponibili.");
    const items = data.services.map((line) => {
      const service = services.find((entry) => entry.id === line.serviceId)!;
      return {
        quickServiceId: service.id,
        project: service.name,
        suggested: service.defaultPrice,
        final: decimal(cents(line.price)),
        discount: decimal(0),
        matchLevel: "SERVICE",
        minutes: 0,
      };
    });
    const primary = devices.find((device) => device.id === deviceIds[0])!;
    const order = await tx.workOrder.create({
      data: {
        code: await nextDailyCode(tx, "service", await getBusinessDay(tx)),
        type: "QUICK_SERVICE",
        deviceId: primary.id,
        customerName: customer.name,
        fault: services.map((service) => service.name).join("; "),
        status: "RECEIVED",
        dueDate: data.expectedAt.slice(0, 10),
        expectedAt: data.expectedAt,
        items: { create: items },
        relatedDevices: {
          create: deviceIds.map((deviceId) => ({ deviceId })),
        },
        history: {
          create: {
            to: "RECEIVED",
            actorId: actor.id,
            actorName: actor.name,
          },
        },
      },
    });
    await audit(tx, actor, order.id, "QUICK_SERVICE_ORDER_CREATED", {
      requestId: data.requestId,
      deviceIds,
      serviceIds,
    });
    return order;
  });
}

export async function updateQuickServiceOrder(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  const data = quickServiceOrderEditInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: { items: true, payments: true, products: true },
    });
    if (order.type !== "QUICK_SERVICE")
      throw new BusinessError("La scheda non è un servizio rapido.");
    if (["COMPLETED", "REFUNDED", "CANCELLED"].includes(order.status))
      throw new BusinessError("La scheda è chiusa.");
    const itemIds = new Set(data.items.map((item) => item.id));
    if (
      data.items.length !== order.items.length ||
      order.items.some((item) => !itemIds.has(item.id))
    )
      throw new BusinessError("I servizi della scheda sono cambiati.");
    const items = data.items.map((item) => ({
      ...order.items.find((existing) => existing.id === item.id)!,
      project: item.project,
      final: decimal(cents(item.final)),
    }));
    if (balance(items, order.payments, order) < 0)
      throw new BusinessError(
        "Il totale non può essere inferiore agli incassi già registrati.",
      );
    await assertDueDate(tx, data.expectedAt.slice(0, 10));
    await tx.workOrder.update({
      where: { id },
      data: {
        expectedAt: data.expectedAt,
        dueDate: data.expectedAt.slice(0, 10),
        notes: data.notes,
        fault: items.map((item) => item.project).join("; "),
      },
    });
    for (const item of data.items)
      await tx.workOrderItem.update({
        where: { id: item.id },
        data: {
          project: item.project,
          final: decimal(cents(item.final)),
        },
      });
    await audit(tx, actor, id, "QUICK_SERVICE_ORDER_UPDATED", {
      expectedAt: data.expectedAt,
      notes: data.notes,
      items: data.items.map(({ project, final }) => ({ project, final })),
    });
  });
}

export async function renameDeviceModel(actorInput: Actor, raw: unknown) {
  const input = renameDeviceModelInput.parse(raw);
  const brand = normalizeBrand(input.brand);
  const target = normalizeDeviceModel(brand, input.to);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const sourceWhere = {
      category: input.category,
      brand: { equals: brand, mode: "insensitive" as const },
      model: { equals: input.from, mode: "insensitive" as const },
    };
    const [deviceCount, rules, compatibilities] = await Promise.all([
      tx.device.count({ where: sourceWhere }),
      tx.priceRule.findMany({ where: sourceWhere }),
      tx.productCompatibility.findMany({ where: sourceWhere }),
    ]);
    if (!deviceCount && !rules.length && !compatibilities.length)
      throw new BusinessError("Modello non disponibile.");
    await tx.device.updateMany({
      where: sourceWhere,
      data: { brand, model: target },
    });
    for (const rule of rules) {
      const duplicate = await tx.priceRule.findFirst({
        where: {
          id: { not: rule.id },
          category: rule.category,
          brand: { equals: brand, mode: "insensitive" },
          series: rule.series,
          model: { equals: target, mode: "insensitive" },
          project: rule.project,
        },
      });
      if (duplicate) {
        await tx.workOrderItem.updateMany({
          where: { ruleId: rule.id },
          data: { ruleId: duplicate.id },
        });
        await tx.priceRule.delete({ where: { id: rule.id } });
      } else {
        await tx.priceRule.update({
          where: { id: rule.id },
          data: { brand, model: target },
        });
      }
    }
    for (const compatibility of compatibilities) {
      const duplicate = await tx.productCompatibility.findFirst({
        where: {
          id: { not: compatibility.id },
          productId: compatibility.productId,
          category: compatibility.category,
          brand: { equals: brand, mode: "insensitive" },
          model: { equals: target, mode: "insensitive" },
          project: compatibility.project,
        },
      });
      if (duplicate)
        await tx.productCompatibility.delete({
          where: { id: compatibility.id },
        });
      else
        await tx.productCompatibility.update({
          where: { id: compatibility.id },
          data: { brand, model: target },
        });
    }
    await audit(
      tx,
      actor,
      `${input.category}:${brand}:${input.from}`,
      "DEVICE_MODEL_RENAMED",
      {
        to: target,
        devices: deviceCount,
        rules: rules.length,
        compatibilities: compatibilities.length,
      },
    );
  });
}

export async function deleteWorkOrder(
  actorInput: Actor,
  id: string,
  raw: unknown,
) {
  const data = deleteWorkOrderInput.parse(raw);
  return transact(async (tx) => {
    await currentActor(tx, actorInput);
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id },
      include: {
        payments: true,
        products: true,
        reworks: true,
      },
    });
    if (data.code !== order.code)
      throw new BusinessError("Il numero della scheda non corrisponde.");
    if (order.payments.length)
      throw new BusinessError("La scheda contiene incassi o rimborsi.");
    if (order.products.length)
      throw new BusinessError(
        "La scheda contiene prenotazioni o movimenti di magazzino.",
      );
    if (order.reworks.length)
      throw new BusinessError("La scheda contiene una pratica post-vendita.");
    if (
      await tx.inventoryMovement.count({
        where: { referenceType: "WORK_ORDER", referenceId: id },
      })
    )
      throw new BusinessError(
        "La scheda contiene prenotazioni o movimenti di magazzino.",
      );
    await tx.workOrderFault.deleteMany({ where: { orderId: id } });
    await tx.statusHistory.deleteMany({ where: { orderId: id } });
    await tx.workOrderItem.deleteMany({ where: { orderId: id } });
    await tx.workOrderDevice.deleteMany({ where: { orderId: id } });
    await tx.auditLog.deleteMany({ where: { entityId: id } });
    await tx.workOrder.delete({ where: { id } });
  });
}
export async function createUser(actorInput: Actor, raw: unknown) {
  const input = userInput.parse(raw);
  const passwordHash = await hash(input.password, 12);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    assertOwner(actor);
    const user = await tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash,
      },
    });
    await audit(tx, actor, user.id, "USER_CREATED", { role: user.role });
    return { id: user.id };
  });
}
export async function setUserEnabled(
  actorInput: Actor,
  id: string,
  enabled: boolean,
) {
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    assertOwner(actor);
    if (actor.id === id)
      throw new BusinessError("Non puoi disattivare il tuo account.");
    await tx.user.update({ where: { id }, data: { enabled } });
    await audit(tx, actor, id, "USER_ACCESS_UPDATED", { enabled });
  });
}

async function syncPhones(
  tx: Tx,
  id: string,
  primary: string,
  extra: string[],
  merge = false,
) {
  const existing = merge
    ? await tx.customerPhone.findMany({ where: { customerId: id } })
    : [];
  const phones = [
    ...new Set([primary, ...existing.map((p) => p.phone), ...extra]),
  ];
  if (phones.length > 3)
    throw new BusinessError("Massimo tre telefoni per cliente.");
  const conflict = await tx.customer.findFirst({
    where: {
      id: { not: id },
      deletedAt: null,
      OR: [
        { phone: { in: phones } },
        { phones: { some: { phone: { in: phones } } } },
      ],
    },
  });
  if (conflict)
    throw new BusinessError("Telefono già associato a un altro cliente.");
  await tx.customerPhone.deleteMany({
    where: { customerId: id, phone: { notIn: phones } },
  });
  for (const phone of phones)
    await tx.customerPhone.upsert({
      where: { phone_customerId: { phone, customerId: id } },
      create: { phone, customerId: id },
      update: {},
    });
}
export async function saveCustomer(
  actorInput: Actor,
  id: string | null,
  raw: unknown,
) {
  const data = customerInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const customer = id
      ? await tx.customer.findFirstOrThrow({ where: { id, deletedAt: null } })
      : await tx.customer.create({
          data: { name: data.name, phone: data.phone },
        });
    await syncPhones(tx, customer.id, data.phone, data.additionalPhones);
    await tx.customer.update({
      where: { id: customer.id },
      data: { name: data.name, phone: data.phone },
    });
    await audit(
      tx,
      actor,
      customer.id,
      id ? "CUSTOMER_UPDATED" : "CUSTOMER_CREATED",
    );
    return { id: customer.id };
  });
}
export async function deleteCustomer(actorInput: Actor, id: string) {
  return deleteCustomers(actorInput, [id]);
}
export async function deleteCustomers(actorInput: Actor, raw: unknown) {
  const ids = [
    ...new Set(z.array(z.string().min(1)).min(1).max(500).parse(raw)),
  ];
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const customers = await tx.customer.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true },
    });
    if (customers.length !== ids.length)
      throw new BusinessError(
        "Clienti non disponibili. Aggiorna la pagina e riprova.",
      );
    const deletedAt = new Date();
    await tx.customer.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt },
    });
    await tx.device.updateMany({
      where: { customerId: { in: ids }, deletedAt: null },
      data: { deletedAt },
    });
    for (const id of ids) await audit(tx, actor, id, "CUSTOMER_DELETED");
  });
}
export async function saveDevice(actorInput: Actor, id: string, raw: unknown) {
  const parsed = deviceInput.parse(raw);
  const data = {
    ...parsed,
    brand: normalizeBrand(parsed.brand),
    model: normalizeDeviceModel(parsed.brand, parsed.model),
  };
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const before = await tx.device.findFirstOrThrow({
      where: { id, deletedAt: null, customer: { deletedAt: null } },
    });
    await tx.device.update({ where: { id }, data });
    await audit(tx, actor, id, "DEVICE_UPDATED", {
      before: { brand: before.brand, model: before.model },
      after: data,
    });
  });
}
export async function createDevice(
  actorInput: Actor,
  customerId: string,
  raw: unknown,
) {
  const parsed = deviceInput.parse(raw);
  const data = {
    ...parsed,
    brand: normalizeBrand(parsed.brand),
    model: normalizeDeviceModel(parsed.brand, parsed.model),
  };
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    await tx.customer.findFirstOrThrow({
      where: { id: customerId, deletedAt: null },
      select: { id: true },
    });
    const device = await tx.device.create({
      data: { customerId, ...data },
    });
    await audit(tx, actor, device.id, "DEVICE_CREATED", { after: data });
    return { id: device.id };
  });
}
export async function deleteDevice(actorInput: Actor, id: string) {
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    await tx.device.update({ where: { id }, data: { deletedAt: new Date() } });
    await audit(tx, actor, id, "DEVICE_DELETED");
  });
}
export async function deletePriceRules(actorInput: Actor, raw: unknown) {
  const ids = z.array(z.string().min(1)).min(1).max(500).parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    assertOwner(actor);
    const rules = await tx.priceRule.findMany({ where: { id: { in: ids } } });
    await tx.workOrderItem.updateMany({
      where: { ruleId: { in: ids } },
      data: { ruleId: null, priceOptionId: null },
    });
    await tx.priceRule.deleteMany({ where: { id: { in: ids } } });
    for (const rule of rules)
      await audit(tx, actor, rule.id, "PRICE_RULE_DELETED", {
        project: rule.project,
        suggested: rule.suggested.toString(),
      });
  });
}
export async function hideFault(
  actorInput: Actor,
  category: string,
  name: string,
) {
  const data = z
    .object({
      category: deviceInput.shape.category,
      name: z.string().trim().min(1).max(120),
    })
    .parse({ category, name });
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const key = data.name.toLowerCase();
    const fault = await tx.faultOption.upsert({
      where: { category_key: { category: data.category, key } },
      create: { ...data, key, hidden: true },
      update: { hidden: true },
    });
    await audit(tx, actor, fault.id, "FAULT_DELETED", data);
  });
}
export async function restoreFault(
  actorInput: Actor,
  category: string,
  name: string,
) {
  const data = z
    .object({
      category: deviceInput.shape.category,
      name: z.string().trim().min(1).max(120),
    })
    .parse({ category, name });
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const key = data.name.toLowerCase();
    const fault = await tx.faultOption.upsert({
      where: { category_key: { category: data.category, key } },
      create: { ...data, key, hidden: false },
      update: { hidden: false },
    });
    await audit(tx, actor, fault.id, "FAULT_RESTORED", data);
  });
}

export async function saveFault(
  actorInput: Actor,
  id: string | null,
  raw: unknown,
) {
  const data = faultCatalogInput.parse(raw);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const key = data.name.toLocaleLowerCase("it");
    const duplicate = await tx.faultOption.findUnique({
      where: { category_key: { category: data.category, key } },
    });
    if (duplicate && duplicate.id !== id)
      throw new BusinessError("Questo problema esiste già.");
    const previous = id
      ? await tx.faultOption.findUniqueOrThrow({ where: { id } })
      : null;
    if (previous && previous.category !== data.category)
      throw new BusinessError("Categoria problema non valida.");
    const sortOrder = previous
      ? previous.sortOrder
      : ((
          await tx.faultOption.aggregate({
            where: { category: data.category },
            _max: { sortOrder: true },
          })
        )._max.sortOrder ?? -1) + 1;
    const fault = previous
      ? await tx.faultOption.update({
          where: { id: previous.id },
          data: { name: data.name, key, note: data.note, hidden: data.hidden },
        })
      : await tx.faultOption.create({
          data: { ...data, key, sortOrder },
        });
    await audit(
      tx,
      actor,
      fault.id,
      previous ? "FAULT_UPDATED" : "FAULT_CREATED",
      {
        before: previous
          ? { name: previous.name, hidden: previous.hidden }
          : null,
        after: { name: fault.name, hidden: fault.hidden },
      },
    );
    return fault;
  });
}

export async function deleteFault(actorInput: Actor, id: string) {
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const fault = await tx.faultOption.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { orders: true } } },
    });
    if (fault._count.orders > 0)
      throw new BusinessError(
        "Il problema è già usato: puoi nasconderlo, ma non eliminarlo.",
      );
    await tx.faultOption.delete({ where: { id } });
    await audit(tx, actor, id, "FAULT_PERMANENTLY_DELETED", {
      name: fault.name,
      category: fault.category,
    });
  });
}

export async function reorderFaults(
  actorInput: Actor,
  category: string,
  ids: unknown,
) {
  const parsed = z.array(z.string().min(1)).max(200).parse(ids);
  const parsedCategory = deviceInput.shape.category.parse(category);
  return transact(async (tx) => {
    const actor = await currentActor(tx, actorInput);
    const found = await tx.faultOption.findMany({
      where: { category: parsedCategory, id: { in: parsed } },
      select: { id: true },
    });
    if (found.length !== parsed.length)
      throw new BusinessError("Ordinamento problemi non valido.");
    await Promise.all(
      parsed.map((id, sortOrder) =>
        tx.faultOption.update({ where: { id }, data: { sortOrder } }),
      ),
    );
    await audit(tx, actor, parsedCategory, "FAULTS_REORDERED", { ids: parsed });
  });
}
