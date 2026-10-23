"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronDown,
  PackageOpen,
  Pencil,
  Plus,
  Smartphone,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { deleteProductsAction, updateProductAction } from "@/app/actions";
import {
  categories as deviceCategories,
  modelKey,
  type Category,
} from "@/lib/catalog";
import { decimal, inventoryStatus, money } from "@/lib/domain";
import { useLanguage, useMessages } from "./language";
import {
  DialogBody,
  FormDialog,
  ProductForm,
  type CategoryView,
  type DeviceCatalogDeletionView,
  type ProductCompatibilityDraft,
} from "./forms";
import { DatePicker, SimpleSelect } from "./business-select";
import { Button } from "./ui/button";
import { BatchControls } from "./ui/batch-controls";
import { QuantityStepper } from "./ui/quantity-stepper";
import {
  CompatibilityAddEditor,
  type CompatibilityDeviceDraft,
} from "./compatibility-add-editor";
export type { CategoryView } from "./forms";

const presetCategories = [
  "Accessori",
  "Ricambi",
  "Cavi",
  "Caricabatterie",
  "Usato",
];

export type ProductView = {
  id: string;
  name: string;
  category: string;
  usage: "RETAIL" | "REPAIR";
  costPrice: number;
  salePrice: number;
  stockQuantity: number;
  unlimitedStock: boolean;
  reservedQuantity: number;
  minStock: number;
  favorite: boolean;
  enabled: boolean;
  compatibilities: ProductCompatibility[];
};

type ProductCompatibility = {
  brand: string;
  category: string;
  model: string;
  project: string;
};

function ProductName({ name, favorite }: { name: string; favorite: boolean }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const viewportElement = viewport.current;
    const textElement = text.current;
    if (!viewportElement || !textElement) return;

    function measure() {
      if (!viewportElement || !textElement) return;
      const travel = Math.max(
        0,
        Math.ceil(textElement.scrollWidth - viewportElement.clientWidth),
      );
      viewportElement.dataset.overflowing = String(travel > 0);
      textElement.style.setProperty("--product-name-travel", `${travel}px`);
      textElement.style.setProperty(
        "--product-name-duration",
        `${Math.max(4, travel / 28 + 2)}s`,
      );
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewportElement);
    observer.observe(textElement);
    return () => observer.disconnect();
  }, [name]);

  return (
    <span className="product-name">
      {favorite && <Star size={14} fill="currentColor" />}
      <span ref={viewport} className="product-name-viewport" title={name}>
        <strong ref={text}>{name}</strong>
      </span>
    </span>
  );
}

