import { authenticate } from "../shopify.server";
import { loadQuoteDocument } from "../lib/quote-document.server";

/**
 * The quotation PDF for any draft order, for staff signed in to the Hyve
 * Custom app (HYV-116): the same document the buyer downloads, generated in
 * one action from the quote page. Requested with App Bridge's fetch, which
 * carries the session.
 */
export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = String(params?.id || "").replace(/\D/g, "");
  if (!id) return new Response("Draft order ID is required.", { status: 400 });

  const doc = await loadQuoteDocument(admin, `gid://shopify/DraftOrder/${id}`, { staff: true });
  if (!doc) return new Response("Quote not found.", { status: 404 });

  const { buildQuotePdf } = await import("../lib/quote-pdf.server.jsx");
  const pdf = await buildQuotePdf(doc);
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Quotation-${doc.ref}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
};
