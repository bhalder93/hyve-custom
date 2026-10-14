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
  { label: "Physical Sample Preparation", value: "sample-preparation" },
  { label: "Awaiting Sample Approval", value: "sample-review" },
  { label: "In Production", value: "in-production" },
  { label: "Production Complete", value: "production-complete" },
  // In place of Shipped for a customer-arranged freight (FOB) order, once its
  // production photo is approved. Not in STATUS_TRANSITIONS: the order page
  // offers it only for those orders.
  { label: "Ready For Collection", value: "ready-for-collection" },
  { label: "Shipped", value: "shipped" },
  { label: "Delivered", value: "delivered" },
  { label: "On Hold", value: "on-hold" },
];

export const STATUS_TRANSITIONS = {
  // Every order goes through its Artwork Proof: there is no skipping from
  // Order Received straight to Proof Approved (HYV-100, Michael).
  "order-placed": ["artwork-received", "on-hold"],

  "artwork-received": ["proof-sent", "on-hold"],

  "proof-sent": ["proof-approved", "sample-preparation", "on-hold"],

  // Awaiting Sample Approval is reached only by Dispatch Physical Sample on
  // the order page, which records the sample the buyer's email links answer.
  "proof-approved": ["sample-preparation", "in-production", "on-hold"],

  "sample-preparation": ["in-production", "on-hold"],

  "sample-review": ["in-production", "sample-preparation", "on-hold"],

  "in-production": ["production-complete", "on-hold"],

  "production-complete": ["shipped", "on-hold"],

  "ready-for-collection": ["delivered", "on-hold"],

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
 * @param {{noArtwork?: boolean}} [options] noArtwork: the order needs no
 *   artwork (a blank order), so it goes straight to In Production from Order
 *   Received, skipping the artwork and proof steps (HYV-120, Michael's F20)
 * @returns {string[]}
 */
export function allowedMoves(currentStatus, history = [], { noArtwork = false } = {}) {
  // A blank order with no status yet starts production; one at Order Received
  // can also be held, and a hold there resumes to Order Received or straight
  // into production, never into the proof steps.
  if (noArtwork && !currentStatus) return ["in-production"];
  if (noArtwork && currentStatus === "order-placed") return ["in-production", "on-hold"];
  if (!currentStatus) return ["order-placed"];
  if (currentStatus !== "on-hold") return STATUS_TRANSITIONS[currentStatus] ?? [];

  const heldFrom = history.find((entry) => entry?.toStatus === "on-hold")?.fromStatus || "";
  if (noArtwork && heldFrom === "order-placed") return ["order-placed", "in-production"];
  const step = heldFrom && heldFrom !== "on-hold" && STATUS_TRANSITIONS[heldFrom] ? heldFrom : "proof-sent";
  const moves = [step, ...STATUS_TRANSITIONS[step].filter((status) => status !== "on-hold")];
  if (step === "production-complete" && !moves.includes("ready-for-collection")) {
    moves.push("ready-for-collection");
  }
  return moves;
}

/** The statuses that email the buyer when staff set them on the order page. */
export const CUSTOMER_EMAIL_STATUSES = new Set([
  "artwork-received",
  "proof-sent",
  "proof-approved",
  "sample-preparation",
  "sample-review",
  "production-complete",
  "ready-for-collection",
]);

export const CUSTOMER_ARRANGED_FREIGHT_TAG = "hyve-freight:customer-arranged";

/**
 * True when the buyer arranges the order's freight: the FOB rate was chosen at
 * checkout ("FOB (Freight Arranged Separately)"). Such an order ends at Ready
 * For Collection instead of Shipped, and has no delivery-scan check.
 *
 * @param {{shippingLine?:{title?:string}, tags?:string[]|string}} order
 */
export function customerArrangesFreight(order) {
  const tags = order?.tags;
  const hasTag = Array.isArray(tags)
    ? tags.includes(CUSTOMER_ARRANGED_FREIGHT_TAG)
    : typeof tags === "string"
      ? tags.split(",").map((t) => t.trim()).includes(CUSTOMER_ARRANGED_FREIGHT_TAG)
      : false;

  if (hasTag) return true;

  return /\bFOB\b/i.test(String(order?.shippingLine?.title || "").trim());
}
