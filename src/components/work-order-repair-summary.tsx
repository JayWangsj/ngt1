"use client";

import { useState } from "react";
import { ChevronRight, Package, Plus, Wrench, X } from "lucide-react";
import { cents, money } from "@/lib/domain";
import {
  ItemsEditor,
  QuoteItemsDraftForm,
  removePartPricePatch,
  type CategoryView,
  type ItemView,
  type RuleView,
} from "./forms";
import { useMessages } from "./language";
import { matchRule } from "@/lib/domain";
import {
  useOrderDetailEdit,
  type OrderDetailEditTarget,
} from "./order-detail-ui";

type Product = {
  id: string;
  name: string;
  category: string;
  stock: number;
  reserved: number;
  available: number;
};
type SummaryItem = ItemView & { source?: string };

function removeDraftTarget(
  items: SummaryItem[],
  target: OrderDetailEditTarget | null | undefined,
  rules: RuleView[],
  device: { category: string; brand: string; series: string; model: string },
  protectPrice: boolean,
) {
  if (target?.action !== "remove") return items;
  if (target.field === "project")
    return items.filter((_, index) => index !== target.index);
  return items.map((item, index) =>
    index === target.index
      ? {
          ...item,
          ...removePartPricePatch(
            item,
            matchRule(rules, device, item.project)?.rule.suggested ?? "",
            protectPrice,
          ),
        }
      : item,
  );
}

