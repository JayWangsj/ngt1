-- Keep PriceRule as the device/project price-list entry and move each
-- product-specific quote into a child option. Legacy columns remain readable
-- during the compatibility window.
CREATE TABLE "PriceRuleOption" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "suggested" DECIMAL(12,2) NOT NULL,
    "cost" DECIMAL(12,2),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "minutes" INTEGER NOT NULL DEFAULT 60,
    "warrantyDays" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceRuleOption_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WorkOrderItem"
  ADD COLUMN "priceOptionId" TEXT,
  ADD COLUMN "priceOptionName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "requiredProductName" TEXT NOT NULL DEFAULT '';

INSERT INTO "PriceRuleOption" (
  "id",
  "ruleId",
  "productId",
  "name",
  "suggested",
  "cost",
  "quantity",
  "minutes",
  "warrantyDays",
  "enabled",
  "isDefault",
  "sortOrder",
  "notes",
  "updatedAt"
)
SELECT
  'legacy_' || substr(md5(rule."id" || ':' || rule."requiredProductId"), 1, 24),
  rule."id",
  rule."requiredProductId",
  product."name",
  rule."suggested",
  COALESCE(rule."cost", product."costPrice"),
  rule."requiredQuantity",
  rule."minutes",
  0,
  rule."enabled" AND product."enabled",
  true,
  0,
  rule."notes",
  rule."updatedAt"
FROM "PriceRule" AS rule
JOIN "Product" AS product ON product."id" = rule."requiredProductId"
WHERE rule."requiredProductId" IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE "WorkOrderItem" AS item
SET
  "priceOptionId" = option."id",
  "priceOptionName" = option."name"
FROM "PriceRuleOption" AS option
WHERE item."ruleId" = option."ruleId"
  AND item."requiredProductId" = option."productId";

UPDATE "WorkOrderItem" AS item
SET "requiredProductName" = product."name"
FROM "Product" AS product
WHERE item."requiredProductId" = product."id";

CREATE UNIQUE INDEX "PriceRuleOption_ruleId_productId_key"
  ON "PriceRuleOption"("ruleId", "productId");
CREATE UNIQUE INDEX "PriceRuleOption_one_default_per_rule"
  ON "PriceRuleOption"("ruleId") WHERE "isDefault" = true;
CREATE INDEX "PriceRuleOption_ruleId_enabled_sortOrder_idx"
  ON "PriceRuleOption"("ruleId", "enabled", "sortOrder");
CREATE INDEX "PriceRuleOption_productId_idx"
  ON "PriceRuleOption"("productId");
CREATE INDEX "WorkOrderItem_priceOptionId_idx"
  ON "WorkOrderItem"("priceOptionId");

ALTER TABLE "PriceRuleOption"
  ADD CONSTRAINT "PriceRuleOption_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "PriceRule"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PriceRuleOption"
  ADD CONSTRAINT "PriceRuleOption_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderItem"
  ADD CONSTRAINT "WorkOrderItem_priceOptionId_fkey"
  FOREIGN KEY ("priceOptionId") REFERENCES "PriceRuleOption"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
