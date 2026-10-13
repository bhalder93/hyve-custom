import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { loadProformaDocument } from "../lib/proforma-document.server";

/**
 * Proforma invoice download for the buyer (HYV-118).
 * Storefront: /apps/account/orders/proforma?order=<gid>
 *
 * Only once staff have issued it in Hyve Custom, which gives it its number
 * and its terms of sale; the buyer gets the same document, never a new
 * number. Only for an order on the buyer's own company.
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const orderGid = url.searchParams.get("order");
    if (!customerId) return backToOrders();
    if (!orderGid || !orderGid.startsWith("gid://shopify/Order/")) {
      return new Response("Proforma invoice not found.", { status: 404 });
    }

    const chrome = await portalChrome(admin, customerId);
    const doc = await loadProformaDocument(admin, orderGid, {
      customerGid: `gid://shopify/Customer/${customerId}`,
      locationGids: chrome.terms?.locationIds || [],
    });
    if (!doc || !doc.reference || doc.missing.length) {
      return new Response("Proforma invoice not found.", { status: 404 });
    }

    const { buildProformaPdf } = await import("../lib/proforma-pdf.server.jsx");
    const pdf = await buildProformaPdf(doc);
    const filename = `Proforma-${String(doc.reference).replace(/[^A-Za-z0-9._-]/g, "")}.pdf`;
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
    console.error("[portal] proforma download failed", error);
    return new Response("We couldn't build that document. Please try again later.", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
};

function backToOrders() {
  return new Response(null, { status: 302, headers: { Location: "/apps/account/orders" } });
}
