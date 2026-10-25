import Link from "next/link";
import type {
  WorkOrder,
  Device,
  Customer,
  WorkOrderItem,
  WorkOrderProduct,
  Payment,
} from "@prisma/client";
import { Plus, Wrench } from "lucide-react";
import { getLocale, getMessages } from "@/lib/i18n-server";
import {
  balance,
  cents,
  dateTime,
  isOverdue,
  promisedDate,
  settlement,
  type OrderStatus,
} from "@/lib/domain";
import { Button } from "./ui/button";
import backButtonStyles from "./ui/back-button.module.css";
import { OrderListBody } from "./order-list-controls";
import { getBusinessDay } from "@/lib/business-date";
export function BackButton({ href, label }: { href: string; label: string }) {
  return (
    <Button
      asChild
      variant="outline"
      className={`back-link ${backButtonStyles.backLink}`}
    >
      <Link href={href}>← {label}</Link>
    </Button>
  );
}
export async function PageHeader({
  title,
  description,
  action = false,
  actionHref,
  actionLabel,
  actionNode,
}: {
  title: string;
  description?: string;
  action?: boolean;
  actionHref?: string;
  actionLabel?: string;
  actionNode?: import("react").ReactNode;
}) {
  const it = await getMessages();
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow">{it.workspace}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actionNode}
      {(action || actionHref) && (
        <Button asChild>
          <Link href={actionHref ?? "/orders/new"}>
            <Plus size={18} />
            {actionLabel ?? it.newOrder}
          </Link>
        </Button>
      )}
    </header>
  );
}
export async function Badge({ status }: { status: OrderStatus }) {
  const it = await getMessages();
  return (
    <span className={`badge status-${status.toLowerCase()}`}>
      <span className="badge-dot" aria-hidden="true" />
      <span className="badge-label">{it.status[status]}</span>
    </span>
  );
}
export async function Empty({ text }: { text?: string }) {
  const it = await getMessages();
  return (
    <div className="empty">
      <Wrench size={26} />
      <p>{text ?? it.empty}</p>
    </div>
  );
}
type Row = WorkOrder & {
  device: Device & { customer: Customer };
  items: WorkOrderItem[];
  products: WorkOrderProduct[];
  payments: Payment[];
};
export async function OrderTable({
  orders,
  hideCustomer = false,
  compact = false,
  returnTo = "/orders",
  emptyText,
}: {
  orders: Row[];
  hideCustomer?: boolean;
  compact?: boolean;
  returnTo?: string;
  emptyText?: string;
}) {
  const it = await getMessages();
  const locale = await getLocale();
  const today = await getBusinessDay();
  if (!orders.length)
    return compact ? (
      <p className="compact-empty">{emptyText ?? it.empty}</p>
    ) : (
      <Empty text={emptyText} />
    );
  return (
    <div className="table-scroll order-table-scroll">
      <table className={`order-table${compact ? " order-table-compact" : ""}`}>
        <thead>
          <tr>
            <th aria-label={it.serviceType} />
            <th>{it.order}</th>
            {!hideCustomer && <th>{it.customer}</th>}
            <th>{it.device}</th>
            <th className="order-status-cell">{it.statusLabel}</th>
            <th className="order-due-cell">{it.dueDate}</th>
            <th className="order-updated-cell">{it.lastOperation}</th>
            <th className="numeric order-payment-cell">{it.payments}</th>
          </tr>
        </thead>
        <OrderListBody
          hideCustomer={hideCustomer}
          compact={compact}
          returnTo={returnTo}
          rows={orders.map((order) => {
            const due = ["REFUNDED", "CANCELLED"].includes(order.status)
              ? 0
              : settlement(order.items, order).due;
            const remaining = balance(order.items, order.payments, order);
            const paid =
              order.status === "CANCELLED"
                ? order.payments.reduce(
                    (sum, payment) => sum + cents(payment.amount),
                    0,
                  )
                : order.status === "REFUNDED"
                  ? 0
                  : due - remaining;
            return {
              id: order.id,
              code: order.code,
              customerId: order.device.customerId,
              customerName: order.device.customer.name,
              brand: order.device.brand,
              model: order.device.model,
              projects: order.inspectionMode
                ? it.inspectionPending
                : order.items.map((item) => item.project).join(", "),
              status: order.status,
              dueDate: promisedDate(order) ?? "",
              expectedAt: order.expectedAt ?? "",
              overdue: isOverdue(order, today),
              lastUpdated: dateTime(order.updatedAt, locale),
              due,
              paid,
              balance: remaining,
              afterSalesOpen: order.afterSalesOpen,
              type: order.type,
            };
          })}
        />
      </table>
    </div>
  );
}
