import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { loadInvoiceDocument } from "../lib/invoice-document.server";

/**
 * Invoice PDF download.
 * Storefront: /apps/account/invoices/download?order=<gid>
 *
 * Shopify has no invoice PDF of its own, so the document is rendered from the
 * order. `loadInvoiceDocument` refuses any order that isn't the signed-in
 * buyer's, personally or through their company.
 *
 * The filename underscore keeps this off the Invoices page's loader — it
 * returns a PDF, not the portal shell.
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const orderGid = url.searchParams.get("order");

    if (!customerId) return redirectToInvoices();
    if (!orderGid || !orderGid.startsWith("gid://shopify/Order/")) {
      return new Response("Invoice not found.", { status: 404 });
    }

    // Anyone signed in can have the paperwork for their own order; a
    // distributor can also have their company's.
    const chrome = await portalChrome(admin, customerId);
    const doc = await loadInvoiceDocument(admin, orderGid, {
      customerGid: `gid://shopify/Customer/${customerId}`,
      locationGids: chrome.terms?.locationIds || [],
    });
    if (!doc) return new Response("Invoice not found.", { status: 404 });

    const { buildInvoicePdf } = await import("../lib/invoice-pdf.server.jsx");
    const pdf = await buildInvoicePdf(doc);
    const filename = `invoice-${String(doc.reference).replace(/[^A-Za-z0-9._-]/g, "")}.pdf`;

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
    console.error("[portal] invoice download failed", error);
    return new Response("We couldn't build that invoice. Please try again later.", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
};

/** Anyone who shouldn't have the file goes back to the page that offers it. */
function redirectToInvoices() {
  return new Response(null, {
    status: 302,
    headers: { Location: "/apps/account/invoices" },
  });
}
