// app/routes/webhooks.orders.paid.jsx

import { authenticate } from "../shopify.server";
import { loadInvoiceDocument } from "../lib/invoice-document.server";
import { sendInvoiceEmail } from "../utils/email.server";
import { checkAndAddFobShippingIfStorefrontQuote } from "../lib/order-fob-shipping.server";
import { orderLocationGid, refreshLocationCredit } from "../lib/credit-check.server";
import { releaseWhenPaid } from "../lib/deposit.server";

/** On an order once its invoice has gone out, so a retried webhook can't send it twice. */
const INVOICE_SENT_TAG = "hyve-notified:invoice";

/**
 * Emails the buyer their invoice PDF once the order is paid (HYV-144).
 * Shopify's order confirmation can't carry an attachment, and companies need
 * the invoice for their books. The same PDF is on the order in their account.
 *
 * Always answers 200 once Shopify is verified: a retry after the email went out
 * would only send it again, so a failure is logged instead.
 */
export async function action({ request }) {
  const { admin, payload, shop } = await authenticate.webhook(request);

  try {
    // A payment frees that much of the company's credit, and may clear an
    // overdue balance (HYV-198).
    const creditLocation = admin ? orderLocationGid(payload) : null;
    if (creditLocation) {
      await refreshLocationCredit(admin, creditLocation).catch((error) =>
        console.error("[orders/paid] credit refresh failed", payload?.name, error?.message || error),
      );
    }

    const orderGid = payload?.admin_graphql_api_id;
    // A deposit order fully paid can now be shipped (HYV-150).
    if (admin && orderGid) {
      await releaseWhenPaid(admin, orderGid).catch((error) =>
        console.error("[orders/paid] fulfilment hold not released", payload?.name, error?.message || error),
      );
    }
    const email = payload?.email || payload?.contact_email || payload?.customer?.email || "";
    if (!admin || !orderGid || !email) {
      return new Response(null, { status: 200 });
    }

    // Claimed on the order itself before anything is sent. Building the PDF
    // can outlast Shopify's wait, and its retry carries the payload as it was,
    // without the tag: checking that copy sent #1122's invoice twice.
    if (!(await claimInvoice(admin, orderGid))) {
      return new Response(null, { status: 200 });
    }

    try {
      await checkAndAddFobShippingIfStorefrontQuote(admin, {
        payload,
        orderId: orderGid,
      });
    } catch (fobErr) {
      console.warn("[orders/paid] checkAndAddFobShippingIfStorefrontQuote warning:", fobErr);
    }

    const doc = await loadInvoiceDocument(admin, orderGid, { system: true });
    if (!doc) {
      console.warn("[orders/paid] no invoice document", { shop, orderGid });
      await releaseInvoiceClaim(admin, orderGid);
      return new Response(null, { status: 200 });
    }

    const { buildInvoicePdf } = await import("../lib/invoice-pdf.server.jsx");
    const pdf = await buildInvoicePdf(doc);
    const customer = payload?.customer || {};
    await sendInvoiceEmail({
      customerEmail: email,
      customerName: [customer.first_name, customer.last_name].filter(Boolean).join(" ") || payload?.billing_address?.name || "",
      orderName: payload?.name || doc.reference,
      orderDate: payload?.created_at,
      pdf,
      filename: `invoice-${String(doc.reference).replace(/[^A-Za-z0-9._-]/g, "")}.pdf`,
    });

    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("[orders/paid] invoice email failed", { shop, error: error?.message || error });
    // Not sent, so a later delivery may try again.
    if (admin && payload?.admin_graphql_api_id) await releaseInvoiceClaim(admin, payload.admin_graphql_api_id);
    return new Response(null, { status: 200 });
  }
}

const ORDER_TAGS = `#graphql
  query InvoiceClaimTags($id: ID!) { order(id: $id) { tags } }`;

const TAGS_ADD = `#graphql
  mutation InvoiceSent($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;

const TAGS_REMOVE = `#graphql
  mutation InvoiceNotSent($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;

/** True when this delivery may send the invoice: the order isn't tagged yet, and now is. */
async function claimInvoice(admin, orderGid) {
  const tags = (await (await admin.graphql(ORDER_TAGS, { variables: { id: orderGid } })).json())?.data?.order?.tags || [];
  if (tags.includes(INVOICE_SENT_TAG)) return false;
  const errors = (await (await admin.graphql(TAGS_ADD, { variables: { id: orderGid, tags: [INVOICE_SENT_TAG] } })).json())?.data
    ?.tagsAdd?.userErrors;
  if (errors?.length) {
    console.warn("[orders/paid] invoice tag not saved, invoice not sent", { orderGid, errors });
    return false;
  }
  return true;
}

async function releaseInvoiceClaim(admin, orderGid) {
  try {
    await admin.graphql(TAGS_REMOVE, { variables: { id: orderGid, tags: [INVOICE_SENT_TAG] } });
  } catch (error) {
    console.error("[orders/paid] invoice tag not removed", orderGid, error?.message || error);
  }
}
