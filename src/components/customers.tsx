"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Plus, Smartphone, Trash2 } from "lucide-react";
import {
  CustomerForm,
  DeviceForm,
  DialogBody,
  DialogFooter,
  FormDialog,
} from "./forms";
import { RecordIcon } from "./ui/record-icon";
import { Button } from "./ui/button";
import { BatchControls } from "./ui/batch-controls";
import { useLanguage, useMessages } from "./language";
import {
  deleteCustomerAction,
  deleteCustomersAction,
  deleteDeviceAction,
} from "@/app/actions";
import { translateError } from "@/lib/i18n";

type Customer = {
  id: string;
  name: string;
  phone: string;
  phones: { phone: string }[];
};
export type CustomerDevice = {
  id: string;
  category: string;
  brand: string;
  model: string;
  imei: string | null;
};
export function customerListUrl(query: string) {
  return query ? `/customers?q=${encodeURIComponent(query)}` : "/customers";
}

export function PhoneList({ customer }: { customer: Customer }) {
  return (
    <div className="customer-phones">
      {[
        ...new Set([customer.phone, ...customer.phones.map((p) => p.phone)]),
      ].map((phone) => (
        <div className="customer-phone" key={phone}>
          <a href={`tel:${phone.replace(/[^+\d]/g, "")}`}>{phone}</a>
        </div>
      ))}
    </div>
  );
}

