/**
 * The credit review queue (HYV-162, HYV-179).
 *
 * A company on terms with "submit orders for review" gets a draft order at
 * checkout, not an order. The buyer sees it in Orders as Credit Under Review,
 * but in Shopify it sat among the drafts, so Bruce couldn't find it and
 * Michael found it under Quotes instead. This lists those drafts in Hyve
 * Custom and decides them:
 *
 * - Approve completes the draft. It keeps the company's payment terms, so the
 *   order is created payment pending, the orders/create webhook gives it Order
 *   Received, and Shopify sends the buyer its order confirmation.
 * - Decline needs a reason. The draft is tagged and keeps the reason, the
 *   buyer's Orders shows it as Credit Declined with the reason, and the buyer
 *   is emailed.
 *
 * Hyve is told when one arrives (webhooks.draft_orders.create): the Credit
 * Review recipients on the Notification Recipients page and the company's
 * sales rep.
 *
 * A cart quote's link is a draft order's checkout, which Shopify completes
 * straight into an order, so it skipped the review (HYV-162). Such an order
 * from one of these companies is put On Hold for credit review as it arrives
 * (webhooks.orders.create) and listed here too: Approve releases it to Order
 * Received, Decline cancels it and tells the buyer.
 */
import { DRAFT_ORIGIN_FIELDS, submittedForReview } from "./account-quotes.server";
import { formatDate, formatMoney } from "./portal.server";
import { SOURCES, productionStatusOf, writeProductionStatus } from "./order-status.server";

export const CREDIT_DECLINED_TAG = "credit-declined";
/** On an order held for credit review: it came from a cart quote's link. */
export const CREDIT_HOLD_TAG = "credit-review-hold";
const HOLD_REASON = "Credit review: Hyve checks your payment terms, then confirms the order";
export const CREDIT_REVIEW_ROLE = "CREDIT_REVIEW";
/** On the draft once Hyve is told, so a retried webhook can't send it twice. */
const NOTIFIED_TAG = "hyve-notified:credit-review";
const REASON_KEY = "credit_decline_reason";

const REVIEW_FIELDS = `
  id
  name
  createdAt
  status
  tags
  poNumber
  email
  paymentTerms { paymentTermsName }
  totalPriceSet { presentmentMoney { amount currencyCode } }
  customer { id displayName defaultEmailAddress { emailAddress } }
  purchasingEntity {
    ... on PurchasingCompany {
      company {
        id
        name
        # The sales rep, when the order's own address doesn't carry one.
        locations(first: 10) {
          nodes {
            salesRep: metafield(namespace: "hyve", key: "sales_rep") { value }
            salesRepEmail: metafield(namespace: "hyve", key: "sales_rep_email") { value }
          }
        }
      }
      location {
        id
        name
        salesRep: metafield(namespace: "hyve", key: "sales_rep") { value }
        salesRepEmail: metafield(namespace: "hyve", key: "sales_rep_email") { value }
      }
    }
  }
  lineItems(first: 5) { nodes { title quantity } }
  declineReason: metafield(namespace: "$app", key: "${REASON_KEY}") { value }
  ${DRAFT_ORIGIN_FIELDS}`;

// A held order, read with the names reviewRow expects.
const ORDER_FIELDS = `
  id
  name
  createdAt
  cancelledAt
  tags
  poNumber
  email
  customAttributes { key value }
  productionStatus: metafield(namespace: "$app", key: "production_status") { value }
  paymentTerms { paymentTermsName }
  totalPriceSet: currentTotalPriceSet { presentmentMoney { amount currencyCode } }
  customer { id displayName defaultEmailAddress { emailAddress } }
  purchasingEntity {
    ... on PurchasingCompany {
      company {
        id
        name
        locations(first: 10) {
          nodes {
            salesRep: metafield(namespace: "hyve", key: "sales_rep") { value }
            salesRepEmail: metafield(namespace: "hyve", key: "sales_rep_email") { value }
          }
        }
      }
      location {
        id
        name
        buyerExperienceConfiguration { checkoutToDraft }
        salesRep: metafield(namespace: "hyve", key: "sales_rep") { value }
        salesRepEmail: metafield(namespace: "hyve", key: "sales_rep_email") { value }
      }
    }
  }
  lineItems(first: 5) { nodes { title quantity } }`;

