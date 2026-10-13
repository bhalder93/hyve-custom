/**
 * The proforma invoice (HYV-118).
 *
 * The document that travels with an international shipment and is read by
 * customs. A Nadel order to Singapore was returned in August because its
 * paperwork had no PO number, no incoterm, the wrong terms of sale and no
 * consignee tax ID or legal entity name, so those are on the face of the
 * first page here and the document isn't issued without them.
 *
 * It is made from an order not yet paid in full, in the quotation's layout,
 * like the invoice. What Shopify doesn't hold is kept on the order in one
 * JSON metafield ($app.proforma): the staff-entered terms of sale, shipping
 * mark, cartons, gross weight and dimensions, and the number once issued. The
 * consignee is the company: its name in Shopify is the "Company Legal Name"
 * from the application, overridden by hyve.legal_name when staff set one on
 * the proforma page (a company renamed to its trading name), and its tax ID
 * is hyve.tax_registration_number, the one Settings and the invoice use.
 *
 * Numbering: PI-<company country>-000001, one series per country, separate
 * from quotes. The number is given the first time the document is issued and
 * kept on the order, so a proforma regenerated after an edit keeps it. The
 * counters live on the shop ($app.proforma_counters) and are written with
 * compareDigest, so two issued at once can't take the same number.
 *
 * HS codes, country of origin, ports and a stamp area wait on Ethan.
 */
import { formatDate, orderBelongsTo } from "./portal.server";
import { incotermFromShipping } from "./incoterm";
import { bankAccountFor } from "./bank-details.server";
import { quoteReference } from "./quote-labels";
import {
  COMPANY_ADDRESS,
  CURRENCY_COUNTRY,
  MAILING_ADDRESS,
  chargeLabel,
  companyBlock,
  currentOrderLines,
  isChargeLine,
  isDutyLine,
  itemRow,
  mailingBlock,
} from "./quote-document.server";

export const TERMS_OF_SALE = ["Gift, not for resale", "Sold goods"];
const PROFORMA_KEY = "proforma";
const COUNTERS_KEY = "proforma_counters";

/** Singapore calls the consignee's tax ID its UEN (HYV-118). */
export function taxIdLabel(country) {
  return String(country || "").toUpperCase() === "SG" ? "UEN" : "Tax ID";
}

const DOCUMENT_QUERY = `#graphql
  query ProformaDocument($id: ID!) {
    shop {
      contactEmail
      # Bank accounts as staff keep them on the Bank Details page.
      bankMetafield: metafield(namespace: "hyve", key: "bank_details") { value }
    }
    order(id: $id) {
      id
      name
      createdAt
      poNumber
      presentmentCurrencyCode
      displayFinancialStatus
      estimatedShipDate: metafield(namespace: "hyve", key: "estimated_ship_date") { value }
      proforma: metafield(namespace: "$app", key: "${PROFORMA_KEY}") { value }
      customer {
        id
        displayName
        defaultPhoneNumber { phoneNumber }
      }
      billingAddress { ${MAILING_ADDRESS} }
      shippingAddress { ${MAILING_ADDRESS} }
      purchasingEntity {
        ... on PurchasingCompany {
          company {
            id
            name
            legalName: metafield(namespace: "hyve", key: "legal_name") { value }
            taxNumber: metafield(namespace: "hyve", key: "tax_registration_number") { value }
            # The quote the order came from, found from the quote's side, as the
            # portal does: an order holds no link back to its draft.
            draftOrders(first: 100, sortKey: UPDATED_AT, reverse: true) {
              nodes { name order { id } }
            }
            # The sales rep, when the order's own address doesn't carry one.
            locations(first: 10) { nodes { salesRep: metafield(namespace: "hyve", key: "sales_rep") { value } } }
          }
          location {
            id
            billingAddress { ${COMPANY_ADDRESS} }
            shippingAddress { ${COMPANY_ADDRESS} }
            salesRep: metafield(namespace: "hyve", key: "sales_rep") { value }
          }
        }
      }
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
          # The order as edited: currentQuantity, priced per unit.
          currentQuantity
          discountedUnitPriceSet { presentmentMoney { amount currencyCode } }
          discountedTotalSet { presentmentMoney { amount currencyCode } }
        }
      }
      shippingLine { title }
      totalPriceSet { presentmentMoney { amount currencyCode } }
      # The totals after any order edit.
      currentSubtotalPriceSet { presentmentMoney { amount currencyCode } }
      currentShippingPriceSet { presentmentMoney { amount currencyCode } }
      currentTotalPriceSet { presentmentMoney { amount currencyCode } }
      totalReceivedSet { presentmentMoney { amount currencyCode } }
      totalOutstandingSet { presentmentMoney { amount currencyCode } }
      paymentTerms {
        paymentTermsName
        paymentSchedules(first: 1) { nodes { dueAt } }
      }
    }
  }`;

