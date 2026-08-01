-- Phase G3B: relational tenant integrity for all implemented tenant-owned relations.
-- Existing single-column foreign keys remain authoritative for lifecycle behavior.
-- Composite foreign keys add a database boundary that rejects parent/child links
-- across tenants. NO ACTION deliberately preserves child tenantId when an existing
-- SET NULL foreign key clears only its domain reference.
--
-- Rollback policy: roll forward with a reviewed corrective migration. Do not drop
-- these constraints in production without equivalent tenant-isolation controls.

DO $$
DECLARE
  relation_record RECORD;
  invalid_rows BIGINT;
BEGIN
  CREATE TEMP TABLE g3b_tenant_relations (
    child_table TEXT NOT NULL,
    child_fk TEXT NOT NULL,
    parent_table TEXT NOT NULL,
    PRIMARY KEY (child_table, child_fk)
  ) ON COMMIT DROP;

  INSERT INTO g3b_tenant_relations (child_table, child_fk, parent_table)
  VALUES
    ('OperationalZone', 'cityId', 'City'),
    ('ServiceArea', 'operationalZoneId', 'OperationalZone'),
    ('HouseholdMember', 'householdId', 'Household'),
    ('HouseholdMember', 'customerId', 'Customer'),
    ('Address', 'customerId', 'Customer'),
    ('Address', 'cityId', 'City'),
    ('Address', 'operationalZoneId', 'OperationalZone'),
    ('BakeryBranch', 'bakeryId', 'Bakery'),
    ('BakeryBranch', 'cityId', 'City'),
    ('BakeryBranch', 'operationalZoneId', 'OperationalZone'),
    ('BakeryOperatingHours', 'bakeryBranchId', 'BakeryBranch'),
    ('BakeryCapacitySlot', 'bakeryBranchId', 'BakeryBranch'),
    ('Product', 'categoryId', 'ProductCategory'),
    ('ProductVariant', 'productId', 'Product'),
    ('BakeryProductOffering', 'bakeryBranchId', 'BakeryBranch'),
    ('BakeryProductOffering', 'productVariantId', 'ProductVariant'),
    ('Cart', 'customerId', 'Customer'),
    ('Cart', 'cityId', 'City'),
    ('Cart', 'operationalZoneId', 'OperationalZone'),
    ('Cart', 'bakeryBranchId', 'BakeryBranch'),
    ('CartItem', 'cartId', 'Cart'),
    ('CartItem', 'bakeryProductOfferingId', 'BakeryProductOffering'),
    ('Quote', 'cartId', 'Cart'),
    ('Quote', 'customerId', 'Customer'),
    ('QuoteItem', 'quoteId', 'Quote'),
    ('QuoteItem', 'bakeryProductOfferingId', 'BakeryProductOffering'),
    ('QuoteItem', 'productVariantId', 'ProductVariant'),
    ('Order', 'customerId', 'Customer'),
    ('Order', 'cityId', 'City'),
    ('Order', 'operationalZoneId', 'OperationalZone'),
    ('Order', 'bakeryBranchId', 'BakeryBranch'),
    ('Order', 'savedAddressId', 'Address'),
    ('OrderItem', 'orderId', 'Order'),
    ('OrderItem', 'productVariantId', 'ProductVariant'),
    ('OrderItem', 'bakeryProductOfferingId', 'BakeryProductOffering'),
    ('OrderStateTransition', 'orderId', 'Order'),
    ('Fulfillment', 'orderId', 'Order'),
    ('Fulfillment', 'bakeryBranchId', 'BakeryBranch'),
    ('Courier', 'courierPartnerId', 'CourierPartner'),
    ('Vehicle', 'courierPartnerId', 'CourierPartner'),
    ('DeliveryTask', 'fulfillmentId', 'Fulfillment'),
    ('DeliveryAssignment', 'deliveryTaskId', 'DeliveryTask'),
    ('DeliveryAssignment', 'courierId', 'Courier'),
    ('DeliveryAssignment', 'vehicleId', 'Vehicle'),
    ('CustomerEvent', 'customerId', 'Customer'),
    ('SupportCase', 'customerId', 'Customer'),
    ('SupportCase', 'orderId', 'Order');

  FOR relation_record IN
    SELECT child_table, child_fk, parent_table
    FROM g3b_tenant_relations
    ORDER BY child_table, child_fk
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I child_row JOIN %I parent_row ON parent_row."id" = child_row.%I WHERE child_row.%I IS NOT NULL AND (child_row."tenantId" IS NULL OR parent_row."tenantId" IS NULL OR child_row."tenantId" <> parent_row."tenantId")',
      relation_record.child_table,
      relation_record.parent_table,
      relation_record.child_fk,
      relation_record.child_fk
    )
    INTO invalid_rows;

    IF invalid_rows <> 0 THEN
      RAISE EXCEPTION
        'G3B aborted: %.% -> % contains % tenant-null or cross-tenant rows',
        relation_record.child_table,
        relation_record.child_fk,
        relation_record.parent_table,
        invalid_rows;
    END IF;
  END LOOP;
