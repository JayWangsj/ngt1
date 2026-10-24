"use client";

import { useState, useTransition } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { deleteRetailSaleAction } from "@/app/actions";
import { DatePicker } from "./business-select";
import { useMessages } from "./language";
import { money } from "@/lib/domain";
import { RecordIcon } from "./ui/record-icon";
import { DialogBody, DialogFooter, FormDialog } from "./forms";
import { Button } from "./ui/button";

export type SaleHistoryRow = {
  id: string;
  code: string;
  date: string;
  period: string;
  itemCount: number;
  method: "CASH" | "CARD" | "TRANSFER" | "OTHER" | null;
  subtotal: number;
  discount: number;
  total: number;
  items: {
    id: string;
    name: string;
    category: string;
    unitPrice: number;
    quantity: number;
    subtotal: number;
  }[];
  services: {
    id: string;
    name: string;
    unitPrice: number;
    quantity: number;
    subtotal: number;
  }[];
};

export function RetailSalesHistory({
  sales,
  period,
  onPeriodChange,
  onSelect,
  onDeleted,
}: {
  sales: SaleHistoryRow[];
  period: string;
  onPeriodChange: (period: string) => void;
  onSelect: (sale: SaleHistoryRow) => void;
  onDeleted: (id: string) => void;
}) {
  const it = useMessages();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [saleToDelete, setSaleToDelete] = useState<SaleHistoryRow | null>(null);
  const filtered = sales.filter((sale) => sale.period === period);
  function remove() {
    if (!saleToDelete) return;
    setError("");
    startTransition(async () => {
      const result = await deleteRetailSaleAction(saleToDelete.id);
      if (!result.ok) return setError(result.error);
      onDeleted(saleToDelete.id);
      setSaleToDelete(null);
    });
  }
  return (
    <DialogBody className="retail-history-dialog">
      <DatePicker
        className="retail-period-picker"
        aria-label={it.month}
        name="period"
        type="month"
        value={period}
        onChange={(event) => onPeriodChange(event.target.value)}
      />
      <section className="panel table-panel">
        {filtered.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{it.retail.saleNumber}</th>
                  <th>{it.retail.date}</th>
                  <th className="numeric">{it.retail.quantity}</th>
                  <th>{it.retail.paymentMethod}</th>
                  <th className="numeric sale-amount-heading">
                    {it.retail.amount}
                  </th>
                  <th
                    className="sale-actions-heading"
                    aria-label={it.retail.deleteSale}
                  />
                </tr>
              </thead>
              <tbody>
                {filtered.map((sale) => (
                  <tr className="business-list-row" key={sale.id}>
                    <td>
                      <button
                        className="order-link order-code-link sale-number-button"
                        onClick={() => onSelect(sale)}
                      >
                        <span>{sale.code}</span>
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    </td>
                    <td>{sale.date}</td>
                    <td className="numeric">{sale.itemCount}</td>
                    <td>{sale.method ? it.methods[sale.method] : "—"}</td>
                    <td className="numeric sale-amount-cell">
                      {money(sale.total)}
                    </td>
                    <td className="sale-actions-cell">
                      <RecordIcon
                        kind="delete"
                        label={`${it.retail.deleteSale} ${sale.code}`}
                        disabled={pending}
                        onClick={() => {
                          setError("");
                          setSaleToDelete(sale);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="inventory-empty">{it.retail.noSales}</p>
        )}
      </section>
      {error && !saleToDelete && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {saleToDelete && (
        <FormDialog
          title={it.retail.deleteSale}
          size="compact"
          onClose={() => {
            if (!pending) {
              setError("");
              setSaleToDelete(null);
            }
          }}
        >
          <DialogBody className="confirm-delete-dialog" aria-busy={pending}>
            <div className="confirm-delete-icon" aria-hidden="true">
              <Trash2 size={22} />
            </div>
            <p>{it.retail.deleteSaleConfirm}</p>
            {error && (
              <p className="message error" role="alert">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="cancel"
              disabled={pending}
              onClick={() => {
                setError("");
                setSaleToDelete(null);
              }}
            >
              {it.cancel}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={remove}
            >
              {it.retail.deleteSale}
            </Button>
          </DialogFooter>
        </FormDialog>
      )}
    </DialogBody>
  );
}

export function RetailSaleDetail({ sale }: { sale: SaleHistoryRow }) {
  const it = useMessages();
  return (
    <DialogBody className="retail-sale-dialog">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{it.inventory.product}</th>
              <th className="numeric">{it.retail.unitPrice}</th>
              <th className="numeric">{it.retail.quantity}</th>
              <th className="numeric">{it.retail.subtotal}</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.name}</strong>
                  <small>{item.category}</small>
                </td>
                <td className="numeric">{money(item.unitPrice)}</td>
                <td className="numeric">{item.quantity}</td>
                <td className="numeric">{money(item.subtotal)}</td>
              </tr>
            ))}
            {sale.services.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.name}</strong>
                  <small>{it.quickService.title}</small>
                </td>
                <td className="numeric">{money(item.unitPrice)}</td>
                <td className="numeric">{item.quantity}</td>
                <td className="numeric">{money(item.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="quote-summary">
        <div>
          <dt>{it.retail.subtotal}</dt>
          <dd>{money(sale.subtotal)}</dd>
        </div>
        <div>
          <dt>{it.retail.discount}</dt>
          <dd>− {money(sale.discount)}</dd>
        </div>
        <div>
          <dt>{it.retail.total}</dt>
          <dd>{money(sale.total)}</dd>
        </div>
        <div>
          <dt>{it.retail.paymentMethod}</dt>
          <dd>{sale.method ? it.methods[sale.method] : "—"}</dd>
        </div>
        <div>
          <dt>{it.retail.date}</dt>
          <dd>{sale.date}</dd>
        </div>
      </dl>
    </DialogBody>
  );
}
