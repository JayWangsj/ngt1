import {
  Boxes,
  CircleAlert,
  PackageCheck,
  PackageX,
  Wallet,
} from "lucide-react";
import { db } from "@/lib/db";
import { cents, dateTime, inventoryStatus, money, romeDay } from "@/lib/domain";
import { getLocale, getMessages } from "@/lib/i18n-server";
import { requireActor } from "@/lib/session";
import { PageHeader } from "@/components/common";
import {
  InventoryHistoryCard,
  InventoryWorkspace,
  NewProductDialogButton,
  type ProductView,
} from "@/components/inventory";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireActor();
  const it = await getMessages();
  const locale = await getLocale();
  const requestedStatus = (await searchParams).status;
  const initialStatus =
    requestedStatus === "IN_STOCK" ||
    requestedStatus === "LOW_STOCK" ||
    requestedStatus === "OUT_OF_STOCK"
      ? requestedStatus
      : "";
  const [
    products,
    categories,
    movements,
    reservations,
    catalogDeletions,
    projectCatalog,
  ] = await Promise.all([
    db.product.findMany({
      where: { enabled: true },
      include: {
        compatibilities: true,
        requiredByRules: {
          where: { enabled: true },
          select: {
            brand: true,
            category: true,
            model: true,
            project: true,
          },
          orderBy: [
            { brand: "asc" },
            { category: "asc" },
            { model: "asc" },
            { project: "asc" },
          ],
        },
      },
      orderBy: [{ favorite: "desc" }, { name: "asc" }],
    }),
    db.inventoryCategory.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    db.inventoryMovement.findMany({
      include: { product: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
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
    db.deviceCatalogDeletion.findMany({
      select: { category: true, kind: true, brand: true, value: true },
    }),
    db.priceRule.findMany({
      where: { enabled: true },
      select: { brand: true, category: true, model: true, project: true },
    }),
  ]);
  const reservedByProduct = new Map(
    reservations.map((entry) => [entry.productId, entry._sum.quantity ?? 0]),
  );
  const productViews: ProductView[] = products.map((product) => ({
    id: product.id,
    name: product.name,
    category: product.category,
    usage: product.usage,
    costPrice: cents(product.costPrice),
    salePrice: cents(product.salePrice),
    stockQuantity: product.stockQuantity,
    reservedQuantity: reservedByProduct.get(product.id) ?? 0,
    minStock: product.minStock,
    favorite: product.favorite,
    enabled: product.enabled,
    compatibilities: [
      ...new Map(
        [...product.compatibilities, ...product.requiredByRules].map((rule) => [
          [rule.brand, rule.category, rule.model, rule.project]
            .map((value) => value.trim().toLocaleLowerCase())
            .join("\u0000"),
          rule,
        ]),
      ).values(),
    ],
  }));
  const enabled = productViews.filter((product) => product.enabled);
  const metrics = [
    { label: it.inventory.productCount, value: enabled.length, icon: Boxes },
    {
      label: it.inventory.stockTotal,
      value: enabled.reduce((sum, product) => sum + product.stockQuantity, 0),
      icon: PackageCheck,
    },
    {
      label: it.inventory.stockCost,
      value: money(
        enabled.reduce(
          (sum, product) => sum + product.costPrice * product.stockQuantity,
          0,
        ),
      ),
      icon: Wallet,
    },
    {
      label: it.inventory.lowStock,
      value: enabled.filter(
        (product) =>
          inventoryStatus(product.stockQuantity, product.minStock) ===
          "LOW_STOCK",
      ).length,
      icon: CircleAlert,
    },
    {
      label: it.inventory.outOfStock,
      value: enabled.filter(
        (product) =>
          inventoryStatus(product.stockQuantity, product.minStock) ===
          "OUT_OF_STOCK",
      ).length,
      icon: PackageX,
    },
  ];
  return (
    <>
      <PageHeader
        title={it.inventory.title}
        description={it.inventory.description}
        actionNode={
          <NewProductDialogButton
            categories={categories}
            projectCatalog={projectCatalog}
          />
        }
      />
      <div className="inventory-metrics">
        {metrics.map(({ label, value, icon: Icon }) => (
          <div className="metric" key={label}>
            <div className="metric-top">
              <span>{label}</span>
              <span className="metric-icon orange">
                <Icon size={20} />
              </span>
            </div>
            <strong>{value}</strong>
          </div>
        ))}
        <InventoryHistoryCard
          currentPeriod={romeDay().slice(0, 7)}
          movements={movements.map((movement) => ({
            id: movement.id,
            productName: movement.product.name,
            quantity: movement.quantity,
            stockBefore: movement.stockBefore,
            stockAfter: movement.stockAfter,
            type: movement.type,
            at: dateTime(movement.createdAt, locale),
            period: romeDay(movement.createdAt).slice(0, 7),
          }))}
        />
      </div>
      <InventoryWorkspace
        products={productViews}
        categories={categories}
        catalogDeletions={catalogDeletions}
        projectCatalog={projectCatalog}
        initialStatus={initialStatus}
      />
    </>
  );
}
