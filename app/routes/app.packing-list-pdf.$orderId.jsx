import { authenticate } from "../shopify.server";
import { loadInvoiceDocument } from "../lib/invoice-document.server";
import { buildPackingListPdf } from "../lib/packing-list-pdf.server.jsx";

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
 * The packing list PDF for an order (HYV-160): the products and quantities,
 * cartons, gross weight, and volume for forwarder collection or customer records.
 * Requested with App Bridge's fetch, which carries the admin session.
 */
export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = String(params?.orderId || "").replace(/\D/g, "");
  if (!id) return new Response("Order ID is required.", { status: 400 });
  const orderGid = `gid://shopify/Order/${id}`;

  const [doc, orderRes] = await Promise.all([
    loadInvoiceDocument(admin, orderGid, { system: true }),
    admin
      .graphql(ORDER_COLLECTION_QUERY, { variables: { id: orderGid } })
      .then((res) => res.json())
      .catch((err) => {
        console.warn("[packing-list-pdf] collection metafields query failed:", err?.message || err);
        return null;
      }),
  ]);

  if (!doc) return new Response("Order not found.", { status: 404 });

  const orderNode = orderRes?.data?.order;
  const url = new URL(request.url);
  const collection = {
    readyDate: url.searchParams.get("readyDate") || orderNode?.collectionReadyDate?.value || "",
    numberOfCartons:
      url.searchParams.get("numberOfCartons") ||
      url.searchParams.get("cartons") ||
      orderNode?.collectionCartons?.value ||
      "",
    grossWeight: url.searchParams.get("grossWeight") || orderNode?.collectionGrossWeight?.value || "",
    cbm: url.searchParams.get("cbm") || orderNode?.collectionCbm?.value || "",
  };

  const pdf = await buildPackingListPdf(doc, collection);
  const reference = String(doc.reference || orderNode?.name || id).replace(/[^A-Za-z0-9._-]/g, "");

  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Packing-List-${reference}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
};