END
$$;

-- Parent keys referenced by the composite tenant foreign keys.
ALTER TABLE "Address"
  ADD CONSTRAINT "g3b_Address_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Bakery"
  ADD CONSTRAINT "g3b_Bakery_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "BakeryBranch"
  ADD CONSTRAINT "g3b_BakeryBranch_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "BakeryProductOffering"
  ADD CONSTRAINT "g3b_BakeryProductOffering_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Cart"
  ADD CONSTRAINT "g3b_Cart_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "City"
  ADD CONSTRAINT "g3b_City_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Courier"
  ADD CONSTRAINT "g3b_Courier_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "CourierPartner"
  ADD CONSTRAINT "g3b_CourierPartner_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Customer"
  ADD CONSTRAINT "g3b_Customer_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "DeliveryTask"
  ADD CONSTRAINT "g3b_DeliveryTask_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Fulfillment"
  ADD CONSTRAINT "g3b_Fulfillment_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Household"
  ADD CONSTRAINT "g3b_Household_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "OperationalZone"
  ADD CONSTRAINT "g3b_OperationalZone_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Order"
  ADD CONSTRAINT "g3b_Order_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Product"
  ADD CONSTRAINT "g3b_Product_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "ProductCategory"
  ADD CONSTRAINT "g3b_ProductCategory_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "ProductVariant"
  ADD CONSTRAINT "g3b_ProductVariant_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Quote"
  ADD CONSTRAINT "g3b_Quote_id_tenant_key" UNIQUE ("id", "tenantId");

ALTER TABLE "Vehicle"
  ADD CONSTRAINT "g3b_Vehicle_id_tenant_key" UNIQUE ("id", "tenantId");

-- Supporting indexes keep parent updates/deletes and integrity checks bounded.
CREATE INDEX "g3b_OperationalZone_cityId_tenant_idx"
  ON "OperationalZone" ("cityId", "tenantId");

CREATE INDEX "g3b_ServiceArea_operationalZoneId_tenant_idx"
  ON "ServiceArea" ("operationalZoneId", "tenantId");

CREATE INDEX "g3b_HouseholdMember_householdId_tenant_idx"
  ON "HouseholdMember" ("householdId", "tenantId");

CREATE INDEX "g3b_HouseholdMember_customerId_tenant_idx"
  ON "HouseholdMember" ("customerId", "tenantId");

CREATE INDEX "g3b_Address_customerId_tenant_idx"
  ON "Address" ("customerId", "tenantId");

CREATE INDEX "g3b_Address_cityId_tenant_idx"
  ON "Address" ("cityId", "tenantId");

CREATE INDEX "g3b_Address_operationalZoneId_tenant_idx"
  ON "Address" ("operationalZoneId", "tenantId");

CREATE INDEX "g3b_BakeryBranch_bakeryId_tenant_idx"
  ON "BakeryBranch" ("bakeryId", "tenantId");

CREATE INDEX "g3b_BakeryBranch_cityId_tenant_idx"
  ON "BakeryBranch" ("cityId", "tenantId");

CREATE INDEX "g3b_BakeryBranch_operationalZoneId_tenant_idx"
  ON "BakeryBranch" ("operationalZoneId", "tenantId");

CREATE INDEX "g3b_BakeryOperatingHours_bakeryBranchId_tenant_idx"
  ON "BakeryOperatingHours" ("bakeryBranchId", "tenantId");

CREATE INDEX "g3b_BakeryCapacitySlot_bakeryBranchId_tenant_idx"
  ON "BakeryCapacitySlot" ("bakeryBranchId", "tenantId");

CREATE INDEX "g3b_Product_categoryId_tenant_idx"
  ON "Product" ("categoryId", "tenantId");

CREATE INDEX "g3b_ProductVariant_productId_tenant_idx"
  ON "ProductVariant" ("productId", "tenantId");

CREATE INDEX "g3b_BakeryProductOffering_bakeryBranchId_tenant_idx"
  ON "BakeryProductOffering" ("bakeryBranchId", "tenantId");

