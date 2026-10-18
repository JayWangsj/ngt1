import { db } from "@/lib/db";
import { requireActor } from "@/lib/session";
import { PriceList } from "@/components/forms";
import { getMessages } from "@/lib/i18n-server";
import { priceRuleViews } from "@/lib/price-rule-view";
export default async function Prices() {
  const it = await getMessages();
  const actor = await requireActor();
  if (actor.role !== "OWNER")
    return <p className="message error">{it.restricted}</p>;
  const [rules, repairProducts, reservations] = await Promise.all([
    db.priceRule.findMany({
      include: {
        options: {
          include: { product: true },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [
        { category: "asc" },
        { brand: "asc" },
        { model: "asc" },
        { project: "asc" },
      ],
    }),
    db.product.findMany({
      where: { enabled: true, usage: "REPAIR" },
      select: {
        id: true,
        name: true,
        category: true,
        stockQuantity: true,
        costPrice: true,
      },
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
  ]);
  const reservedByProduct = new Map(
    reservations.map((entry) => [entry.productId, entry._sum.quantity ?? 0]),
  );
  return (
    <PriceList
      rules={priceRuleViews(rules, reservedByProduct)}
      repairProducts={repairProducts.map((product) => ({
        ...product,
        costPrice: product.costPrice.toString(),
      }))}
    />
  );
}
