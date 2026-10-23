"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { setPaidTotalAction } from "@/app/actions";
import { dateOnly, decimal, money, type OrderStatus } from "@/lib/domain";
import { translateError } from "@/lib/i18n";
import {
  defaultOrderMotionSettings,
  normalizeOrderMotionSettings,
  orderMotionChangeEvent,
  orderViewportFollowChangeEvent,
  readOrderMotionSettings,
  readOrderViewportFollow,
} from "@/lib/order-motion";
import { useBusinessDay } from "./business-date";
import { useMessages } from "./language";
import {
  StatusDropdown,
  type PrimaryStatusAction,
  type StatusDropdownOrder,
} from "./status-dropdown";
import { FormDialog, PaymentForm } from "./forms";
import { DatePicker } from "./business-select";
import { Button } from "./ui/button";

export type OrderListRow = {
  id: string;
  code: string;
  customerId: string;
  customerName: string;
  brand: string;
  model: string;
  projects: string;
  status: OrderStatus;
  dueDate: string;
  expectedAt: string;
  overdue: boolean;
  lastUpdated: string;
  due: number;
  paid: number;
  balance: number;
  afterSalesOpen: boolean;
  type: "REPAIR" | "QUICK_SERVICE";
};

function StatusControl({
  row,
  active,
  onSettled,
  refreshOnSettled,
  primaryAction,
}: {
  row: Pick<
    OrderListRow,
    | "id"
    | "status"
    | "customerName"
    | "due"
    | "paid"
    | "balance"
    | "afterSalesOpen"
    | "type"
  >;
  active: boolean;
  onSettled?: (order: StatusDropdownOrder) => void;
  refreshOnSettled?: boolean;
  primaryAction?: PrimaryStatusAction;
}) {
  return (
    <StatusDropdown
      key={`${row.status}:${row.due}:${row.paid}:${row.balance}`}
      order={row}
      active={active}
      onSettled={onSettled}
      refreshOnSettled={refreshOnSettled}
      primaryAction={primaryAction}
    />
  );
}

export function DetailStatusControl({
  id,
  status,
  customerName,
  due,
  paid,
  balance,
  afterSalesOpen,
  type,
  primaryAction,
}: Pick<
  OrderListRow,
  | "id"
  | "status"
  | "customerName"
  | "due"
  | "paid"
  | "balance"
  | "afterSalesOpen"
  | "type"
> & { primaryAction?: PrimaryStatusAction }) {
  return (
    <div className="detail-status-control">
      <StatusControl
        row={{
          id,
          status,
          customerName,
          due,
          paid,
          balance,
          afterSalesOpen,
          type,
        }}
        active
        primaryAction={primaryAction}
      />
    </div>
  );
}

function DueDateControl({ row }: { row: OrderListRow }) {
  const it = useMessages();
  return (
    <div className="order-static-value">
      <span>
        {row.type === "QUICK_SERVICE"
          ? row.expectedAt.replace("T", " ") || dateOnly(row.dueDate || null)
          : dateOnly(row.dueDate || null)}
      </span>
      {row.overdue && <small>{it.overdue}</small>}
    </div>
  );
}

