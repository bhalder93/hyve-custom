import { authenticate } from "../shopify.server";
import { loadInvoiceDocument } from "../lib/invoice-document.server";
import { buildInvoicePdf } from "../lib/invoice-pdf.server.jsx";

/**
 * The commercial invoice PDF for an order: the products and quantities,
 * pricing, terms, forwarder details, and billing information for staff.
 * Requested with App Bridge's fetch, which carries the admin session.
 */
export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = String(params?.orderId || "").replace(/\D/g, "");
  if (!id) return new Response("Order ID is required.", { status: 400 });
  const orderGid = `gid://shopify/Order/${id}`;

  const doc = await loadInvoiceDocument(admin, orderGid, { system: true });
  if (!doc) return new Response("Order not found.", { status: 404 });

  const pdf = await buildInvoicePdf(doc);
  const reference = String(doc.reference || id).replace(/[^A-Za-z0-9._-]/g, "");

  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Invoice-${reference}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
};

