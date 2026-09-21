/**
 * Putting artwork onto the order itself.
 *
 * Artwork supplied at checkout arrives as a line-item property, which is where
 * production looks for it. Artwork supplied afterwards cannot go there — an
 * order's line items are fixed once it exists, so `orderUpdate` accepts a note,
 * tags, order-level custom attributes and metafields, and nothing else.
 *
 * So a late file is written to the order two ways, both visible to staff in the
 * Shopify admin without opening this app:
 *
 *   - an order custom attribute per position, under Additional details, which
 *     is where the existing proof and shipping values already sit
 *   - an `hyve.artwork` metafield holding the file URLs, as a single place to
 *     read them all back
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
      artwork: metafield(namespace: "hyve", key: "artwork") { value }
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

  let known = [];
  try {
    known = JSON.parse(order.artwork?.value || "[]");
    if (!Array.isArray(known)) known = [];
  } catch {
    known = [];
  }
  const urls = [...new Set([...known, ...files.map((file) => file.url)])];

  const result = await gql(admin, ORDER_UPDATE, {
    input: {
      id: orderGid,
      customAttributes: [...attributes].map(([key, value]) => ({ key, value })),
      metafields: [
        {
          namespace: "hyve",
          key: "artwork",
          type: "list.url",
          value: JSON.stringify(urls),
        },
      ],
    },
  });

  const error = result?.orderUpdate?.userErrors?.[0];
  if (error) return { ok: false, error: error.message };

  return { ok: true };
}
