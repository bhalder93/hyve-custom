/**
 * Putting artwork onto the order itself.
 *
 * Artwork supplied at checkout arrives as a line-item property, which is where
 * production looks for it. Artwork supplied afterwards cannot go there — an
 * order's line items are fixed once it exists, so `orderUpdate` accepts a note,
 * tags, order-level custom attributes and metafields, and nothing else.
 *
 * So a late file is written to the order as a custom attribute per position,
 * under Additional details in the Shopify admin, keyed exactly as the line's own
 * `Artwork: <position>` property would have been. That is where staff and the
 * portal both read it back.
 *
 * Existing attributes are carried over, because `customAttributes` replaces the
 * whole set rather than merging.
 */
import { gql } from "./order-status.server";

const ORDER_ATTRIBUTES = `#graphql
  query OrderArtworkAttributes($id: ID!) {
    order(id: $id) {
      id
      customAttributes { key value }
    }
  }`;

const ORDER_UPDATE = `#graphql
  mutation OrderArtworkUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      userErrors { field message }
      order { id }
    }
  }`;

/**
 * @param {Array<{zone:string, url:string, filename:string}>} supplied
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function attachArtworkToOrder(admin, orderGid, supplied = []) {
  const files = supplied.filter((item) => item?.url);
  if (!files.length) return { ok: true };

  const { order } = await gql(admin, ORDER_ATTRIBUTES, { id: orderGid });
  if (!order) return { ok: false, error: "We couldn't find that order." };

  const attributes = new Map(
    (order.customAttributes || []).map((attr) => [attr.key, attr.value]),
  );
  for (const file of files) {
    attributes.set(file.zone, file.url);
  }

  const result = await gql(admin, ORDER_UPDATE, {
    input: {
      id: orderGid,
      customAttributes: [...attributes].map(([key, value]) => ({ key, value })),
    },
  });

  const error = result?.orderUpdate?.userErrors?.[0];
  if (error) return { ok: false, error: error.message };

  return { ok: true };
}

export const ARTWORK_UPDATE_CANDIDATES = new Set([
  "artwork pending",
  "design it for me",
]);

/**
 * Checks whether an attribute value should be updated to "Artwork Received".
 * Matches "Artwork Pending" and "Design it for me" (case-insensitive).
 * Does NOT match "Provided now".
 */
export function shouldUpdateArtworkAttribute(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "provided now") return false;
  return ARTWORK_UPDATE_CANDIDATES.has(normalized);
}

/**
 * Updates line item attributes in an order payload:
 * If an item has customAttribute { key: "Artwork" } with value "Artwork Pending"
 * or "Design it for me", updates its value to "Artwork Received".
 * Keeps "Provided now" unchanged.
 * Supports payloads formatted with edges/node, nodes array, or raw array.
 */
export function updateLineItemArtworkAttributesInPayload(lineItemsPayload) {
  if (!lineItemsPayload) return lineItemsPayload;

  // Handle edges format: { edges: [ { node: { ... } } ] }
  if (Array.isArray(lineItemsPayload.edges)) {
    return {
      ...lineItemsPayload,
      edges: lineItemsPayload.edges.map((edge) => {
        if (!edge?.node) return edge;
        return {
          ...edge,
          node: updateSingleLineItemArtwork(edge.node),
        };
      }),
    };
  }

  // Handle nodes format: { nodes: [ { ... } ] }
  if (Array.isArray(lineItemsPayload.nodes)) {
    return {
      ...lineItemsPayload,
      nodes: lineItemsPayload.nodes.map(updateSingleLineItemArtwork),
    };
  }

  // Handle array of line items directly: [ { ... } ]
  if (Array.isArray(lineItemsPayload)) {
    return lineItemsPayload.map(updateSingleLineItemArtwork);
  }

  return lineItemsPayload;
}

export function updateSingleLineItemArtwork(lineItem) {
  if (!lineItem || !Array.isArray(lineItem.customAttributes)) {
    return lineItem;
  }

  const customAttributes = lineItem.customAttributes.map((attr) => {
    if (!attr?.key) return attr;
    if (String(attr.key).trim().toLowerCase() === "artwork") {
      if (shouldUpdateArtworkAttribute(attr.value)) {
        return {
          ...attr,
          value: "Artwork Received",
        };
      }
    }
    return attr;
  });

  return {
    ...lineItem,
    customAttributes,
  };
}

const LINE_ITEM_METAFIELDS_SET = `#graphql
  mutation SetLineItemArtworkMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message code }
    }
  }`;

export async function syncLineItemArtworkReceived(admin, order) {
  const lineItems = order?.lineItems?.nodes || order?.lineItems?.edges?.map((e) => e.node) || [];
  const metafields = [];

  for (const item of lineItems) {
    const artworkAttr = (item.customAttributes || []).find(
      (attr) => String(attr?.key || "").trim().toLowerCase() === "artwork",
    );
    if (artworkAttr && shouldUpdateArtworkAttribute(artworkAttr.value) && item.id) {
      metafields.push({
        ownerId: item.id,
        namespace: "$app",
        key: "artwork",
        type: "single_line_text_field",
        value: "Artwork Received",
      });
    }
  }

  if (metafields.length > 0) {
    try {
      await gql(admin, LINE_ITEM_METAFIELDS_SET, { metafields });
    } catch (err) {
      console.error(`[artwork-received] Failed to set line item metafields for ${order?.name || order?.id}:`, err);
    }
  }
}