function ProductCompatibilityDialog({
  product,
  options,
  catalogDeletions,
  onClose,
  onSave,
}: {
  product: ProductView;
  options: ProductCompatibilityDraft[];
  catalogDeletions: DeviceCatalogDeletionView[];
  onClose: () => void;
  onSave: (value: ProductCompatibilityDraft[]) => void;
}) {
  const it = useMessages();
  const [value, setValue] = useState<ProductCompatibilityDraft[]>(
    product.compatibilities,
  );
  const unchanged =
    JSON.stringify(value.map((entry) => JSON.stringify(entry)).sort()) ===
    JSON.stringify(
      product.compatibilities.map((entry) => JSON.stringify(entry)).sort(),
    );
  const [adding, setAdding] = useState<CompatibilityDeviceDraft | null>(null);
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
      const group = groups[key] ?? {
        category: entry.category,
        brand: entry.brand,
        model: entry.model,
        projects: [],
        indices: [],
      };
      if (entry.project && !group.projects.includes(entry.project))
        group.projects.push(entry.project);
      group.indices.push(index);
      groups[key] = group;
      return groups;
    }, {}),
  );
  function confirmAdding() {
    if (!adding) return;
    setValue((current) => [
      ...new Map(
        [
          ...current.filter(
            (entry) =>
              entry.category !== adding.category ||
              entry.brand.toLocaleLowerCase("it") !==
                adding.brand.toLocaleLowerCase("it") ||
              modelKey(entry.model) !== modelKey(adding.model),
          ),
          ...adding.projects.map((project) => ({
            category: adding.category,
            brand: adding.brand,
            model: adding.model,
            project,
          })),
        ].map((entry) => [
          [entry.category, entry.brand, entry.model, entry.project]
            .map((part) => part.toLocaleLowerCase("it"))
            .join("\u0000"),
          entry,
        ]),
      ).values(),
    ]);
    setAdding(null);
  }
  return (
    <FormDialog
      title={
        adding
          ? it.inventory.addCompatibleDevice
          : it.inventory.editCompatibleDevices
      }
      subtitle={
        adding
          ? it.inventory.compatibilityEditorHelp
          : it.inventory.compatibilityListHelp
      }
      onClose={() => (adding ? setAdding(null) : onClose())}
    >
      <div data-form-dialog-body data-product-compatibility-dialog>
        {adding ? (
          <CompatibilityAddEditor
            value={adding}
            onChange={setAdding}
            options={options}
            associated={value}
            defaultCost={decimal(product.costPrice)}
            deletions={catalogDeletions}
          />
        ) : (
          <div className="compatibility-overview">
            <section className="compatibility-product-summary">
              <span className="quick-service-picker-icon" aria-hidden="true">
                <PackageOpen size={22} />
              </span>
              <span>
                <strong>{product.name}</strong>
                <small>
                  {product.category} ·{" "}
                  {it.inventory.compatibleDeviceCount.replace(
                    "{count}",
                    String(devices.length),
                  )}
                </small>
              </span>
            </section>
            <div className="compatibility-list-heading">
              <strong>{it.inventory.compatibleDevices}</strong>
            </div>
            <div className="compatibility-device-list">
              {devices.map((device) => (
                <div
                  className="compatibility-device-row business-list-row"
                  key={device.indices[0]}
                >
                  <div className="compatibility-device-summary">
                    <strong>{device.model}</strong>
                    <span className="compatibility-projects">
                      {device.projects.length ? (
                        device.projects.map((project) => (
                          <span
                            className="compatibility-project-label"
                            key={project}
                          >
                            {project}
                            <button
                              type="button"
                              aria-label={`${it.remove} ${project}`}
                              onClick={() =>
                                setValue((current) =>
                                  current.filter(
                                    (entry) =>
                                      entry.category !== device.category ||
                                      entry.brand !== device.brand ||
                                      entry.model !== device.model ||
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
                      setValue((current) =>
                        current.filter(
                          (_, index) => !device.indices.includes(index),
                        ),
                      )
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              ))}
              {!devices.length && <p className="empty">{it.noMatches}</p>}
            </div>
            <Button
              type="button"
              variant="outline"
              className="add-device-action compatibility-add-device"
              onClick={() =>
                setAdding({
                  category: "PHONE",
                  brand: "",
                  model: "",
                  projects: [],
                })
              }
            >
              <Plus size={16} /> {it.inventory.addCompatibility}
            </Button>
          </div>
        )}
        <div className="dialog-actions">
          <Button
            type="button"
            variant="cancel"
            onClick={() => (adding ? setAdding(null) : onClose())}
          >
            {it.cancel}
          </Button>
          <Button
            type="button"
            disabled={Boolean(
              adding
                ? !adding.brand || !adding.model || adding.projects.length === 0
                : unchanged,
            )}
            onClick={() => (adding ? confirmAdding() : onSave(value))}
          >
            {adding ? it.confirm : it.save}
          </Button>
        </div>
      </div>
    </FormDialog>
  );
}

type DeviceFilter = {
  brand: string;
  category: string;
  model: string;
  project: string;
};

const emptyDeviceFilter: DeviceFilter = {
  brand: "",
  category: "",
  model: "",
  project: "",
};

function uniqueValues(values: string[]) {
  return [
    ...new Map(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => [value.toLocaleLowerCase(), value]),
    ).values(),
  ].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

type InventoryMovementView = {
  id: string;
  productName: string;
  quantity: number;
  stockBefore: number;
  stockAfter: number;
  type:
    | "INITIAL_STOCK"
    | "STOCK_IN"
    | "RETAIL_SALE"
    | "REPAIR_USE"
    | "SALE_RETURN"
    | "MANUAL_ADJUSTMENT";
  at: string;
  period: string;
};

export function InventoryHistoryCard({
  movements,
  currentPeriod,
}: {
  movements: InventoryMovementView[];
  currentPeriod: string;
}) {
  const it = useMessages();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState(currentPeriod);
  const latest = movements[0];
  const filtered = movements.filter((movement) => movement.period === period);
  const typeLabel = (type: InventoryMovementView["type"]) =>
    it.inventory.movementTypes[type];
  return (
    <>
      <button
        type="button"
        className="metric inventory-history-card"
        onClick={() => setOpen(true)}
      >
        <span className="inventory-history-border-flow" aria-hidden="true">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <rect
              x="0.75"
              y="0.75"
              width="98.5"
              height="98.5"
              rx="7"
              pathLength="100"
            />
          </svg>
        </span>
        <span className="inventory-history-card-heading">
          <span className="inventory-history-title">
            {it.inventory.movementHistory}
            <span
              className="inventory-history-title-underline"
              aria-hidden="true"
            />
          </span>
          <ArrowRight
            className="inventory-history-arrow"
            size={19}
            aria-hidden="true"
          />
        </span>
        {latest ? (
          <span className="inventory-history-preview">
            <span className="metric-icon orange">
              <PackageOpen size={20} aria-hidden="true" />
            </span>
            <span>
              <strong>{latest.productName}</strong>
              <span>
                {latest.stockBefore} → {latest.stockAfter}{" "}
                <em
                  className={
                    latest.quantity > 0
                      ? "movement-positive"
                      : "movement-negative"
                  }
                >
                  ({latest.quantity > 0 ? "+" : ""}
                  {latest.quantity})
                </em>
              </span>
              <small>
                {typeLabel(latest.type)} · {latest.at}
              </small>
            </span>
          </span>
        ) : (
          <small className="inventory-history-empty">
            {it.inventory.noMovements}
          </small>
        )}
      </button>
      {open && (
        <FormDialog
          title={it.inventory.movementHistory}
          onClose={() => setOpen(false)}
        >
          <DialogBody className="inventory-movements-dialog">
            <DatePicker
              className="retail-period-picker"
              aria-label={it.month}
              name="period"
              type="month"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            />
            {filtered.length ? (
              filtered.map((movement) => (
                <div
                  className="movement-row business-list-row"
                  key={movement.id}
                >
                  <span
                    className={
                      movement.quantity > 0
                        ? "movement-positive"
                        : "movement-negative"
                    }
                  >
                    {movement.quantity > 0 ? "+" : ""}
                    {movement.quantity}
                  </span>
                  <div>
                    <strong>{movement.productName}</strong>
                    <small>
                      {typeLabel(movement.type)} · {movement.at}
                    </small>
                  </div>
                  <b>
                    {movement.stockBefore} → {movement.stockAfter}
                  </b>
                </div>
              ))
            ) : (
              <p className="inventory-empty">{it.inventory.noMovements}</p>
            )}
          </DialogBody>
        </FormDialog>
      )}
    </>
  );
}

export function NewProductDialogButton({
  categories,
  projectCatalog = [],
  mode = "inventory",
}: {
  categories: CategoryView[];
  projectCatalog?: ProductCompatibilityDraft[];
  mode?: "inventory" | "retail";
}) {
  const it = useMessages();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        aria-label={it.inventory.newProduct}
        onClick={() => setOpen(true)}
      >
        <Plus size={18} />
        {it.inventory.newProductAction}
      </Button>
      {open && (
        <FormDialog
          title={it.inventory.newProduct}
          onClose={() => setOpen(false)}
        >
          <ProductForm
            categories={categories}
            projectCatalog={projectCatalog}
            mode={mode}
            onClose={() => setOpen(false)}
          />
        </FormDialog>
      )}
    </>
  );
}

function StockEditor({
  value,
  label,
  onSave,
}: {
  value: number;
  label: string;
  onSave: (value: number) => void;
}) {
  return (
    <div
      onClick={(event) => {
        event.stopPropagation();
        event.currentTarget.closest("tr")?.focus({ preventScroll: true });
      }}
    >
      <QuantityStepper
        key={value}
        className="is-table"
        ariaLabel={label}
        defaultValue={value}
        min={0}
        onCommit={onSave}
      />
    </div>
  );
}

function DeviceCompatibilityFilter({
  compatibilities,
  value,
  onApply,
  onClear,
}: {
  compatibilities: ProductCompatibility[];
  value: DeviceFilter;
  onApply: (value: DeviceFilter) => void;
  onClear: () => void;
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const active = Object.values(value).some(Boolean);
  const brands = uniqueValues(
    compatibilities.map((compatibility) => compatibility.brand),
  );
  const deviceTypes = uniqueValues(
    compatibilities
      .filter((compatibility) => compatibility.brand === draft.brand)
      .map((compatibility) => compatibility.category),
  );
  const models = uniqueValues(
    compatibilities
      .filter(
        (compatibility) =>
          compatibility.brand === draft.brand &&
          compatibility.category === draft.category,
      )
      .map((compatibility) => compatibility.model),
  );
  const projects = uniqueValues(
    compatibilities
      .filter(
        (compatibility) =>
          compatibility.brand === draft.brand &&
          compatibility.category === draft.category &&
          (!draft.model || compatibility.model === draft.model),
      )
      .map((compatibility) => compatibility.project),
  );
  const deviceTypeLabel = (category: string) =>
    deviceCategories[category as Category]?.[locale === "zh" ? 1 : 0] ??
    category;

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (
        root.current?.contains(event.target) ||
        panel.current?.contains(event.target)
      )
        return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const trigger = root.current?.getBoundingClientRect();
      if (!trigger) return;
      const width = panel.current?.offsetWidth ?? 290;
      const height = panel.current?.offsetHeight ?? 0;
      const edge = 12;
      const gap = 10;
      const below = trigger.bottom + gap;
      const top =
        below + height <= window.innerHeight - edge
          ? below
          : Math.max(edge, trigger.top - gap - height);
      const left = Math.min(
        Math.max(edge, trigger.left + trigger.width / 2 - width / 2),
        window.innerWidth - width - edge,
      );
      setPosition({ top, left });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, draft.brand, draft.category, draft.model]);

  return (
    <div className="inventory-device-filter" ref={root}>
      <button
        type="button"
        className={`inventory-device-filter-trigger${active ? " is-active" : ""}`}
        aria-label={it.inventory.compatibleDevices}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setDraft(value);
          setOpen((current) => !current);
        }}
      >
        <Smartphone size={16} aria-hidden="true" />
        <span>{it.inventory.compatibleDevices}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="inventory-device-popover"
            role="dialog"
            aria-label={it.inventory.compatibleDevices}
            style={position}
            data-prevent-card-autosave
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
          >
            <div className="inventory-device-popover-heading">
              <strong>{it.inventory.compatibleDevices}</strong>
              <button
                type="button"
                className="icon-button x-icon-button"
                aria-label={it.close}
                onClick={() => setOpen(false)}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            <label>{it.brand}</label>
            <SimpleSelect
              value={draft.brand}
              onChange={(brand) =>
                setDraft({ brand, category: "", model: "", project: "" })
              }
              placeholder={it.inventory.allBrands}
              ariaLabel={it.brand}
              options={[
                { value: "", label: it.inventory.allBrands },
                ...brands.map((brand) => ({ value: brand, label: brand })),
              ]}
            />
            {draft.brand && (
              <>
                <label>{it.deviceType}</label>
                <SimpleSelect
                  value={draft.category}
                  onChange={(category) =>
                    setDraft((current) => ({
                      ...current,
                      category,
                      model: "",
                      project: "",
                    }))
                  }
                  placeholder={it.inventory.allDeviceTypes}
                  ariaLabel={it.deviceType}
                  options={[
                    { value: "", label: it.inventory.allDeviceTypes },
                    ...deviceTypes.map((category) => ({
                      value: category,
                      label: deviceTypeLabel(category),
                    })),
                  ]}
                />
              </>
            )}
            {draft.category && (
              <>
                <label>{it.model}</label>
                <SimpleSelect
                  value={draft.model}
                  onChange={(model) =>
                    setDraft((current) => ({
                      ...current,
                      model,
                      project: "",
                    }))
                  }
                  placeholder={it.inventory.allModels}
                  ariaLabel={it.model}
                  options={[
                    { value: "", label: it.inventory.allModels },
                    ...models.map((model) => ({ value: model, label: model })),
                  ]}
                />
                <label>{it.inventory.repairUse}</label>
                <SimpleSelect
                  value={draft.project}
                  onChange={(project) =>
                    setDraft((current) => ({ ...current, project }))
                  }
                  placeholder={it.inventory.allRepairUses}
                  ariaLabel={it.inventory.repairUse}
                  options={[
                    { value: "", label: it.inventory.allRepairUses },
                    ...projects.map((project) => ({
                      value: project,
                      label: project,
                    })),
                  ]}
                />
              </>
            )}
            <div className="inventory-device-popover-actions">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft(emptyDeviceFilter);
                  onClear();
                  setOpen(false);
                }}
              >
                {it.inventory.clearFilter}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  onApply(draft);
                  setOpen(false);
                }}
              >
                {it.inventory.applyFilter}
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function InventoryWorkspace({
  products,
  categories: categoryOptions,
  catalogDeletions,
  projectCatalog,
  initialStatus = "",
}: {
  products: ProductView[];
  categories: CategoryView[];
  catalogDeletions: DeviceCatalogDeletionView[];
  projectCatalog: ProductCompatibility[];
  initialStatus?: "" | ReturnType<typeof inventoryStatus>;
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [usage, setUsage] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [deviceFilter, setDeviceFilter] = useState(emptyDeviceFilter);
  const [selectedId, setSelectedId] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ProductView>>({});
  const [compatibilityEditor, setCompatibilityEditor] = useState("");
  const draftsRef = useRef(drafts);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const categories = useMemo(
    () => [...new Set(products.map((product) => product.category))].sort(),
    [products],
  );
  const compatibilities = useMemo(
    () => products.flatMap((product) => product.compatibilities),
    [products],
  );
  const filtered = useMemo(
    () =>
      products.filter((product) => {
        const normalized = query.trim().toLocaleLowerCase();
        const productStatus = product.unlimitedStock
          ? "IN_STOCK"
          : inventoryStatus(product.stockQuantity, product.minStock);
        const compatibilityText = product.compatibilities
          .flatMap((compatibility) => [
            compatibility.brand,
            compatibility.model,
            compatibility.project,
          ])
          .join(" ")
          .toLocaleLowerCase();
        const matchesDevice =
          !Object.values(deviceFilter).some(Boolean) ||
          product.compatibilities.some(
            (compatibility) =>
              (!deviceFilter.brand ||
                compatibility.brand === deviceFilter.brand) &&
              (!deviceFilter.category ||
                compatibility.category === deviceFilter.category) &&
              (!deviceFilter.model ||
                compatibility.model === deviceFilter.model) &&
              (!deviceFilter.project ||
                compatibility.project === deviceFilter.project),
          );
        return (
          (!normalized ||
            product.name.toLocaleLowerCase().includes(normalized) ||
            product.category.toLocaleLowerCase().includes(normalized) ||
            compatibilityText.includes(normalized)) &&
          (!category || product.category === category) &&
          (!usage || product.usage === usage) &&
          (!status || productStatus === status) &&
          matchesDevice
        );
      }),
    [products, query, category, usage, status, deviceFilter],
  );
  const deviceTypeLabel = (category: string) =>
    deviceCategories[category as Category]?.[locale === "zh" ? 1 : 0] ??
    category;
  const compatibilityPaths = (product: ProductView) =>
    uniqueValues(
      product.compatibilities
        .filter((compatibility) => compatibility.brand)
        .map((compatibility) =>
          [
            compatibility.brand,
            deviceTypeLabel(compatibility.category),
            compatibility.model || it.inventory.allModels,
          ].join(" / "),
        ),
    );
  const usageLabel = (value: ProductView["usage"]) =>
    value === "RETAIL" ? it.inventory.retail : it.inventory.repair;
  const statusLabel = (value: ReturnType<typeof inventoryStatus>) =>
    value === "IN_STOCK"
      ? it.inventory.inStock
      : value === "LOW_STOCK"
        ? it.inventory.low
        : it.inventory.out;
  function updateDraft(product: ProductView, changes: Partial<ProductView>) {
    const next = {
      ...draftsRef.current,
      [product.id]: {
        ...(draftsRef.current[product.id] ?? product),
        ...changes,
      },
    };
    draftsRef.current = next;
    setDrafts(next);
  }
  function restoreScroll(top: number) {
    requestAnimationFrame(() => {
      window.scrollTo({ top, behavior: "auto" });
      requestAnimationFrame(() => window.scrollTo({ top, behavior: "auto" }));
    });
  }
  function saveProduct(next: ProductView, scrollTop = window.scrollY) {
    setError("");
    startTransition(async () => {
      const result = await updateProductAction(next.id, {
        ...next,
        costPrice: decimal(next.costPrice),
        salePrice: decimal(next.salePrice),
      });
      if (!result.ok) {
        setSelectedId(next.id);
        return setError(result.error);
      }
      router.refresh();
      restoreScroll(scrollTop);
    });
  }
  function commit(productId: string, scrollTop = window.scrollY) {
    const next = draftsRef.current[productId];
    if (next) saveProduct(next, scrollTop);
  }
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (!selectedId) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-product-compatibility-dialog]")) return;
      if (target.closest(`[data-inventory-product="${selectedId}"]`)) return;
      const scrollTop = window.scrollY;
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      commit(selectedId, scrollTop);
      setSelectedId("");
      restoreScroll(scrollTop);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  });
  function removeSelected() {
    if (!checked.length || !window.confirm(it.deleteConfirm)) return;
    startTransition(async () => {
      const result = await deleteProductsAction(checked);
      if (!result.ok) return setError(result.error);
      setChecked([]);
      setBatchMode(false);
      router.refresh();
    });
  }
  return (
    <section className="panel inventory-main">
      <div className="inventory-filters">
        <input
          aria-label={it.inventory.search}
          placeholder={it.inventory.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SimpleSelect
          value={category}
          onChange={setCategory}
          placeholder={it.inventory.allCategories}
          ariaLabel={it.inventory.category}
          options={[
            { value: "", label: it.inventory.allCategories },
            ...categories.map((item) => ({ value: item, label: item })),
          ]}
        />
        <SimpleSelect
          value={usage}
          onChange={setUsage}
          placeholder={it.inventory.allUsages}
          ariaLabel={it.inventory.usage}
          options={[
            { value: "", label: it.inventory.allUsages },
            { value: "RETAIL", label: it.inventory.retail },
            { value: "REPAIR", label: it.inventory.repair },
          ]}
        />
        <SimpleSelect
          value={status}
          onChange={(value) =>
            setStatus(value as "" | ReturnType<typeof inventoryStatus>)
          }
          placeholder={it.inventory.allStatuses}
          ariaLabel={it.inventory.status}
          options={[
            { value: "", label: it.inventory.allStatuses },
            { value: "IN_STOCK", label: it.inventory.inStock },
            { value: "LOW_STOCK", label: it.inventory.low },
            { value: "OUT_OF_STOCK", label: it.inventory.out },
          ]}
        />
        <DeviceCompatibilityFilter
          compatibilities={compatibilities}
          value={deviceFilter}
          onApply={setDeviceFilter}
          onClear={() => setDeviceFilter(emptyDeviceFilter)}
        />
        <div className="inventory-batch-controls">
          <BatchControls
            active={batchMode}
            pending={pending}
            selectedCount={checked.length}
            hasItems={filtered.length > 0}
            manageLabel={it.batchManage}
            selectedLabel={it.inventory.selectedCount.replace(
              "{count}",
              String(checked.length),
            )}
            selectAllLabel={it.selectAll}
            deleteLabel={it.inventory.deleteBatch}
            finishLabel={it.inventory.finishBatch}
            onStart={() => {
              setBatchMode(true);
              setChecked([]);
            }}
            onSelectAll={() =>
              setChecked(filtered.map((product) => product.id))
            }
            onDelete={removeSelected}
            onFinish={() => {
              setBatchMode(false);
              setChecked([]);
            }}
          />
        </div>
      </div>
      {error && <p className="message error">{error}</p>}
      {filtered.length ? (
        <div className="table-scroll inventory-table-scroll">
          <table className="inventory-table">
            <thead>
              <tr>
                {batchMode && (
                  <th className="inventory-selection">
                    <input
                      type="checkbox"
                      aria-label={it.selectAll}
                      disabled={pending || !filtered.length}
                      checked={
                        filtered.length > 0 &&
                        filtered.every((product) =>
                          checked.includes(product.id),
                        )
                      }
                      ref={(element) => {
                        if (element)
                          element.indeterminate =
                            checked.some((id) =>
                              filtered.some((product) => product.id === id),
                            ) &&
                            !filtered.every((product) =>
                              checked.includes(product.id),
                            );
                      }}
                      onChange={(event) =>
                        setChecked(
                          event.target.checked
                            ? filtered.map((product) => product.id)
                            : [],
                        )
                      }
                    />
                  </th>
                )}
                <th className="inventory-status-cell">{it.inventory.status}</th>
                <th className="inventory-product-cell">
                  {it.inventory.product}
                </th>
                <th className="inventory-category-cell">
                  {it.inventory.category}
                </th>
                <th className="inventory-usage-cell">{it.inventory.usage}</th>
                <th className="inventory-compatible-cell">
                  {it.inventory.compatibleDevices}
                </th>
                <th className="numeric inventory-price-cell">
                  {it.inventory.costPrice}
                </th>
                <th className="numeric inventory-price-cell">
                  {it.inventory.salePrice}
                </th>
                <th className="inventory-stepper-cell">
                  {it.inventory.currentStock}
                </th>
                <th className="inventory-quantity-cell">{it.reservedStock}</th>
                <th className="inventory-quantity-cell">{it.availableStock}</th>
                <th className="inventory-stepper-cell">
                  {it.inventory.minimumStock}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((source) => {
                const product = drafts[source.id] ?? source;
                const selected = selectedId === product.id;
                const productStatus = product.unlimitedStock
                  ? "IN_STOCK"
                  : inventoryStatus(product.stockQuantity, product.minStock);
                return (
                  <tr
                    key={product.id}
                    className={`business-list-row${selected ? " order-row-active" : ""}`}
                    data-inventory-product={product.id}
                    tabIndex={selected ? 0 : undefined}
                    onClick={(event) => {
                      if (batchMode || selected) return;
                      const row = event.currentTarget;
                      setSelectedId(product.id);
                      requestAnimationFrame(() =>
                        row.focus({ preventScroll: true }),
                      );
                    }}
                    onKeyDown={(event) => {
                      if (
                        !selected ||
                        event.key !== "Enter" ||
                        !(event.target instanceof Element) ||
                        event.target.closest("[data-prevent-card-autosave]")
                      )
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      const scrollTop = window.scrollY;
                      const active = document.activeElement;
                      if (active instanceof HTMLElement) active.blur();
                      requestAnimationFrame(() => {
                        commit(product.id, scrollTop);
                        setSelectedId("");
                        restoreScroll(scrollTop);
                      });
                    }}
                  >
                    {batchMode && (
                      <td className="inventory-selection">
                        <input
                          type="checkbox"
                          aria-label={`${it.selectOption} ${product.name}`}
                          checked={checked.includes(product.id)}
                          onChange={(event) =>
                            setChecked(
                              event.target.checked
                                ? [...checked, product.id]
                                : checked.filter((id) => id !== product.id),
                            )
                          }
                        />
                      </td>
                    )}
                    <td className="inventory-status-cell">
                      <span
                        className={`stock-badge stock-${productStatus.toLowerCase()}`}
                      >
                        {statusLabel(productStatus)}
                      </span>
                    </td>
                    <td className="inventory-product-cell">
                      {selected ? (
                        <div className="inventory-name-edit">
                          <button
                            type="button"
                            aria-label={it.inventory.favorite}
                            className="favorite-toggle"
                            onClick={() =>
                              updateDraft(product, {
                                favorite: !product.favorite,
                              })
                            }
                          >
                            <Star
                              size={16}
                              fill={product.favorite ? "currentColor" : "none"}
                            />
                          </button>
                          <input
                            value={product.name}
                            onChange={(event) =>
                              updateDraft(product, {
                                name: event.target.value,
                              })
                            }
                          />
                        </div>
                      ) : (
                        <ProductName
                          name={product.name}
                          favorite={product.favorite}
                        />
                      )}
                    </td>
                    <td className="inventory-category-cell">
                      {selected ? (
                        <SimpleSelect
                          value={product.category}
                          onChange={(category) =>
                            updateDraft(product, { category })
                          }
                          options={[
                            ...new Set([
                              product.category,
                              ...presetCategories,
                              ...categoryOptions.map((item) => item.name),
                            ]),
                          ].map((item) => ({ value: item, label: item }))}
                          placeholder={it.selectOption}
                          ariaLabel={it.inventory.category}
                        />
                      ) : (
                        product.category
                      )}
                    </td>
                    <td className="inventory-usage-cell">
                      {selected ? (
                        <SimpleSelect
                          value={product.usage}
                          onChange={(value) => {
                            const usage = value as ProductView["usage"];
                            updateDraft(product, {
                              usage,
                              ...(usage === "REPAIR"
                                ? { unlimitedStock: false }
                                : {}),
                            });
                          }}
                          placeholder={it.selectOption}
                          ariaLabel={it.inventory.usage}
                          options={[
                            { value: "RETAIL", label: it.inventory.retail },
                            { value: "REPAIR", label: it.inventory.repair },
                          ]}
                        />
                      ) : (
                        usageLabel(product.usage)
                      )}
                    </td>
                    <td className="inventory-compatible-cell">
                      {selected && product.usage === "REPAIR" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="inventory-compatible-edit"
                          aria-label={it.inventory.editCompatibleDevices}
                          title={it.inventory.editCompatibleDevices}
                          onClick={() => setCompatibilityEditor(product.id)}
                        >
                          {it.inventory.compatibleDevices}
                          <Pencil size={15} aria-hidden="true" />
                        </Button>
                      ) : compatibilityPaths(product).length ? (
                        <span className="inventory-compatibility-list">
                          {compatibilityPaths(product).map((path) => (
                            <span key={path}>{path}</span>
                          ))}
                        </span>
                      ) : (
                        <span className="inventory-universal">
                          {it.inventory.universal}
                        </span>
                      )}
                    </td>
                    <td className="numeric inventory-price-cell">
                      {selected ? (
                        <input
                          className="price-input"
                          inputMode="decimal"
                          defaultValue={decimal(product.costPrice)}
                          onBlur={(event) =>
                            updateDraft(product, {
                              costPrice: Math.round(
                                Number(event.target.value.replace(",", ".")) *
                                  100,
                              ),
                            })
                          }
                        />
                      ) : (
                        money(product.costPrice)
                      )}
                    </td>
                    <td className="numeric inventory-price-cell">
                      {product.usage === "REPAIR" ? (
                        "—"
                      ) : selected ? (
                        <input
                          className="price-input"
                          inputMode="decimal"
                          defaultValue={decimal(product.salePrice)}
                          onBlur={(event) =>
                            updateDraft(product, {
                              salePrice: Math.round(
                                Number(event.target.value.replace(",", ".")) *
                                  100,
                              ),
                            })
                          }
                        />
                      ) : (
                        money(product.salePrice)
                      )}
                    </td>
                    <td className="inventory-stepper-cell">
                      {selected && product.usage === "RETAIL" && (
                        <button
                          type="button"
                          className="motion-switch"
                          role="switch"
                          aria-checked={product.unlimitedStock}
                          aria-label={it.inventory.unlimitedStock}
                          onClick={() =>
                            updateDraft(product, {
                              unlimitedStock: !product.unlimitedStock,
                            })
                          }
                        >
                          <span aria-hidden="true" />
                        </button>
                      )}
                      {product.unlimitedStock ? (
                        "∞"
                      ) : selected ? (
                        <StockEditor
                          value={product.stockQuantity}
                          label={it.inventory.currentStock}
                          onSave={(value) =>
                            updateDraft(product, { stockQuantity: value })
                          }
                        />
                      ) : (
                        product.stockQuantity
                      )}
                    </td>
                    <td className="inventory-quantity-cell">
                      {product.unlimitedStock ? "—" : product.reservedQuantity}
                    </td>
                    <td className="inventory-quantity-cell">
                      {product.unlimitedStock
                        ? "∞"
                        : Math.max(
                            0,
                            product.stockQuantity - product.reservedQuantity,
                          )}
                    </td>
                    <td className="inventory-stepper-cell">
                      {product.unlimitedStock ? (
                        "—"
                      ) : selected ? (
                        <StockEditor
                          value={product.minStock}
                          label={it.inventory.minimumStock}
                          onSave={(value) =>
                            updateDraft(product, { minStock: value })
                          }
                        />
                      ) : (
                        product.minStock
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="inventory-empty">{it.inventory.noProducts}</p>
      )}
      {compatibilityEditor &&
        (() => {
          const source = products.find(
            (product) => product.id === compatibilityEditor,
          );
          const product = drafts[compatibilityEditor] ?? source;
          return product ? (
            <ProductCompatibilityDialog
              product={product}
              options={projectCatalog}
              catalogDeletions={catalogDeletions}
              onClose={() => setCompatibilityEditor("")}
              onSave={(compatibilities) => {
                const next = { ...product, compatibilities };
                updateDraft(product, next);
                saveProduct(next);
                setCompatibilityEditor("");
                setSelectedId("");
              }}
            />
          ) : null;
        })()}
    </section>
  );
}
