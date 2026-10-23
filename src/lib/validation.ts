import { z } from "zod";
import { isDiagnosticFault, normalizePhone, statuses } from "./domain";
const short = z.string().trim().min(1, "Campo obbligatorio").max(120);
const text = z.string().trim().max(2000).default("");
export const amountInput = z
  .string()
  .trim()
  .regex(/^\d{1,8}([.,]\d{1,2})?$/, "Importo non valido");
export const phoneInput = z
  .string()
  .trim()
  .min(6, "Il numero di telefono è troppo corto.")
  .max(30)
  .transform((value, ctx) => {
    try {
      return normalizePhone(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Telefono non valido" });
      return z.NEVER;
    }
  });
export const dueDateInput = z
  .string()
  .refine(
    (value) =>
      !value ||
      (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value),
    "Data non valida",
  )
  .default("");

export const quickServiceExpectedAtInput = z
  .string()
  .trim()
  .refine(
    (value) => !value || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value),
    "Data e ora non valide",
  );

export const businessClockInput = z
  .object({
    mode: z.enum(["SYSTEM", "MANUAL"]),
    manualDate: z.string().trim().default(""),
  })
  .superRefine((value, ctx) => {
    if (value.mode !== "MANUAL") return;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value.manualDate) ||
      Number.isNaN(Date.parse(value.manualDate)) ||
      new Date(value.manualDate).toISOString().slice(0, 10) !== value.manualDate
    )
      ctx.addIssue({
        code: "custom",
        path: ["manualDate"],
        message: "Data non valida",
      });
  });
export const itemInput = z.object({
  project: short,
  final: amountInput,
  adjustmentReason: text,
  discount: amountInput.default("0"),
  saveRule: z.boolean().default(false),
  priceOptionId: z.string().trim().max(100).default(""),
  requiredProductId: z.string().trim().max(100).default(""),
  requiredQuantity: z.coerce.number().int().min(1).max(999).default(1),
  requiredProductRemoved: z.boolean().default(false),
});
export const orderInput = z
  .object({
    requestId: z.string().uuid(),
    customerName: short,
    phone: phoneInput,
    additionalPhones: z.array(phoneInput).max(2).default([]),
    privacyConsent: z.boolean().default(false),
    category: z
      .enum([
        "PHONE",
        "TABLET",
        "LAPTOP",
        "DESKTOP",
        "CONSOLE",
        "SMARTWATCH",
        "SMARTBAND",
        "OTHER",
      ])
      .default("PHONE"),
    faults: z.array(short).max(30).default([]),
    standardFaultIds: z.array(z.string().min(1).max(100)).max(30).default([]),
    customFaults: z
      .array(z.string().trim().min(1).max(200))
      .max(30)
      .default([]),
    inspectionMode: z.boolean().default(false),
    orderDiscount: amountInput.default("0"),
    includeVat: z.boolean().default(false),
    paymentKind: z.enum(["DEPOSIT", "BALANCE"]).default("DEPOSIT"),
    deviceId: z.string().max(100).default(""),
    brand: short,
    series: z.string().trim().max(120).default(""),
    model: short,
    imei: z.string().trim().max(30).default(""),
    appearance: text,
    accessories: text,
    fault: z.string().trim().max(2000).default(""),
    faultNote: z.string().trim().max(2000).default(""),
    notes: text,
    dueDate: dueDateInput,
    items: z.array(itemInput).max(30),
    diagnosticFee: amountInput.default("10"),
    deposit: amountInput.default("0"),
    method: z.enum(["CASH", "CARD", "OTHER"]).default("CASH"),
  })
  .superRefine((value, ctx) => {
    const diagnostic =
      value.inspectionMode || isDiagnosticFault([...value.faults, value.fault]);
    if (
      !diagnostic &&
      value.standardFaultIds.length === 0 &&
      value.customFaults.length === 0 &&
      value.faults.length === 0 &&
      !value.fault
    )
      ctx.addIssue({
        code: "custom",
        path: ["standardFaultIds"],
        message: "Seleziona almeno un problema o attiva la diagnosi.",
      });
    if (!diagnostic && value.items.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Aggiungi almeno un intervento.",
      });
    if (diagnostic && centsSafe(value.diagnosticFee) <= 0)
      ctx.addIssue({
        code: "custom",
        path: ["diagnosticFee"],
        message: "Inserisci un costo diagnosi valido.",
      });
  });

