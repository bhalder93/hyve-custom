/**
 * Turns a draft order into the payload the quote PDF renderer expects.
 *
 * The cart's "Download PDF" builds that payload in the browser from what the
 * shopper can see. A quote in the portal has no such page, so the same shape is
 * assembled here from the draft order Shopify already holds.
 *
 * The draft order is only returned if it belongs to the signed-in customer, so
 * one buyer can't pull another's quote by guessing an ID.
 */

const QUOTE_QUERY = `#graphql
  query QuoteDocument($id: ID!) {
    shop { name }
    draftOrder(id: $id) {
      id
      name
      createdAt
      customer { id }
      email
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 100) {
        nodes {
          title
          variantTitle
          sku
          quantity
          image { url }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountedTotalSet { shopMoney { amount currencyCode } }
        }
      }
      customAttributes { key value }
    }
  }`;

/**
 * @param {string} draftGid the quote's draft order
 * @param {string} customerGid the signed-in buyer
 * @returns {Promise<?object>} null when missing or owned by someone else
 */
export async function loadQuoteDocument(admin, draftGid, customerGid) {
  if (!admin || !draftGid || !customerGid) return null;

  const response = await admin.graphql(QUOTE_QUERY, { variables: { id: draftGid } });
  const body = await response.json();
  if (body?.errors) {
    console.warn("[quote-pdf] query failed", JSON.stringify(body.errors));
    return null;
  }

  const draft = body?.data?.draftOrder;
  if (!draft) return null;
  if (draft.customer?.id !== customerGid) return null;

  const currency = draft.totalPriceSet?.shopMoney?.currencyCode || "USD";
  // The renderer works in cents, the way the cart payload does.
  const cents = (set) => Math.round((Number(set?.shopMoney?.amount) || 0) * 100);

  const lines = draft.lineItems?.nodes || [];
  const validUntil = draft.customAttributes?.find(
    (a) => a.key === "Valid Until" || a.key === "Target Date",
  )?.value;

  return {
    shopName: body.data.shop?.name || "",
    ref: quoteReference(draft.name),
    currency,
    dateStr: formatDay(draft.createdAt),
    validStr: validUntil || formatDay(addDays(draft.createdAt, 14)),

    merch: lines.map((li) => ({
      title: li.title,
      image: li.image?.url || "",
      chips: [li.variantTitle, li.sku ? `SKU ${li.sku}` : ""].filter(Boolean),
      qty: li.quantity,
      unitPrice: cents(li.originalUnitPriceSet),
      linePrice: cents(li.discountedTotalSet),
    })),
    fees: [],
    subtotal: cents(draft.subtotalPriceSet),
    grandTotal: cents(draft.totalPriceSet),
  };
}

/** Draft orders are named #D1055; the portal calls that quote Q-1055. */
export function quoteReference(name) {
  const raw = String(name || "");
  if (raw.startsWith("#D")) return `Q-${raw.slice(2)}`;
  if (raw.startsWith("#")) return `Q-${raw.slice(1)}`;
  return raw || "Quote";
}

function addDays(iso, days) {
  if (!iso) return null;
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function formatDay(iso) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}
