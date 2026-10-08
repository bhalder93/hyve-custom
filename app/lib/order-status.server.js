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
 *   - `$app.production_due_at` on Proof Approved: the standard or rush
 *     production time from Commercial Settings, in business days that skip
 *     weekends and CN holidays
 *   - `$app.on_hold_reason` while On Hold, deleted on any other move
 *   - an `order_status_history` entry, which is the audit trail staff see
 *   - the customer email for the new status, sent once and marked with a
 *     `hyve-notified:*` tag so a retry or a second move doesn't repeat it
 *
 * These mirror the Production Orders screen field for field. If one changes,
 * both must.
 */
import { sendArtworkReceivedEmail, sendProofApprovedEmail, sendOrderOnHoldAlert } from "../utils/email.server";
import { getCustomerServiceRecipients } from "../utils/metaobjects/notification-recipients.server";
import { statusEmailWanted } from "./notification-preferences.server";
import { loadCommercialSettings } from "./commercial-settings.server";
import { syncLineItemArtworkReceived } from "./order-artwork.server";

const STATUS_TAG_PREFIX = "hyve-status:";
const NOTIFIED_TAG_PREFIX = "hyve-notified:";

/**
 * Recorded on the history entry, next to the webhooks' and the admin screen's:
 * a move made signed in to the portal, or from a link in the proof email.
 */
export const SOURCES = { portal: "CUSTOMER_PORTAL", proofEmail: "PROOF_EMAIL", sla: "SLA_CHECK", manualSla: "MANUAL_SLA" };

/**
 * The only moves a buyer makes, each allowed by the Production Orders screen's
 * own transition rules.
 */
const PORTAL_MOVES = {
  "order-placed": ["artwork-received"],
  "proof-sent": ["proof-approved", "on-hold"],
  "production-complete": ["on-hold"],
};

/**
 * The market whose holidays production and the artwork deadline skip:
 * China. Holidays set for other markets on the Holidays page are not
 * counted.
 */
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
    proofUrl: metafield(namespace: "$app", key: "proof_url") { value }
    estimatedShipDate: metafield(namespace: "hyve", key: "estimated_ship_date") { value }
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

