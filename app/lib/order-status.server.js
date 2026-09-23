/**
 * Moving an order along the production chain from the portal.
 *
 * The chain belongs to the SLA engine and the Production Orders screen
 * (app.production-orders.$orderId.jsx). A move made here is only real if it
 * leaves the same marks theirs does, because the engine, the Production Orders
 * list and the reminders all read them:
 *
 *   - `$app.production_status`, the status itself, which everything reads first
 *   - one `hyve-status:*` tag mirroring it
 *   - `$app.status_changed_at`, which every SLA clock runs from
 *   - `$app.production_due_at` on Proof Approved: the in-production service
 *     level (a fixed 4 business days on a rush order), skipping weekends and
 *     CN holidays
 *   - `$app.on_hold_reason` while On Hold, deleted on any other move
 *   - an `order_status_history` entry, which is the audit trail staff see
 *   - the customer email for the new status, sent once and marked with a
 *     `hyve-notified:*` tag so a retry or a second move doesn't repeat it
 *
 * These mirror the Production Orders screen field for field. If one changes,
 * both must.
 */
import { sendArtworkReceivedEmail, sendProofApprovedEmail } from "../utils/email.server";

const STATUS_TAG_PREFIX = "hyve-status:";
const NOTIFIED_TAG_PREFIX = "hyve-notified:";

/** Recorded on the history entry, next to the webhooks' and the admin screen's. */
const SOURCE = "CUSTOMER_PORTAL";

/**
 * The only moves a buyer makes, each allowed by the Production Orders screen's
 * own transition rules.
 */
const PORTAL_MOVES = {
  "order-placed": ["artwork-received"],
  "proof-sent": ["proof-approved", "on-hold"],
};

const RUSH_PRODUCTION_DAYS = 4;
const DEFAULT_PRODUCTION_DAYS = 7;
const PRODUCTION_MARKET = "CN";

/**
 * What a move needs to know about the order. Order actions load it through
 * this fragment so there is one list of fields to keep in step.
 */
export const PRODUCTION_ORDER_FRAGMENT = `#graphql
  fragment ProductionOrder on Order {
    id
    name
    createdAt
    tags
    email
    customer { id displayName defaultEmailAddress { emailAddress } }
    shippingAddress { name }
    productionStatus: metafield(namespace: "$app", key: "production_status") { value }
    rush: metafield(namespace: "$app", key: "rush") { value }
    proofVersion: metafield(namespace: "$app", key: "proof_version") { value }
    lineItems(first: 100) {
      nodes {
        title
        quantity
        sku
        variantTitle
        customAttributes { key value }
        image { url }
        variant { image { url } }
        product { featuredImage { url } }
      }
    }
  }`;

const SERVICE_LEVELS = `#graphql
  query ProductionServiceLevels {
    rules: metaobjects(type: "$app:sla_rule", first: 100) {
      nodes {
        status: field(key: "status") { value }
        duration: field(key: "duration") { value }
        enabled: field(key: "enabled") { value }
      }
    }
    holidays: metaobjects(type: "$app:business_holiday", first: 250) {
      nodes {
        market: field(key: "market") { value }
        date: field(key: "date") { value }
        enabled: field(key: "enabled") { value }
      }
    }
  }`;

const TAGS_ADD = `#graphql
  mutation ProductionTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;

const TAGS_REMOVE = `#graphql
  mutation ProductionTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;

const METAFIELDS_SET = `#graphql
  mutation ProductionMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message code } }
  }`;

const METAFIELDS_DELETE = `#graphql
  mutation ProductionMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }`;

const HISTORY_CREATE = `#graphql
  mutation ProductionHistoryCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) { userErrors { field message code } }
  }`;

export async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors) throw new Error(body.errors[0]?.message || "Shopify rejected the request.");
  return body?.data || {};
}

/** Throws on the first user error, so a half-made move is never reported as done. */
function check(result, field) {
  const error = result?.[field]?.userErrors?.[0];
  if (error) throw new Error(error.message);
}

/**
 * The order's production status. The metafield is the record; the tag is read
 * only where the metafield is missing, the same order the SLA engine reads them.
 */
export function productionStatusOf(order) {
  const stored = String(order?.productionStatus?.value || "").trim();
  if (stored) return stored;
  const tag = (order?.tags || []).find((t) => String(t).startsWith(STATUS_TAG_PREFIX));
  return tag ? tag.slice(STATUS_TAG_PREFIX.length) : "";
}

/**
 * @param {object} order loaded with PRODUCTION_ORDER_FRAGMENT
 * @param {{to:string, changedBy:string, note?:string, onHoldReason?:string}} move
 * @returns {Promise<{ok:true, from:string, productionDueAt:string|null, emailError?:string}|{ok:false, error:string}>}
 */