CREATE INDEX "g3b_BakeryProductOffering_productVariantId_tenant_idx"
  ON "BakeryProductOffering" ("productVariantId", "tenantId");

CREATE INDEX "g3b_Cart_customerId_tenant_idx"
  ON "Cart" ("customerId", "tenantId");

CREATE INDEX "g3b_Cart_cityId_tenant_idx"
  ON "Cart" ("cityId", "tenantId");

CREATE INDEX "g3b_Cart_operationalZoneId_tenant_idx"
  ON "Cart" ("operationalZoneId", "tenantId");

CREATE INDEX "g3b_Cart_bakeryBranchId_tenant_idx"
  ON "Cart" ("bakeryBranchId", "tenantId");

CREATE INDEX "g3b_CartItem_cartId_tenant_idx"
  ON "CartItem" ("cartId", "tenantId");

CREATE INDEX "g3b_CartItem_bakeryProductOfferingId_tenant_idx"
  ON "CartItem" ("bakeryProductOfferingId", "tenantId");

CREATE INDEX "g3b_Quote_cartId_tenant_idx"
  ON "Quote" ("cartId", "tenantId");

CREATE INDEX "g3b_Quote_customerId_tenant_idx"
  ON "Quote" ("customerId", "tenantId");

CREATE INDEX "g3b_QuoteItem_quoteId_tenant_idx"
  ON "QuoteItem" ("quoteId", "tenantId");

CREATE INDEX "g3b_QuoteItem_bakeryProductOfferingId_tenant_idx"
  ON "QuoteItem" ("bakeryProductOfferingId", "tenantId");

CREATE INDEX "g3b_QuoteItem_productVariantId_tenant_idx"
  ON "QuoteItem" ("productVariantId", "tenantId");

CREATE INDEX "g3b_Order_customerId_tenant_idx"
  ON "Order" ("customerId", "tenantId");

CREATE INDEX "g3b_Order_cityId_tenant_idx"
  ON "Order" ("cityId", "tenantId");

CREATE INDEX "g3b_Order_operationalZoneId_tenant_idx"
  ON "Order" ("operationalZoneId", "tenantId");

CREATE INDEX "g3b_Order_bakeryBranchId_tenant_idx"
  ON "Order" ("bakeryBranchId", "tenantId");

CREATE INDEX "g3b_Order_savedAddressId_tenant_idx"
  ON "Order" ("savedAddressId", "tenantId");

CREATE INDEX "g3b_OrderItem_orderId_tenant_idx"
  ON "OrderItem" ("orderId", "tenantId");

CREATE INDEX "g3b_OrderItem_productVariantId_tenant_idx"
  ON "OrderItem" ("productVariantId", "tenantId");

CREATE INDEX "g3b_OrderItem_bakeryProductOfferingId_tenant_idx"
  ON "OrderItem" ("bakeryProductOfferingId", "tenantId");

CREATE INDEX "g3b_OrderStateTransition_orderId_tenant_idx"
  ON "OrderStateTransition" ("orderId", "tenantId");

CREATE INDEX "g3b_Fulfillment_orderId_tenant_idx"
  ON "Fulfillment" ("orderId", "tenantId");

CREATE INDEX "g3b_Fulfillment_bakeryBranchId_tenant_idx"
  ON "Fulfillment" ("bakeryBranchId", "tenantId");

CREATE INDEX "g3b_Courier_courierPartnerId_tenant_idx"
  ON "Courier" ("courierPartnerId", "tenantId");

CREATE INDEX "g3b_Vehicle_courierPartnerId_tenant_idx"
  ON "Vehicle" ("courierPartnerId", "tenantId");

CREATE INDEX "g3b_DeliveryTask_fulfillmentId_tenant_idx"
  ON "DeliveryTask" ("fulfillmentId", "tenantId");

CREATE INDEX "g3b_DeliveryAssignment_deliveryTaskId_tenant_idx"
  ON "DeliveryAssignment" ("deliveryTaskId", "tenantId");

CREATE INDEX "g3b_DeliveryAssignment_courierId_tenant_idx"
  ON "DeliveryAssignment" ("courierId", "tenantId");

CREATE INDEX "g3b_DeliveryAssignment_vehicleId_tenant_idx"
  ON "DeliveryAssignment" ("vehicleId", "tenantId");

CREATE INDEX "g3b_CustomerEvent_customerId_tenant_idx"
  ON "CustomerEvent" ("customerId", "tenantId");

CREATE INDEX "g3b_SupportCase_customerId_tenant_idx"
  ON "SupportCase" ("customerId", "tenantId");