const HELD_ORDERS_QUERY = `#graphql
  query CreditReviewHeldOrders {
    orders(first: 25, query: "tag:${CREDIT_HOLD_TAG}", sortKey: CREATED_AT) {
      nodes { ${ORDER_FIELDS} }
    }
  }`;

const ORDER_QUERY = `#graphql
  query CreditReviewOrder($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }`;

const TAGS_ADD = `#graphql
  mutation CreditReviewTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;

const TAGS_REMOVE = `#graphql
  mutation CreditReviewTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;

const BLANK_CHECK = `#graphql
  query CreditReviewLines($id: ID!) {
    order(id: $id) { lineItems(first: 100) { nodes { customAttributes { key value } } } }
  }`;

/** Adds or removes tags, and fails loudly when Shopify refuses. */
async function changeTags(admin, id, { add = [], remove = [] }) {
  if (add.length) {
    const errors = (await run(admin, TAGS_ADD, { id, tags: add }))?.tagsAdd?.userErrors || [];
    if (errors.length) throw new Error(errors[0].message);
  }
  if (remove.length) {
    const errors = (await run(admin, TAGS_REMOVE, { id, tags: remove }))?.tagsRemove?.userErrors || [];
    if (errors.length) throw new Error(errors[0].message);
  }
}

/**
 * Where a released order goes: Order Received, or Ready For Collection for a
 * blank quote order (no artwork on any line), as orders/create sets it.
 */
async function releaseStatus(admin, orderGid) {
  const lines = (await run(admin, BLANK_CHECK, { id: orderGid }))?.order?.lineItems?.nodes || [];
  const blank = lines.every(
    (line) => !(line.customAttributes || []).some((attr) => attr.key === "Artwork" && String(attr.value || "").trim()),
  );
  return blank ? "ready-for-collection" : "order-placed";
}

/** Shopify's single-line field: a reason typed over several lines, on one. */
const oneLine = (text) => String(text || "").replace(/\s*[\r\n]+\s*/g, " ").trim();

const CANCEL = `#graphql
  mutation CreditReviewCancel($orderId: ID!, $staffNote: String) {
    orderCancel(orderId: $orderId, reason: OTHER, restock: true, notifyCustomer: false, staffNote: $staffNote) {
      job { id }
      orderCancelUserErrors { field message code }
    }
  }`;

const QUEUE_QUERY = `#graphql
  query CreditReviewQueue($after: String) {
    draftOrders(first: 25, after: $after, query: "status:open", sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes { ${REVIEW_FIELDS} }
    }
  }`;

const DRAFT_QUERY = `#graphql
  query CreditReviewDraft($id: ID!) {
    draftOrder(id: $id) { ${REVIEW_FIELDS} }
  }`;

const COMPLETE = `#graphql
  mutation CreditReviewApprove($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { id order { id name createdAt } }
      userErrors { field message }
    }
  }`;

