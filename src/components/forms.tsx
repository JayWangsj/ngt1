"use client";
import {
  useContext,
  useCallback,
  useState,
  useEffect,
  useRef,
  useId,
  useTransition,
  Children,
  isValidElement,
  cloneElement,
  type ReactElement,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { RecordIcon } from "./ui/record-icon";
import { EditableSelect } from "./editable-select";
import {
  deviceProjects,
  uniqueOptions,
  groupPriceRules,
  pricePath,
} from "@/lib/options";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Plus,
  Star,
  Trash2,
  Check,
  ShieldCheck,
  X,
  ChevronRight,
  Package,
  Pencil,
  Smartphone,
  Wrench,
} from "lucide-react";
import type { SimpleIcon } from "simple-icons";
import {
  siAcer,
  siApple,
  siAsus,
  siDell,
  siFitbit,
  siGarmin,
  siGoogle,
  siHonor,
  siHp,
  siHuawei,
  siLenovo,
  siMotorola,
  siMsi,
  siNokia,
  siOneplus,
  siOppo,
  siSamsung,
  siSony,
  siVivo,
  siXiaomi,
} from "simple-icons";
import { Button } from "./ui/button";
import { BatchControls } from "./ui/batch-controls";
import { QuantityStepper } from "./ui/quantity-stepper";
import {
  CompatibilityAddEditor,
  type CompatibilityDeviceDraft,
} from "./compatibility-add-editor";
import { ToggleSwitch } from "./ui/toggle-switch";
import { FormSaveContext, FormCloseContext } from "./ui/form-close-context";
import { useMessages, useLanguage } from "./language";
import { translateError } from "@/lib/i18n";
import { prefersReducedMotion } from "@/lib/motion-preference";
import {
  categories,
  brands,
  models,
  faultPresets,
  type Category,
  normalizeBrand,
  normalizeDeviceModel,
  modelKey,
} from "@/lib/catalog";
import { isDiagnosticFault, settlement } from "@/lib/domain";
import { useBusinessDay } from "./business-date";
import {
  cents,
  decimal,
  matchRule,
  money,
  creatablePaymentMethods,
} from "@/lib/domain";
import { orderInput } from "@/lib/validation";
import {
  SearchableCombobox,
  SimpleSelect,
  DatePicker,
} from "./business-select";
import { FaultSelector } from "./fault-selector";
import type { FaultCatalogItem } from "./fault-catalog-manager";
import {
  createOrderAction,
  lookupCustomerAction,
  paymentAction,
  updateOrderAction,
  quoteAction,
  ruleAction,
  updatePriceRuleFieldsAction,
  customerAction,
  createDeviceAction,
  hideFaultAction,
  deleteCustomerAction,
  deviceAction,
  deleteDeviceAction,
  deleteRulesAction,
  priceRuleOptionAction,
  warrantyAction,
  afterSalesAction,
  updateReworkPartAction,
  refundAction,
  createProductAction,
  deleteInventoryCategoryAction,
} from "@/app/actions";
import {
  focusComfortably,
  focusWithoutScrolling,
} from "@/lib/comfortable-scroll";

export type RuleView = {
  id: string;
  category: string;
  brand: string;
  series: string;
  model: string;
  project: string;
  suggested: string;
  cost?: string | null;
  minutes: number;
  notes: string;
  enabled: boolean;
  requiredProductId?: string | null;
  requiredQuantity?: number;
  requiredProductRemoved?: boolean;
  options?: PriceRuleOptionView[];
};

export type PriceRuleOptionView = {
  id: string;
  productId: string;
  name: string;
  suggested: string;
  cost?: string | null;
  quantity: number;
  minutes: number;
  warrantyDays: number;
  enabled: boolean;
  isDefault: boolean;
  notes: string;
  product: {
    id: string;
    name: string;
    category: string;
    stock: number;
    reserved: number;
    available: number;
  };
};

function InlineRuleFields({
  rule,
  active,
  disabled,
  projectLabel,
  quoteLabel,
  onClose,
  onError,
  onSaved,
}: {
  rule: RuleView;
  active: boolean;
  disabled: boolean;
  projectLabel: string;
  quoteLabel: string;
  onClose: () => void;
  onError: (message: string) => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [project, setProject] = useState(rule.project);
  const [suggested, setSuggested] = useState(rule.suggested);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const save = useCallback(async () => {
    if (saving.current) return;
    const nextProject = project.trim();
    const nextSuggested = suggested.trim();
    if (nextProject === rule.project && nextSuggested === rule.suggested) {
      onClose();
      return;
    }
    saving.current = true;
    setPending(true);
    onError("");
    const result = await updatePriceRuleFieldsAction(rule.id, {
      project: nextProject,
      suggested: nextSuggested,
    });
    setPending(false);
    saving.current = false;
    if (!result.ok) return onError(result.error);
    onClose();
    onSaved();
    router.refresh();
  }, [onClose, onError, onSaved, project, router, rule, suggested]);
  useEffect(() => {
    if (!active) return;
    function saveOutside(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest(`[data-price-rule="${rule.id}"]`)
      ) {
        void save();
      }
    }
    document.addEventListener("pointerdown", saveOutside);
    return () => document.removeEventListener("pointerdown", saveOutside);
  }, [active, rule.id, save]);
  function cancel() {
    setProject(rule.project);
    setSuggested(rule.suggested);
    onClose();
  }
  if (active)
    return (
      <>
        <input
          className="inline-rule-input inline-rule-project"
          aria-label={projectLabel}
          value={project}
          maxLength={120}
          disabled={disabled || pending}
          onChange={(event) => setProject(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape") cancel();
          }}
        />
        <input
          className="inline-rule-input inline-rule-suggested"
          aria-label={quoteLabel}
          value={suggested}
          inputMode="decimal"
          disabled={disabled || pending}
          onChange={(event) => setSuggested(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape") cancel();
          }}
        />
      </>
    );
  return (
    <>
      <button
        type="button"
        className="inline-rule-value inline-rule-project"
        disabled={disabled}
      >
        {rule.project}
      </button>
      <button
        type="button"
        className="inline-rule-value inline-rule-suggested"
        disabled={disabled}
      >
        {money(cents(rule.suggested))}
      </button>
    </>
  );
}
export type ItemView = {
  project: string;
  final: string;
  adjustmentReason: string;
  discount?: string;
  saveRule?: boolean;
  priceOptionId?: string;
  priceOptionName?: string;
  suggested?: string;
  suggestedAfterSwitch?: string;
  discountVisible?: boolean;
  requiredProductId?: string;
  requiredQuantity?: number;
  requiredProductRemoved?: boolean;
};
const blankItem = (): ItemView => ({
  project: "",
  final: "",
  adjustmentReason: "",
  discount: "0",
  saveRule: false,
  priceOptionId: "",
  priceOptionName: "",
  suggested: "",
});
function defaultPriceOption(rule?: RuleView | null) {
  const options = rule?.options?.filter((option) => option.enabled) ?? [];
  return options.find((option) => option.isDefault) ?? options[0] ?? null;
}
function itemPriceOption(rule: RuleView | null | undefined, item: ItemView) {
  return (
    rule?.options?.find(
      (option) =>
        option.enabled &&
        (option.id === item.priceOptionId ||
          (!item.priceOptionId && option.productId === item.requiredProductId)),
    ) ?? null
  );
}
function numeric(value: string) {
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
function validPositiveAmount(value: string) {
  try {
    return cents(value) > 0;
  } catch {
    return false;
  }
}
function normalizedProject(value: string) {
  return value.trim().toLocaleLowerCase("it");
}
export function quoteItemsValid(
  items: ItemView[],
  rules: RuleView[],
  device: { category: string; brand: string; series: string; model: string },
) {
  return (
    items.length > 0 &&
    items.every(
      (item) =>
        item.project.trim() &&
        validPositiveAmount(item.final) &&
        (!!matchRule(rules, device, item.project) || item.saveRule),
    )
  );
}
function Message({ error, success }: { error?: string; success?: boolean }) {
  const it = useMessages();
  const { locale } = useLanguage();
  return error ? (
    <p className="message error" role="alert">
      {translateError(error, locale)}
    </p>
  ) : success ? (
    <p className="message success" role="status">
      <Check size={16} />
      {it.saved}
    </p>
  ) : null;
}
export function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <label className={className}>
      <span id={id}>{label}</span>
      {Children.map(children, (child) =>
        isValidElement(child) &&
        typeof child.type === "string" &&
        ["input", "select", "textarea"].includes(child.type)
          ? cloneElement(
              child as ReactElement<{ "aria-labelledby"?: string }>,
              { "aria-labelledby": id },
            )
          : child,
      )}
    </label>
  );
}

export type CategoryView = {
  id: string;
  name: string;
  repairOnly: boolean;
};

export type CreatedProduct = {
  id: string;
  name: string;
  category: string;
  stock: number;
  reserved?: number;
  available?: number;
  costPrice?: string;
};

function ruleLinkedProducts(
  products: CreatedProduct[],
  rule: RuleView | null | undefined,
  selectedProductId?: string,
) {
  const linkedIds = new Set(
    [rule?.requiredProductId, selectedProductId].filter(Boolean),
  );
  return products.filter((product) => linkedIds.has(product.id));
}

export type ProductCompatibilityDraft = {
  category: string;
  brand: string;
  model: string;
  project: string;
};

export type DeviceCatalogDeletionView = {
  category: string;
  kind: string;
  brand: string;
  value: string;
};

