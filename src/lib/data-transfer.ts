import type {
  AuditLog,
  Customer,
  CustomerPhone,
  Device,
  FaultOption,
  Payment,
  Product,
  InventoryMovement,
  RetailSale,
  RetailSaleItem,
  PaymentAllocation,
  WorkOrderProduct,
  PriceRule,
  PriceRuleOption,
  StatusHistory,
  WorkOrder,
  WorkOrderFault,
  WorkOrderItem,
  ReworkSession,
  ReworkItem,
  DeviceCatalogDeletion,
  ProductCompatibility,
  QuickService,
  RetailServiceItem,
  WorkOrderDevice,
  InventoryCategory,
  BusinessClock,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { BusinessError, type Actor } from "./domain";
import { normalizeBrand, normalizeModel } from "./catalog";

export const BACKUP_FORMAT = "ngt-repair-data";
export const BACKUP_VERSION = 10;

type JsonRow<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
      ? string | null
      : T[K] extends Prisma.Decimal
        ? string
        : T[K] extends Prisma.Decimal | null
          ? string | null
          : T[K];
};
type BackupData = {
  customers: JsonRow<Customer>[];
  phones: JsonRow<CustomerPhone>[];
  devices: JsonRow<Device>[];
  orders: JsonRow<WorkOrder>[];
  items: JsonRow<WorkOrderItem>[];
  payments: JsonRow<Payment>[];
  histories: JsonRow<StatusHistory>[];
  prices: JsonRow<PriceRule>[];
  priceOptions: JsonRow<PriceRuleOption>[];
  faults: JsonRow<FaultOption>[];
  audits: JsonRow<AuditLog>[];
  products: JsonRow<Product>[];
  inventoryMovements: JsonRow<InventoryMovement>[];
  retailSales: JsonRow<RetailSale>[];
  retailSaleItems: JsonRow<RetailSaleItem>[];
  paymentAllocations: JsonRow<PaymentAllocation>[];
  workOrderProducts: JsonRow<WorkOrderProduct>[];
  workOrderFaults: JsonRow<WorkOrderFault>[];
  reworkSessions: JsonRow<ReworkSession>[];
  reworkItems: JsonRow<ReworkItem>[];
  deviceCatalogDeletions: JsonRow<DeviceCatalogDeletion>[];
  productCompatibilities: JsonRow<ProductCompatibility>[];
  quickServices: JsonRow<QuickService>[];
  retailServiceItems: JsonRow<RetailServiceItem>[];
  workOrderDevices: JsonRow<WorkOrderDevice>[];
  inventoryCategories: JsonRow<InventoryCategory>[];
  businessClock: JsonRow<BusinessClock> | null;
};
export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  data: BackupData;
};
export type ImportSummary = { imported: number; skipped: number };

