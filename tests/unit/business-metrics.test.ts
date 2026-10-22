import { describe, expect, it } from "vitest";
import {
  canViewReceiptData,
  monthToDatePeriods,
  recentRomeDays,
  revenueSeries,
  summarizeMonthToDateReceipts,
  summarizePayments,
} from "@/lib/business-metrics";

describe("business metrics", () => {
  const payments = [
    {
      amount: "145",
      method: "CASH" as const,
      receivedAt: "2026-09-24T10:00:00Z",
      orderId: "order",
      allocations: [
        { source: "REPAIR" as const, amount: "120" },
        { source: "RETAIL" as const, amount: "25" },
      ],
    },
    {
      amount: "15",
      method: "TRANSFER" as const,
      receivedAt: "2026-09-24T12:00:00Z",
      saleId: "legacy-sale",
    },
  ];

  it("shows receipt data only to owners", () => {
    expect(canViewReceiptData("OWNER")).toBe(true);
    expect(canViewReceiptData("STAFF")).toBe(false);
  });

  it("uses allocations and groups legacy transfer under other", () => {
    expect(summarizePayments(payments, "2026-09-24")).toEqual({
      total: 16000,
      repair: 12000,
      retail: 4000,
      quickService: 0,
      methods: { CASH: 14500, CARD: 0, OTHER: 1500 },
    });
  });

  it("creates a stable seven-day series ending on the selected Rome day", () => {
    expect(recentRomeDays("2026-03-30", 3)).toEqual([
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
    ]);
    expect(revenueSeries(payments, "2026-09-24", 2)[1]).toMatchObject({
      day: "2026-09-24",
      total: 16000,
      repair: 12000,
      retail: 4000,
    });
  });

  it("builds same-month-to-date periods across calendar years", () => {
    expect(monthToDatePeriods("2026-12-31")).toEqual([
      {
        year: 2026,
        startDay: "2026-12-01",
        endDay: "2026-12-31",
        endDayExclusive: "2027-01-01",
      },
      {
        year: 2025,
        startDay: "2025-12-01",
        endDay: "2025-12-31",
        endDayExclusive: "2026-01-01",
      },
      {
        year: 2024,
        startDay: "2024-12-01",
        endDay: "2024-12-31",
        endDayExclusive: "2025-01-01",
      },
      {
        year: 2023,
        startDay: "2023-12-01",
        endDay: "2023-12-31",
        endDayExclusive: "2024-01-01",
      },
    ]);
  });

  it("caps February 29 comparisons to the last day in shorter years", () => {
    expect(monthToDatePeriods("2024-02-29").slice(0, 2)).toEqual([
      {
        year: 2024,
        startDay: "2024-02-01",
        endDay: "2024-02-29",
        endDayExclusive: "2024-03-01",
      },
      {
        year: 2023,
        startDay: "2023-02-01",
        endDay: "2023-02-28",
        endDayExclusive: "2023-03-01",
      },
    ]);
  });

  it("uses Rome day boundaries and omits percentage changes from zero totals", () => {
    const receipts = summarizeMonthToDateReceipts(
      [
        { amount: "120", receivedAt: "2026-03-29T21:59:59.999Z" },
        { amount: "900", receivedAt: "2026-03-29T22:00:00.000Z" },
        { amount: "80", receivedAt: "2025-03-29T22:59:00.000Z" },
        { amount: "900", receivedAt: "2025-03-29T23:00:00.000Z" },
      ],
      "2026-03-29",
    );

    expect(receipts).toEqual({
      selectedDay: 12000,
      monthToDate: 12000,
      comparisons: [
        { year: 2025, amount: 8000, changePercentage: 50 },
        { year: 2024, amount: 0, changePercentage: null },
        { year: 2023, amount: 0, changePercentage: null },
      ],
    });
  });
});
