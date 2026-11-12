import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type User } from "@prisma/client";
import { getBusinessDay } from "@/lib/business-date";
import { BusinessError } from "@/lib/domain";
import { db } from "@/lib/db";
import { isTestToolsEnabled } from "@/lib/test-tools-guard";

const devices = [
  { brand: "Apple", model: "iPhone 15 Pro Max", prices: [349, 129, 159, 219] },
  { brand: "Samsung", model: "Galaxy S24 Ultra", prices: [329, 119, 149, 249] },
  { brand: "Xiaomi", model: "Redmi Note 13 Pro+", prices: [149, 79, 99, 139] },
  { brand: "Google", model: "Pixel 9 Pro XL", prices: [299, 119, 159, 229] },
  { brand: "OnePlus", model: "Nord 4 5G", prices: [179, 89, 119, 159] },
];

const projects = [
  { name: "sostituzione display", minutes: 90, product: "Display" },
  { name: "sostituzione batteria", minutes: 60, product: "Batteria" },
  {
    name: "riparazione connettore di ricarica",
    minutes: 90,
    product: "Connettore",
  },
  {
    name: "sostituzione fotocamera posteriore",
    minutes: 75,
    product: "Fotocamera",
  },
];

const productCatalog = [
  {
    name: "Display OLED compatibile iPhone 15 Pro Max",
    category: "Display e touchscreen",
    usage: "REPAIR",
    costPrice: "148.00",
    salePrice: "249.00",
    stockQuantity: 7,
    minStock: 2,
  },
  {
    name: "Cover silicone MagSafe iPhone 15 Pro Max",
    category: "Cover",
    usage: "RETAIL",
    costPrice: "7.50",
    salePrice: "19.90",
    stockQuantity: 18,
    minStock: 4,
  },
  {
    name: "Batteria iPhone 15 Pro Max 4422 mAh",
    category: "Batterie",
    usage: "REPAIR",
    costPrice: "42.00",
    salePrice: "89.00",
    stockQuantity: 9,
    minStock: 3,
  },
  {
    name: "Cavo USB-C 60 W 1 m",
    category: "Cavi e alimentazione",
    usage: "RETAIL",
    costPrice: "4.80",
    salePrice: "12.90",
    stockQuantity: 26,
    minStock: 6,
  },
  {
    name: "Display Dynamic AMOLED Galaxy S24 Ultra",
    category: "Display e touchscreen",
    usage: "REPAIR",
    costPrice: "185.00",
    salePrice: "299.00",
    stockQuantity: 5,
    minStock: 2,
  },
  {
    name: "Alimentatore USB-C PD 30 W",
    category: "Cavi e alimentazione",
    usage: "RETAIL",
    costPrice: "11.50",
    salePrice: "24.90",
    stockQuantity: 15,
    minStock: 4,
  },
  {
    name: "Connettore USB-C Pixel 9 Pro XL",
    category: "Connettori e ricarica",
    usage: "REPAIR",
    costPrice: "29.00",
    salePrice: "69.00",
    stockQuantity: 8,
    minStock: 2,
  },
  {
    name: "Pellicola vetro temperato universale",
    category: "Protezione schermo",
    usage: "RETAIL",
    costPrice: "1.80",
    salePrice: "9.90",
    stockQuantity: 40,
    minStock: 10,
  },
  {
    name: "Fotocamera posteriore OnePlus Nord 4",
    category: "Fotocamere",
    usage: "REPAIR",
    costPrice: "48.00",
    salePrice: "99.00",
    stockQuantity: 6,
    minStock: 2,
  },
  {
    name: "Cuffie USB-C con microfono",
    category: "Audio",
    usage: "RETAIL",
    costPrice: "6.80",
    salePrice: "19.90",
    stockQuantity: 20,
    minStock: 5,
  },
  {
    name: "Display AMOLED Redmi Note 13 Pro+",
    category: "Display e touchscreen",
    usage: "REPAIR",
    costPrice: "62.00",
    salePrice: "129.00",
    stockQuantity: 10,
    minStock: 3,
  },
  {
    name: "Cover trasparente Galaxy S24 Ultra",
    category: "Cover",
    usage: "RETAIL",
    costPrice: "5.20",
    salePrice: "14.90",
    stockQuantity: 22,
    minStock: 5,
  },
  {
    name: "Batteria Galaxy S24 Ultra 5000 mAh",
    category: "Batterie",
    usage: "REPAIR",
    costPrice: "38.00",
    salePrice: "79.00",
    stockQuantity: 11,
    minStock: 3,
  },
  {
    name: "Pellicola privacy iPhone 15 Pro Max",
    category: "Protezione schermo",
    usage: "RETAIL",
    costPrice: "3.50",
    salePrice: "14.90",
    stockQuantity: 24,
    minStock: 6,
  },
  {
    name: "Altoparlante auricolare iPhone 15 Pro Max",
    category: "Audio",
    usage: "REPAIR",
    costPrice: "18.00",
    salePrice: "49.00",
    stockQuantity: 7,
    minStock: 2,
  },
  {
    name: "Supporto auto magnetico",
    category: "Accessori",
    usage: "RETAIL",
    costPrice: "5.50",
    salePrice: "16.90",
    stockQuantity: 16,
    minStock: 4,
  },
  {
    name: "Vetro fotocamera Galaxy S24 Ultra",
    category: "Fotocamere",
    usage: "REPAIR",
    costPrice: "12.00",
    salePrice: "35.00",
    stockQuantity: 13,
    minStock: 3,
  },
  {
    name: "Power bank 10000 mAh 20 W",
    category: "Cavi e alimentazione",
    usage: "RETAIL",
    costPrice: "14.50",
    salePrice: "34.90",
    stockQuantity: 12,
    minStock: 3,
  },
  {
    name: "Flat accensione Redmi Note 13 Pro+",
    category: "Componenti interni",
    usage: "REPAIR",
    costPrice: "9.50",
    salePrice: "29.00",
    stockQuantity: 9,
    minStock: 2,
  },
  {
    name: "Adattatore USB-C a jack 3,5 mm",
    category: "Audio",
    usage: "RETAIL",
    costPrice: "3.20",
    salePrice: "11.90",
    stockQuantity: 25,
    minStock: 6,
  },
] as const;

