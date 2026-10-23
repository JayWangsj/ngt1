import { db } from "@/lib/db";
import { cents, dateTime, romeDay } from "@/lib/domain";
import { getLocale, getMessages } from "@/lib/i18n-server";
import { requireActor } from "@/lib/session";
import { RetailWorkbench } from "@/components/retail-workbench";

export default async function RetailPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; id?: string; period?: string }>;
}) {
  await requireActor();
  const it = await getMessages();
  const locale = await getLocale();
  const query = await searchParams;
  const [products, categories, sales, quickServices] = await Promise.all([
    db.product.findMany({
      where: { enabled: true, usage: "RETAIL" },
      orderBy: [{ favorite: "desc" }, { name: "asc" }],
    }),
    db.inventoryCategory.findMany({
      where: { deletedAt: null, repairOnly: false },
      orderBy: { name: "asc" },
    }),
    db.retailSale.findMany({
      include: {
        items: true,
        serviceItems: true,
        payments: { orderBy: { receivedAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.quickService.findMany({
      where: { enabled: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const today = romeDay();
  return (
    <RetailWorkbench
      title={it.retail.title}
      description={it.retail.description}
      initialPeriod={
        /^\d{4}-\d{2}$/.test(query.period ?? "")
          ? query.period!
          : today.slice(0, 7)
      }
      initialView={
        query.view === "sales"
          ? "history"
          : query.view === "sale"
            ? "detail"
            : undefined
      }
      initialSaleId={query.id}
      categories={categories}
      products={products.map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        salePrice: cents(product.salePrice),
        stockQuantity: product.stockQuantity,
        unlimitedStock: product.unlimitedStock,
        favorite: product.favorite,
      }))}
      quickServices={quickServices.map((service) => ({
        id: service.id,
        name: service.name,
        notes: service.notes,
        defaultPrice: cents(service.defaultPrice),
      }))}
      sales={sales.map((sale) => ({
        id: sale.id,
        code: sale.code,
        date: dateTime(sale.createdAt, locale),
        period: romeDay(sale.createdAt).slice(0, 7),
        itemCount: sale.itemCount,
        method: sale.payments[0]?.method ?? null,
        subtotal: cents(sale.subtotal),
        discount: cents(sale.discount),
        total: cents(sale.total),
        items: sale.items.map((item) => ({
          id: item.id,
          name: item.productName,
          category: item.category,
          unitPrice: cents(item.unitPrice),
          quantity: item.quantity,
          subtotal: cents(item.subtotal),
        })),
        services: sale.serviceItems.map((item) => ({
          id: item.id,
          name: item.serviceName,
          unitPrice: cents(item.unitPrice),
          quantity: item.quantity,
          subtotal: cents(item.subtotal),
        })),
      }))}
    />
  );
}
