"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, ChevronUp, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import {
  FormSaveContext,
  FormCloseContext,
  type FormSaveRegistration,
} from "./ui/form-close-context";
import {
  AfterSalesForm,
  FormDialog,
  RefundForm,
  type AfterSalesProject,
  type RuleView,
} from "./forms";
import { useMessages } from "./language";
import { ensureComfortableInteractionSpace } from "@/lib/comfortable-scroll";

export type OrderDetailEditTarget = {
  kind: "repair";
  index: number;
  field: "project" | "part";
  action?: "remove";
};

const OrderDetailEditContext = createContext<{
  editing: boolean;
  session: number;
  target: OrderDetailEditTarget | null;
  requestEdit: (target: OrderDetailEditTarget) => void;
  clearTarget: () => void;
} | null>(null);

export function useOrderDetailEdit() {
  return useContext(OrderDetailEditContext);
}

export function OrderDetailCard({
  title,
  children,
  edit,
  persistent,
  locked = false,
  className = "",
  defaultExpanded = true,
  summary,
  id,
  testId,
}: {
  title: string;
  children: ReactNode;
  edit?: ReactNode;
  persistent?: ReactNode;
  locked?: boolean;
  className?: string;
  defaultExpanded?: boolean;
  summary?: ReactNode;
  id?: string;
  testId?: string;
}) {
  const it = useMessages();
  const router = useRouter();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  const [editSession, setEditSession] = useState(0);
  const [editTarget, setEditTarget] = useState<OrderDetailEditTarget | null>(
    null,
  );
  const card = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const outsideSaveTimer = useRef<number | null>(null);
  const wasExpanded = useRef(expanded);
  const saves = useRef(new Set<FormSaveRegistration>());
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leaveHref, setLeaveHref] = useState("");
  const editable = Boolean(edit) && !locked;
  const closeEdit = () => {
    setEditTarget(null);
    setEditing(false);
    setDirty(false);
  };
  const requestEdit = (target: OrderDetailEditTarget) => {
    setExpanded(true);
    if (!editing) setEditSession((current) => current + 1);
    setEditTarget(target);
    setEditing(true);
  };
  const registerSave = useCallback((registration: FormSaveRegistration) => {
    saves.current.add(registration);
    setDirty(Array.from(saves.current).some((entry) => entry.isDirty()));
    return () => {
      saves.current.delete(registration);
    };
  }, []);
  useEffect(() => {
    const justExpanded = expanded && !wasExpanded.current;
    wasExpanded.current = expanded;
    if (!justExpanded) return;
    const frame = requestAnimationFrame(() => {
      if (!heading.current || !body.current) return;
      ensureComfortableInteractionSpace(heading.current, {
        spaceBelow: Math.min(
          body.current.scrollHeight,
          window.innerHeight * 0.55,
        ),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded]);
  const saveAll = useCallback(async () => {
    for (const registration of saves.current)
      if (!(await registration.save())) return false;
    return true;
  }, []);
  const hasUnsavedChanges = useCallback(
    () =>
      Array.from(saves.current).some((registration) => registration.isDirty()),
    [],
  );
  function toggleExpanded() {
    if (editing) return;
    setExpanded((current) => !current);
  }
  const submitEdit = useCallback(
    async (collapseOnSuccess = false) => {
      if (saving) return;
      setSaving(true);
      const saved = await saveAll();
      setSaving(false);
      if (saved) {
        closeEdit();
        if (collapseOnSuccess) setExpanded(false);
      }
    },
    [saveAll, saving],
  );
  useEffect(() => {
    if (!editing) return;
    function guardNavigation(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element) || card.current?.contains(target))
        return;
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (
        !link ||
        link.target === "_blank" ||
        !hasUnsavedChanges() ||
        new URL(link.href, window.location.href).origin !==
          window.location.origin
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setLeaveHref(`${link.pathname}${link.search}${link.hash}`);
    }
    function guardUnload(event: BeforeUnloadEvent) {
      if (!hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    }
    document.addEventListener("click", guardNavigation, true);
    window.addEventListener("beforeunload", guardUnload);
    return () => {
      document.removeEventListener("click", guardNavigation, true);
      window.removeEventListener("beforeunload", guardUnload);
    };
  }, [editing, hasUnsavedChanges]);
  useEffect(() => {
    if (!editing) return;
    function saveWhenClickingOutside(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element) || card.current?.contains(target))
        return;
      if (
        target.closest("[data-prevent-card-autosave], a[href], [role='dialog']")
      )
        return;
      if (outsideSaveTimer.current !== null)
        window.clearTimeout(outsideSaveTimer.current);
      outsideSaveTimer.current = window.setTimeout(() => {
        outsideSaveTimer.current = null;
        void submitEdit(true);
      }, 0);
    }
    document.addEventListener("pointerdown", saveWhenClickingOutside, true);
    return () => {
      document.removeEventListener(
        "pointerdown",
        saveWhenClickingOutside,
        true,
      );
      if (outsideSaveTimer.current !== null) {
        window.clearTimeout(outsideSaveTimer.current);
        outsideSaveTimer.current = null;
      }
    };
  }, [editing, submitEdit]);
  async function saveAndLeave() {
    if (!leaveHref || saving) return;
    setSaving(true);
    const saved = await saveAll();
    setSaving(false);
    if (!saved) return;
    const href = leaveHref;
    closeEdit();
    setLeaveHref("");
    router.push(href);
  }
  function discardAndLeave() {
    if (!leaveHref) return;
    const href = leaveHref;
    closeEdit();
    setLeaveHref("");
    router.push(href);
  }
  return (
    <OrderDetailEditContext.Provider
      value={{
        editing,
        session: editSession,
        target: editTarget,
        requestEdit,
        clearTarget: () => setEditTarget(null),
      }}
    >
      <section
        ref={card}
        className={`panel padded order-detail-card ${editable ? "is-editable" : ""} ${editing ? "is-editing" : ""} ${locked ? "is-locked" : ""} ${className}`}
        id={id}
        data-testid={testId}
      >
        <div
          ref={heading}
          className="order-card-heading"
          role="button"
          tabIndex={0}
          aria-label={title}
          aria-expanded={expanded}
          onClick={() => void toggleExpanded()}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            void toggleExpanded();
          }}
        >
          <div className="order-card-title">
            <div className="order-card-toggle">
              <h2>{title}</h2>
            </div>
            {!expanded && summary && (
              <small className="order-card-summary">{summary}</small>
            )}
          </div>
          <div className="order-card-actions">
            {editing && <small>{it.editing}</small>}
            {editable && !editing && (
              <button
                type="button"
                className="order-card-edit"
                aria-label={it.edit}
                title={it.edit}
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded(true);
                  setEditSession((current) => current + 1);
                  setEditTarget(null);
                  setEditing(true);
                }}
              >
                <Pencil size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          <span
            className="order-card-expand-icon"
            data-testid="order-card-expand-icon"
          >
            {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
          </span>
        </div>
        <div
          className={`order-card-collapse ${expanded ? "is-expanded" : ""}`}
          aria-hidden={!expanded}
          inert={!expanded || undefined}
        >
          <div
            ref={body}
            className="order-card-body"
            onChangeCapture={() =>
              requestAnimationFrame(() => setDirty(hasUnsavedChanges()))
            }
            onInputCapture={() =>
              requestAnimationFrame(() => setDirty(hasUnsavedChanges()))
            }
          >
            {editing ? (
              <FormSaveContext.Provider value={registerSave}>
                <FormCloseContext.Provider value={closeEdit}>
                  {edit}
                  {persistent}
                  <div className="dialog-actions order-card-edit-actions">
                    <Button
                      type="button"
                      variant="cancel"
                      disabled={saving}
                      onClick={closeEdit}
                    >
                      {it.cancel}
                    </Button>
                    <Button
                      type="button"
                      disabled={saving || !dirty}
                      onClick={() => void submitEdit()}
                    >
                      {saving ? it.saving : it.save}
                    </Button>
                  </div>
                </FormCloseContext.Provider>
              </FormSaveContext.Provider>
            ) : (
              <>
                {children}
                {persistent}
              </>
            )}
          </div>
        </div>
      </section>
      {leaveHref && (
        <FormDialog
          title={it.unsavedChangesTitle}
          onClose={() => setLeaveHref("")}
          restoreFocusComfortably={false}
        >
          <p>{it.unsavedChangesHelp}</p>
          <div className="dialog-actions">
            <Button
              type="button"
              variant="cancel"
              disabled={saving}
              onClick={() => setLeaveHref("")}
            >
              {it.continueEditing}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={discardAndLeave}
            >
              {it.discardAndLeave}
            </Button>
            <Button
              type="button"
              disabled={saving}
              onClick={() => void saveAndLeave()}
            >
              {saving ? it.saving : it.saveAndLeave}
            </Button>
          </div>
        </FormDialog>
      )}
    </OrderDetailEditContext.Provider>
  );
}