function PaymentControl({
  row,
  active,
}: {
  row: OrderListRow;
  active: boolean;
}) {
  const it = useMessages();
  const router = useRouter();
  const [value, setValue] = useState(decimal(row.paid));
  const [method, setMethod] = useState<"" | "CASH" | "CARD" | "OTHER">("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const closed = ["COMPLETED", "REFUNDED", "CANCELLED"].includes(row.status);
  const parsed = Number(value.replace(",", "."));
  const changed =
    !Number.isFinite(parsed) || Math.round(parsed * 100) !== row.paid;
  function save() {
    if (!changed) return;
    if (!method || !adjustmentReason.trim()) {
      setError(it.paymentAdjustmentDetailsRequired);
      return;
    }
    startTransition(async () => {
      const result = await setPaidTotalAction(row.id, {
        requestId: crypto.randomUUID(),
        amount: value,
        method,
        adjustmentReason,
      });
      if (!result.ok) return setError(result.error);
      setError("");
      router.refresh();
    });
  }
  const mayCollect = active && !closed && row.balance > 0;
  const mayCorrect = active && !closed && !row.afterSalesOpen;
  return (
    <div className="order-payment-values">
      <span>
        <small>{it.total}</small>
        <strong>{money(row.due)}</strong>
      </span>
      <span>
        <small>{it.paid}</small>
        {correcting && mayCorrect ? (
          <input
            aria-label={it.paid}
            value={value}
            inputMode="decimal"
            disabled={pending}
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
            }}
          />
        ) : (
          <strong>{money(row.paid)}</strong>
        )}
      </span>
      <span className="order-balance-value">
        <small>{it.balance}</small>
        <strong>{money(row.balance)}</strong>
      </span>
      {mayCollect && (
        <Button
          type="button"
          variant="outline"
          className="order-payment-action"
          onClick={(event) => {
            event.stopPropagation();
            setCollecting(true);
          }}
        >
          {it.addPayment}
        </Button>
      )}
      {mayCorrect && !correcting && (
        <button
          type="button"
          className="order-payment-correction-toggle"
          onClick={(event) => {
            event.stopPropagation();
            setValue(decimal(row.paid));
            setCorrecting(true);
            setError("");
          }}
        >
          {it.paymentCorrection}
        </button>
      )}
      {correcting && mayCorrect && (
        <>
          <div className="order-payment-adjustment">
            <label>
              <span className="sr-only">{it.paymentMethod}</span>
              <select
                aria-label={it.paymentMethod}
                value={method}
                disabled={pending}
                onChange={(event) => {
                  setMethod(event.target.value as typeof method);
                  setError("");
                }}
              >
                <option value="">{it.choosePaymentMethod}</option>
                <option value="CASH">{it.cash}</option>
                <option value="CARD">{it.card}</option>
                <option value="OTHER">{it.otherPaymentMethod}</option>
              </select>
            </label>
            <label>
              <span className="sr-only">{it.paymentAdjustmentReason}</span>
              <input
                aria-label={it.paymentAdjustmentReason}
                value={adjustmentReason}
                placeholder={it.paymentAdjustmentReason}
                disabled={pending}
                onChange={(event) => {
                  setAdjustmentReason(event.target.value);
                  setError("");
                }}
              />
            </label>
          </div>
          <div className="order-payment-correction-actions">
            <Button
              type="button"
              variant="cancel"
              disabled={pending}
              onClick={() => {
                setValue(decimal(row.paid));
                setCorrecting(false);
                setError("");
              }}
            >
              {it.cancel}
            </Button>
            <Button type="button" disabled={pending || !changed} onClick={save}>
              {pending ? it.saving : it.save}
            </Button>
          </div>
        </>
      )}
      {error && <small className="inline-control-error">{error}</small>}
      {collecting && (
        <FormDialog title={it.addPayment} onClose={() => setCollecting(false)}>
          <PaymentForm id={row.id} remaining={row.balance} />
        </FormDialog>
      )}
    </div>
  );
}

