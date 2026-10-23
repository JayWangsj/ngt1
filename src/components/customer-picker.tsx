"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { customerAction, lookupCustomerAction } from "@/app/actions";
import { translateError } from "@/lib/i18n";
import { focusComfortably } from "@/lib/comfortable-scroll";
import { SearchableCombobox } from "./business-select";
import {
  DialogBody,
  DialogFooter,
  DialogForm,
  Field,
  FormDialog,
} from "./forms";
import { useLanguage, useMessages } from "./language";
import { Button } from "./ui/button";

export type CustomerOption = {
  id: string;
  name: string;
  phone: string;
  phones: { phone: string }[];
};

export type CustomerDetail = Awaited<
  ReturnType<typeof import("@/app/actions").lookupCustomerAction>
>;

export function CustomerPicker({
  customers,
  customer,
  onChange,
  invalid = false,
}: {
  customers: CustomerOption[];
  customer: CustomerDetail;
  onChange: (customer: CustomerDetail) => void;
  invalid?: boolean;
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const router = useRouter();
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [duplicate, setDuplicate] = useState<CustomerDetail>(null);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const createFocus = useRef<"name" | "phone">("phone");

  function clear() {
    onChange(null);
    setQuery("");
    setChoosing(true);
    setName("");
    setPhone("");
    setDuplicate(null);
  }

  async function select(id: string) {
    const selected = customers.find((candidate) => candidate.id === id);
    if (!selected) return clear();
    const detail = await lookupCustomerAction(selected.phone);
    if (!detail) return;
    onChange(detail);
    setChoosing(false);
    setQuery("");
  }

  function openCreate(value: string) {
    const next = value.trim();
    const looksLikePhone = /^[+\d\s().-]{6,}$/.test(next);
    setQuery(next);
    setName(looksLikePhone ? "" : next);
    setPhone(looksLikePhone ? next : "");
    createFocus.current = looksLikePhone ? "name" : "phone";
    setDuplicate(null);
    setError("");
    setCreating(true);
  }

  async function save() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const existing = await lookupCustomerAction(phone);
      if (existing) return setDuplicate(existing);
      const result = await customerAction(null, {
        name,
        phone,
        additionalPhones: [],
      });
      if (!result.ok) return setError(result.error);
      const created = await lookupCustomerAction(phone);
      if (!created) return setError(it.connectionError);
      onChange(created);
      setChoosing(false);
      setQuery("");
      setCreating(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    if (!creating) return;
    const frame = requestAnimationFrame(() => {
      focusComfortably(
        createFocus.current === "name" ? nameInput.current : phoneInput.current,
        { select: true },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [creating]);

  return (
    <>
      {!customer || choosing ? (
        <Field label={`${it.searchCustomer} *`}>
          <SearchableCombobox
            value={customer?.id || query}
            onChange={(id) => void select(id)}
            onQueryChange={setQuery}
            ariaLabel={it.searchCustomer}
            placeholder={it.customerSearchPlaceholder}
            searchPlaceholder={it.customerSearchPlaceholder}
            emptyText={it.noCustomerMatches}
            autoFocusQuery={choosing ? customer?.name : undefined}
            customLabel={it.addCustomer}
            onCustom={openCreate}
            creationControls="no-match"
            clearable
            groups={[
              {
                options: customers.map((entry) => ({
                  value: entry.id,
                  label: entry.name,
                  secondary: entry.phone,
                  keywords: entry.phones.map((item) => item.phone).join(" "),
                })),
              },
            ]}
          />
        </Field>
      ) : (
        <div
          className="selection-summary selected-customer-summary is-actionable"
          onClick={(event) => {
            if (!(event.target as HTMLElement).closest("button")) clear();
          }}
        >
          <span className="selection-summary-icon is-customer">
            <UserRound size={19} aria-hidden="true" />
          </span>
          <div className="selection-summary-copy">
            <strong>{customer.name}</strong>
            <small>{customer.phone}</small>
          </div>
          <button type="button" className="summary-action" onClick={clear}>
            <span>{it.reselect}</span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {invalid && <p className="field-error">{it.selectCustomerError}</p>}
      {creating && (
        <FormDialog title={it.addCustomer} onClose={() => setCreating(false)}>
          <DialogForm
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <DialogBody>
              <Field label={`${it.name} *`}>
                <input
                  ref={nameInput}
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label={`${it.phone} *`}>
                <input
                  ref={phoneInput}
                  required
                  type="tel"
                  maxLength={30}
                  value={phone}
                  onChange={(event) => {
                    setPhone(event.target.value);
                    setDuplicate(null);
                  }}
                />
              </Field>
              {duplicate && (
                <div className="message warning duplicate-customer">
                  <strong>{it.customerFound}</strong>
                  <span>{duplicate.name}</span>
                  <small>{duplicate.phone}</small>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      onChange(duplicate);
                      setChoosing(false);
                      setQuery("");
                      setCreating(false);
                    }}
                  >
                    {it.useExistingCustomer}
                  </Button>
                </div>
              )}
              {error && (
                <p className="message error">{translateError(error, locale)}</p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="cancel"
                disabled={pending}
                onClick={() => setCreating(false)}
              >
                {it.cancel}
              </Button>
              <Button disabled={pending}>
                {pending ? it.saving : it.saveCustomer}
              </Button>
            </DialogFooter>
          </DialogForm>
        </FormDialog>
      )}
    </>
  );
}
