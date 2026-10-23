import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getMessages } from "@/lib/i18n-server";
import { PageHeader, OrderTable } from "@/components/common";
import { OrderFilters } from "@/components/order-filters";
import { balance, romeDay, statuses, type OrderStatus } from "@/lib/domain";
import { requireActor } from "@/lib/session";
import {
  getBusinessDay,
  romeDateRange,
  validBusinessDate,
} from "@/lib/business-date";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

const pageSize = 25;
const closedStatuses = ["COMPLETED", "CANCELLED", "REFUNDED"] as const;

function nextMonth(month: string) {
  const [year, value] = month.split("-").map(Number);
  return value === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(value + 1).padStart(2, "0")}-01`;
}

export default async function Orders({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    attention?: string;
    month?: string;
    type?: string;
    view?: string;
    page?: string;
  }>;
}) {
  const it = await getMessages();
  await requireActor();
  const query = await searchParams;
  const today = await getBusinessDay();
  const q = query.q?.trim() ?? "";
  const exactOrderSearch =
    /^\d+$/.test(q) || /^(?:R|S|V)-?\d{8}-?\d{3}$/i.test(q);
  const requestedView = [
    "active",
    "ready",
    "overdue",
    "unpaid",
    "closed",
  ].includes(query.view ?? "")
    ? query.view!
    : "";
  const view = exactOrderSearch ? "" : requestedView;
  const month =
    exactOrderSearch ||
    view === "overdue" ||
    view === "unpaid" ||
    query.attention === "overdue" ||
    query.attention === "unpaid" ||
    (view && query.month === undefined)
      ? ""
      : query.month === undefined
        ? romeDay().slice(0, 7)
        : validBusinessDate(`${query.month}-01`)
          ? query.month
          : "";
  const status = statuses.includes(query.status as OrderStatus)
    ? (query.status as OrderStatus)
    : "";
  const type =
    query.type === "REPAIR" || query.type === "QUICK_SERVICE" ? query.type : "";
  const attention =
    view === "overdue" || view === "unpaid"
      ? view
      : query.attention === "overdue" || query.attention === "unpaid"
        ? query.attention
        : "";
  const filters: Prisma.WorkOrderWhereInput[] = [];
  if (q)
    filters.push({
      OR: [
        { device: { brand: { contains: q, mode: "insensitive" } } },
        { device: { model: { contains: q, mode: "insensitive" } } },
        { device: { imei: { contains: q, mode: "insensitive" } } },
        {
          device: { customer: { name: { contains: q, mode: "insensitive" } } },
        },
        {
          device: { customer: { phone: { contains: q, mode: "insensitive" } } },
        },
        {
          device: {
            customer: {
              phones: { some: { phone: { contains: q, mode: "insensitive" } } },
            },
          },
        },
        {
          relatedDevices: {
            some: {
              device: {
                OR: [
                  { brand: { contains: q, mode: "insensitive" } },
                  { model: { contains: q, mode: "insensitive" } },
                  { imei: { contains: q, mode: "insensitive" } },
                ],
              },
            },
          },
        },
        { items: { some: { project: { contains: q, mode: "insensitive" } } } },
        { fault: { contains: q, mode: "insensitive" } },
        { faultNote: { contains: q, mode: "insensitive" } },
        { inspectionResult: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
        ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : []),
      ],
    });
  if (view === "active")
    filters.push({ status: { notIn: [...closedStatuses] } });
  if (view === "ready") filters.push({ status: "READY" });
  if (view === "closed") filters.push({ status: { in: [...closedStatuses] } });
  if (status) filters.push({ status });
  if (type) filters.push({ type });
  if (month)
    filters.push({
      createdAt: romeDateRange(`${month}-01`, nextMonth(month)),
    });
  if (attention === "overdue")
    filters.push(
      { status: { notIn: [...closedStatuses] } },
      {
        OR: [
          { type: "QUICK_SERVICE", expectedAt: { lt: `${today}T00:00` } },
          {
            type: "QUICK_SERVICE",
            expectedAt: null,
            dueDate: { lt: today },
          },
          {
            type: "REPAIR",
            afterSalesOpen: true,
            afterSalesDueDate: { lt: today },
          },
          {
            type: "REPAIR",
            afterSalesOpen: false,
            dueDate: { lt: today },
          },
        ],
      },
    );
  if (attention === "unpaid")
    filters.push({ status: { notIn: [...closedStatuses] } });
  const where: Prisma.WorkOrderWhereInput =
    filters.length > 0 ? { AND: filters } : {};
  const findOrders = (pagination: { skip?: number; take?: number } = {}) =>
    db.workOrder.findMany({
      where,
      include: {
        device: { include: { customer: true } },
        items: true,
        products: true,
        payments: true,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      ...pagination,
    });
  const requestedPage = Math.max(
    1,
    Number.parseInt(query.page ?? "1", 10) || 1,
  );
  let page: number;
  let pageCount: number;
  let totalCount: number;
  let orders: Awaited<ReturnType<typeof findOrders>> = [];
  if (attention === "unpaid") {
    const candidates = await findOrders();
    const unpaid = candidates.filter(
      (order) => balance(order.items, order.payments, order) > 0,
    );
    totalCount = unpaid.length;
    pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
    page = Math.min(requestedPage, pageCount);
    orders = unpaid.slice((page - 1) * pageSize, page * pageSize);
  } else {
    totalCount = await db.workOrder.count({ where });
    pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
    page = Math.min(requestedPage, pageCount);
    orders = await findOrders({ skip: (page - 1) * pageSize, take: pageSize });
  }
  function pageHref(targetPage: number) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (query.month !== undefined || !view) params.set("month", month);
    if (status) params.set("status", status);
    if (attention) params.set("attention", attention);
    if (type) params.set("type", type);
    if (view) params.set("view", view);
    params.set("page", String(targetPage));
    return `/orders?${params.toString()}`;
  }
  const returnParams = new URLSearchParams();
  if (q) returnParams.set("q", q);
  if (query.month !== undefined || !view) returnParams.set("month", month);
  if (status) returnParams.set("status", status);
  if (attention) returnParams.set("attention", attention);
  if (type) returnParams.set("type", type);
  if (view) returnParams.set("view", view);
  if (query.page) returnParams.set("page", String(page));
  const returnTo = `/orders?${returnParams.toString()}`;
  const quickViews = [
    { key: "", label: it.orderViews.month },
    { key: "active", label: it.orderViews.active },
    { key: "ready", label: it.orderViews.ready },
    { key: "overdue", label: it.orderViews.overdue },
    { key: "unpaid", label: it.orderViews.unpaid },
    { key: "closed", label: it.orderViews.closed },
  ];
  function quickViewHref(nextView: string) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    if (nextView) params.set("view", nextView);
    return `/orders?${params.toString()}`;
  }
  return (
    <div className="workspace-list-page orders-page">
      <PageHeader
        title={it.nav.orders}
        description={it.ordersDescription}
        actionNode={
          <div className="page-header-actions">
            <Button asChild>
              <Link href="/orders/new">
                <Plus size={18} />
                {it.quickService.repairMode}
              </Link>
            </Button>
            <Button asChild>
              <Link href="/orders/new?type=quick">
                <Plus size={18} />
                {it.quickService.quickMode}
              </Link>
            </Button>
          </div>
        }
      />
      <nav className="order-quick-views" aria-label={it.orderQuickViewsLabel}>
        {quickViews.map(({ key, label }) => (
          <Link
            key={key || "month"}
            href={quickViewHref(key)}
            className={
              !view && !key
                ? "is-active"
                : view === key && key
                  ? "is-active"
                  : ""
            }
            aria-current={
              !view && !key ? "page" : view === key && key ? "page" : undefined
            }
          >
            {label}
          </Link>
        ))}
        {view && <span>{it.orderViews.allTime}</span>}
      </nav>
      <OrderFilters
        key={[month, status, attention, type, view].join("|")}
        initial={{
          q,
          month,
          status,
          attention,
          type,
          view,
        }}
        currentMonth={romeDay().slice(0, 7)}
        exactOrderSearch={exactOrderSearch}
      />
      <section className="panel table-panel">
        <OrderTable
          orders={orders}
          returnTo={returnTo}
          emptyText={it.searchNoResults}
        />
      </section>
      {pageCount > 1 && (
        <nav className="order-pagination" aria-label={it.orderPagination}>
          <span>
            {it.pageOf
              .replace("{current}", String(page))
              .replace("{total}", String(pageCount))
              .replace("{count}", String(totalCount))}
          </span>
          <div>
            {page > 1 && (
              <Button asChild variant="outline">
                <Link href={pageHref(page - 1)}>{it.previousPage}</Link>
              </Button>
            )}
            {page < pageCount && (
              <Button asChild variant="outline">
                <Link href={pageHref(page + 1)}>{it.nextPage}</Link>
              </Button>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
