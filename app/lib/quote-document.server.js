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
import { bankAccountFor } from "./bank-details.server";

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

/**
 * The note a cart quote's draft starts with, so staff can tell it from one
 * sales prepared. The buyer's own cart note follows it, and only that part is
 * the quotation's Other Remarks.
 */
export const CART_QUOTE_NOTE = "Quote created from cart";

/** What a cart quote saves as its Source, against a quote sales prepared. */
const CART_QUOTE_SOURCE = "Cart quote";

/**
 * A quote's country when it carries no address: a guest's cart quote has only
 * an email. Each live market sells in its own currency, so the currency names
 * the country. USD is only a Vietnam distributor's, and a distributor always
 * has an address.
 */
const CURRENCY_COUNTRY = { SGD: "SG", HKD: "HK", MYR: "MY", THB: "TH", IDR: "ID", PHP: "PH", VND: "VN", CNY: "CN" };

/** The Incoterm a quote states when nothing on the draft chooses one. */
const RETAIL_INCOTERM = "DDP";

const MAILING_ADDRESS = "firstName lastName name company address1 address2 city province zip country countryCodeV2 phone";
const COMPANY_ADDRESS = "firstName lastName recipient companyName address1 address2 city province zip country countryCode phone";

const QUOTE_QUERY = `#graphql
  query QuoteDocument($id: ID!) {
    shop { name }
    draftOrder(id: $id) {
      id
      name
      createdAt
      email
      note2
      poNumber
      customer {
        id
        displayName
        defaultEmailAddress { emailAddress }
        defaultPhoneNumber { phoneNumber }
        defaultAddress { ${MAILING_ADDRESS} }
      }
      purchasingEntity {
        ... on PurchasingCompany {
          company {
            id
            name
          }
          location {
            shippingAddress { ${COMPANY_ADDRESS} }
            billingAddress { ${COMPANY_ADDRESS} }
            buyerExperienceConfiguration { paymentTermsTemplate { name } }
            salesRep: metafield(namespace: "hyve", key: "sales_rep") { value }
          }
          contact {
            customer {
              displayName
              defaultEmailAddress { emailAddress }
              defaultPhoneNumber { phoneNumber }
            }
          }
        }
      }
      shippingAddress { ${MAILING_ADDRESS} }
      billingAddress { ${MAILING_ADDRESS} }
      shippingLine { title originalPriceSet { presentmentMoney { amount currencyCode } } }
      paymentTerms { paymentTermsName }
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
          variant { selectedOptions { name value } }
          originalUnitPriceSet { presentmentMoney { amount currencyCode } }
          discountedTotalSet { presentmentMoney { amount currencyCode } }
        }
      }
    }
  }`;

/**
 * Everything the quotation PDF prints (HYV-116): the layout of NetSuite's
 * quotation, with the fields of the one Hyve issues by hand (Q46153).
 *
 * @param {string} draftGid the quote's draft order
 * @param {{customerGid?:string, companyGid?:string, email?:string, staff?:boolean}} proof
 *   who is asking. A signed-in buyer proves it with their customer id, or with
 *   their company for a quote raised by a colleague; the end client retrieving a
 *   quote without an account proves it with an email the quote belongs to, which
 *   the retrieve page has just checked. Staff, signed in to the Hyve Custom app,
 *   can open any.
 * @returns {Promise<?object>} null when missing or owned by someone else
 */
