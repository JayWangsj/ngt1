"use server";
import { requireActor } from "@/lib/session";
import * as service from "@/lib/service";
import {
  balance,
  BusinessError,
  cents,
  dateTime,
  romeDay,
  settlement,
  type StatusMutationSnapshot,
} from "@/lib/domain";
import type {
  Payment,
  WorkOrder,
  WorkOrderItem,
  WorkOrderProduct,
} from "@prisma/client";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { phoneInput } from "@/lib/validation";
import { clearBusinessData } from "@/lib/data-transfer";
import { generateTestData } from "@/lib/test-tools";
import { assertStudioWritesAvailable } from "@/lib/studio-maintenance";
type Result<Data = undefined> =
  { ok: true; id?: string; data?: Data } | { ok: false; error: string };
async function execute<Work extends { id?: string } | void, Data = undefined>(
  work: () => Promise<Work>,
  select?: (result: Work) => Data,
  revalidatePaths: string[] | false = ["/"],
): Promise<Result<Data>> {
  try {
    await assertStudioWritesAvailable();
    const result = await work();
    if (revalidatePaths)
      for (const path of revalidatePaths) revalidatePath(path);
    return {
      ok: true,
      id: result?.id,
      ...(select ? { data: select(result) } : {}),
    };
  } catch (error) {
    if (error instanceof BusinessError)
      return { ok: false, error: error.message };
    if (
      error instanceof ZodError &&
      error.issues.some(
        (issue) =>
          issue.path[0] === "phone" ||
          issue.path[0] === "additionalPhones" ||
          issue.message.includes("telefono"),
      )
    )
      return {
        ok: false,
        error:
          error.issues.find(
            (issue) =>
              issue.path[0] === "phone" ||
              issue.path[0] === "additionalPhones" ||
              issue.message.includes("telefono"),
          )?.message ?? "Telefono non valido.",
      };
    if (error instanceof ZodError)
      return {
        ok: false,
        error: "Controlla i campi obbligatori e gli importi.",
      };
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      return {
        ok: false,
        error: "Record già presente. Controlla i dati e riprova.",
      };
    // Redirect errors must propagate; infrastructure errors are deliberately not logged with PII.
    if (error instanceof Error && "digest" in error) throw error;
    return {
      ok: false,
      error: "Operazione non riuscita. Aggiorna la pagina e riprova.",
    };
  }
}
function orderPaths(id?: string) {
  return ["/", "/orders", ...(id ? [`/orders/${id}`] : [])];
}
const inventoryPaths = ["/", "/inventory", "/retail", "/orders"];
const pricePaths = ["/", "/quotes", "/orders", "/orders/new"];
const customerPaths = ["/", "/customers", "/orders", "/orders/new"];
type StatusOrderRecord = WorkOrder & {
  items: WorkOrderItem[];
  products: WorkOrderProduct[];
  payments: Payment[];
};
function statusMutationSnapshot(
  order: StatusOrderRecord,
): StatusMutationSnapshot {
  const closed = ["REFUNDED", "CANCELLED"].includes(order.status);
  const due = closed ? 0 : settlement(order.items, order).due;
  const remaining = balance(order.items, order.payments, order);
  const paid =
    order.status === "CANCELLED"
      ? order.payments.reduce((sum, payment) => sum + cents(payment.amount), 0)
      : order.status === "REFUNDED"
        ? 0
        : due - remaining;
  return {
    status: order.status,
    due,
    paid,
    balance: remaining,
    pickedUpAt: order.pickedUpAt?.toISOString() ?? null,
  };
}
export async function createOrderAction(input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.createOrder(actor, input),
    undefined,
    orderPaths(),
  );
}
export async function createQuickServiceOrderAction(input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.createQuickServiceOrder(actor, input),
    undefined,
    orderPaths(),
  );
}
export async function updateBusinessClockAction(input: unknown) {
  const actor = await requireActor();
  return execute(() => service.updateBusinessClock(actor, input), undefined, [
    "/",
    "/orders",
  ]);
}
export async function updateOrderAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.updateOrder(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function updateDueDateAction(id: string, dueDate: string) {
  const actor = await requireActor();
  return execute(
    () => service.updateDueDate(actor, id, dueDate),
    undefined,
    orderPaths(id),
  );
}
export async function updateQuickServiceOrderAction(
  id: string,
  input: unknown,
) {
  const actor = await requireActor();
  return execute(
    () => service.updateQuickServiceOrder(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function quoteAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.replaceQuote(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function completeInspectionAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.completeInspection(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function paymentAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.addPayment(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function setPaidTotalAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.setPaidTotal(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function createProductAction(input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.createProduct(actor, input),
    undefined,
    inventoryPaths,
  );
}
export async function adjustInventoryAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.adjustInventory(actor, id, input),
    undefined,
    inventoryPaths,
  );
}
export async function updateProductAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.updateProduct(actor, id, input),
    undefined,
    inventoryPaths,
  );
}
export async function deleteProductsAction(ids: string[]) {
  const actor = await requireActor();
  return execute(
    () => service.deleteProducts(actor, ids),
    undefined,
    inventoryPaths,
  );
}
export async function saveInventoryCategoryAction(input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.saveInventoryCategory(actor, input),
    undefined,
    inventoryPaths,
  );
}
export async function deleteInventoryCategoryAction(id: string) {
  const actor = await requireActor();
  return execute(
    () => service.deleteInventoryCategory(actor, id),
    undefined,
    inventoryPaths,
  );
}

export async function deleteDeviceCatalogOptionAction(input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.deleteDeviceCatalogOption(actor, input),
    undefined,
    customerPaths,
  );
}
export async function createRetailSaleAction(input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.createRetailSale(actor, input),
    (sale) => ({
      id: sale.id,
      code: sale.code,
      date: dateTime(sale.createdAt),
      period: romeDay(sale.createdAt).slice(0, 7),
      itemCount: sale.itemCount,
      method: sale.payments[0]?.method ?? null,
      subtotal: cents(sale.subtotal),
      discount: cents(sale.discount),
      total: cents(sale.total),
      items: sale.items.map((item) => ({
        id: item.id,
        name: item.productName,
        category: item.category,
        unitPrice: cents(item.unitPrice),
        quantity: item.quantity,
        subtotal: cents(item.subtotal),
      })),
      services: sale.serviceItems.map((item) => ({
        id: item.id,
        name: item.serviceName,
        unitPrice: cents(item.unitPrice),
        quantity: item.quantity,
        subtotal: cents(item.subtotal),
      })),
    }),
    ["/", "/retail", "/retail/sales", "/inventory"],
  );
}
export async function deleteRetailSaleAction(id: string) {
  const actor = await requireActor();
  return execute(() => service.deleteRetailSale(actor, id), undefined, [
    "/",
    "/retail",
    "/retail/sales",
    `/retail/sales/${id}`,
    "/inventory",
  ]);
}
export async function saveQuickServiceAction(
  id: string | null,
  input: unknown,
) {
  const actor = await requireActor();
  return execute(() => service.saveQuickService(actor, id, input), undefined, [
    "/",
    "/retail",
    "/orders/new",
  ]);
}
export async function deleteQuickServiceAction(id: string) {
  const actor = await requireActor();
  return execute(() => service.deleteQuickService(actor, id), undefined, [
    "/",
    "/retail",
    "/orders/new",
  ]);
}
export async function renameDeviceModelAction(input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.renameDeviceModel(actor, input),
    undefined,
    customerPaths,
  );
}
export async function deleteWorkOrderAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.deleteWorkOrder(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function addWorkOrderProductAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.addWorkOrderProduct(actor, id, input),
    undefined,
    [...orderPaths(id), "/inventory"],
  );
}
export async function removeWorkOrderProductAction(id: string, lineId: string) {
  const actor = await requireActor();
  return execute(
    () => service.removeWorkOrderProduct(actor, id, lineId),
    undefined,
    [...orderPaths(id), "/inventory"],
  );
}
export async function checkoutWorkOrderAction(
  id: string,
  input: unknown,
  revalidate = true,
) {
  const actor = await requireActor();
  return execute(
    () => service.checkoutWorkOrder(actor, id, input),
    statusMutationSnapshot,
    revalidate ? [...orderPaths(id), "/inventory"] : false,
  );
}
export async function statusAction(
  id: string,
  input: unknown,
  revalidate = true,
) {
  const actor = await requireActor();
  return execute(
    () => service.changeStatus(actor, id, input),
    statusMutationSnapshot,
    revalidate ? [...orderPaths(id), "/inventory"] : false,
  );
}
export async function warrantyAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.updateWarranty(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function afterSalesAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.openAfterSales(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function updateReworkPartAction(
  id: string,
  itemId: string,
  input: unknown,
) {
  const actor = await requireActor();
  return execute(
    () => service.updateReworkPart(actor, id, itemId, input),
    undefined,
    orderPaths(id),
  );
}
export async function refundAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.refundOrder(actor, id, input),
    undefined,
    orderPaths(id),
  );
}
export async function ruleAction(id: string | null, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.savePriceRule(actor, id, input),
    undefined,
    pricePaths,
  );
}
export async function updatePriceRuleFieldsAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.updatePriceRuleFields(actor, id, input),
    undefined,
    pricePaths,
  );
}

