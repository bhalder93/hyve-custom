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

/**
 * Who a quote belongs to. A quote raised by someone buying for a company is
 * created against the company alone — Shopify refuses a customer and a
 * purchasing company on the same draft — so it can carry no customer and no
 * email of its own, only the company and the contact it was raised for.
 */
export const QUOTE_OWNER_FIELDS = `
      customer { id defaultEmailAddress { emailAddress } }
      purchasingEntity {
        ... on PurchasingCompany {
          company { id }
          contact { customer { defaultEmailAddress { emailAddress } } }
        }
      }`;

/**
 * The addresses that prove a quote is someone's without an account: the one
 * it was sent to, and the person it was raised for. The quotes list shows a
 * company quote to its buyer by company, so checking only the draft's own email
 * turned "Q-26" into "not found" for the person who could see it in the portal.
 *
 * @param {object} draft read with QUOTE_OWNER_FIELDS
 * @returns {string[]} lower-cased, without blanks
 */
export function quoteEmails(draft) {
  return [
    draft?.email,
    draft?.customer?.defaultEmailAddress?.emailAddress,
    draft?.purchasingEntity?.contact?.customer?.defaultEmailAddress?.emailAddress,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

const QUOTE_QUERY = `#graphql
  query QuoteDocument($id: ID!) {
    shop { name }
    draftOrder(id: $id) {
      id
      name
      createdAt
      email
      ${QUOTE_OWNER_FIELDS}
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
 * @param {{customerGid?:string, companyGid?:string, email?:string}} proof who is
 *   asking. A signed-in buyer proves it with their customer id, or with their
 *   company for a quote raised by a colleague; the end client retrieving a quote
 *   without an account proves it with an email the quote belongs to, which the
 *   retrieve page has just checked.
 * @returns {Promise<?object>} null when missing or owned by someone else
 */
export async function loadQuoteDocument(admin, draftGid, proof = {}) {
  const { customerGid, companyGid, email } = proof;
  if (!admin || !draftGid || (!customerGid && !companyGid && !email)) return null;

  const response = await admin.graphql(QUOTE_QUERY, { variables: { id: draftGid } });
  const body = await response.json();
  if (body?.errors) {
    console.warn("[quote-pdf] query failed", JSON.stringify(body.errors));
    return null;
  }

  const draft = body?.data?.draftOrder;
  if (!draft) return null;
  const ownedByCustomer = customerGid && draft.customer?.id === customerGid;
  // The same rule the portal's Quotes list uses: every quote the company
  // bought belongs to everyone buying for it.
  const ownedByCompany = companyGid && draft.purchasingEntity?.company?.id === companyGid;
  const ownedByEmail = email && quoteEmails(draft).includes(String(email).trim().toLowerCase());
  if (!ownedByCustomer && !ownedByCompany && !ownedByEmail) return null;

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
