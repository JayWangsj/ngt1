import { db } from "@/lib/db";
import { requireActor } from "@/lib/session";
import { NewOrderWizard } from "@/components/new-order-form";
import { NewServiceOrder } from "@/components/new-service-order";
import { BackButton, PageHeader } from "@/components/common";
import { getMessages } from "@/lib/i18n-server";
import { priceRuleViews } from "@/lib/price-rule-view";
export default async function NewOrder({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const it = await getMessages();
  await requireActor();
  const query = await searchParams;
  const rules = await db.priceRule.findMany({
    where: { enabled: true },
    include: {
      options: {
        where: { enabled: true },
        include: { product: true },
        orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }],
      },
    },
    orderBy: { project: "asc" },
  });
  const [
    faultOptions,
    customers,
    products,
    productCategories,
    reservations,
    quickServices,
  ] = await Promise.all([
    db.faultOption.findMany({
      select: {
        id: true,
        category: true,
        name: true,
        note: true,
        hidden: true,
        sortOrder: true,
        _count: { select: { orders: true } },
      },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    }),
    db.customer.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        phone: true,
        phones: { select: { phone: true } },
        devices: {
          where: { deletedAt: null },
          select: { id: true, category: true, brand: true, model: true },
        },
      },
      orderBy: { name: "asc" },
    }),
    db.product.findMany({
      where: { enabled: true, usage: "REPAIR" },
      select: { id: true, name: true, category: true, stockQuantity: true },
      orderBy: [{ favorite: "desc" }, { name: "asc" }],
    }),
    db.inventoryCategory.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, repairOnly: true },
      orderBy: { name: "asc" },
    }),
    db.workOrderProduct.groupBy({
      by: ["productId"],
      where: {
        kind: "REPAIR_PART",
        consumedAt: null,
        order: { status: { notIn: ["COMPLETED", "REFUNDED", "CANCELLED"] } },
      },
      _sum: { quantity: true },
    }),
    db.quickService.findMany({
      where: { enabled: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const reservedByProduct = new Map(
    reservations.map((entry) => [entry.productId, entry._sum.quantity ?? 0]),
  );
  return (
    <>
      <BackButton href="/orders" label={it.nav.orders} />
      <PageHeader title={it.newOrder} description={it.ordersDescription} />
      <NewServiceOrder
        initialMode={query.type === "quick" ? "QUICK_SERVICE" : "REPAIR"}
        customers={customers}
        services={quickServices.map((service) => ({
          id: service.id,
          name: service.name,
          notes: service.notes,
          defaultPrice: Number(service.defaultPrice) * 100,
        }))}
        repairForm={
          <NewOrderWizard
            faultOptions={faultOptions.map(({ _count, ...fault }) => ({
              ...fault,
              usageCount: _count.orders,
            }))}
            customers={customers}
            products={products.map((product) => ({
              id: product.id,
              name: product.name,
              category: product.category,
              stock: product.stockQuantity,
              reserved: reservedByProduct.get(product.id) ?? 0,
              available: Math.max(
                0,
                product.stockQuantity -
                  (reservedByProduct.get(product.id) ?? 0),
              ),
            }))}
            productCategories={productCategories}
            rules={priceRuleViews(rules, reservedByProduct)}
          />
        }
      />
    </>
  );
}