const COUNTERS_QUERY = `#graphql
  query ProformaCounters {
    shop {
      id
      counters: metafield(namespace: "$app", key: "${COUNTERS_KEY}") { value compareDigest }
    }
  }`;

const SET_METAFIELDS = `#graphql
  mutation ProformaSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }`;

async function run(admin, query, variables) {
  const body = await (await admin.graphql(query, variables ? { variables } : undefined)).json();
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
  return body?.data;
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const text = (value) => String(value ?? "").trim();

/** The staff-entered fields, as saved on the order. */
function proformaFields(order) {
  const saved = parseJson(order?.proforma?.value);
  return {
    number: text(saved.number),
    issuedAt: text(saved.issuedAt),
    termsOfSale: TERMS_OF_SALE.includes(saved.termsOfSale) ? saved.termsOfSale : "",
    shippingMark: text(saved.shippingMark),
    cartons: text(saved.cartons),
    grossWeight: text(saved.grossWeight),
    dimensions: text(saved.dimensions),
  };
}

/** The country the numbering series follows: the company's own. */
function seriesCountry(order) {
  const location = order.purchasingEntity?.location;
  return text(
    location?.billingAddress?.countryCode ||
      location?.shippingAddress?.countryCode ||
      order.billingAddress?.countryCodeV2 ||
      CURRENCY_COUNTRY[order.presentmentCurrencyCode] ||
      "",
  ).toUpperCase();
}

function sourceQuote(order) {
  const drafts = order.purchasingEntity?.company?.draftOrders?.nodes || [];
  const draft = drafts.find((node) => node.order?.id === order.id);
  return draft ? quoteReference(draft.name) : "";
}

/**
 * Everything the proforma needs, and what's still missing before it can be
 * issued.
 *
 * @param {object} [by] who is asking: staff (`staff: true`), or the buyer
 *   (`customerGid`, `locationGids`), who only gets their own company's order
 * @returns {Promise<?object>} null when the order is missing or isn't theirs
 */
export async function loadProformaDocument(admin, orderGid, { staff, customerGid, locationGids } = {}) {
  const locations = (Array.isArray(locationGids) ? locationGids : [locationGids]).filter(Boolean);
  if (!admin || !orderGid || (!staff && !customerGid && !locations.length)) return null;

  const data = await run(admin, DOCUMENT_QUERY, { id: orderGid });
  const order = data?.order;
  if (!order) return null;
  if (!staff && !orderBelongsTo(order, { customerGid, locationGids: locations })) return null;

  const fields = proformaFields(order);
  const currency = order.presentmentCurrencyCode || order.totalPriceSet?.presentmentMoney?.currencyCode || "USD";
  const cents = (set) => Math.round((Number(set?.presentmentMoney?.amount) || 0) * 100);

  const company = order.purchasingEntity?.company || null;
  const location = order.purchasingEntity?.location || null;
  const contactName = order.customer?.displayName || "";
  const contactPhone = order.customer?.defaultPhoneNumber?.phoneNumber || "";
  const country = seriesCountry(order);

  const legalName = text(company?.legalName?.value);
  const taxId = text(company?.taxNumber?.value);
  const consigneeCountry = text(order.shippingAddress?.countryCodeV2 || location?.shippingAddress?.countryCode || country);

  const invoicing =
    mailingBlock(order.billingAddress) ||
    companyBlock(location?.billingAddress, company?.name, contactName, contactPhone) ||
    { name: company?.name || contactName, lines: [], phone: contactPhone };
  const shipping =
    mailingBlock(order.shippingAddress) ||
    companyBlock(location?.shippingAddress, company?.name, contactName, contactPhone) ||
    null;

  // The consignee is the legal entity, with its tax ID directly under it.
  const consigneeName = legalName || company?.name || "";
  const companyNames = new Set([company?.name, legalName].filter(Boolean));
  const consignee = shipping
    ? {
        ...shipping,
        lines: [
          consigneeName,
          taxId ? `${taxIdLabel(consigneeCountry)}: ${taxId}` : "",
          ...shipping.lines.filter((line) => !companyNames.has(line)),
        ].filter(Boolean),
      }
    : null;

  const lines = currentOrderLines(order);
  const rows = [
    ...lines.filter((li) => !isChargeLine(li) && !isDutyLine(li)).map((li) => itemRow(li, cents, { artwork: false })),
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
    ...lines
      .filter(isDutyLine)
      .map((li) => ({ ...itemRow(li, cents, { artwork: false }), kind: "charge", code: "", image: "" })),
  ];

  const incoterm = incotermFromShipping(order.shippingLine?.title);
  const outstanding = cents(order.totalOutstandingSet);

  // What the ticket requires before it's issued (HYV-118 acceptance 2).
  const missing = [
    !text(order.poNumber) && "Customer PO number (on the order in Shopify)",
    !incoterm && "Incoterm (the order has no shipping method)",
    !fields.termsOfSale && "Terms of Sale",
    !taxId && "Consignee tax ID (the company's tax registration number)",
    !company && "a company (the proforma is for distributor orders)",
  ].filter(Boolean);

  return {
    orderId: order.id,
    orderName: order.name,
    companyId: company?.id || "",
    companyName: company?.name || "",
    legalName,
    taxId,
    taxIdLabel: taxIdLabel(consigneeCountry),
    fields,
    missing,
    paidInFull: outstanding <= 0,
    seriesCountry: country,

    shopEmail: data.shop?.contactEmail || "",
    reference: fields.number,
    issuedLabel: formatDate(fields.issuedAt || new Date().toISOString()),
    currency,
    poNumber: text(order.poNumber),
    incoterm,
    termsOfSale: fields.termsOfSale,
    salesManager:
      text(location?.salesRep?.value) ||
      text((company?.locations?.nodes || []).find((l) => text(l.salesRep?.value))?.salesRep?.value),
    quoteReference: sourceQuote(order),

    invoicing,
    shipping: consignee,

    logistics: [
      ["Shipping Method", text(order.shippingLine?.title)],
      ["Shipping Date", formatDate(order.estimatedShipDate?.value)],
      ["Shipping Mark", fields.shippingMark],
      ["Number of Cartons", fields.cartons],
      ["Gross Weight", fields.grossWeight],
      ["Dimensions", fields.dimensions],
    ].filter(([, value]) => value),

    rows,
    subtotal: cents(order.currentSubtotalPriceSet),
    shippingTotal: cents(order.currentShippingPriceSet),
    total: cents(order.currentTotalPriceSet),
    amountPaid: cents(order.totalReceivedSet),
    outstanding,
    termsName: order.paymentTerms?.paymentTermsName || "",
    dueLabel: formatDate(order.paymentTerms?.paymentSchedules?.nodes?.[0]?.dueAt),
    // The same accounts the quotation and invoice print.
    // Until staff save that page, the built-in accounts.
    bank: bankAccountFor(country, data.shop?.bankMetafield?.value ? parseJson(data.shop.bankMetafield.value) : null),
  };
}

/**
 * Saves the staff-entered fields on the order. The number and issue date are
 * kept as they are.
 * @returns {Promise<?string>} an error message, or null
 */
export async function saveProformaFields(admin, orderGid, input) {
  const data = await run(admin, DOCUMENT_QUERY, { id: orderGid });
  const order = data?.order;
  if (!order) return "Order not found.";
  const current = proformaFields(order);
  const termsOfSale = text(input.termsOfSale);
  if (termsOfSale && !TERMS_OF_SALE.includes(termsOfSale)) return "Choose a Terms of Sale from the list.";

  const next = {
    ...current,
    termsOfSale,
    shippingMark: text(input.shippingMark).slice(0, 200),
    cartons: text(input.cartons).slice(0, 40),
    grossWeight: text(input.grossWeight).slice(0, 60),
    dimensions: text(input.dimensions).slice(0, 200),
  };
  const metafields = [
    { ownerId: orderGid, namespace: "$app", key: PROFORMA_KEY, type: "json", value: JSON.stringify(next) },
  ];

  // The consignee's legal name and tax ID belong to the company, so a fix made
  // here reaches every document and Settings.
  const companyId = order.purchasingEntity?.company?.id;
  if (companyId) {
    for (const [key, value] of [
      ["legal_name", input.legalName],
      ["tax_registration_number", input.taxId],
    ]) {
      if (value === undefined || value === null) continue;
      const clean = text(value).slice(0, 200);
      if (clean) metafields.push({ ownerId: companyId, namespace: "hyve", key, type: "single_line_text_field", value: clean });
    }
  }

  const result = (await run(admin, SET_METAFIELDS, { metafields }))?.metafieldsSet;
  const error = result?.userErrors?.[0]?.message;
  if (error) {
    console.error("[proforma] save failed", orderGid, JSON.stringify(result.userErrors));
    return error;
  }
  return null;
}

/**
 * Gives the order its proforma number the first time it's issued; after that
 * the same number. Returns the number, or throws.
 */
export async function issueProformaNumber(admin, doc) {
  if (doc.fields.number) return doc.fields.number;
  const country = doc.seriesCountry || "XX";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Another download of this order may have issued it meanwhile.
    const current = proformaFields((await run(admin, DOCUMENT_QUERY, { id: doc.orderId }))?.order);
    if (current.number) return current.number;

    const shop = (await run(admin, COUNTERS_QUERY))?.shop;
    const counters = parseJson(shop?.counters?.value);
    const next = (Number(counters[country]) || 0) + 1;
    const number = `PI-${country}-${String(next).padStart(6, "0")}`;

    // compareDigest refuses the write if another issue moved the counter first.
    const claimed = (
      await run(admin, SET_METAFIELDS, {
        metafields: [
          {
            ownerId: shop.id,
            namespace: "$app",
            key: COUNTERS_KEY,
            type: "json",
            value: JSON.stringify({ ...counters, [country]: next }),
            // null on the first issue: Shopify then only creates it, so two
            // first issues can't both write (metafieldsSet, compare-and-swap).
            compareDigest: shop?.counters?.compareDigest ?? null,
          },
        ],
      })
    )?.metafieldsSet;
    if (claimed?.userErrors?.length) {
      const stale = claimed.userErrors.some((e) => e.code === "STALE_OBJECT");
      if (stale) continue;
      throw new Error(claimed.userErrors[0].message);
    }

    const saved = (
      await run(admin, SET_METAFIELDS, {
        metafields: [
          {
            ownerId: doc.orderId,
            namespace: "$app",
            key: PROFORMA_KEY,
            type: "json",
            value: JSON.stringify({ ...current, number, issuedAt: new Date().toISOString() }),
          },
        ],
      })
    )?.metafieldsSet;
    if (saved?.userErrors?.length) throw new Error(saved.userErrors[0].message);
    return number;
  }
  throw new Error("Couldn't assign a proforma number. Please try again.");
}
