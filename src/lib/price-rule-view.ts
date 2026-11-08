import type { Prisma } from "@prisma/client";
import type { RuleView } from "@/components/forms";

type RuleWithOptions = Prisma.PriceRuleGetPayload<{
  include: {
    options: {
      include: {
        product: true;
      };
    };
  };
}>;
type ProductWithCompatibilities =
  RuleWithOptions["options"][number]["product"] & {
    compatibilities?: {
      category: string;
      brand: string;
      model: string;
      project: string;
    }[];
  };

export function priceRuleViews(
  rules: RuleWithOptions[],
  reservedByProduct: Map<string, number> = new Map(),
): RuleView[] {
  return rules.map((rule) => ({
    id: rule.id,
    category: rule.category,
    brand: rule.brand,
    series: rule.series,
    model: rule.model,
    project: rule.project,
    suggested: rule.suggested.toString(),
    cost: rule.cost?.toString(),
    minutes: rule.minutes,
    notes: rule.notes,
    enabled: rule.enabled,
    requiredProductId: rule.requiredProductId,
    requiredQuantity: rule.requiredQuantity,
    options: rule.options.map((option) => {
      const reserved = reservedByProduct.get(option.productId) ?? 0;
      const product = option.product as ProductWithCompatibilities;
      return {
        id: option.id,
        productId: option.productId,
        name: option.name,
        suggested: option.suggested.toString(),
        cost: option.cost?.toString(),
        quantity: option.quantity,
        minutes: option.minutes,
        warrantyDays: option.warrantyDays,
        enabled: option.enabled,
        isDefault: option.isDefault,
        notes: option.notes,
        product: {
          id: product.id,
          name: product.name,
          category: product.category,
          enabled: product.enabled,
          usage: product.usage,
          stock: product.stockQuantity,
          reserved,
          available: Math.max(0, product.stockQuantity - reserved),
          compatibilities: product.compatibilities ?? [],
        },
      };
    }),
  }));
}
