-- Additive ready-stock inventory foundation for packaged bakery offerings.
--
-- SIGNATURE_FRESH production continues to use dailyCapacity/BakeryCapacitySlot
-- (a production-capacity reservation, not a stock count). This adds a separate
-- stock-on-hand counter that only applies when a variant's productionMode is
-- READY_STOCK, decremented atomically at order acceptance to prevent oversell.
-- Existing rows default to stockTracked = false / stockOnHand = NULL, which the
-- shape check below already permits, so no backfill is required.

ALTER TABLE "BakeryProductOffering"
  ADD COLUMN "stockTracked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stockOnHand" INTEGER,
  ADD CONSTRAINT "BakeryProductOffering_stock_shape_check" CHECK (
    (NOT "stockTracked" AND "stockOnHand" IS NULL) OR
    ("stockTracked" AND "stockOnHand" >= 0)
  );