function date(value: string | null | undefined) {
  return value ? new Date(value) : null;
}
function ensureBackup(value: unknown): BackupFile {
  if (!value || typeof value !== "object")
    throw new BusinessError("File di backup non valido.");
  const candidate = value as Partial<BackupFile>;
  if (
    candidate.format !== BACKUP_FORMAT ||
    typeof candidate.version !== "number" ||
    candidate.version > BACKUP_VERSION ||
    !candidate.data ||
    typeof candidate.data !== "object"
  )
    throw new BusinessError("Formato di backup non supportato.");
  for (const key of [
    "customers",
    "phones",
    "devices",
    "orders",
    "items",
    "payments",
    "histories",
    "prices",
    "faults",
    "audits",
  ] as const)
    if (!Array.isArray(candidate.data[key]))
      throw new BusinessError("File di backup incompleto.");
  const products = (candidate.data as Partial<BackupData>).products ?? [];
  const priceOptions =
    (candidate.data as Partial<BackupData>).priceOptions ?? [];
  const inventoryMovements =
    (candidate.data as Partial<BackupData>).inventoryMovements ?? [];
  const retailSales = (candidate.data as Partial<BackupData>).retailSales ?? [];
  const retailSaleItems =
    (candidate.data as Partial<BackupData>).retailSaleItems ?? [];
  const paymentAllocations =
    (candidate.data as Partial<BackupData>).paymentAllocations ?? [];
  const workOrderProducts =
    (candidate.data as Partial<BackupData>).workOrderProducts ?? [];
  const workOrderFaults =
    (candidate.data as Partial<BackupData>).workOrderFaults ?? [];
  const reworkSessions =
    (candidate.data as Partial<BackupData>).reworkSessions ?? [];
  const reworkItems = (candidate.data as Partial<BackupData>).reworkItems ?? [];
  const deviceCatalogDeletions =
    (candidate.data as Partial<BackupData>).deviceCatalogDeletions ?? [];
  const productCompatibilities =
    (candidate.data as Partial<BackupData>).productCompatibilities ?? [];
  const quickServices =
    (candidate.data as Partial<BackupData>).quickServices ?? [];
  const retailServiceItems =
    (candidate.data as Partial<BackupData>).retailServiceItems ?? [];
  const workOrderDevices =
    (candidate.data as Partial<BackupData>).workOrderDevices ?? [];
  const inventoryCategories =
    (candidate.data as Partial<BackupData>).inventoryCategories ?? [];
  const businessClock =
    (candidate.data as Partial<BackupData>).businessClock ?? null;
  if (
    !Array.isArray(products) ||
    !Array.isArray(priceOptions) ||
    !Array.isArray(inventoryMovements) ||
    !Array.isArray(retailSales) ||
    !Array.isArray(retailSaleItems) ||
    !Array.isArray(paymentAllocations) ||
    !Array.isArray(workOrderProducts) ||
    !Array.isArray(workOrderFaults) ||
    !Array.isArray(reworkSessions) ||
    !Array.isArray(reworkItems) ||
    !Array.isArray(deviceCatalogDeletions) ||
    !Array.isArray(productCompatibilities) ||
    !Array.isArray(quickServices) ||
    !Array.isArray(retailServiceItems) ||
    !Array.isArray(workOrderDevices) ||
    !Array.isArray(inventoryCategories)
  )
    throw new BusinessError("File di backup incompleto.");
  return {
    ...(candidate as BackupFile),
    data: {
      ...(candidate.data as BackupData),
      products,
      priceOptions,
      inventoryMovements,
      retailSales,
      retailSaleItems,
      paymentAllocations,
      workOrderProducts,
      workOrderFaults,
      reworkSessions,
      reworkItems,
      deviceCatalogDeletions,
      productCompatibilities,
      quickServices,
      retailServiceItems,
      workOrderDevices,
      inventoryCategories,
      businessClock,
    },
  };
}
async function ensureActor(actor: Actor) {
  const found = await db.user.findFirst({
    where: { id: actor.id, enabled: true },
  });
  if (!found) throw new BusinessError("Sessione locale non valida.");
  return found;
}

