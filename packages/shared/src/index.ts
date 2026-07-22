export type CityCode = string;
export type Money = Readonly<{ amount: number; currency: "IRR" }>;

export type FulfillmentMode =
  | "MADE_TO_ORDER_FRESH_SIGNATURE"
  | "PACKAGED_TRADITIONAL_STOCK"
  | "PACKAGED_SPECIALTY_STOCK"
  | "PREORDER_LIMITED";

export type ActorType =
  | "CUSTOMER"
  | "HOUSEHOLD_MEMBER"
  | "CALL_CENTER_AGENT"
  | "BAKERY"
  | "SUPPLIER"
  | "LOGISTICS_PROVIDER"
  | "COURIER"
  | "ADMIN";
