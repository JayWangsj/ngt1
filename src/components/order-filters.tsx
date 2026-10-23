"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { statuses } from "@/lib/domain";
import { DatePicker, SimpleSelect } from "./business-select";
import { useMessages } from "./language";

type FilterValues = {
  q: string;
  month: string;
  status: string;
  attention: string;
  type: string;
  view: string;
};

export function OrderFilters({
  initial,
  currentMonth,
  exactOrderSearch = false,
}: {
  initial: FilterValues;
  currentMonth: string;
  exactOrderSearch?: boolean;
}) {
  const it = useMessages();
  const router = useRouter();
  const pathname = usePathname();
  const timer = useRef<number | null>(null);
  const [values, setValues] = useState(initial);

  function apply(next: FilterValues, delay = 0) {
    setValues(next);
    if (timer.current) window.clearTimeout(timer.current);
    const navigate = () => {
      const params = new URLSearchParams();
      if (next.q.trim()) params.set("q", next.q.trim());
      if (next.status) params.set("status", next.status);
      if (next.attention) params.set("attention", next.attention);
      if (next.type) params.set("type", next.type);
      if (next.view) params.set("view", next.view);
      params.set("month", next.month);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    };
    if (delay) timer.current = window.setTimeout(navigate, delay);
    else navigate();
  }

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className="filters order-filters">
      <label className="grow">
        <span className="sr-only">{it.search}</span>
        <input
          name="q"
          placeholder={it.orderSearch}
          value={values.q}
          onChange={(event) => apply({ ...values, q: event.target.value }, 250)}
        />
      </label>
      <label className="order-month-filter">
        <span className="sr-only">{it.month}</span>
        <DatePicker
          name="month"
          type="month"
          value={values.month}
          onChange={(event) => apply({ ...values, month: event.target.value })}
        />
      </label>
      <button
        type="button"
        className="order-date-scope-toggle"
        onClick={() =>
          apply({
            ...values,
            month: values.month ? "" : currentMonth,
            view: "",
            attention: "",
          })
        }
      >
        {values.month ? it.orderViews.allTime : it.orderViews.month}
      </button>
      <label>
        <span className="sr-only">{it.statusLabel}</span>
        <SimpleSelect
          name="status"
          value={values.status}
          onChange={(status) => apply({ ...values, status })}
          placeholder={`${it.all} · ${it.statusLabel}`}
          ariaLabel={it.statusLabel}
          options={[
            { value: "", label: `${it.all} · ${it.statusLabel}` },
            ...statuses
              .filter(
                (status) => status !== "RECEIVED" || values.type !== "REPAIR",
              )
              .map((status) => ({
                value: status,
                label:
                  status === "RECEIVED"
                    ? it.quickStatus.RECEIVED
                    : it.status[status],
              })),
          ]}
        />
      </label>
      <label>
        <span className="sr-only">{it.serviceType}</span>
        <SimpleSelect
          name="type"
          value={values.type}
          onChange={(type) => apply({ ...values, type })}
          placeholder={it.orderTypes.all}
          ariaLabel={it.serviceType}
          options={[
            { value: "", label: it.orderTypes.all },
            { value: "REPAIR", label: it.orderTypes.REPAIR },
            { value: "QUICK_SERVICE", label: it.orderTypes.QUICK_SERVICE },
          ]}
        />
      </label>
      <label>
        <span className="sr-only">{it.attention}</span>
        <SimpleSelect
          name="attention"
          value={values.attention}
          onChange={(attention) => apply({ ...values, attention })}
          placeholder={`${it.all} · ${it.attention}`}
          ariaLabel={it.attention}
          options={[
            { value: "", label: `${it.all} · ${it.attention}` },
            { value: "overdue", label: it.overdue },
            { value: "unpaid", label: it.unpaid },
          ]}
        />
      </label>
      {exactOrderSearch && (
        <p className="order-search-scope" role="status">
          {it.exactOrderSearchScope}
        </p>
      )}
    </div>
  );
}
