/**
 * Turns a draft order into the payload the quote PDF renderer expects.
 *
 * The cart's "Download PDF" builds that payload in the browser from what the
 * shopper can see. A quote in the portal has no such page, so the same shape is
 * assembled here from the draft order Shopify already holds.
 *
 * The draft order is only returned to someone who has proved it is theirs, so
 * one buyer can't pull another's quote by guessing an ID.
 */

/** How long a quote stands. The scheduled sweep that withdraws quotes uses the
 *  same figure — change both together. */
export const QUOTE_VALID_DAYS = 14;

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
 * @param {{customerGid?:string, email?:string}} proof who is asking. A signed-in
 *   buyer proves it with their customer id; the end client retrieving a quote
 *   without an account proves it with the email the quote was sent to, which
 *   the retrieve page has just checked.
 * @returns {Promise<?object>} null when missing or owned by someone else
 */
export async function loadQuoteDocument(admin, draftGid, proof = {}) {
  const { customerGid, email } = proof;
  if (!admin || !draftGid || (!customerGid && !email)) return null;

  const response = await admin.graphql(QUOTE_QUERY, { variables: { id: draftGid } });
  const body = await response.json();
  if (body?.errors) {
    console.warn("[quote-pdf] query failed", JSON.stringify(body.errors));
    return null;
  }

  const draft = body?.data?.draftOrder;
  if (!draft) return null;
  const ownedByCustomer = customerGid && draft.customer?.id === customerGid;
  const ownedByEmail =
    email && String(draft.email || "").toLowerCase() === String(email).toLowerCase();
  if (!ownedByCustomer && !ownedByEmail) return null;

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
    // Must match the scheduled job that withdraws expired quotes, or the PDF
    // promises a date the quote no longer honours.
    validStr: validUntil || formatDay(addDays(draft.createdAt, QUOTE_VALID_DAYS)),

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
