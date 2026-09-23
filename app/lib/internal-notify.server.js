/**
 * Where Hyve's own notifications go: the store's contact address, as Shopify
 * holds it. Decided rather than configurable, so there is one answer and no
 * setting to get wrong. Change it here if it ever needs to be elsewhere.
 */

const SHOP_QUERY = `#graphql
  query InternalNotifyTarget {
    shop {
      name
      email
    }
  }`;

/**
 * @returns {Promise<{shopName: string, to: string}>} `to` is "" when the shop
 *   has no contact address, in which case the caller sends nothing.
 */
export async function internalNotifyTarget(admin) {
  try {
    const response = await admin.graphql(SHOP_QUERY);
    const body = await response.json();
    const shop = body?.data?.shop;
    return { shopName: shop?.name || "Hyve Promo", to: shop?.email || "" };
  } catch (error) {
    console.warn("[notify] could not read the shop address", error?.message || error);
    return { shopName: "Hyve Promo", to: "" };
  }
}
