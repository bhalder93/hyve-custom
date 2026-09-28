/**
 * A reminder before a quote expires (HYV-110, NTF-02).
 *
 * A quote is an open draft order, valid until the day its PDF prints
 * (quoteValidUntil); the scheduled Flow withdraws it after that
 * (expired-quotes.server.js). REMINDER_DAYS_BEFORE ahead of that day the buyer
 * gets one email with the link to review and order it. Each quote is tagged
 * once reminded, so the 15-minute SLA run that calls this never sends a second
 * one.
 *
 * Only a quote the buyer can order is reminded: not one Hyve declined, and not
 * a portal request still waiting for staff to price it.
 */
import { QUOTE_VALID_DAYS, quoteEmails, QUOTE_OWNER_FIELDS, quoteReference, quoteValidUntil } from "./quote-document.server";
import { DRAFT_ORIGIN_FIELDS, QUOTE_STATUSES, quoteStatus, submittedForReview } from "./account-quotes.server";

const REMINDER_DAYS_BEFORE = 3;
const REMINDED_TAG = "hyve-notified:quote-expiry";
/** Set on a portal quote request until staff price and approve it (proxy.quotes). */
const DAY_MS = 24 * 60 * 60 * 1000;

const QUOTES_QUERY = `#graphql
  query QuotesNearExpiry($query: String!) {
    draftOrders(first: 50, query: $query) {
      nodes {
        id
        name
        createdAt
        status
        tags
        invoiceSentAt
        invoiceUrl
        email
        hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
        ${QUOTE_OWNER_FIELDS}
        ${DRAFT_ORIGIN_FIELDS}
        customer { firstName }
        totalPriceSet { presentmentMoney { amount currencyCode } }
      }
    }
  }`;

const TAG_QUOTE = `#graphql
  mutation QuoteReminded($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { message } }
  }`;

/**
 * @param {{now?:Date, dryRun?:boolean}} [options] dryRun finds the quotes but
 *   neither emails nor tags them.
 * @returns {Promise<{checked:number, sent:number, errors:string[], due:string[]}>}
 */
export async function sendQuoteExpiryReminders(admin, { now = new Date(), dryRun = false } = {}) {
  const result = { checked: 0, sent: 0, errors: [], due: [] };

  // Open quotes raised inside the reminder window; older ones are withdrawn.
  const windowStart = new Date(now.getTime() - QUOTE_VALID_DAYS * DAY_MS);
  const response = await admin.graphql(QUOTES_QUERY, {
    variables: { query: `status:open created_at:>='${windowStart.toISOString()}'` },
  });
  const body = await response.json();
  if (body?.errors?.length) throw new Error(body.errors[0]?.message || "Quote lookup failed.");

  const { sendEmail } = await import("./mailer.server");
  const { brandedEmail, escapeHtml } = await import("../utils/email.server");

  for (const draft of body?.data?.draftOrders?.nodes || []) {
    result.checked += 1;
    const { at: expires, label: validUntil } = quoteValidUntil(draft.createdAt);
    const daysLeft = (expires.getTime() - now.getTime()) / DAY_MS;
    if (draft.status !== "OPEN" || daysLeft <= 0 || daysLeft > REMINDER_DAYS_BEFORE) continue;
    const tags = draft.tags || [];
    if (tags.includes(REMINDED_TAG)) continue;
    // Only a quote that is with the buyer: not one declined, one sales hasn't
    // sent, a request Hyve is still pricing, or a terms order waiting on its
    // credit review, which is an order and has no expiry (HYV-99).
    if (quoteStatus(draft) !== QUOTE_STATUSES.SENT || submittedForReview(draft)) continue;

    const to = quoteEmails(draft)[0];
    if (!to || !draft.invoiceUrl) continue;

    const ref = quoteReference(draft.name);
    result.due.push(ref);
    if (dryRun) continue;

    try {
      const money = draft.totalPriceSet?.presentmentMoney;
      const total = money ? `${money.currencyCode} ${Number(money.amount).toFixed(2)}` : "";
      const firstName = draft.customer?.firstName || "";
      await sendEmail({
        to,
        subject: `Your quote ${ref} expires on ${validUntil}`,
        text: [
          firstName ? `Hi ${firstName},` : "Hi,",
          "",
          `Your quote ${ref}${total ? ` (${total})` : ""} expires on ${validUntil}.`,
          "Confirm your order before then to keep these prices:",
          draft.invoiceUrl,
        ].join("\n"),
        html: brandedEmail({
          title: "Your quote expires soon",
          greeting: firstName ? `Hi ${escapeHtml(firstName)},` : "Hi,",
          body: `
            <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
              Your quote <strong>${escapeHtml(ref)}</strong> expires on <strong>${escapeHtml(validUntil)}</strong>.
              Confirm your order before then to keep these prices. After that, ask us and we'll price it again.
            </p>
            <div style="margin:22px 0;">
              <a href="${escapeHtml(draft.invoiceUrl)}" style="display:inline-block; padding:14px 22px; background:#0f172a; color:#ffffff; text-decoration:none; border-radius:10px; font-size:14px; font-weight:700;">
                Confirm Order
              </a>
            </div>`,
          details: [
            ["Quote", escapeHtml(ref)],
            ...(total ? [["Total", escapeHtml(total)]] : []),
            ["Valid until", escapeHtml(validUntil)],
          ],
        }),
      });
      await admin.graphql(TAG_QUOTE, { variables: { id: draft.id, tags: [REMINDED_TAG] } });
      result.sent += 1;
    } catch (error) {
      result.errors.push(`${ref}: ${error?.message || error}`);
    }
  }
  return result;
}