export function ProductCompatibilityFields({
  value,
  onChange,
  options = [],
  canAdd = true,
  defaultCost = "",
}: {
  value: ProductCompatibilityDraft[];
  onChange: (value: ProductCompatibilityDraft[]) => void;
  options?: ProductCompatibilityDraft[];
  canAdd?: boolean;
  defaultCost?: string;
}) {
  const it = useMessages();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<CompatibilityDeviceDraft>({
    category: "PHONE",
    brand: "",
    model: "",
    projects: [],
  });
  const devices = Object.values(
    value.reduce<
      Record<
        string,
        {
          category: string;
          brand: string;
          model: string;
          projects: string[];
          indices: number[];
        }
      >
    >((groups, entry, index) => {
      const key = [entry.category, entry.brand, entry.model].join("\u0000");
      const device = groups[key] ?? {
        category: entry.category,
        brand: entry.brand,
        model: entry.model,
        projects: [],
        indices: [],
      };
      if (entry.project && !device.projects.includes(entry.project))
        device.projects.push(entry.project);
      device.indices.push(index);
      groups[key] = device;
      return groups;
    }, {}),
  );
  return (
    <>
      <fieldset className="product-compatibility-editor">
        <legend>{it.inventory.compatibleDevices}</legend>
        {devices.map((device) => (
          <div
            className="compatibility-device-row business-list-row"
            key={device.indices[0]}
          >
            <div className="compatibility-device-summary">
              <strong>
                {device.brand} {device.model}
              </strong>
              <span className="compatibility-projects">
                {device.projects.length ? (
                  device.projects.map((project) => (
                    <span className="compatibility-project-label" key={project}>
                      {project}
                      <button
                        type="button"
                        aria-label={`${it.remove} ${project}`}
                        onClick={() =>
                          onChange(
                            value.filter(
                              (entry, index) =>
                                !device.indices.includes(index) ||
                                entry.project !== project,
                            ),
                          )
                        }
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))
                ) : (
                  <span>{it.inventory.allRepairUses}</span>
                )}
              </span>
            </div>
            <button
              type="button"
              className="record-icon record-icon-delete"
              aria-label={`${it.remove} ${device.brand} ${device.model}`}
              onClick={() =>
                onChange(
                  value.filter((_, index) => !device.indices.includes(index)),
                )
              }
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          className="add-device-action"
          disabled={!canAdd}
          onClick={() => {
            setDraft({ category: "PHONE", brand: "", model: "", projects: [] });
            setDialogOpen(true);
          }}
        >
          <Plus size={16} /> {it.inventory.addCompatibility}
        </Button>
      </fieldset>
      {dialogOpen && (
        <FormDialog
          title={it.inventory.addCompatibleDevice}
          subtitle={it.inventory.compatibilityEditorHelp}
          onClose={() => setDialogOpen(false)}
        >
          <div data-form-dialog-body data-product-compatibility-dialog>
            <CompatibilityAddEditor
              value={draft}
              onChange={setDraft}
              options={options}
              associated={value}
              defaultCost={defaultCost}
            />
            <div className="dialog-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                {it.cancel}
              </Button>
              <Button
                type="button"
                disabled={
                  !draft.brand.trim() ||
                  !draft.model.trim() ||
                  !draft.projects.length
                }
                onClick={() => {
                  onChange([
                    ...value.filter(
                      (entry) =>
                        entry.category !== draft.category ||
                        entry.brand.toLocaleLowerCase("it") !==
                          draft.brand.toLocaleLowerCase("it") ||
                        modelKey(entry.model) !== modelKey(draft.model),
                    ),
                    ...draft.projects.map((project) => ({
                      category: draft.category,
                      brand: draft.brand,
                      model: draft.model,
                      project,
                    })),
                  ]);
                  setDialogOpen(false);
                }}
              >
                {it.confirm}
              </Button>
            </div>
          </div>
        </FormDialog>
      )}
    </>
  );
}
const presetInventoryCategories = [
  "Accessori",
  "Ricambi",
  "Cavi",
  "Caricabatterie",
  "Usato",
];

export function ProductForm({
  categories,
  onClose,
  mode,
  initialName = "",
  initialUsage,
  onCreated,
  quickRepair = false,
  initialCompatibility,
  projectCatalog = [],
}: {
  categories: CategoryView[];
  onClose: () => void;
  mode: "inventory" | "retail";
  initialName?: string;
  initialUsage?: "RETAIL" | "REPAIR";
  onCreated?: (product: CreatedProduct) => void;
  quickRepair?: boolean;
  initialCompatibility?: ProductCompatibilityDraft;
  projectCatalog?: ProductCompatibilityDraft[];
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [category, setCategory] = useState(quickRepair ? "Ricambi" : "");
  const [productName, setProductName] = useState(initialName);
  const [productCost, setProductCost] = useState("0");
  const [usage, setUsage] = useState<"RETAIL" | "REPAIR">(
    quickRepair ? "REPAIR" : (initialUsage ?? "RETAIL"),
  );
  const [compatibilities, setCompatibilities] = useState<
    ProductCompatibilityDraft[]
  >(() => (initialCompatibility ? [initialCompatibility] : []));
  const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);
  const nameInput = useRef<HTMLInputElement>(null);
  const costInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const target = !quickRepair
      ? nameInput.current
      : initialName
        ? costInput.current
        : null;
    if (!target) return;
    const frame = requestAnimationFrame(() => focusComfortably(target));
    return () => cancelAnimationFrame(frame);
  }, [initialName, quickRepair]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const costPrice = String(form.get("costPrice") ?? "").trim();
    const salePrice = String(form.get("salePrice") ?? "").trim();
    const quickCompatibility = compatibilities[0];
    const quickContextComplete = Boolean(
      quickCompatibility?.category.trim() &&
      quickCompatibility.brand.trim() &&
      quickCompatibility.model.trim() &&
      quickCompatibility.project.trim(),
    );
    if (quickRepair && !quickContextComplete) {
      setError(it.inventory.repairContextMissing);
      return;
    }
    const missing = [
      !name
        ? quickRepair
          ? it.inventory.repairPartName
          : it.inventory.product
        : "",
      !category ? it.inventory.category : "",
      !costPrice
        ? quickRepair
          ? it.inventory.repairPartCost
          : it.inventory.costPrice
        : "",
      (mode === "retail" || usage !== "REPAIR") && !salePrice
        ? it.inventory.salePrice
        : "",
    ].filter(Boolean);
    if (missing.length) {
      setError(
        it.missingRequiredFields.replace(
          "{fields}",
          missing.join(locale === "zh" ? "、" : ", "),
        ),
      );
      return;
    }
    const initialStock = Number(form.get("initialStock") ?? 0);
    setError("");
    startTransition(async () => {
      const result = await createProductAction({
        requestId: crypto.randomUUID(),
        name,
        category,
        usage: mode === "retail" ? "RETAIL" : usage,
        costPrice,
        salePrice: mode === "inventory" && usage === "REPAIR" ? "0" : salePrice,
        initialStock: String(initialStock),
        minStock: String(form.get("minStock") ?? "0"),
        favorite: form.get("favorite") === "on",
        enabled: true,
        compatibilities: quickRepair
          ? quickCompatibility
            ? [quickCompatibility]
            : []
          : compatibilities.filter(
              (entry) => entry.brand.trim() && entry.model.trim(),
            ),
      });
      if (!result.ok) return setError(result.error);
      if (result.id)
        onCreated?.({
          id: result.id,
          name,
          category,
          stock: initialStock,
          costPrice,
        });
      onClose();
      if (!onCreated) router.refresh();
    });
  }
  const options = [
    ...new Set([
      ...presetInventoryCategories,
      ...categories
        .filter(
          (item) =>
            !hiddenCategories.includes(item.id) &&
            (mode === "inventory" || !item.repairOnly),
        )
        .map((item) => item.name),
    ]),
  ]
    .filter((item) => mode === "inventory" || item.toLowerCase() !== "ricambi")
    .sort();
  return (
    <form
      className="dialog-form"
      onSubmit={submit}
      aria-busy={pending}
      noValidate
    >
      <div className="form-grid">
        <Field
          label={
            quickRepair ? it.inventory.repairPartName : it.inventory.product
          }
        >
          <input
            ref={nameInput}
            name="name"
            required
            maxLength={120}
            value={productName}
            onChange={(event) => setProductName(event.target.value)}
          />
        </Field>
        {!quickRepair && (
          <EditableSelect
            label={it.inventory.category}
            value={category}
            onChange={setCategory}
            options={options}
            required
            deletableValues={categories
              .filter((item) => item.name.toLocaleLowerCase("it") !== "ricambi")
              .map((item) => item.name)}
            onDelete={async (name) => {
              const selected = categories.find((item) => item.name === name);
              if (!selected) return;
              const result = await deleteInventoryCategoryAction(selected.id);
              if (!result.ok) return setError(result.error);
              setHiddenCategories((current) => [...current, selected.id]);
              if (category === name) setCategory("");
            }}
          />
        )}
        {mode === "inventory" && !quickRepair && (
          <Field label={it.inventory.usage}>
            <SimpleSelect
              name="usage"
              value={usage}
              onChange={(value) => setUsage(value as typeof usage)}
              placeholder={it.selectOption}
              ariaLabel={it.inventory.usage}
              options={[
                { value: "RETAIL", label: it.inventory.retail },
                { value: "REPAIR", label: it.inventory.repair },
              ]}
            />
          </Field>
        )}
        <Field
          label={
            quickRepair ? it.inventory.repairPartCost : it.inventory.costPrice
          }
        >
          <input
            ref={costInput}
            name="costPrice"
            inputMode="decimal"
            value={productCost}
            onChange={(event) => setProductCost(event.target.value)}
            required
          />
        </Field>
        {(mode === "retail" || usage !== "REPAIR") && (
          <Field label={it.inventory.salePrice}>
            <input
              name="salePrice"
              inputMode="decimal"
              defaultValue="0"
              required
            />
          </Field>
        )}
        <Field label={it.inventory.initialStock}>
          <QuantityStepper
            name="initialStock"
            ariaLabel={it.inventory.initialStock}
            min={0}
            defaultValue={0}
            required
          />
        </Field>
        <Field label={it.inventory.minimumStock}>
          <QuantityStepper
            name="minStock"
            ariaLabel={it.inventory.minimumStock}
            min={0}
            defaultValue={0}
            required
          />
        </Field>
      </div>
      {quickRepair && (
        <p className="product-quick-repair-context">
          {initialCompatibility?.brand.trim() &&
          initialCompatibility.model.trim() &&
          initialCompatibility.project.trim()
            ? it.inventory.repairContext
                .replace("{brand}", initialCompatibility.brand)
                .replace("{model}", initialCompatibility.model)
                .replace("{project}", initialCompatibility.project)
            : it.inventory.repairContextMissing}
        </p>
      )}
      {mode === "inventory" && usage === "REPAIR" && !quickRepair && (
        <ProductCompatibilityFields
          value={compatibilities}
          onChange={setCompatibilities}
          options={projectCatalog}
          canAdd={Boolean(productName.trim() && category.trim())}
          defaultCost={productCost}
        />
      )}
      <label className="checkbox">
        <input name="favorite" type="checkbox" />
        {quickRepair ? it.inventory.repairPartFavorite : it.inventory.favorite}
      </label>
      {error && (
        <p className="message error" role="alert">
          {translateError(error, locale)}
        </p>
      )}
      <div className="dialog-actions">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={pending}
        >
          {it.cancel}
        </Button>
        <Button disabled={pending}>
          {quickRepair
            ? it.inventory.createAndSelect
            : it.inventory.saveProduct}
        </Button>
      </div>
    </form>
  );
}

function Section({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="panel form-section">
      <h2>
        <span className="section-number">{number}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function PriceOptionPicker({
  options,
  inventoryProducts = [],
  selected,
  customProduct,
  currentPrice,
  noneSelected = false,
  open,
  disabled = false,
  ariaLabel,
  onOpenChange,
  onSelect,
  onSelectProduct,
  onRemove,
  onAdd,
}: {
  options: PriceRuleOptionView[];
  inventoryProducts?: CreatedProduct[];
  selected?: PriceRuleOptionView | null;
  customProduct?: CreatedProduct;
  currentPrice?: string;
  noneSelected?: boolean;
  open: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (optionId: string) => void;
  onSelectProduct?: (productId: string) => void;
  onRemove?: () => void;
  onAdd?: () => void;
}) {
  const it = useMessages();
  const product = selected?.product ?? customProduct;
  const available = product?.available ?? product?.stock ?? 0;
  const initialDraftOptionId =
    selected?.id ?? (product ? `product:${product.id}` : "");
  const [draftOptionId, setDraftOptionId] = useState<string | null>(
    initialDraftOptionId,
  );
  const openPicker = () => {
    setDraftOptionId(initialDraftOptionId);
    onOpenChange(true);
  };
  return (
    <>
      {product || noneSelected ? (
        <div
          className={`selection-summary selected-part-summary price-option-picker-summary${disabled ? "" : " is-actionable"}`}
          onClick={(event) => {
            if (disabled || (event.target as HTMLElement).closest("button"))
              return;
            openPicker();
          }}
        >
          <span className="selection-summary-icon is-part">
            <Package size={18} aria-hidden="true" />
          </span>
          <div className="selection-summary-copy">
            <strong>
              {product ? (selected?.name ?? product.name) : it.noRequiredPart}
            </strong>
            <small>
              {product ? (
                <>
                  {selected ? (
                    <>
                      {product.name} · {it.priceListPrice}{" "}
                      {money(cents(selected.suggested))} ·{" "}
                    </>
                  ) : (
                    <>{product.category} · </>
                  )}
                  {it.actualStock} {product.stock} · {it.reservedStock}{" "}
                  {product.reserved ?? 0} · {it.availableStock} {available} ·{" "}
                  <span
                    className={`part-stock ${available >= (selected?.quantity ?? 1) ? "is-available" : "is-empty"}`}
                  >
                    ●{" "}
                    {available >= (selected?.quantity ?? 1)
                      ? it.partInStock
                      : it.partOutOfStock}
                  </span>
                </>
              ) : (
                it.noPartOptions
              )}
            </small>
          </div>
          {currentPrice !== undefined && (
            <div className="selection-summary-value">
              <small>{it.currentQuote}</small>
              <strong>{money(cents(currentPrice))}</strong>
            </div>
          )}
          <div className="selected-part-actions">
            <button
              type="button"
              className="summary-action"
              disabled={disabled}
              onClick={openPicker}
            >
              <span>{it.change}</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
            {onRemove && !disabled && (
              <button
                type="button"
                className="quick-service-remove"
                aria-label={`${it.remove} ${product?.name ?? it.noRequiredPart}`}
                onClick={onRemove}
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="quick-service-service-add quote-required-part-add"
          disabled={disabled}
          onClick={openPicker}
        >
          <Plus size={18} /> {it.partPriceOptions}
        </button>
      )}
      {open && (
        <FormDialog
          title={it.partPriceOptions}
          onClose={() => onOpenChange(false)}
        >
          <div className="price-option-dialog" aria-label={ariaLabel}>
            <div className="price-option-list">
              {options.map((option) => (
                <button
                  type="button"
                  className={`price-option-card price-option-choice business-list-row${option.id === draftOptionId ? " is-selected" : ""}`}
                  key={option.id}
                  disabled={disabled}
                  onClick={() => setDraftOptionId(option.id)}
                >
                  <div className="price-option-card-heading">
                    <div>
                      <strong>{option.name}</strong>
                      <small>{option.product.name}</small>
                    </div>
                    {option.isDefault && (
                      <small className="price-option-card-status">
                        {it.defaultRecommended}
                      </small>
                    )}
                  </div>
                  <div className="price-option-data">
                    <span>
                      <small>{it.suggested}</small>
                      <strong>{money(cents(option.suggested))}</strong>
                    </span>
                    <span>
                      <small>{it.cost}</small>
                      <strong>
                        {option.cost ? money(cents(option.cost)) : "—"}
                      </strong>
                    </span>
                    <span>
                      <small>{it.quantity}</small>
                      <strong>{option.quantity}</strong>
                    </span>
                    <span>
                      <small>{it.durationMinutes}</small>
                      <strong>{option.minutes}</strong>
                    </span>
                    <span>
                      <small>{it.warrantyDays}</small>
                      <strong>{option.warrantyDays}</strong>
                    </span>
                    <span>
                      <small>{it.availableStock}</small>
                      <strong>
                        {option.product.available} / {option.product.stock}
                      </strong>
                    </span>
                  </div>
                </button>
              ))}
              {inventoryProducts
                .filter(
                  (entry) =>
                    !options.some((option) => option.productId === entry.id),
                )
                .map((entry) => {
                  const entryAvailable = entry.available ?? entry.stock;
                  return (
                    <button
                      type="button"
                      className={`price-option-card price-option-choice price-option-inventory business-list-row${draftOptionId === `product:${entry.id}` ? " is-selected" : ""}`}
                      key={entry.id}
                      disabled={disabled}
                      onClick={() => setDraftOptionId(`product:${entry.id}`)}
                    >
                      <div className="price-option-card-heading">
                        <div>
                          <strong>{entry.name}</strong>
                          <small>{entry.category}</small>
                        </div>
                      </div>
                      <div className="price-option-data price-option-inventory-data">
                        <span>
                          <small>{it.actualStock}</small>
                          <strong>{entry.stock}</strong>
                        </span>
                        <span>
                          <small>{it.reservedStock}</small>
                          <strong>{entry.reserved ?? 0}</strong>
                        </span>
                        <span>
                          <small>{it.availableStock}</small>
                          <strong>{entryAvailable}</strong>
                        </span>
                      </div>
                    </button>
                  );
                })}
              <button
                type="button"
                className={`price-option-card price-option-choice price-option-none business-list-row${draftOptionId === "" ? " is-selected" : ""}`}
                disabled={disabled}
                onClick={() => setDraftOptionId("")}
              >
                <span className="quick-service-picker-icon">
                  <Package size={20} aria-hidden="true" />
                </span>
                <span className="quick-service-picker-copy">
                  <strong>{it.noRequiredPart}</strong>
                  <small>{it.noPartOptions}</small>
                </span>
              </button>
            </div>
            {onAdd && (
              <button
                type="button"
                className="quick-service-picker-add price-option-add"
                disabled={disabled}
                onClick={() => {
                  onAdd();
                }}
              >
                <Plus size={16} /> {it.addPartOption}
              </button>
            )}
            <div className="quick-service-picker-footer price-option-picker-footer">
              <div className="dialog-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onOpenChange(false)}
                >
                  {it.cancel}
                </Button>
                <Button
                  type="button"
                  disabled={disabled || draftOptionId === null}
                  onClick={() => {
                    if (draftOptionId === null) return;
                    if (draftOptionId.startsWith("product:"))
                      onSelectProduct?.(draftOptionId.slice(8));
                    else onSelect(draftOptionId);
                    onOpenChange(false);
                  }}
                >
                  {it.quickService.confirmServices}
                </Button>
              </div>
            </div>
          </div>
        </FormDialog>
      )}
    </>
  );
}

export function ItemsEditor({
  items,
  onChange,
  rules,
  device,
  products = [],
  productCategories = [],
  discounts = false,
  progressive = false,
  showEmptyPartSummary = true,
  initialEdit,
  focusedEdit = false,
  onFocusedEditComplete,
  projectPicker = false,
  protectPriceOnOptionSwitch = false,
}: {
  discounts?: boolean;
  items: ItemView[];
  onChange: (items: ItemView[]) => void;
  rules: RuleView[];
  products?: {
    id: string;
    name: string;
    category: string;
    stock: number;
    reserved?: number;
    available?: number;
    costPrice?: string;
  }[];
  productCategories?: CategoryView[];
  device: { category: string; brand: string; series: string; model: string };
  owner?: boolean;
  progressive?: boolean;
  showEmptyPartSummary?: boolean;
  initialEdit?: { index: number; field: "project" | "part" };
  focusedEdit?: boolean;
  onFocusedEditComplete?: () => void;
  projectPicker?: boolean;
  protectPriceOnOptionSwitch?: boolean;
}) {
  const it = useMessages();
  const router = useRouter();
  const [createdProducts, setCreatedProducts] = useState<CreatedProduct[]>([]);
  const availableProducts = [
    ...products,
    ...createdProducts.filter(
      (created) => !products.some((product) => product.id === created.id),
    ),
  ];
  const [creatingPart, setCreatingPart] = useState<{
    index: number;
    query: string;
  } | null>(null);
  const [creatingPriceOptionRule, setCreatingPriceOptionRule] =
    useState<RuleView | null>(null);
  const [projectQueries, setProjectQueries] = useState<Record<number, string>>(
    {},
  );
  const [editingParts, setEditingParts] = useState<Record<number, boolean>>(
    initialEdit?.field === "part" ? { [initialEdit.index]: true } : {},
  );
  const [editingProjects, setEditingProjects] = useState<
    Record<number, boolean>
  >(initialEdit?.field === "project" ? { [initialEdit.index]: true } : {});
  const [editingPrices, setEditingPrices] = useState<Record<number, boolean>>(
    {},
  );
  const [temporaryProjects, setTemporaryProjects] = useState<
    Record<number, ItemView[]>
  >({});
  const [choosingProjects, setChoosingProjects] = useState(false);
  const [draftProjects, setDraftProjects] = useState<string[]>([]);
  const [pickerCustomProjects, setPickerCustomProjects] = useState<ItemView[]>(
    [],
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingPickerProject, setEditingPickerProject] = useState("");
  const [projectRemoveSuppressed, setProjectRemoveSuppressed] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [newProjectPrice, setNewProjectPrice] = useState("");
  const [newProjectPart, setNewProjectPart] = useState("");
  const priceInputs = useRef<Record<number, HTMLInputElement | null>>({});
  useEffect(() => {
    const index = Object.entries(editingPrices).find(
      ([, active]) => active,
    )?.[0];
    if (index === undefined) return;
    const frame = requestAnimationFrame(() =>
      focusComfortably(priceInputs.current[Number(index)]),
    );
    return () => cancelAnimationFrame(frame);
  }, [editingPrices]);
  const deviceKey = [
    device.category,
    device.brand,
    device.series,
    device.model,
  ].join("|");
  const previousDevice = useRef(deviceKey);
  const catalogProjects = deviceProjects(rules, device);
  const pickerProjects = [
    ...catalogProjects.map((project) => {
      const found = matchRule(rules, device, project)!;
      const option = defaultPriceOption(found.rule);
      return {
        project,
        final: option?.suggested ?? found.rule.suggested,
        notes: found.rule.notes,
        item: {
          project,
          final: option?.suggested ?? found.rule.suggested,
          adjustmentReason: "",
          discount: "0",
          discountVisible: false,
          saveRule: false,
          priceOptionId: option?.id ?? "",
          priceOptionName: option?.name ?? "",
          suggested: option?.suggested ?? found.rule.suggested,
          requiredProductId:
            option?.productId ?? found.rule.requiredProductId ?? "",
          requiredQuantity:
            option?.quantity ?? found.rule.requiredQuantity ?? 1,
          requiredProductRemoved: false,
        } satisfies ItemView,
      };
    }),
    ...pickerCustomProjects
      .filter(
        (item) =>
          !catalogProjects.some(
            (project) =>
              normalizedProject(project) === normalizedProject(item.project),
          ),
      )
      .map((item) => ({
        project: item.project,
        final: item.final,
        notes: it.afterSales.temporaryProject,
        item,
      })),
  ];
  function openProjectPicker() {
    setDraftProjects(items.map((item) => item.project).filter(Boolean));
    setPickerCustomProjects(
      items.filter(
        (item) => item.saveRule && !matchRule(rules, device, item.project),
      ),
    );
    setChoosingProjects(true);
  }
  function toggleDraftProject(project: string) {
    setDraftProjects((current) =>
      current.some(
        (value) => normalizedProject(value) === normalizedProject(project),
      )
        ? current.filter(
            (value) => normalizedProject(value) !== normalizedProject(project),
          )
        : [...current, project],
    );
  }
  function confirmProjects() {
    onChange(
      draftProjects
        .map((project) => {
          const existing = items.find(
            (item) =>
              normalizedProject(item.project) === normalizedProject(project),
          );
          return (
            existing ??
            pickerProjects.find(
              (choice) =>
                normalizedProject(choice.project) ===
                normalizedProject(project),
            )?.item
          );
        })
        .filter((item): item is ItemView => Boolean(item)),
    );
    setChoosingProjects(false);
  }
  useEffect(() => {
    if (previousDevice.current === deviceKey) return;
    previousDevice.current = deviceKey;
    setProjectQueries({});
    setEditingParts({});
    setEditingPrices({});
    setTemporaryProjects({});
    const projects = deviceProjects(rules, device);
    const next = items.map((item) => {
      const project = projects.find(
        (candidate) =>
          candidate.toLocaleLowerCase("it") ===
          item.project.trim().toLocaleLowerCase("it"),
      );
      const found = project ? matchRule(rules, device, project) : null;
      const option = defaultPriceOption(found?.rule);
      return project && found
        ? {
            ...item,
            project,
            final: option?.suggested ?? found.rule.suggested,
            priceOptionId: option?.id ?? "",
            priceOptionName: option?.name ?? "",
            suggested: option?.suggested ?? found.rule.suggested,
            requiredProductId:
              option?.productId ?? found.rule.requiredProductId ?? "",
            requiredQuantity:
              option?.quantity ?? found.rule.requiredQuantity ?? 1,
            requiredProductRemoved: false,
            suggestedAfterSwitch: undefined,
          }
        : {
            ...item,
            project: "",
            final: "",
            discount: "0",
            priceOptionId: "",
            priceOptionName: "",
            suggested: "",
            requiredProductId: "",
            requiredQuantity: 1,
            requiredProductRemoved: false,
            suggestedAfterSwitch: undefined,
          };
    });
    onChange(projectPicker ? next.filter((item) => item.project) : next);
  }, [deviceKey, device, items, rules, onChange, projectPicker]);
  const update = (index: number, patch: Partial<ItemView>) => {
    const next = items.map((item, i) =>
      i === index ? { ...item, ...patch } : item,
    );
    const changed = next[index];
    if (
      changed?.project.trim() &&
      changed.saveRule &&
      !matchRule(rules, device, changed.project)
    )
      setTemporaryProjects((current) => {
        const drafts = current[index] ?? [];
        const position = drafts.findIndex(
          (draft) =>
            normalizedProject(draft.project) ===
            normalizedProject(changed.project),
        );
        return {
          ...current,
          [index]:
            position < 0
              ? [...drafts, changed]
              : drafts.map((draft, i) => (i === position ? changed : draft)),
        };
      });
    onChange(next);
  };
  const resetItem = (index: number, project = "") =>
    update(index, {
      project,
      final: "",
      adjustmentReason: "",
      discount: "0",
      discountVisible: false,
      saveRule: false,
      priceOptionId: "",
      priceOptionName: "",
      suggested: "",
      requiredProductId: "",
      requiredQuantity: 1,
      requiredProductRemoved: false,
      suggestedAfterSwitch: undefined,
    });
  const newProjectExists = pickerProjects.some(
    (choice) =>
      normalizedProject(choice.project) === normalizedProject(newProject) &&
      normalizedProject(choice.project) !==
        normalizedProject(editingPickerProject),
  );
  return (
    <div
      className={`items-editor${projectRemoveSuppressed ? " is-remove-suppressed" : ""}`}
      onPointerMove={() => {
        if (projectRemoveSuppressed) setProjectRemoveSuppressed(false);
      }}
    >
      {items.map((item, index) => {
        if (focusedEdit && initialEdit?.index !== index) return null;
        const projects = deviceProjects(rules, device);
        const match = matchRule(rules, device, item.project);
        const priceOptions =
          match?.rule.options?.filter((option) => option.enabled) ?? [];
        const selectedPriceOption = itemPriceOption(match?.rule, item);
        const projectQuery = projectQueries[index] ?? "";
        const drafts = temporaryProjects[index] ?? [];
        const normalizedQuery = normalizedProject(projectQuery);
        const searchProjects = [
          ...projects,
          ...drafts.map((draft) => draft.project),
        ];
        const noProjectMatches =
          !!normalizedQuery &&
          !searchProjects.some((project) =>
            normalizedProject(project).includes(normalizedQuery),
          );
        const itemPriceValid = validPositiveAmount(item.final);
        const noMatchHint = !item.final.trim()
          ? it.noMatchesPriceHint
          : itemPriceValid
            ? it.customPriceReadyHint.replace(
                "{action}",
                it.afterSales.addCustomProject,
              )
            : it.customPriceInvalidHint;
        const itemSelected =
          !!item.project.trim() && (!!match || !!item.saveRule);
        const itemComplete = itemSelected && itemPriceValid;
        const editingProject =
          (focusedEdit && initialEdit?.field === "project") ||
          editingProjects[index];
        const editingPart =
          (focusedEdit && initialEdit?.field === "part") || editingParts[index];
        const selectedProduct = availableProducts.find(
          (product) => product.id === item.requiredProductId,
        );
        const selectedStock = selectedPriceOption?.product ?? selectedProduct;
        const partShortage =
          !!selectedStock &&
          Number(item.requiredQuantity ?? 1) >
            (selectedStock.available ?? selectedStock.stock);
        const switchPriceOption = (priceOptionId: string) => {
          const option = priceOptions.find(
            (candidate) => candidate.id === priceOptionId,
          );
          if (!priceOptionId) {
            update(index, {
              priceOptionId: "",
              priceOptionName: "",
              suggested: "",
              requiredProductId: "",
              requiredQuantity: 1,
              requiredProductRemoved: true,
              suggestedAfterSwitch: undefined,
            });
            if (focusedEdit) onFocusedEditComplete?.();
            return;
          }
          if (!option) return;
          const previousSuggestion =
            selectedPriceOption?.suggested ?? match?.rule.suggested ?? "";
          const manuallyAdjusted =
            protectPriceOnOptionSwitch ||
            (!!item.final.trim() &&
              numeric(item.final) !== numeric(previousSuggestion));
          update(index, {
            priceOptionId: option.id,
            priceOptionName: option.name,
            suggested: option.suggested,
            requiredProductId: option.productId,
            requiredQuantity: option.quantity,
            requiredProductRemoved: false,
            ...(manuallyAdjusted ? {} : { final: option.suggested }),
            suggestedAfterSwitch: manuallyAdjusted
              ? option.suggested
              : undefined,
          });
          if (focusedEdit) onFocusedEditComplete?.();
        };
        const createTemporaryProject = (project: string) => {
          const value = project.trim();
          if (!noProjectMatches || !value || !validPositiveAmount(item.final))
            return;
          const duplicate = searchProjects.find(
            (candidate) =>
              normalizedProject(candidate) === normalizedProject(value),
          );
          if (duplicate) return;
          setProjectQueries((current) => ({ ...current, [index]: "" }));
          setEditingProjects((current) => ({
            ...current,
            [index]: false,
          }));
          update(index, {
            project: value,
            adjustmentReason: "",
            discount: "0",
            discountVisible: false,
            saveRule: true,
            priceOptionId: "",
            priceOptionName: "",
            suggested: "",
            requiredProductId: "",
            requiredQuantity: 1,
            requiredProductRemoved: false,
          });
          if (focusedEdit) onFocusedEditComplete?.();
        };
        return (
          <div
            className={`quote-item${focusedEdit ? " is-focused-edit" : ""}`}
            key={projectPicker ? normalizedProject(item.project) : index}
          >
            {(!focusedEdit || initialEdit?.field === "project") &&
            itemSelected &&
            !editingProject ? (
              <div
                className={`selection-summary selected-project-summary${!editingPrices[index] ? " is-actionable" : ""}`}
                onClick={(event) => {
                  if (
                    editingPrices[index] ||
                    (event.target as HTMLElement).closest("button, input")
                  )
                    return;
                  if (projectPicker) {
                    openProjectPicker();
                    return;
                  }
                  setEditingProjects((current) => ({
                    ...current,
                    [index]: true,
                  }));
                }}
              >
                <span className="selection-summary-icon is-project">
                  <Wrench size={18} aria-hidden="true" />
                </span>
                <div className="selection-summary-copy">
                  <strong>{item.project}</strong>
                  <small>
                    {match
                      ? `${it.priceListProject} · ${device.brand} ${device.model}`
                      : it.afterSales.temporaryProject}
                  </small>
                </div>
                <div className="selection-summary-value">
                  <small>{it.currentQuote}</small>
                  {editingPrices[index] ? (
                    <div className="quote-summary-price-field">
                      <input
                        ref={(element) => {
                          priceInputs.current[index] = element;
                        }}
                        className="quote-summary-price"
                        aria-label={`${it.final} ${index + 1}`}
                        inputMode="decimal"
                        value={item.final}
                        aria-invalid={!itemPriceValid}
                        onChange={(event) =>
                          update(index, { final: event.target.value })
                        }
                        onBlur={() => {
                          if (itemPriceValid)
                            setEditingPrices((current) => ({
                              ...current,
                              [index]: false,
                            }));
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          event.stopPropagation();
                          if (itemPriceValid) event.currentTarget.blur();
                        }}
                      />
                      {!itemPriceValid && (
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
                        setEditingPrices((current) => ({
                          ...current,
                          [index]: true,
                        }))
                      }
                    >
                      <strong>{money(cents(item.final))}</strong>
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
                {projectPicker ? (
                  !editingPrices[index] && (
                    <div className="selected-part-actions">
                      <button
                        type="button"
                        className="summary-action"
                        onClick={openProjectPicker}
                      >
                        <span>{it.change}</span>
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="quick-service-remove"
                        aria-label={`${it.remove} ${item.project}`}
                        onClick={(event) => {
                          event.currentTarget.blur();
                          setProjectRemoveSuppressed(true);
                          onChange(
                            items.filter((_, itemIndex) => itemIndex !== index),
                          );
                        }}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )
                ) : (
                  <button
                    type="button"
                    className="summary-action"
                    onClick={() =>
                      setEditingProjects((current) => ({
                        ...current,
                        [index]: true,
                      }))
                    }
                  >
                    <span>{it.change}</span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : projectPicker ? null : !focusedEdit ||
              initialEdit?.field === "project" ? (
              <>
                <SearchableCombobox
                  className="repair-project-combobox"
                  value={item.project}
                  ariaLabel={`${it.project} ${index + 1}`}
                  placeholder={it.afterSales.projectPlaceholder}
                  searchPlaceholder={it.afterSales.projectSearch}
                  emptyText={
                    projects.length
                      ? it.afterSales.noProjectMatches
                      : it.afterSales.noDeviceProjects
                  }
                  customLabel={it.afterSales.addCustomProject}
                  customDisabled={!validPositiveAmount(item.final)}
                  creationControls="no-match"
                  showEmptyPanel={false}
                  preserveQueryOnClose
                  clearable
                  autoFocusQuery={editingProject ? item.project : undefined}
                  onClose={() => {
                    if (focusedEdit) return;
                    setEditingProjects((current) => ({
                      ...current,
                      [index]: false,
                    }));
                  }}
                  middleControl={
                    <div className="quote-price-field">
                      <input
                        ref={(element) => {
                          priceInputs.current[index] = element;
                        }}
                        className="quote-price-input"
                        aria-label={`${it.final} ${index + 1}`}
                        placeholder={it.final}
                        inputMode="decimal"
                        required
                        disabled={!noProjectMatches}
                        value={item.final}
                        aria-invalid={
                          noProjectMatches && !validPositiveAmount(item.final)
                        }
                        onChange={(event) =>
                          update(index, { final: event.target.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          event.stopPropagation();
                          createTemporaryProject(projectQuery);
                        }}
                      />
                    </div>
                  }
                  groups={[
                    {
                      options: projects.map((project) => {
                        const found = matchRule(rules, device, project);
                        return {
                          value: project,
                          label: project,
                          trailing: found
                            ? money(cents(found.rule.suggested))
                            : undefined,
                          secondary: found?.rule.notes || undefined,
                        };
                      }),
                    },
                    {
                      options: drafts.map((draft) => ({
                        value: draft.project,
                        label: draft.project,
                        secondary: it.afterSales.temporaryProject,
                      })),
                    },
                  ]}
                  onQueryChange={(query) => {
                    setProjectQueries((current) => ({
                      ...current,
                      [index]: query,
                    }));
                  }}
                  onCustom={createTemporaryProject}
                  onNoMatchEnter={(project) => {
                    setProjectQueries((current) => ({
                      ...current,
                      [index]: project,
                    }));
                    requestAnimationFrame(() =>
                      focusComfortably(priceInputs.current[index]),
                    );
                  }}
                  onChange={(project) => {
                    const found = matchRule(rules, device, project);
                    const option = defaultPriceOption(found?.rule);
                    const draft = drafts.find(
                      (candidate) =>
                        normalizedProject(candidate.project) ===
                        normalizedProject(project),
                    );
                    setProjectQueries((current) => ({
                      ...current,
                      [index]: "",
                    }));
                    setEditingParts((current) => ({
                      ...current,
                      [index]: false,
                    }));
                    if (!project) resetItem(index);
                    else if (draft) update(index, draft);
                    else
                      update(index, {
                        project,
                        final: option?.suggested ?? found?.rule.suggested ?? "",
                        adjustmentReason: "",
                        discount: "0",
                        discountVisible: false,
                        saveRule: false,
                        priceOptionId: option?.id ?? "",
                        priceOptionName: option?.name ?? "",
                        suggested:
                          option?.suggested ?? found?.rule.suggested ?? "",
                        requiredProductId:
                          option?.productId ??
                          found?.rule.requiredProductId ??
                          "",
                        requiredQuantity:
                          option?.quantity ?? found?.rule.requiredQuantity ?? 1,
                        requiredProductRemoved: false,
                        suggestedAfterSwitch: undefined,
                      });
                    if (project) {
                      if (focusedEdit) onFocusedEditComplete?.();
                      else
                        setEditingProjects((current) => ({
                          ...current,
                          [index]: false,
                        }));
                    }
                  }}
                />
                {noProjectMatches && (
                  <p className="repair-project-no-match-hint">{noMatchHint}</p>
                )}
              </>
            ) : null}
            {(!focusedEdit || initialEdit?.field === "part") &&
              (!progressive || itemComplete) && (
                <div className="quote-progressive-reveal">
                  <div className="quote-required-part">
                    {!focusedEdit && (
                      <strong className="quote-required-part-label">
                        {match
                          ? it.partPriceOption
                          : `${it.requiredPart} (${it.optional})`}
                      </strong>
                    )}
                    {match ? (
                      <PriceOptionPicker
                        options={priceOptions}
                        inventoryProducts={
                          priceOptions.length
                            ? []
                            : ruleLinkedProducts(
                                availableProducts,
                                match?.rule,
                                item.requiredProductId,
                              )
                        }
                        selected={selectedPriceOption}
                        customProduct={selectedProduct}
                        currentPrice={item.final}
                        noneSelected={Boolean(item.requiredProductRemoved)}
                        open={Boolean(editingPart)}
                        ariaLabel={`${it.partPriceOption} ${index + 1}`}
                        onOpenChange={(open) => {
                          if (focusedEdit && !open) onFocusedEditComplete?.();
                          else
                            setEditingParts((current) => ({
                              ...current,
                              [index]: open,
                            }));
                        }}
                        onSelect={switchPriceOption}
                        onSelectProduct={(requiredProductId) => {
                          update(index, {
                            requiredProductId,
                            requiredQuantity: 1,
                            requiredProductRemoved: false,
                            priceOptionId: "",
                            priceOptionName: "",
                            suggested: "",
                            suggestedAfterSwitch: undefined,
                          });
                          if (focusedEdit) onFocusedEditComplete?.();
                        }}
                        onRemove={() =>
                          update(index, {
                            requiredProductId: "",
                            requiredQuantity: 1,
                            requiredProductRemoved: false,
                            priceOptionId: "",
                            priceOptionName: "",
                            suggestedAfterSwitch: undefined,
                          })
                        }
                        onAdd={() =>
                          setCreatingPriceOptionRule(match?.rule ?? null)
                        }
                      />
                    ) : selectedProduct && !editingPart ? (
                      <div
                        className="selection-summary selected-part-summary is-actionable"
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest("button"))
                            return;
                          setEditingParts((current) => ({
                            ...current,
                            [index]: true,
                          }));
                        }}
                      >
                        <span className="selection-summary-icon is-part">
                          <Package size={18} aria-hidden="true" />
                        </span>
                        <div className="selection-summary-copy">
                          <strong>{selectedProduct.name}</strong>
                          <small>
                            {selectedProduct.category} · {it.actualStock}{" "}
                            {selectedProduct.stock} · {it.reservedStock}{" "}
                            {selectedProduct.reserved ?? 0} ·{" "}
                            {it.availableStock}{" "}
                            {selectedProduct.available ?? selectedProduct.stock}{" "}
                            ·{" "}
                            <span
                              className={`part-stock ${(selectedProduct.available ?? selectedProduct.stock) > 0 ? "is-available" : "is-empty"}`}
                            >
                              ●{" "}
                              {(selectedProduct.available ??
                                selectedProduct.stock) > 0
                                ? it.partInStock
                                : it.partOutOfStock}
                            </span>
                          </small>
                        </div>
                        <div className="selected-part-actions">
                          <button
                            type="button"
                            className="summary-action"
                            onClick={() =>
                              setEditingParts((current) => ({
                                ...current,
                                [index]: true,
                              }))
                            }
                          >
                            <span>{it.change}</span>
                            <ChevronRight size={15} aria-hidden="true" />
                          </button>
                          {projectPicker && (
                            <button
                              type="button"
                              className="quick-service-remove"
                              aria-label={`${it.remove} ${selectedProduct.name}`}
                              onClick={() =>
                                update(index, {
                                  requiredProductId: "",
                                  requiredQuantity: 1,
                                  requiredProductRemoved: true,
                                })
                              }
                            >
                              <X size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                    ) : projectPicker &&
                      item.requiredProductRemoved &&
                      !editingPart ? (
                      <div
                        className="selection-summary selected-part-summary is-actionable"
                        onClick={() =>
                          setEditingParts((current) => ({
                            ...current,
                            [index]: true,
                          }))
                        }
                      >
                        <span className="selection-summary-icon is-part">
                          <Package size={18} aria-hidden="true" />
                        </span>
                        <div className="selection-summary-copy">
                          <strong>{it.afterSales.noPart}</strong>
                        </div>
                        <button
                          type="button"
                          className="summary-action"
                          onClick={() =>
                            setEditingParts((current) => ({
                              ...current,
                              [index]: true,
                            }))
                          }
                        >
                          <span>{it.change}</span>
                          <ChevronRight size={15} aria-hidden="true" />
                        </button>
                      </div>
                    ) : projectPicker && !editingPart ? (
                      <button
                        type="button"
                        className="quick-service-service-add quote-required-part-add"
                        onClick={() =>
                          setEditingParts((current) => ({
                            ...current,
                            [index]: true,
                          }))
                        }
                      >
                        <Plus size={18} /> {it.repairPart}
                      </button>
                    ) : showEmptyPartSummary && !editingPart ? (
                      <div
                        className="selection-summary selected-part-summary is-actionable"
                        onClick={() =>
                          setEditingParts((current) => ({
                            ...current,
                            [index]: true,
                          }))
                        }
                      >
                        <span className="selection-summary-icon is-part">
                          <Package size={18} aria-hidden="true" />
                        </span>
                        <div className="selection-summary-copy">
                          <strong>{it.afterSales.noPart}</strong>
                        </div>
                        <button
                          type="button"
                          className="summary-action"
                          onClick={() =>
                            setEditingParts((current) => ({
                              ...current,
                              [index]: true,
                            }))
                          }
                        >
                          <span>{it.change}</span>
                          <ChevronRight size={15} aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <SearchableCombobox
                        className="repair-part-combobox"
                        value={item.requiredProductId ?? ""}
                        onChange={(requiredProductId) => {
                          update(index, {
                            requiredProductId,
                            requiredQuantity: 1,
                            requiredProductRemoved: !requiredProductId,
                          });
                          if (!focusedEdit)
                            setEditingParts((current) => ({
                              ...current,
                              [index]: false,
                            }));
                          else onFocusedEditComplete?.();
                        }}
                        ariaLabel={`${it.requiredPart} ${index + 1}`}
                        placeholder={it.searchInventoryPart}
                        searchPlaceholder={it.searchInventoryPart}
                        emptyText={it.noMatches}
                        autoFocusQuery={
                          editingPart
                            ? (selectedProduct?.name ?? "")
                            : undefined
                        }
                        groups={[
                          ...(editingPart && selectedProduct
                            ? [
                                {
                                  options: [
                                    { value: "", label: it.noRequiredPart },
                                  ],
                                },
                              ]
                            : []),
                          {
                            options: availableProducts.map((product) => ({
                              value: product.id,
                              label: product.name,
                              secondary: product.category,
                              keywords: product.category,
                              trailing: (
                                <span
                                  className={`part-stock ${(product.available ?? product.stock) > 0 ? "is-available" : "is-empty"}`}
                                >
                                  {it.actualStock} {product.stock} ·{" "}
                                  {it.reservedStock} {product.reserved ?? 0} ·{" "}
                                  {it.availableStock}{" "}
                                  {product.available ?? product.stock} · ●{" "}
                                  {(product.available ?? product.stock) > 0
                                    ? it.partInStock
                                    : it.partOutOfStock}
                                </span>
                              ),
                            })),
                          },
                        ]}
                        onClose={() => {
                          if (focusedEdit) return;
                          setEditingParts((current) => ({
                            ...current,
                            [index]: false,
                          }));
                        }}
                        customLabel={it.newPart}
                        onCustom={(query) => setCreatingPart({ index, query })}
                        creationControls="no-match"
                        clearable
                        commitEmptyOnClose
                      />
                    )}
                  </div>
                  {partShortage && (
                    <p className="message warning">
                      {it.requiredPartOutOfStock}
                    </p>
                  )}
                  {item.suggestedAfterSwitch && (
                    <div className="message warning quote-price-switch-notice">
                      <span>
                        {it.partChangedKeepsPrice.replace(
                          "{price}",
                          money(cents(item.suggestedAfterSwitch)),
                        )}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          update(index, {
                            final: item.suggestedAfterSwitch,
                            adjustmentReason: "",
                            suggestedAfterSwitch: undefined,
                          });
                        }}
                      >
                        {it.useSuggestedPrice}
                      </Button>
                    </div>
                  )}
                  {!focusedEdit &&
                    discounts &&
                    (item.discountVisible ||
                      numeric(item.discount ?? "0") > 0) && (
                      <Field label={`${it.itemDiscount} ${index + 1}`}>
                        <input
                          inputMode="decimal"
                          required
                          value={item.discount ?? "0"}
                          onChange={(e) =>
                            update(index, { discount: e.target.value })
                          }
                        />
                      </Field>
                    )}
                  {!focusedEdit && (
                    <div className="item-actions">
                      {discounts && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            update(index, {
                              discountVisible: !(
                                item.discountVisible ||
                                numeric(item.discount ?? "0") > 0
                              ),
                              discount: "0",
                            })
                          }
                        >
                          {item.discountVisible ||
                          numeric(item.discount ?? "0") > 0
                            ? it.cancelDiscount
                            : it.addItemDiscount}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            {!projectPicker && !focusedEdit && items.length > 1 && (
              <RecordIcon
                kind="delete"
                label={it.remove + " " + it.project + " " + (index + 1)}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              />
            )}
          </div>
        );
      })}
      {!projectPicker &&
        !focusedEdit &&
        (!progressive ||
          items.every(
            (item) => item.project.trim() && validAmount(item.final),
          )) && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onChange([...items, blankItem()])}
          >
            <Plus size={16} />
            {it.addItem}
          </Button>
        )}
      {projectPicker && (
        <button
          type="button"
          className="quick-service-service-add"
          onClick={openProjectPicker}
        >
          <Plus size={18} /> {it.project}
        </button>
      )}
      {!focusedEdit &&
        (!progressive ||
          items.some(
            (item) => item.project.trim() && validAmount(item.final),
          )) && (
          <div className="quote-total quote-progressive-reveal">
            <span>{it.originalTotal}</span>
            <strong>
              {money(items.reduce((sum, item) => sum + numeric(item.final), 0))}
            </strong>
          </div>
        )}
      {choosingProjects && (
        <FormDialog
          title={it.selectRepairProjects}
          subtitle={it.repairProjectPickerHelp}
          onClose={() => setChoosingProjects(false)}
        >
          <div className="quick-service-picker">
            <div className="quick-service-picker-list">
              {pickerProjects.map((choice) => {
                const selected = draftProjects.some(
                  (project) =>
                    normalizedProject(project) ===
                    normalizedProject(choice.project),
                );
                const custom = pickerCustomProjects.find(
                  (item) =>
                    normalizedProject(item.project) ===
                    normalizedProject(choice.project),
                );
                return (
                  <article
                    className={`quick-service-picker-option quick-service-picker-service business-list-row${selected ? " is-selected" : ""}`}
                    key={normalizedProject(choice.project)}
                    onClick={() => toggleDraftProject(choice.project)}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      aria-label={`${it.selectOption} ${choice.project}`}
                      onChange={() => toggleDraftProject(choice.project)}
                      onClick={(event) => event.stopPropagation()}
                    />
                    <span className="quick-service-picker-icon">
                      <Wrench size={22} aria-hidden="true" />
                    </span>
                    <span className="quick-service-picker-copy">
                      <strong>{choice.project}</strong>
                      <small>{choice.notes || it.priceListProject}</small>
                    </span>
                    <strong className="quick-service-picker-price">
                      {money(cents(choice.final))}
                    </strong>
                    {custom && (
                      <div
                        className="record-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <RecordIcon
                          kind="edit"
                          label={`${it.edit} ${choice.project}`}
                          onClick={() => {
                            setEditingPickerProject(choice.project);
                            setNewProject(custom.project);
                            setNewProjectPrice(custom.final);
                            setNewProjectPart(custom.requiredProductId ?? "");
                            setChoosingProjects(false);
                            setCreatingProject(true);
                          }}
                        />
                        <RecordIcon
                          kind="delete"
                          label={`${it.remove} ${choice.project}`}
                          onClick={() => {
                            setPickerCustomProjects((current) =>
                              current.filter(
                                (item) =>
                                  normalizedProject(item.project) !==
                                  normalizedProject(choice.project),
                              ),
                            );
                            setDraftProjects((current) =>
                              current.filter(
                                (project) =>
                                  normalizedProject(project) !==
                                  normalizedProject(choice.project),
                              ),
                            );
                          }}
                        />
                      </div>
                    )}
                  </article>
                );
              })}
              {!pickerProjects.length && (
                <p className="muted">{it.afterSales.noDeviceProjects}</p>
              )}
            </div>
            <button
              type="button"
              className="quick-service-picker-add"
              onClick={() => {
                setNewProject("");
                setNewProjectPrice("");
                setNewProjectPart("");
                setEditingPickerProject("");
                setChoosingProjects(false);
                setCreatingProject(true);
              }}
            >
              <Plus size={16} /> {it.project}
            </button>
            <div className="quick-service-picker-footer">
              <strong>
                {it.selectedRepairProjects.replace(
                  "{count}",
                  String(draftProjects.length),
                )}
              </strong>
              <div className="dialog-actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setChoosingProjects(false)}
                >
                  {it.cancel}
                </Button>
                <Button type="button" onClick={confirmProjects}>
                  {it.quickService.confirmServices}
                </Button>
              </div>
            </div>
          </div>
        </FormDialog>
      )}
      {creatingProject && (
        <FormDialog
          title={
            editingPickerProject ? it.edit : it.afterSales.addCustomProject
          }
          onClose={() => {
            setCreatingProject(false);
            setEditingPickerProject("");
            setChoosingProjects(true);
          }}
        >
          <div className="quick-service-custom-project">
            <Field label={`${it.project} *`}>
              <input
                autoFocus
                value={newProject}
                onChange={(event) => setNewProject(event.target.value)}
              />
            </Field>
            <Field label={`${it.final} *`}>
              <input
                inputMode="decimal"
                value={newProjectPrice}
                onChange={(event) => setNewProjectPrice(event.target.value)}
                aria-invalid={
                  Boolean(newProjectPrice) &&
                  !validPositiveAmount(newProjectPrice)
                }
              />
            </Field>
            <Field label={`${it.requiredPart} (${it.optional})`}>
              <SearchableCombobox
                value={newProjectPart}
                onChange={setNewProjectPart}
                ariaLabel={it.requiredPart}
                placeholder={it.noRequiredPart}
                searchPlaceholder={it.searchInventoryPart}
                emptyText={it.noMatches}
                clearable
                groups={[
                  {
                    options: availableProducts.map((product) => ({
                      value: product.id,
                      label: product.name,
                      secondary: product.category,
                    })),
                  },
                ]}
              />
            </Field>
            {newProjectExists && (
              <p className="field-error">{it.repairProjectExists}</p>
            )}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreatingProject(false);
                  setEditingPickerProject("");
                  setChoosingProjects(true);
                }}
              >
                {it.cancel}
              </Button>
              <Button
                type="button"
                disabled={
                  !newProject.trim() ||
                  !validPositiveAmount(newProjectPrice) ||
                  newProjectExists
                }
                onClick={() => {
                  const item: ItemView = {
                    project: newProject.trim(),
                    final: newProjectPrice,
                    adjustmentReason: "",
                    discount: "0",
                    discountVisible: false,
                    saveRule: true,
                    requiredProductId: newProjectPart,
                    requiredQuantity: 1,
                    requiredProductRemoved: false,
                  };
                  setPickerCustomProjects((current) =>
                    editingPickerProject
                      ? current.map((project) =>
                          normalizedProject(project.project) ===
                          normalizedProject(editingPickerProject)
                            ? item
                            : project,
                        )
                      : [...current, item],
                  );
                  setDraftProjects((current) =>
                    editingPickerProject
                      ? current.map((project) =>
                          normalizedProject(project) ===
                          normalizedProject(editingPickerProject)
                            ? item.project
                            : project,
                        )
                      : [...current, item.project],
                  );
                  setCreatingProject(false);
                  setEditingPickerProject("");
                  setChoosingProjects(true);
                }}
              >
                {it.save}
              </Button>
            </div>
          </div>
        </FormDialog>
      )}
      {creatingPart && (
        <FormDialog
          title={it.newRepairPart}
          onClose={() => setCreatingPart(null)}
        >
          <ProductForm
            categories={productCategories}
            mode="inventory"
            initialName={creatingPart.query}
            initialUsage="REPAIR"
            quickRepair
            initialCompatibility={{
              category: device.category,
              brand: device.brand,
              model: device.model,
              project: items[creatingPart.index]?.project ?? "",
            }}
            onClose={() => setCreatingPart(null)}
            onCreated={(product) => {
              setCreatedProducts((current) => [...current, product]);
              update(creatingPart.index, {
                requiredProductId: product.id,
                requiredQuantity: 1,
                requiredProductRemoved: false,
              });
            }}
          />
        </FormDialog>
      )}
      {creatingPriceOptionRule && (
        <FormDialog
          title={it.newPartOption}
          onClose={() => setCreatingPriceOptionRule(null)}
        >
          <PriceRuleOptionForm
            rule={creatingPriceOptionRule}
            products={availableProducts.map((product) => ({
              id: product.id,
              name: product.name,
              category: product.category,
              stockQuantity: product.stock,
              costPrice: product.costPrice,
            }))}
            productCategories={productCategories}
            compatibility={{
              category: device.category,
              brand: device.brand,
              model: device.model,
              project: creatingPriceOptionRule.project,
            }}
            onSuccess={() => {
              setCreatingPriceOptionRule(null);
              router.refresh();
            }}
          />
        </FormDialog>
      )}
    </div>
  );
}

export function NewOrderForm({
  rules,
  faultOptions,
  devices,
  customers,
}: {
  rules: RuleView[];
  owner?: boolean;
  faultOptions: { category: string; name: string; hidden: boolean }[];
  devices: { category: string; brand: string; model: string }[];
  customers: {
    id: string;
    name: string;
    phone: string;
    phones: { phone: string }[];
  }[];
}) {
  const it = useMessages();
  const today = useBusinessDay();
  const { locale } = useLanguage();
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [customer, setCustomer] =
    useState<Awaited<ReturnType<typeof lookupCustomerAction>>>(null);
  const [customerConfirmed, setCustomerConfirmed] = useState(false);
  const [hiddenFaults, setHiddenFaults] = useState<string[]>([]);
  const [managingFaults, setManagingFaults] = useState(false);
  const [customFault, setCustomFault] = useState("");
  const [localFaults, setLocalFaults] = useState<string[]>([]);
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [paymentNow, setPaymentNow] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<z.input<typeof orderInput>, unknown, z.output<typeof orderInput>>(
    {
      resolver: zodResolver(orderInput),
      defaultValues: {
        requestId,
        customerName: "",
        phone: "",
        additionalPhones: [],
        privacyConsent: false,
        deviceId: "",
        category: "PHONE",
        brand: "",
        series: "",
        model: "",
        imei: "",
        appearance: "",
        accessories: "",
        fault: "",
        faults: [],
        notes: "",
        dueDate: "",
        items: [blankItem()],
        diagnosticFee: "10",
        deposit: "0",
        method: "CASH",
        paymentKind: "DEPOSIT",
        orderDiscount: "0",
        includeVat: false,
      },
    },
  );
  const values = useWatch({ control }) as z.input<typeof orderInput>;
  const category = values.category ?? "PHONE";
  const diagnostic = isDiagnosticFault([
    ...(values.faults ?? []),
    values.fault ?? "",
  ]);
  useEffect(() => {
    if ((values.phone ?? "").trim().length < 6) {
      return;
    }
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const found = await lookupCustomerAction(values.phone);
        if (active) {
          setCustomer(found);
          if (found) {
            setValue("customerName", found.name);
            setValue("phone", found.phone);
            setValue(
              "additionalPhones",
              found.phones.map((p) => p.phone).filter((p) => p !== found.phone),
            );
          }
        }
      } catch {
        if (active) setError("Connessione non disponibile. Riprova.");
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [values.phone, setValue]);
  const knownDevices = devices.filter((d) => d.category === category);
  const brandOptions = [
    ...new Set([
      ...brands[category],
      ...knownDevices.map((d) => d.brand),
      ...rules.filter((r) => r.category === category).map((r) => r.brand),
    ]),
  ];
  const modelOptions = [
    ...new Set([
      ...(models[category]?.[values.brand] ?? []),
      ...knownDevices
        .filter((d) => d.brand.toLowerCase() === values.brand.toLowerCase())
        .map((d) => d.model),
      ...rules
        .filter(
          (r) =>
            r.category === category &&
            r.brand.toLowerCase() === values.brand.toLowerCase() &&
            r.model,
        )
        .map((r) => r.model),
    ]),
  ];
  const presets = faultPresets(category);
  const faults = [
    ...new Map(
      [
        ...presets.map(([name, zh]) => ({
          name,
          label: locale === "zh" ? zh : name,
        })),
        ...faultOptions
          .filter((f) => f.category === category)
          .map((f) => ({
            name: f.name,
            label:
              presets.find(([n]) => n.toLowerCase() === f.name.toLowerCase())?.[
                locale === "zh" ? 1 : 0
              ] ?? f.name,
          })),
        ...localFaults.map((name) => ({ name, label: name })),
      ].map((f) => [f.name.toLowerCase(), f]),
    ).values(),
  ];
  const visibleFaults = faults.filter(
    (f) =>
      !faultOptions.some(
        (o) =>
          o.category === category &&
          o.hidden &&
          o.name.toLowerCase() === f.name.toLowerCase(),
      ) && !hiddenFaults.includes(category + ":" + f.name.toLowerCase()),
  );
  const customerUnchanged =
    !!customer &&
    values.customerName === customer.name &&
    values.phone === customer.phone &&
    JSON.stringify([...(values.additionalPhones ?? [])].sort()) ===
      JSON.stringify(
        customer.phones
          .map((p) => p.phone)
          .filter((p) => p !== customer.phone)
          .sort(),
      );
  async function confirmCustomer() {
    setError("");
    try {
      const found = await lookupCustomerAction(values.phone);
      if (!found && !window.confirm(it.addCustomerPrompt)) return false;
      const result = await customerAction(found?.id ?? null, {
        name: values.customerName,
        phone: found?.phone ?? values.phone,
        additionalPhones: values.additionalPhones ?? [],
      });
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      const saved = await lookupCustomerAction(values.phone);
      setCustomer(saved);
      setCustomerConfirmed(true);
      return true;
    } catch {
      setError("Connessione non disponibile. Riprova.");
      return false;
    }
  }
  const clearDevice = () => {
    setValue("deviceId", "");
    setValue("brand", "");
    setValue("series", "");
    setValue("model", "");
    setValue("imei", "");
  };
  return (
    <form
      className="order-form"
      onSubmit={handleSubmit(async (data) => {
        setPending(true);
        setError("");
        try {
          if (!customerConfirmed && !(await confirmCustomer())) return;
          const result = await createOrderAction(data);
          if (result.ok) router.push(`/orders/${result.id}`);
          else setError(result.error);
        } catch {
          setError("Connessione non disponibile. Riprova.");
        } finally {
          setPending(false);
        }
      })}
    >
      <Section number="01" title={it.customerSection}>
        <div className="form-grid">
          <EditableSelect
            label={it.phone}
            value={values.phone}
            required
            maxLength={30}
            options={customers.flatMap((c) =>
              uniqueOptions([c.phone, ...c.phones.map((p) => p.phone)]).map(
                (phone) => ({ value: phone, label: phone + " · " + c.name }),
              ),
            )}
            onChange={(phone) => {
              if (phone === values.phone) return;
              setValue("phone", phone);
              setCustomer(null);
              setCustomerConfirmed(false);
              setValue("customerName", "");
              setValue("additionalPhones", []);
              clearDevice();
            }}
          />
          <EditableSelect
            label={it.name}
            value={values.customerName}
            required
            options={customers.map((c) => ({
              value: c.id,
              label: c.name + " · " + c.phone,
            }))}
            onChange={(value) => {
              const found = customers.find((c) => c.id === value);
              setCustomerConfirmed(false);
              if (found) {
                clearDevice();
                setValue("customerName", found.name, { shouldDirty: true });
                setValue("phone", found.phone);
                setValue(
                  "additionalPhones",
                  found.phones
                    .map((phone) => phone.phone)
                    .filter((phone) => phone !== found.phone),
                );
                void lookupCustomerAction(found.phone).then((customer) =>
                  setCustomer(customer),
                );
              } else {
                setValue("customerName", value, { shouldDirty: true });
              }
            }}
          />
        </div>
        {(values.additionalPhones ?? []).map((phone, index) => (
          <div className="phone-row" key={index}>
            <Field label={it.phone + " " + (index + 2)}>
              <input
                type="tel"
                value={phone}
                required
                maxLength={30}
                onChange={(e) => {
                  setValue(
                    "additionalPhones",
                    (values.additionalPhones ?? []).map((p, i) =>
                      i === index ? e.target.value : p,
                    ),
                  );
                  setCustomerConfirmed(false);
                }}
              />
            </Field>
            <RecordIcon
              kind="delete"
              label={it.remove + " " + it.phone + " " + (index + 2)}
              onClick={() => {
                setValue(
                  "additionalPhones",
                  (values.additionalPhones ?? []).filter((_, i) => i !== index),
                );
                setCustomerConfirmed(false);
              }}
            />
          </div>
        ))}
        <div className="catalog-toolbar">
          <Button
            type="button"
            variant="outline"
            disabled={(values.additionalPhones ?? []).length >= 2}
            onClick={() => {
              setValue("additionalPhones", [
                ...(values.additionalPhones ?? []),
                "",
              ]);
              setCustomerConfirmed(false);
            }}
          >
            {it.addPhone}
          </Button>
          <Button
            type="button"
            disabled={pending || customerUnchanged}
            onClick={async () => {
              setPending(true);
              try {
                await confirmCustomer();
              } finally {
                setPending(false);
              }
            }}
          >
            {it.confirmCustomer}
          </Button>
          {customerConfirmed && (
            <span role="status">{it.customerConfirmed}</span>
          )}
        </div>
        {customer && <p className="quote-hint">{it.customerFound}</p>}
      </Section>
      <Section number="02" title={it.deviceSection}>
        {customer && customer.devices.length > 0 && (
          <Field label={it.chooseDevice}>
            <SimpleSelect
              value={values.deviceId}
              onChange={(deviceId) => {
                const d = customer.devices.find((d) => d.id === deviceId);
                setValue("deviceId", deviceId);
                const nextCategory = (d?.category ?? "PHONE") as Category;
                setValue("category", nextCategory);
                for (const key of [
                  "brand",
                  "series",
                  "model",
                  "imei",
                  "appearance",
                ] as const)
                  setValue(key, d?.[key] ?? "");
                setValue("faults", []);
                setLocalFaults([]);
              }}
              placeholder={it.newDevice}
              ariaLabel={it.chooseDevice}
              options={[
                { value: "", label: it.newDevice },
                ...customer.devices.map((device) => ({
                  value: device.id,
                  label: `${device.brand} ${device.model}`,
                  secondary: device.imei ?? undefined,
                })),
              ]}
            />
          </Field>
        )}
        <div className="form-grid three">
          <Field label={it.deviceType}>
            <input type="hidden" {...register("category")} />
            <SimpleSelect
              value={category}
              onChange={(next) => {
                setValue("category", next as Category);
                clearDevice();
                setValue("faults", []);
                setLocalFaults([]);
              }}
              disabled={!!values.deviceId}
              placeholder={it.selectOption}
              ariaLabel={it.deviceType}
              options={Object.entries(categories).map(([key, names]) => ({
                value: key,
                label: names[locale === "zh" ? 1 : 0],
              }))}
            />
          </Field>
          <EditableSelect
            label={it.brand}
            createLabel={it.customBrand}
            value={values.brand}
            required
            readOnly={!!values.deviceId}
            options={uniqueOptions(brandOptions)}
            normalize={normalizeBrand}
            onChange={(brand) => {
              setValue("brand", brand);
              setValue("model", "");
              setValue("series", "");
            }}
          />
          <EditableSelect
            label={it.model}
            createLabel={it.customModel}
            value={values.model}
            required
            readOnly={!!values.deviceId}
            options={uniqueOptions(modelOptions)}
            normalize={(model) => normalizeDeviceModel(values.brand, model)}
            onChange={(model) => setValue("model", model)}
          />
        </div>
        <div className="fault-options-heading">
          <strong>{it.fault}</strong>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setManagingFaults(!managingFaults)}
          >
            {managingFaults ? it.finishFaultManagement : it.manageFaults}
          </Button>
        </div>
        <fieldset className="fault-options" aria-label={it.fault}>
          {visibleFaults.map((f) => (
            <div className="fault-row" key={f.name}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={(values.faults ?? []).includes(f.name)}
                  onChange={(e) =>
                    setValue(
                      "faults",
                      e.target.checked
                        ? [...(values.faults ?? []), f.name]
                        : (values.faults ?? []).filter((n) => n !== f.name),
                    )
                  }
                />
                {f.label}
              </label>
              {managingFaults && (
                <button
                  type="button"
                  className="record-icon record-icon-delete record-icon-compact"
                  aria-label={it.deleteFault + " " + f.label}
                  onClick={async () => {
                    try {
                      const result = await hideFaultAction(category, f.name);
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      const key = category + ":" + f.name.toLowerCase();
                      setHiddenFaults([...hiddenFaults, key]);
                      setValue(
                        "faults",
                        (values.faults ?? []).filter((n) => n !== f.name),
                      );
                    } catch {
                      setError("Connessione non disponibile. Riprova.");
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </fieldset>
        <div className="input-action">
          <Field label={it.faultOther}>
            <input
              value={customFault}
              maxLength={120}
              onChange={(e) => setCustomFault(e.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const typed = customFault.trim();
              if (!typed) return;
              const name =
                faults.find((f) => f.name.toLowerCase() === typed.toLowerCase())
                  ?.name ?? typed;
              setLocalFaults([...localFaults, name]);
              setValue("faults", [
                ...new Set([...(values.faults ?? []), name]),
              ]);
              setCustomFault("");
            }}
          >
            {it.addFault}
          </Button>
        </div>
        <Field label={it.faultNotes}>
          <textarea {...register("fault")} maxLength={2000} rows={2} />
        </Field>
        <Field label={it.dueDate}>
          <DatePicker
            {...register("dueDate")}
            min={today}
            quickDays={[0, 1, 2, 3, 7]}
          />
        </Field>
      </Section>
      <Section number="03" title={it.quoteSection}>
        {diagnostic ? (
          <Field label={it.diagnosticFee}>
            <input
              {...register("diagnosticFee")}
              required
              inputMode="decimal"
            />
          </Field>
        ) : (
          <ItemsEditor
            items={values.items.map((i) => ({
              ...i,
              adjustmentReason: i.adjustmentReason ?? "",
              requiredQuantity: Number(i.requiredQuantity ?? 1),
            }))}
            onChange={(items) => setValue("items", items)}
            rules={rules}
            device={{
              category,
              brand: values.brand,
              series: values.series ?? "",
              model: values.model,
            }}
            discounts
          />
        )}
        <div className="quote-adjustments">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDiscountEnabled(!discountEnabled);
              setValue("orderDiscount", "0");
            }}
          >
            {discountEnabled ? it.cancelDiscount : it.addOrderDiscount}
          </Button>
          {discountEnabled && (
            <Field label={it.orderDiscount}>
              <input
                {...register("orderDiscount")}
                required
                inputMode="decimal"
              />
            </Field>
          )}
          <label className="checkbox">
            <input type="checkbox" {...register("includeVat")} />
            {it.includeVat}
          </label>
        </div>
        <QuoteSummary
          items={
            diagnostic
              ? [{ final: values.diagnosticFee ?? "10", discount: "0" }]
              : values.items
          }
          orderDiscount={values.orderDiscount ?? "0"}
          includeVat={values.includeVat ?? false}
        />
      </Section>
      <Section number="04" title={it.paymentSection}>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={paymentNow}
            onChange={(e) => {
              setPaymentNow(e.target.checked);
              if (!e.target.checked) setValue("deposit", "0");
            }}
          />
          {it.paymentNow}
        </label>
        {paymentNow && (
          <div className="form-grid three">
            <Field label={it.initialPayment}>
              <input {...register("deposit")} required inputMode="decimal" />
            </Field>

            <Field label={it.paymentMethod}>
              <input type="hidden" {...register("method")} />
              <SimpleSelect
                value={values.method}
                onChange={(method) =>
                  setValue(
                    "method",
                    method as (typeof creatablePaymentMethods)[number],
                  )
                }
                placeholder={it.selectOption}
                ariaLabel={it.paymentMethod}
                options={creatablePaymentMethods.map((method) => ({
                  value: method,
                  label: it.methods[method],
                }))}
              />
            </Field>
          </div>
        )}
      </Section>
      {Object.keys(errors).length > 0 && (
        <p className="message error" role="alert">
          {it.validationError}
        </p>
      )}
      <Message error={error} />
      <div className="form-footer">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          {it.cancel}
        </Button>
        <Button disabled={pending}>{pending ? it.saving : it.create}</Button>
      </div>
    </form>
  );
}

export function QuoteSummary({
  items,
  orderDiscount,
  includeVat,
  inspectionFee = "0",
}: {
  items: { final: string; discount?: string }[];
  orderDiscount: string;
  includeVat: boolean;
  inspectionFee?: string;
}) {
  const it = useMessages();
  let q;
  try {
    q = settlement(items, { orderDiscount, includeVat, inspectionFee });
  } catch {
    return <p className="field-error">{it.invalidAmount}</p>;
  }
  return (
    <dl className="quote-summary">
      {[
        [it.originalTotal, q.gross],
        [it.discountTotal, q.discount],
        [it.netTotal, q.net],
        [it.vatAmount, q.vat],
        [it.withVat, q.withVat],
        [it.total, q.due],
      ].map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{money(Number(value))}</dd>
        </div>
      ))}
    </dl>
  );
}

type ActionResult = { ok: boolean; error?: string; id?: string };
function ActionForm({
  action,
  children,
  submit,
  onSuccess,
  onCancel,
  cancelLabel,
  disabled = false,
  disableUnchangedSave = false,
  changeKey = "",
  className = "",
  closeOnSuccess = false,
  saveRef,
}: {
  action: (data: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submit: string;
  onSuccess?: (result: ActionResult) => void;
  onCancel?: () => void;
  cancelLabel?: string;
  disabled?: boolean;
  disableUnchangedSave?: boolean;
  changeKey?: string;
  className?: string;
  closeOnSuccess?: boolean;
  saveRef?: { current: (() => Promise<boolean>) | null };
}) {
  const it = useMessages();
  const dialogClose = useContext(FormCloseContext);
  const closeDialog = onCancel ?? dialogClose;
  const registerSave = useContext(FormSaveContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const initial = useRef("");
  const initialChangeKey = useRef(changeKey);
  const [unchanged, setUnchanged] = useState(disableUnchangedSave);
  const initialized = useRef(false);
  const activeSave = useRef<Promise<boolean> | null>(null);
  const router = useRouter();
  const snapshot = useCallback((element: HTMLFormElement) => {
    return JSON.stringify(
      Array.from(element.elements).flatMap((control) => {
        if (!(
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
        ))
          return [];
        return [
          [
            control.name,
            control.type,
            "checked" in control ? control.checked : null,
            control.value,
          ],
        ];
      }),
    );
  }, []);
  const updateUnchanged = useCallback(() => {
    if (form.current && disableUnchangedSave)
      setUnchanged(
        snapshot(form.current) === initial.current &&
          changeKey === initialChangeKey.current,
      );
  }, [changeKey, disableUnchangedSave, snapshot]);
  const save = useCallback(
    (element: HTMLFormElement) => {
      if (activeSave.current) return activeSave.current;
      const current = snapshot(element);
      if (
        registerSave &&
        current === initial.current &&
        changeKey === initialChangeKey.current
      )
        return Promise.resolve(true);
      const request = (async () => {
        setPending(true);
        setError("");
        setSuccess(false);
        try {
          const result = await action(new FormData(element));
          if (!result.ok) {
            setError(result.error ?? "Errore");
            return false;
          }
          initial.current = current;
          initialChangeKey.current = changeKey;
          if (disableUnchangedSave) setUnchanged(true);
          setSuccess(true);
          onSuccess?.(result);
          router.refresh();
          return true;
        } catch {
          setError("Connessione non disponibile. Riprova.");
          return false;
        } finally {
          setPending(false);
          activeSave.current = null;
        }
      })();
      activeSave.current = request;
      return request;
    },
    [
      action,
      changeKey,
      disableUnchangedSave,
      onSuccess,
      registerSave,
      router,
      snapshot,
    ],
  );
  useEffect(() => {
    if (!form.current || initialized.current) return;
    initialized.current = true;
    initial.current = snapshot(form.current);
  }, [snapshot]);
  useEffect(() => {
    updateUnchanged();
  }, [updateUnchanged]);
  useEffect(() => {
    if (!registerSave) return;
    return registerSave({
      save: () => (form.current ? save(form.current) : Promise.resolve(true)),
      isDirty: () =>
        Boolean(
          form.current &&
          (snapshot(form.current) !== initial.current ||
            changeKey !== initialChangeKey.current),
        ),
    });
  }, [changeKey, registerSave, save, snapshot]);
  useEffect(() => {
    if (!saveRef) return;
    saveRef.current = () =>
      form.current ? save(form.current) : Promise.resolve(false);
    return () => {
      saveRef.current = null;
    };
  }, [save, saveRef]);
  async function handle(event: FormEvent<HTMLFormElement>) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    if (disableUnchangedSave && unchanged) return;
    if (await save(event.currentTarget)) {
      if (registerSave || closeOnSuccess) closeDialog?.();
    }
  }
  return (
    <form
      ref={form}
      onSubmit={handle}
      onChangeCapture={() => requestAnimationFrame(updateUnchanged)}
      onInputCapture={() => requestAnimationFrame(updateUnchanged)}
      className={`action-form ${className}`}
      aria-busy={pending}
    >
      {children}
      <Message error={error} success={success} />
      {registerSave ? null : closeDialog ? (
        <div className="dialog-actions">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={closeDialog}
          >
            {cancelLabel ?? it.cancel}
          </Button>
          <Button disabled={pending || disabled || unchanged}>
            {pending ? it.saving : submit}
          </Button>
        </div>
      ) : (
        <Button disabled={pending || disabled || unchanged}>
          {pending ? it.saving : submit}
        </Button>
      )}
    </form>
  );
}
const str = (data: FormData, key: string) => String(data.get(key) ?? "");
export function PaymentForm({
  id,
  remaining,
}: {
  id: string;
  remaining: number;
}) {
  const it = useMessages();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [method, setMethod] = useState("CASH");
  return (
    <ActionForm
      submit={it.addPayment}
      onSuccess={() => setRequestId(crypto.randomUUID())}
      action={(data) =>
        paymentAction(id, {
          requestId,
          amount: str(data, "amount"),
          method,
          kind: "BALANCE",
        })
      }
    >
      <div className="form-grid">
        <Field label={it.amount}>
          <input
            className="payment-amount-input"
            name="amount"
            inputMode="decimal"
            defaultValue={decimal(Math.max(0, remaining))}
            required
          />
        </Field>
        <Field label={it.paymentMethod}>
          <SimpleSelect
            name="method"
            value={method}
            onChange={setMethod}
            placeholder={it.selectOption}
            ariaLabel={it.paymentMethod}
            options={creatablePaymentMethods.map((option) => ({
              value: option,
              label: it.methods[option],
            }))}
          />
        </Field>
      </div>
    </ActionForm>
  );
}
export function EditOrderForm({
  id,
  values,
  customers,
  faultOptions,
}: {
  id: string;
  customers: {
    id: string;
    name: string;
    phone: string;
    phones: { phone: string }[];
  }[];
  faultOptions: FaultCatalogItem[];
  values: {
    customerId: string;
    category: string;
    fault: string;
    faultNote: string;
    standardFaultIds: string[];
    notes: string;
    accessories: string;
    dueDate: string | null;
  };
}) {
  const it = useMessages();
  const today = useBusinessDay();
  const [customerId, setCustomerId] = useState(values.customerId);
  const [localCustomers, setLocalCustomers] = useState(customers);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerError, setCustomerError] = useState("");
  const [customerPending, setCustomerPending] = useState(false);
  const [standardFaultIds, setStandardFaultIds] = useState(
    values.standardFaultIds,
  );
  const [faults, setFaults] = useState(faultOptions);
  function openCustomer(query: string) {
    const value = query.trim();
    const phone = /^[+\d\s().-]{6,}$/.test(value);
    setCustomerName(phone ? "" : value);
    setCustomerPhone(phone ? value : "");
    setCustomerError("");
    setAddingCustomer(true);
  }
  return (
    <>
      <ActionForm
        submit={it.save}
        disableUnchangedSave
        changeKey={JSON.stringify([customerId, standardFaultIds])}
        action={(data) =>
          updateOrderAction(id, {
            ...Object.fromEntries(data),
            customerId,
            standardFaultIds,
            accessories: values.accessories,
          })
        }
      >
        <Field label={it.customer}>
          <SearchableCombobox
            value={customerId}
            onChange={setCustomerId}
            ariaLabel={it.searchCustomer}
            placeholder={it.customerSearchPlaceholder}
            searchPlaceholder={it.customerSearchPlaceholder}
            emptyText={it.noCustomerMatches}
            customLabel={it.addCustomer}
            onCustom={openCustomer}
            groups={[
              {
                options: localCustomers.map((customer) => ({
                  value: customer.id,
                  label: customer.name,
                  secondary: customer.phone,
                  keywords: customer.phones
                    .map((phone) => phone.phone)
                    .join(" "),
                })),
              },
            ]}
          />
        </Field>
        <FaultSelector
          category={values.category}
          items={faults}
          selected={standardFaultIds}
          onChange={setStandardFaultIds}
          onItemsChange={setFaults}
        />
        <input type="hidden" name="fault" value={values.fault} />
        <Field label={it.faultNotes}>
          <textarea
            name="faultNote"
            defaultValue={values.faultNote}
            maxLength={2000}
          />
        </Field>
        <Field label={it.dueDate}>
          <DatePicker
            name="dueDate"
            min={today}
            quickDays={[0, 1, 2, 3, 7]}
            defaultValue={values.dueDate ?? ""}
          />
        </Field>
        <Field label={it.notes}>
          <textarea name="notes" defaultValue={values.notes} maxLength={2000} />
        </Field>
      </ActionForm>
      {addingCustomer && (
        <FormDialog
          title={it.addCustomer}
          onClose={() => setAddingCustomer(false)}
        >
          <form
            className="dialog-form"
            data-form-dialog-body
            onSubmit={(event) => {
              event.preventDefault();
              if (customerPending) return;
              setCustomerPending(true);
              setCustomerError("");
              void customerAction(null, {
                name: customerName,
                phone: customerPhone,
                additionalPhones: [],
              })
                .then(async (result) => {
                  if (!result.ok) return setCustomerError(result.error);
                  const created = await lookupCustomerAction(customerPhone);
                  if (!created) return setCustomerError(it.connectionError);
                  setLocalCustomers((current) => [...current, created]);
                  setCustomerId(created.id);
                  setAddingCustomer(false);
                })
                .finally(() => setCustomerPending(false));
            }}
          >
            <Field label={`${it.name} *`}>
              <input
                required
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
              />
            </Field>
            <Field label={`${it.phone} *`}>
              <input
                required
                type="tel"
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
              />
            </Field>
            {customerError && <p className="message error">{customerError}</p>}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddingCustomer(false)}
              >
                {it.cancel}
              </Button>
              <Button disabled={customerPending}>
                {customerPending ? it.saving : it.saveCustomer}
              </Button>
            </div>
          </form>
        </FormDialog>
      )}
    </>
  );
}

export function WarrantyForm({
  id,
  items,
}: {
  id: string;
  items: { id: string; project: string; days: number; notes: string }[];
}) {
  const it = useMessages();
  const [values, setValues] = useState(items);
  return (
    <ActionForm
      submit={it.save}
      disableUnchangedSave
      changeKey={JSON.stringify([values])}
      action={(data) =>
        warrantyAction(id, {
          items: items.map((item) => ({
            id: item.id,
            days: Number(data.get(`warranty-days-${item.id}`)),
            notes: String(data.get(`warranty-notes-${item.id}`) ?? ""),
          })),
        })
      }
    >
      <div className="project-warranty-editor">
        {values.map((item, index) => (
          <section key={item.id}>
            <strong>{item.project}</strong>
            <Field label={it.warranty.duration}>
              <SimpleSelect
                name={`warranty-days-${item.id}`}
                value={String(item.days)}
                onChange={(days) =>
                  setValues((current) =>
                    current.map((entry, i) =>
                      i === index ? { ...entry, days: Number(days) } : entry,
                    ),
                  )
                }
                placeholder={it.selectOption}
                ariaLabel={`${it.warranty.duration} ${item.project}`}
                options={[0, 7, 30, 60, 90, 180, 365].map((days) => ({
                  value: String(days),
                  label: days
                    ? `${days} ${it.warranty.days}`
                    : it.warranty.none,
                }))}
              />
            </Field>
            <Field label={it.warranty.notes}>
              <textarea
                name={`warranty-notes-${item.id}`}
                value={item.notes}
                maxLength={2000}
                onChange={(event) =>
                  setValues((current) =>
                    current.map((entry, i) =>
                      i === index
                        ? { ...entry, notes: event.target.value }
                        : entry,
                    ),
                  )
                }
              />
            </Field>
          </section>
        ))}
      </div>
    </ActionForm>
  );
}

export type AfterSalesProject = {
  id: string;
  name: string;
  price: string;
  warranty: AfterSalesWarranty;
  warrantyDays: number;
  reworked: boolean;
  requiredProductId?: string;
  requiredQuantity?: number;
};
export type AfterSalesWarranty = {
  start: string;
  end: string;
  progress: number;
  remainingPercent: number;
  remainingDays: number;
  elapsedDays: number;
  totalDays: number;
  state: "ACTIVE" | "EXPIRING" | "EXPIRED";
} | null;

export function WarrantyProgressPanel({
  warranty,
  days,
}: {
  warranty: AfterSalesWarranty;
  days?: number;
}) {
  const it = useMessages();
  const [progress, setProgress] = useState(0);
  const [displayedRemaining, setDisplayedRemaining] = useState(100);
  useEffect(() => {
    if (!warranty) return;
    let frame = 0;
    const reducedMotion = prefersReducedMotion();
    const timer = window.setTimeout(
      () => {
        setProgress(warranty.progress);
        if (reducedMotion) {
          setDisplayedRemaining(warranty.remainingPercent);
          return;
        }
        const start = performance.now();
        const animateRemaining = (now: number) => {
          const raw = Math.min(1, (now - start) / 700);
          const eased = 1 - Math.pow(1 - raw, 3);
          setDisplayedRemaining(
            Math.round(100 + (warranty.remainingPercent - 100) * eased),
          );
          if (raw < 1) frame = requestAnimationFrame(animateRemaining);
        };
        frame = requestAnimationFrame(animateRemaining);
      },
      reducedMotion ? 0 : 100,
    );
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [warranty]);
  if (!warranty)
    return (
      <section className="warranty-progress-panel is-none">
        <ShieldCheck size={19} aria-hidden="true" />
        <div>
          <strong>
            {days ? `${days} ${it.warranty.days}` : it.afterSales.noWarranty}
          </strong>
          <p>
            {days
              ? it.warranty.startsAfterDelivery
              : it.afterSales.noWarrantyHint}
          </p>
        </div>
      </section>
    );
  const tone =
    warranty.state === "EXPIRED"
      ? "expired"
      : warranty.remainingPercent <= 20
        ? "ending"
        : warranty.remainingPercent <= 50
          ? "warning"
          : "healthy";
  const title =
    warranty.state === "EXPIRED"
      ? it.afterSales.warrantyExpired
      : warranty.state === "EXPIRING"
        ? it.afterSales.warrantyExpiring
        : it.afterSales.warrantyActive;
  return (
    <section className={`warranty-progress-panel is-${tone}`}>
      <ShieldCheck size={19} aria-hidden="true" />
      <div className="warranty-progress-content">
        <strong>{days ? `${days} ${it.warranty.days}` : title}</strong>
        <p>
          {title}
          {warranty.state !== "EXPIRED" &&
            ` · ${it.afterSales.remainingDays.replace("{count}", String(warranty.remainingDays))}`}
        </p>
        <div className="warranty-progress-labels">
          <span>
            {warranty.elapsedDays} / {warranty.totalDays} {it.warranty.days}{" "}
            {it.afterSales.used}
          </span>
          <span data-testid="warranty-remaining">
            {displayedRemaining}% {it.afterSales.remaining}
          </span>
        </div>
        <div className="warranty-progress-track" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="warranty-progress-dates">
          <span>{it.afterSales.warrantyUntil}</span>
          <span>{warranty.end.replaceAll("-", "/")}</span>
        </div>
      </div>
    </section>
  );
}

function ReworkPartSummary({
  product,
  option,
  disabled = false,
  onChange,
  onRemove,
}: {
  product?: CreatedProduct;
  option?: PriceRuleOptionView;
  disabled?: boolean;
  onChange: () => void;
  onRemove: () => void;
}) {
  const it = useMessages();
  const available = product?.available ?? product?.stock ?? 0;
  return (
    <div
      className={`selection-summary selected-part-summary rework-part-summary${disabled ? "" : " is-actionable"}`}
      onClick={(event) => {
        if (disabled || (event.target as HTMLElement).closest("button")) return;
        onChange();
      }}
    >
      <span className="selection-summary-icon is-part">
        <Package size={18} aria-hidden="true" />
      </span>
      <div className="selection-summary-copy">
        <strong>{option?.name ?? product?.name ?? it.afterSales.noPart}</strong>
        <small>
          {product ? (
            <>
              {option && (
                <>
                  {product.name} · {it.priceListPrice}{" "}
                  {money(cents(option.suggested))} ·{" "}
                </>
              )}
              {product.category} · {it.actualStock} {product.stock} ·{" "}
              {it.reservedStock} {product.reserved ?? 0} · {it.availableStock}{" "}
              {available} ·{" "}
              <span
                className={`part-stock ${available > 0 ? "is-available" : "is-empty"}`}
              >
                ● {available > 0 ? it.partInStock : it.partOutOfStock}
              </span>
            </>
          ) : (
            it.noRequiredPart
          )}
        </small>
      </div>
      <div className="selected-part-actions">
        <button
          type="button"
          className="summary-action"
          disabled={disabled}
          onClick={onChange}
        >
          <span>{it.change}</span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        {product && !disabled && (
          <button
            type="button"
            className="quick-service-remove"
            aria-label={`${it.remove} ${product.name}`}
            onClick={onRemove}
          >
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

export function ReworkPartEditor({
  orderId,
  itemId,
  value,
  products,
  productCategories,
  device,
  project,
  options = [],
  rule,
}: {
  orderId: string;
  itemId: string;
  value: string;
  products: CreatedProduct[];
  productCategories: CategoryView[];
  device: { category: string; brand: string; model: string };
  project: string;
  options?: PriceRuleOptionView[];
  rule?: RuleView;
}) {
  const it = useMessages();
  const router = useRouter();
  const [selected, setSelected] = useState(value);
  const [noneSelected, setNoneSelected] = useState(!value);
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [createdProducts, setCreatedProducts] = useState<CreatedProduct[]>([]);
  const [creatingPart, setCreatingPart] = useState<string | null>(null);
  const [creatingPriceOption, setCreatingPriceOption] = useState(false);
  const availableProducts = [
    ...products,
    ...createdProducts.filter(
      (created) => !products.some((product) => product.id === created.id),
    ),
  ];
  const selectedProduct = availableProducts.find(
    (product) => product.id === selected,
  );
  const selectedOption = options.find(
    (option) => option.enabled && option.productId === selected,
  );
  const select = (productId: string, explicitNoPart = !productId) => {
    const option = options.find(
      (candidate) => candidate.productId === productId,
    );
    setSelected(productId);
    setNoneSelected(explicitNoPart);
    startTransition(async () => {
      const result = await updateReworkPartAction(orderId, itemId, {
        productId,
        quantity: option?.quantity ?? 1,
      });
      if (!result.ok) {
        setSelected(value);
        setEditing(true);
        setError(result.error);
        return;
      }
      setEditing(false);
      setError("");
      router.refresh();
    });
  };
  return (
    <div className="rework-part-editor">
      {rule ? (
        <PriceOptionPicker
          options={options.filter((option) => option.enabled)}
          inventoryProducts={
            options.length
              ? []
              : ruleLinkedProducts(availableProducts, rule, selected)
          }
          selected={selectedOption}
          customProduct={selectedProduct}
          noneSelected={noneSelected}
          open={editing}
          disabled={pending}
          ariaLabel={`${it.requiredPart} ${project}`}
          onOpenChange={setEditing}
          onSelect={(optionId) => {
            const option = options.find(
              (candidate) => candidate.id === optionId,
            );
            select(option?.productId ?? "");
          }}
          onSelectProduct={(productId) => select(productId, false)}
          onRemove={() => select("", false)}
          onAdd={rule ? () => setCreatingPriceOption(true) : undefined}
        />
      ) : editing ? (
        <SearchableCombobox
          value={selected}
          disabled={pending}
          autoFocusQuery={selectedProduct?.name ?? ""}
          onClose={() => setEditing(false)}
          onChange={select}
          ariaLabel={it.requiredPart}
          placeholder={it.noRequiredPart}
          searchPlaceholder={it.searchInventoryPart}
          emptyText={it.noMatches}
          clearable
          groups={[
            ...(options.length
              ? [
                  {
                    options: options
                      .filter((option) => option.enabled)
                      .map((option) => ({
                        value: option.productId,
                        label: option.name,
                        secondary: `${it.priceListPrice}: ${money(cents(option.suggested))}`,
                        trailing: `${it.availableStock} ${option.product.available}`,
                      })),
                  },
                ]
              : []),
            {
              options: availableProducts
                .filter(
                  (product) =>
                    !options.some((option) => option.productId === product.id),
                )
                .map((product) => ({
                  value: product.id,
                  label: product.name,
                  secondary: product.category,
                  trailing: `${it.actualStock} ${product.stock} · ${it.reservedStock} ${product.reserved ?? 0} · ${it.availableStock} ${product.available ?? product.stock}`,
                })),
            },
          ]}
          customLabel={it.newPart}
          onCustom={setCreatingPart}
          creationControls="no-match"
          commitEmptyOnClose
        />
      ) : (
        <ReworkPartSummary
          product={selectedProduct}
          option={selectedOption}
          disabled={pending}
          onChange={() => setEditing(true)}
          onRemove={() => select("")}
        />
      )}
      {error && <p className="field-error">{error}</p>}
      {creatingPart !== null && (
        <FormDialog
          title={it.newRepairPart}
          onClose={() => setCreatingPart(null)}
        >
          <ProductForm
            categories={productCategories}
            mode="inventory"
            initialName={creatingPart}
            initialUsage="REPAIR"
            quickRepair
            initialCompatibility={{ ...device, project }}
            onClose={() => setCreatingPart(null)}
            onCreated={(product) => {
              setCreatedProducts((current) => [...current, product]);
              select(product.id);
            }}
          />
        </FormDialog>
      )}
      {creatingPriceOption && rule && (
        <FormDialog
          title={it.newPartOption}
          onClose={() => setCreatingPriceOption(false)}
        >
          <PriceRuleOptionForm
            rule={rule}
            products={availableProducts.map((product) => ({
              id: product.id,
              name: product.name,
              category: product.category,
              stockQuantity: product.stock,
              costPrice: product.costPrice,
            }))}
            productCategories={productCategories}
            compatibility={{ ...device, project }}
            onSuccess={() => {
              setCreatingPriceOption(false);
              router.refresh();
            }}
          />
        </FormDialog>
      )}
    </div>
  );
}

export function AfterSalesForm({
  id,
  originalProjects,
  products,
  productCategories,
  device,
  rules,
  onSuccess,
}: {
  id: string;
  originalProjects: AfterSalesProject[];
  products: CreatedProduct[];
  productCategories: CategoryView[];
  device: { category: string; brand: string; series: string; model: string };
  rules: RuleView[];
  onSuccess?: () => void;
}) {
  const it = useMessages();
  const today = useBusinessDay();
  const available = originalProjects.filter((project) => !project.reworked);
  const [selected, setSelected] = useState<string[]>(
    available.length === 1 ? [available[0].id] : [],
  );
  const [itemValues, setItemValues] = useState<
    Record<
      string,
      {
        treatment: "WARRANTY" | "PAID";
        fee: string;
        requiredProductId: string;
        requiredQuantity: number;
        requiredProductRemoved: boolean;
      }
    >
  >(() =>
    Object.fromEntries(
      available.map((project) => [
        project.id,
        {
          treatment:
            project.warranty && project.warranty.state !== "EXPIRED"
              ? "WARRANTY"
              : "PAID",
          fee: "0",
          requiredProductId: project.requiredProductId ?? "",
          requiredQuantity: project.requiredQuantity ?? 1,
          requiredProductRemoved: false,
        },
      ]),
    ),
  );
  const [editingParts, setEditingParts] = useState<Record<string, boolean>>(
    () => Object.fromEntries(available.map((project) => [project.id, false])),
  );
  const [notes, setNotes] = useState("");
  const [createdProducts, setCreatedProducts] = useState<CreatedProduct[]>([]);
  const [creatingPart, setCreatingPart] = useState<{
    projectId: string;
    query: string;
  } | null>(null);
  const [creatingPriceOptionRule, setCreatingPriceOptionRule] =
    useState<RuleView | null>(null);
  const availableProducts = [
    ...products,
    ...createdProducts.filter(
      (created) => !products.some((product) => product.id === created.id),
    ),
  ];
  return (
    <ActionForm
      submit={it.afterSales.openRework}
      onSuccess={onSuccess}
      disabled={
        !selected.length ||
        selected.some((id) => !validAmount(itemValues[id]?.fee ?? ""))
      }
      action={(data) =>
        afterSalesAction(id, {
          items: selected.map((originalItemId) => ({
            originalItemId,
            treatment: itemValues[originalItemId].treatment,
            fee:
              itemValues[originalItemId].treatment === "WARRANTY"
                ? "0"
                : itemValues[originalItemId].fee,
            requiredProductId: itemValues[originalItemId].requiredProductId,
            requiredQuantity: itemValues[originalItemId].requiredQuantity,
          })),
          notes: str(data, "notes"),
          dueDate: str(data, "dueDate"),
        })
      }
    >
      <div className="rework-project-list">
        {originalProjects.map((project) => {
          const checked = selected.includes(project.id);
          const value = itemValues[project.id];
          const selectedProduct = availableProducts.find(
            (product) => product.id === value?.requiredProductId,
          );
          const rule = matchRule(rules, device, project.name)?.rule;
          const options =
            rule?.options?.filter((option) => option.enabled) ?? [];
          const selectedOption = options.find(
            (option) => option.productId === value?.requiredProductId,
          );
          return (
            <section
              className={project.reworked ? "is-disabled" : ""}
              key={project.id}
            >
              <label className="checkbox">
                <input
                  type="checkbox"
                  disabled={project.reworked}
                  checked={checked}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, project.id]
                        : current.filter((id) => id !== project.id),
                    )
                  }
                />
                <strong>{project.name}</strong>
                <span>{project.price}</span>
              </label>
              {project.reworked && <p>{it.afterSales.alreadyReworked}</p>}
              {!project.reworked && (
                <WarrantyProgressPanel
                  warranty={project.warranty}
                  days={project.warrantyDays}
                />
              )}
              {checked && value && (
                <>
                  <fieldset className="after-sales-treatment">
                    <legend>{it.afterSales.treatment}</legend>
                    {(["WARRANTY", "PAID"] as const).map((choice) => (
                      <label
                        className={`after-sales-radio ${value.treatment === choice ? "is-selected" : ""}`}
                        key={choice}
                      >
                        <input
                          type="radio"
                          checked={value.treatment === choice}
                          onChange={() =>
                            setItemValues((current) => ({
                              ...current,
                              [project.id]: {
                                ...value,
                                treatment: choice,
                                fee: choice === "WARRANTY" ? "0" : value.fee,
                              },
                            }))
                          }
                        />
                        <span>
                          <strong>
                            {choice === "WARRANTY"
                              ? it.afterSales.warrantyTreatment
                              : it.afterSales.paidTreatment}
                          </strong>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  {value.treatment === "PAID" && (
                    <Field label={it.afterSales.fee}>
                      <input
                        inputMode="decimal"
                        value={value.fee}
                        aria-invalid={!validAmount(value.fee)}
                        onChange={(event) =>
                          setItemValues((current) => ({
                            ...current,
                            [project.id]: { ...value, fee: event.target.value },
                          }))
                        }
                      />
                      {selectedOption && (
                        <small>
                          {it.priceListPrice}:{" "}
                          {money(cents(selectedOption.suggested))}
                        </small>
                      )}
                    </Field>
                  )}
                  <div className="after-sales-part-field">
                    <span>{it.requiredPart}</span>
                    {rule ? (
                      <PriceOptionPicker
                        options={options}
                        inventoryProducts={
                          options.length
                            ? []
                            : ruleLinkedProducts(
                                availableProducts,
                                rule,
                                value.requiredProductId,
                              )
                        }
                        selected={selectedOption}
                        customProduct={selectedProduct}
                        noneSelected={value.requiredProductRemoved}
                        open={Boolean(editingParts[project.id])}
                        ariaLabel={`${it.requiredPart} ${project.name}`}
                        onOpenChange={(open) =>
                          setEditingParts((current) => ({
                            ...current,
                            [project.id]: open,
                          }))
                        }
                        onSelect={(optionId) => {
                          const option = options.find(
                            (candidate) => candidate.id === optionId,
                          );
                          setItemValues((current) => ({
                            ...current,
                            [project.id]: {
                              ...value,
                              requiredProductId: option?.productId ?? "",
                              requiredQuantity: option?.quantity ?? 1,
                              requiredProductRemoved: !option,
                            },
                          }));
                        }}
                        onSelectProduct={(requiredProductId) => {
                          setItemValues((current) => ({
                            ...current,
                            [project.id]: {
                              ...value,
                              requiredProductId,
                              requiredQuantity: 1,
                              requiredProductRemoved: false,
                            },
                          }));
                        }}
                        onRemove={() => {
                          setItemValues((current) => ({
                            ...current,
                            [project.id]: {
                              ...value,
                              requiredProductId: "",
                              requiredQuantity: 1,
                              requiredProductRemoved: false,
                            },
                          }));
                        }}
                        onAdd={
                          rule
                            ? () => setCreatingPriceOptionRule(rule)
                            : undefined
                        }
                      />
                    ) : editingParts[project.id] ? (
                      <SearchableCombobox
                        value={value.requiredProductId}
                        autoFocusQuery={
                          selectedProduct ? selectedProduct.name : undefined
                        }
                        onClose={() =>
                          setEditingParts((current) => ({
                            ...current,
                            [project.id]: false,
                          }))
                        }
                        onChange={(requiredProductId) => {
                          const option = options.find(
                            (candidate) =>
                              candidate.productId === requiredProductId,
                          );
                          setItemValues((current) => ({
                            ...current,
                            [project.id]: {
                              ...value,
                              requiredProductId,
                              requiredQuantity: option?.quantity ?? 1,
                            },
                          }));
                          setEditingParts((current) => ({
                            ...current,
                            [project.id]: false,
                          }));
                        }}
                        ariaLabel={`${it.requiredPart} ${project.name}`}
                        placeholder={it.noRequiredPart}
                        searchPlaceholder={it.searchInventoryPart}
                        emptyText={it.noMatches}
                        clearable
                        groups={[
                          ...(options.length
                            ? [
                                {
                                  options: options.map((option) => ({
                                    value: option.productId,
                                    label: option.name,
                                    secondary: `${it.priceListPrice}: ${money(cents(option.suggested))}`,
                                    trailing: `${it.actualStock} ${option.product.stock} · ${it.reservedStock} ${option.product.reserved} · ${it.availableStock} ${option.product.available}`,
                                  })),
                                },
                              ]
                            : []),
                          {
                            options: availableProducts
                              .filter(
                                (product) =>
                                  !options.some(
                                    (option) => option.productId === product.id,
                                  ),
                              )
                              .map((product) => ({
                                value: product.id,
                                label: product.name,
                                secondary: product.category,
                                trailing: `${it.actualStock} ${product.stock} · ${it.availableStock} ${product.available ?? product.stock}`,
                              })),
                          },
                        ]}
                        customLabel={it.newPart}
                        onCustom={(query) =>
                          setCreatingPart({ projectId: project.id, query })
                        }
                        creationControls="no-match"
                        commitEmptyOnClose
                      />
                    ) : (
                      <ReworkPartSummary
                        product={selectedProduct}
                        option={selectedOption}
                        onRemove={() =>
                          setItemValues((current) => ({
                            ...current,
                            [project.id]: {
                              ...value,
                              requiredProductId: "",
                              requiredQuantity: 1,
                            },
                          }))
                        }
                        onChange={() =>
                          setEditingParts((current) => ({
                            ...current,
                            [project.id]: true,
                          }))
                        }
                      />
                    )}
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
      <Field label={it.afterSales.notes} className="after-sales-notes">
        <textarea
          name="notes"
          rows={3}
          maxLength={200}
          value={notes}
          placeholder={it.afterSales.notesPlaceholder}
          onChange={(event) => setNotes(event.target.value)}
        />
        <small>{notes.length}/200</small>
      </Field>
      <div className="after-sales-grid">
        <Field label={it.afterSales.dueDate}>
          <DatePicker name="dueDate" min={today} quickDays={[0, 1, 2, 3, 7]} />
        </Field>
      </div>
      {creatingPart && (
        <FormDialog
          title={it.newRepairPart}
          onClose={() => setCreatingPart(null)}
        >
          <ProductForm
            categories={productCategories}
            mode="inventory"
            initialName={creatingPart.query}
            initialUsage="REPAIR"
            quickRepair
            initialCompatibility={{
              ...device,
              project:
                originalProjects.find(
                  (project) => project.id === creatingPart.projectId,
                )?.name ?? "",
            }}
            onClose={() => setCreatingPart(null)}
            onCreated={(product) => {
              setCreatedProducts((current) => [...current, product]);
              setItemValues((current) => ({
                ...current,
                [creatingPart.projectId]: {
                  ...current[creatingPart.projectId],
                  requiredProductId: product.id,
                  requiredQuantity: 1,
                },
              }));
              setEditingParts((current) => ({
                ...current,
                [creatingPart.projectId]: false,
              }));
            }}
          />
        </FormDialog>
      )}
      {creatingPriceOptionRule && (
        <FormDialog
          title={it.newPartOption}
          onClose={() => setCreatingPriceOptionRule(null)}
        >
          <PriceRuleOptionForm
            rule={creatingPriceOptionRule}
            products={availableProducts.map((product) => ({
              id: product.id,
              name: product.name,
              category: product.category,
              stockQuantity: product.stock,
              costPrice: product.costPrice,
            }))}
            productCategories={productCategories}
            compatibility={{
              category: device.category,
              brand: device.brand,
              model: device.model,
              project: creatingPriceOptionRule.project,
            }}
            onSuccess={() => {
              setCreatingPriceOptionRule(null);
            }}
          />
        </FormDialog>
      )}
    </ActionForm>
  );
}

export function RefundForm({ id, received }: { id: string; received: number }) {
  const it = useMessages();
  const [requestId] = useState(() => crypto.randomUUID());
  const [method, setMethod] = useState("CASH");
  return (
    <ActionForm
      submit={it.afterSales.confirmRefund}
      action={(data) =>
        refundAction(id, {
          requestId,
          method,
          reason: str(data, "reason"),
        })
      }
    >
      <p className="message warning">{it.afterSales.refundWarning}</p>
      <Field label={it.afterSales.currentReceived}>
        <input readOnly value={money(received)} />
      </Field>
      <Field label={it.afterSales.refundAmount}>
        <input readOnly value={money(received)} />
      </Field>
      <Field label={it.afterSales.refundMethod}>
        <SimpleSelect
          name="method"
          value={method}
          onChange={setMethod}
          placeholder={it.selectOption}
          ariaLabel={it.afterSales.refundMethod}
          options={creatablePaymentMethods.map((option) => ({
            value: option,
            label: it.methods[option],
          }))}
        />
      </Field>
      <Field label={it.afterSales.refundReason}>
        <textarea name="reason" required maxLength={2000} />
      </Field>
    </ActionForm>
  );
}
export function EditQuoteForm({
  id,
  initial,
  initialDiscount = "0",
  initialVat = false,
  inspectionFee = "0",
  rules,
  device,
  products = [],
  productCategories = [],
  onSuccess,
  mode = "all",
}: {
  id: string;
  initial: ItemView[];
  initialDiscount?: string;
  initialVat?: boolean;
  inspectionFee?: string;
  rules: RuleView[];
  products?: {
    id: string;
    name: string;
    category: string;
    stock: number;
    reserved?: number;
    available?: number;
  }[];
  productCategories?: CategoryView[];
  device: { category: string; brand: string; series: string; model: string };
  owner: boolean;
  onSuccess?: () => void;
  mode?: "all" | "items" | "totals";
}) {
  const it = useMessages();
  const [items, setItems] = useState(initial);
  const [orderDiscount, setOrderDiscount] = useState(initialDiscount);
  const [includeVat, setIncludeVat] = useState(initialVat);
  const [discounts, setDiscounts] = useState(numeric(initialDiscount) > 0);
  return (
    <ActionForm
      submit={it.save}
      disableUnchangedSave
      changeKey={JSON.stringify([items, orderDiscount, includeVat])}
      action={() => quoteAction(id, { items, orderDiscount, includeVat })}
      onSuccess={onSuccess}
    >
      {mode !== "totals" && (
        <>
          <p className="message warning">{it.quoteNotice}</p>
          <ItemsEditor
            items={items}
            onChange={setItems}
            rules={rules}
            device={device}
            discounts
            products={products}
            productCategories={productCategories}
            showEmptyPartSummary
          />
        </>
      )}
      {mode !== "items" && (
        <>
          {mode === "totals" && (
            <div className="quote-total">
              <span>{it.originalTotal}</span>
              <strong>
                {money(
                  items.reduce((sum, item) => sum + numeric(item.final), 0),
                )}
              </strong>
            </div>
          )}
          <div className="quote-adjustments">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDiscounts(!discounts);
                setOrderDiscount("0");
              }}
            >
              {discounts ? it.cancelDiscount : it.addOrderDiscount}
            </Button>
            {discounts && (
              <Field label={it.orderDiscount}>
                <input
                  inputMode="decimal"
                  required
                  value={orderDiscount}
                  onChange={(e) => setOrderDiscount(e.target.value)}
                />
              </Field>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeVat}
                onChange={(e) => setIncludeVat(e.target.checked)}
              />
              {it.includeVat}
            </label>
          </div>
          <QuoteSummary
            items={items}
            orderDiscount={orderDiscount}
            includeVat={includeVat}
            inspectionFee={inspectionFee}
          />
        </>
      )}
    </ActionForm>
  );
}
export function QuoteItemsDraftForm({
  id,
  items,
  orderDiscount,
  includeVat,
}: {
  id: string;
  items: ItemView[];
  orderDiscount: string;
  includeVat: boolean;
}) {
  const it = useMessages();
  return (
    <ActionForm
      className="quote-draft-save-form"
      submit={it.save}
      action={() => quoteAction(id, { items, orderDiscount, includeVat })}
    >
      <input
        type="hidden"
        name="quoteItemsDraft"
        value={JSON.stringify(items)}
      />
    </ActionForm>
  );
}
export function RuleForm({
  rule,
  rules = [],
  repairProducts = [],
  initial,
  focusOptions = false,
  onSuccess,
  onOptionSaved,
}: {
  rule?: RuleView;
  rules?: RuleView[];
  repairProducts?: {
    id: string;
    name: string;
    category: string;
    stockQuantity: number;
    costPrice: string;
  }[];
  initial?: Partial<RuleView>;
  onSuccess?: (
    device: {
      category: string;
      brand: string;
      model: string;
    },
    id?: string,
  ) => void;
  focusOptions?: boolean;
  onOptionSaved?: () => void;
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const router = useRouter();
  const [category, setCategory] = useState<Category>(
    ((rule?.category ?? initial?.category) as Category) ?? "PHONE",
  );
  const [brand, setBrand] = useState(rule?.brand ?? initial?.brand ?? "");
  const [model, setModel] = useState(rule?.model ?? initial?.model ?? "");
  const [project, setProject] = useState(rule?.project ?? "");
  const [createdRuleId, setCreatedRuleId] = useState("");
  const [editingOption, setEditingOption] = useState<{
    option?: PriceRuleOptionView;
  } | null>(null);
  const [optionPending, setOptionPending] = useState(false);
  const [optionError, setOptionError] = useState("");
  const optionSection = useRef<HTMLElement>(null);
  const saveBaseQuote = useRef<(() => Promise<boolean>) | null>(null);
  const ruleId = rule?.id ?? createdRuleId;
  const currentRule =
    rules.find((candidate) => candidate.id === ruleId) ?? rule ?? null;
  const selectedProjectRule =
    !currentRule && category && brand.trim() && model.trim() && project.trim()
      ? rules.find(
          (candidate) =>
            candidate.category === category &&
            normalizeBrand(candidate.brand) === normalizeBrand(brand) &&
            normalizeDeviceModel(candidate.brand, candidate.model) ===
              normalizeDeviceModel(brand, model) &&
            candidate.project.toLocaleLowerCase("it") ===
              project.trim().toLocaleLowerCase("it"),
        )
      : null;
  const optionRule: RuleView | null =
    currentRule ??
    selectedProjectRule ??
    (ruleId
      ? {
          id: ruleId,
          category,
          brand,
          series: "",
          model,
          project,
          suggested: "",
          cost: null,
          minutes: 60,
          notes: "",
          enabled: true,
          options: [],
        }
      : null);
  useEffect(() => {
    if (focusOptions)
      optionSection.current?.scrollIntoView({ block: "nearest" });
  }, [focusOptions]);
  return (
    <ActionForm
      submit={it.saveAndLeave}
      disableUnchangedSave={Boolean(rule)}
      changeKey={JSON.stringify([category, brand, model, project])}
      cancelLabel={it.close}
      className="price-rule-editor"
      closeOnSuccess
      saveRef={saveBaseQuote}
      onSuccess={(result) => {
        if (!rule && result.id) setCreatedRuleId(result.id);
        onSuccess?.(
          {
            category,
            brand: normalizeBrand(brand),
            model: normalizeDeviceModel(brand, model),
          },
          result.id,
        );
      }}
      action={(data) =>
        ruleAction(ruleId || selectedProjectRule?.id || null, {
          ...Object.fromEntries(data),
          category,
          brand,
          model,
          project,
          requiredProductId: currentRule?.requiredProductId ?? "",
          requiredQuantity: currentRule?.requiredQuantity ?? 1,
          series: model ? "" : (currentRule?.series ?? ""),
          minutes: currentRule?.minutes ?? 60,
          enabled: true,
        })
      }
    >
      <section className="price-rule-editor-section">
        <header className="price-rule-editor-heading">
          <div>
            <h3>{it.priceProjectSection}</h3>
            <p>{it.ruleHelp}</p>
          </div>
        </header>
        <div className="form-grid three">
          <Field label={it.deviceType}>
            <SimpleSelect
              value={category}
              onChange={(value) => {
                setCategory(value as Category);
                setBrand("");
                setModel("");
              }}
              placeholder={it.selectOption}
              ariaLabel={it.deviceType}
              options={Object.entries(categories).map(([key, names]) => ({
                value: key,
                label: names[locale === "zh" ? 1 : 0],
              }))}
            />
          </Field>
          <EditableSelect
            label={it.brand}
            createLabel={it.customBrand}
            value={brand}
            onChange={(v) => {
              setBrand(v);
              setModel("");
            }}
            options={uniqueOptions([
              ...brands[category],
              ...rules
                .filter((r) => r.category === category)
                .map((r) => r.brand),
            ])}
            normalize={normalizeBrand}
          />
          <EditableSelect
            label={it.model}
            createLabel={it.customModel}
            value={model}
            onChange={setModel}
            options={uniqueOptions(
              rules
                .filter(
                  (r) =>
                    r.category === category &&
                    r.brand.toLowerCase() === brand.toLowerCase(),
                )
                .map((r) => r.model),
            )}
            normalize={(value) => normalizeDeviceModel(brand, value)}
          />
        </div>
        <EditableSelect
          label={it.project}
          createLabel={it.afterSales.addCustomProject}
          value={project}
          onChange={setProject}
          options={uniqueOptions(
            rules
              .filter(
                (r) =>
                  r.category === category &&
                  r.brand.toLowerCase() === brand.toLowerCase() &&
                  r.model.toLowerCase() === model.toLowerCase(),
              )
              .map((r) => r.project),
          )}
          required
        />
        <div className="form-grid">
          <Field label={it.suggested + " (€)"}>
            <input
              name="suggested"
              required
              inputMode="decimal"
              defaultValue={rule?.suggested}
            />
          </Field>
          <Field label={it.cost}>
            <input
              name="cost"
              inputMode="decimal"
              defaultValue={rule?.cost ?? ""}
            />
          </Field>
        </div>
        <Field label={it.notes}>
          <input name="notes" defaultValue={rule?.notes} maxLength={2000} />
        </Field>
      </section>
      <section
        className="price-rule-editor-section price-rule-editor-options"
        ref={optionSection}
      >
        <header className="price-rule-editor-heading">
          <div>
            <h3>{it.partPriceOptions}</h3>
            <p>{it.partOptionsHelp}</p>
          </div>
          {optionRule && (
            <span className="price-rule-editor-count">
              {optionRule.options?.length ?? 0}
            </span>
          )}
        </header>
        {optionRule?.options?.length ? (
          <div className="price-option-list">
            {optionRule.options.map((option) => (
              <article
                className={`price-option-card${option.enabled ? "" : " is-disabled"}`}
                key={option.id}
              >
                <div className="price-option-card-heading">
                  <div className="price-option-card-title">
                    <div className="price-option-card-title-row">
                      <strong>{option.name}</strong>
                      <div className="price-option-actions">
                        {option.enabled && (
                          <button
                            type="button"
                            className={`price-option-default-action${option.isDefault ? " is-default" : ""}`}
                            disabled={optionPending || option.isDefault}
                            onClick={async () => {
                              setOptionPending(true);
                              setOptionError("");
                              try {
                                const result = await priceRuleOptionAction(
                                  optionRule.id,
                                  option.id,
                                  {
                                    ...option,
                                    isDefault: true,
                                    cost: option.cost ?? "",
                                  },
                                );
                                if (!result.ok) setOptionError(result.error);
                                else {
                                  onOptionSaved?.();
                                  router.refresh();
                                }
                              } catch {
                                setOptionError(
                                  "Connessione non disponibile. Riprova.",
                                );
                              } finally {
                                setOptionPending(false);
                              }
                            }}
                          >
                            <Star
                              size={14}
                              fill="currentColor"
                              aria-hidden="true"
                            />
                            {option.isDefault
                              ? it.defaultRecommended
                              : it.setDefault}
                          </button>
                        )}
                        <ToggleSwitch
                          className="price-option-enabled-switch"
                          role="switch"
                          checked={option.enabled}
                          enabledLabel={it.enabledState}
                          disabledLabel={it.disabledState}
                          ariaLabel={`${option.name}: ${option.enabled ? it.disabled : it.enabled}`}
                          title={`${option.name}: ${option.enabled ? it.disabled : it.enabled}`}
                          disabled={optionPending}
                          onToggle={async (enabled) => {
                            setOptionPending(true);
                            setOptionError("");
                            try {
                              const result = await priceRuleOptionAction(
                                optionRule.id,
                                option.id,
                                {
                                  ...option,
                                  enabled,
                                  isDefault: enabled ? option.isDefault : false,
                                  cost: option.cost ?? "",
                                },
                              );
                              if (!result.ok) {
                                setOptionError(result.error);
                                return false;
                              }
                              onOptionSaved?.();
                              router.refresh();
                              return true;
                            } catch {
                              setOptionError(
                                "Connessione non disponibile. Riprova.",
                              );
                              return false;
                            } finally {
                              setOptionPending(false);
                            }
                          }}
                        />
                      </div>
                    </div>
                    <small>{option.product.name}</small>
                  </div>
                  <RecordIcon
                    kind="edit"
                    label={it.editPartOption}
                    disabled={optionPending}
                    onClick={() => setEditingOption({ option })}
                  />
                </div>
                <div className="price-option-data">
                  <span>
                    <small>{it.suggested}</small>
                    <strong>{money(cents(option.suggested))}</strong>
                  </span>
                  <span>
                    <small>{it.cost}</small>
                    <strong>
                      {option.cost ? money(cents(option.cost)) : "—"}
                    </strong>
                  </span>
                  <span>
                    <small>{it.quantity}</small>
                    <strong>{option.quantity}</strong>
                  </span>
                  <span>
                    <small>{it.durationMinutes}</small>
                    <strong>{option.minutes}</strong>
                  </span>
                  <span>
                    <small>{it.warrantyDays}</small>
                    <strong>{option.warrantyDays}</strong>
                  </span>
                  <span>
                    <small>{it.availableStock}</small>
                    <strong>
                      {option.product.available} / {option.product.stock}
                    </strong>
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : optionRule ? (
          <p className="empty">{it.noPartOptions}</p>
        ) : null}
        <Message error={optionError} />
        {project.trim() && (
          <button
            type="button"
            className="quick-service-picker-add price-option-add"
            disabled={optionPending}
            onClick={async () => {
              if (selectedProjectRule && !ruleId) {
                setEditingOption({});
                return;
              }
              if (await saveBaseQuote.current?.()) setEditingOption({});
            }}
          >
            <Plus size={16} /> {it.addPartOption}
          </button>
        )}
      </section>
      {editingOption && optionRule && (
        <FormDialog
          title={editingOption.option ? it.editPartOption : it.newPartOption}
          onClose={() => setEditingOption(null)}
        >
          <PriceRuleOptionForm
            rule={optionRule}
            option={editingOption.option}
            products={repairProducts}
            compatibility={{ category, brand, model, project }}
            onSuccess={() => {
              setEditingOption(null);
              onOptionSaved?.();
              router.refresh();
            }}
          />
        </FormDialog>
      )}
    </ActionForm>
  );
}

export function CustomerForm({
  customer,
  onSuccess,
  onCancel,
}: {
  onSuccess?: () => void;
  onCancel?: () => void;
  customer?: {
    id: string;
    name: string;
    phone: string;
    phones: { phone: string }[];
  };
}) {
  const it = useMessages();
  const router = useRouter();
  const [phones, setPhones] = useState(
    customer?.phones.map((p) => p.phone).filter((p) => p !== customer.phone) ??
      [],
  );
  return (
    <ActionForm
      submit={it.save}
      disableUnchangedSave={Boolean(customer)}
      changeKey={JSON.stringify(phones)}
      onSuccess={onSuccess}
      onCancel={onCancel}
      action={async (data) => {
        const result = await customerAction(customer?.id ?? null, {
          name: str(data, "name"),
          phone: str(data, "phone"),
          additionalPhones: phones,
        });
        if (result.ok && !customer && !onSuccess)
          router.push("/customers/" + result.id);
        return result;
      }}
    >
      <Field label={it.name}>
        <input
          name="name"
          defaultValue={customer?.name}
          required
          maxLength={120}
        />
      </Field>
      <Field label={it.phone}>
        <input
          name="phone"
          defaultValue={customer?.phone}
          required
          maxLength={30}
        />
      </Field>
      {phones.map((phone, index) => (
        <div className="phone-row" key={index}>
          <Field label={it.phone + " " + (index + 2)}>
            <input
              value={phone}
              required
              maxLength={30}
              onChange={(e) =>
                setPhones(
                  phones.map((p, i) => (i === index ? e.target.value : p)),
                )
              }
            />
          </Field>
          <RecordIcon
            kind="delete"
            label={it.remove + " " + it.phone + " " + (index + 2)}
            onClick={() => setPhones(phones.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={phones.length >= 2}
        onClick={() => setPhones([...phones, ""])}
      >
        {it.addPhone}
      </Button>
    </ActionForm>
  );
}
export function DeleteRecord({
  id,
  kind,
}: {
  id: string;
  kind: "customer" | "device";
}) {
  const it = useMessages();
  const router = useRouter();
  return (
    <ActionForm
      submit={kind === "customer" ? it.deleteCustomer : it.deleteDevice}
      action={async () => {
        if (!window.confirm(it.deleteConfirm)) return { ok: false, error: "" };
        const result = await (kind === "customer"
          ? deleteCustomerAction(id)
          : deleteDeviceAction(id));
        if (result.ok && kind === "customer") router.push("/customers");
        return result;
      }}
    >
      <></>
    </ActionForm>
  );
}
export function DeviceForm({
  device,
  customerId,
  onSuccess,
  onCancel,
}: {
  onSuccess?: () => void;
  onCancel?: () => void;
  customerId?: string;
  device?: {
    id: string;
    category: string;
    brand: string;
    model: string;
    imei: string | null;
  };
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const [category, setCategory] = useState<Category>(
    (device?.category ?? "PHONE") as Category,
  );
  const [brand, setBrand] = useState(device?.brand ?? "");
  const [model, setModel] = useState(device?.model ?? "");
  return (
    <ActionForm
      submit={it.save}
      disableUnchangedSave={Boolean(device)}
      changeKey={JSON.stringify([category, brand, model])}
      onSuccess={onSuccess}
      onCancel={onCancel}
      action={(data) => {
        const input = { ...Object.fromEntries(data), brand, model };
        return device
          ? deviceAction(device.id, input)
          : createDeviceAction(customerId!, input);
      }}
    >
      <Field label={it.deviceType}>
        <SimpleSelect
          name="category"
          value={category}
          onChange={(value) => {
            setCategory(value as Category);
            setBrand("");
            setModel("");
          }}
          placeholder={it.selectOption}
          ariaLabel={it.deviceType}
          options={Object.entries(categories).map(([key, names]) => ({
            value: key,
            label: names[locale === "zh" ? 1 : 0],
          }))}
        />
      </Field>
      <EditableSelect
        label={it.brand}
        createLabel={it.customBrand}
        value={brand}
        onChange={(value) => {
          setBrand(value);
          setModel("");
        }}
        options={brands[category] ?? []}
        normalize={normalizeBrand}
        required
      />
      <EditableSelect
        label={it.model}
        createLabel={it.customModel}
        value={model}
        onChange={setModel}
        options={models[category]?.[brand] ?? []}
        normalize={(value) => normalizeDeviceModel(brand, value)}
        readOnly={!brand}
        required
      />
      <Field label={it.imei}>
        <input name="imei" defaultValue={device?.imei ?? ""} maxLength={30} />
      </Field>
    </ActionForm>
  );
}
const priceBrandIcons: Record<string, SimpleIcon> = {
  acer: siAcer,
  apple: siApple,
  asus: siAsus,
  dell: siDell,
  fitbit: siFitbit,
  garmin: siGarmin,
  google: siGoogle,
  honor: siHonor,
  hp: siHp,
  huawei: siHuawei,
  lenovo: siLenovo,
  motorola: siMotorola,
  msi: siMsi,
  nokia: siNokia,
  oneplus: siOneplus,
  oppo: siOppo,
  samsung: siSamsung,
  sony: siSony,
  vivo: siVivo,
  xiaomi: siXiaomi,
};

function PriceBrandMark({ brand }: { brand: string }) {
  const brandKey = brand.trim().toLocaleLowerCase("it");
  if (brandKey === "microsoft") {
    return (
      <svg
        className="price-brand-logo"
        data-brand-icon="logo"
        viewBox="0 0 24 24"
        role="img"
        aria-label="Microsoft"
      >
        <path fill="#f35325" d="M1 1h10v10H1z" />
        <path fill="#81bc06" d="M13 1h10v10H13z" />
        <path fill="#05a6f0" d="M1 13h10v10H1z" />
        <path fill="#ffba08" d="M13 13h10v10H13z" />
      </svg>
    );
  }
  if (brandKey === "nintendo") {
    return (
      <svg
        className="price-brand-logo price-brand-logo-wide"
        data-brand-icon="logo"
        viewBox="0 0 32 24"
        role="img"
        aria-label="Nintendo"
      >
        <rect x="1" y="4" width="30" height="16" rx="8" fill="#e60012" />
        <text
          x="16"
          y="14"
          fill="#fff"
          fontSize="5.5"
          fontWeight="700"
          textAnchor="middle"
        >
          Nintendo
        </text>
      </svg>
    );
  }
  if (brandKey === "realme") {
    return (
      <span
        className="price-brand-wordmark price-brand-realme"
        data-brand-icon="logo"
        aria-label="realme"
      >
        realme
      </span>
    );
  }
  const icon = priceBrandIcons[brandKey];
  if (!icon) {
    return (
      <span className="price-brand-fallback" data-brand-icon="fallback">
        {brand.trim().charAt(0).toLocaleUpperCase("it") || "·"}
      </span>
    );
  }
  return (
    <svg
      className="price-brand-logo"
      data-brand-icon="logo"
      viewBox="0 0 24 24"
      role="img"
      aria-label={icon.title}
      style={{ color: `#${icon.hex === "FFFFFF" ? "111111" : icon.hex}` }}
    >
      <path fill="currentColor" d={icon.path} />
    </svg>
  );
}

function PriceRuleOptionForm({
  rule,
  option,
  products,
  productCategories = [],
  compatibility,
  onSuccess,
}: {
  rule: RuleView;
  option?: PriceRuleOptionView;
  products: {
    id: string;
    name: string;
    category: string;
    stockQuantity: number;
    costPrice?: string;
  }[];
  productCategories?: CategoryView[];
  compatibility?: ProductCompatibilityDraft;
  onSuccess: () => void;
}) {
  const it = useMessages();
  const [createdProducts, setCreatedProducts] = useState<
    {
      id: string;
      name: string;
      category: string;
      stockQuantity: number;
      costPrice?: string;
    }[]
  >([]);
  const [creatingProduct, setCreatingProduct] = useState<string | null>(null);
  const availableProducts = [
    ...products,
    ...createdProducts.filter(
      (created) => !products.some((product) => product.id === created.id),
    ),
  ];
  const [productId, setProductId] = useState(option?.productId ?? "");
  const selected = availableProducts.find(
    (product) => product.id === productId,
  );
  const [name, setName] = useState(option?.name ?? "");
  const [suggested, setSuggested] = useState(option?.suggested ?? "");
  const [cost, setCost] = useState(option?.cost ?? "");
  const [quantity, setQuantity] = useState(option?.quantity ?? 1);
  const [minutes, setMinutes] = useState(option?.minutes ?? rule.minutes);
  const [warrantyDays, setWarrantyDays] = useState(option?.warrantyDays ?? 0);
  const [enabled, setEnabled] = useState(option?.enabled ?? true);
  const [isDefault, setIsDefault] = useState(option?.isDefault ?? false);
  const [notes, setNotes] = useState(option?.notes ?? "");
  const selectProduct = (value: string) => {
    setProductId(value);
    const product = availableProducts.find((entry) => entry.id === value);
    if (!product) return;
    if (!option || !name.trim()) setName(product.name);
    if (!cost.trim() && product.costPrice) setCost(product.costPrice);
  };
  return (
    <>
      <ActionForm
        submit={it.save}
        disableUnchangedSave={Boolean(option)}
        changeKey={JSON.stringify([
          productId,
          name,
          suggested,
          cost,
          quantity,
          minutes,
          warrantyDays,
          enabled,
          isDefault,
          notes,
        ])}
        onSuccess={onSuccess}
        action={() =>
          priceRuleOptionAction(rule.id, option?.id ?? null, {
            productId,
            name: name.trim() || selected?.name || "",
            suggested,
            cost,
            quantity,
            minutes,
            warrantyDays,
            enabled,
            isDefault,
            notes,
          })
        }
      >
        <Field label={it.requiredPart}>
          <SearchableCombobox
            value={productId}
            onChange={selectProduct}
            ariaLabel={it.requiredPart}
            placeholder={it.selectOption}
            searchPlaceholder={it.searchInventoryPart}
            emptyText={it.noMatches}
            groups={[
              {
                options: availableProducts.map((product) => ({
                  value: product.id,
                  label: product.name,
                  secondary: product.category,
                  trailing: `${it.actualStock} ${product.stockQuantity}`,
                })),
              },
            ]}
            customLabel={it.repairPart}
            onCustom={setCreatingProduct}
            creationControls="no-match"
          />
        </Field>
        <div className="form-grid two">
          <Field label={it.partOptionName}>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          <Field label={`${it.suggested} (€)`}>
            <input
              value={suggested}
              inputMode="decimal"
              onChange={(event) => setSuggested(event.target.value)}
              required
            />
          </Field>
          <Field label={`${it.cost} (€)`}>
            <input
              value={cost}
              inputMode="decimal"
              onChange={(event) => setCost(event.target.value)}
            />
          </Field>
          <Field label={it.quantity}>
            <QuantityStepper
              ariaLabel={it.quantity}
              min={1}
              value={quantity}
              onValueChange={(value) => setQuantity(Number(value))}
            />
          </Field>
          <Field label={it.durationMinutes}>
            <input
              type="number"
              min={0}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            />
          </Field>
          <Field label={it.warrantyDays}>
            <input
              type="number"
              min={0}
              value={warrantyDays}
              onChange={(event) => setWarrantyDays(Number(event.target.value))}
            />
          </Field>
        </div>
        <Field label={it.notes}>
          <textarea
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        <div className="form-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {it.enabled}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />
            {it.defaultRecommended}
          </label>
        </div>
      </ActionForm>
      {creatingProduct !== null && (
        <FormDialog
          title={it.newRepairPart}
          onClose={() => setCreatingProduct(null)}
        >
          <ProductForm
            categories={productCategories}
            mode="inventory"
            initialName={creatingProduct}
            initialUsage="REPAIR"
            quickRepair
            initialCompatibility={
              compatibility ?? {
                category: rule.category,
                brand: rule.brand,
                model: rule.model,
                project: rule.project,
              }
            }
            onClose={() => setCreatingProduct(null)}
            onCreated={(product) => {
              const created = {
                id: product.id,
                name: product.name,
                category: product.category,
                stockQuantity: product.stock,
                costPrice: product.costPrice,
              };
              setCreatedProducts((current) => [...current, created]);
              setProductId(created.id);
              setName(created.name);
              if (created.costPrice) setCost(created.costPrice);
            }}
          />
        </FormDialog>
      )}
    </>
  );
}

export function PriceList({
  rules,
  repairProducts,
}: {
  rules: RuleView[];
  repairProducts: {
    id: string;
    name: string;
    category: string;
    stockQuantity: number;
    costPrice: string;
  }[];
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [batchMode, setBatchMode] = useState(false);
  const [activeRuleId, setActiveRuleId] = useState("");
  const [creating, setCreating] = useState<Partial<RuleView> | null>(null);
  const [editing, setEditing] = useState<RuleView | null>(null);
  const [focusOptions, setFocusOptions] = useState(false);
  const [saved, setSaved] = useState(false);
  const reveal = useRef("");
  const groups = groupPriceRules(rules, query);
  const visibleIds = groups.flatMap((b) =>
    b.categories.flatMap((c) =>
      c.models.flatMap((m) => m.rules.map((r) => r.id)),
    ),
  );
  const selectedIds = selected.filter((id) => visibleIds.includes(id));
  useEffect(() => {
    if (!reveal.current) return;
    const target = document.getElementById(reveal.current);
    if (target) {
      target.scrollIntoView({ block: "nearest" });
      reveal.current = "";
    }
  }, [rules, creating]);
  function toggle(key: string) {
    setExpanded((current) =>
      current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key],
    );
  }
  function updateSelection(ids: string[], checked: boolean) {
    setSelected((current) =>
      checked
        ? [...new Set([...current, ...ids])]
        : current.filter((id) => !ids.includes(id)),
    );
  }
  const heading = (
    key: string,
    label: string,
    ids: string[],
    level: "brand" | "category" | "model",
    initial?: Partial<RuleView>,
  ) => (
    <div
      className={`catalog-toolbar price-tree-heading price-tree-heading-${level}`}
    >
      {batchMode && (
        <PriceTreeCheckbox
          label={`${it.selectOption} ${label}`}
          ids={ids}
          selected={selected}
          disabled={pending}
          onChange={updateSelection}
        />
      )}
      <button
        type="button"
        className="price-toggle"
        aria-expanded={Boolean(query.trim()) || expanded.includes(key)}
        aria-controls={"group-" + key}
        onClick={() => toggle(key)}
      >
        <ChevronRight
          className="price-tree-chevron"
          size={17}
          aria-hidden="true"
        />
        <span className="price-tree-level-icon" aria-hidden="true">
          {level === "brand" ? (
            <PriceBrandMark brand={label} />
          ) : level === "category" ? (
            <Smartphone size={18} />
          ) : (
            <Package size={18} />
          )}
        </span>
        <span className="price-tree-label">{label}</span>
      </button>
      {initial && (
        <Button
          variant="ghost"
          className="price-add-project"
          onClick={() => {
            setSaved(false);
            setEditing(null);
            setFocusOptions(false);
            setCreating(initial);
          }}
        >
          <Plus size={16} />
          {it.addProject}
        </Button>
      )}
    </div>
  );

  async function remove(ids: string[]) {
    if (!window.confirm(it.deleteConfirm)) return;
    setPending(true);
    setError("");
    try {
      const result = await deleteRulesAction(ids);
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
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">{it.workspace}</div>
          <h1>{it.nav.prices}</h1>
          <p>{it.priceDescription}</p>
        </div>
        <Button
          aria-label={it.newRule}
          onClick={() => {
            setSaved(false);
            setEditing(null);
            setFocusOptions(false);
            setCreating({});
          }}
        >
          <Plus size={18} />
          {it.newRuleAction}
        </Button>
      </header>
      <div className="filters price-filters price-list-controls">
        <label className="grow">
          <span className="sr-only">{it.search}</span>
          <input
            type="search"
            placeholder={it.priceSearch}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected([]);
            }}
          />
        </label>
        <div
          className={`catalog-toolbar price-batch-toolbar${batchMode ? " is-active" : ""}`}
        >
          <BatchControls
            active={batchMode}
            pending={pending}
            selectedCount={selectedIds.length}
            hasItems={visibleIds.length > 0}
            manageLabel={it.batchManage}
            selectedLabel={it.selectedPriceItems.replace(
              "{count}",
              String(selectedIds.length),
            )}
            selectAllLabel={it.selectAll}
            showSelectAll={false}
            deleteLabel={it.deleteSelected}
            finishLabel={it.finishBatch}
            onStart={() => {
              setBatchMode(true);
              setSelected([]);
              setActiveRuleId("");
            }}
            onSelectAll={() => setSelected(visibleIds)}
            onDelete={() => remove(selectedIds)}
            onFinish={() => {
              setBatchMode(false);
              setSelected([]);
            }}
          />
        </div>
      </div>
      {(creating || editing) && (
        <FormDialog
          title={editing ? it.editQuote : it.newRule}
          onClose={() => {
            setCreating(null);
            setEditing(null);
            setFocusOptions(false);
          }}
        >
          <RuleForm
            rule={editing ?? undefined}
            initial={creating ?? undefined}
            rules={rules}
            repairProducts={repairProducts}
            focusOptions={focusOptions}
            onSuccess={(device) => {
              setSaved(true);
              if (creating) {
                setQuery("");
                setSelected([]);
                const paths = [
                  pricePath(device.brand),
                  pricePath(device.brand, device.category),
                  pricePath(device.brand, device.category, device.model),
                ];
                setExpanded((current) => [...new Set([...current, ...paths])]);
                reveal.current = "group-" + paths[2];
              }
            }}
            onOptionSaved={() => setSaved(true)}
          />
        </FormDialog>
      )}
      <Message success={saved} />
      <Message error={error} />
      <div className="price-groups">
        {groups.length === 0 && <p className="empty">{it.noPriceResults}</p>}
        {groups.map((brand) => (
          <section className="price-group" key={brand.key}>
            {heading(
              brand.key,
              brand.brand || it.generic,
              brand.categories.flatMap((category) =>
                category.models.flatMap((model) =>
                  model.rules.map((rule) => rule.id),
                ),
              ),
              "brand",
            )}
            <div
              id={"group-" + brand.key}
              hidden={!query.trim() && !expanded.includes(brand.key)}
            >
              {brand.categories.map((category) => (
                <section className="price-tree-level" key={category.key}>
                  {heading(
                    category.key,
                    categories[category.category as Category]?.[
                      locale === "zh" ? 1 : 0
                    ] ?? category.category,
                    category.models.flatMap((model) =>
                      model.rules.map((rule) => rule.id),
                    ),
                    "category",
                  )}
                  <div
                    id={"group-" + category.key}
                    hidden={!query.trim() && !expanded.includes(category.key)}
                  >
                    {category.models.map((group) => (
                      <section className="price-tree-level" key={group.key}>
                        {heading(
                          group.key,
                          group.model || it.generic,
                          group.rules.map((rule) => rule.id),
                          "model",
                          {
                            brand: brand.brand,
                            category: category.category,
                            model: group.model,
                          },
                        )}
                        <div
                          id={"group-" + group.key}
                          hidden={
                            !query.trim() && !expanded.includes(group.key)
                          }
                        >
                          <div className="rule-list">
                            <div
                              className={`price-rule-header${batchMode ? " is-batch" : ""}`}
                            >
                              {batchMode && <span aria-hidden="true" />}
                              <strong>{it.project}</strong>
                              <strong className="price-rule-heading-quote">
                                {it.quote}
                              </strong>
                              <strong className="price-option-count-heading">
                                {it.partOptionCount}
                              </strong>
                              <span aria-hidden="true" />
                            </div>
                            {group.rules.map((rule) => (
                              <article
                                key={rule.id}
                                className={`price-rule-row business-list-row${batchMode ? " is-batch" : ""}${!batchMode && activeRuleId === rule.id ? " order-row-active" : ""}`}
                                data-price-rule={rule.id}
                                onClick={() => {
                                  if (!batchMode) setActiveRuleId(rule.id);
                                }}
                              >
                                {batchMode && (
                                  <input
                                    type="checkbox"
                                    aria-label={
                                      it.selectOption +
                                      " " +
                                      rule.project +
                                      " " +
                                      rule.brand +
                                      " " +
                                      rule.model
                                    }
                                    checked={selected.includes(rule.id)}
                                    onChange={(event) =>
                                      updateSelection(
                                        [rule.id],
                                        event.target.checked,
                                      )
                                    }
                                  />
                                )}
                                <InlineRuleFields
                                  key={`${rule.id}:${rule.project}:${rule.suggested}`}
                                  rule={rule}
                                  active={
                                    !batchMode && activeRuleId === rule.id
                                  }
                                  disabled={pending}
                                  projectLabel={it.project}
                                  quoteLabel={it.quote}
                                  onClose={() =>
                                    setActiveRuleId((current) =>
                                      current === rule.id ? "" : current,
                                    )
                                  }
                                  onError={setError}
                                  onSaved={() => setSaved(true)}
                                />
                                <span
                                  className="price-option-count"
                                  aria-label={`${rule.options?.length ?? 0} ${it.partOptionCount}`}
                                >
                                  {rule.options?.length ?? 0}
                                </span>
                                <span className="price-row-actions record-actions">
                                  {!batchMode && activeRuleId !== rule.id && (
                                    <RecordIcon
                                      kind="edit"
                                      label={it.editQuote}
                                      disabled={pending}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setCreating(null);
                                        setEditing(rule);
                                        setFocusOptions(false);
                                      }}
                                    />
                                  )}
                                </span>
                              </article>
                            ))}
                          </div>
                        </div>
                      </section>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function PriceTreeCheckbox({
  label,
  ids,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  ids: string[];
  selected: string[];
  disabled: boolean;
  onChange: (ids: string[], checked: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const selectedCount = ids.filter((id) => selected.includes(id)).length;
  const checked = ids.length > 0 && selectedCount === ids.length;
  const indeterminate = selectedCount > 0 && !checked;
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={input}
      className="price-tree-checkbox"
      type="checkbox"
      aria-label={label}
      aria-checked={indeterminate ? "mixed" : checked}
      checked={checked}
      disabled={disabled || ids.length === 0}
      onChange={(event) => onChange(ids, event.target.checked)}
    />
  );
}

export function FormDialog({
  title,
  subtitle,
  onClose,
  restoreFocusComfortably = true,
  children,
}: {
  title: ReactNode;
  subtitle?: string;
  onClose: () => void;
  restoreFocusComfortably?: boolean;
  children: ReactNode;
}) {
  const it = useMessages();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const busy = () =>
    Boolean(dialog.current?.querySelector('[aria-busy="true"]'));
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      if (restoreFocusComfortably) focusComfortably(previous);
      else focusWithoutScrolling(previous);
    };
  }, [restoreFocusComfortably]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="form-dialog"
      data-prevent-card-autosave
      aria-labelledby={titleId}
      onKeyDownCapture={(event) => {
        if (
          event.key === "Escape" &&
          dialog.current?.querySelector(".date-picker-popover")
        )
          event.preventDefault();
      }}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (
          dialog.current?.querySelector(
            ".status-dropdown-menu, .date-picker-popover",
          )
        )
          return;
        if (!busy()) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          className="dialog-close icon-button"
          aria-label={it.close}
          title={it.close}
          onClick={() => {
            if (!busy()) onClose();
          }}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <FormCloseContext.Provider value={onClose}>
        {children}
      </FormCloseContext.Provider>
    </dialog>,
    document.body,
  );
}
export function NewCustomerDialog() {
  const it = useMessages();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <div>
      <Button
        aria-label={it.addCustomer}
        onClick={() => {
          setSaved(false);
          setOpen(true);
        }}
      >
        <Plus size={18} />
        {it.addCustomerAction}
      </Button>
      <Message success={saved} />
      {open && (
        <FormDialog title={it.addCustomer} onClose={() => setOpen(false)}>
          <CustomerForm
            onSuccess={() => {
              setOpen(false);
              setSaved(true);
            }}
          />
        </FormDialog>
      )}
    </div>
  );
}
