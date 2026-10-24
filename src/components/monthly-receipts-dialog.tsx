"use client";

import { CalendarRange } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { money } from "@/lib/domain";
import { DatePicker } from "./business-select";
import { DialogBody, FormDialog } from "./forms";
import { useMessages } from "./language";
import { Button } from "./ui/button";

type MonthlyReceiptSummary = {
  amount: number;
  comparisons: {
    year: number;
    amount: number;
    changePercentage: number | null;
  }[];
};

const subscribeToBrowser = () => () => {};

export function MonthlyReceiptsDialog({
  open,
  defaultMonth,
  month,
  maxMonth,
  rangeLabel,
  summary,
}: {
  open: boolean;
  defaultMonth: string;
  month: string;
  maxMonth: string;
  rangeLabel: string;
  summary: MonthlyReceiptSummary | null;
}) {
  const it = useMessages();
  const router = useRouter();
  const mounted = useSyncExternalStore(
    subscribeToBrowser,
    () => true,
    () => false,
  );

  function receiptUrl(nextMonth?: string) {
    const params = new URLSearchParams(window.location.search);
    if (nextMonth) params.set("receipts", nextMonth);
    else params.delete("receipts");
    const query = params.toString();
    return `${window.location.pathname}${query ? `?${query}` : ""}`;
  }

  function close() {
    router.replace(receiptUrl(), { scroll: false });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="dashboard-month-entry"
        onClick={() => router.push(receiptUrl(defaultMonth), { scroll: false })}
      >
        <CalendarRange size={16} aria-hidden="true" />
        {it.dashboard.monthlyReceipts}
      </Button>
      {mounted && open && summary && (
        <FormDialog
          title={it.dashboard.monthlyReceipts}
          subtitle={it.dashboard.monthlyReceiptsDescription}
          size="medium"
          onClose={close}
        >
          <DialogBody className="monthly-receipt-dialog">
            <div className="monthly-receipt-overview">
              <div className="monthly-receipt-picker">
                <span>{it.month}</span>
                <DatePicker
                  type="month"
                  value={month}
                  max={maxMonth}
                  aria-label={it.month}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value)
                      router.replace(receiptUrl(value), { scroll: false });
                  }}
                />
              </div>
              <div className="monthly-receipt-total">
                <span>{it.dashboard.selectedMonthTotal}</span>
                <strong>{money(summary.amount)}</strong>
                <small>{rangeLabel}</small>
              </div>
            </div>
            <section
              className="monthly-receipt-comparisons"
              aria-labelledby="monthly-receipt-comparisons-title"
            >
              <h3 id="monthly-receipt-comparisons-title">
                {it.dashboard.yearOverYear}
              </h3>
              {summary.comparisons.map((comparison) => (
                <div
                  className="monthly-receipt-comparison"
                  key={comparison.year}
                >
                  <span>{comparison.year}</span>
                  <strong>{money(comparison.amount)}</strong>
                  <small
                    className={
                      comparison.changePercentage === null
                        ? ""
                        : comparison.changePercentage >= 0
                          ? "is-positive"
                          : "is-negative"
                    }
                  >
                    {comparison.changePercentage === null
                      ? "—"
                      : `${comparison.changePercentage > 0 ? "+" : ""}${comparison.changePercentage}%`}
                  </small>
                </div>
              ))}
            </section>
          </DialogBody>
        </FormDialog>
      )}
    </>
  );
}
