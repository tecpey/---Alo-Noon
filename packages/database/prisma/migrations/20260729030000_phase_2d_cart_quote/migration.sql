-- Phase 2D: customer-bound server carts and immutable, expiring quote snapshots.

CREATE TYPE "CartState" AS ENUM ('ACTIVE', 'CONVERTED', 'ABANDONED');
CREATE TYPE "QuoteStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'ACCEPTED');

CREATE TABLE "Cart" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "cityId" UUID NOT NULL,
    "operationalZoneId" UUID NOT NULL,
    "bakeryBranchId" UUID NOT NULL,
    "state" "CartState" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CartItem" (
    "id" UUID NOT NULL,
    "cartId" UUID NOT NULL,
    "bakeryProductOfferingId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "cartId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "cartVersion" INTEGER NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "subtotalAmount" BIGINT NOT NULL,
    "deliveryFeeAmount" BIGINT NOT NULL DEFAULT 0,
    "discountAmount" BIGINT NOT NULL DEFAULT 0,
    "totalAmount" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'IRR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuoteItem" (
    "id" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "bakeryProductOfferingId" UUID NOT NULL,
    "productVariantId" UUID NOT NULL,
    "bakeryBranchId" UUID NOT NULL,
    "skuSnapshot" VARCHAR(64) NOT NULL,
    "nameFaSnapshot" TEXT NOT NULL,
    "fulfillmentClassSnapshot" "ProductFulfillmentClass" NOT NULL,
    "freshnessClaimSnapshot" "FreshnessClaim" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceAmount" BIGINT NOT NULL,
    "lineTotalAmount" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'IRR',
    CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Cart_one_active_per_customer_key"
ON "Cart"("customerId")
WHERE "state" = 'ACTIVE';
CREATE INDEX "Cart_customerId_state_updatedAt_idx" ON "Cart"("customerId", "state", "updatedAt");
CREATE INDEX "Cart_cityId_operationalZoneId_bakeryBranchId_state_idx"
ON "Cart"("cityId", "operationalZoneId", "bakeryBranchId", "state");
CREATE UNIQUE INDEX "CartItem_cartId_bakeryProductOfferingId_key"
ON "CartItem"("cartId", "bakeryProductOfferingId");
CREATE INDEX "CartItem_bakeryProductOfferingId_idx" ON "CartItem"("bakeryProductOfferingId");
CREATE UNIQUE INDEX "Quote_publicId_key" ON "Quote"("publicId");
CREATE UNIQUE INDEX "Quote_idempotencyKey_key" ON "Quote"("idempotencyKey");
CREATE INDEX "Quote_customerId_status_expiresAt_idx" ON "Quote"("customerId", "status", "expiresAt");
CREATE INDEX "Quote_cartId_cartVersion_status_idx" ON "Quote"("cartId", "cartVersion", "status");
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");
CREATE INDEX "QuoteItem_bakeryProductOfferingId_idx" ON "QuoteItem"("bakeryProductOfferingId");
CREATE INDEX "QuoteItem_productVariantId_idx" ON "QuoteItem"("productVariantId");

ALTER TABLE "Cart"
ADD CONSTRAINT "Cart_version_check" CHECK ("version" >= 1);
ALTER TABLE "CartItem"
ADD CONSTRAINT "CartItem_quantity_check" CHECK ("quantity" BETWEEN 1 AND 100);
ALTER TABLE "Quote"
ADD CONSTRAINT "Quote_amounts_check" CHECK (
  "subtotalAmount" >= 0 AND
  "deliveryFeeAmount" >= 0 AND
  "discountAmount" >= 0 AND
  "totalAmount" >= 0 AND
  "totalAmount" = "subtotalAmount" + "deliveryFeeAmount" - "discountAmount"
);
ALTER TABLE "Quote"
ADD CONSTRAINT "Quote_cart_version_check" CHECK ("cartVersion" >= 1);
ALTER TABLE "QuoteItem"
ADD CONSTRAINT "QuoteItem_amounts_check" CHECK (
  "quantity" BETWEEN 1 AND 100 AND
  "unitPriceAmount" >= 0 AND
  "lineTotalAmount" = "unitPriceAmount" * "quantity"
);

ALTER TABLE "Cart"
ADD CONSTRAINT "Cart_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Cart"
ADD CONSTRAINT "Cart_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Cart"
ADD CONSTRAINT "Cart_operationalZoneId_fkey" FOREIGN KEY ("operationalZoneId") REFERENCES "OperationalZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Cart"
ADD CONSTRAINT "Cart_bakeryBranchId_fkey" FOREIGN KEY ("bakeryBranchId") REFERENCES "BakeryBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CartItem"
ADD CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem"
ADD CONSTRAINT "CartItem_bakeryProductOfferingId_fkey" FOREIGN KEY ("bakeryProductOfferingId") REFERENCES "BakeryProductOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Quote"
ADD CONSTRAINT "Quote_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Quote"
ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuoteItem"
ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuoteItem"
ADD CONSTRAINT "QuoteItem_bakeryProductOfferingId_fkey" FOREIGN KEY ("bakeryProductOfferingId") REFERENCES "BakeryProductOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuoteItem"
ADD CONSTRAINT "QuoteItem_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
