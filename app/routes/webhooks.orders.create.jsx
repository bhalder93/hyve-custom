import { authenticate, unauthenticated } from "../shopify.server";
import {
  artworkFromOrderPayload,
  recordOrderArtwork,
  artworkOwnerGid,
  companyGidForCustomer,
} from "../lib/artwork.server";

/**
 * orders/create — the product page to Saved Artwork link (F4).
 *
 * The product page uploads artwork as line-item properties, so the file only
 * becomes knowable once the order exists. This reads the new order's
 * properties, adds anything it finds to the customer's library and records the
 * order against it, which is what makes the "used in N orders" count real.
 *
 * Guest checkouts work too: the buyer supplies an email at checkout, so the
 * order carries a customer by the time this fires.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  try {
    const customerId = payload?.customer?.id;
    if (!customerId) {
      // No customer on the order (rare, e.g. a POS or draft edge case) — there
      // is no library to attach the artwork to.
      return new Response();
    }

    const artworks = artworkFromOrderPayload(payload);
    if (!artworks.length) return new Response();

    // Webhooks arrive without a session, so open an offline one for the shop.
    const { admin } = await unauthenticated.admin(shop);

    // The library belongs to the company where the buyer has one. A webhook has
    // no portal session to read that from, so it is looked up here.
    const customerGid = `gid://shopify/Customer/${customerId}`;
    const companyId = await companyGidForCustomer(admin, customerGid);

    const result = await recordOrderArtwork(
      admin,
      artworkOwnerGid({ companyId, customerId }),
      artworks,
      {
        id: `gid://shopify/Order/${payload.id}`,
        name: payload.name || `#${payload.order_number || payload.id}`,
        createdAt: payload.created_at || new Date().toISOString(),
      },
    );

    console.log(`[${topic}] ${payload.name}: ${artworks.length} artwork file(s) recorded`, result.ok);
  } catch (error) {
    // Never fail the webhook — Shopify retries, and a retry storm helps nobody.
    console.error("[orders/create] artwork sync failed", error);
  }

  return new Response();
};