const DECLINE = `#graphql
  mutation CreditReviewDecline($id: ID!, $tags: [String!]!, $metafields: [MetafieldsSetInput!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

// Pages of 25: each draft brings its lines, company and creation event, which
// keeps one page well inside Shopify's cost limit for a single query.
const QUEUE_PAGES = 40;

async function run(admin, query, variables) {
  const body = await (await admin.graphql(query, { variables })).json();
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
  return body?.data;
}

const isDeclined = (node) => (node?.tags || []).includes(CREDIT_DECLINED_TAG);

/** An open draft checkout made for review, not yet declined. */
export function waitingForReview(node) {
  return Boolean(node) && node.status === "OPEN" && submittedForReview(node) && !isDeclined(node);
}

const isOrder = (gid) => String(gid || "").startsWith("gid://shopify/Order/");

/** An order held for credit review, not yet decided or cancelled. */
export function heldForReview(node) {
  return Boolean(node) && (node.tags || []).includes(CREDIT_HOLD_TAG) && !node.cancelledAt;
}

/** The queue's row for a review draft or a held order. */
export function reviewRow(node) {
  const money = node.totalPriceSet?.presentmentMoney;
  const company = node.purchasingEntity?.company;
  const location = node.purchasingEntity?.location;
  const repFrom = [location, ...(company?.locations?.nodes || [])].find((l) => l?.salesRepEmail?.value || l?.salesRep?.value);
  return {
    id: node.id,
    // "order" for one held after checking out from a cart quote's link.
    kind: isOrder(node.id) ? "order" : "draft",
    numericId: String(node.id).replace(/^gid:\/\/shopify\/(DraftOrder|Order)\//, ""),
    name: node.name,
    submittedAt: node.createdAt,
    company: company?.name || "",
    location: location?.name || "",
    buyer: node.customer?.displayName || "",
    buyerEmail: node.customer?.defaultEmailAddress?.emailAddress || node.email || "",
    total: money ? formatMoney(money.amount, money.currencyCode) : "",
    terms: node.paymentTerms?.paymentTermsName || "",
    poNumber: node.poNumber || "",
    salesRep: repFrom?.salesRep?.value || "",
    salesRepEmail: repFrom?.salesRepEmail?.value || "",
    // What the buyer calls it: the portal shows an order in review by its PO,
    // never Shopify's #D draft number (HYV-173). Staff alerts keep the #D.
    buyerReference: isOrder(node.id) ? node.name : node.poNumber ? `PO ${node.poNumber}` : "",
    items: (node.lineItems?.nodes || []).map((li) => `${li.quantity} × ${li.title}`).join(", "),
  };
}

/** Every order waiting on a credit review, oldest first. */
export async function loadCreditReviewQueue(admin) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < QUEUE_PAGES; page += 1) {
    const block = (await run(admin, QUEUE_QUERY, { after }))?.draftOrders;
    nodes.push(...(block?.nodes || []));
    if (!block?.pageInfo?.hasNextPage) break;
    after = block.pageInfo.endCursor;
  }
  const held = (await run(admin, HELD_ORDERS_QUERY))?.orders?.nodes || [];
  return [...nodes.filter(waitingForReview), ...held.filter(heldForReview)]
    .map(reviewRow)
    .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
}

async function loadHeldOrder(admin, orderGid) {
  return (await run(admin, ORDER_QUERY, { id: orderGid }))?.order || null;
}

/**
 * Puts an order on hold for credit review when it came from a cart quote's
 * link and its company submits orders for review (HYV-162). Called by
 * webhooks.orders.create once the order has its first status. Staff quotes
 * aren't held: whether they should be is still Hyve's to decide.
 * @returns {Promise<{held:boolean, reason?:string}>}
 */
export async function holdOrderForCreditReview(admin, orderGid) {
  const order = await loadHeldOrder(admin, orderGid);
  if (!order) return { held: false, reason: "order not found" };
  if ((order.tags || []).includes(CREDIT_HOLD_TAG)) return { held: false, reason: "already held" };
  if (!order.purchasingEntity?.location?.buyerExperienceConfiguration?.checkoutToDraft) {
    return { held: false, reason: "company doesn't submit orders for review" };
  }
  const source = (order.customAttributes || []).find((attr) => attr.key === "Source")?.value;
  if (source !== "Cart quote") return { held: false, reason: "not from a cart quote" };
  const from = productionStatusOf(order);
  // Order Received, or Ready For Collection for a blank quote order.
  if (from !== "order-placed" && from !== "ready-for-collection") {
    return { held: false, reason: `already at ${from || "no status"}` };
  }

  // Tagged first: an order On Hold without the tag would be missing from the
  // queue, with nothing to release it.
  await changeTags(admin, orderGid, { add: [CREDIT_HOLD_TAG] });
  await writeProductionStatus(admin, order, {
    from,
    to: "on-hold",
    onHoldReason: HOLD_REASON,
    changedBy: "Credit review",
    source: SOURCES.creditReview,
    note: "Placed from a cart quote by a company whose orders are reviewed. Held until Hyve approves it in Credit Review.",
  });

  const alert = await sendCreditReviewAlert(admin, { ...order, tags: [...(order.tags || []), CREDIT_HOLD_TAG] }).catch((error) => ({
    sent: false,
    reason: error?.message || String(error),
  }));
  console.log("[credit-review] held", order.name, alert.sent ? `alert sent to ${alert.to.join(", ")}` : `no alert: ${alert.reason}`);
  return { held: true };
}

async function approveHeldOrder(admin, orderGid) {
  const order = await loadHeldOrder(admin, orderGid);
  if (!heldForReview(order)) return { ok: false, error: "This order is no longer waiting for a credit review." };
  const to = await releaseStatus(admin, orderGid);
  const from = productionStatusOf(order);
  // Still On Hold, or released already by an approval whose tag removal
  // failed: then only the tag is left to take off.
  if (from === "on-hold") {
    await writeProductionStatus(admin, order, {
      from,
      to,
      changedBy: "Credit review",
      source: SOURCES.creditReview,
      note: "Credit approved in Hyve Custom.",
    });
  } else if (from !== to) {
    return { ok: false, error: "This order is no longer waiting for a credit review." };
  }
  await changeTags(admin, orderGid, { remove: [CREDIT_HOLD_TAG] });
  // The buyer had Shopify's order confirmation at checkout.
  return { ok: true, orderName: order.name, released: true, releasedTo: to === "ready-for-collection" ? "Ready For Collection" : "Order Received" };
}

async function declineHeldOrder(admin, orderGid, why) {
  const order = await loadHeldOrder(admin, orderGid);
  if (!heldForReview(order)) return { ok: false, error: "This order is no longer waiting for a credit review." };

  const cancelled = (await run(admin, CANCEL, { orderId: orderGid, staffNote: `Credit not approved: ${why}`.slice(0, 255) }))
    ?.orderCancel;
  const cancelError = cancelled?.orderCancelUserErrors?.[0]?.message;
  if (cancelError) return { ok: false, error: `Shopify couldn't cancel the order: ${cancelError}` };

  // Cancelled now, so the rest is done even if one step fails: the buyer is
  // still told, and staff see what didn't save.
  const problems = [];
  try {
    await writeProductionStatus(admin, order, {
      from: productionStatusOf(order),
      to: "on-hold",
      // The reason is kept on one line, as the field allows.
      onHoldReason: oneLine(`Not approved on payment terms: ${why}`),
      changedBy: "Credit review",
      source: SOURCES.creditReview,
      note: `Credit declined and the order cancelled. Reason: ${why}`,
    });
  } catch (error) {
    problems.push(`reason not saved (${error?.message || error})`);
  }
  try {
    // Off the Production Orders On Hold tab: it's cancelled, not waiting.
    await changeTags(admin, orderGid, { add: [CREDIT_DECLINED_TAG], remove: [CREDIT_HOLD_TAG, "hyve-status:on-hold"] });
  } catch (error) {
    problems.push(`tags not updated (${error?.message || error})`);
  }

  const row = reviewRow(order);
  const emailed = await emailDecline(row, why);
  if (problems.length) console.error("[credit-review] decline after cancel", order.name, problems.join("; "));
  return { ok: true, emailed, warning: problems.length ? `Cancelled, but ${problems.join(" and ")}.` : "" };
}

