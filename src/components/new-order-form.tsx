"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  Smartphone,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { createOrderAction, lookupCustomerAction } from "@/app/actions";
import { categories, type Category } from "@/lib/catalog";
import {
  cents,
  creatablePaymentMethods,
  matchRule,
  money,
  settlement,
} from "@/lib/domain";
import { useBusinessDay } from "./business-date";
import { translateError } from "@/lib/i18n";
import { prefersReducedMotion } from "@/lib/motion-preference";
import { DatePicker, SimpleSelect } from "./business-select";
import orderStepCardStyles from "./order-step-card.module.css";
import {
  DeviceForm,
  DialogBody,
  DialogFooter,
  Field,
  FormDialog,
  ItemsEditor,
  quoteItemsValid,
  type CategoryView,
  type RuleView,
} from "./forms";
import { type FaultCatalogItem } from "./fault-catalog-manager";
import { FaultSelector } from "./fault-selector";
import { useLanguage, useMessages } from "./language";
import { Button } from "./ui/button";
import { ensureComfortableInteractionSpace } from "@/lib/comfortable-scroll";
import {
  CustomerPicker,
  type CustomerDetail,
  type CustomerOption,
} from "./customer-picker";
import {
  CustomerDeviceCard,
  DeleteRecordDialog,
  type CustomerDevice,
} from "./customers";

type Item = {
  project: string;
  final: string;
  adjustmentReason: string;
  discount?: string;
  saveRule?: boolean;
  discountVisible?: boolean;
  requiredProductId?: string;
  requiredQuantity?: number;
  requiredProductRemoved?: boolean;
};

function safeCents(value: string) {
  try {
    return cents(value);
  } catch {
    return 0;
  }
}

function validAmount(value: string) {
  try {
    return cents(value) >= 0;
  } catch {
    return false;
  }
}

function RepairDeviceSummary({
  category,
  brand,
  model,
  imei,
  onChange,
}: {
  category: string;
  brand: string;
  model: string;
  imei: string;
  onChange: () => void;
}) {
  const it = useMessages();
  return (
    <div
      className="selection-summary repair-device-summary is-actionable"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        onChange();
      }}
    >
      <span className="selection-summary-icon" aria-hidden="true">
        <Smartphone size={20} />
      </span>
      <div className="selection-summary-copy">
        <strong>
          {brand} {model}
        </strong>
        <small>
          {category}
          {imei ? ` · ${it.imei}: ${imei}` : ""}
        </small>
      </div>
      <button type="button" className="summary-action" onClick={onChange}>
        <span>{it.changeDevice}</span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

