/**
 * Reorder: the same items back in the buyer's cart (HYV-85).
 *
 * The buyer then checks out as usual, picking the address, shipping and PO
 * number, so nothing is placed or emailed until they do. Only the product
 * lines come across, each with its options and saved artwork: the cart adds
 * its own setup, rush and gift charges from those lines, and checkout adds
 * import duty for the shipping picked, so neither charge line is copied.
 *
 * A line that can no longer be bought (deleted or unavailable) is left out,
 * and the caller is told how many.
 */

import { orderBelongsTo } from "./portal.server";
import { zonesFromAttributes } from "./artwork-zones.server";

const SOURCE_QUERY = `#graphql
  query ReorderSource($id: ID!) {
    order(id: $id) {
      id
      name
      customer { id }
      # Artwork uploaded after the order was placed is kept on the order.
      customAttributes { key value }
      purchasingEntity {
        ... on PurchasingCompany {
          location { id }
        }
      }
      lineItems(first: 100) {
        nodes {
          quantity: currentQuantity
          variant { id availableForSale product { handle } }
          customAttributes { key value }
        }
      }
    }
  }`;

/** The charge lines the cart and checkout add themselves. */
const CHARGE_HANDLES = new Set(["additional-charges", "import-duties-taxes-included"]);

/** Checkout's and quotes' working fields, which the new cart sets again. */
const WORKING_KEYS = new Set(["_hyve_quote", "_hyve_freight", "_variant_price_usd"]);

/**
 * The line's properties for the cart. Two things are put back that the order
 * line may not carry (HYV-85):
 * - The decoration fee keys. A quote's lines leave `_imprint` and `_fcw` out
 *   (its price was fixed), so they are rebuilt from the visible "Imprint
 *   Locations" and "Full Colour Wrap" text the theme writes them from;
 *   without them the cart charges no decoration fee.
 * - Artwork sent after the order was placed, which is kept on the order under
 *   the same "Artwork: <position>" key the line would have had. Once every
 *   position has a file, the line reads as artwork provided.
 */
function cartProperties(line, orderAttributes) {
  const props = Object.fromEntries(
    (line.customAttributes || [])
      .filter(({ key, value }) => key && !WORKING_KEYS.has(key) && value != null && value !== "")
      .map(({ key, value }) => [key, value]),
  );

  const imprint = String(props["Imprint Locations"] || "");
  if (imprint && !props._imprint) {
    const split = imprint.indexOf(":");
    const method = (split > -1 ? imprint.slice(0, split) : imprint).trim();
    const locations = split > -1 ? imprint.slice(split + 1).split(",").map((part) => part.trim()).filter(Boolean) : [];
    if (method && locations.length) props._imprint = JSON.stringify({ method, locations: locations.length });
  }
  if (props["Full Colour Wrap"] && !props._fcw) props._fcw = "true";

  const zones = zonesFromAttributes(line.customAttributes || [], orderAttributes);
  for (const zone of zones) {
    if (zone.url && !props[zone.key]) props[zone.key] = zone.url;
  }
  if (zones.length && zones.every((zone) => zone.url) && props.Artwork) props.Artwork = "Provided now";

  return props;
}

/**
 * @param {string} orderGid the order being repeated
 * @param {string} customerGid the signed-in buyer, who must own that order
 * @param {string[]} [locationGids] their company's locations: an order placed
 *   for a company they have left can't be repeated (HYV-76)
 * @returns {Promise<{ok:boolean, error?:string, name?:string,
 *   lines?:{id:number, quantity:number, properties:Object<string,string>}[], skipped?:number}>}
 */
export async function reorderLines(admin, orderGid, customerGid, locationGids = []) {
  if (!admin || !orderGid || !customerGid) {
    return { ok: false, error: "We couldn't work out which order to repeat." };
  }

  const source = await gql(admin, SOURCE_QUERY, { id: orderGid });
  const order = source?.order;
  if (!order) return { ok: false, error: "We couldn't find that order." };

  // A buyer may only repeat their own order, and a company order only while
  // they're still on that company.
  if (order.customer?.id !== customerGid || !orderBelongsTo(order, { customerGid, locationGids })) {
    return { ok: false, error: "We couldn't find that order." };
  }

  const products = (order.lineItems?.nodes || []).filter(
    (li) => li.quantity > 0 && !CHARGE_HANDLES.has(li.variant?.product?.handle || ""),
  );
  const lines = products
    .filter((li) => li.variant?.id && li.variant.availableForSale)
    .map((li) => ({
      id: Number(String(li.variant.id).split("/").pop()),
      quantity: li.quantity,
      properties: cartProperties(li, order.customAttributes || []),
    }));

  if (!lines.length) {
    return { ok: false, error: "None of the items on that order can be bought again." };
  }
  return { ok: true, name: order.name, lines, skipped: products.length - lines.length };
}

async function gql(admin, query, variables) {
  try {
    const response = await admin.graphql(query, { variables });
    const body = await response.json();
    if (body?.errors) {
      console.error("[reorder] graphql errors", JSON.stringify(body.errors));
      return null;
    }
    return body?.data || null;
  } catch (error) {
    console.error("[reorder] request threw", error);
    return null;
  }
}