export async function loadReviewDraft(admin, draftGid) {
  return (await run(admin, DRAFT_QUERY, { id: draftGid }))?.draftOrder || null;
}

async function emailBuyer(row, { title, subject, body, details }) {
  if (!row.buyerEmail) return false;
  try {
    const { sendEmail } = await import("./mailer.server");
    const { brandedEmail, escapeHtml, CUSTOMER_ORDERS_URL } = await import("../utils/email.server");
    await sendEmail({
      to: row.buyerEmail,
      subject,
      html: brandedEmail({
        title,
        greeting: `Hi ${escapeHtml(row.buyer || row.company || "there")},`,
        body: `<p style="margin:0 0 14px; line-height:1.7; font-size:15px;">${body}</p>`,
        details: details.map(([label, value]) => [label, escapeHtml(value)]),
        detailsAction: `<div style="margin-top:20px;"><a href="${escapeHtml(CUSTOMER_ORDERS_URL)}" style="display:inline-block; padding:12px 22px; background:#0f172a; color:#ffffff !important; text-decoration:none; border-radius:10px; font-size:14px; font-weight:700;">View your orders</a></div>`,
      }),
    });
    return true;
  } catch (error) {
    console.error("[credit-review] buyer email failed", row.name, error?.message || error);
    return false;
  }
}

