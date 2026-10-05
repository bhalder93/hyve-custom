// app/routes/webhooks.orders.paid.jsx

import { authenticate } from "../shopify.server";
import { loadInvoiceDocument } from "../lib/invoice-document.server";
import { sendInvoiceEmail } from "../utils/email.server";

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
    const orderGid = payload?.admin_graphql_api_id;
    const email = payload?.email || payload?.contact_email || payload?.customer?.email || "";
    const tags = String(payload?.tags || "")
      .split(",")
      .map((tag) => tag.trim());
    if (!admin || !orderGid || !email || tags.includes(INVOICE_SENT_TAG)) {
      return new Response(null, { status: 200 });
    }

    const doc = await loadInvoiceDocument(admin, orderGid, { system: true });
    if (!doc) {
      console.warn("[orders/paid] no invoice document", { shop, orderGid });
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

    const tagged = await admin.graphql(
      `#graphql
      mutation InvoiceSent($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
      }`,
      { variables: { id: orderGid, tags: [INVOICE_SENT_TAG] } },
    );
    const errors = (await tagged.json())?.data?.tagsAdd?.userErrors;
    if (errors?.length) console.warn("[orders/paid] invoice tag not saved", { orderGid, errors });

    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("[orders/paid] invoice email failed", { shop, error: error?.message || error });
    return new Response(null, { status: 200 });
  }
}
