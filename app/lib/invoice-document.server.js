/**
 * Loads everything a single invoice PDF needs.
 *
 * Shopify has no invoice object and no invoice PDF, so the document is built
 * from the order the invoice belongs to: its line items, its tax and shipping,
 * and the payment schedule that makes it an invoice in the first place.
 *
 * The order is only returned if the buyer placed it, or if their own company
 * location did, so nobody can pull someone else's invoice by guessing an ID.
 *
 * An order without payment terms still gets a document — it was simply paid at
 * checkout rather than on terms, and the buyer may still want the paperwork.
 *
 * It is the quotation's family (HYV-155): the same address blocks, product
 * rows, charge rows and bank account, built by the same functions as the
 * quote (quote-document.server.js), so the two documents can't drift apart.
 */
import { formatDate, orderBelongsTo } from "./portal.server";
import { incotermFromShipping } from "./incoterm";
import { bankAccountFor } from "./bank-details.server";
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

const DOCUMENT_QUERY = `#graphql
  query InvoiceDocument($id: ID!) {
    shop {
      contactEmail
      bankMetafield: metafield(namespace: "hyve", key: "bank_details") { value }
    }
    order(id: $id) {
      id
      name
      createdAt
      poNumber
      presentmentCurrencyCode
      # The ship date customer service gives, as on the order (HYV-102).
      estimatedShipDate: metafield(namespace: "hyve", key: "estimated_ship_date") { value }
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
            taxRegistrationNumber: metafield(namespace: "hyve", key: "tax_registration_number") { value }
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
        paymentSchedules(first: 1) {
          nodes {
            issuedAt
            dueAt
            completedAt
          }
        }
      }
    }
  }`;

/**
 * @param {string} orderGid the order the invoice belongs to
 * @param {{customerGid?:string, locationGids?:string[], system?:boolean}} owner who
 *   is asking: the buyer, or the app itself emailing the invoice once the order
 *   is paid (HYV-144)
 * @returns {Promise<?object>} null when the order is missing or isn't theirs
 */
export async function loadInvoiceDocument(admin, orderGid, { customerGid, locationGids, system } = {}) {
  const locations = (Array.isArray(locationGids) ? locationGids : [locationGids]).filter(Boolean);
  if (!admin || !orderGid || (!system && !customerGid && !locations.length)) return null;

  const response = await admin.graphql(DOCUMENT_QUERY, { variables: { id: orderGid } });
  const body = await response.json();
  if (body?.errors) {
    console.warn("[invoice-pdf] query failed", JSON.stringify(body.errors));
    return null;
  }

  const order = body?.data?.order;
  if (!order) return null;

  // A company's invoice is only for people on that company now (HYV-76).
  if (!system && !orderBelongsTo(order, { customerGid, locationGids: locations })) return null;

  // Only an order on terms has a schedule; a prepaid one was settled at checkout.
  const schedule = order.paymentTerms?.paymentSchedules?.nodes?.[0] || null;

  // The currency the buyer paid in (HYV-103). `currencyCode` is the shop's
  // own, which printed an SGD order in USD.
  const currency = order.presentmentCurrencyCode || order.totalPriceSet?.presentmentMoney?.currencyCode || "USD";
  // The renderer works in cents, as the quotation's does.
  const cents = (set) => Math.round((Number(set?.presentmentMoney?.amount) || 0) * 100);
  const outstanding = cents(order.totalOutstandingSet);
  const paid = Boolean(schedule?.completedAt) || outstanding <= 0;

  const dueAt = schedule?.dueAt ? new Date(schedule.dueAt) : null;
  const overdue = !paid && dueAt ? dueAt.getTime() < Date.now() : false;

  const company = order.purchasingEntity?.company || null;
  const location = order.purchasingEntity?.location || null;
  const contactName = order.customer?.displayName || "";
  const contactPhone = order.customer?.defaultPhoneNumber?.phoneNumber || "";

  const invoicing =
    mailingBlock(order.billingAddress) ||
    companyBlock(location?.billingAddress, company?.name, contactName, contactPhone) ||
    { name: company?.name || contactName, lines: [], phone: contactPhone };
  const shipping =
    mailingBlock(order.shippingAddress) ||
    companyBlock(location?.shippingAddress, company?.name, contactName, contactPhone) ||
    null;
  // The shipping block names its own contact only when it isn't the person
  // billed, as on the quotation.
  const shippingContact =
    shipping && shipping.name && (shipping.name !== invoicing.name || shipping.phone !== invoicing.phone)
      ? { name: shipping.name, phone: shipping.phone }
      : null;

  const country =
    order.billingAddress?.countryCodeV2 ||
    order.shippingAddress?.countryCodeV2 ||
    location?.billingAddress?.countryCode ||
    CURRENCY_COUNTRY[currency] ||
    "";

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

  return {
    shopEmail: body.data.shop?.contactEmail || "",

    reference: order.name,
    poNumber: order.poNumber || "",
    currency,
    status: paid ? "PAID" : overdue ? "OVERDUE" : "DUE",

    issuedLabel: formatDate(schedule?.issuedAt || order.createdAt),
    dueLabel: formatDate(schedule?.dueAt) || "On receipt",
    paidLabel: formatDate(schedule?.completedAt) || formatDate(order.createdAt),
    termsName: order.paymentTerms?.paymentTermsName || "",
    shipDateLabel: formatDate(order.estimatedShipDate?.value),
    // HYV-140: the term the order ships under, DDP or FOB Ningbo.
    incoterm: incotermFromShipping(order.shippingLine?.title),
    accountManager: location?.salesRep?.value || "",

    invoicing,
    shipping,
    shippingContact,
    billToTaxNumber: company?.taxRegistrationNumber?.value || "",

    rows,
    subtotal: cents(order.currentSubtotalPriceSet),
    // G9: name the rate rather than just "Shipping", so the buyer sees which
    // delivery they chose (FOB or a UPS rate), not a generic total.
    shippingName: order.shippingLine?.title || "",
    shippingTotal: cents(order.currentShippingPriceSet),
    total: cents(order.currentTotalPriceSet),
    amountPaid: cents(order.totalReceivedSet),
    outstanding,

    // Bank details to pay into, matching quotation and portal; only while
    // something is still owed (HYV-151).
    bank: paid ? null : (() => {
      let customAccounts = null;
      try {
        const rawJson = body.data.shop?.bankMetafield?.value;
        if (rawJson) customAccounts = JSON.parse(rawJson);
      } catch {}
      return bankAccountFor(country, customAccounts);
    })(),
  };
}