/**
 * Creates the order from the draft. Shopify sends the buyer its order
 * confirmation.
 * @returns {Promise<{ok:boolean, error?:string, orderName?:string}>}
 */
export async function approveCreditReview(admin, draftGid) {
  if (isOrder(draftGid)) return approveHeldOrder(admin, draftGid);
  const draft = await loadReviewDraft(admin, draftGid);
  if (!waitingForReview(draft)) return { ok: false, error: "This order is no longer waiting for a credit review." };

  const result = (await run(admin, COMPLETE, { id: draftGid }))?.draftOrderComplete;
  const error = result?.userErrors?.[0]?.message;
  if (error) return { ok: false, error };
  const order = result?.draftOrder?.order;
  if (!order) return { ok: false, error: "Shopify didn't create the order." };

  // Shopify emails the buyer its own order confirmation when the order is
  // created, so no second email goes from here (#1096 got both).
  return { ok: true, orderName: order.name };
}

/**
 * Declines the order with a reason and tells the buyer. The draft stays, so
 * the buyer's Orders can show why.
 * @returns {Promise<{ok:boolean, error?:string, emailed?:boolean}>}
 */
export async function declineCreditReview(admin, draftGid, reason) {
  const why = String(reason || "").trim();
  if (!why) return { ok: false, error: "Enter a reason for declining." };

  if (isOrder(draftGid)) return declineHeldOrder(admin, draftGid, why);

  const draft = await loadReviewDraft(admin, draftGid);
  if (!waitingForReview(draft)) return { ok: false, error: "This order is no longer waiting for a credit review." };

  const data = await run(admin, DECLINE, {
    id: draftGid,
    tags: [CREDIT_DECLINED_TAG],
    metafields: [{ ownerId: draftGid, namespace: "$app", key: REASON_KEY, type: "multi_line_text_field", value: why }],
  });
  const error = data?.tagsAdd?.userErrors?.[0]?.message || data?.metafieldsSet?.userErrors?.[0]?.message;
  if (error) return { ok: false, error };

  const emailed = await emailDecline(reviewRow(draft), why);
  return { ok: true, emailed };
}

