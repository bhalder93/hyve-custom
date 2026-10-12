/**
 * Checkout's working fields, taken off the order once it's placed (HYV-176).
 *
 * Checkout extensions keep values in `_hyve_*` attributes while the buyer is
 * checking out: `_hyve_ship`, the chosen shipping cost the cart transform
 * prices import duty from. Shopify copies every checkout attribute onto the
 * order, where they showed as raw fields under Additional details. Nothing
 * reads them after checkout, so they come off; every other attribute stays.
 */

const INTERNAL_PREFIX = "_hyve_";

/**
 * @param {Array<{name?: string, key?: string, value?: string}>} noteAttributes
 *   the order's attributes, as the orders/create payload carries them
 */
export async function removeCheckoutWorkingFields(admin, orderId, noteAttributes = []) {
  const attributes = (Array.isArray(noteAttributes) ? noteAttributes : []).map((attr) => ({
    key: String(attr?.name ?? attr?.key ?? ""),
    value: String(attr?.value ?? ""),
  }));
  const kept = attributes.filter((attr) => attr.key && !attr.key.startsWith(INTERNAL_PREFIX));
  if (kept.length === attributes.length) return;
  const input = { id: orderId, customAttributes: kept };

  try {
    const response = await admin.graphql(
      `#graphql
      mutation RemoveCheckoutWorkingFields($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id }
          userErrors { field message }
        }
      }`,
      { variables: { input } },
    );
    const body = await response.json();
    const error = body?.errors?.[0]?.message || body?.data?.orderUpdate?.userErrors?.[0]?.message;
    if (error) console.warn("[order] couldn't remove checkout working fields", orderId, error);
  } catch (error) {
    console.warn("[order] couldn't remove checkout working fields", orderId, error?.message || error);
  }
}
