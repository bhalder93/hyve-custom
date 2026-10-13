import { authenticate } from "../shopify.server";
import { issueProformaNumber, loadProformaDocument } from "../lib/proforma-document.server";

/**
 * The proforma invoice PDF for staff (HYV-118). Issued in one action from the
 * proforma page: the first download gives the order its PI number, later ones
 * reprint it with the same number. Refused with the list of what's missing
 * until the PO number, incoterm, terms of sale and consignee tax ID are in.
 * Requested with App Bridge's fetch, which carries the session.
 */
export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = String(params?.orderId || "").replace(/\D/g, "");
  if (!id) return new Response("Order ID is required.", { status: 400 });
  const orderGid = `gid://shopify/Order/${id}`;

  const doc = await loadProformaDocument(admin, orderGid, { staff: true });
  if (!doc) return new Response("Order not found.", { status: 404 });
  if (doc.missing.length) {
    return Response.json({ missing: doc.missing }, { status: 409 });
  }

  const number = await issueProformaNumber(admin, doc);
  const issued = number === doc.reference ? doc : await loadProformaDocument(admin, orderGid, { staff: true });

  const { buildProformaPdf } = await import("../lib/proforma-pdf.server.jsx");
  const pdf = await buildProformaPdf(issued);
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Proforma-${number}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
};
