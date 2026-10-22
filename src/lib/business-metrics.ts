import { cents, romeDay } from "./domain";
import type { Actor } from "./domain";
import { daysInMonth, monthParts } from "./date-picker";

type Allocation = {
  source: "REPAIR" | "RETAIL" | "QUICK_SERVICE";
  amount: string | { toString(): string };
};
export type BusinessPayment = {
  amount: string | { toString(): string };
  method: "CASH" | "CARD" | "TRANSFER" | "OTHER";
  receivedAt: Date | string;
  orderId?: string | null;
  saleId?: string | null;
  allocations?: Allocation[];
};

export type MonthToDatePeriod = {
  year: number;
  startDay: string;
  endDay: string;
  endDayExclusive: string;
};

export type MonthlyReceiptPeriod = MonthToDatePeriod & {
  month: string;
};

export function canViewReceiptData(role: Actor["role"]) {
  return role === "OWNER";
}

function nextDay(day: string) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function normalizeReceiptMonth(
  requestedMonth: string | undefined,
  businessToday: string,
) {
  const currentMonth = businessToday.slice(0, 7);
  return requestedMonth &&
    monthParts(requestedMonth) &&
    requestedMonth <= currentMonth
    ? requestedMonth
    : currentMonth;
}

export function monthlyReceiptPeriods(
  requestedMonth: string | undefined,
  businessToday: string,
  previousYears = 3,
) {
  const month = normalizeReceiptMonth(requestedMonth, businessToday);
  const { year: selectedYear, month: selectedMonth } = monthParts(month)!;
  const currentMonth = businessToday.slice(0, 7);
  const currentDay = Number(businessToday.slice(8, 10));
  const useCurrentCutoff = month === currentMonth;

  return Array.from({ length: previousYears + 1 }, (_, offset) => {
    const year = selectedYear - offset;
    const monthText = String(selectedMonth).padStart(2, "0");
    const lastDay = daysInMonth(year, selectedMonth);
    const endDate = useCurrentCutoff ? Math.min(currentDay, lastDay) : lastDay;
    const endDay = `${year}-${monthText}-${String(endDate).padStart(2, "0")}`;

    return {
      year,
      month: `${year}-${monthText}`,
      startDay: `${year}-${monthText}-01`,
      endDay,
      endDayExclusive: nextDay(endDay),
    };
  });
}

export function summarizeMonthlyReceipts(
  payments: Pick<BusinessPayment, "amount" | "receivedAt">[],
  requestedMonth: string | undefined,
  businessToday: string,
  previousYears = 3,
) {
  const periods = monthlyReceiptPeriods(
    requestedMonth,
    businessToday,
    previousYears,
  );
  const totalBetween = (startDay: string, endDayExclusive: string) =>
    payments.reduce((total, payment) => {
      const day = romeDay(new Date(payment.receivedAt));
      return day >= startDay && day < endDayExclusive
        ? total + cents(payment.amount)
        : total;
    }, 0);
  const amount = totalBetween(periods[0].startDay, periods[0].endDayExclusive);

  return {
    month: periods[0].month,
    amount,
    startDay: periods[0].startDay,
    endDay: periods[0].endDay,
    comparisons: periods.slice(1).map((period) => {
      const comparisonAmount = totalBetween(
        period.startDay,
        period.endDayExclusive,
      );
      return {
        year: period.year,
        amount: comparisonAmount,
        changePercentage:
          comparisonAmount === 0
            ? null
            : Math.round(
                ((amount - comparisonAmount) / comparisonAmount) * 100,
              ),
      };
    }),
  };
}

export function monthToDatePeriods(selectedDay: string, previousYears = 3) {
  const [selectedYear, month, selectedDate] = selectedDay
    .split("-")
    .map(Number);
  const monthText = String(month).padStart(2, "0");

  return Array.from({ length: previousYears + 1 }, (_, offset) => {
    const year = selectedYear - offset;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = String(Math.min(selectedDate, lastDay)).padStart(2, "0");
    const endDay = `${year}-${monthText}-${day}`;

    return {
      year,
      startDay: `${year}-${monthText}-01`,
      endDay,
      endDayExclusive: nextDay(endDay),
    };
  });
}

export function summarizeMonthToDateReceipts(
  payments: Pick<BusinessPayment, "amount" | "receivedAt">[],
  selectedDay: string,
  previousYears = 3,
) {
  const periods = monthToDatePeriods(selectedDay, previousYears);
  const totalBetween = (startDay: string, endDayExclusive: string) =>
    payments.reduce((total, payment) => {
      const day = romeDay(new Date(payment.receivedAt));
      return day >= startDay && day < endDayExclusive
        ? total + cents(payment.amount)
        : total;
    }, 0);
  const monthToDate = totalBetween(
    periods[0].startDay,
    periods[0].endDayExclusive,
  );

  return {
    selectedDay: totalBetween(selectedDay, nextDay(selectedDay)),
    monthToDate,
    comparisons: periods.slice(1).map((period) => {
      const amount = totalBetween(period.startDay, period.endDayExclusive);
      return {
        year: period.year,
        amount,
        changePercentage:
          amount === 0
            ? null
            : Math.round(((monthToDate - amount) / amount) * 100),
      };
    }),
  };
}

export function revenueParts(payment: BusinessPayment) {
  if (payment.allocations?.length) {
    return payment.allocations.reduce(
      (result, allocation) => {
        const key =
          allocation.source === "QUICK_SERVICE"
            ? "quickService"
            : (allocation.source.toLowerCase() as "repair" | "retail");
        result[key] += cents(allocation.amount);
        return result;
      },
      { repair: 0, retail: 0, quickService: 0 },
    );
  }
  return payment.saleId
    ? { repair: 0, retail: cents(payment.amount), quickService: 0 }
    : { repair: cents(payment.amount), retail: 0, quickService: 0 };
}

export function summarizePayments(payments: BusinessPayment[], day?: string) {
  return payments
    .filter((payment) => !day || romeDay(new Date(payment.receivedAt)) === day)
    .reduce(
      (summary, payment) => {
        const parts = revenueParts(payment);
        const amount = cents(payment.amount);
        summary.total += amount;
        summary.repair += parts.repair;
        summary.retail += parts.retail;
        summary.quickService += parts.quickService;
        const method = payment.method === "TRANSFER" ? "OTHER" : payment.method;
        summary.methods[method] += amount;
        return summary;
      },
      {
        total: 0,
        repair: 0,
        retail: 0,
        quickService: 0,
        methods: { CASH: 0, CARD: 0, OTHER: 0 },
      },
    );
}

export function recentRomeDays(today: string, count = 7) {
  const [year, month, day] = today.split("-").map(Number);
  const anchor = Date.UTC(year, month - 1, day, 12);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(anchor - (count - index - 1) * 86_400_000);
    return date.toISOString().slice(0, 10);
  });
}

export function revenueSeries(
  payments: BusinessPayment[],
  today: string,
  count = 7,
) {
  return recentRomeDays(today, count).map((day) => ({
    day,
    ...summarizePayments(payments, day),
  }));
}
