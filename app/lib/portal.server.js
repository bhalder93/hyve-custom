/**
 * Shared conventions for the distributor portal.
 *
 * Two specs govern this file:
 *  - "Order Status Notifications and Alerts" v1.1 defines how the production
 *    lifecycle is stored on a Shopify order: one `hyve-status:*` tag at a time,
 *    mirrored into `hyve.production_status`, alongside supporting metafields.
 *  - "Distributor Portal Requirements" v1.6 (newer) defines what the customer
 *    sees: six statuses (J3), no delivery status (J10), and J6 requires the
 *    wording to match J3 exactly.
 *
 * So: eight statuses are stored, six are shown. `delivered` is recorded for the
 * internal clocks but displayed as Shipped, per J10.
 *
 * Open with the client: `awaiting-artwork` (F11) and `credit-under-review` (J3)
 * are required states with no tag in the status spec. They are modelled here in
 * the same family so the portal can show them the moment Flow sets them.
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
  { key: "credit-under-review", label: "Credit Under Review", tone: "warn" },
  { key: "on-hold", label: "On Hold", tone: "error" },
];

const ALL_STATUSES = [...VISIBLE_STATUSES, ...BRANCH_STATUSES];
const STATUS_BY_KEY = Object.fromEntries(ALL_STATUSES.map((s) => [s.key, s]));

/** Stored tag value -> displayed status key. */
const TAG_TO_STATUS = {
  "order-placed": "order-received",
  "artwork-received": "artwork-received",
  "awaiting-artwork": "awaiting-artwork",
  "credit-under-review": "credit-under-review",
  "proof-sent": "proof-sent",
  "proof-approved": "in-production",
  "in-production": "in-production",
  "production-complete": "production-completed",
  shipped: "shipped",
  // Recorded by Flow on the carrier delivery scan, but never shown as its own
  // state: under EXW and FOB the last leg is the buyer's freight (J10).
  delivered: "shipped",
  "on-hold": "on-hold",
};

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
 * Work out an order's displayed status from its `hyve-status:*` tag, falling
 * back to Shopify's own fulfillment state for orders Flow hasn't tagged yet.
 *
 * @param {{tags?:string[], displayFulfillmentStatus?:string}} order
 */
export function orderStatusKey(order) {
  const tags = normalizeTags(order?.tags);
  const statusTag = tags.find((t) => t.startsWith(STATUS_TAG_PREFIX));
  if (statusTag) {
    const mapped = TAG_TO_STATUS[statusTag.slice(STATUS_TAG_PREFIX.length)];
    if (mapped) return mapped;
  }

  // Untagged order: Shopify's fulfillment state is the only signal we have.
  const fulfillment = String(order?.displayFulfillmentStatus || "").toUpperCase();
  if (["FULFILLED", "PARTIALLY_FULFILLED", "IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(fulfillment)) {
    return "shipped";
  }
  return "order-received";
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
