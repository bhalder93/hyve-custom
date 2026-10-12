import { loadQuoteDocument, quoteEmails } from "./quote-document.server";

/**
 * Emails a staff quote from Hyve Custom (HYV-166, HYV-161).
 *
 * Shopify's own draft order email is an invoice: it can't carry the quote
 * PDF, calls itself an invoice, shows "$4,580.00" with no currency, and its
 * "Send invoice" button can't be renamed. This sends ours instead: titled
 * Quotation, the PDF attached, the validity date the PDF prints, every amount
 * with its currency code, and a button to view and confirm it.
 *
 * Sending it tags the draft `quote-sent`, so the quote reads Sent on the
 * dashboard, the Quotes page and in the buyer's portal (quoteStatus).
 */

export const QUOTE_SENT_TAG = "quote-sent";

const RECIPIENT_QUERY = `#graphql
  query StaffQuoteRecipient($id: ID!) {
    draftOrder(id: $id) {
      id
      email
      invoiceUrl
      tags
      customer { id defaultEmailAddress { emailAddress } }
      purchasingEntity {
        ... on PurchasingCompany {
          company { id }
          contact { customer { defaultEmailAddress { emailAddress } } }
        }
      }
    }
  }`;

/**
 * Terms that let the buyer confirm without paying now: Net terms and payment
 * on fulfilment. "Due on receipt" and upfront terms are paid when confirmed.
 */
function payLater(terms) {
  return /\bnet\b|fulfil/i.test(String(terms || ""));
}