export function WorkOrderRepairSummary({
  orderId,
  items,
  rules,
  device,
  products,
  productCategories,
  initialDiscount,
  initialVat,
  locked,
  protectPriceOnOptionSwitch,
}: {
  orderId: string;
  items: SummaryItem[];
  rules: RuleView[];
  device: { category: string; brand: string; series: string; model: string };
  products: Product[];
  productCategories: CategoryView[];
  initialDiscount: string;
  initialVat: boolean;
  inspectionFee: string;
  owner: boolean;
  locked: boolean;
  protectPriceOnOptionSwitch: boolean;
}) {
  const it = useMessages();
  const cardEdit = useOrderDetailEdit();
  const session = cardEdit?.session ?? 0;
  const [draft, setDraft] = useState<{ session: number; items: ItemView[] }>({
    session,
    items: removeDraftTarget(
      items,
      cardEdit?.target,
      rules,
      device,
      protectPriceOnOptionSwitch,
    ),
  });
  const [minimumNotice, setMinimumNotice] = useState(false);
  if (cardEdit?.editing && draft.session !== session)
    setDraft({
      session,
      items: removeDraftTarget(
        items,
        cardEdit.target,
        rules,
        device,
        protectPriceOnOptionSwitch,
      ),
    });
  const draftItems = draft.items;
  const setDraftItems = (next: ItemView[]) =>
    setDraft({ session, items: next });
  const editing =
    cardEdit?.target?.kind === "repair" && !cardEdit.target.action
      ? cardEdit.target
      : null;
  const change = (index: number, field: "project" | "part") => {
    if (!locked) {
      setMinimumNotice(false);
      cardEdit?.requestEdit({ kind: "repair", index, field });
    }
  };
  const editor = (index: number, field: "project" | "part") => (
    <div className={`detail-repair-editor is-${field}`}>
      <ItemsEditor
        items={draftItems}
        onChange={setDraftItems}
        rules={rules}
        device={device}
        products={products}
        productCategories={productCategories}
        initialEdit={{ index, field }}
        focusedEdit
        showEmptyPartSummary
        protectPriceOnOptionSwitch={protectPriceOnOptionSwitch}
        onFocusedEditComplete={cardEdit?.clearTarget}
      />
    </div>
  );
  const displayedItems: SummaryItem[] = cardEdit?.editing ? draftItems : items;
  const removable = !locked;

  function removeProject(index: number) {
    if ((cardEdit?.editing ? draftItems : items).length <= 1) {
      setMinimumNotice(true);
      return;
    }
    setMinimumNotice(false);
    if (!cardEdit?.editing) {
      cardEdit?.requestEdit({
        kind: "repair",
        index,
        field: "project",
        action: "remove",
      });
      return;
    }
    cardEdit?.clearTarget();
    setDraftItems(draftItems.filter((_, itemIndex) => itemIndex !== index));
  }

  function removePart(index: number) {
    const remove = (current: ItemView[]) =>
      current.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              ...removePartPricePatch(
                item,
                matchRule(rules, device, item.project)?.rule.suggested ?? "",
                protectPriceOnOptionSwitch,
              ),
            }
          : item,
      );
    if (!cardEdit?.editing) {
      cardEdit?.requestEdit({
        kind: "repair",
        index,
        field: "part",
        action: "remove",
      });
      return;
    }
    cardEdit?.clearTarget();
    setDraftItems(remove(draftItems));
  }

  function addProject() {
    setMinimumNotice(false);
    const index = draftItems.length;
    setDraftItems([
      ...draftItems,
      {
        project: "",
        final: "",
        adjustmentReason: "",
        discount: "0",
        saveRule: false,
      },
    ]);
    cardEdit?.requestEdit({ kind: "repair", index, field: "project" });
  }

  return (
    <section className="detail-repair-summaries" id="required-parts">
      <h3>{it.quoteSection}</h3>
      {minimumNotice && (
        <p className="message warning" role="status">
          {it.repairItemMinimum}
        </p>
      )}
      {displayedItems.map((item, index) => {
        const product = products.find(
          (candidate) => candidate.id === item.requiredProductId,
        );
        const historicalProductName =
          item.requiredProductName?.trim() ||
          item.requiredProduct?.name ||
          product?.name;
        return (
          <div
            className="detail-repair-summary"
            key={`${item.project}-${index}`}
          >
            {editing?.index === index && editing.field === "project" ? (
              editor(index, "project")
            ) : (
              <div
                className={`selection-summary selected-project-summary${locked ? "" : " is-actionable"}`}
                onClick={() => change(index, "project")}
              >
                <span className="selection-summary-icon is-project">
                  <Wrench size={18} aria-hidden="true" />
                </span>
                <div className="selection-summary-copy">
                  <strong>{item.project}</strong>
                  <small>{items[index]?.source}</small>
                </div>
                <div className="selection-summary-value">
                  <small>{it.currentQuote}</small>
                  <strong>{money(cents(item.final))}</strong>
                </div>
                {!locked && (
                  <div className="selected-part-actions">
                    <button
                      type="button"
                      className="summary-action"
                      onClick={() => change(index, "project")}
                    >
                      <span>{it.change}</span>
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                    {removable && (
                      <button
                        type="button"
                        className="quick-service-remove"
                        aria-label={`${it.remove} ${item.project}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          removeProject(index);
                        }}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <strong className="quote-required-part-label">
              {item.priceOptionName
                ? it.partPriceOption
                : `${it.requiredPart} (${it.optional})`}
            </strong>
            {editing?.index === index && editing.field === "part" ? (
              editor(index, "part")
            ) : (
              <div
                className={`selection-summary selected-part-summary${item.suggested ? " has-quote" : ""}${locked ? "" : " is-actionable"}`}
                onClick={() => change(index, "part")}
              >
                <span className="selection-summary-icon is-part">
                  <Package size={18} aria-hidden="true" />
                </span>
                <div className="selection-summary-copy">
                  <strong>
                    {historicalProductName ||
                      item.priceOptionName ||
                      it.afterSales.noPart}
                  </strong>
                  {product && (
                    <small>
                      {item.priceOptionName &&
                        item.priceOptionName !== historicalProductName &&
                        `${item.priceOptionName} · `}
                      {product.category} · {it.actualStock} {product.stock} ·{" "}
                      {it.reservedStock} {product.reserved} ·{" "}
                      {it.availableStock} {product.available} ·{" "}
                      <span
                        className={`part-stock ${product.available > 0 ? "is-available" : "is-empty"}`}
                      >
                        ●{" "}
                        {product.available > 0
                          ? it.partInStock
                          : it.partOutOfStock}
                      </span>
                    </small>
                  )}
                  {!product &&
                    item.priceOptionName &&
                    item.priceOptionName !== historicalProductName && (
                      <small>{item.priceOptionName}</small>
                    )}
                </div>
                {item.suggested && (
                  <div className="selection-summary-value">
                    <small>{it.priceListPrice}</small>
                    <strong>{money(cents(item.suggested))}</strong>
                  </div>
                )}
                {!locked && (
                  <div className="selected-part-actions">
                    <button
                      type="button"
                      className="summary-action"
                      onClick={() => change(index, "part")}
                    >
                      <span>
                        {item.priceOptionName
                          ? `${it.change} ${it.partPriceOption}`
                          : it.change}
                      </span>
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                    {removable && historicalProductName && (
                      <button
                        type="button"
                        className="quick-service-remove"
                        aria-label={`${it.remove} ${historicalProductName}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          removePart(index);
                        }}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {cardEdit?.editing && !locked && (
        <button
          type="button"
          className="quick-service-service-add detail-repair-add"
          onClick={addProject}
        >
          <Plus size={18} /> {it.project}
        </button>
      )}
      {cardEdit?.editing && !locked && (
        <QuoteItemsDraftForm
          id={orderId}
          items={draftItems}
          orderDiscount={initialDiscount}
          includeVat={initialVat}
        />
      )}
    </section>
  );
}
