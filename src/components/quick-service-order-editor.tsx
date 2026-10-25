"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { updateQuickServiceOrderAction } from "@/app/actions";
import { cents, money } from "@/lib/domain";
import { useMessages } from "./language";
import { Field, FormDialog } from "./forms";
import { Button } from "./ui/button";
import dialogStyles from "./ui/dialog.module.css";
import { DatePicker } from "./business-select";

type QuickServiceItem = { id: string; project: string; final: string };

export function QuickServiceOrderEditor({
  id,
  expectedAt,
  notes,
  items: initialItems,
  paid,
  currentTotal,
  locked,
}: {
  id: string;
  expectedAt: string;
  notes: string;
  items: QuickServiceItem[];
  paid: number;
  currentTotal: number;
  locked: boolean;
}) {
  const it = useMessages();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(expectedAt);
  const [orderNotes, setOrderNotes] = useState(notes);
  const [items, setItems] = useState(initialItems);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const newTotal = items.reduce((sum, item) => {
    try {
      return sum + cents(item.final);
    } catch {
      return Number.NaN;
    }
  }, 0);
  const hasChanges =
    date !== expectedAt ||
    orderNotes !== notes ||
    items.some(
      (item, index) =>
        item.project !== initialItems[index]?.project ||
        item.final !== initialItems[index]?.final,
    );
  const validItems = items.every((item) => {
    try {
      return Boolean(item.project.trim()) && Number.isFinite(cents(item.final));
    } catch {
      return false;
    }
  });
  const canSave =
    !pending &&
    hasChanges &&
    Boolean(date) &&
    validItems &&
    Number.isFinite(newTotal) &&
    newTotal >= paid;

  function close() {
    if (!pending) setOpen(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setPending(true);
    setError("");
    try {
      const result = await updateQuickServiceOrderAction(id, {
        expectedAt: date,
        notes: orderNotes,
        items,
      });
      if (!result.ok) return setError(result.error);
      setOpen(false);
      router.refresh();
    } catch {
      setError(it.connectionError);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {!locked && (
        <Button
          type="button"
          variant="outline"
          className="quick-service-order-edit-trigger"
          aria-label={it.quickService.editOrder}
          onClick={() => {
            setDate(expectedAt);
            setOrderNotes(notes);
            setItems(initialItems.map((item) => ({ ...item })));
            setError("");
            setOpen(true);
          }}
        >
          <Pencil size={15} aria-hidden="true" />
          {it.edit}
        </Button>
      )}
      {open && (
        <FormDialog
          title={it.quickService.editOrder}
          onClose={close}
          restoreFocusComfortably={false}
        >
          <form
            className={`${dialogStyles.dialogForm} dialog-form quick-service-order-edit`}
            aria-busy={pending}
            onSubmit={submit}
          >
            <Field label={it.quickService.expectedAt}>
              <DatePicker
                type="datetime-local"
                required
                value={date}
                disabled={pending}
                onChange={(event) => setDate(event.target.value)}
              />
            </Field>
            <Field label={it.quickService.notes}>
              <textarea
                rows={3}
                maxLength={2000}
                value={orderNotes}
                disabled={pending}
                onChange={(event) => setOrderNotes(event.target.value)}
              />
            </Field>
            <div className="quick-service-order-edit-items">
              {items.map((item, index) => (
                <div className="form-grid" key={item.id}>
                  <Field
                    label={it.quickService.serviceItem.replace(
                      "{number}",
                      String(index + 1),
                    )}
                  >
                    <input
                      required
                      maxLength={120}
                      value={item.project}
                      disabled={pending}
                      onChange={(event) =>
                        setItems((current) =>
                          current.map((entry) =>
                            entry.id === item.id
                              ? { ...entry, project: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={it.quickService.serviceItemPrice}>
                    <input
                      inputMode="decimal"
                      required
                      value={item.final}
                      disabled={pending}
                      onChange={(event) =>
                        setItems((current) =>
                          current.map((entry) =>
                            entry.id === item.id
                              ? { ...entry, final: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </Field>
                </div>
              ))}
            </div>
            <div className="quick-service-order-edit-totals" aria-live="polite">
              <span>
                {it.quickService.currentTotal}:{" "}
                <strong>{money(currentTotal)}</strong>
              </span>
              <span>
                {it.quickService.newTotal}:{" "}
                <strong>
                  {Number.isFinite(newTotal) ? money(newTotal) : "—"}
                </strong>
              </span>
              <span>
                {it.quickService.paidAmount}: <strong>{money(paid)}</strong>
              </span>
            </div>
            {paid > 0 && (
              <p className="message warning" role="note">
                {it.quickService.paymentImpact}
              </p>
            )}
            {newTotal < paid && (
              <p className="message error" role="alert">
                {it.quickService.paymentImpact}
              </p>
            )}
            {error && (
              <p className="message error" role="alert">
                {error}
              </p>
            )}
            <div className={`${dialogStyles.dialogActions} dialog-actions`}>
              <Button
                type="button"
                variant="cancel"
                disabled={pending}
                onClick={close}
              >
                {it.cancel}
              </Button>
              <Button disabled={!canSave}>
                {pending ? it.saving : it.quickService.saveOrder}
              </Button>
            </div>
          </form>
        </FormDialog>
      )}
    </>
  );
}
