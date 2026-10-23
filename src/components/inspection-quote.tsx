"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { completeInspectionAction } from "@/app/actions";
import { settlement } from "@/lib/domain";
import { useBusinessDay } from "./business-date";
import {
  Field,
  FormDialog,
  ItemsEditor,
  QuoteSummary,
  quoteItemsValid,
  type CategoryView,
  type ItemView,
  type RuleView,
} from "./forms";
import { DatePicker } from "./business-select";
import { FaultSelector } from "./fault-selector";
import type { FaultCatalogItem } from "./fault-catalog-manager";
import { useMessages } from "./language";
import { Button } from "./ui/button";

export function CompleteInspectionButton({
  orderId,
  inspectionFee,
  device,
  rules,
  faultOptions,
  initialFaultIds,
  products,
  productCategories,
}: {
  orderId: string;
  inspectionFee: string;
  device: { category: string; brand: string; series: string; model: string };
  rules: RuleView[];
  faultOptions: FaultCatalogItem[];
  initialFaultIds: string[];
  products: {
    id: string;
    name: string;
    category: string;
    stock: number;
    reserved: number;
    available: number;
  }[];
  productCategories: CategoryView[];
}) {
  const today = useBusinessDay();
  const it = useMessages();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [faults, setFaults] = useState(faultOptions);
  const [selectedFaults, setSelectedFaults] = useState(initialFaultIds);
  const [faultNote, setFaultNote] = useState("");
  const [items, setItems] = useState<ItemView[]>([]);
  const [discount, setDiscount] = useState("0");
  const [includeVat, setIncludeVat] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const quoteValid = quoteItemsValid(items, rules, device);
  const priceValid = useMemo(() => {
    try {
      settlement(items, {
        orderDiscount: discount,
        includeVat,
        inspectionFee,
      });
      return quoteValid;
    } catch {
      return false;
    }
  }, [discount, includeVat, inspectionFee, items, quoteValid]);
  const ready =
    selectedFaults.length > 0 && !!dueDate && quoteValid && priceValid;

  function close() {
    if (!pending) setOpen(false);
  }
  return (
    <>
      <Button
        type="button"
        className="stage-primary-action status-action-trigger status-diagnosing"
        onClick={() => setOpen(true)}
      >
        <span className="status-dropdown-dot" aria-hidden="true" />
        {it.completeInspection}
      </Button>
      {open && (
        <FormDialog title={it.completeInspection} onClose={close}>
          <form
            className="dialog-form inspection-complete-form"
            data-form-dialog-body
            aria-busy={pending}
            onSubmit={async (event) => {
              event.preventDefault();
              if (submitting.current || pending || !ready) return;
              submitting.current = true;
              setPending(true);
              setError("");
              try {
                const response = await completeInspectionAction(orderId, {
                  standardFaultIds: selectedFaults,
                  faultNote,
                  items,
                  orderDiscount: discount,
                  includeVat,
                  dueDate,
                });
                if (!response.ok) return setError(response.error);
                setOpen(false);
                router.refresh();
              } finally {
                submitting.current = false;
                setPending(false);
              }
            }}
          >
            <FaultSelector
              category={device.category}
              items={faults}
              selected={selectedFaults}
              disabled={pending}
              onChange={setSelectedFaults}
              onItemsChange={setFaults}
            />
            {selectedFaults.length > 0 && (
              <div className="inspection-progressive-reveal">
                <Field label={`${it.faultNotes} (${it.optional})`}>
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={faultNote}
                    onChange={(event) => setFaultNote(event.target.value)}
                  />
                </Field>
                <div className="compact-date-field">
                  <Field label={it.dueDate}>
                    <DatePicker
                      min={today}
                      quickDays={[0, 1, 2, 3, 7]}
                      value={dueDate}
                      onChange={(event) => setDueDate(event.target.value)}
                    />
                  </Field>
                </div>
              </div>
            )}
            {selectedFaults.length > 0 && dueDate && (
              <div className="inspection-progressive-reveal inspection-quote-stage">
                <h3>{it.quoteSection}</h3>
                <ItemsEditor
                  items={items}
                  onChange={setItems}
                  rules={rules}
                  device={device}
                  discounts
                  products={products}
                  productCategories={productCategories}
                  progressive
                  projectPicker
                />
                {quoteValid && (
                  <div className="inspection-progressive-reveal">
                    <Field label={it.orderDiscount}>
                      <input
                        inputMode="decimal"
                        value={discount}
                        onChange={(event) => setDiscount(event.target.value)}
                        aria-invalid={!priceValid}
                      />
                      {!priceValid && discount && (
                        <small className="field-error">
                          {it.invalidAmount}
                        </small>
                      )}
                    </Field>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={includeVat}
                        onChange={(event) =>
                          setIncludeVat(event.target.checked)
                        }
                      />
                      {it.includeVat}
                    </label>
                    <QuoteSummary
                      items={items}
                      orderDiscount={discount}
                      includeVat={includeVat}
                      inspectionFee={inspectionFee}
                    />
                  </div>
                )}
              </div>
            )}
            {error && <p className="message error">{error}</p>}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="cancel"
                disabled={pending}
                onClick={close}
              >
                {it.cancel}
              </Button>
              <Button disabled={pending || !ready}>
                {pending ? it.saving : it.save}
              </Button>
            </div>
          </form>
        </FormDialog>
      )}
    </>
  );
}