function centsSafe(value: string) {
  const normalized = Number(value.replace(",", "."));
  return Number.isFinite(normalized) ? Math.round(normalized * 100) : -1;
}
export const editInput = z.object({
  customerId: z.string().trim().max(100).optional(),
  standardFaultIds: z.array(z.string().min(1).max(100)).max(30).optional(),
  fault: z.string().trim().min(1).max(2000),
  faultNote: text,
  customFaults: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  notes: text,
  appearance: text,
  accessories: text,
  dueDate: dueDateInput,
});
export const paymentInput = z.object({
  requestId: z.string().uuid(),
  amount: amountInput,
  method: z.enum(["CASH", "CARD", "OTHER"]),
  kind: z.enum(["DEPOSIT", "BALANCE", "OTHER"]),
});
export const productInput = z.object({
  requestId: z.string().uuid(),
  name: short,
  category: short,
  usage: z.enum(["RETAIL", "REPAIR"]),
  costPrice: amountInput,
  salePrice: amountInput,
  initialStock: z.coerce.number().int().min(0).max(1_000_000).default(0),
  minStock: z.coerce.number().int().min(0).max(1_000_000).default(0),
  favorite: z.boolean().default(false),
  enabled: z.boolean().default(true),
  compatibilities: z
    .array(
      z.object({
        category: z.string().trim().min(1).max(30),
        brand: short,
        model: short,
        project: z.string().trim().max(120).default(""),
      }),
    )
    .max(100)
    .default([]),
});
export const productUpdateInput = z.object({
  name: short,
  category: short,
  usage: z.enum(["RETAIL", "REPAIR"]),
  costPrice: amountInput,
  salePrice: amountInput,
  stockQuantity: z.coerce.number().int().min(0).max(1_000_000),
  minStock: z.coerce.number().int().min(0).max(1_000_000),
  favorite: z.boolean(),
  compatibilities: z
    .array(
      z.object({
        category: z.string().trim().min(1).max(30),
        brand: short,
        model: short,
        project: z.string().trim().max(120).default(""),
      }),
    )
    .max(100)
    .optional(),
});
export const paidTotalInput = z.object({
  requestId: z.string().uuid(),
  amount: amountInput,
  method: z.enum(["CASH", "CARD", "OTHER"]).default("CASH"),
  adjustmentReason: z.string().trim().min(1).max(200),
});
export const inventoryAdjustmentInput = z.object({
  requestId: z.string().uuid(),
  quantity: z.coerce
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => value !== 0, "La variazione non può essere zero."),
  type: z.enum(["STOCK_IN", "MANUAL_ADJUSTMENT"]),
  note: text,
});
export const retailSaleInput = z
  .object({
    requestId: z.string().uuid(),
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.coerce.number().int().min(1).max(999),
        }),
      )
      .max(100)
      .default([]),
    services: z
      .array(
        z.object({
          serviceId: z.string().min(1).max(100),
          price: amountInput,
          quantity: z.coerce.number().int().min(1).max(99).default(1),
        }),
      )
      .max(100)
      .default([]),
    discount: amountInput.default("0"),
    method: z.enum(["CASH", "CARD", "OTHER"]),
  })
  .refine((value) => value.items.length + value.services.length > 0, {
    message: "Aggiungi almeno un prodotto o servizio.",
  });
export const workOrderProductInput = z.object({
  productId: z.string().min(1),
  kind: z.enum(["REPAIR_PART", "RETAIL_ADDON"]),
  quantity: z.coerce.number().int().min(1).max(999),
});
export const checkoutInput = z.object({
  requestId: z.string().uuid(),
  amount: amountInput.default("0"),
  method: z.enum(["CASH", "CARD", "OTHER"]),
  pickedUpBy: short,
  pickedUpAt: z.string().datetime().optional(),
  override: z.boolean().default(false),
});
export const statusInput = z.object({
  status: z.enum(statuses),
  note: text,
  pickedUpBy: z.string().trim().max(120).default(""),
  override: z.boolean().default(false),
  cancelPayment: z
    .object({
      requestId: z.string().uuid(),
      amount: amountInput,
      method: z.enum(["CASH", "CARD", "OTHER"]),
    })
    .optional(),
});

export const quickServiceInput = z.object({
  name: short,
  defaultPrice: amountInput,
  notes: text,
  enabled: z.boolean().default(true),
});

export const quickServiceOrderInput = z.object({
  requestId: z.string().uuid(),
  customerId: z.string().min(1).max(100),
  deviceIds: z.array(z.string().min(1).max(100)).min(1).max(10),
  services: z
    .array(
      z.object({
        serviceId: z.string().min(1).max(100),
        price: amountInput,
      }),
    )
    .min(1)
    .max(30),
  expectedAt: quickServiceExpectedAtInput.refine(
    Boolean,
    "Data e ora non valide",
  ),
});