export async function changeProductionStatus(admin, order, { to, changedBy, note = "", onHoldReason = "" }) {
  const from = productionStatusOf(order);
  if (!(PORTAL_MOVES[from] || []).includes(to)) {
    return { ok: false, error: "This order has already moved on, so that can't be done from here." };
  }
  if (to === "on-hold" && !onHoldReason.trim()) {
    return { ok: false, error: "An order can't go on hold without a reason." };
  }

  const changedAt = new Date().toISOString();
  const productionDueAt =
    to === "proof-approved" ? await productionDueFrom(admin, changedAt, order.rush?.value === "true") : null;

  const statusTags = (order.tags || []).filter((t) => String(t).startsWith(STATUS_TAG_PREFIX));
  if (statusTags.length) {
    check(await gql(admin, TAGS_REMOVE, { id: order.id, tags: statusTags }), "tagsRemove");
  }
  check(await gql(admin, TAGS_ADD, { id: order.id, tags: [`${STATUS_TAG_PREFIX}${to}`] }), "tagsAdd");

  const field = (key, type, value) => ({ ownerId: order.id, namespace: "$app", key, type, value });
  const metafields = [
    field("production_status", "single_line_text_field", to),
    field("status_changed_at", "date_time", changedAt),
  ];
  if (productionDueAt) metafields.push(field("production_due_at", "date_time", productionDueAt));
  if (to === "on-hold") metafields.push(field("on_hold_reason", "single_line_text_field", onHoldReason.trim()));
  check(await gql(admin, METAFIELDS_SET, { metafields }), "metafieldsSet");

  if (to !== "on-hold") {
    check(
      await gql(admin, METAFIELDS_DELETE, {
        metafields: [{ ownerId: order.id, namespace: "$app", key: "on_hold_reason" }],
      }),
      "metafieldsDelete",
    );
  }

  const fields = [
    { key: "order_id", value: order.id },
    { key: "order_name", value: order.name },
    { key: "from_status", value: from },
    { key: "to_status", value: to },
    { key: "changed_at", value: changedAt },
    { key: "changed_by", value: changedBy || "Customer" },
    { key: "source", value: SOURCE },
  ];
  if (note.trim()) fields.push({ key: "note", value: note.trim() });
  check(
    await gql(admin, HISTORY_CREATE, { metaobject: { type: "$app:order_status_history", fields } }),
    "metaobjectCreate",
  );

  // The move stands even if the email fails, as it does on the admin screen.
  let emailError;
  try {
    await notifyCustomer(admin, order, to, productionDueAt);
  } catch (error) {
    console.error(`[portal] ${to} email failed for ${order.name}`, error);
    emailError = error?.message || String(error);
  }

  return { ok: true, from, productionDueAt, emailError };
}

/** The emails the admin screen sends for the same two statuses. */
async function notifyCustomer(admin, order, status, productionDueAt) {
  if (status !== "artwork-received" && status !== "proof-approved") return;

  const tag = `${NOTIFIED_TAG_PREFIX}${status}`;
  if ((order.tags || []).includes(tag)) return;

  const customerEmail = order.customer?.defaultEmailAddress?.emailAddress || order.email || "";
  if (!customerEmail) throw new Error("Customer email address is missing.");

  const common = {
    customerEmail,
    customerName: order.customer?.displayName || order.shippingAddress?.name || "Customer",
    orderName: order.name,
    orderDate: order.createdAt,
    lineItems: order.lineItems?.nodes || [],
  };

  if (status === "artwork-received") await sendArtworkReceivedEmail(common);
  else await sendProofApprovedEmail({ ...common, productionDueAt });

  check(await gql(admin, TAGS_ADD, { id: order.id, tags: [tag] }), "tagsAdd");
}

/**
 * Production due date for an approval made now: the enabled in-production
 * service level, or a fixed 4 days on a rush order, counted in business days
 * that skip weekends and the production market's holidays.
 */
async function productionDueFrom(admin, changedAt, rush) {
  const data = await gql(admin, SERVICE_LEVELS);

  const rule = (data.rules?.nodes || []).find(
    (node) => node.status?.value === "in-production" && node.enabled?.value !== "false",
  );
  const days = rush ? RUSH_PRODUCTION_DAYS : Number(rule?.duration?.value) || DEFAULT_PRODUCTION_DAYS;

  const holidays = new Set(
    (data.holidays?.nodes || [])
      .filter(
        (node) =>
          node.enabled?.value !== "false" && node.market?.value === PRODUCTION_MARKET && node.date?.value,
      )
      .map((node) => String(node.date.value).slice(0, 10)),
  );

  const date = new Date(changedAt);
  let added = 0;
  while (added < days) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(date.toISOString().slice(0, 10))) added += 1;
  }
  return date.toISOString();
}
