import { describe, it, expect } from "vitest";
import {
  assertDelivery,
  assertOwner,
  assertTransition,
  allowedTransitions,
  allocatePayment,
  balance,
  cents,
  dateTime,
  dateTimeLocal,
  dateOnly,
  decimal,
  isOverdue,
  isActiveOrderStatus,
  inventoryStatus,
  isDiagnosticFault,
  matchRule,
  normalizePhone,
  romeDay,
  promisedDate,
  settlement,
  statuses,
  total,
  warrantyPeriod,
  warrantyProgress,
} from "@/lib/domain";
import { orderInput, paymentInput, ruleInput } from "@/lib/validation";
const staff = { id: "s", name: "Staff", role: "STAFF" as const };
describe("integer money", () => {
  it("handles euro cents exactly", () => {
    expect(total([{ final: "0.1" }, { final: "0.2" }])).toBe(30);
    expect(cents("12,05")).toBe(1205);
    expect(decimal(1205)).toBe("12.05");
    expect(cents("-1.25")).toBe(-125);
    expect(decimal(-125)).toBe("-1.25");
    expect(balance([{ final: "10" }], [{ amount: "2.99" }])).toBe(701);
  });
  it.each(["NaN", "1.001", "1e2", "Infinity", "100000000", "", "1.2.3"])(
    "rejects invalid money %s",
    (value) => expect(() => cents(value)).toThrow(),
  );
  it("keeps product prices tax-inclusive and allocates mixed payments", () => {
    const result = settlement([{ final: "100" }], {
      includeVat: true,
      products: [{ unitPrice: "15", quantity: 2 }],
    });
    expect(result).toMatchObject({ vat: 2200, productTotal: 3000, due: 15200 });
    expect(allocatePayment(9500, 8000, 1500)).toEqual({
      repair: 8000,
      retail: 1500,
    });
  });
  it("adds post-sale fees without changing quote or IVA totals", () => {
    const result = settlement([{ final: "100" }], {
      includeVat: true,
      afterSalesFee: "50",
    });
    expect(result).toMatchObject({
      gross: 10000,
      vat: 2200,
      afterSalesTotal: 5000,
      due: 17200,
    });
    expect(
      balance([{ final: "100" }], [{ amount: "0" }], {
        status: "REFUNDED",
      }),
    ).toBe(0);
  });
  it("keeps inspection fees separate from repair items and applies the shared IVA rule", () => {
    expect(
      settlement([], { inspectionFee: "30", includeVat: false }),
    ).toMatchObject({
      inspectionTotal: 3000,
      repairGross: 0,
      vat: 660,
      due: 3000,
    });
    expect(settlement([], { inspectionFee: "30", includeVat: true }).due).toBe(
      3660,
    );
  });
});

describe("diagnostic intake", () => {
  it("recognizes the diagnostic fault in both supported languages", () => {
    expect(isDiagnosticFault(["Da diagnosticare"])).toBe(true);
    expect(isDiagnosticFault(["故障待检测"])).toBe(true);
    expect(isDiagnosticFault(["Display rotto"])).toBe(false);
  });
});

describe("inventory status", () => {
  it("distinguishes available, low and out-of-stock products", () => {
    expect(inventoryStatus(8, 3)).toBe("IN_STOCK");
    expect(inventoryStatus(3, 3)).toBe("LOW_STOCK");
    expect(inventoryStatus(0, 3)).toBe("OUT_OF_STOCK");
  });
});