export function CustomerDetailLink({
  href,
  name,
}: {
  href: string;
  name: string;
}) {
  return (
    <Link
      className="order-link order-customer-link"
      href={href}
      onClick={(event) => event.stopPropagation()}
    >
      <span>{name}</span>
      <ChevronRight size={15} aria-hidden="true" />
    </Link>
  );
}

export function AfterSalesActions({
  orderId,
  received,
  originalProjects,
  products,
  productCategories,
  device,
  rules,
}: {
  orderId: string;
  received: number;
  originalProjects: AfterSalesProject[];
  products: import("./forms").CreatedProduct[];
  productCategories: import("./forms").CategoryView[];
  device: { category: string; brand: string; series: string; model: string };
  rules: RuleView[];
}) {
  const it = useMessages();
  const [dialog, setDialog] = useState<"rework" | "refund" | null>(null);
  return (
    <section className="panel padded after-sales-actions">
      <h2>{it.afterSales.title}</h2>
      <div className="after-sales-buttons">
        <Button onClick={() => setDialog("rework")}>
          {it.afterSales.rework}
        </Button>
        <Button
          variant="danger"
          disabled={received <= 0}
          onClick={() => setDialog("refund")}
        >
          {it.afterSales.refund}
        </Button>
      </div>
      {dialog === "rework" && (
        <FormDialog
          title={it.afterSales.openRework}
          subtitle={it.afterSales.reworkSubtitle}
          onClose={() => setDialog(null)}
        >
          <AfterSalesForm
            id={orderId}
            originalProjects={originalProjects}
            products={products}
            productCategories={productCategories}
            device={device}
            rules={rules}
            onSuccess={() => setDialog(null)}
          />
        </FormDialog>
      )}
      {dialog === "refund" && (
        <FormDialog
          title={it.afterSales.confirmRefund}
          onClose={() => setDialog(null)}
        >
          <RefundForm id={orderId} received={received} />
        </FormDialog>
      )}
    </section>
  );
}