const PRODUCTION_HOLIDAYS = `#graphql
  query ProductionHolidays {
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
 * @param {{to:string, changedBy:string, note?:string, onHoldReason?:string, source?:string}} move
 * @returns {Promise<{ok:true, from:string, productionDueAt:string|null, emailError?:string}|{ok:false, error:string}>}
 */
export async function changeProductionStatus(
  admin,
  order,
  { to, changedBy, note = "", onHoldReason = "", source = SOURCES.portal, ipAddress = "", userAgent = "" },
) {
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

  await recordStatusHistory(admin, { order, from, to, changedAt, changedBy: changedBy || "Customer", source, note, ipAddress, userAgent });

  if (to === "artwork-received") {
    try {
      await syncLineItemArtworkReceived(admin, order);
    } catch (artError) {
      console.error(`[portal] line item artwork update failed for ${order.name}:`, artError);
    }
  }

  if (to === "on-hold") {
    try {
      await notifyCustomerServiceOrderOnHold(admin, {
        order,
        onHoldReason,
        changedBy: changedBy || "Customer",
        note,
      });
    } catch (csError) {
      console.error(`[portal] on-hold Customer Service notification failed for ${order.name}:`, csError);
    }
  }

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
/**
 * One entry on the order's Production timeline, the audit trail staff see.
 * Every move that isn't made on the Production Orders screen writes it here:
 * the buyer in the portal or from the proof email, and the automatic day-10
 * hold, which used to leave no entry at all.
 */
export async function recordStatusHistory(admin, { order, from, to, changedAt, changedBy, source, note = "", ipAddress = "", userAgent = "" }) {
  const fields = [
    { key: "order_id", value: order.id },
    { key: "order_name", value: order.name },
    { key: "from_status", value: from },
    { key: "to_status", value: to },
    { key: "changed_at", value: changedAt },
    { key: "changed_by", value: changedBy },
    { key: "source", value: source },
  ];
  if (String(note).trim()) fields.push({ key: "note", value: String(note).trim() });
  if (ipAddress) fields.push({ key: "ip_address", value: ipAddress });
  if (userAgent) fields.push({ key: "user_agent", value: userAgent });
  check(
    await gql(admin, HISTORY_CREATE, { metaobject: { type: "$app:order_status_history", fields } }),
    "metaobjectCreate",
  );
}

/**
 * Notifies recipients with role Customer Service when an order is placed On Hold.
 */
export async function notifyCustomerServiceOrderOnHold(
  admin,
  { order, onHoldReason = "", changedBy = "", note = "" },
) {
  try {
    const recipients = await getCustomerServiceRecipients(admin);
    if (!recipients || !recipients.length) {
      console.warn(`[on-hold] No Customer Service recipients found for ${order.name}. Alert not sent.`);
      return { ok: false, sent: false, reason: "No Customer Service recipients configured" };
    }

    const numericOrderId = String(order.id || "").replace(/^gid:\/\/shopify\/Order\//, "").split("/").pop();
    const adminUrl = process.env.SHOPIFY_APP_URL
      ? `${process.env.SHOPIFY_APP_URL}/app/production-orders/${numericOrderId}`
      : "";

    const customerName =
      order.customer?.displayName ||
      order.customer?.name ||
      order.shippingAddress?.name ||
      "Customer";

    await sendOrderOnHoldAlert({
      to: recipients,
      orderName: order.name,
      customerName,
      onHoldReason,
      changedBy,
      note,
      adminUrl,
    });

    return { ok: true, sent: true, recipients };
  } catch (error) {
    console.error(`[on-hold] Customer Service notification failed for ${order.name}:`, error);
    return { ok: false, sent: false, error: error?.message || String(error) };
  }
}

async function notifyCustomer(admin, order, status, productionDueAt) {
  if (status !== "artwork-received" && status !== "proof-approved") return;

  const tag = `${NOTIFIED_TAG_PREFIX}${status}`;
  if ((order.tags || []).includes(tag)) return;
  if (!(await statusEmailWanted(admin, order.customer?.id, status))) return;

  const customerEmail = order.customer?.defaultEmailAddress?.emailAddress || order.email || "";
  if (!customerEmail) throw new Error("Customer email address is missing.");

  const common = {
    customerEmail,
    customerName: order.customer?.displayName || order.shippingAddress?.name || "Customer",
    orderName: order.name,
    orderDate: order.createdAt,
    lineItems: order.lineItems?.nodes || [],
  };

  let estimatedShipDate = order.estimatedShipDate?.value;
  if (!estimatedShipDate && productionDueAt) {
    const d = new Date(productionDueAt);
    d.setDate(d.getDate() + 5);
    estimatedShipDate = d.toISOString();
  }

  if (status === "artwork-received") await sendArtworkReceivedEmail(common);
  else await sendProofApprovedEmail({ ...common, productionDueAt, estimatedShipDate });

  check(await gql(admin, TAGS_ADD, { id: order.id, tags: [tag] }), "tagsAdd");
}

/**
 * Production due date for an approval made now: the production time from
 * Commercial Settings, in business days that skip weekends and the production
 * market's holidays.
 */
async function productionDueFrom(admin, changedAt, rush) {
  return productionDueDate(await productionCalendar(admin), changedAt, rush);
}

/**
 * What a production due date is counted from: the standard and rush
 * production times in Commercial Settings (HYV-133), the same ones the product
 * page, cart and quote promise, and the production market's enabled holidays.
 * Every due date comes through here: an approval on the Production Orders
 * screen, one the buyer makes from the email or the portal, and the recount
 * when holidays change. Read once and reused when many orders are worked out
 * together (production-reschedule.server.js).
 */
export async function productionCalendar(admin) {
  const [data, { values }] = await Promise.all([gql(admin, PRODUCTION_HOLIDAYS), loadCommercialSettings(admin)]);

  const isChinaHoliday = (market) => {
    const m = String(market || "").trim().toUpperCase();
    return m === PRODUCTION_MARKET || m === "CHINA";
  };

  const holidays = new Set(
    (data.holidays?.nodes || [])
      .filter(
        (node) =>
          node.enabled?.value !== "false" &&
          isChinaHoliday(node.market?.value) &&
          node.date?.value,
      )
      .map((node) => String(node.date.value).slice(0, 10)),
  );

  return {
    standardDays: Number(values.production_days_standard),
    rushDays: Number(values.production_days_rush),
    // Blank means Hyve has set no artwork deadline (HYV-102).
    artworkDueDays: values.artwork_due_days ? Number(values.artwork_due_days) : null,
    holidays,
  };
}

/**
 * Singapore, and China where production runs, are UTC+8 all year. Business
 * days are counted as they fall there: counted in UTC, a proof approved early
 * on a Saturday in Singapore was still Friday, so the count started a day
 * early and the due date came out a day late (HYV-100, #1064).
 */
const PRODUCTION_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/** `days` business days after `from`, skipping weekends and the calendar's holidays. */
function addBusinessDays(calendar, from, days) {
  // Shifted to UTC+8, so the UTC calendar methods read Singapore's days.
  const date = new Date(new Date(from).getTime() + PRODUCTION_UTC_OFFSET_MS);
  let added = 0;
  while (added < days) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !calendar.holidays.has(date.toISOString().slice(0, 10))) added += 1;
  }
  return new Date(date.getTime() - PRODUCTION_UTC_OFFSET_MS).toISOString();
}

/** The due date for a proof approved at `approvedAt`, on a given calendar. */
export function productionDueDate(calendar, approvedAt, rush) {
  const days = rush ? calendar.rushDays : calendar.standardDays;
  if (!Number.isInteger(days) || days < 1) throw new Error("Production times are missing from Commercial Settings.");
  return addBusinessDays(calendar, approvedAt, days);
}

/**
 * When artwork sent later is due on an order placed at `placedAt`: the
 * artwork deadline in Commercial Settings (HYV-102), on the same business-day
 * calendar as production. Null while Hyve has set no deadline.
 */
export function artworkDueDate(calendar, placedAt) {
  const days = calendar.artworkDueDays;
  if (!Number.isInteger(days) || days < 1 || !placedAt) return null;
  return addBusinessDays(calendar, placedAt, days);
}
