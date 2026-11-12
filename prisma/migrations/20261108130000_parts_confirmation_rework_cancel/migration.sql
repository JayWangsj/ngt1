ALTER TYPE "Status" ADD VALUE 'PARTS_PENDING_CONFIRMATION';

ALTER TABLE "ReworkSession"
ADD COLUMN "cancelledAt" TIMESTAMPTZ(3);

DROP INDEX "ReworkItem_originalItemId_key";

CREATE INDEX "ReworkItem_originalItemId_idx"
ON "ReworkItem"("originalItemId");
