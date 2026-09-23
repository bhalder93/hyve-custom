import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { loadQuoteDocument } from "../lib/quote-document.server";

/**
 * Quote PDF download.
 * Storefront: /apps/account/quotes/pdf?draft=<gid>
 *
 * The same renderer the cart's "Download PDF" uses, fed from the draft order
 * instead of from the page. `loadQuoteDocument` refuses a draft order that
 * belongs to another customer.
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const draftGid = url.searchParams.get("draft");

    if (!customerId) return redirectToQuotes();
    if (!draftGid || !draftGid.startsWith("gid://shopify/DraftOrder/")) {
      return new Response("Quote not found.", { status: 404 });
    }

    const chrome = await portalChrome(admin, customerId);
    if (!chrome.isDistributor) return redirectToQuotes();

    const doc = await loadQuoteDocument(admin, draftGid, {
      customerGid: `gid://shopify/Customer/${customerId}`,
    });
    if (!doc) return new Response("Quote not found.", { status: 404 });

    const { buildQuotePdf } = await import("../lib/quote-pdf.server.jsx");
    const pdf = await buildQuotePdf(doc);
    const filename = `${String(doc.ref).replace(/[^A-Za-z0-9._-]/g, "")}.pdf`;

    return new Response(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] quote download failed", error);
    return new Response("We couldn't build that quote. Please try again later.", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
};

function redirectToQuotes() {
  return new Response(null, { status: 302, headers: { Location: "/apps/account/quotes" } });
}