describe("payment methods", () => {
  it("keeps legacy transfer values out of new payment input", () => {
    expect(
      paymentInput.safeParse({
        requestId: "85d6d2cc-bc27-4b55-9ec7-7a90092388d3",
        amount: "10",
        method: "TRANSFER",
        kind: "BALANCE",
      }).success,
    ).toBe(false);
  });
});
describe("quote matching", () => {
  const device = {
    category: "PHONE",
    brand: "Apple",
    series: "iPhone",
    model: "iPhone 13",
  };
  const rules = [
    {
      id: "generic",
      category: "PHONE",
      brand: "",
      series: "",
      model: "",
      project: "Display",
      enabled: true,
    },
    {
      id: "series",
      category: "PHONE",
      brand: "Apple",
      series: "iPhone",
      model: "",
      project: "Display",
      enabled: true,
    },
    {
      id: "exact",
      category: "PHONE",
      brand: "Apple",
      series: "",
      model: "iPhone 13",
      project: "Display",
      enabled: true,
    },
  ];
  it("prefers exact model, then series, then generic", () => {
    expect(matchRule(rules, device, " display ")?.rule.id).toBe("exact");
    expect(matchRule(rules.slice(0, 2), device, "Display")?.rule.id).toBe(
      "series",
    );
    expect(matchRule(rules.slice(0, 1), device, "Display")?.level).toBe(
      "GENERIC",
    );
  });
  it("ignores inactive and other brands", () => {
    expect(
      matchRule(
        rules.map((r) => ({ ...r, enabled: false })),
        device,
        "Display",
      ),
    ).toBeNull();
    expect(
      matchRule(rules, { ...device, brand: "Samsung" }, "Display")?.rule.id,
    ).toBe("generic");
    expect(matchRule(rules, device, "Camera")).toBeNull();
  });
});
describe("status and permissions", () => {
  it("excludes refunded orders from active counts", () => {
    expect(isActiveOrderStatus("READY")).toBe(true);
    expect(isActiveOrderStatus("REFUNDED")).toBe(false);
    expect(isActiveOrderStatus("COMPLETED")).toBe(false);
    expect(isActiveOrderStatus("CANCELLED")).toBe(false);
  });
  it("requires allowed transitions and terminal states remain closed", () => {
    expect(statuses).not.toContain("WAITING_APPROVAL");
    expect(() => assertTransition("RECEIVED", "COMPLETED")).toThrow();
    expect(() => assertTransition("COMPLETED", "REPAIRING")).toThrow();
    expect(() => assertTransition("CANCELLED", "RECEIVED")).toThrow();
    expect(() => assertTransition("REPAIRING", "READY")).not.toThrow();
    expect(() => assertTransition("REPAIRING", "PARTS_MISSING")).toThrow();
    expect(() => assertTransition("RECEIVED", "PARTS_MISSING")).toThrow();
    expect(() => assertTransition("PARTS_MISSING", "REPAIRING")).toThrow();
    expect(allowedTransitions("PARTS_MISSING", false)).toEqual(["CANCELLED"]);
    expect(allowedTransitions("PARTS_MISSING", true)).toEqual([]);
    expect(allowedTransitions("PARTS_PENDING_CONFIRMATION", false)).toEqual([
      "REPAIRING",
      "CANCELLED",
    ]);
    expect(allowedTransitions("PARTS_PENDING_CONFIRMATION", true)).toEqual([
      "REWORKING",
    ]);
    expect(allowedTransitions("READY", false)).toEqual([
      "REPAIRING",
      "COMPLETED",
    ]);
    expect(allowedTransitions("READY", true)).toEqual([
      "REWORKING",
      "COMPLETED",
    ]);
    expect(() => assertTransition("READY", "REWORKING", true)).not.toThrow();
    expect(() => assertTransition("READY", "CANCELLED", true)).toThrow();
    expect(() => assertTransition("READY", "REPAIRING", true)).toThrow();
    expect(() => assertTransition("DIAGNOSING", "REPAIRING")).toThrow();
    expect(() => assertTransition("DIAGNOSING", "READY")).toThrow();
    expect(() => assertTransition("DIAGNOSING", "COMPLETED")).toThrow();
    expect(() => assertTransition("DIAGNOSING", "CANCELLED")).not.toThrow();
  });
  it("requires a zero balance for delivery", () => {
    expect(() => assertDelivery(100)).toThrow();
    expect(() => assertDelivery(0)).not.toThrow();
    expect(() => assertOwner(staff)).toThrow();
  });
});
describe("Italian localization and validation", () => {
  it("normalizes national and international phones without dropping Italian leading zero", () => {
    expect(normalizePhone("333 123 4567")).toBe("+393331234567");
    expect(normalizePhone("0039 02-1234567")).toBe("+39021234567");
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
  });
  it("uses Rome day across UTC midnight and daylight saving", () => {
    expect(romeDay(new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02");
    expect(romeDay(new Date("2026-01-01T23:30:00Z"))).toBe("2026-01-02");
  });
  it("formats timestamps for the selected interface language", () => {
    const timestamp = new Date("2026-10-14T00:51:00Z");
    expect(dateTime(timestamp, "it")).toBe("14/10/26, 02:51");
    expect(dateTime(timestamp, "zh")).toBe("2026/10/14 02:51");
  });
  it("formats plain dates and local date-times without changing their day", () => {
    expect(dateOnly("2026-10-14", "it")).toBe("14/10/2026");
    expect(dateOnly("2026-10-14", "zh")).toBe("2026/10/14");
    expect(dateTimeLocal("2026-10-14T09:05", "it")).toBe("14/10/26, 09:05");
    expect(dateTimeLocal("2026-10-14T09:05", "zh")).toBe("2026/10/14 09:05");
  });
  it("starts warranty at actual delivery and adds exact days", () => {
    expect(
      warrantyPeriod(new Date("2026-09-27T12:00:00Z"), 90, "2026-12-01"),
    ).toEqual({ start: "2026-09-27", end: "2026-12-26", active: true });
    expect(warrantyPeriod(null, 90)).toBeNull();
  });
  it("reports warranty progress and expiry without exceeding its bounds", () => {
    const delivery = new Date("2026-01-01T12:00:00Z");
    expect(warrantyProgress(delivery, 30, "2026-01-16")).toMatchObject({
      progress: 50,
      remainingPercent: 50,
      remainingDays: 15,
      state: "ACTIVE",
    });
    expect(warrantyProgress(delivery, 30, "2026-02-02")).toMatchObject({
      progress: 100,
      remainingPercent: 0,
      remainingDays: 0,
      state: "EXPIRED",
    });
    expect(warrantyProgress(null, 90, "2026-01-16")).toBeNull();
  });
  it("excludes closed orders from overdue", () => {
    expect(
      isOverdue({ status: "READY", dueDate: "2026-01-01" }, "2026-01-02"),
    ).toBe(true);
    expect(
      isOverdue({ status: "COMPLETED", dueDate: "2026-01-01" }, "2026-01-02"),
    ).toBe(false);
    expect(
      isOverdue({ status: "REFUNDED", dueDate: "2026-01-01" }, "2026-01-02"),
    ).toBe(false);
    expect(
      isOverdue({ status: "READY", dueDate: "2026-01-02" }, "2026-01-02"),
    ).toBe(false);
  });
  it("uses one promised date for repair, quick service, and open after-sales", () => {
    expect(
      promisedDate({
        dueDate: "2026-01-01",
        type: "REPAIR",
        afterSalesOpen: true,
        afterSalesDueDate: "2026-01-05",
      }),
    ).toBe("2026-01-05");
    expect(
      promisedDate({
        dueDate: "2026-01-01",
        type: "QUICK_SERVICE",
        expectedAt: "2026-01-06T18:30",
      }),
    ).toBe("2026-01-06");
    expect(
      isOverdue(
        {
          status: "REWORKING",
          dueDate: "2026-01-01",
          afterSalesOpen: true,
          afterSalesDueDate: "2026-01-05",
        },
        "2026-01-04",
      ),
    ).toBe(false);
  });
  it("rejects ambiguous quote scopes", () => {
    expect(
      ruleInput.safeParse({
        brand: "Apple",
        project: "Display",
        suggested: "10",
        minutes: 30,
        enabled: true,
      }).success,
    ).toBe(false);
  });
  it("rejects an impossible due date", () => {
    expect(orderInput.shape.dueDate.safeParse("2026-02-30").success).toBe(
      false,
    );
  });
});
