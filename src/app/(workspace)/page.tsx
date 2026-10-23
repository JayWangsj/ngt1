import Link from "next/link";
import {
  AlertTriangle,
  ChartNoAxesColumnIncreasing,
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
  monthlyReceiptPeriods,
  monthToDatePeriods,
  normalizeReceiptMonth,
  recentRomeDays,
  revenueSeries,
  summarizeMonthlyReceipts,
  summarizeMonthToDateReceipts,
  summarizePayments,
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
import { MonthlyReceiptsDialog } from "@/components/monthly-receipts-dialog";

function percentage(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; receipts?: string }>;
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
  const receiptDialogOpen = canViewReceipts && query.receipts !== undefined;
  const defaultReceiptMonth = normalizeReceiptMonth(
    today.slice(0, 7),
    businessToday,
  );
  const receiptMonth = normalizeReceiptMonth(
    receiptDialogOpen ? query.receipts : defaultReceiptMonth,
    businessToday,
  );
  const paymentPeriods = monthToDatePeriods(today, 0);
  const receiptDialogPeriods = receiptDialogOpen
    ? monthlyReceiptPeriods(receiptMonth, businessToday)
    : [];
  const weekStart = recentRomeDays(today, 7)[0];
  const closedStatuses = ["COMPLETED", "CANCELLED", "REFUNDED"] as const;
  const [
    orderStatusRows,
    overdueCount,
    stockLevels,
    payments,
    receiptDialogPayments,
    recentOrders,
  ] = await Promise.all([
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
            OR: [
              ...paymentPeriods.map((period) => ({
                receivedAt: romeDateRange(
                  period.startDay,
                  period.endDayExclusive,
                ),
              })),
              {
                receivedAt: romeDateRange(
                  weekStart,
                  paymentPeriods[0].endDayExclusive,
                ),
              },
            ],
          },
          include: { allocations: true },
          orderBy: { receivedAt: "asc" },
        })
      : Promise.resolve([]),
    receiptDialogOpen
      ? db.payment.findMany({
          where: {
            OR: receiptDialogPeriods.map((period) => ({
              receivedAt: romeDateRange(
                period.startDay,
                period.endDayExclusive,
              ),
            })),
          },
          select: { amount: true, receivedAt: true },
          orderBy: { receivedAt: "asc" },
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
  const attentionCount = overdueCount + lowStockCount + outOfStockCount;
  const receiptSummary = canViewReceipts
    ? summarizeMonthToDateReceipts(payments, today, 0)
    : null;
  const receiptDialogSummary = receiptDialogOpen
    ? summarizeMonthlyReceipts(
        receiptDialogPayments,
        receiptMonth,
        businessToday,
      )
    : null;
  const todayRevenue = canViewReceipts
    ? summarizePayments(payments, today)
    : null;
  const series = canViewReceipts ? revenueSeries(payments, today) : [];
  const chartMax = Math.max(
    ...series.flatMap((day) => [day.repair, day.retail, day.quickService]),
    1,
  );
  const hasRevenueSeries = series.some((day) => day.total !== 0);
  const repairShare = todayRevenue
    ? percentage(todayRevenue.repair, todayRevenue.total)
    : 0;
  const retailShare = todayRevenue
    ? percentage(todayRevenue.retail, todayRevenue.total)
    : 0;
  const quickServiceShare = todayRevenue
    ? percentage(todayRevenue.quickService, todayRevenue.total)
    : 0;
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
    revenueSeries: series.map(({ total }) => total),
    receiptComposition: todayRevenue
      ? [todayRevenue.repair, todayRevenue.retail, todayRevenue.quickService]
      : null,
    attention: [overdueCount, lowStockCount, outOfStockCount],
    recent: recentOrders[0]?.updatedAt,
  });
  const dateLocale = locale === "zh" ? "zh-CN" : "it-IT";
  const formatDate = (day: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(dateLocale, {
      ...options,
      timeZone: "Europe/Rome",
    }).format(new Date(`${day}T12:00:00Z`));
  const monthRangeLabel = receiptSummary
    ? `${formatDate(paymentPeriods[0].startDay, { day: "numeric", month: "short" })} – ${formatDate(paymentPeriods[0].endDay, { day: "numeric", month: "short", year: "numeric" })}`
    : "";
  const receiptDialogRangeLabel = receiptDialogSummary
    ? `${formatDate(receiptDialogSummary.startDay, { day: "numeric", month: "short" })} – ${formatDate(receiptDialogSummary.endDay, { day: "numeric", month: "short", year: "numeric" })}`
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
              <MonthlyReceiptsDialog
                open={receiptDialogOpen}
                defaultMonth={defaultReceiptMonth}
                month={receiptMonth}
                maxMonth={businessToday.slice(0, 7)}
                rangeLabel={receiptDialogRangeLabel}
                summary={receiptDialogSummary}
              />
            </div>
          </div>
        </section>
      )}
      {canViewReceipts && todayRevenue && (
        <div className="dashboard-charts">
          <section className="panel padded revenue-chart-card">
            <div className="section-heading">
              <h2>{it.dashboard.revenue7}</h2>
              <div className="chart-legend">
                <span>
                  <i className="repair" />
                  {it.dashboard.repairRevenue}
                </span>
                <span>
                  <i className="retail" />
                  {it.dashboard.retailRevenue}
                </span>
                <span>
                  <i className="quick-service" />
                  {it.dashboard.quickServiceRevenue}
                </span>
              </div>
            </div>
            {hasRevenueSeries ? (
              <div className="revenue-bars">
                {series.map((day) => {
                  const dateLabel = formatDate(day.day, {
                    month: "2-digit",
                    day: "2-digit",
                  });
                  return (
                    <div
                      aria-label={`${dateLabel}: ${it.dashboard.totalRevenue} ${money(day.total)}`}
                      className="revenue-day"
                      key={day.day}
                      tabIndex={0}
                    >
                      <div className="revenue-bar-track">
                        <div
                          className="revenue-bar repair"
                          data-bar={`${(day.repair / chartMax) * 100}%`}
                          style={{
                            height: `${(day.repair / chartMax) * 100}%`,
                          }}
                        />
                        <div
                          className="revenue-bar retail"
                          data-bar={`${(day.retail / chartMax) * 100}%`}
                          style={{
                            height: `${(day.retail / chartMax) * 100}%`,
                          }}
                        />
                        <div
                          className="revenue-bar quick-service"
                          data-bar={`${(day.quickService / chartMax) * 100}%`}
                          style={{
                            height: `${(day.quickService / chartMax) * 100}%`,
                          }}
                        />
                      </div>
                      <small>{dateLabel}</small>
                      <div className="revenue-tooltip" role="tooltip">
                        <strong>{dateLabel}</strong>
                        <span>
                          {it.dashboard.repairRevenue}
                          <b>{money(day.repair)}</b>
                        </span>
                        <span>
                          {it.dashboard.quickServiceRevenue}
                          <b>{money(day.quickService)}</b>
                        </span>
                        <span>
                          {it.dashboard.retailRevenue}
                          <b>{money(day.retail)}</b>
                        </span>
                        <span className="total">
                          {it.dashboard.totalRevenue}
                          <b>{money(day.total)}</b>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="dashboard-empty dashboard-chart-empty">
                <ChartNoAxesColumnIncreasing size={22} />
                <span>{it.dashboard.noRevenue}</span>
              </div>
            )}
          </section>
          <section className="panel padded revenue-source-card">
            <h2>{it.dashboard.receiptComposition}</h2>
            {todayRevenue.total ? (
              <div className="revenue-source-content">
                <div className="revenue-donut">
                  <svg aria-hidden="true" viewBox="0 0 42 42">
                    <circle className="donut-track" cx="21" cy="21" r="15.9" />
                    <circle
                      className="donut-segment repair"
                      cx="21"
                      cy="21"
                      data-donut-segment={repairShare}
                      pathLength="100"
                      r="15.9"
                      style={{
                        strokeDasharray: `${repairShare} ${100 - repairShare}`,
                      }}
                    />
                    <circle
                      className="donut-segment retail"
                      cx="21"
                      cy="21"
                      data-donut-segment={retailShare}
                      data-donut-offset={-repairShare}
                      pathLength="100"
                      r="15.9"
                      style={{
                        strokeDasharray: `${retailShare} ${100 - retailShare}`,
                        strokeDashoffset: -repairShare,
                      }}
                    />
                    <circle
                      className="donut-segment quick-service"
                      cx="21"
                      cy="21"
                      data-donut-segment={quickServiceShare}
                      data-donut-offset={-(repairShare + retailShare)}
                      pathLength="100"
                      r="15.9"
                      style={{
                        strokeDasharray: `${quickServiceShare} ${100 - quickServiceShare}`,
                        strokeDashoffset: -(repairShare + retailShare),
                      }}
                    />
                  </svg>
                  <span>
                    <strong
                      data-count={todayRevenue.total}
                      data-count-type="money"
                    >
                      {money(todayRevenue.total)}
                    </strong>
                    <small>{it.receipts}</small>
                  </span>
                </div>
                <div className="revenue-source-legend">
                  {[
                    [
                      "repair",
                      it.dashboard.repairRevenue,
                      todayRevenue.repair,
                      repairShare,
                    ],
                    [
                      "retail",
                      it.dashboard.retailRevenue,
                      todayRevenue.retail,
                      retailShare,
                    ],
                    [
                      "quick-service",
                      it.dashboard.quickServiceRevenue,
                      todayRevenue.quickService,
                      quickServiceShare,
                    ],
                  ].map(([source, label, amount, share]) => (
                    <p key={String(source)}>
                      <i className={String(source)} />
                      <span>{label}</span>
                      <strong>{money(Number(amount))}</strong>
                      <small>{share}%</small>
                    </p>
                  ))}
                </div>
              </div>
            ) : (
              <div className="dashboard-empty dashboard-compact-empty">
                <Inbox size={20} />
                <span>{it.dashboard.noReceipts}</span>
              </div>
            )}
          </section>
        </div>
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
          </div>
        ))}
      </div>

      <div className="dashboard-lists">
        <section
          className={`panel padded attention-card${attentionCount ? " is-active" : ""}`}
        >
          <div className="section-heading">
            <h2>{it.priorities}</h2>
          </div>
          {attentionCount ? (
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
