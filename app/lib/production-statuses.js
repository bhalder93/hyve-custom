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
  // Every order goes through its Artwork Proof: there is no skipping from
  // Order Received straight to Proof Approved (HYV-100, Michael).
  "order-placed": ["artwork-received", "on-hold"],

  "artwork-received": ["proof-sent", "on-hold"],

  "proof-sent": ["proof-approved", "on-hold"],

  "proof-approved": ["in-production", "on-hold"],

  "in-production": ["production-complete", "on-hold"],

  "production-complete": ["shipped", "on-hold"],

  shipped: ["delivered", "on-hold"],

  delivered: [],

  // On Hold goes back where it came from: see allowedMoves().
  "on-hold": [],
};

/**
 * The statuses an order can move to from where it is. On Hold is the one that
 * depends on the order (HYV-100): it goes back to the step it was held at, or
 * on to the next one. Held at Proof Sent, that is a new Artwork Proof or the
 * approval the buyer gave outside the portal. It is never a step the order
 * hasn't reached, so a hold can't be used to skip the proof.
 *
 * The step comes from the latest move to On Hold in the order's history. The
 * automatic day-10 hold records no history, but it only ever holds an order at
 * Proof Sent, so an unrecorded hold counts as held there.
 *
 * @param {string} currentStatus the stored production status
 * @param {Array<{fromStatus:string, toStatus:string}>} [history] newest first
 * @returns {string[]}
 */
export function allowedMoves(currentStatus, history = []) {
  if (!currentStatus) return ["order-placed"];
  if (currentStatus !== "on-hold") return STATUS_TRANSITIONS[currentStatus] ?? [];

  const heldFrom = history.find((entry) => entry?.toStatus === "on-hold")?.fromStatus || "";
  const step = heldFrom && heldFrom !== "on-hold" && STATUS_TRANSITIONS[heldFrom] ? heldFrom : "proof-sent";
  return [step, ...STATUS_TRANSITIONS[step].filter((status) => status !== "on-hold")];
}

/** The statuses that email the buyer when staff set them on the order page. */
export const CUSTOMER_EMAIL_STATUSES = new Set([
  "artwork-received",
  "proof-sent",
  "proof-approved",
  "production-complete",
]);