export function OrderListBody({
  rows,
  hideCustomer = false,
  compact = false,
  returnTo = "/orders",
}: {
  rows: OrderListRow[];
  hideCustomer?: boolean;
  compact?: boolean;
  returnTo?: string;
}) {
  const it = useMessages();
  const [activeId, setActiveId] = useState("");
  const [settledRows, setSettledRows] = useState<
    Record<string, { before: StatusDropdownOrder; after: StatusDropdownOrder }>
  >({});
  const [highlightedId, setHighlightedId] = useState("");
  const [suppressedHoverId, setSuppressedHoverId] = useState("");
  const body = useRef<HTMLTableSectionElement>(null);
  const pendingStatusAnimation = useRef("");
  const previousRowPositions = useRef(new Map<string, DOMRect>());
  const motionScrollStart = useRef<{ x: number; y: number } | null>(null);
  const motionScrollFrame = useRef<number | null>(null);
  const floatingRow = useRef<HTMLTableElement | null>(null);
  const landingTimer = useRef<number | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const motionSettings = useRef(defaultOrderMotionSettings);
  const followViewport = useRef(true);
  useEffect(() => {
    function outside(event: PointerEvent) {
      const protectedTarget = (event.target as Element).closest?.(
        "[data-prevent-card-autosave]",
      );
      if (
        protectedTarget &&
        (protectedTarget.tagName !== "DIALOG" ||
          !protectedTarget.contains(body.current))
      )
        return;
      if (!body.current?.contains(event.target as Node))
        requestAnimationFrame(() => setActiveId(""));
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useEffect(() => {
    motionSettings.current = readOrderMotionSettings();
    followViewport.current = readOrderViewportFollow();
    function update(event: Event) {
      motionSettings.current = normalizeOrderMotionSettings(
        (event as CustomEvent).detail,
      );
    }
    function updateViewportFollow(event: Event) {
      followViewport.current = Boolean((event as CustomEvent).detail);
    }
    window.addEventListener(orderMotionChangeEvent, update);
    window.addEventListener(
      orderViewportFollowChangeEvent,
      updateViewportFollow,
    );
    return () => {
      window.removeEventListener(orderMotionChangeEvent, update);
      window.removeEventListener(
        orderViewportFollowChangeEvent,
        updateViewportFollow,
      );
    };
  }, []);
  useEffect(
    () => () => {
      if (landingTimer.current) window.clearTimeout(landingTimer.current);
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
      if (motionScrollFrame.current)
        window.cancelAnimationFrame(motionScrollFrame.current);
      floatingRow.current?.remove();
    },
    [],
  );
  useLayoutEffect(() => {
    const changedId = pendingStatusAnimation.current;
    if (!changedId || !body.current) return;
    const elements = Array.from(
      body.current.querySelectorAll<HTMLTableRowElement>("tr[data-order-id]"),
    );
    const target = elements.find(
      (element) => element.dataset.orderId === changedId,
    );
    pendingStatusAnimation.current = "";
    if (!target) return;
    const motion = motionSettings.current;
    const total = motion.rise + motion.hold + motion.glide + motion.land;
    const travelDuration = motion.rise + motion.hold + motion.glide;
    const liftOffset = motion.rise / total;
    const holdOffset = (motion.rise + motion.hold) / total;
    const glideOffset = travelDuration / total;
    const displacedHoldOffset = (motion.rise + motion.hold) / travelDuration;
    const previousTarget = previousRowPositions.current.get(changedId);
    const scrollStart = motionScrollStart.current ?? {
      x: window.scrollX,
      y: window.scrollY,
    };
    if (motionScrollFrame.current) {
      window.cancelAnimationFrame(motionScrollFrame.current);
      motionScrollFrame.current = null;
    }
    window.scrollTo({
      left: scrollStart.x,
      top: scrollStart.y,
      behavior: "auto",
    });
    const currentTarget = target.getBoundingClientRect();
    const targetDocumentTop = currentTarget.top + scrollStart.y;
    const desiredTargetTop = previousTarget
      ? Math.min(Math.max(96, previousTarget.top), window.innerHeight * 0.38)
      : currentTarget.top;
    const maximumScroll = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight,
    );
    const targetScrollY =
      followViewport.current &&
      (currentTarget.top < 64 || currentTarget.bottom > window.innerHeight - 64)
        ? Math.min(
            maximumScroll,
            Math.max(0, targetDocumentTop - desiredTargetTop),
          )
        : scrollStart.y;
    const finalTargetTop = targetDocumentTop - targetScrollY;
    const targetDelta = previousTarget
      ? finalTargetTop - previousTarget.top
      : 0;
    const layoutDelta = previousTarget
      ? currentTarget.top - previousTarget.top
      : 0;
    if (previousTarget && Math.abs(layoutDelta) < 1) return;
    target.classList.add("order-row-status-moving");
    if (previousTarget && Math.abs(layoutDelta) >= 1) {
      floatingRow.current?.remove();
      const table = document.createElement("table");
      const floatingBody = document.createElement("tbody");
      const clone = target.cloneNode(true) as HTMLTableRowElement;
      const sourceCells = Array.from(
        target.querySelectorAll<HTMLTableCellElement>("td"),
      );
      const clonedCells = Array.from(
        clone.querySelectorAll<HTMLTableCellElement>("td"),
      );
      clone.removeAttribute("data-order-id");
      clone.classList.add("order-row-floating");
      clone
        .querySelectorAll<HTMLElement>("[id]")
        .forEach((element) => element.removeAttribute("id"));
      clone
        .querySelectorAll<HTMLAnchorElement>("a[href]")
        .forEach((element) => element.removeAttribute("href"));
      clonedCells.forEach((cell, index) => {
        const width = sourceCells[index]?.getBoundingClientRect().width;
        if (width) cell.style.width = `${width}px`;
      });
      floatingBody.className = "order-list-body";
      floatingBody.append(clone);
      table.className = "order-table order-floating-table";
      table.setAttribute("aria-hidden", "true");
      table.dataset.floatingOrderId = changedId;
      Object.assign(table.style, {
        top: `${previousTarget.top}px`,
        left: `${previousTarget.left}px`,
        width: `${previousTarget.width}px`,
        height: `${currentTarget.height}px`,
      });
      table.append(floatingBody);
      document.body.append(table);
      floatingRow.current = table;
      target.classList.add("order-row-floating-placeholder");

      const restingShadow = "0 2px 5px -3px rgb(74 54 0 / 20%)";
      const floatingShadow = `0 ${motion.shadowY}px ${motion.shadowBlur}px ${motion.shadowSpread}px rgb(74 54 0 / ${motion.shadowOpacity}%)`;
      const landedShadow = "0 0 0 0 rgb(74 54 0 / 0%)";
      table.animate(
        [
          {
            transform: "translateY(0) scale(1)",
            boxShadow: restingShadow,
            offset: 0,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          },
          {
            transform: `translateY(-${motion.lift}px) scale(1)`,
            boxShadow: floatingShadow,
            offset: liftOffset,
            easing: "linear",
          },
          {
            transform: `translateY(-${motion.lift}px) scale(1)`,
            boxShadow: floatingShadow,
            offset: holdOffset,
            easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
          },
          {
            transform: `translateY(${targetDelta - motion.lift}px) scale(1)`,
            boxShadow: floatingShadow,
            offset: glideOffset,
            easing: "cubic-bezier(0.4, 0, 0.2, 1)",
          },
          {
            transform: `translateY(${targetDelta}px) scale(1)`,
            boxShadow: landedShadow,
            offset: 1,
          },
        ],
        { duration: total, easing: "linear", fill: "both" },
      );
      clonedCells.forEach((cell, index) => {
        const floatingEdge =
          index === 0 ? "inset 4px 0 #d7aa00" : "inset 0 0 transparent";
        const landedEdge =
          index === 0 ? "inset 3px 0 #d7aa00" : "inset 0 0 transparent";
        cell.animate(
          [
            {
              backgroundColor: "#fff8dc",
              boxShadow: floatingEdge,
              offset: 0,
            },
            {
              backgroundColor: "#fff1b2",
              boxShadow: floatingEdge,
              offset: liftOffset,
            },
            {
              backgroundColor: "#fff1b2",
              boxShadow: floatingEdge,
              offset: holdOffset,
            },
            {
              backgroundColor: "#fff1b2",
              boxShadow: floatingEdge,
              offset: glideOffset,
              easing: "cubic-bezier(0.4, 0, 0.2, 1)",
            },
            {
              backgroundColor: "#fff5ca",
              boxShadow: landedEdge,
              offset: 1,
            },
          ],
          { duration: total, easing: "linear", fill: "both" },
        );
      });
      if (Math.abs(targetScrollY - scrollStart.y) >= 1) {
        const glideStartsAt = performance.now() + motion.rise + motion.hold;
        const scrollDistance = targetScrollY - scrollStart.y;
        const follow = (now: number) => {
          if (now < glideStartsAt) {
            motionScrollFrame.current = window.requestAnimationFrame(follow);
            return;
          }
          const progress = Math.min(
            1,
            Math.max(0, (now - glideStartsAt) / motion.glide),
          );
          const eased = 1 - Math.pow(1 - progress, 3);
          window.scrollTo({
            left: scrollStart.x,
            top: scrollStart.y + scrollDistance * eased,
            behavior: "auto",
          });
          if (progress < 1)
            motionScrollFrame.current = window.requestAnimationFrame(follow);
          else motionScrollFrame.current = null;
        };
        motionScrollFrame.current = window.requestAnimationFrame(follow);
      }
    }
    elements.forEach((element) => {
      const previous = previousRowPositions.current.get(
        element.dataset.orderId ?? "",
      );
      if (!previous) return;
      const delta = previous.top - element.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) return;
      const changed = element === target;
      if (changed && floatingRow.current) return;
      const cells = Array.from(
        element.querySelectorAll<HTMLTableCellElement>("td"),
      );
      cells.forEach((cell, index) => {
        const edgeShadow =
          index === 0
            ? "inset 4px 0 #d7aa00"
            : index === cells.length - 1
              ? "inset -1px 0 rgb(215 170 0 / 28%)"
              : "inset 0 0 transparent";
        const restingShadow = `${edgeShadow}, inset 0 1px rgb(255 255 255 / 62%), 0 2px 4px -3px rgb(74 54 0 / 18%)`;
        const floatingShadow = `${edgeShadow}, inset 0 2px rgb(255 255 255 / 78%), inset 0 -1px rgb(174 128 0 / 18%), 0 ${motion.shadowY}px ${motion.shadowBlur}px ${motion.shadowSpread}px rgb(74 54 0 / ${motion.shadowOpacity}%)`;
        cell.animate(
          changed
            ? [
                {
                  transform: `translateY(${delta}px)`,
                  backgroundColor: "#fff8dc",
                  boxShadow: restingShadow,
                  offset: 0,
                },
                {
                  transform: `translateY(${delta - motion.lift}px)`,
                  backgroundColor: "#fff1b2",
                  boxShadow: floatingShadow,
                  offset: liftOffset,
                },
                {
                  transform: `translateY(${delta - motion.lift}px)`,
                  backgroundColor: "#fff1b2",
                  boxShadow: floatingShadow,
                  offset: holdOffset,
                },
                {
                  transform: `translateY(-${motion.lift}px)`,
                  backgroundColor: "#fff1b2",
                  boxShadow: floatingShadow,
                  offset: glideOffset,
                },
                {
                  transform: "translateY(0)",
                  backgroundColor: "#fff5ca",
                  boxShadow: restingShadow,
                  offset: 1,
                },
              ]
            : [
                { transform: `translateY(${delta}px)`, offset: 0 },
                {
                  transform: `translateY(${delta}px)`,
                  offset: displacedHoldOffset,
                },
                { transform: "translateY(0)", offset: 1 },
              ],
          {
            duration: changed ? total : travelDuration,
            easing: changed ? "cubic-bezier(0.22, 1, 0.36, 1)" : "ease-out",
          },
        );
      });
    });
    if (landingTimer.current) window.clearTimeout(landingTimer.current);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    landingTimer.current = window.setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const floating = floatingRow.current;
          target.classList.remove("order-row-floating-placeholder");
          target.classList.add("order-row-status-highlight");
          target.classList.remove("order-row-status-moving");
          motionScrollStart.current = null;
          setHighlightedId(changedId);
          if (floating) {
            const handoff = floating.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: 420,
              easing: "ease-out",
              fill: "forwards",
            });
            handoff.addEventListener(
              "finish",
              () => {
                floating.remove();
                if (floatingRow.current === floating)
                  floatingRow.current = null;
              },
              { once: true },
            );
          }
          highlightTimer.current = window.setTimeout(
            () => setHighlightedId(""),
            1500,
          );
        });
      });
    }, total);
  }, [rows]);
  return (
    <tbody className="order-list-body" ref={body}>
      {rows.map((sourceRow) => {
        const settled = settledRows[sourceRow.id];
        const sourceIsUnchanged =
          settled &&
          settled.before.status === sourceRow.status &&
          settled.before.due === sourceRow.due &&
          settled.before.paid === sourceRow.paid &&
          settled.before.balance === sourceRow.balance;
        const row = sourceIsUnchanged
          ? { ...sourceRow, ...settled.after }
          : sourceRow;
        const active = row.id === activeId;
        return (
          <tr
            key={row.id}
            id={`order-${row.id}`}
            data-order-id={row.id}
            className={`business-list-row ${active ? "order-row-active" : ""} ${suppressedHoverId === row.id ? "order-row-hover-suppressed" : ""} ${highlightedId === row.id ? "order-row-status-highlight" : ""}`.trim()}
            onClick={() => setActiveId(row.id)}
            onPointerLeave={() => {
              if (suppressedHoverId === row.id) setSuppressedHoverId("");
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const target = event.target;
              if (!(target instanceof HTMLInputElement)) return;
              event.preventDefault();
              target.blur();
              requestAnimationFrame(() => setActiveId(""));
            }}
          >
            <td className="order-type-cell">
              <span
                className={`order-type-tag order-type-${row.type.toLowerCase().replace("_", "-")}`}
              >
                {it.orderTypes[row.type]}
              </span>
            </td>
            <td>
              <Link
                className="order-link order-code-link"
                href={`/orders/${row.id}?returnTo=${encodeURIComponent(returnTo)}`}
                onClick={(event) => event.stopPropagation()}
              >
                <span>{row.code}</span>
                <ChevronRight size={15} aria-hidden="true" />
              </Link>
            </td>
            {!hideCustomer && (
              <td>
                <Link
                  className="order-link order-customer-link"
                  href={`/customers/${row.customerId}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <span>{row.customerName}</span>
                  <ChevronRight size={15} aria-hidden="true" />
                </Link>
              </td>
            )}
            <td>
              <strong>
                {row.brand} {row.model}
              </strong>
              <small className={compact ? "order-project-summary" : undefined}>
                {row.projects}
              </small>
            </td>
            <td className="order-inline-edit-cell order-status-cell">
              <StatusControl
                row={row}
                active={active}
                refreshOnSettled={!compact}
                onSettled={(settled) => {
                  if (!compact) {
                    motionScrollStart.current = {
                      x: window.scrollX,
                      y: window.scrollY,
                    };
                    previousRowPositions.current = new Map(
                      Array.from(
                        body.current?.querySelectorAll<HTMLTableRowElement>(
                          "tr[data-order-id]",
                        ) ?? [],
                      ).map((element) => [
                        element.dataset.orderId ?? "",
                        element.getBoundingClientRect(),
                      ]),
                    );
                    pendingStatusAnimation.current = row.id;
                  }
                  setSettledRows((current) => ({
                    ...current,
                    [row.id]: { before: sourceRow, after: settled },
                  }));
                  if (compact) setSuppressedHoverId(row.id);
                  setActiveId("");
                }}
              />
            </td>
            <td
              className={`order-inline-edit-cell order-due-cell${row.overdue ? " danger-text" : ""}`}
            >
              <DueDateControl key={row.expectedAt || row.dueDate} row={row} />
            </td>
            <td className="order-updated-cell">{row.lastUpdated}</td>
            <td className="numeric order-inline-edit-cell order-payment-cell">
              <PaymentControl key={row.paid} row={row} active={active} />
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
