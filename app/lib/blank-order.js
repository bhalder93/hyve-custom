/**
 * Business rule:
 *
 * A blank order has no "Artwork" attribute on any line item.
 *
 * Blank orders:
 * - are not production orders
 * - do not get hyve-status:order-placed
 * - do not get production_status
 * - do not get status_changed_at
 * - do not get production status history
 * - should not appear in Production Orders
 * - should not be processed by SLA
 *
 * orders/create decides with it, and the daily digest reads it to spot a
 * decorated order that isn't in Production Orders.
 */
export function isBlankOrder(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return true;
  }

  return lineItems.every((lineItem) => {
    const attr = lineItem.customAttributes?.find(
      (attribute) => String(attribute.key || "").trim().toLowerCase() === "artwork",
    );
    return !(attr && attr.value && attr.value.trim());
  });
}