CREATE INDEX "g3b_SupportCase_orderId_tenant_idx"
  ON "SupportCase" ("orderId", "tenantId");

-- Tenant-aware relationship constraints.
ALTER TABLE "OperationalZone"
  ADD CONSTRAINT "g3b_OperationalZone_cityId_tenant_fk"
  FOREIGN KEY ("cityId", "tenantId")
  REFERENCES "City" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "ServiceArea"
  ADD CONSTRAINT "g3b_ServiceArea_operationalZoneId_tenant_fk"
  FOREIGN KEY ("operationalZoneId", "tenantId")
  REFERENCES "OperationalZone" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "HouseholdMember"
  ADD CONSTRAINT "g3b_HouseholdMember_householdId_tenant_fk"
  FOREIGN KEY ("householdId", "tenantId")
  REFERENCES "Household" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "HouseholdMember"
  ADD CONSTRAINT "g3b_HouseholdMember_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Address"
  ADD CONSTRAINT "g3b_Address_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Address"
  ADD CONSTRAINT "g3b_Address_cityId_tenant_fk"
  FOREIGN KEY ("cityId", "tenantId")
  REFERENCES "City" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Address"
  ADD CONSTRAINT "g3b_Address_operationalZoneId_tenant_fk"
  FOREIGN KEY ("operationalZoneId", "tenantId")
  REFERENCES "OperationalZone" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "BakeryBranch"
  ADD CONSTRAINT "g3b_BakeryBranch_bakeryId_tenant_fk"
  FOREIGN KEY ("bakeryId", "tenantId")
  REFERENCES "Bakery" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "BakeryBranch"
  ADD CONSTRAINT "g3b_BakeryBranch_cityId_tenant_fk"
  FOREIGN KEY ("cityId", "tenantId")
  REFERENCES "City" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "BakeryBranch"
  ADD CONSTRAINT "g3b_BakeryBranch_operationalZoneId_tenant_fk"
  FOREIGN KEY ("operationalZoneId", "tenantId")
  REFERENCES "OperationalZone" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "BakeryOperatingHours"
  ADD CONSTRAINT "g3b_BakeryOperatingHours_bakeryBranchId_tenant_fk"
  FOREIGN KEY ("bakeryBranchId", "tenantId")
  REFERENCES "BakeryBranch" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "BakeryCapacitySlot"
  ADD CONSTRAINT "g3b_BakeryCapacitySlot_bakeryBranchId_tenant_fk"
  FOREIGN KEY ("bakeryBranchId", "tenantId")
  REFERENCES "BakeryBranch" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Product"
  ADD CONSTRAINT "g3b_Product_categoryId_tenant_fk"
  FOREIGN KEY ("categoryId", "tenantId")
  REFERENCES "ProductCategory" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "ProductVariant"
  ADD CONSTRAINT "g3b_ProductVariant_productId_tenant_fk"
  FOREIGN KEY ("productId", "tenantId")
  REFERENCES "Product" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "BakeryProductOffering"
  ADD CONSTRAINT "g3b_BakeryProductOffering_bakeryBranchId_tenant_fk"
  FOREIGN KEY ("bakeryBranchId", "tenantId")
  REFERENCES "BakeryBranch" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "BakeryProductOffering"
  ADD CONSTRAINT "g3b_BakeryProductOffering_productVariantId_tenant_fk"
  FOREIGN KEY ("productVariantId", "tenantId")
  REFERENCES "ProductVariant" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Cart"
  ADD CONSTRAINT "g3b_Cart_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Cart"
  ADD CONSTRAINT "g3b_Cart_cityId_tenant_fk"
  FOREIGN KEY ("cityId", "tenantId")
  REFERENCES "City" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Cart"
  ADD CONSTRAINT "g3b_Cart_operationalZoneId_tenant_fk"
  FOREIGN KEY ("operationalZoneId", "tenantId")
  REFERENCES "OperationalZone" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Cart"
  ADD CONSTRAINT "g3b_Cart_bakeryBranchId_tenant_fk"
  FOREIGN KEY ("bakeryBranchId", "tenantId")
  REFERENCES "BakeryBranch" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "CartItem"
  ADD CONSTRAINT "g3b_CartItem_cartId_tenant_fk"
  FOREIGN KEY ("cartId", "tenantId")
  REFERENCES "Cart" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "CartItem"
  ADD CONSTRAINT "g3b_CartItem_bakeryProductOfferingId_tenant_fk"
  FOREIGN KEY ("bakeryProductOfferingId", "tenantId")
  REFERENCES "BakeryProductOffering" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Quote"
  ADD CONSTRAINT "g3b_Quote_cartId_tenant_fk"
  FOREIGN KEY ("cartId", "tenantId")
  REFERENCES "Cart" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Quote"
  ADD CONSTRAINT "g3b_Quote_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "QuoteItem"
  ADD CONSTRAINT "g3b_QuoteItem_quoteId_tenant_fk"
  FOREIGN KEY ("quoteId", "tenantId")
  REFERENCES "Quote" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "QuoteItem"
  ADD CONSTRAINT "g3b_QuoteItem_bakeryProductOfferingId_tenant_fk"
  FOREIGN KEY ("bakeryProductOfferingId", "tenantId")
  REFERENCES "BakeryProductOffering" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "QuoteItem"
  ADD CONSTRAINT "g3b_QuoteItem_productVariantId_tenant_fk"
  FOREIGN KEY ("productVariantId", "tenantId")
  REFERENCES "ProductVariant" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Order"
  ADD CONSTRAINT "g3b_Order_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Order"
  ADD CONSTRAINT "g3b_Order_cityId_tenant_fk"
  FOREIGN KEY ("cityId", "tenantId")
  REFERENCES "City" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Order"
  ADD CONSTRAINT "g3b_Order_operationalZoneId_tenant_fk"
  FOREIGN KEY ("operationalZoneId", "tenantId")
  REFERENCES "OperationalZone" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Order"
  ADD CONSTRAINT "g3b_Order_bakeryBranchId_tenant_fk"
  FOREIGN KEY ("bakeryBranchId", "tenantId")
  REFERENCES "BakeryBranch" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Order"
  ADD CONSTRAINT "g3b_Order_savedAddressId_tenant_fk"
  FOREIGN KEY ("savedAddressId", "tenantId")
  REFERENCES "Address" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "g3b_OrderItem_orderId_tenant_fk"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "g3b_OrderItem_productVariantId_tenant_fk"
  FOREIGN KEY ("productVariantId", "tenantId")
  REFERENCES "ProductVariant" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "g3b_OrderItem_bakeryProductOfferingId_tenant_fk"
  FOREIGN KEY ("bakeryProductOfferingId", "tenantId")
  REFERENCES "BakeryProductOffering" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "OrderStateTransition"
  ADD CONSTRAINT "g3b_OrderStateTransition_orderId_tenant_fk"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Fulfillment"
  ADD CONSTRAINT "g3b_Fulfillment_orderId_tenant_fk"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Fulfillment"
  ADD CONSTRAINT "g3b_Fulfillment_bakeryBranchId_tenant_fk"
  FOREIGN KEY ("bakeryBranchId", "tenantId")
  REFERENCES "BakeryBranch" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Courier"
  ADD CONSTRAINT "g3b_Courier_courierPartnerId_tenant_fk"
  FOREIGN KEY ("courierPartnerId", "tenantId")
  REFERENCES "CourierPartner" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "Vehicle"
  ADD CONSTRAINT "g3b_Vehicle_courierPartnerId_tenant_fk"
  FOREIGN KEY ("courierPartnerId", "tenantId")
  REFERENCES "CourierPartner" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "DeliveryTask"
  ADD CONSTRAINT "g3b_DeliveryTask_fulfillmentId_tenant_fk"
  FOREIGN KEY ("fulfillmentId", "tenantId")
  REFERENCES "Fulfillment" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "DeliveryAssignment"
  ADD CONSTRAINT "g3b_DeliveryAssignment_deliveryTaskId_tenant_fk"
  FOREIGN KEY ("deliveryTaskId", "tenantId")
  REFERENCES "DeliveryTask" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "DeliveryAssignment"
  ADD CONSTRAINT "g3b_DeliveryAssignment_courierId_tenant_fk"
  FOREIGN KEY ("courierId", "tenantId")
  REFERENCES "Courier" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "DeliveryAssignment"
  ADD CONSTRAINT "g3b_DeliveryAssignment_vehicleId_tenant_fk"
  FOREIGN KEY ("vehicleId", "tenantId")
  REFERENCES "Vehicle" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "CustomerEvent"
  ADD CONSTRAINT "g3b_CustomerEvent_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "SupportCase"
  ADD CONSTRAINT "g3b_SupportCase_customerId_tenant_fk"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES "Customer" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "SupportCase"
  ADD CONSTRAINT "g3b_SupportCase_orderId_tenant_fk"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order" ("id", "tenantId")
  ON UPDATE CASCADE
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE;
