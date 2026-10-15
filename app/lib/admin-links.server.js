/**
 * Links that open a Hyve Custom page inside the Shopify admin, as staff use
 * it: admin.shopify.com/store/<store>/apps/<app handle>/app/... (HYV-127).
 * The app's own server address opens the page outside the admin, without
 * the staff member's session.
 *
 * The store and the app handle are read from Shopify (the `app` query returns
 * the calling app), so the link follows whichever app and store it runs in.
 */

const ADMIN_BASE_QUERY = `#graphql
  query AdminAppBase {
    app { handle }
    shop { myshopifyDomain }
  }`;

let cachedBase = null;

/** @returns {Promise<string>} "https://admin.shopify.com/store/<store>/apps/<handle>", or "" */
async function adminAppBase(admin) {
  if (cachedBase) return cachedBase;
  try {
    const response = await admin.graphql(ADMIN_BASE_QUERY);
    const data = (await response.json())?.data;
    const handle = data?.app?.handle;
    const store = String(data?.shop?.myshopifyDomain || "").replace(/\.myshopify\.com$/, "");
    if (!handle || !store) return "";
    cachedBase = `https://admin.shopify.com/store/${store}/apps/${handle}`;
    return cachedBase;
  } catch (error) {
    console.warn("[admin-links] could not read the app handle", error?.message || error);
    return "";
  }
}

/** The order's Production Orders page in the admin, or "" when it can't be built. */
export async function adminOrderUrl(admin, orderId) {
  const numericId = String(orderId || "").split("/").pop();
  const base = await adminAppBase(admin);
  return base && numericId ? `${base}/app/production-orders/${numericId}` : "";
}
