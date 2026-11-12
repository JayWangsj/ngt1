import { normalizeBrand, normalizeDeviceModel } from "./catalog";

export const statuses = [
  "RECEIVED",
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
export type OrderStatus = (typeof statuses)[number];
export function isActiveOrderStatus(status: string) {
  return !["COMPLETED", "REFUNDED", "CANCELLED"].includes(status);
}
export type StatusMutationSnapshot = {
  status: OrderStatus;
  due: number;
  paid: number;
  balance: number;
  pickedUpAt: string | null;
};
export type Actor = { id: string; name: string; role: "OWNER" | "STAFF" };
export class BusinessError extends Error {}
export function cents(value: string | { toString(): string }): number {
  const text = value.toString().trim().replace(",", ".");
  if (!/^-?\d{1,8}(\.\d{1,2})?$/.test(text))
    throw new BusinessError("Importo non valido (massimo 2 decimali).");
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const valueInCents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return negative ? -valueInCents : valueInCents;
}
export function decimal(value: number): string {
  if (!Number.isSafeInteger(value))
    throw new BusinessError("Importo non valido.");
  const absolute = Math.abs(value);
  return `${value < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
export function total(
  items: { final: string | { toString(): string } }[],
): number {
  return items.reduce((sum, item) => sum + cents(item.final), 0);
}
type Amount = string | { toString(): string };
export type QuoteItem = { final: Amount; discount?: Amount };
export type QuoteOptions = { orderDiscount?: Amount; includeVat?: boolean };
export type ProductCharge = {
  unitPrice: Amount;
  discount?: Amount;
  quantity: number;
};
export type WorkOrderOptions = QuoteOptions & {
  products?: ProductCharge[];
  afterSalesFee?: Amount;
  inspectionFee?: Amount;
  status?: OrderStatus;
};
export function settlement(items: QuoteItem[], options: WorkOrderOptions = {}) {
  const inspectionTotal = cents(options.inspectionFee ?? "0");
  if (inspectionTotal < 0)
    throw new BusinessError("Costo diagnosi non valido.");
  const repairGross = total(items);
  const gross = repairGross + inspectionTotal;
  const itemDiscount = items.reduce((sum, item) => {
    const discount = cents(item.discount ?? "0");
    if (discount < 0 || discount > cents(item.final))
      throw new BusinessError("Lo sconto supera il prezzo.");
    return sum + discount;
  }, 0);
  const discount = itemDiscount + cents(options.orderDiscount ?? "0");
  if (discount < 0 || discount > gross)
    throw new BusinessError("Lo sconto supera il prezzo.");
  const net = gross - discount;
  const vat = Math.round((net * 22) / 100);
  const products = options.products ?? [];
  const productTotal = products.reduce((sum, product) => {
    if (!Number.isSafeInteger(product.quantity) || product.quantity <= 0)
      throw new BusinessError("Quantità prodotto non valida.");
    const line = cents(product.unitPrice) * product.quantity;
    const lineDiscount = cents(product.discount ?? "0");
    if (lineDiscount < 0 || lineDiscount > line)
      throw new BusinessError("Lo sconto prodotto supera il prezzo.");
    return sum + line - lineDiscount;
  }, 0);
  const afterSalesTotal = cents(options.afterSalesFee ?? "0");
  if (afterSalesTotal < 0)
    throw new BusinessError("Costo post-vendita non valido.");
  return {
    inspectionTotal,
    repairGross,
    gross,
    discount,
    net,
    vat,
    withVat: net + vat,
    productTotal,
    afterSalesTotal,
    due: net + (options.includeVat ? vat : 0) + productTotal + afterSalesTotal,
  };
}

export function allocatePayment(
  amount: number,
  repairOutstanding: number,
  retailOutstanding: number,
) {
  const outstanding = repairOutstanding + retailOutstanding;
  if (amount < 0 || amount > outstanding || outstanding <= 0)
    throw new BusinessError("Ripartizione pagamento non valida.");
  if (amount === outstanding)
    return { repair: repairOutstanding, retail: retailOutstanding };
  const repair = Math.min(
    repairOutstanding,
    Math.round((amount * repairOutstanding) / outstanding),
  );
  return {
    repair,
    retail: Math.min(retailOutstanding, amount - repair),
  };
}
export function balance(
  items: QuoteItem[],
  payments: { amount: string | { toString(): string } }[],
  options: WorkOrderOptions = {},
) {
  if (options.status === "REFUNDED" || options.status === "CANCELLED") return 0;
  return (
    settlement(items, options).due -
    payments.reduce((sum, payment) => sum + cents(payment.amount), 0)
  );
}
export const transitions: Record<OrderStatus, OrderStatus[]> = {
  RECEIVED: ["DIAGNOSING", "REPAIRING", "CANCELLED"],
  DIAGNOSING: ["CANCELLED"],
  REPAIRING: ["READY", "CANCELLED"],
  PARTS_MISSING: ["CANCELLED"],
  PARTS_PENDING_CONFIRMATION: ["REPAIRING", "CANCELLED"],
  READY: ["REPAIRING", "COMPLETED"],
  COMPLETED: [],
  REWORKING: ["READY", "CANCELLED"],
  REFUNDED: [],
  CANCELLED: [],
};
export function allowedTransitions(
  from: OrderStatus,
  afterSalesOpen = false,
): OrderStatus[] {
  if (afterSalesOpen) {
    if (from === "READY") return ["REWORKING", "COMPLETED"];
    if (from === "PARTS_PENDING_CONFIRMATION") return ["REWORKING"];
    if (from === "REWORKING") return ["READY"];
    return [];
  }
  return transitions[from];
}
export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  afterSalesOpen = false,
) {
  if (!allowedTransitions(from, afterSalesOpen).includes(to))
    throw new BusinessError("Cambio di stato non consentito.");
}
export function assertOwner(actor: Actor) {
  if (actor.role !== "OWNER")
    throw new BusinessError("Operazione riservata al titolare.");
}
export function assertDelivery(remaining: number) {
  if (remaining !== 0)
    throw new BusinessError("Il saldo deve essere zero prima della consegna.");
}
export function warrantyPeriod(
  deliveredAt: Date | null,
  days: number,
  today = romeDay(),
) {
  if (!deliveredAt || days <= 0) return null;
  const start = romeDay(deliveredAt);
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  const end = date.toISOString().slice(0, 10);
  return { start, end, active: today <= end };
}
export function warrantyProgress(
  deliveredAt: Date | null,
  days: number,
  today = romeDay(),
) {
  const period = warrantyPeriod(deliveredAt, days, today);
  if (!period) return null;
  const day = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86_400_000;
  const start = day(period.start);
  const end = day(period.end);
  const current = day(today);
  const totalDays = Math.max(0, end - start);
  const elapsedDays = current - start;
  const progress =
    totalDays > 0
      ? Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)))
      : current >= end
        ? 100
        : 0;
  const remainingPercent = 100 - progress;
  const remainingDays = Math.max(0, Math.ceil(end - current));
  return {
    ...period,
    progress,
    remainingPercent,
    remainingDays,
    elapsedDays: Math.min(totalDays, Math.max(0, Math.floor(elapsedDays))),
    totalDays,
    state: !period.active
      ? ("EXPIRED" as const)
      : remainingPercent <= 20
        ? ("EXPIRING" as const)
        : ("ACTIVE" as const),
  };
}
export function normalizePhone(phone: string) {
  const clean = phone.replace(/[\s().-]/g, "").replace(/^00/, "+");
  if (!/^\+?\d{6,15}$/.test(clean))
    throw new BusinessError("Numero di telefono non valido.");
  return clean.startsWith("+") ? clean : `+39${clean}`;
}
export type MatchableRule = {
  id: string;
  category: string;
  brand: string;
  series: string;
  model: string;
  project: string;
  enabled: boolean;
};
export const normalizeRepairProject = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase("it");
const norm = normalizeRepairProject;
export function matchesProductCompatibility(
  compatibility: {
    category: string;
    brand: string;
    model: string;
    project: string;
  },
  device: { category: string; brand: string; model: string },
  project: string,
) {
  return (
    compatibility.category === device.category &&
    norm(normalizeBrand(compatibility.brand)) ===
      norm(normalizeBrand(device.brand)) &&
    norm(normalizeDeviceModel(device.brand, compatibility.model)) ===
      norm(normalizeDeviceModel(device.brand, device.model)) &&
    (!compatibility.project.trim() ||
      norm(compatibility.project) === norm(project))
  );
}
export function matchRule<T extends MatchableRule>(
  rules: T[],
  device: { category: string; brand: string; series: string; model: string },
  project: string,
): { rule: T; level: string } | null {
  const eligible = rules.filter(
    (r) =>
      r.enabled &&
      r.category === device.category &&
      norm(r.project) === norm(project),
  );
  const exact = eligible.find(
    (r) =>
      r.model &&
      norm(normalizeBrand(r.brand)) === norm(normalizeBrand(device.brand)) &&
      norm(normalizeDeviceModel(device.brand, r.model)) ===
        norm(normalizeDeviceModel(device.brand, device.model)),
  );
  if (exact) return { rule: exact, level: "MODEL" };
  const series = eligible.find(
    (r) =>
      !r.model &&
      r.brand &&
      norm(normalizeBrand(r.brand)) === norm(normalizeBrand(device.brand)) &&
      r.series &&
      norm(normalizeDeviceModel(device.brand, r.series)) ===
        norm(normalizeDeviceModel(device.brand, device.series)),
  );
  if (series) return { rule: series, level: "SERIES" };
  const generic = eligible.find((r) => !r.brand && !r.series && !r.model);
  return generic ? { rule: generic, level: "GENERIC" } : null;
}
export function romeDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function isDiagnosticFault(values: string[]) {
  return values.some((value) =>
    ["da diagnosticare", "故障待检测"].includes(value.trim().toLowerCase()),
  );
}
export function promisedDate(order: {
  dueDate: string | null;
  type?: string;
  expectedAt?: string | null;
  afterSalesOpen?: boolean;
  afterSalesDueDate?: string | null;
}) {
  if (order.type === "QUICK_SERVICE")
    return order.expectedAt?.slice(0, 10) ?? order.dueDate ?? null;
  if (order.afterSalesOpen) return order.afterSalesDueDate ?? null;
  return order.dueDate ?? null;
}

export function isOverdue(
  order: {
    status: string;
    dueDate: string | null;
    type?: string;
    expectedAt?: string | null;
    afterSalesOpen?: boolean;
    afterSalesDueDate?: string | null;
  },
  today = romeDay(),
) {
  const dueDate = promisedDate(order);
  return (
    !["COMPLETED", "REFUNDED", "CANCELLED"].includes(order.status) &&
    !!dueDate &&
    dueDate < today
  );
}
export const money = (amount: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(
    amount / 100,
  );
export const dateTime = (date: Date | string, locale: "it" | "zh" = "it") =>
  new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "it-IT", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Rome",
  }).format(new Date(date));
export const dateOnly = (date: string | null, locale: "it" | "zh" = "it") =>
  date
    ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "it-IT", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${date}T00:00:00Z`))
    : "—";
export const dateTimeLocal = (
  value: string | null,
  locale: "it" | "zh" = "it",
) => {
  if (!value) return "—";
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value,
  );
  if (!match) return value.replace("T", " ");
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "it-IT", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(
    new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}Z`),
  );
};
export const orderCode = (code: string | number) =>
  typeof code === "string" ? code : `NGT-${String(code).padStart(5, "0")}`;
export const saleCode = (code: string | number) =>
  typeof code === "string" ? code : `R-${String(code).padStart(5, "0")}`;
export const creatablePaymentMethods = ["CASH", "CARD", "OTHER"] as const;

export type InventoryStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
export function inventoryStatus(
  stock: number,
  minimum: number,
): InventoryStatus {
  if (stock <= 0) return "OUT_OF_STOCK";
  return stock <= minimum ? "LOW_STOCK" : "IN_STOCK";
}