function productDevice(name: string) {
  return devices.find((device) => name.includes(device.model));
}

function productProject(name: string) {
  const normalized = name.toLocaleLowerCase("it-IT");
  if (normalized.includes("display")) return projects[0];
  if (normalized.includes("batteria")) return projects[1];
  if (normalized.includes("connettore")) return projects[2];
  if (normalized.includes("fotocamera")) return projects[3];
  return null;
}

const firstNames = [
  "Alessandro",
  "Andrea",
  "Chiara",
  "Davide",
  "Elena",
  "Federico",
  "Francesca",
  "Giulia",
  "Lorenzo",
  "Luca",
  "Marco",
  "Martina",
  "Matteo",
  "Michela",
  "Paolo",
  "Sara",
  "Simone",
  "Sofia",
  "Stefano",
  "Valentina",
];
const lastNames = [
  "Bianchi",
  "Colombo",
  "Conti",
  "Costa",
  "De Angelis",
  "De Santis",
  "Esposito",
  "Ferrari",
  "Fontana",
  "Gallo",
  "Giordano",
  "Greco",
  "Lombardi",
  "Mancini",
  "Marino",
  "Moretti",
  "Ricci",
  "Rinaldi",
  "Romano",
  "Russo",
];

function offsetDay(day: string, offset: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export async function generateTestData(
  actor: Pick<User, "id" | "name">,
  count: 10 | 50 | 100,
) {
  if (!isTestToolsEnabled())
    throw new BusinessError("Gli strumenti di test non sono disponibili.");

  const token = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const prefix = `TEST-${token}`;
  const now = Date.now();
  const statuses = [
    "DIAGNOSING",
    "REPAIRING",
    "PARTS_MISSING",
    "PARTS_PENDING_CONFIRMATION",
    "READY",
    "COMPLETED",
    "REWORKING",
    "REFUNDED",
    "CANCELLED",
  ] as const;
  const productCount = Math.min(20, Math.max(6, Math.ceil(count / 5)));

  await db.$transaction(async (tx) => {
    const businessDay = await getBusinessDay(tx);
    const selectedCatalog = productCatalog.slice(0, productCount);
    for (const category of new Set(
      selectedCatalog.map((item) => item.category),
    )) {
      const repairOnly = selectedCatalog
        .filter((item) => item.category === category)
        .every((item) => item.usage === "REPAIR");
      await tx.inventoryCategory.upsert({
        where: { name: category },
        create: { name: category, repairOnly },
        update: { repairOnly },
      });
    }

    const products: Prisma.ProductCreateManyInput[] = selectedCatalog.map(
      (product, index) => ({
        id: `${prefix}-product-${index}`,
        ...product,
        favorite: index < 6,
      }),
    );
    await tx.product.createMany({ data: products });
    await tx.inventoryMovement.createMany({
      data: products.map((product) => ({
        requestId: randomUUID(),
        productId: product.id!,
        quantity: product.stockQuantity ?? 0,
        stockBefore: 0,
        stockAfter: product.stockQuantity ?? 0,
        type: "INITIAL_STOCK",
        referenceType: "PRODUCT",
        referenceId: product.id!,
        note: "Carico iniziale dati demo",
        actorId: actor.id,
        actorName: actor.name,
      })),
    });

    await tx.productCompatibility.createMany({
      data: products.flatMap((product) => {
        const device = productDevice(String(product.name));
        if (!device) return [];
        return [
          {
            productId: product.id!,
            category: "PHONE",
            brand: device.brand,
            model: device.model,
            project:
              product.usage === "REPAIR"
                ? (productProject(String(product.name))?.name ?? "")
                : "",
          },
        ];
      }),
    });

    const quickServices = [
      {
        id: `${prefix}-quick-service-0`,
        name: `Migrazione dati assistita ${token}`,
        defaultPrice: "29.90",
        notes: "Servizio demo per due dispositivi",
        enabled: true,
      },
      {
        id: `${prefix}-quick-service-1`,
        name: `Configurazione smartphone ${token}`,
        defaultPrice: "19.90",
        notes: "Configurazione iniziale e account",
        enabled: true,
      },
      {
        id: `${prefix}-quick-service-2`,
        name: `Applicazione pellicola ${token}`,
        defaultPrice: "10.00",
        notes: "Servizio rapido al banco",
        enabled: true,
      },
      {
        id: `${prefix}-quick-service-3`,
        name: `Servizio sospeso ${token}`,
        defaultPrice: "15.00",
        notes: "Voce demo disattivata",
        enabled: false,
      },
    ];
    await tx.quickService.createMany({ data: quickServices });

    const repairProducts = products.filter(
      (product) => product.usage === "REPAIR",
    );
    const rules = new Map<
      string,
      { id: string; suggested: string; requiredProductId: string | null }
    >();
    for (const [deviceIndex, device] of devices.entries()) {
      for (const [projectIndex, project] of projects.entries()) {
        const requiredProduct = repairProducts.find(
          (product) =>
            productDevice(String(product.name))?.model === device.model &&
            productProject(String(product.name))?.name === project.name,
        );
        const suggested = String(device.prices[projectIndex]);
        const rule = await tx.priceRule.upsert({
          where: {
            category_brand_series_model_project: {
              category: "PHONE",
              brand: device.brand,
              series: "",
              model: device.model,
              project: project.name,
            },
          },
          create: {
            id: `${prefix}-rule-${deviceIndex}-${projectIndex}`,
            category: "PHONE",
            brand: device.brand,
            model: device.model,
            project: project.name,
            suggested,
            cost: String(Math.round(device.prices[projectIndex] * 0.45)),
            minutes: project.minutes,
            notes: `Dati demo ${prefix}`,
            requiredProductId: requiredProduct?.id ?? null,
          },
          update: {
            suggested,
            cost: String(Math.round(device.prices[projectIndex] * 0.45)),
            minutes: project.minutes,
            enabled: true,
            notes: `Dati demo ${prefix}`,
            requiredProductId: requiredProduct?.id ?? null,
          },
        });
        rules.set(`${device.model}|${project.name}`, {
          id: rule.id,
          suggested,
          requiredProductId: requiredProduct?.id ?? null,
        });
      }
    }

    const repairCodePrefix = `R-${businessDay.replaceAll("-", "")}`;
    const serviceCodePrefix = `S-${businessDay.replaceAll("-", "")}`;
    const [latestRepairOrder, latestServiceOrder] = await Promise.all([
      tx.workOrder.findFirst({
        where: { code: { startsWith: repairCodePrefix } },
        orderBy: { code: "desc" },
        select: { code: true },
      }),
      tx.workOrder.findFirst({
        where: { code: { startsWith: serviceCodePrefix } },
        orderBy: { code: "desc" },
        select: { code: true },
      }),
    ]);
    const firstRepairSequence = latestRepairOrder
      ? Number(latestRepairOrder.code.slice(-3)) + 1
      : 1;
    const firstServiceSequence = latestServiceOrder
      ? Number(latestServiceOrder.code.slice(-3)) + 1
      : 1;
    if (Math.max(firstRepairSequence, firstServiceSequence) + count - 1 > 999)
      throw new BusinessError("Limite giornaliero raggiunto.");

    const customers: Prisma.CustomerCreateManyInput[] = [];
    const customerPhones: Prisma.CustomerPhoneCreateManyInput[] = [];
    const generatedDevices: Prisma.DeviceCreateManyInput[] = [];
    const orders: Prisma.WorkOrderCreateManyInput[] = [];
    const items: Prisma.WorkOrderItemCreateManyInput[] = [];
    const history: Prisma.StatusHistoryCreateManyInput[] = [];
    const relatedDevices: Prisma.WorkOrderDeviceCreateManyInput[] = [];
    const faults: Prisma.WorkOrderFaultCreateManyInput[] = [];
    const extraDevices: Prisma.DeviceCreateManyInput[] = [];
    let repairSequence = firstRepairSequence;
    let serviceSequence = firstServiceSequence;
    for (let index = 0; index < count; index += 1) {
      const customerId = `${prefix}-customer-${index}`;
      const deviceId = `${prefix}-device-${index}`;
      const orderId = `${prefix}-order-${index}`;
      const quick = index % 5 === 4;
      const quickStatuses = [
        "RECEIVED",
        "REPAIRING",
        "READY",
        "COMPLETED",
        "CANCELLED",
      ] as const;
      const status = quick
        ? quickStatuses[Math.floor(index / 5) % quickStatuses.length]
        : statuses[index % statuses.length];
      const diagnostic = !quick && status === "DIAGNOSING";
      const createdAt = new Date(now - index * 60_000);
      const dueOffset = index % 4 === 0 ? -3 : (index % 8) + 1;
      const customerName = `${firstNames[index % firstNames.length]} ${lastNames[(index * 7) % lastNames.length]}`;
      const phone = `+393${String(20 + (index % 70)).padStart(2, "0")}${String(now % 10_000).padStart(4, "0")}${String(index).padStart(3, "0")}`;
      const device = devices[index % devices.length];
      const project = projects[index % projects.length];
      const rule = rules.get(`${device.model}|${project.name}`)!;
      const quickService = quickServices[index % 3];
      const code = quick
        ? `${serviceCodePrefix}${String(serviceSequence++).padStart(3, "0")}`
        : `${repairCodePrefix}${String(repairSequence++).padStart(3, "0")}`;
      customers.push({
        id: customerId,
        name: customerName,
        phone,
        consentAt: createdAt,
        consentVersion: `DEMO-${token}`,
        createdAt,
      });
      customerPhones.push({ phone, customerId });
      generatedDevices.push({
        id: deviceId,
        customerId,
        category: "PHONE",
        brand: device.brand,
        model: device.model,
        appearance:
          index % 3 === 0
            ? "Lievi segni d'uso sulla cornice"
            : "Buone condizioni generali",
        accessories: index % 4 === 0 ? "Custodia protettiva" : "",
      });
      relatedDevices.push({ orderId, deviceId });
      if (quick) {
        const extraDeviceId = `${prefix}-device-${index}-secondary`;
        extraDevices.push({
          id: extraDeviceId,
          customerId,
          category: "PHONE",
          brand: index % 2 ? "Samsung" : "Apple",
          model: index % 2 ? "Galaxy S24 Ultra" : "iPhone 15 Pro Max",
          appearance: "Dispositivo secondario per servizio rapido",
        });
        relatedDevices.push({ orderId, deviceId: extraDeviceId });
      }
      orders.push({
        id: orderId,
        code,
        type: quick ? "QUICK_SERVICE" : "REPAIR",
        customerName,
        deviceId,
        status,
        inspectionMode: diagnostic,
        inspectionFee: diagnostic ? "30" : "0",
        fault: quick
          ? quickService.name
          : diagnostic
            ? "Da diagnosticare"
            : index % 2
              ? "Display rotto"
              : "Problema di ricarica",
        notes: `Dati demo ${prefix}`,
        dueDate: offsetDay(businessDay, dueOffset),
        expectedAt: quick ? `${offsetDay(businessDay, dueOffset)}T18:00` : null,
        afterSalesOpen: !quick && status === "REWORKING",
        createdAt,
        updatedAt: createdAt,
      });
      if (!diagnostic)
        items.push({
          id: `${prefix}-item-${index}`,
          orderId,
          ruleId: quick ? null : rule.id,
          quickServiceId: quick ? quickService.id : null,
          project: quick ? quickService.name : project.name,
          suggested: quick ? quickService.defaultPrice : rule.suggested,
          final: quick ? quickService.defaultPrice : rule.suggested,
          matchLevel: quick ? "SERVICE" : "MODEL",
          minutes: quick ? 0 : project.minutes,
          requiredProductId: quick ? null : rule.requiredProductId,
        });
      if (!quick && !diagnostic)
        faults.push({
          id: `${prefix}-fault-${index}`,
          orderId,
          nameSnapshot: index % 2 ? "Display rotto" : "Problema di ricarica",
          custom: false,
        });
      history.push({
        id: `${prefix}-history-${index}`,
        orderId,
        to: status,
        actorId: actor.id,
        actorName: actor.name,
        note: "Stato iniziale dati demo",
        createdAt,
      });
    }
    await tx.customer.createMany({ data: customers });
    await tx.customerPhone.createMany({ data: customerPhones });
    await tx.device.createMany({
      data: [...generatedDevices, ...extraDevices],
    });
    await tx.workOrder.createMany({ data: orders });
    await tx.workOrderItem.createMany({ data: items });
    await tx.workOrderDevice.createMany({ data: relatedDevices });
    await tx.workOrderFault.createMany({ data: faults });
    await tx.statusHistory.createMany({ data: history });

    const reworkOrders = orders.filter(
      (order) => order.type === "REPAIR" && order.status === "REWORKING",
    );
    for (const [index, order] of reworkOrders.entries()) {
      const item = items.find((candidate) => candidate.orderId === order.id)!;
      const sessionId = `${prefix}-rework-${index}`;
      await tx.reworkSession.create({
        data: {
          id: sessionId,
          orderId: order.id!,
          dueDate: offsetDay(businessDay, 3),
          notes: `Dati demo ${prefix}`,
          items: {
            create: {
              originalItemId: item.id!,
              warrantyState: index % 2 ? "EXPIRED" : "VALID",
              treatment: index % 2 ? "PAID" : "WARRANTY",
              fee: index % 2 ? "35.00" : "0",
              requiredProductId: item.requiredProductId,
            },
          },
        },
      });
    }

    const retailProduct = products.find(
      (product) => product.usage === "RETAIL" && product.stockQuantity! > 0,
    )!;
    const retailService = quickServices[2];
    const retailSaleCount = Math.max(2, Math.ceil(count / 10));
    const saleCodePrefix = `V-${businessDay.replaceAll("-", "")}`;
    const latestSale = await tx.retailSale.findFirst({
      where: { code: { startsWith: saleCodePrefix } },
      orderBy: { code: "desc" },
      select: { code: true },
    });
    const firstSaleSequence = latestSale
      ? Number(latestSale.code.slice(-3)) + 1
      : 1;
    let stock = Number(retailProduct.stockQuantity);
    for (let index = 0; index < retailSaleCount; index += 1) {
      const sale = await tx.retailSale.create({
        data: {
          code: `${saleCodePrefix}${String(firstSaleSequence + index).padStart(3, "0")}`,
          requestId: randomUUID(),
          subtotal: "22.90",
          total: "22.90",
          itemCount: 2,
          actorId: actor.id,
          actorName: actor.name,
          items: {
            create: {
              productId: retailProduct.id!,
              productName: String(retailProduct.name),
              category: String(retailProduct.category),
              unitPrice: "12.90",
              quantity: 1,
              subtotal: "12.90",
            },
          },
          serviceItems: {
            create: {
              quickServiceId: retailService.id,
              serviceName: retailService.name,
              notes: retailService.notes,
              unitPrice: "10.00",
              quantity: 1,
              subtotal: "10.00",
            },
          },
        },
      });
      const payment = await tx.payment.create({
        data: {
          requestId: randomUUID(),
          saleId: sale.id,
          amount: "22.90",
          method: index % 2 ? "CARD" : "CASH",
          kind: "SALE",
          actorId: actor.id,
          actorName: actor.name,
        },
      });
      await tx.paymentAllocation.createMany({
        data: [
          { paymentId: payment.id, source: "RETAIL", amount: "12.90" },
          {
            paymentId: payment.id,
            source: "QUICK_SERVICE",
            amount: "10.00",
          },
        ],
      });
      await tx.inventoryMovement.create({
        data: {
          requestId: randomUUID(),
          productId: retailProduct.id!,
          quantity: -1,
          stockBefore: stock,
          stockAfter: stock - 1,
          type: "RETAIL_SALE",
          referenceType: "RETAIL_SALE",
          referenceId: sale.id,
          note: `Dati demo ${prefix}`,
          actorId: actor.id,
          actorName: actor.name,
        },
      });
      stock -= 1;
    }
    await tx.product.update({
      where: { id: retailProduct.id! },
      data: { stockQuantity: stock },
    });

    const paidOrders = orders.filter(
      (order) => order.status === "COMPLETED" || order.status === "READY",
    );
    for (const order of paidOrders) {
      const item = items.find((candidate) => candidate.orderId === order.id)!;
      const payment = await tx.payment.create({
        data: {
          requestId: randomUUID(),
          orderId: order.id!,
          amount: item.final,
          method: "CARD",
          kind: "BALANCE",
          actorId: actor.id,
          actorName: actor.name,
        },
      });
      await tx.paymentAllocation.create({
        data: {
          paymentId: payment.id,
          source: order.type === "QUICK_SERVICE" ? "QUICK_SERVICE" : "REPAIR",
          amount: item.final,
        },
      });
    }

    return { retailSaleCount };
  });

  return {
    id: prefix,
    customers: count,
    products: productCount,
    priceRules: devices.length * projects.length,
    orders: count,
    quickServices: 4,
    retailSales: Math.max(2, Math.ceil(count / 10)),
  };
}
