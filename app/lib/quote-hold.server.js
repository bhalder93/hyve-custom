/**
 * Quote requests held at checkout until Hyve approves them.
 *
 * A quote is a Shopify draft order, and its checkout link works from the
 * moment the draft exists. A buyer's request from the portal starts as a
 * placeholder line at 0.00 that sales still has to price, so the link must not
 * take an order until Hyve approves it.
 *
 * The draft carries the HOLD_ATTRIBUTE marker until then. The draft's own
 * attributes become the checkout's, and the checkout rule in the Extensions
 * app (cart-checkout-validation) refuses to place an order that has it. Being
 * on the draft rather than a line, it stays when sales replace the
 * placeholder with real products.
 */

export const HOLD_ATTRIBUTE = "_hyve_hold";
const HOLD_VALUE = "Waiting for Hyve approval";

/** The marker for a new request's draft. */
export const HOLD_CUSTOM_ATTRIBUTE = { key: HOLD_ATTRIBUTE, value: HOLD_VALUE };

/**
 * Puts the marker on a draft, or takes it off. Only a buyer's request (tagged
 * awaiting_review) is ever held: a quote sales made is theirs to send.
 * @returns {Promise<string|null>} an error message, or null when done
 */
export async function setQuoteHold(admin, draftGid, held) {
  const response = await admin.graphql(
    `#graphql
    query QuoteHold($id: ID!) {
      draftOrder(id: $id) { id status tags customAttributes { key value } }
    }`,
    { variables: { id: draftGid } },
  );
  const draft = (await response.json())?.data?.draftOrder;
  if (!draft) return "This quote couldn't be found.";
  if (draft.status === "COMPLETED") return null;
  if (held && !(draft.tags || []).includes("awaiting_review")) return null;

  const others = (draft.customAttributes || []).filter((attr) => attr.key !== HOLD_ATTRIBUTE);
  const isHeld = others.length !== (draft.customAttributes || []).length;
  if (isHeld === held) return null;

  const updated = await admin.graphql(
    `#graphql
    mutation QuoteHoldUpdate($id: ID!, $input: DraftOrderInput!) {
      draftOrderUpdate(id: $id, input: $input) {
        draftOrder { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        id: draftGid,
        input: {
          customAttributes: [
            ...others.map(({ key, value }) => ({ key, value })),
            ...(held ? [HOLD_CUSTOM_ATTRIBUTE] : []),
          ],
        },
      },
    },
  );
  const body = await updated.json();
  const error = body?.errors?.[0]?.message || body?.data?.draftOrderUpdate?.userErrors?.[0]?.message;
  if (error) {
    console.error("[quote-hold] update failed", draftGid, error);
    return held ? `The quote couldn't be held: ${error}` : `The quote couldn't be released for checkout: ${error}`;
  }
  return null;
}
