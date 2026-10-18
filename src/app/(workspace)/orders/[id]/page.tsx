import { faultLabel } from "@/lib/catalog";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { orderInclude } from "@/lib/service";
import { requireActor } from "@/lib/session";
import {
  balance,
  cents,
  dateOnly,
  dateTime,
  dateTimeLocal,
  money,
  matchRule,
  orderCode,
  promisedDate,
  settlement,
  warrantyProgress,
} from "@/lib/domain";
import { BackButton, Badge, PageHeader } from "@/components/common";
import {
  EditOrderForm,
  EditQuoteForm,
  PaymentForm,
  QuoteSummary,
  WarrantyForm,
  WarrantyProgressPanel,
  ReworkPartEditor,
} from "@/components/forms";
import { getLocale, getMessages } from "@/lib/i18n-server";
import {
  WorkOrderCheckout,
  WorkOrderProducts,
} from "@/components/work-order-products";
import {
  AfterSalesActions,
  CustomerDetailLink,
  OrderDetailCard,
} from "@/components/order-detail-ui";
import { DetailStatusControl } from "@/components/order-list-controls";
import { CompleteInspectionButton } from "@/components/inspection-quote";
import { getBusinessDay } from "@/lib/business-date";
import { WorkOrderRepairSummary } from "@/components/work-order-repair-summary";
import { ServiceOrderActions } from "@/components/service-order-actions";
import { ServiceOrderPrint } from "@/components/service-order-print";
import { it as italianMessages } from "@/messages/it";
import { priceRuleViews } from "@/lib/price-rule-view";

type TimelineEvent = {
  id: string;
  at: Date;
  title: string;
  actor: string;
  detail?: string;
};

