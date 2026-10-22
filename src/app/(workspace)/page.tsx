import Link from "next/link";
import {
  AlertTriangle,
  ChevronRight,
  Clock3,
  Inbox,
  PackageCheck,
  ShoppingBag,
  Wrench,
} from "lucide-react";
import { db } from "@/lib/db";
import { isActiveOrderStatus, money, orderCode } from "@/lib/domain";
import {
  canViewReceiptData,
  monthToDatePeriods,
  summarizeMonthToDateReceipts,
} from "@/lib/business-metrics";
import { getLocale, getMessages } from "@/lib/i18n-server";
import { Badge, PageHeader } from "@/components/common";
import { requireActor } from "@/lib/session";
import { DashboardMotion } from "@/components/dashboard-motion";
import {
  getBusinessDay,
  romeDateRange,
  validBusinessDate,
} from "@/lib/business-date";
import { DatePicker } from "@/components/business-select";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const it = await getMessages();
  const locale = await getLocale();
  const actor = await requireActor();
  const businessToday = await getBusinessDay();
  const query = await searchParams;
  const requestedDay = query.day;
  const today =
    requestedDay && validBusinessDate(requestedDay)
      ? requestedDay
      : businessToday;
  const canViewReceipts = canViewReceiptData(actor.role);
  const paymentPeriods = monthToDatePeriods(today);
  const closedStatuses = ["COMPLETED", "CANCELLED", "REFUNDED"] as const;
  const [orderStatusRows, overdueCount, stockLevels, payments, recentOrders] =
    await Promise.all([
      db.workOrder.groupBy({ by: ["status"], _count: { _all: true } }),
      db.workOrder.count({
        where: {
          status: { notIn: [...closedStatuses] },
          dueDate: { lt: businessToday },
        },
      }),
      db.product.findMany({
        where: { enabled: true },
        select: { stockQuantity: true, minStock: true },
      }),
      canViewReceipts
        ? db.payment.findMany({
            where: {
              OR: paymentPeriods.map((period) => ({
                receivedAt: romeDateRange(
                  period.startDay,
                  period.endDayExclusive,
                ),
              })),
            },
            select: { amount: true, receivedAt: true },
          })
        : Promise.resolve([]),
      db.workOrder.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          code: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          device: { select: { brand: true, model: true } },
        },
      }),
    ]);
  const statusCounts = new Map(
    orderStatusRows.map((row) => [row.status, row._count._all]),
  );
  const activeCount = orderStatusRows.reduce(
    (sum, row) => sum + (isActiveOrderStatus(row.status) ? row._count._all : 0),
    0,
  );
  const lowStockCount = stockLevels.filter(
    (product) =>
      product.stockQuantity > 0 && product.stockQuantity <= product.minStock,
  ).length;
  const outOfStockCount = stockLevels.filter(
    (product) => product.stockQuantity <= 0,
  ).length;
  const receiptSummary = canViewReceipts
    ? summarizeMonthToDateReceipts(payments, today)
    : null;
  const metrics = [
    {
      label: it.active,
      value: activeCount,
      count: activeCount,
      type: "integer",
      icon: Wrench,
      color: "teal",
    },
    {
      label: it.ready,
      value: statusCounts.get("READY") ?? 0,
      count: statusCounts.get("READY") ?? 0,
      type: "integer",
      icon: PackageCheck,
      color: "blue",
    },
    {
      label: it.overdue,
      value: overdueCount,
      count: overdueCount,
      type: "integer",
      icon: Clock3,
      color: "orange",
    },
  ];
  const fingerprint = JSON.stringify({
    today,
    metrics: metrics.map(({ count }) => count),
    receipts: receiptSummary,
    attention: [overdueCount, lowStockCount, outOfStockCount],
    recent: recentOrders[0]?.updatedAt,
  });
  const dateLocale = locale === "zh" ? "zh-CN" : "it-IT";
  const formatDate = (day: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(dateLocale, {
      ...options,
      timeZone: "Europe/Rome",
    }).format(new Date(`${day}T12:00:00Z`));
  const selectedDateLabel = formatDate(today, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const monthRangeLabel = receiptSummary
    ? `${formatDate(paymentPeriods[0].startDay, { day: "numeric", month: "short" })} – ${formatDate(paymentPeriods[0].endDay, { day: "numeric", month: "short", year: "numeric" })}`
    : "";

  return (
    <DashboardMotion fingerprint={fingerprint} locale={locale}>
      <PageHeader title={it.today} description={it.dashboardDescription} />
      {canViewReceipts && receiptSummary && (
        <section
          aria-labelledby="dashboard-receipts-title"
          className="panel padded dashboard-receipts"
        >
          <div className="dashboard-receipts-heading">
            <h2 id="dashboard-receipts-title">{it.dashboard.receiptsTitle}</h2>
            <form className="date-strip dashboard-date-filter">
              <span className="live-dot" />
              <span>{selectedDateLabel}</span>
              <DatePicker name="day" defaultValue={today} />
            </form>
          </div>
          <div className="dashboard-receipt-summary">
            <div className="dashboard-day-receipts">
              <span>{it.receivedOnDay}</span>
              <strong
                data-count={receiptSummary.selectedDay}
                data-count-type="money"
              >
                {money(receiptSummary.selectedDay)}
              </strong>
            </div>
            <div className="dashboard-month-receipts">
              <div className="dashboard-month-total">
                <span>{it.dashboard.monthToDate}</span>
                <small>{monthRangeLabel}</small>
                <strong
                  data-count={receiptSummary.monthToDate}
                  data-count-type="money"
                >
                  {money(receiptSummary.monthToDate)}
                </strong>
              </div>
              <div className="dashboard-year-section">
                <h3 className="dashboard-year-heading">
                  {it.dashboard.yearOverYear}
                </h3>
                <div className="dashboard-year-comparisons">
                  {receiptSummary.comparisons.map((comparison) => (
                    <div
                      className="dashboard-year-comparison"
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
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
      <div className="metrics dashboard-kpis">
        {metrics.map(({ label, value, count, type, icon: Icon, color }) => (
          <div className="metric" key={label}>
            <div className="metric-top">
              <span>{label}</span>
              <span className={`metric-icon ${color}`}>
                <Icon size={21} />
              </span>
            </div>
            <strong data-count={count} data-count-type={type}>
              {value}
            </strong>
            <small>{it.workspace}</small>
          </div>
        ))}
      </div>

      <div className="dashboard-lists">
        <section className="panel padded attention-card">
          <div className="section-heading">
            <h2>{it.priorities}</h2>
          </div>
          {overdueCount + lowStockCount + outOfStockCount ? (
            <>
              <Link href="/orders?attention=overdue">
                <Clock3 size={18} />
                <span>{it.overdue}</span>
                <strong>{overdueCount}</strong>
              </Link>
              <Link href="/inventory?status=LOW_STOCK">
                <AlertTriangle size={18} />
                <span>{it.dashboard.lowStock}</span>
                <strong>{lowStockCount}</strong>
              </Link>
              <Link href="/inventory?status=OUT_OF_STOCK">
                <ShoppingBag size={18} />
                <span>{it.dashboard.outOfStock}</span>
                <strong>{outOfStockCount}</strong>
              </Link>
            </>
          ) : (
            <p className="dashboard-empty">
              <Inbox size={18} />
              {it.dashboard.noAttention}
            </p>
          )}
        </section>

        <section className="panel padded dashboard-list-card">
          <div className="section-heading">
            <h2>{it.recent}</h2>
            <Link className="dashboard-action-link" href="/orders">
              <span className="dashboard-link-label">{it.viewAll}</span>
              <ChevronRight size={15} aria-hidden="true" />
            </Link>
          </div>
          {recentOrders.map((order) => (
            <Link
              className="dashboard-list-row"
              href={`/orders/${order.id}`}
              key={order.id}
            >
              <span>
                <strong>{orderCode(order.code)}</strong>
                <small>
                  {order.device.brand} {order.device.model}
                </small>
              </span>
              <Badge status={order.status} />
            </Link>
          ))}
          {!recentOrders.length && (
            <p className="dashboard-empty">
              <Inbox size={18} />
              {it.empty}
            </p>
          )}
        </section>
      </div>
    </DashboardMotion>
  );
}
