"use client";
import { useMemo, useState, useTransition } from "react";
import {
  Banknote,
  BatteryCharging,
  Boxes,
  Cable,
  Check,
  CircleEllipsis,
  ClipboardList,
  CreditCard,
  Headphones,
  Package,
  Pencil,
  PlugZap,
  ShieldCheck,
  Smartphone,
  Star,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { createRetailSaleAction } from "@/app/actions";
import { cents, creatablePaymentMethods, decimal, money } from "@/lib/domain";
import { FormDialog } from "./forms";
import { useMessages } from "./language";
import { NewProductDialogButton } from "./inventory";
import type { CategoryView } from "./inventory";
import {
  RetailSaleDetail,
  RetailSalesHistory,
  type SaleHistoryRow,
} from "./retail-sales-history";
import { Button } from "./ui/button";
import { QuantityStepper } from "./ui/quantity-stepper";

type RetailProduct = {
  id: string;
  name: string;
  category: string;
  salePrice: number;
  stockQuantity: number;
  unlimitedStock: boolean;
  favorite: boolean;
};
type RetailQuickService = {
  id: string;
  name: string;
  notes: string;
  defaultPrice: number;
};
const quickServiceFilter = "__quick_services__";

function productCategoryIcon(category: string, name: string) {
  const value = `${category} ${name}`.trim().toLocaleLowerCase();
  if (/cav|cable|线/.test(value)) return { Icon: Cable, kind: "cable" };
  if (/batter|电池/.test(value))
    return { Icon: BatteryCharging, kind: "battery" };
  if (/carica|charger|aliment|plug|充电|电源/.test(value))
    return { Icon: PlugZap, kind: "charger" };
  if (/cuff|audio|headphone|耳机/.test(value))
    return { Icon: Headphones, kind: "audio" };
  if (/cover|custodia|case|保护|手机壳/.test(value))
    return { Icon: ShieldCheck, kind: "case" };
  if (/usato|used|smartphone|telefono|phone|二手|手机/.test(value))
    return { Icon: Smartphone, kind: "device" };
  if (/accessor|配件/.test(value)) return { Icon: Boxes, kind: "accessory" };
  return { Icon: Package, kind: "product" };
}

const paymentIcons = {
  CASH: Banknote,
  CARD: CreditCard,
  OTHER: CircleEllipsis,
};

type RetailDialog =
  | { view: "history" }
  | {
      view: "detail";
      sale: SaleHistoryRow;
      returnTo: "history" | "completed";
    }
  | { view: "completed"; sale: SaleHistoryRow };

export function RetailWorkbench({
  products,
  quickServices,
  categories: productCategories,
  sales: initialSales,
  initialPeriod,
  initialView,
  initialSaleId,
  title,
  description,
}: {
  products: RetailProduct[];
  quickServices: RetailQuickService[];
  categories: CategoryView[];
  sales: SaleHistoryRow[];
  initialPeriod: string;
  initialView?: "history" | "detail";
  initialSaleId?: string;
  title: string;
  description: string;
}) {
  const it = useMessages();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [serviceCart, setServiceCart] = useState<Record<string, string>>({});
  const [editingServicePrice, setEditingServicePrice] = useState("");
  const [discount, setDiscount] = useState("0");
  const [editingDiscount, setEditingDiscount] = useState(false);
  const [method, setMethod] =
    useState<(typeof creatablePaymentMethods)[number]>("CASH");
  const [sales, setSales] = useState(initialSales);
  const [period, setPeriod] = useState(initialPeriod);
  const [dialog, setDialog] = useState<RetailDialog | null>(() => {
    if (initialView === "history") return { view: "history" };
    if (initialView === "detail") {
      const sale = initialSales.find((item) => item.id === initialSaleId);
      if (sale) return { view: "detail", sale, returnTo: "history" };
    }
    return null;
  });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const categories = useMemo(
    () => [...new Set(products.map((product) => product.category))].sort(),
    [products],
  );
  const filtered = products.filter((product) => {
    const normalized = query.trim().toLocaleLowerCase();
    return (
      (!normalized ||
        product.name.toLocaleLowerCase().includes(normalized) ||
        product.category.toLocaleLowerCase().includes(normalized)) &&
      category !== quickServiceFilter &&
      (!category || product.category === category) &&
      (!favorites || product.favorite)
    );
  });
  const filteredServices = quickServices.filter((service) => {
    const normalized = query.trim().toLocaleLowerCase();
    return (
      (!category || category === quickServiceFilter) &&
      (!normalized ||
        service.name.toLocaleLowerCase().includes(normalized) ||
        service.notes.toLocaleLowerCase().includes(normalized))
    );
  });
  const items = products
    .filter((product) => cart[product.id])
    .map((product) => ({ ...product, quantity: cart[product.id] }));
  const subtotal = items.reduce(
    (sum, item) => sum + item.salePrice * item.quantity,
    0,
  );
  const serviceItems = quickServices
    .filter((service) => service.id in serviceCart)
    .map((service) => ({
      ...service,
      price: serviceCart[service.id],
      priceCents: (() => {
        try {
          return cents(serviceCart[service.id]);
        } catch {
          return 0;
        }
      })(),
    }));
  const combinedSubtotal =
    subtotal + serviceItems.reduce((sum, item) => sum + item.priceCents, 0);
  let discountCents = 0;
  try {
    discountCents = cents(discount || "0");
  } catch {
    discountCents = combinedSubtotal;
  }
  const total = Math.max(0, combinedSubtotal - discountCents);
  const count =
    items.reduce((sum, item) => sum + item.quantity, 0) + serviceItems.length;
  function setQuantity(product: RetailProduct, quantity: number) {
    setCart((current) => {
      const next = { ...current };
      if (quantity <= 0) delete next[product.id];
      else
        next[product.id] = Math.min(
          quantity,
          product.unlimitedStock ? 999 : product.stockQuantity,
        );
      return next;
    });
  }
  function checkout() {
    const requestId = crypto.randomUUID();
    setError("");
    startTransition(async () => {
      const result = await createRetailSaleAction({
        requestId,
        items: items.map((item) => ({
          productId: item.id,
          quantity: item.quantity,
        })),
        services: serviceItems.map((item) => ({
          serviceId: item.id,
          price: item.price,
          quantity: 1,
        })),
        discount,
        method,
      });
      if (!result.ok || !result.data)
        return setError(result.ok ? it.connectionError : result.error);
      const sale = result.data;
      setSales((current) => [
        sale,
        ...current.filter((item) => item.id !== sale.id),
      ]);
      setCart({});
      setServiceCart({});
      setDiscount("0");
      setMethod("CASH");
      setDialog({ view: "completed", sale });
    });
  }
  function closeDialog() {
    setDialog(null);
    if (initialView) window.history.replaceState(null, "", "/retail");
  }
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">{it.workspace}</div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <Button
          variant="outline"
          className="retail-sales-trigger"
          onClick={() => setDialog({ view: "history" })}
        >
          <ClipboardList size={18} />
          {it.retail.sales}
        </Button>
      </header>
      <div className="retail-layout">
        <section className="retail-products">
          <div className="panel retail-toolbar">
            <input
              aria-label={it.retail.search}
              placeholder={it.retail.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="retail-tabs">
              <button
                className={!category && !favorites ? "active" : ""}
                onClick={() => {
                  setCategory("");
                  setFavorites(false);
                }}
              >
                {it.retail.all}
              </button>
              <button
                className={favorites ? "active" : ""}
                onClick={() => {
                  setFavorites(true);
                  setCategory("");
                }}
              >
                <Star size={15} />
                {it.retail.favorites}
              </button>
              <button
                className={category === quickServiceFilter ? "active" : ""}
                onClick={() => {
                  setCategory(quickServiceFilter);
                  setFavorites(false);
                }}
              >
                <Wrench size={15} aria-hidden="true" />
                {it.quickService.title}
              </button>
              {categories.map((item) => (
                <button
                  className={category === item ? "active" : ""}
                  key={item}
                  onClick={() => {
                    setCategory(item);
                    setFavorites(false);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
          <div className="retail-product-grid">
            {filtered.map((product) => {
              const unavailable =
                !product.unlimitedStock && product.stockQuantity <= 0;
              const { Icon, kind } = productCategoryIcon(
                product.category,
                product.name,
              );
              return (
                <button
                  className="retail-product-card"
                  key={product.id}
                  disabled={unavailable}
                  onClick={() =>
                    setQuantity(product, (cart[product.id] ?? 0) + 1)
                  }
                >
                  {product.favorite && (
                    <Star
                      className="retail-favorite"
                      size={16}
                      fill="currentColor"
                    />
                  )}
                  <span
                    className="retail-product-icon"
                    data-category-icon={kind}
                  >
                    <Icon size={24} aria-hidden="true" />
                  </span>
                  <strong>{product.name}</strong>
                  <small>{product.category}</small>
                  <b>{money(product.salePrice)}</b>
                  <span className={unavailable ? "danger-text" : "muted"}>
                    {unavailable
                      ? it.retail.outOfStock
                      : product.unlimitedStock
                        ? it.inventory.unlimitedStock
                        : `${it.inventory.currentStock} ${product.stockQuantity}`}
                  </span>
                </button>
              );
            })}
            {filteredServices.map((service) => (
              <button
                className="retail-product-card retail-service-card"
                key={service.id}
                onClick={() =>
                  setServiceCart((current) => ({
                    ...current,
                    [service.id]: decimal(service.defaultPrice),
                  }))
                }
              >
                <span
                  className="retail-product-icon"
                  data-category-icon="service"
                >
                  <Wrench size={24} aria-hidden="true" />
                </span>
                <strong>{service.name}</strong>
                <small>{service.notes || it.quickService.title}</small>
                <b>{money(service.defaultPrice)}</b>
              </button>
            ))}
            <div className="retail-new-product">
              <NewProductDialogButton
                categories={productCategories}
                mode="retail"
              />
            </div>
          </div>
        </section>
        <aside className="panel retail-cart">
          <div className="section-heading">
            <div>
              <h2>{it.retail.cart}</h2>
              <span className="muted">
                {count} {it.retail.products}
              </span>
            </div>
            {count > 0 && (
              <Button
                variant="ghost"
                className="retail-clear"
                onClick={() => {
                  setCart({});
                  setServiceCart({});
                }}
              >
                <Trash2 size={15} />
                {it.retail.clear}
              </Button>
            )}
          </div>
          <div className="retail-cart-items">
            {count ? (
              <>
                {items.map((item) => (
                  <div className="retail-cart-row" key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{money(item.salePrice)}</small>
                    </div>
                    <button
                      className="retail-remove"
                      aria-label={`${it.retail.remove} ${item.name}`}
                      onClick={() => setQuantity(item, 0)}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                    <QuantityStepper
                      key={`${item.id}-${item.quantity}`}
                      className="is-retail"
                      ariaLabel={`${it.retail.quantity} ${item.name}`}
                      buttonLabel={item.name}
                      defaultValue={item.quantity}
                      min={0}
                      max={item.unlimitedStock ? 999 : item.stockQuantity}
                      onCommit={(quantity) => setQuantity(item, quantity)}
                    />
                    <b>{money(item.salePrice * item.quantity)}</b>
                  </div>
                ))}
                {serviceItems.map((item) => (
                  <div className="retail-cart-row" key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{it.quickService.title}</small>
                    </div>
                    <button
                      className="retail-remove"
                      aria-label={`${it.retail.remove} ${item.name}`}
                      onClick={() =>
                        setServiceCart((current) => {
                          const next = { ...current };
                          delete next[item.id];
                          return next;
                        })
                      }
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                    {editingServicePrice === item.id ? (
                      <label className="retail-service-price-field is-editing">
                        <span className="sr-only">{it.retail.unitPrice}</span>
                        <input
                          autoFocus
                          className="retail-service-price"
                          aria-label={`${item.name} ${it.retail.unitPrice}`}
                          inputMode="decimal"
                          value={item.price}
                          onChange={(event) =>
                            setServiceCart((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))
                          }
                          onBlur={() =>
                            window.setTimeout(() => setEditingServicePrice(""))
                          }
                        />
                        <span aria-hidden="true">€</span>
                      </label>
                    ) : (
                      <button
                        type="button"
                        className="retail-service-price-display"
                        aria-label={`${it.retail.editPrice} ${item.name}`}
                        onClick={() => setEditingServicePrice(item.id)}
                      >
                        <span>{money(item.priceCents)}</span>
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ))}
              </>
            ) : (
              <p className="retail-empty-cart">{it.retail.emptyCart}</p>
            )}
          </div>
          <div className="retail-totals">
            <div>
              <span>{it.retail.subtotal}</span>
              <strong>{money(combinedSubtotal)}</strong>
            </div>
            <div className="retail-discount-row">
              <span>{it.retail.discount}</span>
              {editingDiscount ? (
                <label className="retail-discount-field is-editing">
                  <span className="sr-only">{it.retail.discount}</span>
                  <input
                    autoFocus
                    aria-label={it.retail.discount}
                    inputMode="decimal"
                    value={discount}
                    onChange={(event) => setDiscount(event.target.value)}
                    onBlur={() => setEditingDiscount(false)}
                  />
                  <span aria-hidden="true">€</span>
                </label>
              ) : (
                <button
                  type="button"
                  className="retail-discount-display"
                  aria-label={it.retail.editDiscount}
                  onClick={() => setEditingDiscount(true)}
                >
                  <span>{money(discountCents)}</span>
                  <Pencil size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="retail-total">
              <span>{it.retail.total}</span>
              <strong>{money(total)}</strong>
            </div>
          </div>
          <fieldset className="payment-methods">
            <legend>{it.retail.paymentMethod}</legend>
            {creatablePaymentMethods.map((value) => {
              const PaymentIcon = paymentIcons[value];
              return (
                <button
                  type="button"
                  className={method === value ? "active" : ""}
                  key={value}
                  onClick={() => setMethod(value)}
                >
                  <PaymentIcon size={17} aria-hidden="true" />
                  {it.methods[value]}
                </button>
              );
            })}
          </fieldset>
          {error && <p className="message error">{error}</p>}
          <Button
            className="retail-checkout"
            disabled={
              pending ||
              !count ||
              total <= 0 ||
              discountCents >= combinedSubtotal
            }
            onClick={checkout}
          >
            {it.retail.checkout} {money(total)}
          </Button>
        </aside>
      </div>
      {dialog && (
        <FormDialog
          title={
            dialog.view === "detail" ? (
              <span className="retail-dialog-title">
                <button
                  type="button"
                  className="button button-outline back-link retail-dialog-back"
                  onClick={() =>
                    setDialog(
                      dialog.returnTo === "history"
                        ? { view: "history" }
                        : { view: "completed", sale: dialog.sale },
                    )
                  }
                >
                  ←{" "}
                  {dialog.returnTo === "history"
                    ? it.retail.salesHistory
                    : it.retail.completed}
                </button>
                <span>
                  {it.retail.detail} · {dialog.sale.code}
                </span>
              </span>
            ) : dialog.view === "history" ? (
              it.retail.salesHistory
            ) : (
              <span className="sr-only">{it.retail.completed}</span>
            )
          }
          subtitle={dialog.view === "detail" ? dialog.sale.date : undefined}
          onClose={closeDialog}
        >
          {dialog.view === "history" && (
            <RetailSalesHistory
              sales={sales}
              period={period}
              onPeriodChange={setPeriod}
              onDeleted={(id) =>
                setSales((current) => current.filter((sale) => sale.id !== id))
              }
              onSelect={(sale) =>
                setDialog({ view: "detail", sale, returnTo: "history" })
              }
            />
          )}
          {dialog.view === "detail" && <RetailSaleDetail sale={dialog.sale} />}
          {dialog.view === "completed" && (
            <section
              className="retail-success retail-success-dialog"
              role="status"
            >
              <span>
                <Check size={34} />
              </span>
              <h2>{it.retail.completed}</h2>
              <strong>{money(dialog.sale.total)}</strong>
              <p>
                {dialog.sale.method ? it.methods[dialog.sale.method] : "—"} ·{" "}
                {dialog.sale.itemCount} {it.retail.products}
              </p>
              <div>
                <Button
                  variant="outline"
                  onClick={() =>
                    setDialog({
                      view: "detail",
                      sale: dialog.sale,
                      returnTo: "completed",
                    })
                  }
                >
                  {it.retail.viewSale}
                </Button>
                <Button onClick={closeDialog}>{it.retail.nextSale}</Button>
              </div>
            </section>
          )}
        </FormDialog>
      )}
    </>
  );
}
