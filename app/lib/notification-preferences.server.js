/**
 * What a buyer's Email Notifications switch in Settings controls (HYV-110).
 *
 * Switched off, the order status updates stop: Artwork Received, Approved and
 * In Production, Production Completed. The proof email and its reminders keep
 * going, because the order can't move without the buyer's decision. Shopify's
 * own order and shipping confirmations are Shopify's and aren't affected.
 */
export const OPTIONAL_STATUS_EMAILS = new Set(["artwork-received", "proof-approved", "production-complete"]);

const PREFERENCE_QUERY = `#graphql
  query CustomerEmailPreference($id: ID!) {
    customer(id: $id) {
      emailNotifications: metafield(namespace: "custom", key: "email_notifications") { value }
    }
  }`;

/**
 * Whether this buyer should get the email for this status. Only an explicit
 * "off" stops it; a buyer who never touched the switch gets their emails.
 *
 * @param {string} customerGid
 * @param {string} status the production status the email is for
 */
export async function statusEmailWanted(admin, customerGid, status) {
  if (!OPTIONAL_STATUS_EMAILS.has(status) || !customerGid) return true;

  const response = await admin.graphql(PREFERENCE_QUERY, { variables: { id: customerGid } });
  const body = await response.json();
  return body?.data?.customer?.emailNotifications?.value !== "false";
}
