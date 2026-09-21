export const HYVE_STATUS = {
  ORDER_PLACED: "Order Placed",
  ARTWORK_RECEIVED: "Artwork Received",
  PROOF_SENT: "Proof Sent",
  PROOF_APPROVED: "Proof Approved",
  IN_PRODUCTION: "In Production",
  PRODUCTION_COMPLETE: "Production Complete",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  ON_HOLD: "On Hold",
};

export const STATUS_TAGS = {
  "Order Placed":
    "hyve-status:order-placed",

  "Artwork Received":
    "hyve-status:artwork-received",

  "Proof Sent":
    "hyve-status:proof-sent",

  "Proof Approved":
    "hyve-status:proof-approved",

  "In Production":
    "hyve-status:in-production",

  "Production Complete":
    "hyve-status:production-complete",

  Shipped:
    "hyve-status:shipped",

  Delivered:
    "hyve-status:delivered",

  "On Hold":
    "hyve-status:on-hold",
};

export const TAG_TO_STATUS =
  Object.fromEntries(
    Object.entries(
      STATUS_TAGS,
    ).map(([status, tag]) => [
      tag,
      status,
    ]),
  );

export const ALLOWED_TRANSITIONS = {
  "Order Placed": [
    "Artwork Received",
  ],

  "Artwork Received": [
    "Proof Sent",
  ],

  "Proof Sent": [
    "Proof Approved",
    "On Hold",
  ],

  "Proof Approved": [
    "In Production",
  ],

  "In Production": [
    "Production Complete",
  ],

  "Production Complete": [
    "Shipped",
  ],

  Shipped: [
    "Delivered",
  ],

  "On Hold": [
    "Proof Sent",
  ],

  Delivered: [],
};