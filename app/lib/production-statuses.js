/**
 * The production statuses staff set on an order, in the order they run, and
 * the moves allowed from each. The order page, the orders list and the Order
 * Statuses page all read them from here (HYV-135).
 *
 * `value` is what is stored on the order (the `hyve-status:<value>` tag and
 * the production status metafield). `label` is the staff wording; the buyer
 * sees the portal's own wording for each (customerStatusLabel in
 * portal.server.js).
 *
 * Not a .server module: the order page's status dropdown uses it in the
 * browser too.
 */
export const STATUS_OPTIONS = [
  { label: "Order Received", value: "order-placed" },
  { label: "Artwork Received", value: "artwork-received" },
  { label: "Proof Sent", value: "proof-sent" },
  { label: "Proof Approved", value: "proof-approved" },
  { label: "In Production", value: "in-production" },
  { label: "Production Complete", value: "production-complete" },
  { label: "Shipped", value: "shipped" },
  { label: "Delivered", value: "delivered" },
  { label: "On Hold", value: "on-hold" },
];

export const STATUS_TRANSITIONS = {
  "order-placed": ["artwork-received", "proof-approved", "on-hold"],

  "artwork-received": ["proof-sent", "on-hold"],

  "proof-sent": ["proof-approved", "on-hold"],

  "proof-approved": ["in-production", "on-hold"],

  "in-production": ["production-complete", "on-hold"],

  "production-complete": ["shipped", "on-hold"],

  shipped: ["delivered", "on-hold"],

  delivered: [],

  "on-hold": [
    "proof-sent",
    "proof-approved",
    "in-production",
    "production-complete",
  ],
};

/** The statuses that email the buyer when staff set them on the order page. */
export const CUSTOMER_EMAIL_STATUSES = new Set([
  "artwork-received",
  "proof-sent",
  "proof-approved",
  "production-complete",
]);
