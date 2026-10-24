"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Smartphone, Wrench, X, Zap } from "lucide-react";
import {
  createQuickServiceOrderAction,
  lookupCustomerAction,
} from "@/app/actions";
import { cents, decimal, money } from "@/lib/domain";
import { useMessages } from "./language";
import {
  DeviceForm,
  DialogBody,
  DialogFooter,
  Field,
  FormDialog,
} from "./forms";
import { DatePicker } from "./business-select";
import { Button } from "./ui/button";
import selectionSummaryStyles from "./selection-summary.module.css";
import {
  CustomerPicker,
  type CustomerDetail,
  type CustomerOption,
} from "./customer-picker";
import { QuickServiceEditor, type QuickServiceView } from "./catalog-managers";
import {
  CustomerDeviceCard,
  DeleteRecordDialog,
  type CustomerDevice,
} from "./customers";
import { RecordIcon } from "./ui/record-icon";
import { useBusinessDay } from "./business-date";
import quickServiceDeviceCardStyles from "./quick-service-device-card.module.css";

type Customer = CustomerOption & { devices: { id: string }[] };

type Service = Omit<QuickServiceView, "enabled">;

function validPrice(value: string) {
  try {
    return cents(value) > 0;
  } catch {
    return false;
  }
}

export function NewServiceOrder({
  repairForm,
  customers,
  services,
  initialMode = "REPAIR",
}: {
  repairForm: ReactNode;
  customers: Customer[];
  services: Service[];
  initialMode?: "REPAIR" | "QUICK_SERVICE";
}) {
  const it = useMessages();
  const today = useBusinessDay();
  const router = useRouter();
  const [mode, setMode] = useState<"REPAIR" | "QUICK_SERVICE">(initialMode);
  const [customer, setCustomer] = useState<CustomerDetail>(null);
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [availableServices, setAvailableServices] = useState<
    QuickServiceView[]
  >(services.map((service) => ({ ...service, enabled: true })));
  const [selectedServices, setSelectedServices] = useState<
    Record<string, string>
  >({});
  const [editingServicePrices, setEditingServicePrices] = useState<
    Record<string, boolean>
  >({});
  const [expectedAt, setExpectedAt] = useState("");
  const [choosingDevices, setChoosingDevices] = useState(false);
  const [draftDeviceIds, setDraftDeviceIds] = useState<string[]>([]);
  const [choosingServices, setChoosingServices] = useState(false);
  const [draftServiceIds, setDraftServiceIds] = useState<string[]>([]);
  const [creatingDevice, setCreatingDevice] = useState(false);
  const [editingDevice, setEditingDevice] = useState<CustomerDevice | null>(
    null,
  );
  const [deletingDevice, setDeletingDevice] = useState<CustomerDevice | null>(
    null,
  );
  const [creatingService, setCreatingService] = useState(false);
  const [editingService, setEditingService] = useState<QuickServiceView | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const customerId = customer?.id ?? "";
  const selectedDevices =
    customer?.devices.filter((device) => deviceIds.includes(device.id)) ?? [];
  const selectedServiceItems = availableServices.filter(
    (service) => service.id in selectedServices,
  );

  function changeMode(next: "REPAIR" | "QUICK_SERVICE") {
    setMode(next);
    if (next === "REPAIR") {
      setChoosingDevices(false);
      setChoosingServices(false);
      setCreatingDevice(false);
      setEditingDevice(null);
      setDeletingDevice(null);
      setCreatingService(false);
      setEditingService(null);
    }
  }

  function changeCustomer(next: CustomerDetail) {
    setCustomer(next);
    setDeviceIds([]);
    setChoosingDevices(false);
  }

  function toggleDraftDevice(id: string) {
    setDraftDeviceIds((current) =>
      current.includes(id)
        ? current.filter((deviceId) => deviceId !== id)
        : [...current, id],
    );
  }

  function openDevicePicker() {
    setDraftDeviceIds(deviceIds);
    setChoosingDevices(true);
  }

  function openServicePicker() {
    setDraftServiceIds(Object.keys(selectedServices));
    setChoosingServices(true);
  }

  function confirmServices() {
    setSelectedServices((current) =>
      Object.fromEntries(
        draftServiceIds.map((id) => {
          const service = availableServices.find((item) => item.id === id)!;
          return [id, current[id] ?? decimal(service.defaultPrice)];
        }),
      ),
    );
    setChoosingServices(false);
  }

  async function refreshDevices(selectCreated = false) {
    if (!customer) return;
    const previousIds = new Set(customer.devices.map((device) => device.id));
    const updated = await lookupCustomerAction(customer.phone);
    if (!updated) return;
    const created = updated.devices.find(
      (device) => !previousIds.has(device.id),
    );
    setCustomer(updated);
    if (selectCreated && created)
      setDraftDeviceIds((current) => [...new Set([...current, created.id])]);
    setCreatingDevice(false);
    setEditingDevice(null);
    setChoosingDevices(true);
  }

  async function submit() {
    if (
      !customerId ||
      !deviceIds.length ||
      !Object.keys(selectedServices).length ||
      !expectedAt
    )
      return setError(it.validationError);
    setPending(true);
    setError("");
    const result = await createQuickServiceOrderAction({
      requestId: crypto.randomUUID(),
      customerId,
      deviceIds,
      services: Object.entries(selectedServices).map(([serviceId, price]) => ({
        serviceId,
        price,
      })),
      expectedAt,
    });
    setPending(false);
    if (!result.ok || !result.id)
      return setError(result.ok ? it.connectionError : result.error);
    router.push(`/orders/${result.id}`);
  }

  return (
    <>
      <div className="service-mode-switch panel">
        <button
          type="button"
          className={mode === "REPAIR" ? "active" : ""}
          onClick={() => changeMode("REPAIR")}
        >
          <Wrench size={17} aria-hidden="true" />
          {it.quickService.repairMode}
        </button>
        <button
          type="button"
          className={mode === "QUICK_SERVICE" ? "active" : ""}
          onClick={() => changeMode("QUICK_SERVICE")}
        >
          <Zap size={17} aria-hidden="true" />
          {it.quickService.quickMode}
        </button>
      </div>
      <div className="service-mode-form-repair" hidden={mode !== "REPAIR"}>
        {repairForm}
      </div>
      <div
        className="service-mode-form-quick"
        hidden={mode !== "QUICK_SERVICE"}
      >
        <div className="new-order-layout quick-service-layout">
          <section className="panel padded quick-service-order-form service-order-form-column">
            <section className="quick-service-section">
              <h2>{it.customerSection}</h2>
              <CustomerPicker
                customers={customers}
                customer={customer}
                onChange={changeCustomer}
              />
            </section>
            <section className="quick-service-section">
              <h2>{it.quickService.selectDevices}</h2>
              <div
                className={`quick-service-device-cards ${quickServiceDeviceCardStyles.cards}`}
              >
                {selectedDevices.map((device) => (
                  <article
                    className={`quick-service-device-card ${quickServiceDeviceCardStyles.card}`}
                    key={device.id}
                  >
                    <span
                      className={`quick-service-picker-icon ${quickServiceDeviceCardStyles.icon}`}
                      aria-hidden="true"
                    >
                      <Smartphone size={22} />
                    </span>
                    <div className={quickServiceDeviceCardStyles.content}>
                      <strong>
                        {device.brand} {device.model}
                      </strong>
                      <small>{device.imei || "—"}</small>
                    </div>
                    <button
                      type="button"
                      className={`x-icon-button ${quickServiceDeviceCardStyles.removeButton}`}
                      aria-label={`${it.remove} ${device.brand} ${device.model}`}
                      onClick={() =>
                        setDeviceIds((current) =>
                          current.filter((id) => id !== device.id),
                        )
                      }
                    >
                      <X size={16} />
                    </button>
                  </article>
                ))}
                <button
                  type="button"
                  className="quick-service-device-card is-add add-device-action"
                  disabled={!customer}
                  onClick={openDevicePicker}
                >
                  <Plus size={18} /> {it.device}
                </button>
              </div>
            </section>
            <section className="quick-service-section">
              <h2>{it.quickService.serviceItems}</h2>
              <div className="quick-service-service-cards">
                {selectedServiceItems.map((service) => (
                  <article
                    className={`selection-summary selected-project-summary ${selectionSummaryStyles.scope}`}
                    key={service.id}
                  >
                    <span className="selection-summary-icon is-project">
                      <Zap size={18} aria-hidden="true" />
                    </span>
                    <div className="selection-summary-copy">
                      <strong>{service.name}</strong>
                      <small>
                        {service.notes || it.quickService.quickMode}
                      </small>
                    </div>
                    <div className="selection-summary-value">
                      <small>{it.currentQuote}</small>
                      {editingServicePrices[service.id] ? (
                        <div className="quote-summary-price-field">
                          <input
                            autoFocus
                            className="quote-summary-price"
                            aria-label={`${service.name} ${it.currentQuote}`}
                            inputMode="decimal"
                            value={selectedServices[service.id]}
                            aria-invalid={
                              !validPrice(selectedServices[service.id])
                            }
                            onChange={(event) =>
                              setSelectedServices((current) => ({
                                ...current,
                                [service.id]: event.target.value,
                              }))
                            }
                            onBlur={() => {
                              if (validPrice(selectedServices[service.id]))
                                setEditingServicePrices((current) => ({
                                  ...current,
                                  [service.id]: false,
                                }));
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              if (validPrice(selectedServices[service.id]))
                                event.currentTarget.blur();
                            }}
                          />
                          {!validPrice(selectedServices[service.id]) && (
                            <small className="field-error">
                              {it.positiveAmountError}
                            </small>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="summary-price-button"
                          aria-label={`${it.edit} ${it.currentQuote}`}
                          onClick={() =>
                            setEditingServicePrices((current) => ({
                              ...current,
                              [service.id]: true,
                            }))
                          }
                        >
                          <strong>
                            {money(cents(selectedServices[service.id]))}
                          </strong>
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    {!editingServicePrices[service.id] && (
                      <button
                        type="button"
                        className="quick-service-remove"
                        aria-label={`${it.remove} ${service.name}`}
                        onClick={() =>
                          setSelectedServices((current) => {
                            const next = { ...current };
                            delete next[service.id];
                            return next;
                          })
                        }
                      >
                        <X size={16} />
                      </button>
                    )}
                  </article>
                ))}
                <button
                  type="button"
                  className="quick-service-service-add"
                  onClick={openServicePicker}
                >
                  <Plus size={18} /> {it.quickService.serviceItems}
                </button>
              </div>
            </section>
            <section className="quick-service-section quick-service-schedule">
              <h2>{it.quickService.expectedAt}</h2>
              <Field label={it.quickService.expectedAt}>
                <DatePicker
                  type="datetime-local"
                  value={expectedAt}
                  required
                  min={`${today}T00:00`}
                  quickDays={[0, 1, 2, 3, 7]}
                  onChange={(event) => setExpectedAt(event.target.value)}
                />
              </Field>
            </section>
            {error && <p className="message error">{error}</p>}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="cancel"
                onClick={() => router.push("/orders")}
              >
                {it.cancel}
              </Button>
              <Button
                type="button"
                disabled={
                  pending ||
                  !customerId ||
                  !deviceIds.length ||
                  !expectedAt ||
                  !Object.keys(selectedServices).length
                }
                onClick={() => void submit()}
              >
                {it.quickService.createOrder}
              </Button>
            </div>
            {choosingDevices && customer && (
              <FormDialog
                title={it.quickService.selectDevices}
                subtitle={it.quickService.devicePickerHelp}
                onClose={() => setChoosingDevices(false)}
              >
                <DialogBody className="quick-service-picker">
                  <div className="quick-service-picker-list">
                    {customer.devices.map((device) => (
                      <CustomerDeviceCard
                        key={device.id}
                        device={device}
                        selected={draftDeviceIds.includes(device.id)}
                        onToggle={() => toggleDraftDevice(device.id)}
                        onEdit={() => {
                          setChoosingDevices(false);
                          setEditingDevice(device);
                        }}
                        onDelete={() => {
                          setChoosingDevices(false);
                          setDeletingDevice(device);
                        }}
                      />
                    ))}
                    {!customer.devices.length && (
                      <p className="muted">{it.noDevices}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="quick-service-picker-add add-device-action"
                    onClick={() => {
                      setChoosingDevices(false);
                      setCreatingDevice(true);
                    }}
                  >
                    <Plus size={16} /> {it.device}
                  </button>
                </DialogBody>
                <DialogFooter
                  summary={
                    <strong>
                      {it.quickService.selectedDevices.replace(
                        "{count}",
                        String(draftDeviceIds.length),
                      )}
                    </strong>
                  }
                >
                  <Button
                    type="button"
                    variant="cancel"
                    onClick={() => setChoosingDevices(false)}
                  >
                    {it.cancel}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      setDeviceIds(draftDeviceIds);
                      setChoosingDevices(false);
                    }}
                  >
                    {it.quickService.confirmDevices}
                  </Button>
                </DialogFooter>
              </FormDialog>
            )}
            {choosingServices && (
              <FormDialog
                title={it.quickService.selectServices}
                subtitle={it.quickService.servicePickerHelp}
                onClose={() => setChoosingServices(false)}
              >
                <DialogBody className="quick-service-picker">
                  <div className="quick-service-picker-list">
                    {availableServices.map((service) => (
                      <article
                        className={`quick-service-picker-option quick-service-picker-service business-list-row${draftServiceIds.includes(service.id) ? " is-selected" : ""}`}
                        key={service.id}
                        onClick={() =>
                          setDraftServiceIds((current) =>
                            current.includes(service.id)
                              ? current.filter((id) => id !== service.id)
                              : [...current, service.id],
                          )
                        }
                      >
                        <input
                          type="checkbox"
                          checked={draftServiceIds.includes(service.id)}
                          onChange={() =>
                            setDraftServiceIds((current) =>
                              current.includes(service.id)
                                ? current.filter((id) => id !== service.id)
                                : [...current, service.id],
                            )
                          }
                          onClick={(event) => event.stopPropagation()}
                        />
                        <span className="quick-service-picker-icon">
                          <Zap size={22} aria-hidden="true" />
                        </span>
                        <span className="quick-service-picker-copy">
                          <strong>{service.name}</strong>
                          <small>
                            {service.notes || it.quickService.quickMode}
                          </small>
                        </span>
                        <strong className="quick-service-picker-price">
                          {money(service.defaultPrice)}
                        </strong>
                        <div
                          className="record-actions"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <RecordIcon
                            kind="edit"
                            label={`${it.edit} ${service.name}`}
                            onClick={() => {
                              setChoosingServices(false);
                              setEditingService(service);
                            }}
                          />
                        </div>
                      </article>
                    ))}
                    {!availableServices.length && (
                      <p className="muted">{it.quickService.noServices}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="quick-service-picker-add"
                    onClick={() => {
                      setChoosingServices(false);
                      setCreatingService(true);
                    }}
                  >
                    <Plus size={16} /> {it.quickService.serviceItems}
                  </button>
                </DialogBody>
                <DialogFooter
                  summary={
                    <strong>
                      {it.quickService.selectedServices.replace(
                        "{count}",
                        String(draftServiceIds.length),
                      )}
                    </strong>
                  }
                >
                  <Button
                    type="button"
                    variant="cancel"
                    onClick={() => setChoosingServices(false)}
                  >
                    {it.cancel}
                  </Button>
                  <Button type="button" onClick={confirmServices}>
                    {it.quickService.confirmServices}
                  </Button>
                </DialogFooter>
              </FormDialog>
            )}
            {creatingDevice && customer && (
              <FormDialog
                title={it.newDevice}
                onClose={() => {
                  setCreatingDevice(false);
                  setChoosingDevices(true);
                }}
              >
                <DeviceForm
                  customerId={customer.id}
                  onSuccess={() => void refreshDevices(true)}
                  onCancel={() => {
                    setCreatingDevice(false);
                    setChoosingDevices(true);
                  }}
                />
              </FormDialog>
            )}
            {editingDevice && customer && (
              <FormDialog
                title={it.editDevice}
                onClose={() => {
                  setEditingDevice(null);
                  setChoosingDevices(true);
                }}
              >
                <DeviceForm
                  device={editingDevice}
                  onSuccess={() => void refreshDevices()}
                  onCancel={() => {
                    setEditingDevice(null);
                    setChoosingDevices(true);
                  }}
                />
              </FormDialog>
            )}
            {deletingDevice && (
              <DeleteRecordDialog
                kind="device"
                id={deletingDevice.id}
                name={`${deletingDevice.brand} ${deletingDevice.model}`}
                onClose={() => {
                  setDeletingDevice(null);
                  setChoosingDevices(true);
                }}
                onDeleted={() => {
                  setDraftDeviceIds((current) =>
                    current.filter((id) => id !== deletingDevice.id),
                  );
                  setDeviceIds((current) =>
                    current.filter((id) => id !== deletingDevice.id),
                  );
                  setDeletingDevice(null);
                  void refreshDevices();
                }}
              />
            )}
            {creatingService && (
              <FormDialog
                title={it.quickService.new}
                onClose={() => {
                  setCreatingService(false);
                  setChoosingServices(true);
                }}
              >
                <QuickServiceEditor
                  onCancel={() => {
                    setCreatingService(false);
                    setChoosingServices(true);
                  }}
                  onSaved={(saved) => {
                    setAvailableServices((current) =>
                      saved.enabled
                        ? [...current, saved].sort((a, b) =>
                            a.name.localeCompare(b.name),
                          )
                        : current,
                    );
                    if (saved.enabled)
                      setDraftServiceIds((current) => [
                        ...new Set([...current, saved.id]),
                      ]);
                    setCreatingService(false);
                    setChoosingServices(true);
                  }}
                />
              </FormDialog>
            )}
            {editingService && (
              <FormDialog
                title={it.edit}
                onClose={() => {
                  setEditingService(null);
                  setChoosingServices(true);
                }}
              >
                <QuickServiceEditor
                  item={editingService}
                  onCancel={() => {
                    setEditingService(null);
                    setChoosingServices(true);
                  }}
                  onSaved={(saved) => {
                    setAvailableServices((current) =>
                      saved.enabled
                        ? current
                            .map((item) =>
                              item.id === saved.id ? saved : item,
                            )
                            .sort((a, b) => a.name.localeCompare(b.name))
                        : current.filter((item) => item.id !== saved.id),
                    );
                    if (!saved.enabled) {
                      setDraftServiceIds((current) =>
                        current.filter((id) => id !== saved.id),
                      );
                      setSelectedServices((current) => {
                        const next = { ...current };
                        delete next[saved.id];
                        return next;
                      });
                    }
                    setEditingService(null);
                    setChoosingServices(true);
                  }}
                />
              </FormDialog>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