export function DeleteRecordDialog({
  kind,
  id,
  name,
  onClose,
  onDeleted,
}: {
  kind: "customer" | "device";
  id: string;
  name: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setPending(true);
    setError("");
    try {
      const result =
        kind === "device"
          ? await deleteDeviceAction(id)
          : await deleteCustomerAction(id);
      if (!result.ok) setError(result.error ?? "Errore");
      else onDeleted();
    } catch {
      setError("Connessione non disponibile. Riprova.");
    } finally {
      setPending(false);
    }
  }
  return (
    <FormDialog
      title={
        kind === "customer"
          ? it.deleteCustomerQuestion
          : it.deleteDeviceQuestion
      }
      onClose={onClose}
    >
      <DialogBody className="confirm-delete-dialog">
        <div className="confirm-delete-icon" aria-hidden="true">
          <Trash2 size={22} />
        </div>
        <p>
          {(kind === "customer"
            ? it.deleteCustomerDescription
            : it.deleteDeviceDescription
          ).replace("{name}", name)}
        </p>
        {error && (
          <p role="alert" className="message error">
            {translateError(error, locale)}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="cancel" disabled={pending} onClick={onClose}>
          {it.cancel}
        </Button>
        <Button variant="danger" disabled={pending} onClick={remove}>
          {kind === "customer" ? it.deleteCustomer : it.deleteDevice}
        </Button>
      </DialogFooter>
    </FormDialog>
  );
}

export function CustomerDeviceCard({
  device,
  selected,
  onToggle,
  onSelect,
  onEdit,
  onDelete,
}: {
  device: CustomerDevice;
  selected?: boolean;
  onToggle?: () => void;
  onSelect?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const it = useMessages();
  const selectable = onToggle ?? onSelect;
  return (
    <article
      className={`customer-device-row business-list-row${selected ? " is-selected" : ""}${selectable ? " is-selectable" : ""}`}
      onClick={selectable}
    >
      {onToggle && (
        <input
          type="checkbox"
          checked={selected}
          aria-label={`${it.selectOption} ${device.brand} ${device.model}`}
          onChange={onToggle}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <div className="customer-device-icon" aria-hidden="true">
        <Smartphone size={20} />
      </div>
      <div>
        <strong>
          {device.brand} {device.model}
        </strong>
        <small>
          {device.category}
          {device.imei ? ` · ${it.imei}: ${device.imei}` : ""}
        </small>
      </div>
      {(onEdit || onDelete) && (
        <div
          className="record-actions"
          onClick={(event) => event.stopPropagation()}
        >
          {onEdit && (
            <RecordIcon kind="edit" label={it.editDevice} onClick={onEdit} />
          )}
          {onDelete && (
            <RecordIcon
              kind="delete"
              label={it.deleteDevice}
              onClick={onDelete}
            />
          )}
        </div>
      )}
    </article>
  );
}

export function CustomerList({
  customers,
}: {
  customers: (Customer & {
    _count: { devices: number };
    lastRepairAt: string | null;
  })[];
}) {
  const it = useMessages();
  const params = useSearchParams();
  const router = useRouter();
  const { locale } = useLanguage();
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [batchMode, setBatchMode] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("customer-list-position");
      if (!saved) return;
      sessionStorage.removeItem("customer-list-position");
      const position = JSON.parse(saved);
      if (position.query === query && Number.isFinite(position.y)) {
        const frame = requestAnimationFrame(() =>
          window.scrollTo(0, position.y),
        );
        return () => cancelAnimationFrame(frame);
      }
    } catch {
      /* Storage may be unavailable in private sessions. */
    }
  }, [query]);
  const normalized = query.trim().toLocaleLowerCase();
  const shown = customers.filter(
    (c) =>
      c.name.toLocaleLowerCase().includes(normalized) ||
      [c.phone, ...c.phones.map((p) => p.phone)].some((phone) =>
        phone.includes(normalized),
      ),
  );
  const selectedIds = selected.filter((id) => shown.some((c) => c.id === id));
  async function removeSelected() {
    if (!selectedIds.length || pending) return;
    if (
      !window.confirm(
        it.customerDeleteConfirm.replace("{count}", String(selectedIds.length)),
      )
    )
      return;
    setPending(true);
    setError("");
    try {
      const result = await deleteCustomersAction(selectedIds);
      if (!result.ok) setError(result.error);
      else {
        setSelected([]);
        router.refresh();
      }
    } catch {
      setError("Connessione non disponibile. Riprova.");
    } finally {
      setPending(false);
    }
  }
  function search(value: string) {
    setQuery(value);
    setSelected([]);
    window.history.replaceState(
      { ...window.history.state },
      "",
      customerListUrl(value),
    );
  }
  return (
    <>
      <form
        className="filters customer-search"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="grow">
          <span className="sr-only">{it.search}</span>
          <input
            type="search"
            disabled={pending}
            name="q"
            value={query}
            onChange={(event) => search(event.target.value)}
            placeholder={it.customerSearch}
          />
        </label>
        {query && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => search("")}
          >
            {it.clearSearch}
          </Button>
        )}
        <div className="inventory-batch-controls customer-batch-toolbar">
          <BatchControls
            active={batchMode}
            pending={pending}
            selectedCount={selectedIds.length}
            deleteDisabled={selectedIds.length > 500}
            hasItems={shown.length > 0}
            manageLabel={it.batchManage}
            selectedLabel={it.inventory.selectedCount.replace(
              "{count}",
              String(selectedIds.length),
            )}
            selectAllLabel={it.selectAll}
            showSelectAll={false}
            deleteLabel={it.deleteCustomers}
            finishLabel={it.finishBatch}
            onStart={() => {
              setBatchMode(true);
              setSelected([]);
            }}
            onSelectAll={() =>
              setSelected(shown.map((customer) => customer.id))
            }
            onDelete={removeSelected}
            onFinish={() => {
              setBatchMode(false);
              setSelected([]);
            }}
          />
          {batchMode && selectedIds.length > 500 && (
            <span role="alert">{it.batchLimit}</span>
          )}
        </div>
      </form>
      <p className="customer-result-count" role="status">
        {shown.length} {it.customerResults}
      </p>
      {error && (
        <p className="message error" role="alert">
          {translateError(error, locale)}
        </p>
      )}
      <section className="panel customer-table-panel">
        {shown.length ? (
          <table className="customer-table">
            <thead>
              <tr>
                {batchMode && (
                  <th className="customer-selection">
                    <input
                      type="checkbox"
                      aria-label={it.selectAll}
                      disabled={pending || !shown.length}
                      checked={
                        shown.length > 0 && selectedIds.length === shown.length
                      }
                      ref={(element) => {
                        if (element)
                          element.indeterminate =
                            selectedIds.length > 0 &&
                            selectedIds.length < shown.length;
                      }}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? shown.map((customer) => customer.id)
                            : [],
                        )
                      }
                    />
                  </th>
                )}
                <th className="customer-name-heading">{it.customer}</th>
                <th className="customer-phone-heading">{it.phone}</th>
                <th className="numeric customer-device-heading">
                  {it.devices}
                </th>
                <th className="customer-last-repair-heading">
                  {it.lastRepairTime}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((customer) => {
                const href = `/customers/${customer.id}${query ? `?q=${encodeURIComponent(query)}` : ""}`;
                return (
                  <tr className="business-list-row" key={customer.id}>
                    {batchMode && (
                      <td className="customer-selection">
                        <input
                          type="checkbox"
                          aria-label={it.selectOption + " " + customer.name}
                          disabled={pending}
                          checked={selectedIds.includes(customer.id)}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, customer.id]
                                : current.filter((id) => id !== customer.id),
                            )
                          }
                        />
                      </td>
                    )}
                    <td className="customer-name">
                      <Link
                        className="order-link"
                        href={href}
                        onClick={() => {
                          try {
                            sessionStorage.setItem(
                              "customer-list-position",
                              JSON.stringify({ query, y: window.scrollY }),
                            );
                          } catch {}
                        }}
                      >
                        <span>{customer.name}</span>
                        <ChevronRight size={15} aria-hidden="true" />
                      </Link>
                    </td>
                    <td className="customer-contact">
                      <PhoneList customer={customer} />
                    </td>
                    <td className="numeric customer-device-count">
                      <span className="mobile-label">{it.devices}: </span>
                      {customer._count.devices}
                    </td>
                    <td className="customer-last-repair">
                      <span className="mobile-label">{it.lastRepairTime}:</span>
                      {customer.lastRepairAt
                        ? new Intl.DateTimeFormat(
                            locale === "zh" ? "zh-CN" : "it-IT",
                            { dateStyle: "medium", timeStyle: "short" },
                          ).format(new Date(customer.lastRepairAt))
                        : it.noRepairHistory}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            <p>{query ? it.noCustomerMatches : it.noCustomers}</p>
            {query && (
              <Button variant="outline" onClick={() => search("")}>
                {it.clearSearch}
              </Button>
            )}
          </div>
        )}
      </section>
    </>
  );
}