/** The buyer's "not approved" email, with the reason. */
async function emailDecline(row, why) {
  const { escapeHtml } = await import("../utils/email.server");
  return emailBuyer(row, {
    title: "Order Not Approved",
    subject: `Your order${row.buyerReference ? ` ${row.buyerReference}` : ""} was not approved`,
    body: `We couldn't approve your order on ${escapeHtml(row.terms || "payment terms")}${
      row.kind === "order" ? ", so it has been cancelled" : ""
    }.<br /><br /><strong>Reason:</strong> ${escapeHtml(why).replace(/\n/g, "<br />")}<br /><br />Please contact your account manager${row.salesRepEmail ? ` at ${escapeHtml(row.salesRepEmail)}` : ""} to arrange another way to pay.`,
    details: [
      ...(row.kind === "order" ? [["Order", row.name]] : []),
      ["Submitted", formatDate(row.submittedAt) || "—"],
      ["Total", row.total],
      ["PO number", row.poNumber || "—"],
    ],
  });
}

/** How far back the safety net looks: older drafts were in the queue already. */
const MISSED_ALERT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * The safety net for the alert, run by the 15-minute SLA job: any order in
 * review from the last two days that hasn't been alerted on yet. The draft
 * webhook alerts within a minute when it can; this covers the rest, so an
 * alert is at most one run late.
 * @returns {Promise<{sent:number, errors:string[]}>}
 */
export async function sendMissedCreditReviewAlerts(admin) {
  const since = Date.now() - MISSED_ALERT_WINDOW_MS;
  const nodes = [];
  let after = null;
  for (let page = 0; page < QUEUE_PAGES; page += 1) {
    const block = (await run(admin, QUEUE_QUERY, { after }))?.draftOrders;
    nodes.push(...(block?.nodes || []));
    if (!block?.pageInfo?.hasNextPage) break;
    after = block.pageInfo.endCursor;
  }
  const missed = nodes.filter(
    (node) =>
      waitingForReview(node) &&
      !(node.tags || []).includes(NOTIFIED_TAG) &&
      new Date(node.createdAt).getTime() >= since &&
      // Under two minutes old, the webhook is still on it.
      new Date(node.createdAt).getTime() <= Date.now() - 2 * 60 * 1000,
  );
  const result = { sent: 0, errors: [] };
  for (const node of missed) {
    try {
      const sent = await notifyCreditReview(admin, node.id, { wait: false });
      if (sent.sent) result.sent += 1;
      else console.log("[credit-review] safety net: no alert", node.name, sent.reason);
    } catch (error) {
      result.errors.push(`${node.name}: ${error?.message || error}`);
    }
  }
  // Orders held from a quote link: their alert goes from orders/create, once.
  const held = ((await run(admin, HELD_ORDERS_QUERY))?.orders?.nodes || []).filter(
    (node) =>
      heldForReview(node) &&
      !(node.tags || []).includes(NOTIFIED_TAG) &&
      new Date(node.createdAt).getTime() >= since &&
      new Date(node.createdAt).getTime() <= Date.now() - 2 * 60 * 1000,
  );
  for (const node of held) {
    try {
      const sent = await sendCreditReviewAlert(admin, node);
      if (sent.sent) result.sent += 1;
      else console.log("[credit-review] safety net: no alert", node.name, sent.reason);
    } catch (error) {
      result.errors.push(`${node.name}: ${error?.message || error}`);
    }
  }
  return result;
}

/**
 * Tells Hyve an order is waiting: the Credit Review recipients and the
 * company's sales rep, or the store's address when neither is set.
 */
export async function notifyCreditReview(admin, draftGid, { wait = true } = {}) {
  let draft = await loadReviewDraft(admin, draftGid);
  // Who made a draft is read from its "created" event, which may not be
  // readable the moment the webhook arrives: up to about a minute is allowed.
  // The safety net doesn't wait: Flow gives the cron 30 seconds.
  for (const pause of wait ? [5000, 15000, 40000] : []) {
    if (!draft || draft.createdEvent?.nodes?.length) break;
    await new Promise((resolve) => setTimeout(resolve, pause));
    draft = await loadReviewDraft(admin, draftGid);
  }
  if (!draft) return { sent: false, reason: "draft not found" };
  if (!draft.createdEvent?.nodes?.length) return { sent: false, reason: "no created event after a minute" };
  if (!waitingForReview(draft)) return { sent: false, reason: "not a credit review order" };
  return sendCreditReviewAlert(admin, draft);
}

