/**
 * Shared conventions for the distributor portal.
 *
 * Two sources govern this file:
 *  - The production chain the SLA engine and the Production Orders screen run
 *    on: `$app.production_status`, mirrored by one `hyve-status:*` tag, with
 *    the values order-placed, artwork-received, proof-sent, proof-approved,
 *    in-production, production-complete, shipped, delivered and on-hold.
 *  - "Distributor Portal Requirements" v1.6 defines what the customer sees:
 *    six statuses (J3), no delivery status (J10), and J6 requires the wording
 *    to match J3 exactly.
 *
 * So: nine statuses are stored, six are shown, plus two branch states.
 * `delivered` is recorded for the internal clocks but displayed as Shipped, per
 * J10. Awaiting Artwork (F11) is not stored at all: it is an Order Placed order
 * whose buyer chose to send artwork later.
 */

/**
 * A distributor is a customer who belongs to a B2B company.
 *
 * The store runs Shopify B2B, so company membership is the approval: staff
 * approve an application by creating the company and attaching the customer as
 * a contact. Nothing else has to be kept in sync.
 */

const STATUS_TAG_PREFIX = "hyve-status:";

/** Customer metafields backing the commercial terms panel (M2, M3, M5). */
export const CUSTOMER_METAFIELDS = {
  namespace: "hyve",
  keys: {
    tier: "tier",
    paymentTerms: "payment_terms",
    salesRep: "sales_rep",
    salesRepEmail: "sales_rep_email",
    salesRepPhone: "sales_rep_phone",
  },
};

/**
 * The six customer-visible statuses, in J3 order. `key` is the filter value,
 * `label` is the exact wording J6 requires.
 */
export const VISIBLE_STATUSES = [
  { key: "order-received", label: "Order Received", tone: "neutral" },
  { key: "artwork-received", label: "Artwork Received", tone: "info" },
  { key: "proof-sent", label: "Proof Sent", tone: "warn" },
  { key: "in-production", label: "Approved and In Production", tone: "indigo" },
  { key: "production-completed", label: "Production Completed", tone: "teal" },
  { key: "shipped", label: "Shipped", tone: "ok" },
];

/**
 * Branch states. They are shown on a row but are not filters — J1 says the
 * filters are the six words in J3 and nothing else.
 */
export const BRANCH_STATUSES = [
  { key: "awaiting-artwork", label: "Awaiting Artwork", tone: "warn" },
  { key: "on-hold", label: "On Hold", tone: "error" },
];

const ALL_STATUSES = [...VISIBLE_STATUSES, ...BRANCH_STATUSES];
const STATUS_BY_KEY = Object.fromEntries(ALL_STATUSES.map((s) => [s.key, s]));

/** Stored status -> displayed status key. */
const STORED_TO_DISPLAY = {
  "order-placed": "order-received",
  "artwork-received": "artwork-received",
  "proof-sent": "proof-sent",
  "proof-approved": "in-production",
  "in-production": "in-production",
  "production-complete": "production-completed",
  shipped: "shipped",
  // Recorded for the internal clocks, but never shown as its own state: under
  // EXW and FOB the last leg is the buyer's freight (J10).
  delivered: "shipped",
  "on-hold": "on-hold",
};

/**
 * The value the product page writes to a line's `Artwork` property when the
 * buyer picks Send later (hyve-order.liquid). The order emails and the
 * order-created webhook read the same property.
 */
const ARTWORK_PENDING = "Artwork Pending";

/** Statuses that are waiting on the distributor — drives the Orders badge (H9). */
export const AWAITING_DISTRIBUTOR = ["proof-sent", "awaiting-artwork"];

/** @param {object} customer Admin API customer with companyContactProfiles */
export function isDistributor(customer) {
  return Boolean(customer?.companyContactProfiles?.length);
}

/** Look up a displayed status by key. */
export function statusByKey(key) {
  return STATUS_BY_KEY[key] || null;
}

/**
 * The portal's wording for a stored production status. The status emails use
 * it so they say exactly what the portal, and customer service, say.
 */
export function customerStatusLabel(stored) {
  return STATUS_BY_KEY[STORED_TO_DISPLAY[stored]]?.label || null;
}

/**
 * Work out an order's displayed status from its production status — the
 * `$app.production_status` metafield, or the `hyve-status:*` tag where that is
 * missing, the order the SLA engine reads them in — falling back to Shopify's
 * own fulfillment state for an order outside the production chain, such as a
 * blank one.
 *
 * @param {{productionStatus?:{value?:string}, tags?:string[], displayFulfillmentStatus?:string,
 *   lineItems?:{nodes?:Array<{customAttributes?:Array<{key?:string, value?:string}>}>}}} order
 */
export function orderStatusKey(order) {
  let stored = String(order?.productionStatus?.value || "").trim().toLowerCase();
  if (!stored) {
    const statusTag = normalizeTags(order?.tags).find((t) => t.startsWith(STATUS_TAG_PREFIX));
    stored = statusTag ? statusTag.slice(STATUS_TAG_PREFIX.length) : "";
  }

  if (stored === "order-placed" && artworkPending(order)) return "awaiting-artwork";
  if (STORED_TO_DISPLAY[stored]) return STORED_TO_DISPLAY[stored];

  // Outside the production chain: Shopify's fulfillment state is the only signal.
  const fulfillment = String(order?.displayFulfillmentStatus || "").toUpperCase();
  if (["FULFILLED", "PARTIALLY_FULFILLED", "IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(fulfillment)) {
    return "shipped";
  }
  return "order-received";
}

/**
 * True when any line was ordered with its artwork to follow. Such an order is
 * held at Awaiting Artwork until the artwork arrives, here and on the
 * Production Orders screen.
 */
export function artworkPending(order) {
  return (order?.lineItems?.nodes || []).some((line) =>
    (line?.customAttributes || []).some(
      (attr) => attr?.key === "Artwork" && String(attr.value || "").trim() === ARTWORK_PENDING,
    ),
  );
}

function normalizeTags(tags) {
  return (tags || []).map((t) => String(t).trim().toLowerCase());
}

/** Format money the way the portal shows it: "SGD 4,850". */
export function formatMoney(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "";
  const digits = Number.isInteger(value) ? 0 : 2;
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency ? `${currency} ${formatted}` : formatted;
}

/** Compact money for the summary cards: "SGD 20.2K". */
export function formatMoneyCompact(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "";
  const compact =
    Math.abs(value) >= 1000
      ? `${(value / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`
      : value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return currency ? `${currency} ${compact}` : compact;
}

/** "Jan 15, 2026" — UTC so the server's zone can't shift the date. */
export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