export const quickServiceOrderEditInput = z
  .object({
    expectedAt: quickServiceExpectedAtInput.refine(Boolean),
    notes: text,
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          project: short,
          final: amountInput,
        }),
      )
      .min(1)
      .max(30),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.items.map((item) => item.id)).size !== value.items.length)
      ctx.addIssue({ code: "custom", path: ["items"] });
  });

export const renameDeviceModelInput = z.object({
  category: z.string().trim().min(1).max(30),
  brand: short,
  from: short,
  to: short,
});

export const deleteWorkOrderInput = z.object({
  code: short,
});
export const warrantyInput = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        days: z.coerce
          .number()
          .int()
          .refine((value) => [0, 7, 30, 60, 90, 180, 365].includes(value)),
        notes: text,
      }),
    )
    .min(1)
    .max(30),
});
export const afterSalesInput = z.object({
  items: z
    .array(
      z.object({
        originalItemId: z.string().min(1).max(100),
        treatment: z.enum(["WARRANTY", "PAID"]),
        fee: amountInput.default("0"),
        requiredProductId: z.string().max(100).default(""),
        requiredQuantity: z.coerce.number().int().min(1).max(999).default(1),
      }),
    )
    .min(1)
    .max(30),
  notes: text,
  dueDate: dueDateInput,
});
export const refundInput = z.object({
  requestId: z.string().uuid(),
  amount: amountInput,
  method: z.enum(["CASH", "CARD", "OTHER"]),
  reason: z.string().trim().min(1).max(2000),
});
export const ruleInput = z
  .object({
    category: z
      .enum([
        "PHONE",
        "TABLET",
        "LAPTOP",
        "DESKTOP",
        "CONSOLE",
        "SMARTWATCH",
        "SMARTBAND",
        "OTHER",
      ])
      .default("PHONE"),
    brand: z.string().trim().max(120).default(""),
    series: z.string().trim().max(120).default(""),
    model: z.string().trim().max(120).default(""),
    project: short,
    suggested: amountInput,
    cost: z.union([amountInput, z.literal("")]).default(""),
    minutes: z.coerce.number().int().min(0).max(10000).default(60),
    enabled: z.boolean().default(true),
    notes: text,
    requiredProductId: z.string().trim().max(100).default(""),
    requiredQuantity: z.coerce.number().int().min(1).max(999).default(1),
  })
  .superRefine((r, ctx) => {
    if (
      (r.model && !r.brand) ||
      (r.series && !r.brand) ||
      (r.brand && !r.model && !r.series) ||
      (r.model && r.series)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Scegli marca + modello, marca + serie oppure una regola generica senza dispositivo.",
      });
  });
export const priceRuleOptionInput = z.object({
  productId: z.string().trim().min(1).max(100),
  name: short,
  suggested: amountInput,
  cost: z.union([amountInput, z.literal("")]).default(""),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  minutes: z.coerce.number().int().min(0).max(10000).default(60),
  warrantyDays: z.coerce.number().int().min(0).max(3650).default(0),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  notes: text,
});
export const userInput = z.object({
  name: short,
  email: z.string().email().toLowerCase(),
  password: z.string().min(12).max(128),
  role: z.enum(["OWNER", "STAFF"]),
});

export const quoteInput = z.object({
  items: z.array(itemInput).min(1).max(30),
  orderDiscount: amountInput.default("0"),
  includeVat: z.boolean().default(false),
});

export const inspectionQuoteInput = quoteInput.extend({
  standardFaultIds: z.array(z.string().min(1).max(100)).min(1).max(30),
  faultNote: text,
  dueDate: dueDateInput.refine(Boolean, "Data obbligatoria"),
});

export const faultCatalogInput = z.object({
  category: z.enum([
    "PHONE",
    "TABLET",
    "LAPTOP",
    "DESKTOP",
    "CONSOLE",
    "SMARTWATCH",
    "SMARTBAND",
    "OTHER",
  ]),
  name: short,
  note: text,
  hidden: z.boolean().default(false),
});

export const customerInput = z
  .object({
    name: short,
    phone: phoneInput,
    additionalPhones: z.array(phoneInput).max(2).default([]),
  })
  .refine(
    (v) =>
      new Set([v.phone, ...v.additionalPhones]).size ===
      1 + v.additionalPhones.length,
    "I numeri di telefono non possono essere duplicati.",
  );
export const deviceInput = z.object({
  category: z.enum([
    "PHONE",
    "TABLET",
    "LAPTOP",
    "DESKTOP",
    "CONSOLE",
    "SMARTWATCH",
    "SMARTBAND",
    "OTHER",
  ]),
  brand: short,
  model: short,
  imei: z.string().trim().max(30).default(""),
});