export async function loadQuoteDocument(admin, draftGid, proof = {}) {
  const { customerGid, companyGid, email, staff } = proof;
  if (!admin || !draftGid || (!staff && !customerGid && !companyGid && !email)) return null;

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
  if (!staff && !ownedByCustomer && !ownedByCompany && !ownedByEmail) return null;

  // The currency the quote was raised in, which is what the buyer pays
  // (HYV-98): a Vietnam distributor's is USD, from their B2B market (HYV-77).
  const currency = draft.totalPriceSet?.presentmentMoney?.currencyCode || "USD";
  // The renderer works in cents, the way the cart payload does.
  const cents = (set) => Math.round((Number(set?.presentmentMoney?.amount) || 0) * 100);

  const company = draft.purchasingEntity?.company || null;
  const location = draft.purchasingEntity?.location || null;
  const contact = draft.purchasingEntity?.contact?.customer || draft.customer || null;
  const contactName = contact?.displayName || "";
  const contactPhone = contact?.defaultPhoneNumber?.phoneNumber || "";

  const invoicing =
    mailingBlock(draft.billingAddress) ||
    companyBlock(location?.billingAddress, company?.name, contactName, contactPhone) ||
    mailingBlock(draft.customer?.defaultAddress) ||
    { name: contactName || draft.email || "", lines: [], phone: contactPhone };
  const shipping =
    mailingBlock(draft.shippingAddress) ||
    companyBlock(location?.shippingAddress, company?.name, contactName, contactPhone) ||
    mailingBlock(draft.customer?.defaultAddress) ||
    null;
  // The shipping block names its own contact only when it isn't the person
  // billed (HYV-116).
  const shippingContact =
    shipping && shipping.name && (shipping.name !== invoicing.name || shipping.phone !== invoicing.phone)
      ? { name: shipping.name, phone: shipping.phone }
      : null;

  const country =
    draft.shippingAddress?.countryCodeV2 ||
    draft.billingAddress?.countryCodeV2 ||
    location?.shippingAddress?.countryCode ||
    location?.billingAddress?.countryCode ||
    draft.customer?.defaultAddress?.countryCodeV2 ||
    CURRENCY_COUNTRY[currency] ||
    "";

  const attributes = draft.customAttributes || [];
  // Shipping method and date are on quotes sales prepare, not cart quotes,
  // which have no shipping chosen yet (Stephen, Sep 30).
  const cartQuote = attributes.some((attr) => attr.key === "Source" && attr.value === CART_QUOTE_SOURCE);
  const shippingLine = draft.shippingLine || null;

  const lines = draft.lineItems?.nodes || [];
  const rows = [
    ...lines.filter((li) => !isChargeLine(li) && !isDutyLine(li)).map((li) => itemRow(li, cents)),
    // The hidden Additional Charges lines are named on the quotation, with no
    // picture: a charge isn't something you hold (HYV-116).
    ...lines.filter(isChargeLine).map((li) => ({
      kind: "charge",
      code: li.sku || "",
      image: "",
      title: chargeLabel(li),
      details: [],
      qty: li.quantity,
      unit: cents(li.originalUnitPriceSet),
      total: cents(li.discountedTotalSet),
    })),
    // The duties line goes with the charges, below the products, and has no
    // picture either.
    ...lines.filter(isDutyLine).map((li) => ({ ...itemRow(li, cents), kind: "charge", code: "", image: "" })),
    ...(shippingLine
      ? [{
        kind: "shipping",
        code: "Shipping",
        image: "",
        title: "Shipping Fee",
        details: shippingLine.title ? [shippingLine.title] : [],
        qty: 1,
        unit: cents(shippingLine.originalPriceSet),
        total: cents(shippingLine.originalPriceSet),
      }]
      : []),
  ];

  return {
    // The quote email's subject names the store. Trimmed, so a space at the
    // end of the store name can't read "Your Hyve.Promo  quote".
    shopName: String(body.data.shop?.name || "").trim(),
    ref: quoteReference(draft.name),
    currency,
    dateStr: formatDate(draft.createdAt),
    // Must match the scheduled job that withdraws expired quotes, or the PDF
    // promises a date the quote no longer honours. The footer states it too.
    validStr: quoteValidUntil(draft.createdAt).label,
    leadTime: attributes.find((attr) => attr.key === LEAD_TIME_ATTRIBUTE)?.value || "",
    accountManager: location?.salesRep?.value || "",
    incoterm: incotermFor(shippingLine, company),
    customerPo: draft.poNumber || "",
    paymentTerms:
      draft.paymentTerms?.paymentTermsName ||
      location?.buyerExperienceConfiguration?.paymentTermsTemplate?.name ||
      "100% upfront",

    invoicing,
    shipping,
    shippingContact,

    rows,
    subtotal: cents(draft.subtotalPriceSet),
    shippingTotal: shippingLine ? cents(shippingLine.originalPriceSet) : null,
    // What the Shipping row says with no shipping line: a distributor's quote
    // is FOB, so shipping is theirs to arrange (HYV-144).
    shippingNote: company ? `Excluded (${DISTRIBUTOR_INCOTERM})` : "Calculated at checkout",
    grandTotal: cents(draft.totalPriceSet),

    shippingMethod: !cartQuote && shippingLine?.title ? shippingLine.title : "",
    remarks: remarksFrom(draft.note2),
    bank: bankAccountFor(country),
  };
}

/** The import duties line a checkout or sales can add, priced like a product. */
function isDutyLine(line) {
  return /^import duties/i.test(String(line?.title || ""));
}

