import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { loadInvoiceDocument } from "../lib/invoice-document.server";

const ORDER_COLLECTION_QUERY = `#graphql
  query OrderCollectionMetafields($id: ID!) {
    order(id: $id) {
      name
      collectionReadyDate: metafield(namespace: "$app", key: "collection_ready_date") { value }
      collectionCartons: metafield(namespace: "$app", key: "collection_cartons") { value }
      collectionGrossWeight: metafield(namespace: "$app", key: "collection_gross_weight") { value }
      collectionCbm: metafield(namespace: "$app", key: "collection_cbm") { value }
    }
  }`;

/**
 * Packing list PDF download for the buyer (HYV-160).
 * Storefront: /apps/account/orders/packing-list?order=<gid>
 *
 * Renders the products, quantities, cartons, gross weight, and CBM for forwarder
 * collection or customer records. Only accessible for orders belonging to the
 * authenticated customer or their company.
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const orderGid = url.searchParams.get("order");

    if (!customerId) return backToOrders();
    if (!orderGid || !orderGid.startsWith("gid://shopify/Order/")) {
      return new Response("Packing list not found.", { status: 404 });
    }

    // Verify access: the signed-in buyer personally or through their company
    const chrome = await portalChrome(admin, customerId);
    const [doc, orderRes] = await Promise.all([
      loadInvoiceDocument(admin, orderGid, {
        customerGid: `gid://shopify/Customer/${customerId}`,
        locationGids: chrome.terms?.locationIds || [],
      }),
      admin
        .graphql(ORDER_COLLECTION_QUERY, { variables: { id: orderGid } })
        .then((res) => res.json())
        .catch((err) => {
          console.warn("[portal] packing list collection metafields query failed:", err?.message || err);
          return null;
        }),
    ]);

    if (!doc) {
      return new Response("Packing list not found.", { status: 404 });
    }

    const orderNode = orderRes?.data?.order;
    const collection = {
      readyDate: orderNode?.collectionReadyDate?.value || "",
      numberOfCartons: orderNode?.collectionCartons?.value || doc.calculatedCartons || "",
      grossWeight: orderNode?.collectionGrossWeight?.value || doc.calculatedGrossWeight || "",
      cbm: orderNode?.collectionCbm?.value || doc.calculatedCbm || "",
      forwarderName: doc.forwarderName || "",
      forwarderAccount: doc.forwarderAccount || "",
      packingWarnings: doc.packingWarnings || [],
      detailedPackingWarnings: doc.detailedPackingWarnings || [],
    };

    const { buildPackingListPdf } = await import("../lib/packing-list-pdf.server.jsx");
    const pdf = await buildPackingListPdf(doc, collection);
    const reference = String(doc.reference || orderNode?.name || orderGid.replace(/\D/g, "")).replace(/[^A-Za-z0-9._-]/g, "");
    const filename = `Packing-List-${reference}.pdf`;

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
    console.error("[portal] packing list download failed", error);
    return new Response("We couldn't build that packing list. Please try again later.", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
};

function backToOrders() {
  return new Response(null, { status: 302, headers: { Location: "/apps/account/orders" } });
}
