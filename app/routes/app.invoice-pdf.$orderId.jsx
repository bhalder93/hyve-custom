import { authenticate } from "../shopify.server";
import { loadInvoiceDocument } from "../lib/invoice-document.server";
import { buildInvoicePdf } from "../lib/invoice-pdf.server.jsx";

/**
 * The commercial invoice PDF for an order: the products and quantities,
 * pricing, terms, forwarder details, and billing information for staff.
 * Requested with App Bridge's fetch from the production order page, which
 * downloads it, and by the Hyve invoice print action under Print on Shopify's
 * own order page (HYV-219), which asks with `?print=1` and shows it to print.
 * The print action is how staff get an invoice for an order without
 * decoration, which never enters Production Orders.
 */
export const loader = async ({ request, params }) => {
  const { admin, cors } = await authenticate.admin(request);
  const id = String(params?.orderId || "").replace(/\D/g, "");
  if (!id) return cors(new Response("Order ID is required.", { status: 400 }));
  const orderGid = `gid://shopify/Order/${id}`;

  const doc = await loadInvoiceDocument(admin, orderGid, { system: true });
  if (!doc) return cors(new Response("Order not found.", { status: 404 }));

  const pdf = await buildInvoicePdf(doc);
  const reference = String(doc.reference || id).replace(/[^A-Za-z0-9._-]/g, "");
  const print = new URL(request.url).searchParams.get("print") === "1";

  return cors(
    new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${print ? "inline" : "attachment"}; filename="Invoice-${reference}.pdf"`,
        "Cache-Control": "no-store",
      },
    }),
  );
};