export async function exportBusinessData(): Promise<BackupFile> {
  const [
    customers,
    phones,
    devices,
    orders,
    items,
    payments,
    histories,
    prices,
    priceOptions,
    faults,
    audits,
    products,
    inventoryMovements,
    retailSales,
    retailSaleItems,
    paymentAllocations,
    workOrderProducts,
    workOrderFaults,
    reworkSessions,
    reworkItems,
    deviceCatalogDeletions,
    productCompatibilities,
    quickServices,
    retailServiceItems,
    workOrderDevices,
    inventoryCategories,
    businessClock,
  ] = await db.$transaction(
    async (tx) =>
      Promise.all([
        tx.customer.findMany({ orderBy: { createdAt: "asc" } }),
        tx.customerPhone.findMany({ orderBy: { phone: "asc" } }),
        tx.device.findMany({ orderBy: { id: "asc" } }),
        tx.workOrder.findMany({ orderBy: { number: "asc" } }),
        tx.workOrderItem.findMany({ orderBy: { id: "asc" } }),
        tx.payment.findMany({ orderBy: { receivedAt: "asc" } }),
        tx.statusHistory.findMany({ orderBy: { createdAt: "asc" } }),
        tx.priceRule.findMany({
          orderBy: [
            { category: "asc" },
            { brand: "asc" },
            { model: "asc" },
            { project: "asc" },
          ],
        }),
        tx.priceRuleOption.findMany({
          orderBy: [{ ruleId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
        }),
        tx.faultOption.findMany({
          orderBy: [{ category: "asc" }, { key: "asc" }],
        }),
        tx.auditLog.findMany({ orderBy: { createdAt: "asc" } }),
        tx.product.findMany({ orderBy: { createdAt: "asc" } }),
        tx.inventoryMovement.findMany({ orderBy: { createdAt: "asc" } }),
        tx.retailSale.findMany({ orderBy: { number: "asc" } }),
        tx.retailSaleItem.findMany({ orderBy: { id: "asc" } }),
        tx.paymentAllocation.findMany({ orderBy: { id: "asc" } }),
        tx.workOrderProduct.findMany({ orderBy: { id: "asc" } }),
        tx.workOrderFault.findMany({ orderBy: { id: "asc" } }),
        tx.reworkSession.findMany({ orderBy: { createdAt: "asc" } }),
        tx.reworkItem.findMany({ orderBy: { id: "asc" } }),
        tx.deviceCatalogDeletion.findMany({ orderBy: { createdAt: "asc" } }),
        tx.productCompatibility.findMany({ orderBy: { id: "asc" } }),
        tx.quickService.findMany({ orderBy: { createdAt: "asc" } }),
        tx.retailServiceItem.findMany({ orderBy: { id: "asc" } }),
        tx.workOrderDevice.findMany({
          orderBy: [{ orderId: "asc" }, { deviceId: "asc" }],
        }),
        tx.inventoryCategory.findMany({ orderBy: { createdAt: "asc" } }),
        tx.businessClock.findUnique({ where: { id: "default" } }),
      ]),
    { isolationLevel: "RepeatableRead", timeout: 30000 },
  );
  const data = JSON.parse(
    JSON.stringify({
      customers,
      phones,
      devices,
      orders,
      items,
      payments,
      histories,
      prices,
      priceOptions,
      faults,
      audits,
      products,
      inventoryMovements,
      retailSales,
      retailSaleItems,
      paymentAllocations,
      workOrderProducts,
      workOrderFaults,
      reworkSessions,
      reworkItems,
      deviceCatalogDeletions,
      productCompatibilities,
      quickServices,
      retailServiceItems,
      workOrderDevices,
      inventoryCategories,
      businessClock,
    }),
  ) as BackupData;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

export async function clearBusinessData(actor: Actor) {
  await ensureActor(actor);
  return db.$transaction(async (tx) => {
    await tx.auditLog.deleteMany();
    await tx.paymentAllocation.deleteMany();
    await tx.payment.deleteMany();
    await tx.retailServiceItem.deleteMany();
    await tx.retailSaleItem.deleteMany();
    await tx.retailSale.deleteMany();
    await tx.workOrderProduct.deleteMany();
    await tx.reworkItem.deleteMany();
    await tx.reworkSession.deleteMany();
    await tx.inventoryMovement.deleteMany();
    await tx.statusHistory.deleteMany();
    await tx.workOrderFault.deleteMany();
    await tx.workOrderDevice.deleteMany();
    await tx.workOrderItem.deleteMany();
    await tx.priceRuleOption.deleteMany();
    await tx.priceRule.deleteMany();
    await tx.product.deleteMany();
    await tx.workOrder.deleteMany();
    await tx.device.deleteMany();
    await tx.customerPhone.deleteMany();
    await tx.customer.deleteMany();
    await tx.quickService.deleteMany();
    await tx.faultOption.deleteMany();
    await tx.deviceCatalogDeletion.deleteMany();
    await tx.inventoryCategory.deleteMany();
    await tx.businessClock.deleteMany();
    await tx.$executeRawUnsafe(
      'ALTER SEQUENCE "WorkOrder_number_seq" RESTART WITH 1',
    );
    await tx.$executeRawUnsafe(
      'ALTER SEQUENCE "RetailSale_number_seq" RESTART WITH 1',
    );
    return { id: "cleared" };
  });
}

export async function importBusinessData(
  actorInput: Actor,
  value: unknown,
): Promise<ImportSummary> {
  const actor = await ensureActor(actorInput);
  const backup = ensureBackup(value);
  let imported = 0;
  let skipped = 0;
  await db.$transaction(async (tx) => {
    const customerIds = new Map<string, string>();
    const deviceIds = new Map<string, string>();
    const priceIds = new Map<string, string>();
    const priceOptionIds = new Map<string, string>();
    const orderIds = new Map<string, string>();
    const existingOrderIds = new Set<string>();
    const saleIds = new Map<string, string>();
    const paymentIds = new Map<string, string>();
    const entityIds = new Map<string, string>();
    const faultIds = new Map<string, string>();
    const itemIds = new Map<string, string>();
    const reworkSessionIds = new Map<string, string>();
    const orderSourceIds = new Set(backup.data.orders.map((order) => order.id));

    for (const source of backup.data.inventoryCategories) {
      const existing = await tx.inventoryCategory.findFirst({
        where: { OR: [{ id: source.id }, { name: source.name }] },
      });
      if (existing) skipped++;
      else {
        await tx.inventoryCategory.create({
          data: {
            id: source.id,
            name: source.name,
            repairOnly: source.repairOnly,
            deletedAt: date(source.deletedAt),
            createdAt: date(source.createdAt) ?? new Date(),
          },
        });
        imported++;
      }
    }
    if (backup.data.businessClock) {
      const existing = await tx.businessClock.findUnique({
        where: { id: backup.data.businessClock.id },
      });
      if (existing) skipped++;
      else {
        await tx.businessClock.create({
          data: {
            id: backup.data.businessClock.id,
            mode: backup.data.businessClock.mode,
            manualDate: backup.data.businessClock.manualDate,
            updatedAt: date(backup.data.businessClock.updatedAt) ?? new Date(),
          },
        });
        imported++;
      }
    }

    for (const source of backup.data.products) {
      const existing = await tx.product.findUnique({
        where: { id: source.id },
      });
      if (existing) {
        skipped++;
      } else {
        await tx.product.create({
          data: {
            id: source.id,
            name: source.name,
            category: source.category,
            usage: source.usage,
            costPrice: source.costPrice,
            salePrice: source.salePrice,
            stockQuantity: source.stockQuantity,
            minStock: source.minStock,
            favorite: source.favorite,
            enabled: source.enabled,
            createdAt: date(source.createdAt) ?? new Date(),
            updatedAt: date(source.updatedAt) ?? new Date(),
          },
        });
        imported++;
      }
      await tx.inventoryCategory.upsert({
        where: { name: source.category },
        create: {
          name: source.category,
          repairOnly: source.usage === "REPAIR",
        },
        update: {},
      });
      entityIds.set(source.id, source.id);
    }

    for (const source of backup.data.productCompatibilities) {
      const product = await tx.product.findUnique({
        where: { id: source.productId },
      });
      if (!product) {
        skipped++;
        continue;
      }
      const existing = await tx.productCompatibility.findFirst({
        where: {
          OR: [
            { id: source.id },
            {
              productId: source.productId,
              category: source.category,
              brand: source.brand,
              model: source.model,
              project: source.project,
            },
          ],
        },
      });
      if (existing) skipped++;
      else {
        await tx.productCompatibility.create({ data: source });
        imported++;
      }
    }

    for (const source of backup.data.quickServices) {
      const existing = await tx.quickService.findUnique({
        where: { id: source.id },
      });
      if (existing) skipped++;
      else {
        await tx.quickService.create({
          data: {
            ...source,
            createdAt: date(source.createdAt) ?? new Date(),
            updatedAt: date(source.updatedAt) ?? new Date(),
          },
        });
        imported++;
      }
    }

    for (const source of backup.data.customers) {
      let target = await tx.customer.findUnique({ where: { id: source.id } });
      if (!target && !source.deletedAt)
        target = await tx.customer.findFirst({
          where: {
            deletedAt: null,
            OR: [
              { phone: source.phone },
              { phones: { some: { phone: source.phone } } },
            ],
          },
        });
      if (!target) {
        target = await tx.customer.create({
          data: {
            id: source.id,
            name: source.name,
            phone: source.phone,
            consentAt: date(source.consentAt),
            consentVersion: source.consentVersion,
            codiceFiscale: source.codiceFiscale,
            partitaIva: source.partitaIva,
            createdAt: date(source.createdAt) ?? new Date(),
            deletedAt: date(source.deletedAt),
          },
        });
        imported++;
      } else skipped++;
      customerIds.set(source.id, target.id);
      entityIds.set(source.id, target.id);
    }
    for (const source of backup.data.retailSales) {
      let target = await tx.retailSale.findUnique({ where: { id: source.id } });
      target ??= await tx.retailSale.findUnique({
        where: { requestId: source.requestId },
      });
      if (!target) {
        const numberConflict = await tx.retailSale.findUnique({
          where: { number: source.number },
        });
        if (numberConflict) {
          skipped++;
          continue;
        }
        target = await tx.retailSale.create({
          data: {
            id: source.id,
            number: source.number,
            code:
              source.code ??
              `V-LEGACY${String(source.number).padStart(6, "0")}`,
            requestId: source.requestId,
            subtotal: source.subtotal,
            discount: source.discount,
            total: source.total,
            itemCount: source.itemCount,
            actorId: actor.id,
            actorName: source.actorName,
            createdAt: date(source.createdAt) ?? new Date(),
          },
        });
        imported++;
      } else skipped++;
      saleIds.set(source.id, target.id);
      entityIds.set(source.id, target.id);
    }
    for (const source of backup.data.retailSaleItems) {
      const saleId = saleIds.get(source.saleId);
      const product = await tx.product.findUnique({
        where: { id: source.productId },
      });
      if (!saleId || !product) {
        skipped++;
        continue;
      }
      const exists = await tx.retailSaleItem.findUnique({
        where: { id: source.id },
      });
      if (exists) skipped++;
      else {
        await tx.retailSaleItem.create({
          data: {
            id: source.id,
            saleId,
            productId: source.productId,
            productName: source.productName,
            category: source.category,
            unitPrice: source.unitPrice,
            quantity: source.quantity,
            subtotal: source.subtotal,
          },
        });
        imported++;
      }
    }
    for (const source of backup.data.retailServiceItems) {
      const saleId = saleIds.get(source.saleId);
      if (!saleId) {
        skipped++;
        continue;
      }
      const quickServiceId = source.quickServiceId
        ? ((
            await tx.quickService.findUnique({
              where: { id: source.quickServiceId },
            })
          )?.id ?? null)
        : null;
      const exists = await tx.retailServiceItem.findUnique({
        where: { id: source.id },
      });
      if (exists) skipped++;
      else {
        await tx.retailServiceItem.create({
          data: { ...source, saleId, quickServiceId },
        });
        imported++;
      }
    }
    for (const source of backup.data.phones) {
      const customerId = customerIds.get(source.customerId);
      if (!customerId) {
        skipped++;
        continue;
      }
      const exists = await tx.customerPhone.findUnique({
        where: { phone_customerId: { phone: source.phone, customerId } },
      });
      const activeTarget = await tx.customer.findFirst({
        where: { id: customerId, deletedAt: null },
      });
      const conflict =
        activeTarget &&
        (await tx.customer.findFirst({
          where: {
            id: { not: customerId },
            deletedAt: null,
            OR: [
              { phone: source.phone },
              { phones: { some: { phone: source.phone } } },
            ],
          },
        }));
      if (exists || conflict) skipped++;
      else {
        await tx.customerPhone.create({
          data: { phone: source.phone, customerId },
        });
        imported++;
      }
    }
    for (const source of backup.data.devices) {
      const customerId = customerIds.get(source.customerId);
      if (!customerId) {
        skipped++;
        continue;
      }
      let target = await tx.device.findUnique({ where: { id: source.id } });
      target ??= await tx.device.findFirst({
        where: {
          customerId,
          category: source.category,
          brand: normalizeBrand(source.brand),
          series: normalizeModel(source.series),
          model: normalizeModel(source.model),
          imei: source.imei,
        },
      });
      if (!target) {
        target = await tx.device.create({
          data: {
            id: source.id,
            customerId,
            category: source.category,
            brand: normalizeBrand(source.brand),
            series: normalizeModel(source.series),
            model: normalizeModel(source.model),
            imei: source.imei,
            appearance: source.appearance,
            accessories: source.accessories,
            deletedAt: date(source.deletedAt),
          },
        });
        imported++;
      } else skipped++;
      deviceIds.set(source.id, target.id);
      entityIds.set(source.id, target.id);
    }
    for (const source of backup.data.prices) {
      let target = await tx.priceRule.findUnique({ where: { id: source.id } });
      target ??= await tx.priceRule.findUnique({
        where: {
          category_brand_series_model_project: {
            category: source.category,
            brand: normalizeBrand(source.brand),
            series: normalizeModel(source.series),
            model: normalizeModel(source.model),
            project: source.project,
          },
        },
      });
      if (!target) {
        target = await tx.priceRule.create({
          data: {
            id: source.id,
            category: source.category,
            brand: normalizeBrand(source.brand),
            series: normalizeModel(source.series),
            model: normalizeModel(source.model),
            project: source.project,
            suggested: source.suggested,
            cost: source.cost,
            minutes: source.minutes,
            enabled: source.enabled,
            notes: source.notes,
            requiredProductId:
              source.requiredProductId &&
              (await tx.product.findUnique({
                where: { id: source.requiredProductId },
              }))
                ? source.requiredProductId
                : null,
            requiredQuantity: source.requiredQuantity ?? 1,
            updatedAt: date(source.updatedAt) ?? new Date(),
          },
        });
        imported++;
      } else skipped++;
      priceIds.set(source.id, target.id);
      entityIds.set(source.id, target.id);
    }
    for (const source of backup.data.priceOptions) {
      const ruleId = priceIds.get(source.ruleId);
      const product = await tx.product.findUnique({
        where: { id: source.productId },
      });
      if (!ruleId || !product) {
        skipped++;
        continue;
      }
      let target = await tx.priceRuleOption.findUnique({
        where: { id: source.id },
      });
      target ??= await tx.priceRuleOption.findUnique({
        where: {
          ruleId_productId: { ruleId, productId: source.productId },
        },
      });
      if (!target) {
        const existingDefault = source.isDefault
          ? await tx.priceRuleOption.findFirst({
              where: { ruleId, isDefault: true },
              select: { id: true },
            })
          : null;
        target = await tx.priceRuleOption.create({
          data: {
            id: source.id,
            ruleId,
            productId: source.productId,
            name: source.name,
            suggested: source.suggested,
            cost: source.cost,
            quantity: source.quantity,
            minutes: source.minutes,
            warrantyDays: source.warrantyDays,
            enabled: source.enabled,
            isDefault: source.isDefault && !existingDefault,
            sortOrder: source.sortOrder,
            notes: source.notes,
            updatedAt: date(source.updatedAt) ?? new Date(),
          },
        });
        imported++;
      } else skipped++;
      priceOptionIds.set(source.id, target.id);
      entityIds.set(source.id, target.id);
    }
    for (const source of backup.data.orders) {
      const deviceId = deviceIds.get(source.deviceId);
      if (!deviceId) {
        skipped++;
        continue;
      }
      const target = await tx.workOrder.findUnique({
        where: { id: source.id },
      });
      if (target) {
        skipped++;
        existingOrderIds.add(source.id);
        orderIds.set(source.id, target.id);
        entityIds.set(source.id, target.id);
        continue;
      }
      const numberConflict = await tx.workOrder.findUnique({
        where: { number: source.number },
      });
      if (numberConflict) {
        skipped++;
        continue;
      }
      const created = await tx.workOrder.create({
        data: {
          id: source.id,
          number: source.number,
          code:
            source.code ?? `R-LEGACY${String(source.number).padStart(6, "0")}`,
          type: source.type ?? "REPAIR",
          customerName: source.customerName,
          deviceId,
          status: source.status,
          orderDiscount: source.orderDiscount,
          includeVat: source.includeVat,
          inspectionMode: source.inspectionMode ?? false,
          inspectionFee: source.inspectionFee ?? "0",
          inspectionResult: source.inspectionResult ?? "",
          faultNote: source.faultNote ?? "",
          fault: source.fault,
          appearance: source.appearance,
          accessories: source.accessories,
          notes: source.notes,
          dueDate: source.dueDate,
          expectedAt: source.expectedAt ?? null,
          confirmedAt: date(source.confirmedAt),
          confirmationNote: source.confirmationNote,
          pickedUpAt: date(source.pickedUpAt),
          pickedUpBy: source.pickedUpBy,
          warrantyMonths: source.warrantyMonths ?? 0,
          warrantyDays:
            source.warrantyDays ??
            { 1: 30, 3: 90, 6: 180, 12: 365 }[source.warrantyMonths ?? 0] ??
            (source.warrantyMonths ?? 0) * 30,
          warrantyScope: source.warrantyScope ?? "",
          warrantyNotes: source.warrantyNotes ?? "",
          afterSalesFee: source.afterSalesFee ?? "0",
          afterSalesDueDate: source.afterSalesDueDate ?? null,
          afterSalesOpen: source.afterSalesOpen ?? false,
          createdAt: date(source.createdAt) ?? new Date(),
          updatedAt: date(source.updatedAt) ?? new Date(),
          relatedDevices: { create: { deviceId } },
        },
      });
      imported++;
      orderIds.set(source.id, created.id);
      entityIds.set(source.id, created.id);
    }
    for (const source of backup.data.workOrderDevices) {
      if (existingOrderIds.has(source.orderId)) {
        skipped++;
        continue;
      }
      const orderId = orderIds.get(source.orderId);
      const deviceId = deviceIds.get(source.deviceId);
      if (!orderId || !deviceId) {
        skipped++;
        continue;
      }
      const exists = await tx.workOrderDevice.findUnique({
        where: { orderId_deviceId: { orderId, deviceId } },
      });
      if (exists) skipped++;
      else {
        await tx.workOrderDevice.create({ data: { orderId, deviceId } });
        imported++;
      }
    }
    for (const source of backup.data.items) {
      if (existingOrderIds.has(source.orderId)) {
        skipped++;
        continue;
      }
      const orderId = orderIds.get(source.orderId);
      if (!orderId) {
        skipped++;
        continue;
      }
      const exists = await tx.workOrderItem.findUnique({
        where: { id: source.id },
      });
      if (exists) skipped++;
      else {
        await tx.workOrderItem.create({
          data: {
            id: source.id,
            orderId,
            ruleId: source.ruleId
              ? (priceIds.get(source.ruleId) ?? null)
              : null,
            priceOptionId: source.priceOptionId
              ? (priceOptionIds.get(source.priceOptionId) ?? null)
              : null,
            priceOptionName: source.priceOptionName ?? "",
            quickServiceId: source.quickServiceId
              ? ((
                  await tx.quickService.findUnique({
                    where: { id: source.quickServiceId },
                  })
                )?.id ?? null)
              : null,
            project: source.project,
            suggested: source.suggested,
            discount: source.discount,
            final: source.final,
            matchLevel: source.matchLevel,
            adjustmentReason: source.adjustmentReason,
            minutes: source.minutes,
            requiredProductId: source.requiredProductId ?? null,
            requiredProductName: source.requiredProductName ?? "",
            requiredQuantity: source.requiredQuantity ?? 1,
            warrantyStart: date(source.warrantyStart),
            warrantyDays: source.warrantyDays ?? 0,
            warrantyExpiresAt: date(source.warrantyExpiresAt),
            warrantyNotes: source.warrantyNotes ?? "",
          },
        });
        imported++;
      }
      itemIds.set(source.id, source.id);
    }
    for (const source of backup.data.reworkSessions) {
      if (existingOrderIds.has(source.orderId)) {
        skipped++;
        continue;
      }
      const orderId = orderIds.get(source.orderId);
      if (!orderId) {
        skipped++;
        continue;
      }
      const exists = await tx.reworkSession.findUnique({
        where: { id: source.id },
      });
      if (!exists) {
        await tx.reworkSession.create({
          data: {
            id: source.id,
            orderId,
            receivedAt: date(source.receivedAt) ?? new Date(),
            dueDate: source.dueDate,
            notes: source.notes,
            open: source.open,
            createdAt: date(source.createdAt) ?? new Date(),
            updatedAt: date(source.updatedAt) ?? new Date(),
          },
        });
        imported++;
      } else skipped++;
      reworkSessionIds.set(source.id, source.id);
    }
    for (const source of backup.data.reworkItems) {
      const sessionId = reworkSessionIds.get(source.sessionId);
      const originalItemId = itemIds.get(source.originalItemId);
      if (!sessionId || !originalItemId) {
        skipped++;
        continue;
      }
      const exists = await tx.reworkItem.findUnique({
        where: { id: source.id },
      });
      if (exists) skipped++;
      else {
        await tx.reworkItem.create({
          data: {
            id: source.id,
            sessionId,
            originalItemId,
            warrantyState: source.warrantyState,
            treatment: source.treatment,
            fee: source.fee,
            requiredProductId: source.requiredProductId,
            requiredQuantity: source.requiredQuantity,
          },
        });
        imported++;
      }
    }
    for (const source of backup.data.workOrderProducts) {
      if (existingOrderIds.has(source.orderId)) {
        skipped++;
        continue;
      }
      const orderId = orderIds.get(source.orderId);
      const product = await tx.product.findUnique({
        where: { id: source.productId },
      });
      if (!orderId || !product) {
        skipped++;
        continue;
      }
      const exists = await tx.workOrderProduct.findUnique({
        where: { id: source.id },
      });
      if (exists) skipped++;
      else {
        await tx.workOrderProduct.create({
          data: {
            id: source.id,
            orderId,
            productId: source.productId,
            productName: source.productName,
            category: source.category,
            kind: source.kind,
            contextKey: source.contextKey ?? "ORIGINAL",
            unitPrice: source.unitPrice,
            discount: source.discount,
            quantity: source.quantity,
            consumedAt: date(source.consumedAt),
            createdAt: date(source.createdAt) ?? new Date(),
          },
        });
        imported++;
      }
    }
    for (const source of backup.data.payments) {
      if (source.orderId && existingOrderIds.has(source.orderId)) {
        skipped++;
        continue;
      }
      const orderId = source.orderId ? orderIds.get(source.orderId) : null;
      const saleId = source.saleId ? saleIds.get(source.saleId) : null;
      if ((!orderId && !saleId) || (orderId && saleId)) {
        skipped++;
        continue;
      }
      const exists =
        (await tx.payment.findUnique({ where: { id: source.id } })) ??
        (await tx.payment.findUnique({
          where: { requestId: source.requestId },
        }));
      if (exists) {
        skipped++;
        paymentIds.set(source.id, exists.id);
      } else {
        const created = await tx.payment.create({
          data: {
            id: source.id,
            requestId: source.requestId,
            orderId,
            saleId,
            reworkSessionId: source.reworkSessionId
              ? (reworkSessionIds.get(source.reworkSessionId) ?? null)
              : null,
            amount: source.amount,
            method: source.method,
            kind: source.kind,
            receivedAt: date(source.receivedAt) ?? new Date(),
            actorId: actor.id,
            actorName: source.actorName,
          },
        });
        paymentIds.set(source.id, created.id);
        imported++;
      }
    }
    for (const source of backup.data.paymentAllocations) {
      const paymentId = paymentIds.get(source.paymentId);
      if (!paymentId) {
        skipped++;
        continue;
      }
      const exists = await tx.paymentAllocation.findUnique({
        where: {
          paymentId_source: { paymentId, source: source.source },
        },
      });
      if (exists) skipped++;
      else {
        await tx.paymentAllocation.create({
          data: {
            id: source.id,
            paymentId,
            source: source.source,
            amount: source.amount,
          },
        });
        imported++;
      }
    }
    if (backup.version < 3) {
      for (const source of backup.data.payments) {
        if (!source.orderId) continue;
        const paymentId = paymentIds.get(source.id);
        if (!paymentId) continue;
        await tx.paymentAllocation.upsert({
          where: {
            paymentId_source: { paymentId, source: "REPAIR" },
          },
          create: {
            paymentId,
            source: "REPAIR",
            amount: source.amount,
          },
          update: {},
        });
      }
    }
    for (const source of backup.data.histories) {
      if (existingOrderIds.has(source.orderId)) {
        skipped++;
        continue;
      }
      const orderId = orderIds.get(source.orderId);
      if (!orderId) {
        skipped++;
        continue;
      }
      const exists = await tx.statusHistory.findUnique({
        where: { id: source.id },
      });
      if (exists) skipped++;
      else {
        await tx.statusHistory.create({
          data: {
            id: source.id,
            orderId,
            from: source.from,
            to: source.to,
            actorId: actor.id,
            actorName: source.actorName,
            note: source.note,
            createdAt: date(source.createdAt) ?? new Date(),
          },
        });
        imported++;
      }
    }
    for (const source of backup.data.faults) {
      const exists =
        (await tx.faultOption.findUnique({ where: { id: source.id } })) ??
        (await tx.faultOption.findUnique({
          where: {
            category_key: { category: source.category, key: source.key },
          },
        }));
      if (exists) skipped++;
      else {
        await tx.faultOption.create({ data: source });
        imported++;
      }
      faultIds.set(source.id, exists?.id ?? source.id);
    }
    for (const source of backup.data.workOrderFaults) {
      if (existingOrderIds.has(source.orderId)) {
        skipped++;
        continue;
      }
      const orderId = orderIds.get(source.orderId);
      if (!orderId) {
        skipped++;
        continue;
      }
      const exists = await tx.workOrderFault.findUnique({
        where: { id: source.id },
      });
      if (exists) skipped++;
      else {
        await tx.workOrderFault.create({
          data: {
            ...source,
            orderId,
            catalogId: source.catalogId
              ? (faultIds.get(source.catalogId) ?? null)
              : null,
          },
        });
        imported++;
      }
    }
    for (const source of backup.data.audits) {
      if (existingOrderIds.has(source.entityId)) {
        skipped++;
        continue;
      }
      if (
        orderSourceIds.has(source.entityId) &&
        !entityIds.has(source.entityId)
      ) {
        skipped++;
        continue;
      }
      const exists = await tx.auditLog.findUnique({ where: { id: source.id } });
      if (exists) skipped++;
      else {
        await tx.auditLog.create({
          data: {
            id: source.id,
            entityId: entityIds.get(source.entityId) ?? source.entityId,
            action: source.action,
            actorId: actor.id,
            actorName: source.actorName,
            context: source.context as Prisma.InputJsonValue,
            createdAt: date(source.createdAt) ?? new Date(),
          },
        });
        imported++;
      }
    }
    for (const source of backup.data.inventoryMovements) {
      const product = await tx.product.findUnique({
        where: { id: source.productId },
      });
      if (!product) {
        skipped++;
        continue;
      }
      const exists =
        (await tx.inventoryMovement.findUnique({ where: { id: source.id } })) ??
        (await tx.inventoryMovement.findUnique({
          where: { requestId: source.requestId },
        }));
      if (exists) skipped++;
      else {
        await tx.inventoryMovement.create({
          data: {
            id: source.id,
            requestId: source.requestId,
            productId: source.productId,
            quantity: source.quantity,
            stockBefore: source.stockBefore,
            stockAfter: source.stockAfter,
            type: source.type,
            referenceType: source.referenceType,
            referenceId: source.referenceId,
            note: source.note,
            actorId: actor.id,
            actorName: source.actorName,
            createdAt: date(source.createdAt) ?? new Date(),
          },
        });
        imported++;
      }
    }
    for (const source of backup.data.deviceCatalogDeletions) {
      const exists = await tx.deviceCatalogDeletion.findUnique({
        where: {
          category_kind_brand_value: {
            category: source.category,
            kind: source.kind,
            brand: source.brand,
            value: source.value,
          },
        },
      });
      if (exists) skipped++;
      else {
        await tx.deviceCatalogDeletion.create({
          data: {
            id: source.id,
            category: source.category,
            kind: source.kind,
            brand: source.brand,
            value: source.value,
            createdAt: date(source.createdAt) ?? new Date(),
          },
        });
        imported++;
      }
    }
    await tx.$executeRawUnsafe(
      "SELECT setval(" +
        "pg_get_serial_sequence('\"WorkOrder\"', 'number'), " +
        'GREATEST((SELECT COALESCE(MAX("number"), 0) FROM "WorkOrder"), 1), ' +
        '(SELECT COUNT(*) > 0 FROM "WorkOrder"))',
    );
    await tx.$executeRawUnsafe(
      "SELECT setval(" +
        "pg_get_serial_sequence('\"RetailSale\"', 'number'), " +
        'GREATEST((SELECT COALESCE(MAX("number"), 0) FROM "RetailSale"), 1), ' +
        '(SELECT COUNT(*) > 0 FROM "RetailSale"))',
    );
  });
  return { imported, skipped };
}