/**
 * The alert itself, for a review draft or a held order: the Credit Review
 * recipients and the company's sales rep, or the store's address when
 * neither is set. Marked on the record so it goes once.
 */
async function sendCreditReviewAlert(admin, node) {
  if ((node.tags || []).includes(NOTIFIED_TAG)) return { sent: false, reason: "already sent" };
  const row = reviewRow(node);
  const draftGid = node.id;

  const { getNotificationRecipients } = await import("../utils/metaobjects/notification-recipients.server");
  const recipients = await getNotificationRecipients(admin).catch((error) => {
    console.warn("[credit-review] recipients failed", error?.message || error);
    return [];
  });
  const to = new Set(
    recipients
      .filter((r) => r.enabled && r.role === CREDIT_REVIEW_ROLE && r.email.trim())
      .map((r) => r.email.trim().toLowerCase()),
  );
  if (row.salesRepEmail.trim()) to.add(row.salesRepEmail.trim().toLowerCase());
  let shopName = "Hyve Promo";
  if (!to.size) {
    const { internalNotifyTarget } = await import("./internal-notify.server");
    const target = await internalNotifyTarget(admin);
    shopName = target.shopName;
    if (target.to) to.add(target.to);
  }
  if (!to.size) return { sent: false, reason: "no recipient" };

  // Marked before sending, so a retried webhook arriving meanwhile doesn't
  // send it again.
  const tagged = await run(admin, `#graphql
    mutation CreditReviewNotified($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
    }`, { id: draftGid, tags: [NOTIFIED_TAG] }).catch((error) => ({ error }));
  // Not marked, not sent: the 15-minute safety net would otherwise send it
  // again on every run. It tries again next run.
  if (tagged?.error || tagged?.tagsAdd?.userErrors?.length) {
    console.warn("[credit-review] notified tag not set", draftGid, tagged?.error?.message || JSON.stringify(tagged?.tagsAdd?.userErrors));
    return { sent: false, reason: "couldn't mark it as alerted; retried next run" };
  }
  const { sendEmail } = await import("./mailer.server");
  const { brandedEmail, escapeHtml } = await import("../utils/email.server");
  try {
    await sendEmail({
    to: [...to].join(","),
    subject: `Credit review: ${row.name} — ${row.company || row.buyer || "a distributor"}`,
    html: brandedEmail({
      title: "Order Waiting For Credit Review",
      body: `<p style="margin:0 0 14px; line-height:1.7; font-size:15px;"><strong>${escapeHtml(row.company || row.buyer)}</strong> ${
        row.kind === "order"
          ? `placed order <strong>${escapeHtml(row.name)}</strong> from a quote on ${escapeHtml(row.terms || "payment terms")}. It's on hold until approved.`
          : `submitted order <strong>${escapeHtml(row.name)}</strong> on ${escapeHtml(row.terms || "payment terms")}.`
      } Approve or decline it in ${escapeHtml(shopName)} admin → Apps → Hyve Custom → Credit Review.</p>`,
      details: [
        ["Order", escapeHtml(row.name)],
        ["Company", escapeHtml(row.company || "—")],
        ["Buyer", escapeHtml([row.buyer, row.buyerEmail].filter(Boolean).join(" · ") || "—")],
        ["Total", escapeHtml(row.total || "—")],
        ["Payment terms", escapeHtml(row.terms || "—")],
        ["PO number", escapeHtml(row.poNumber || "—")],
        ["Items", escapeHtml(row.items || "—")],
      ],
    }),
    });
  } catch (error) {
    // Unmarked, so the next safety-net run sends it.
    await run(admin, TAGS_REMOVE, { id: draftGid, tags: [NOTIFIED_TAG] }).catch(() => {});
    throw error;
  }
  return { sent: true, to: [...to] };
}