/** "HKD 4,580.00": the code first, like every other price (HYV-143). */
function money(cents, currency) {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat("en-SG", { style: "currency", currency, currencyDisplay: "code" }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/**
 * @param {string} draftGid
 * @param {{to?: string}} [options] an address other than the buyer's on file
 * @returns {Promise<{ok: true, to: string} | {ok: false, error: string}>}
 */
export async function emailStaffQuote(admin, draftGid, options = {}) {
  const response = await admin.graphql(RECIPIENT_QUERY, { variables: { id: draftGid } });
  const draft = (await response.json())?.data?.draftOrder;
  if (!draft) return { ok: false, error: "This quote couldn't be found." };

  // The draft's own email, then the customer's, then the company contact's
  // (a company quote carries no email of its own).
  const to = String(options.to || "").trim() || quoteEmails(draft)[0] || "";
  if (!to) {
    return { ok: false, error: "This quote has no buyer email. Add a customer or company contact to the draft first." };
  }
  if (!draft.invoiceUrl) return { ok: false, error: "This quote has no checkout link yet. Save it in Shopify first." };

  // Emailing a buyer's request is Hyve sending its price, so the quote is
  // released for checkout first; otherwise the link in this email would be
  // refused as still waiting for approval (quote-hold).
  const { setQuoteHold } = await import("./quote-hold.server");
  const holdError = await setQuoteHold(admin, draftGid, false);
  if (holdError) return { ok: false, error: holdError };

  const doc = await loadQuoteDocument(admin, draftGid, { staff: true });
  if (!doc) return { ok: false, error: "The quotation couldn't be built." };

  let pdf = null;
  try {
    const { buildQuotePdf } = await import("./quote-pdf.server.jsx");
    pdf = await buildQuotePdf(doc);
  } catch (error) {
    console.error("[staff-quote-email] PDF failed", error?.message || error);
    return { ok: false, error: "The quotation PDF couldn't be built, so nothing was sent." };
  }

  const shopName = doc.shopName || "Hyve Promo";
  const total = money(doc.grandTotal, doc.currency);
  const { brandedEmail, escapeHtml } = await import("../utils/email.server");
  const paragraph = 'style="margin:0 0 14px; line-height:1.7; font-size:15px;"';

  const html = brandedEmail({
    title: `Quotation ${doc.ref}`,
    body: `
      <p ${paragraph}>
        Thank you for your enquiry. Your quotation <strong>${escapeHtml(doc.ref)}</strong> is attached as a PDF,
        and is valid until <strong>${escapeHtml(doc.validStr)}</strong>.
      </p>
      <p ${paragraph}>
        When you're ready, review and confirm it with the button below.
        ${payLater(doc.paymentTerms) ? `Your ${escapeHtml(doc.paymentTerms)} terms apply, so no payment is taken now.` : ""}
      </p>
      <div style="margin:22px 0;">
        <a href="${escapeHtml(draft.invoiceUrl)}" style="display:inline-block; padding:14px 22px; background:#0f172a; color:#ffffff; text-decoration:none; border-radius:10px; font-size:14px; font-weight:700;">
          Review and confirm quotation
        </a>
      </div>
      <p style="margin:0; font-size:12px; line-height:1.6; color:#6B7280;">
        If the button doesn't work, copy this link:<br>
        <a href="${escapeHtml(draft.invoiceUrl)}" style="color:#0f766e;">${escapeHtml(draft.invoiceUrl)}</a>
      </p>`,
    details: [
      ["Quotation", escapeHtml(doc.ref)],
      ["Total", escapeHtml(total)],
      ["Valid until", escapeHtml(doc.validStr)],
      ...(doc.paymentTerms ? [["Payment terms", escapeHtml(doc.paymentTerms)]] : []),
      ...(doc.incoterm ? [["Incoterm", escapeHtml(doc.incoterm)]] : []),
      ...(doc.accountManager ? [["Account manager", escapeHtml(doc.accountManager)]] : []),
    ],
  });

  const text = [
    `Quotation ${doc.ref} from ${shopName}`,
    "",
    `Total: ${total}`,
    `Valid until: ${doc.validStr}`,
    doc.paymentTerms ? `Payment terms: ${doc.paymentTerms}` : "",
    doc.incoterm ? `Incoterm: ${doc.incoterm}` : "",
    "",
    "The quotation PDF is attached.",
    `Review and confirm it here: ${draft.invoiceUrl}`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");

  try {
    const { sendQuoteEmail } = await import("./mailer.server.js");
    await sendQuoteEmail({
      to,
      subject: `Quotation ${doc.ref} from ${shopName}`,
      html,
      text,
      pdfBuffer: pdf,
      filename: `Quotation-${String(doc.ref).replace(/[^A-Za-z0-9._-]/g, "")}.pdf`,
    });
  } catch (error) {
    console.error("[staff-quote-email] send failed", error?.message || error);
    return { ok: false, error: `The email couldn't be sent: ${error?.message || "unknown error"}` };
  }

  // Emailing a buyer's request is Hyve's approval of it, so the decision is
  // recorded too: otherwise the quote page still offered Approve / Decline
  // for a quote the buyer already had.
  if ((draft.tags || []).includes("awaiting_review")) {
    try {
      const approved = await admin.graphql(
        `#graphql
        mutation ApproveEmailedRequest($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
        {
          variables: {
            metafields: [{ ownerId: draftGid, namespace: "$app", key: "hyve_status", type: "boolean", value: "true" }],
          },
        },
      );
      const errors = (await approved.json())?.data?.metafieldsSet?.userErrors || [];
      if (errors.length) console.warn("[staff-quote-email] couldn't record the approval", JSON.stringify(errors));
    } catch (error) {
      console.warn("[staff-quote-email] couldn't record the approval", error?.message || error);
    }
  }

  // Sent, so it reads Sent everywhere. A failed tag doesn't undo the email.
  try {
    const tagged = await admin.graphql(
      `#graphql
      mutation MarkQuoteSent($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
      }`,
      { variables: { id: draftGid, tags: [QUOTE_SENT_TAG] } },
    );
    const errors = (await tagged.json())?.data?.tagsAdd?.userErrors || [];
    if (errors.length) console.warn("[staff-quote-email] couldn't tag the quote as sent", JSON.stringify(errors));
  } catch (error) {
    console.warn("[staff-quote-email] couldn't tag the quote as sent", error?.message || error);
  }

  return { ok: true, to };
}