function StepCard({
  number,
  title,
  state,
  summary,
  selected,
  expanded,
  onToggle,
  children,
}: {
  number: string;
  title: string;
  state: "not-started" | "in-progress" | "completed";
  summary?: string;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const it = useMessages();
  const heading = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
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
  const label =
    state === "completed"
      ? it.stepComplete
      : state === "in-progress"
        ? it.stepCurrent
        : it.stepEmpty;
  return (
    <section
      className={`panel ${orderStepCardStyles.card} order-step-card is-${state} ${selected ? `is-selected ${orderStepCardStyles.selected}` : ""}`}
    >
      <button
        ref={heading}
        type="button"
        className="order-step-heading"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="section-number">{number}</span>
        <span className="order-step-title">
          <strong>
            {title}{" "}
            {state === "completed" && <Check size={16} aria-hidden="true" />}
          </strong>
          {summary && <small>{summary}</small>}
        </span>
        <span className="order-step-state">{label}</span>
        <ChevronDown className="order-step-chevron" size={17} />
      </button>
      <div
        className={`order-step-collapse ${expanded ? "is-expanded" : ""}`}
        aria-hidden={!expanded}
        inert={!expanded || undefined}
      >
        <div ref={body} className="order-step-body">
          {children}
        </div>
      </div>
    </section>
  );
}

export function NewOrderWizard({
  rules,
  faultOptions,
  customers,
  products,
  productCategories,
}: {
  rules: RuleView[];
  faultOptions: FaultCatalogItem[];
  customers: CustomerOption[];
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
  const it = useMessages();
  const { locale } = useLanguage();
  const today = useBusinessDay();
  const router = useRouter();
  const [requestId] = useState(() => crypto.randomUUID());
  const autoAdvanceTimer = useRef<number | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(0);
  const [expandedStep, setExpandedStep] = useState<number | null>(0);
  const [customer, setCustomer] = useState<CustomerDetail>(null);
  const [deviceId, setDeviceId] = useState("");
  const [choosingDevice, setChoosingDevice] = useState(false);
  const [creatingDevice, setCreatingDevice] = useState(false);
  const [editingDevice, setEditingDevice] = useState<CustomerDevice | null>(
    null,
  );
  const [deletingDevice, setDeletingDevice] = useState<CustomerDevice | null>(
    null,
  );
  const [draftDeviceId, setDraftDeviceId] = useState("");
  const [category, setCategory] = useState<Category>("PHONE");
  const [brand, setBrand] = useState("");
  const [series, setSeries] = useState("");
  const [model, setModel] = useState("");
  const [imei, setImei] = useState("");
  const [appearance, setAppearance] = useState("");
  const [accessories, setAccessories] = useState("");
  const [selectedFaults, setSelectedFaults] = useState<string[]>([]);
  const [customFaults, setCustomFaults] = useState<string[]>([]);
  const [faultNote, setFaultNote] = useState("");
  const [faults, setFaults] = useState(faultOptions);
  const [inspectionMode, setInspectionMode] = useState(false);
  const [inspectionFee, setInspectionFee] = useState("30");
  const [dueDate, setDueDate] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [orderDiscount, setOrderDiscount] = useState("0");
  const [includeVat, setIncludeVat] = useState(false);
  const [deposit, setDeposit] = useState("0");
  const [method, setMethod] =
    useState<(typeof creatablePaymentMethods)[number]>("CASH");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const completed = useRef([false, false, false]);

  const catalog = faults
    .filter((fault) => fault.category === category && !fault.hidden)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const validCustomer = !!customer;
  const validDevice = !!category && !!brand.trim() && !!model.trim();
  const validFault =
    inspectionMode || selectedFaults.length > 0 || customFaults.length > 0;
  const validStep2 = validDevice && validFault && !!dueDate;
  const validQuote = inspectionMode
    ? safeCents(inspectionFee) > 0
    : quoteItemsValid(items, rules, { category, brand, series, model });
  const hasCompleteQuoteItem = items.some(
    (item) =>
      item.project.trim() &&
      validAmount(item.final) &&
      (item.saveRule ||
        !!matchRule(rules, { category, brand, series, model }, item.project)),
  );
  const requiredComplete = [validCustomer, validStep2, validQuote].filter(
    Boolean,
  ).length;
  const ready = requiredComplete === 3;
  const quote = useMemo(
    () =>
      settlement(
        inspectionMode
          ? []
          : items.map((item) => ({
              final: validAmount(item.final) ? item.final : "0",
              discount: validAmount(item.discount || "0")
                ? item.discount || "0"
                : "0",
            })),
        {
          orderDiscount: validAmount(orderDiscount) ? orderDiscount : "0",
          includeVat,
          inspectionFee:
            inspectionMode && validAmount(inspectionFee) ? inspectionFee : "0",
        },
      ),
    [includeVat, inspectionFee, inspectionMode, items, orderDiscount],
  );

  function toggleStep(index: number) {
    if (autoAdvanceTimer.current !== null) {
      window.clearTimeout(autoAdvanceTimer.current);
      autoAdvanceTimer.current = null;
    }
    if (selectedStep === index && expandedStep === index) {
      setExpandedStep(null);
      setSelectedStep(null);
      return;
    }
    setSelectedStep(index);
    setExpandedStep(index);
  }
  function clearDevice() {
    setDeviceId("");
    setBrand("");
    setSeries("");
    setModel("");
    setImei("");
    setAppearance("");
    setAccessories("");
  }
  function selectCustomerDevice(
    device: NonNullable<CustomerDetail>["devices"][number],
  ) {
    setDeviceId(device.id);
    setCategory(device.category as Category);
    setBrand(device.brand);
    setSeries(device.series);
    setModel(device.model);
    setImei(device.imei ?? "");
    setAppearance(device.appearance);
    setAccessories(device.accessories);
  }
  function changeDevice() {
    setDraftDeviceId(deviceId);
    setChoosingDevice(true);
  }
  function changeCustomer(next: CustomerDetail) {
    setCustomer(next);
    clearDevice();
    setChoosingDevice(false);
    setCreatingDevice(false);
    setEditingDevice(null);
    setDeletingDevice(null);
    if (!next) {
      setSelectedStep(0);
      setExpandedStep(0);
    }
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
    if (selectCreated && created) setDraftDeviceId(created.id);
    const selected = updated.devices.find((device) => device.id === deviceId);
    if (selected) selectCustomerDevice(selected);
    setCreatingDevice(false);
    setEditingDevice(null);
    setChoosingDevice(true);
  }
  function leaveInspection() {
    if (inspectionMode) setInspectionMode(false);
  }
  async function submit() {
    if (pending) return;
    setTouched(true);
    if (!ready || !customer) return;
    setPending(true);
    setError("");
    try {
      const result = await createOrderAction({
        requestId,
        customerName: customer.name,
        phone: customer.phone,
        additionalPhones: customer.phones
          .map((entry) => entry.phone)
          .filter((phone) => phone !== customer.phone),
        privacyConsent: false,
        deviceId,
        category,
        brand,
        series,
        model,
        imei,
        appearance,
        accessories,
        faults: [],
        standardFaultIds: inspectionMode ? [] : selectedFaults,
        customFaults: inspectionMode ? [] : customFaults,
        inspectionMode,
        fault: "",
        faultNote,
        notes: "",
        dueDate,
        items: inspectionMode ? [] : items,
        diagnosticFee: inspectionFee,
        orderDiscount,
        includeVat,
        deposit,
        method,
        paymentKind: "DEPOSIT",
      });
      if (!result.ok) return setError(result.error);
      router.push(`/orders/${result.id}`);
    } catch {
      setError(it.connectionError);
    } finally {
      setPending(false);
    }
  }

  const stepStates = [
    validCustomer ? "completed" : "in-progress",
    validStep2 ? "completed" : validCustomer ? "in-progress" : "not-started",
    validQuote ? "completed" : validStep2 ? "in-progress" : "not-started",
    safeCents(deposit) > 0 ? "completed" : "not-started",
  ] as const;
  useEffect(
    () => () => {
      if (autoAdvanceTimer.current !== null)
        window.clearTimeout(autoAdvanceTimer.current);
    },
    [],
  );
  useEffect(() => {
    const values = [validCustomer, validStep2, validQuote];
    const completedIndex = values.findIndex(
      (value, index) =>
        value && !completed.current[index] && selectedStep === index,
    );
    completed.current = values;
    if (completedIndex < 0 || completedIndex >= 2) return;
    const reduced = prefersReducedMotion();
    if (reduced) {
      setSelectedStep(completedIndex + 1);
      setExpandedStep(completedIndex + 1);
      return;
    }
    const closeTimer = window.setTimeout(() => {
      setExpandedStep(null);
      setSelectedStep(null);
      autoAdvanceTimer.current = window.setTimeout(() => {
        autoAdvanceTimer.current = null;
        setSelectedStep(completedIndex + 1);
        setExpandedStep(completedIndex + 1);
      }, 70);
    }, 100);
    return () => {
      window.clearTimeout(closeTimer);
    };
  }, [selectedStep, validCustomer, validQuote, validStep2]);
  const faultSummary = inspectionMode
    ? it.inspectionPending
    : [
        ...selectedFaults
          .map((id) => catalog.find((fault) => fault.id === id)?.name)
          .filter(Boolean),
        ...customFaults,
      ].join(", ");
  return (
    <>
      <div className="new-order-layout">
        <form
          className="order-form order-wizard service-order-form-column"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <StepCard
            number="01"
            title={it.customerSection}
            state={stepStates[0]}
            selected={selectedStep === 0}
            expanded={expandedStep === 0}
            onToggle={() => toggleStep(0)}
            summary={customer?.name}
          >
            <CustomerPicker
              customers={customers}
              customer={customer}
              onChange={changeCustomer}
              invalid={touched && !validCustomer}
            />
          </StepCard>

          <StepCard
            number="02"
            title={it.deviceSection}
            state={stepStates[1]}
            selected={selectedStep === 1}
            expanded={expandedStep === 1}
            onToggle={() => toggleStep(1)}
            summary={
              validDevice
                ? `${categories[category][locale === "zh" ? 1 : 0]} · ${brand} · ${model}${faultSummary ? ` · ${faultSummary}` : ""}`
                : undefined
            }
          >
            {validDevice ? (
              <RepairDeviceSummary
                category={categories[category][locale === "zh" ? 1 : 0]}
                brand={brand}
                model={model}
                imei={imei}
                onChange={changeDevice}
              />
            ) : (
              <div className="quick-service-device-cards">
                <button
                  type="button"
                  className="quick-service-device-card is-add add-device-action"
                  disabled={!customer}
                  onClick={changeDevice}
                >
                  <Plus size={18} /> {it.device}
                </button>
              </div>
            )}
            {validDevice && (
              <div className="wizard-progressive-reveal">
                <div
                  className={`inspection-choice ${inspectionMode ? "is-active" : ""}`}
                >
                  <Search size={20} />
                  <div>
                    <strong>{it.inspectionPending}</strong>
                    <p>{it.inspectionHelp}</p>
                  </div>
                  <Button
                    type="button"
                    variant={inspectionMode ? "outline" : "default"}
                    disabled={!validDevice}
                    onClick={() => {
                      setInspectionMode((value) => !value);
                    }}
                  >
                    {inspectionMode ? it.inspectionActive : it.setInspection}
                  </Button>
                </div>
                <FaultSelector
                  category={category}
                  items={faults}
                  selected={selectedFaults}
                  disabled={!validDevice || inspectionMode}
                  onItemsChange={setFaults}
                  onChange={(ids) => {
                    setSelectedFaults(ids);
                    if (ids.length) leaveInspection();
                  }}
                />
              </div>
            )}
            {customFaults.map((description, index) => (
              <div className="custom-fault-row" key={`${description}-${index}`}>
                <span>{description}</span>
                <button
                  type="button"
                  className="x-icon-button"
                  aria-label={`${it.remove} ${description}`}
                  onClick={() =>
                    setCustomFaults((current) =>
                      current.filter((_, i) => i !== index),
                    )
                  }
                >
                  <X size={15} />
                </button>
              </div>
            ))}
            {validDevice && validFault && !inspectionMode && (
              <div className="wizard-progressive-reveal">
                <Field label={it.faultNotes}>
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={faultNote}
                    onChange={(event) => setFaultNote(event.target.value)}
                  />
                </Field>
              </div>
            )}
            {choosingDevice && customer && (
              <FormDialog
                title={it.chooseDevice}
                onClose={() => setChoosingDevice(false)}
              >
                <DialogBody className="quick-service-picker">
                  <div className="quick-service-picker-list">
                    {customer.devices.map((device) => (
                      <CustomerDeviceCard
                        key={device.id}
                        device={device}
                        selected={device.id === draftDeviceId}
                        onSelect={() => setDraftDeviceId(device.id)}
                        onEdit={() => {
                          setChoosingDevice(false);
                          setEditingDevice(device);
                        }}
                        onDelete={() => {
                          setChoosingDevice(false);
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
                      setChoosingDevice(false);
                      setCreatingDevice(true);
                    }}
                  >
                    <Plus size={16} /> {it.device}
                  </button>
                </DialogBody>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="cancel"
                    onClick={() => setChoosingDevice(false)}
                  >
                    {it.cancel}
                  </Button>
                  <Button
                    type="button"
                    disabled={!draftDeviceId}
                    onClick={() => {
                      const device = customer.devices.find(
                        (entry) => entry.id === draftDeviceId,
                      );
                      if (!device) return;
                      selectCustomerDevice(device);
                      setChoosingDevice(false);
                    }}
                  >
                    {it.quickService.confirmDevices}
                  </Button>
                </DialogFooter>
              </FormDialog>
            )}
            {creatingDevice && customer && (
              <FormDialog
                title={it.newDevice}
                onClose={() => {
                  setCreatingDevice(false);
                  setChoosingDevice(true);
                }}
              >
                <DeviceForm
                  customerId={customer.id}
                  onSuccess={() => void refreshDevices(true)}
                  onCancel={() => {
                    setCreatingDevice(false);
                    setChoosingDevice(true);
                  }}
                />
              </FormDialog>
            )}
            {editingDevice && (
              <FormDialog
                title={it.editDevice}
                onClose={() => {
                  setEditingDevice(null);
                  setChoosingDevice(true);
                }}
              >
                <DeviceForm
                  device={editingDevice}
                  onSuccess={() => void refreshDevices()}
                  onCancel={() => {
                    setEditingDevice(null);
                    setChoosingDevice(true);
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
                  setChoosingDevice(true);
                }}
                onDeleted={() => {
                  setDraftDeviceId((current) =>
                    current === deletingDevice.id ? "" : current,
                  );
                  if (deviceId === deletingDevice.id) clearDevice();
                  setDeletingDevice(null);
                  void refreshDevices();
                }}
              />
            )}
            {touched && !validFault && (
              <p className="field-error">{it.selectFaultError}</p>
            )}
            {validDevice && validFault && (
              <div className="wizard-progressive-reveal compact-date-field">
                <Field label={it.dueDate}>
                  <DatePicker
                    name="dueDate"
                    min={today}
                    quickDays={[0, 1, 2, 3, 7]}
                    value={dueDate}
                    disabled={!validDevice || !validFault}
                    onChange={(event) => setDueDate(event.target.value)}
                  />
                </Field>
              </div>
            )}
          </StepCard>

          <StepCard
            number="03"
            title={it.quoteSection}
            state={stepStates[2]}
            selected={selectedStep === 2}
            expanded={expandedStep === 2}
            onToggle={() => toggleStep(2)}
            summary={
              validQuote
                ? `${inspectionMode ? it.inspectionFeeLabel : `${items.length} ${it.repairItems}`} · ${money(quote.due)}`
                : undefined
            }
          >
            {inspectionMode ? (
              <>
                <div className="inspection-banner">
                  <Search size={19} />
                  <div>
                    <strong>{it.inspectionModeTitle}</strong>
                    <p>{it.inspectionQuoteHelp}</p>
                  </div>
                </div>
                <Field label={`${it.diagnosticFee} *`}>
                  <input
                    inputMode="decimal"
                    value={inspectionFee}
                    onChange={(event) => setInspectionFee(event.target.value)}
                    aria-invalid={!validAmount(inspectionFee)}
                  />
                  {!validAmount(inspectionFee) && inspectionFee && (
                    <small className="field-error">{it.invalidAmount}</small>
                  )}
                </Field>
              </>
            ) : (
              <ItemsEditor
                items={items}
                onChange={setItems}
                rules={rules}
                device={{ category, brand, series, model }}
                discounts
                products={products}
                productCategories={productCategories}
                progressive
                projectPicker
              />
            )}
            {touched && !validQuote && (
              <p className="field-error">
                {inspectionMode ? it.inspectionFeeError : it.repairItemError}
              </p>
            )}
            {!inspectionMode && hasCompleteQuoteItem && (
              <div className="wizard-progressive-reveal">
                <Field label={it.orderDiscount}>
                  <input
                    inputMode="decimal"
                    value={orderDiscount}
                    onChange={(event) => setOrderDiscount(event.target.value)}
                    aria-invalid={!validAmount(orderDiscount)}
                  />
                  {!validAmount(orderDiscount) && orderDiscount && (
                    <small className="field-error">{it.invalidAmount}</small>
                  )}
                </Field>
              </div>
            )}
            {(inspectionMode || hasCompleteQuoteItem) && (
              <div className="price-breakdown wizard-progressive-reveal">
                <h3>{it.priceDetails}</h3>
                {inspectionMode && (
                  <div>
                    <span>{it.inspectionFeeNet}</span>
                    <strong>{money(quote.inspectionTotal)}</strong>
                  </div>
                )}{" "}
                {!inspectionMode && (
                  <>
                    <div>
                      <span>{it.repairSubtotal}</span>
                      <strong>{money(quote.repairGross)}</strong>
                    </div>
                    <div>
                      <span>{it.discountTotal}</span>
                      <strong>{money(quote.discount)}</strong>
                    </div>
                    <div>
                      <span>{it.netTotal}</span>
                      <strong>{money(quote.net)}</strong>
                    </div>
                  </>
                )}
                <div>
                  <span>{it.vatAmount}</span>
                  <strong>{money(quote.vat)}</strong>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={includeVat}
                    onChange={(event) => setIncludeVat(event.target.checked)}
                  />
                  {it.includeVat}
                </label>
                <div className="price-due">
                  <span>{it.total}</span>
                  <strong>{money(quote.due)}</strong>
                </div>
              </div>
            )}
          </StepCard>

          <StepCard
            number="04"
            title={it.paymentSection}
            state={stepStates[3]}
            selected={selectedStep === 3}
            expanded={expandedStep === 3}
            onToggle={() => toggleStep(3)}
            summary={
              safeCents(deposit) > 0 ? money(safeCents(deposit)) : undefined
            }
          >
            <div className="form-grid">
              <Field label={it.initialPayment}>
                <input
                  inputMode="decimal"
                  value={deposit}
                  onChange={(event) => setDeposit(event.target.value)}
                  aria-invalid={!validAmount(deposit)}
                />
                {!validAmount(deposit) && deposit && (
                  <small className="field-error">{it.invalidAmount}</small>
                )}
              </Field>
              <Field label={it.paymentMethod}>
                <SimpleSelect
                  value={method}
                  onChange={(value) => setMethod(value as typeof method)}
                  ariaLabel={it.paymentMethod}
                  placeholder={it.selectOption}
                  options={creatablePaymentMethods.map((value) => ({
                    value,
                    label: it.methods[value],
                  }))}
                />
              </Field>
            </div>
          </StepCard>
          {error && (
            <p className="message error" role="alert">
              {translateError(error, locale)}
            </p>
          )}
          <div
            className={`sticky-order-actions ${ready ? "is-ready" : "needs-attention"}`}
          >
            <div>
              {ready ? (
                <>
                  <strong>
                    <Check size={16} /> {it.requiredStepsComplete}
                  </strong>
                  <small>{it.canCreateOrder}</small>
                </>
              ) : (
                <>
                  <strong>
                    ○ {it.finishStep}:{" "}
                    {![validCustomer, validStep2, validQuote].find(Boolean)
                      ? it.customerSection
                      : !validStep2
                        ? it.deviceSection
                        : it.quoteSection}
                  </strong>
                </>
              )}
            </div>
            <span>
              <Button
                type="button"
                variant="cancel"
                onClick={() => router.push("/orders")}
              >
                {it.cancel}
              </Button>
              <Button
                type="button"
                disabled={!ready || pending}
                onClick={() => void submit()}
              >
                {pending ? it.saving : it.create}
              </Button>
            </span>
          </div>
        </form>
        <aside className="order-progress panel">
          <h2>{it.formProgress}</h2>
          <strong>{requiredComplete}/3</strong>
          {[
            it.customerSection,
            it.deviceSection,
            it.quoteSection,
            it.paymentSection,
          ].map((label, index) => (
            <div
              key={label}
              className={stepStates[index] === "completed" ? "is-complete" : ""}
            >
              <span>
                {stepStates[index] === "completed" ? "✓" : "○"} {label}
              </span>
              <small>
                {stepStates[index] === "completed"
                  ? it.stepComplete
                  : stepStates[index] === "in-progress"
                    ? it.stepCurrent
                    : it.stepEmpty}
              </small>
            </div>
          ))}
          <footer>
            <strong>
              {ready ? <Check size={15} /> : "○"}{" "}
              {ready ? it.requiredStepsComplete : `${requiredComplete}/3`}
            </strong>
            <span>{ready ? it.canCreateOrder : it.completeRequiredSteps}</span>
          </footer>
        </aside>
      </div>
    </>
  );
}
