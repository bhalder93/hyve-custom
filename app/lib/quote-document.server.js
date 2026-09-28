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

import { formatDate } from "./portal.server";

/** How long a quote stands. The scheduled sweep that withdraws quotes uses the
 *  same figure — change both together. */
export const QUOTE_VALID_DAYS = 14;

/**
 * The day a quote stops standing, QUOTE_VALID_DAYS after it was raised. The
 * PDF prints it and the expiry reminder counts down to it, so both read it
 * from here.
 *
 * @param {string|Date} createdAt when the draft order was created
 * @returns {{at: Date, label: string}}
 */
export function quoteValidUntil(createdAt) {
  const at = new Date(addDays(createdAt, QUOTE_VALID_DAYS));
  return { at, label: formatDate(at) };
}

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

/**
 * The cart marks its charge lines (setup, rush, gift packaging, physical
 * sample) with these, and a cart quote keeps them on its lines. Older quotes
 * were saved without them, so a line from the Additional Charges product
 * counts too, the same rule the cart's own quote PDF uses (hyve-quote.js).
 */
const CHARGE_FLAGS = ["_hyve_setup", "_hyve_rush", "_hyve_gift", "_hyve_sample"];

/** @param {{title?:string, customAttributes?:{key:string,value:string}[]}} line */
export function isChargeLine(line) {
  const flagged = (line?.customAttributes || []).some(
    (attr) => CHARGE_FLAGS.includes(attr.key) && String(attr.value) === "true",
  );
  return flagged || /^additional charges/i.test(String(line?.title || ""));
}

/** "Setup" rather than "Additional Charges": the variant names the charge. */
export function chargeLabel(line) {
  const variant = String(line?.variantTitle || "").trim();
  if (variant && variant !== "Default Title") return variant;
  return String(line?.title || "Charge").replace(/^additional charges\s*[-–]\s*/i, "") || "Charge";
}

/**
 * The configuration shown under a quoted item: its variant and the options
 * the buyer chose, read from the line's details. The same rules as the cart's
 * quote PDF (itemChipsArr in hyve-quote.js), so a quote downloaded from the
 * account reads like the one downloaded from the cart. Hidden details (a
 * leading underscore) are the cart's own bookkeeping and never shown.
 */
export function quoteLineChips(line) {
  const chips = [];
  const variant = String(line?.variantTitle || "").trim();
  if (variant && variant !== "Default Title") chips.push(variant);
  for (const { key, value } of line?.customAttributes || []) {
    if (!key || key.startsWith("_") || value == null || value === "") continue;
    const text = String(value);
    if (/^https?:/i.test(text)) chips.push(`${key.replace(/^Artwork:\s*/i, "")} · file ✓`);
    else if (text.toLowerCase() === "yes") chips.push(key);
    else if (key === "Imprint Locations") chips.push(text);
    else chips.push(text.length > 44 ? `${key}: ${text.slice(0, 44)}…` : `${key}: ${text}`);
  }
  return chips;
}

/** The lead time a cart quote was raised with, saved on the draft. */
export const LEAD_TIME_ATTRIBUTE = "Lead time";

const QUOTE_QUERY = `#graphql
  query QuoteDocument($id: ID!) {
    shop { name }
    draftOrder(id: $id) {
      id
      name
      createdAt
      email
      ${QUOTE_OWNER_FIELDS}
      customAttributes { key value }
      totalPriceSet { presentmentMoney { amount currencyCode } }
      subtotalPriceSet { presentmentMoney { amount currencyCode } }
      lineItems(first: 100) {
        nodes {
          title
          variantTitle
          sku
          quantity
          image { url }
          customAttributes { key value }
          originalUnitPriceSet { presentmentMoney { amount currencyCode } }
          discountedTotalSet { presentmentMoney { amount currencyCode } }
        }
      }
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

  // The currency the quote was raised in, which is what the buyer pays
  // (HYV-98). The shop's own currency printed an SGD quote in USD.
  const currency = draft.totalPriceSet?.presentmentMoney?.currencyCode || "USD";
  // The renderer works in cents, the way the cart payload does.
  const cents = (set) => Math.round((Number(set?.presentmentMoney?.amount) || 0) * 100);

  const lines = draft.lineItems?.nodes || [];
  const items = lines.filter((li) => !isChargeLine(li));
  const charges = lines.filter(isChargeLine);

  return {
    shopName: body.data.shop?.name || "",
    ref: quoteReference(draft.name),
    currency,
    dateStr: formatDate(draft.createdAt),
    // Must match the scheduled job that withdraws expired quotes, or the PDF
    // promises a date the quote no longer honours.
    validStr: quoteValidUntil(draft.createdAt).label,
    leadTime: (draft.customAttributes || []).find((attr) => attr.key === LEAD_TIME_ATTRIBUTE)?.value || "",

    merch: items.map((li) => ({
      title: li.title,
      image: li.image?.url || "",
      chips: quoteLineChips(li),
      qty: li.quantity,
      unitPrice: cents(li.originalUnitPriceSet),
      linePrice: cents(li.discountedTotalSet),
    })),
    // Charges sit under the subtotal, as they do in the cart's quote.
    fees: charges.map((li) => ({ label: chargeLabel(li), amount: cents(li.discountedTotalSet) })),
    subtotal: items.reduce((sum, li) => sum + cents(li.discountedTotalSet), 0),
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