export async function priceRuleOptionAction(
  ruleId: string,
  id: string | null,
  input: unknown,
) {
  const actor = await requireActor();
  return execute(
    () => service.savePriceRuleOption(actor, ruleId, id, input),
    undefined,
    pricePaths,
  );
}

export async function deletePriceRuleOptionAction(ruleId: string, id: string) {
  const actor = await requireActor();
  return execute(
    () => service.deletePriceRuleOption(actor, ruleId, id),
    undefined,
    pricePaths,
  );
}

export async function lookupCustomerAction(phone: string) {
  await requireActor();
  const parsed = phoneInput.safeParse(phone);
  if (!parsed.success) return null;
  return db.customer.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { phone: parsed.data },
        { phones: { some: { phone: parsed.data } } },
      ],
    },
    select: {
      id: true,
      name: true,
      phone: true,
      consentAt: true,
      phones: { select: { phone: true } },
      devices: {
        where: { deletedAt: null },
        select: {
          id: true,
          category: true,
          brand: true,
          series: true,
          model: true,
          imei: true,
          appearance: true,
          accessories: true,
        },
      },
    },
  });
}

export async function customerAction(id: string | null, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.saveCustomer(actor, id, input),
    undefined,
    customerPaths,
  );
}
export async function deleteCustomerAction(id: string) {
  const actor = await requireActor();
  return execute(
    () => service.deleteCustomer(actor, id),
    undefined,
    customerPaths,
  );
}
export async function deleteCustomersAction(ids: string[]) {
  const actor = await requireActor();
  return execute(
    () => service.deleteCustomers(actor, ids),
    undefined,
    customerPaths,
  );
}
export async function deviceAction(id: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.saveDevice(actor, id, input),
    undefined,
    customerPaths,
  );
}
export async function createDeviceAction(customerId: string, input: unknown) {
  const actor = await requireActor();
  return execute(
    () => service.createDevice(actor, customerId, input),
    undefined,
    customerPaths,
  );
}
export async function deleteDeviceAction(id: string) {
  const actor = await requireActor();
  return execute(
    () => service.deleteDevice(actor, id),
    undefined,
    customerPaths,
  );
}
export async function deleteRulesAction(ids: string[]) {
  const actor = await requireActor();
  return execute(
    () => service.deletePriceRules(actor, ids),
    undefined,
    pricePaths,
  );
}
export async function hideFaultAction(category: string, name: string) {
  const actor = await requireActor();
  return execute(() => service.hideFault(actor, category, name), undefined, [
    "/",
    "/settings",
    "/orders/new",
    "/orders",
  ]);
}
export async function saveFaultAction(id: string | null, input: unknown) {
  const actor = await requireActor();
  return execute(() => service.saveFault(actor, id, input), undefined, [
    "/",
    "/settings",
    "/orders/new",
    "/orders",
  ]);
}
export async function deleteFaultAction(id: string) {
  const actor = await requireActor();
  return execute(() => service.deleteFault(actor, id), undefined, [
    "/",
    "/settings",
    "/orders/new",
    "/orders",
  ]);
}
export async function reorderFaultsAction(category: string, ids: string[]) {
  const actor = await requireActor();
  return execute(() => service.reorderFaults(actor, category, ids), undefined, [
    "/",
    "/settings",
    "/orders/new",
    "/orders",
  ]);
}
export async function restoreFaultAction(category: string, name: string) {
  const actor = await requireActor();
  return execute(() => service.restoreFault(actor, category, name), undefined, [
    "/",
    "/settings",
    "/orders/new",
    "/orders",
  ]);
}
export async function clearDataAction() {
  const actor = await requireActor();
  return execute(() => clearBusinessData(actor), undefined, [
    "/",
    "/orders",
    "/customers",
    "/inventory",
    "/retail",
    "/quotes",
  ]);
}

export async function generateTestDataAction(count: 10 | 50 | 100) {
  const actor = await requireActor();
  if (![10, 50, 100].includes(count))
    return { ok: false as const, error: "Quantità di test non valida." };
  return execute(
    () => generateTestData(actor, count),
    ({
      customers,
      products,
      priceRules,
      orders,
      quickServices,
      retailSales,
    }) => ({
      customers,
      products,
      priceRules,
      orders,
      quickServices,
      retailSales,
    }),
    ["/", "/orders", "/customers", "/inventory", "/retail", "/quotes"],
  );
}