function auditContext(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export default async function Detail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const it = await getMessages();
  const locale = await getLocale();
  const actor = await requireActor();
  const today = await getBusinessDay();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const requestedReturnTo = query.returnTo ?? "";
  const returnTo =
    requestedReturnTo === "/orders" || requestedReturnTo.startsWith("/orders?")
      ? requestedReturnTo
      : "/orders";
  const backHref = `${returnTo}#order-${id}`;
  const [order, audits, inventoryMovementCount] = await Promise.all([
    db.workOrder.findUnique({ where: { id }, include: orderInclude }),
    db.auditLog.findMany({
      where: {
        entityId: id,
        action: {
          in: [
            "ORDER_CREATED",
            "INSPECTION_STARTED",
            "INSPECTION_COMPLETED",
            "QUOTE_CREATED",
            "AFTER_SALES_OPENED",
            "AFTER_SALES_PART_CHANGED",
            "REFUND_ISSUED",
            "STATUS_CHANGED",
          ],
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.inventoryMovement.count({
      where: { referenceType: "WORK_ORDER", referenceId: id },
    }),
  ]);
  if (!order) notFound();
  const [
    rules,
    products,
    customers,
    faultOptions,
    productCategories,
    reservations,
  ] = await Promise.all([
    db.priceRule.findMany({
      where: { enabled: true },
      include: {
        options: {
          where: { enabled: true },
          include: { product: true },
          orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }],
        },
      },
    }),
    db.product.findMany({
      where: { enabled: true },
      orderBy: [{ favorite: "desc" }, { name: "asc" }],
    }),
    db.customer.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        phone: true,
        phones: { select: { phone: true } },
      },
      orderBy: { name: "asc" },
    }),
    db.faultOption.findMany({
      select: {
        id: true,
        category: true,
        name: true,
        note: true,
        hidden: true,
        sortOrder: true,
        _count: { select: { orders: true } },
      },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    }),
    db.inventoryCategory.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, repairOnly: true },
      orderBy: { name: "asc" },
    }),
    db.workOrderProduct.groupBy({
      by: ["productId"],
      where: {
        consumedAt: null,
        order: {
          status: { notIn: ["COMPLETED", "REFUNDED", "CANCELLED"] },
        },
      },
      _sum: { quantity: true },
    }),
  ]);
  const repairProducts = products.filter(
    (product) => product.usage === "REPAIR",
  );
  const reservedByProduct = new Map(
    reservations.map((entry) => [entry.productId, entry._sum.quantity ?? 0]),
  );
  const ruleViews = priceRuleViews(rules, reservedByProduct);
  const totals = settlement(order.items, order);
  const remaining = balance(order.items, order.payments, order);
  const receivedTotal = order.payments.reduce(
    (sum, payment) => sum + cents(payment.amount),
    0,
  );
  const financiallyClosed = ["REFUNDED", "CANCELLED"].includes(order.status);
  const received = financiallyClosed ? 0 : receivedTotal;
  const currentDue = financiallyClosed ? 0 : totals.due;
  const deleteBlockedReason = order.payments.length
    ? it.deleteServiceOrderBlockedPayment
    : order.products.length || inventoryMovementCount
      ? it.deleteServiceOrderBlockedInventory
      : order.reworks.length
        ? it.deleteServiceOrderBlockedAfterSales
        : undefined;
  const repairAmount = financiallyClosed
    ? 0
    : totals.due -
      totals.productTotal -
      totals.afterSalesTotal -
      totals.inspectionTotal;
  const productAmount = financiallyClosed ? 0 : totals.productTotal;
  const afterSalesAmount = financiallyClosed ? 0 : totals.afterSalesTotal;
  const inspectionStageAction =
    order.type === "REPAIR" && order.status === "DIAGNOSING" ? (
      <CompleteInspectionButton
        orderId={id}
        inspectionFee={order.inspectionFee.toString()}
        device={{
          category: order.device.category,
          brand: order.device.brand,
          series: order.device.series,
          model: order.device.model,
        }}
        rules={ruleViews}
        faultOptions={faultOptions.map(({ _count, ...fault }) => ({
          ...fault,
          usageCount: _count.orders,
        }))}
        initialFaultIds={order.faults.flatMap((fault) =>
          fault.catalogId ? [fault.catalogId] : [],
        )}
        products={repairProducts.map((product) => ({
          id: product.id,
          name: product.name,
          category: product.category,
          stock: product.stockQuantity,
          reserved: reservedByProduct.get(product.id) ?? 0,
          available: Math.max(
            0,
            product.stockQuantity - (reservedByProduct.get(product.id) ?? 0),
          ),
        }))}
        productCategories={productCategories}
      />
    ) : null;
  const originalLocked =
    order.afterSalesOpen ||
    ["COMPLETED", "REWORKING", "REFUNDED", "CANCELLED"].includes(order.status);
  const itemWarranties = new Map(
    order.items.map((item) => [
      item.id,
      warrantyProgress(item.warrantyStart, item.warrantyDays, today),
    ]),
  );
  const printDevices =
    order.type === "QUICK_SERVICE" && order.relatedDevices.length
      ? order.relatedDevices.map(({ device }) => ({
          name: `${device.brand} ${device.model}`,
          imei: device.imei,
        }))
      : [
          {
            name: `${order.device.brand} ${order.device.model}`,
            imei: order.device.imei,
          },
        ];
  const printInterventions = [
    ...order.items.map((item) => ({
      label: item.project,
      amount: money(cents(item.final)),
    })),
    ...(totals.inspectionTotal > 0
      ? [
          {
            label: italianMessages.inspectionFeeLabel,
            amount: money(totals.inspectionTotal),
          },
        ]
      : []),
    ...order.products.map((product) => ({
      label: `${product.productName} × ${product.quantity}`,
      amount: money(cents(product.unitPrice) * product.quantity),
    })),
    ...(totals.afterSalesTotal > 0
      ? [
          {
            label: italianMessages.afterSales.feeEvent,
            amount: money(totals.afterSalesTotal),
          },
        ]
      : []),
  ];
  const printView = (
    <ServiceOrderPrint
      code={orderCode(order.code)}
      acceptedAt={dateTime(order.createdAt)}
      expectedAt={
        order.type === "QUICK_SERVICE"
          ? dateTimeLocal(order.expectedAt)
          : dateOnly(promisedDate(order))
      }
      customerName={order.customerName || order.device.customer.name}
      customerPhone={order.device.customer.phone}
      devices={printDevices}
      appearance={order.appearance || order.device.appearance}
      accessories={order.accessories || order.device.accessories}
      problem={[
        faultLabel(order.fault, "it"),
        order.faultNote,
        order.inspectionResult,
        order.notes,
      ].filter(Boolean)}
      interventions={printInterventions}
      discount={totals.discount > 0 ? money(totals.discount) : undefined}
      vat={order.includeVat ? money(totals.vat) : undefined}
      total={money(currentDue)}
      paid={money(received)}
      remaining={money(remaining)}
      paymentStatus={
        ["REFUNDED", "CANCELLED"].includes(order.status)
          ? italianMessages.status[order.status]
          : remaining === 0
            ? italianMessages.printOrder.settled
            : italianMessages.printOrder.outstanding
      }
      paymentMethods={[
        ...new Set(
          order.payments
            .filter((payment) => payment.kind !== "REFUND")
            .map((payment) => italianMessages.methods[payment.method]),
        ),
      ]}
    />
  );

  if (order.type === "QUICK_SERVICE")
    return (
      <>
        <BackButton href={backHref} label={it.nav.orders} />
        <PageHeader
          title={orderCode(order.code)}
          description={`${it.orderTypes.QUICK_SERVICE} · ${order.device.customer.name}`}
        />
        <div className="detail-status">
          <div className="detail-primary-actions">
            <DetailStatusControl
              id={id}
              type={order.type}
              status={order.status}
              customerName={order.customerName || order.device.customer.name}
              due={currentDue}
              paid={received}
              balance={remaining}
              afterSalesOpen={false}
            />
            {inspectionStageAction}
            <ServiceOrderActions
              id={id}
              code={order.code}
              status={order.status}
              blockedReason={deleteBlockedReason}
            />
          </div>
          <span>
            {it.created}: {dateTime(order.createdAt, locale)}
          </span>
          <span>
            {it.quickService.expectedAt}:{" "}
            {dateTimeLocal(order.expectedAt, locale)}
          </span>
        </div>
        <div className="detail-grid">
          <div className="stack">
            <section className="panel padded">
              <h2>{it.quickService.serviceItems}</h2>
              <div className="quick-service-detail-list">
                {order.items.map((item) => (
                  <div key={item.id}>
                    <span>
                      <strong>{item.project}</strong>
                      {item.quickService?.notes && (
                        <small>{item.quickService.notes}</small>
                      )}
                    </span>
                    <strong>{money(cents(item.final))}</strong>
                  </div>
                ))}
              </div>
              {order.notes && (
                <p className="quick-service-order-notes">{order.notes}</p>
              )}
            </section>
            <section className="panel padded">
              <h2>{it.quickService.selectDevices}</h2>
              <div className="quick-service-device-list">
                {order.relatedDevices.map(({ device }) => (
                  <div key={device.id}>
                    <strong>
                      {device.brand} {device.model}
                    </strong>
                    <small>{device.imei || "—"}</small>
                  </div>
                ))}
              </div>
            </section>
          </div>
          <div className="stack">
            <section className="panel padded balance-card">
              <span>{it.balance}</span>
              <strong>{money(remaining)}</strong>
              <div>
                <span>
                  {it.quickService.income}: {money(currentDue)}
                </span>
                <span>
                  {it.paid}: {money(received)}
                </span>
              </div>
            </section>
            {order.status === "READY" && (
              <section className="panel padded status-operation-card">
                <h2>{it.orderProducts.checkout}</h2>
                <WorkOrderCheckout
                  orderId={id}
                  due={currentDue}
                  paid={received}
                  remaining={remaining}
                  customerName={
                    order.customerName || order.device.customer.name
                  }
                />
              </section>
            )}
            <section className="panel padded payments-card">
              <h2>{it.payments}</h2>
              {order.payments.map((payment) => (
                <div className="payment-row" key={payment.id}>
                  <strong>{money(cents(payment.amount))}</strong>
                  <span>
                    {it.kinds[payment.kind]} · {it.methods[payment.method]}
                  </span>
                  <small>
                    {dateTime(payment.receivedAt, locale)} · {payment.actorName}
                  </small>
                </div>
              ))}
              {remaining > 0 &&
                !["COMPLETED", "CANCELLED"].includes(order.status) && (
                  <PaymentForm key={remaining} id={id} remaining={remaining} />
                )}
            </section>
          </div>
        </div>
        {printView}
      </>
    );

  const events: TimelineEvent[] = [];
  for (const audit of audits) {
    const context = auditContext(audit.context);
    if (audit.action === "ORDER_CREATED")
      events.push({
        id: audit.id,
        at: order.createdAt,
        title: it.actions.ORDER_CREATED,
        actor: audit.actorName,
      });
    if (audit.action === "INSPECTION_STARTED")
      events.push({
        id: audit.id,
        at: audit.createdAt,
        title: it.actions.INSPECTION_STARTED,
        actor: audit.actorName,
        detail: `${it.diagnosticFee}: ${money(cents(String(context.fee ?? "0")))}`,
      });
    if (audit.action === "INSPECTION_COMPLETED")
      events.push({
        id: audit.id,
        at: audit.createdAt,
        title: it.actions.INSPECTION_COMPLETED,
        actor: audit.actorName,
        detail: [
          Array.isArray(context.faults)
            ? context.faults
                .filter((fault) => typeof fault === "string")
                .join(", ")
            : context.result,
          context.faultNote,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    if (audit.action === "QUOTE_CREATED")
      events.push({
        id: audit.id,
        at: audit.createdAt,
        title: it.actions.QUOTE_CREATED,
        actor: audit.actorName,
      });
    if (audit.action === "AFTER_SALES_OPENED") {
      const projects = Array.isArray(context.projects)
        ? context.projects
            .map((entry) => {
              if (!entry || typeof entry !== "object") return null;
              const project = entry as Record<string, unknown>;
              const treatment =
                project.treatment === "WARRANTY"
                  ? it.afterSales.warrantyTreatment
                  : it.afterSales.paidTreatment;
              return `${String(project.project ?? "")} · ${treatment} · ${money(cents(String(project.fee ?? "0")))}`;
            })
            .filter(Boolean)
            .join("; ")
        : "";
      const treatment =
        context.treatment === "WARRANTY"
          ? it.afterSales.warrantyTreatment
          : it.afterSales.paidTreatment;
      const detail = [
        projects ||
          `${String(context.project ?? context.reason)} · ${treatment} · ${money(cents(String(context.fee ?? "0")))}`,
        context.notes ? `${it.afterSales.notes}: ${context.notes}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      events.push({
        id: audit.id,
        at: audit.createdAt,
        title: it.actions.AFTER_SALES_OPENED,
        actor: audit.actorName,
        detail,
      });
    }
    if (audit.action === "AFTER_SALES_PART_CHANGED")
      events.push({
        id: audit.id,
        at: audit.createdAt,
        title: it.actions.AFTER_SALES_PART_CHANGED,
        actor: audit.actorName,
        detail: context.productName
          ? `${context.productName} × ${context.quantity}`
          : it.noRequiredPart,
      });
    if (audit.action === "REFUND_ISSUED") {
      const originalMethods = Array.isArray(context.originalMethods)
        ? context.originalMethods
            .map((method) =>
              typeof method === "string" && method in it.methods
                ? it.methods[method as keyof typeof it.methods]
                : null,
            )
            .filter(Boolean)
            .join(", ")
        : "";
      events.push({
        id: audit.id,
        at: audit.createdAt,
        title: `${it.afterSales.refundEvent} ${money(cents(String(context.amount)))}`,
        actor: audit.actorName,
        detail: [
          context.method
            ? `${it.afterSales.refundMethod}: ${it.methods[context.method as keyof typeof it.methods]}`
            : null,
          originalMethods
            ? `${it.afterSales.originalMethod}: ${originalMethods}`
            : null,
          context.reason,
        ]
          .filter(Boolean)
          .join(" · "),
      });
      events.push({
        id: `${audit.id}:status`,
        at: new Date(audit.createdAt.getTime() + 1),
        title: `${it.actions.STATUS_CHANGED}: ${it.status.REFUNDED}`,
        actor: audit.actorName,
      });
    }
    if (audit.action === "STATUS_CHANGED" && context.to === "CANCELLED")
      events.push({
        id: audit.id,
        at: audit.createdAt,
        title: `${it.actions.STATUS_CHANGED}: ${it.status.CANCELLED}`,
        actor: audit.actorName,
        detail: [
          `${it.total}: ${money(cents(String(context.originalDue ?? "0")))}`,
          `${it.paid}: ${money(cents(String(context.originalReceived ?? "0")))}`,
          context.reason,
        ]
          .filter(Boolean)
          .join(" · "),
      });
  }
  for (const history of order.history) {
    if (
      !history.from ||
      history.to === "REWORKING" ||
      history.to === "REFUNDED" ||
      history.to === "CANCELLED"
    )
      continue;
    events.push({
      id: history.id,
      at: history.createdAt,
      title:
        history.to === "COMPLETED"
          ? it.actions.ORDER_DELIVERED
          : `${it.actions.STATUS_CHANGED}: ${it.status[history.to]}`,
      actor: history.actorName,
      detail: history.note,
    });
  }
  for (const payment of order.payments) {
    if (payment.kind === "REFUND") continue;
    events.push({
      id: payment.id,
      at: payment.receivedAt,
      title: `${
        payment.kind === "AFTER_SALES"
          ? it.afterSales.paymentEvent
          : it.actions.PAYMENT_ADDED
      } ${money(cents(payment.amount))}`,
      actor: payment.actorName,
      detail: it.methods[payment.method],
    });
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  const latestEvent = events.at(-1);

  return (
    <>
      <BackButton href={backHref} label={it.nav.orders} />
      <PageHeader
        title={orderCode(order.code)}
        description={`${order.device.brand} ${order.device.model} · ${order.device.customer.name}`}
      />
      <div className="detail-status">
        <div className="detail-primary-actions">
          <DetailStatusControl
            id={id}
            type={order.type}
            status={order.status}
            customerName={order.customerName || order.device.customer.name}
            due={currentDue}
            paid={received}
            balance={remaining}
            afterSalesOpen={order.afterSalesOpen}
          />
          {inspectionStageAction}
          {order.status === "PARTS_MISSING" && (
            <a
              className={`button button-primary stage-primary-action status-action-trigger status-${order.status.toLowerCase()}`}
              href={order.afterSalesOpen ? "#warranty" : "#required-parts"}
            >
              <span className="status-dropdown-dot" aria-hidden="true" />
              {it.stageActions.viewMissingParts}
            </a>
          )}
          <ServiceOrderActions
            id={id}
            code={order.code}
            status={order.status}
            blockedReason={deleteBlockedReason}
          />
        </div>
        <span>
          {it.created}: {dateTime(order.createdAt, locale)}
        </span>
        <span>
          {it.dueDate}: {dateOnly(promisedDate(order), locale)}
        </span>
      </div>
      {order.status === "COMPLETED" && (
        <p className="order-lock-notice">{it.lockedDelivered}</p>
      )}
      {order.status === "REFUNDED" && (
        <p className="order-lock-notice refunded">{it.lockedRefunded}</p>
      )}
      {order.status === "CANCELLED" && (
        <p className="order-lock-notice">{it.lockedCancelled}</p>
      )}
      <div className="detail-grid">
        <div className="stack">
          <OrderDetailCard
            key={`details-${order.afterSalesOpen}-${order.status}`}
            title={it.details}
            locked={originalLocked}
            defaultExpanded={!order.afterSalesOpen}
            summary={`${order.device.customer.name} · ${order.device.brand} ${order.device.model} · ${order.status === "DIAGNOSING" ? it.inspectionPending : faultLabel(order.fault, locale)}`}
            testId="details-card"
            edit={
              <EditOrderForm
                id={id}
                customers={customers}
                faultOptions={faultOptions.map(({ _count, ...fault }) => ({
                  ...fault,
                  usageCount: _count.orders,
                }))}
                values={{
                  customerId: order.device.customerId,
                  category: order.device.category,
                  fault: order.fault,
                  faultNote: order.faultNote,
                  standardFaultIds: order.faults
                    .filter((fault) => !fault.custom)
                    .flatMap((fault) =>
                      fault.catalogId ? [fault.catalogId] : [],
                    ),
                  notes: order.notes,
                  accessories: order.accessories,
                  dueDate: order.dueDate,
                }}
              />
            }
            persistent={
              order.status !== "DIAGNOSING" ? (
                <WorkOrderRepairSummary
                  orderId={id}
                  locked={originalLocked}
                  protectPriceOnOptionSwitch={
                    !!order.confirmedAt || receivedTotal > 0
                  }
                  initialDiscount={order.orderDiscount.toString()}
                  initialVat={order.includeVat}
                  inspectionFee={order.inspectionFee.toString()}
                  owner={actor.role === "OWNER"}
                  device={{
                    category: order.device.category,
                    brand: order.device.brand,
                    series: order.device.series,
                    model: order.device.model,
                  }}
                  items={order.items.map((item) => ({
                    project: item.project,
                    final: item.final.toString(),
                    discount: item.discount.toString(),
                    adjustmentReason: item.adjustmentReason,
                    priceOptionId: item.priceOptionId ?? "",
                    priceOptionName: item.priceOptionName,
                    suggested: item.suggested?.toString(),
                    requiredProductId: item.requiredProductId ?? "",
                    requiredQuantity: item.requiredQuantity,
                    source: `${it.levels[item.matchLevel as keyof typeof it.levels]} · ${order.device.brand} ${order.device.model}`,
                    requiredProduct: item.requiredProduct
                      ? {
                          id: item.requiredProduct.id,
                          name: item.requiredProduct.name,
                          category: item.requiredProduct.category,
                          stock: item.requiredProduct.stockQuantity,
                          reserved:
                            reservedByProduct.get(item.requiredProduct.id) ?? 0,
                          available: Math.max(
                            0,
                            item.requiredProduct.stockQuantity -
                              (reservedByProduct.get(item.requiredProduct.id) ??
                                0),
                          ),
                        }
                      : null,
                  }))}
                  rules={ruleViews}
                  products={repairProducts.map((product) => ({
                    id: product.id,
                    name: product.name,
                    category: product.category,
                    stock: product.stockQuantity,
                    reserved: reservedByProduct.get(product.id) ?? 0,
                    available: Math.max(
                      0,
                      product.stockQuantity -
                        (reservedByProduct.get(product.id) ?? 0),
                    ),
                  }))}
                  productCategories={productCategories}
                />
              ) : null
            }
          >
            <dl className="detail-list">
              <div>
                <dt>{it.customer}</dt>
                <dd>
                  <CustomerDetailLink
                    href={`/customers/${order.device.customerId}`}
                    name={order.device.customer.name}
                  />
                </dd>
              </div>
              <div>
                <dt>{it.phone}</dt>
                <dd>
                  <a href={`tel:${order.device.customer.phone}`}>
                    {order.device.customer.phone}
                  </a>
                </dd>
              </div>
              <div>
                <dt>{it.fault}</dt>
                <dd>
                  {order.status === "DIAGNOSING"
                    ? it.inspectionPending
                    : faultLabel(order.fault, locale)}
                </dd>
              </div>
              {order.faultNote && (
                <div>
                  <dt>{it.faultNotes}</dt>
                  <dd>{order.faultNote}</dd>
                </div>
              )}
              {order.inspectionResult && (
                <div>
                  <dt>{it.inspectionResult}</dt>
                  <dd>{order.inspectionResult}</dd>
                </div>
              )}
              <div>
                <dt>{it.dueDate}</dt>
                <dd>{dateOnly(promisedDate(order), locale)}</dd>
              </div>
              <div>
                <dt>{it.notes}</dt>
                <dd>{order.notes || "—"}</dd>
              </div>
            </dl>
            {order.pickedUpAt && (
              <p className="message success">
                {it.delivered}: {order.pickedUpBy} ·{" "}
                {dateTime(order.pickedUpAt, locale)}
              </p>
            )}
          </OrderDetailCard>

          <WorkOrderProducts
            key={`products-${order.afterSalesOpen}-${order.status}`}
            orderId={id}
            closed={originalLocked}
            defaultExpanded={false}
            products={products.map((product) => ({
              id: product.id,
              name: product.name,
              category: product.category,
              usage: product.usage,
              salePrice: product.salePrice.toString(),
              stock: product.stockQuantity,
              reserved: reservedByProduct.get(product.id) ?? 0,
              available: Math.max(
                0,
                product.stockQuantity -
                  (reservedByProduct.get(product.id) ?? 0),
              ),
            }))}
            lines={order.products.map((line) => ({
              id: line.id,
              productId: line.productId,
              productName: line.productName,
              kind: line.kind,
              unitPrice: line.unitPrice.toString(),
              quantity: line.quantity,
              consumedAt: line.consumedAt?.toISOString() ?? null,
            }))}
          />

          <OrderDetailCard
            key={`quote-${order.afterSalesOpen}-${order.status}`}
            title={
              order.status === "DIAGNOSING" ? it.inspectionAndQuote : it.quote
            }
            locked={originalLocked || order.status === "DIAGNOSING"}
            defaultExpanded={!order.afterSalesOpen}
            summary={
              order.inspectionMode
                ? `${it.inspectionFeeLabel} · ${money(totals.inspectionTotal)}`
                : `${order.items.map((item) => item.project).join(" · ")} · ${money(totals.due)}`
            }
            testId="quote-card"
            edit={
              order.status !== "DIAGNOSING" ? (
                <EditQuoteForm
                  key={order.updatedAt.toISOString()}
                  mode="totals"
                  id={id}
                  initialDiscount={order.orderDiscount.toString()}
                  initialVat={order.includeVat}
                  inspectionFee={order.inspectionFee.toString()}
                  initial={order.items.map((item) => ({
                    project: item.project,
                    final: item.final.toString(),
                    discount: item.discount.toString(),
                    adjustmentReason: item.adjustmentReason,
                    priceOptionId: item.priceOptionId ?? "",
                    requiredProductId: item.requiredProductId ?? "",
                    requiredQuantity: item.requiredQuantity,
                  }))}
                  device={{
                    category: order.device.category,
                    brand: order.device.brand,
                    series: order.device.series,
                    model: order.device.model,
                  }}
                  owner={actor.role === "OWNER"}
                  rules={ruleViews}
                  products={repairProducts.map((product) => ({
                    id: product.id,
                    name: product.name,
                    category: product.category,
                    stock: product.stockQuantity,
                    reserved: reservedByProduct.get(product.id) ?? 0,
                    available: Math.max(
                      0,
                      product.stockQuantity -
                        (reservedByProduct.get(product.id) ?? 0),
                    ),
                  }))}
                  productCategories={productCategories}
                />
              ) : undefined
            }
          >
            {order.status === "DIAGNOSING" ? (
              <div className="inspection-detail">
                <div className="inspection-banner">
                  <span aria-hidden="true">⌕</span>
                  <div>
                    <strong>{it.inspectionInProgress}</strong>
                    <p>{it.inspectionDetailHelp}</p>
                  </div>
                </div>
                <dl className="quote-summary">
                  <div>
                    <dt>{it.inspectionFeeNet}</dt>
                    <dd>{money(cents(order.inspectionFee))}</dd>
                  </div>
                  <div>
                    <dt>{it.vatAmount}</dt>
                    <dd>{money(totals.vat)}</dd>
                  </div>
                  <div>
                    <dt>{it.includeVat}</dt>
                    <dd>{order.includeVat ? it.yes : it.no}</dd>
                  </div>
                  <div>
                    <dt>{it.total}</dt>
                    <dd>{money(totals.due)}</dd>
                  </div>
                </dl>
              </div>
            ) : (
              <>
                {cents(order.inspectionFee) > 0 && (
                  <p className="inspection-fee-line">
                    <span>{it.inspectionFeeNet}</span>
                    <strong>{money(cents(order.inspectionFee))}</strong>
                  </p>
                )}
                <QuoteSummary
                  items={order.items.map((item) => ({
                    final: item.final.toString(),
                    discount: item.discount.toString(),
                  }))}
                  orderDiscount={order.orderDiscount.toString()}
                  includeVat={order.includeVat}
                  inspectionFee={order.inspectionFee.toString()}
                />
              </>
            )}
          </OrderDetailCard>

          <OrderDetailCard
            key={`warranty-${order.afterSalesOpen}`}
            title={it.warranty.title}
            locked={originalLocked}
            defaultExpanded={order.afterSalesOpen}
            summary={order.items
              .map((item) => {
                const warranty = itemWarranties.get(item.id);
                const status = !warranty
                  ? it.warranty.none
                  : warranty.active
                    ? it.warranty.active
                    : it.warranty.expired;
                return `${item.project} · ${status}`;
              })
              .join(" · ")}
            testId="warranty-card"
            id="warranty"
            edit={
              <WarrantyForm
                id={id}
                items={order.items.map((item) => ({
                  id: item.id,
                  project: item.project,
                  days: item.warrantyDays,
                  notes: item.warrantyNotes,
                }))}
              />
            }
          >
            <div className="project-warranty-list">
              {order.items.map((item) => {
                const activeRework = order.reworks
                  .find((session) => session.open)
                  ?.items.find((entry) => entry.originalItemId === item.id);
                return (
                  <section key={item.id}>
                    <strong>{item.project}</strong>
                    <WarrantyProgressPanel
                      warranty={itemWarranties.get(item.id) ?? null}
                      days={item.warrantyDays}
                    />
                    {item.warrantyNotes && <p>{item.warrantyNotes}</p>}
                    {activeRework && (
                      <div className="active-rework-summary">
                        <Badge status="REWORKING" />
                        <p>
                          {activeRework.treatment === "WARRANTY"
                            ? it.afterSales.warrantyTreatment
                            : `${it.afterSales.paidTreatment} · ${money(cents(activeRework.fee))}`}
                        </p>
                        <strong>{it.requiredPart}</strong>
                        <ReworkPartEditor
                          orderId={id}
                          itemId={activeRework.id}
                          value={activeRework.requiredProductId ?? ""}
                          products={repairProducts.map((product) => ({
                            id: product.id,
                            name: product.name,
                            category: product.category,
                            stock: product.stockQuantity,
                            reserved: reservedByProduct.get(product.id) ?? 0,
                            available: Math.max(
                              0,
                              product.stockQuantity -
                                (reservedByProduct.get(product.id) ?? 0),
                            ),
                          }))}
                          productCategories={productCategories}
                          device={{
                            category: order.device.category,
                            brand: order.device.brand,
                            model: order.device.model,
                          }}
                          project={item.project}
                          options={
                            matchRule(ruleViews, order.device, item.project)
                              ?.rule.options
                          }
                          rule={
                            matchRule(ruleViews, order.device, item.project)
                              ?.rule
                          }
                        />
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </OrderDetailCard>

          <OrderDetailCard
            key={`history-${order.afterSalesOpen}`}
            title={it.history}
            locked
            defaultExpanded={false}
            summary={
              latestEvent
                ? `${latestEvent.title}${latestEvent.detail ? ` · ${latestEvent.detail}` : ""}`
                : it.history
            }
            className="history-card"
            testId="history-card"
          >
            <ol className="timeline">
              {events.map((event) => (
                <li key={event.id}>
                  <span className="timeline-dot" />
                  <strong>{event.title}</strong>
                  <small>
                    {dateTime(event.at, locale)} · {event.actor}
                  </small>
                  {event.detail && <p>{event.detail}</p>}
                </li>
              ))}
            </ol>
          </OrderDetailCard>
        </div>

        <div className="stack">
          <section className="panel padded balance-card">
            <span>{it.balance}</span>
            <strong>{money(remaining)}</strong>
            <div>
              <span>
                {it.orderProducts.repairAmount}: {money(repairAmount)}
              </span>
              {totals.inspectionTotal > 0 && (
                <span>
                  {it.inspectionFeeLabel}: {money(totals.inspectionTotal)}
                </span>
              )}
              <span>
                {it.orderProducts.retailAddons}: {money(productAmount)}
              </span>
              {afterSalesAmount > 0 && (
                <span>
                  {it.afterSales.feeEvent}: {money(afterSalesAmount)}
                </span>
              )}
              <span>
                {it.total}: {money(currentDue)}
              </span>
              <span>
                {it.paid}: {money(received)}
              </span>
            </div>
          </section>

          {order.status === "READY" && (
            <section className="panel padded status-operation-card">
              <h2>{it.orderProducts.checkout}</h2>
              <WorkOrderCheckout
                orderId={id}
                due={currentDue}
                paid={received}
                remaining={remaining}
                customerName={order.customerName || order.device.customer.name}
              />
            </section>
          )}

          {["COMPLETED", "REFUNDED"].includes(order.status) && (
            <section className="panel padded current-status-card">
              <h2>{it.currentStatus}</h2>
              <Badge status={order.status} />
              {order.pickedUpAt && <p>{dateTime(order.pickedUpAt, locale)}</p>}
            </section>
          )}

          <section className="panel padded payments-card">
            <h2>{it.payments}</h2>
            {order.payments.length ? (
              order.payments.map((payment) => (
                <div
                  className={`payment-row ${payment.kind === "REFUND" ? "is-refund" : ""}`}
                  key={payment.id}
                >
                  <strong>{money(cents(payment.amount))}</strong>
                  <span>
                    {it.kinds[payment.kind]} · {it.methods[payment.method]}
                  </span>
                  <small>
                    {dateTime(payment.receivedAt, locale)} · {payment.actorName}
                  </small>
                </div>
              ))
            ) : (
              <p className="muted">{it.noPayments}</p>
            )}
            {remaining > 0 &&
              !["COMPLETED", "REFUNDED", "CANCELLED"].includes(
                order.status,
              ) && (
                <PaymentForm key={remaining} id={id} remaining={remaining} />
              )}
          </section>

          {order.status === "COMPLETED" && (
            <AfterSalesActions
              orderId={id}
              received={receivedTotal}
              originalProjects={order.items.map((item) => ({
                id: item.id,
                name: item.project,
                price: money(cents(item.final)),
                warranty: itemWarranties.get(item.id) ?? null,
                warrantyDays: item.warrantyDays,
                reworked: Boolean(item.reworkItem),
                requiredProductId: item.requiredProductId ?? undefined,
                requiredQuantity: item.requiredQuantity,
              }))}
              products={repairProducts.map((product) => ({
                id: product.id,
                name: product.name,
                category: product.category,
                stock: product.stockQuantity,
                reserved: reservedByProduct.get(product.id) ?? 0,
                available: Math.max(
                  0,
                  product.stockQuantity -
                    (reservedByProduct.get(product.id) ?? 0),
                ),
              }))}
              productCategories={productCategories}
              device={{
                category: order.device.category,
                brand: order.device.brand,
                series: order.device.series,
                model: order.device.model,
              }}
              rules={ruleViews}
            />
          )}
        </div>
      </div>
      {printView}
    </>
  );
}