export function CustomerSummary({
  customer,
  query,
  deleted,
  showHeading = true,
  dialog = false,
}: {
  customer: Customer;
  query: string;
  deleted: boolean;
  showHeading?: boolean;
  dialog?: boolean;
}) {
  const it = useMessages();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <section
      className={`panel padded customer-summary ${editing ? "is-editing" : ""}`}
    >
      {editing ? (
        <CustomerForm
          customer={customer}
          onCancel={() => setEditing(false)}
          onSuccess={() => setEditing(false)}
        />
      ) : (
        <>
          <div>
            {showHeading && <h1>{customer.name}</h1>}
            <PhoneList customer={customer} />
          </div>
          {!deleted && (
            <div className="customer-summary-actions record-actions">
              <RecordIcon
                kind="edit"
                label={it.editCustomer}
                onClick={() => setEditing(true)}
              />
              <RecordIcon
                kind="delete"
                label={it.deleteCustomer}
                onClick={() => setDeleting(true)}
              />
            </div>
          )}
        </>
      )}
      {deleting && (
        <DeleteRecordDialog
          kind="customer"
          id={customer.id}
          name={customer.name}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            if (dialog) router.back();
            else router.push(customerListUrl(query));
            router.refresh();
          }}
        />
      )}
    </section>
  );
}
export function CustomerDevices({
  customerId,
  devices,
  readOnly,
}: {
  customerId: string;
  devices: CustomerDevice[];
  readOnly: boolean;
}) {
  const it = useMessages();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [deleting, setDeleting] = useState<CustomerDevice | null>(null);
  return (
    <section className="customer-devices-section">
      <div className="customer-section-heading">
        <h2>
          {it.devices} ({devices.length})
        </h2>
      </div>
      <div className="panel customer-device-list">
        {devices.length ? (
          devices.map((device) =>
            editingId === device.id ? (
              <article
                className="customer-device-row business-list-row is-editing"
                key={device.id}
              >
                <DeviceForm
                  device={device}
                  onCancel={() => setEditingId("")}
                  onSuccess={() => setEditingId("")}
                />
              </article>
            ) : (
              <CustomerDeviceCard
                key={device.id}
                device={device}
                onEdit={readOnly ? undefined : () => setEditingId(device.id)}
                onDelete={readOnly ? undefined : () => setDeleting(device)}
              />
            ),
          )
        ) : (
          <p className="empty">{it.noDevices}</p>
        )}
        {!readOnly && (
          <Button
            type="button"
            variant="outline"
            className="add-device-action customer-detail-add-device"
            onClick={() => setCreating(true)}
          >
            <Plus size={18} aria-hidden="true" />
            {it.device}
          </Button>
        )}
      </div>
      {creating && (
        <FormDialog title={it.newDevice} onClose={() => setCreating(false)}>
          <DeviceForm
            customerId={customerId}
            onCancel={() => setCreating(false)}
            onSuccess={() => setCreating(false)}
          />
        </FormDialog>
      )}
      {deleting && (
        <DeleteRecordDialog
          kind="device"
          id={deleting.id}
          name={`${deleting.brand} ${deleting.model}`}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}