/** The quotation's line for a product: its decorated code and full specification. */
function itemRow(li, cents) {
  const attributes = li.customAttributes || [];
  const { method, positions, count } = decorationOf(attributes);
  const options = (li.variant?.selectedOptions || []).filter(
    (opt) => opt?.name && opt.value && opt.value !== "Default Title",
  );
  const option = (pattern) => options.find((opt) => pattern.test(opt.name))?.value || "";
  const color = option(/^colou?r$/i) || (options.length ? "" : plainVariant(li.variantTitle));

  // The rows Q46153 lists, left out when there is no value rather than shown
  // blank (Stephen, Sep 30). Pcs per carton, G.W. per carton, Carton size and
  // Imprint size live only in each product's free-text Specifications so far,
  // so they wait for Hyve to supply them as fields.
  const details = [
    color && `Color: ${color}`,
    option(/^size$/i) && `Size: ${option(/^size$/i)}`,
    ...options.filter((opt) => !/^(colou?r|size)$/i.test(opt.name)).map((opt) => `${opt.name}: ${opt.value}`),
    method && `Imprint Method: ${method}`,
    positions.length && `Imprint Location: ${positions.join(", ")}`,
    ...attributes
      .filter((attr) => attr.key && !attr.key.startsWith("_") && attr.key !== "Imprint Locations" && attr.value)
      .map((attr) =>
        /^https?:/i.test(String(attr.value)) ? `${attr.key}: file received` : `${attr.key}: ${attr.value}`,
      ),
  ].filter(Boolean);

  return {
    kind: "item",
    // The decorated SKU, as NetSuite prints it: 50280MATBLK-Laser.
    code: li.sku ? (method ? `${li.sku}-${method}` : li.sku) : "",
    image: li.image?.url || "",
    title: li.title,
    decoration: count ? `with ${count} logo${count > 1 ? "s" : ""} printing` : "",
    details,
    qty: li.quantity,
    unit: cents(li.originalUnitPriceSet),
    total: cents(li.discountedTotalSet),
  };
}

/**
 * The decoration a line was ordered with. The product page saves it as
 * "Imprint Locations" ("Laser: Front, Back") and as `_imprint`, whose method
 * and count stand in when the first is missing.
 */
function decorationOf(attributes) {
  const text = String(attributes.find((attr) => attr.key === "Imprint Locations")?.value || "").trim();
  if (text.includes(":")) {
    const method = text.slice(0, text.indexOf(":")).trim();
    const positions = text.slice(text.indexOf(":") + 1).split(",").map((p) => p.trim()).filter(Boolean);
    return { method, positions, count: positions.length };
  }
  try {
    const imprint = JSON.parse(attributes.find((attr) => attr.key === "_imprint")?.value || "{}");
    const method = String(imprint?.method || "").trim();
    return { method, positions: [], count: method ? Number(imprint?.locations) || 0 : 0 };
  } catch {
    return { method: "", positions: [], count: 0 };
  }
}

function plainVariant(title) {
  const text = String(title || "").trim();
  return text && text !== "Default Title" ? text : "";
}

/** Hyve's FOB is at Ningbo. */
const DISTRIBUTOR_INCOTERM = "FOB Ningbo";

/**
 * NetSuite's quotation states the Incoterm. A quote with shipping chosen says
 * which. Without it, a distributor is quoted FOB with shipping excluded
 * (Michael, HYV-144), and a retail buyer DDP, the duties paid at checkout.
 */
function incotermFor(shippingLine, company) {
  const title = String(shippingLine?.title || "");
  if (/^fob\b/i.test(title)) return DISTRIBUTOR_INCOTERM;
  // if (/^exw\b/i.test(title)) return "EXW";
  if (title) return "DDP";
  return company ? DISTRIBUTOR_INCOTERM : RETAIL_INCOTERM;
}

/** A draft's note, without the line marking a cart quote. */
function remarksFrom(note) {
  return String(note || "")
    .split("\n")
    .filter((line, i) => !(i === 0 && line.trim() === CART_QUOTE_NOTE))
    .join("\n")
    .trim();
}

/** A draft order's own address, for the address blocks. */
function mailingBlock(address) {
  if (!address?.address1 && !address?.city) return null;
  const name = address.name || [address.firstName, address.lastName].filter(Boolean).join(" ");
  return {
    name,
    lines: [address.company, streetOf(address), placeOf(address), address.country].filter(Boolean),
    phone: address.phone || "",
  };
}

/** A company location's address, named after the person buying for it. */
function companyBlock(address, companyName, contactName, contactPhone) {
  if (!address?.address1 && !address?.city) return null;
  const name = address.recipient || [address.firstName, address.lastName].filter(Boolean).join(" ") || contactName;
  return {
    name,
    lines: [address.companyName || companyName, streetOf(address), placeOf(address), address.country].filter(Boolean),
    phone: address.phone || contactPhone || "",
  };
}

function streetOf(address) {
  return [address.address1, address.address2].filter(Boolean).join(", ");
}

function placeOf(address) {
  return [address.city, address.province, address.zip].filter(Boolean).join(" ");
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


