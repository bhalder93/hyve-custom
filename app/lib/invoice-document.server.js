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
 */
import { ARTWORK_PENDING, formatMoney, formatDate, orderBelongsTo } from "./portal.server";
import { artworkSupplied } from "./artwork-zones.server";
import { LEGAL_NAME, BUSINESS_REGISTRATION_NUMBER, LEGAL_ADDRESS } from "./legal-entity.server";

const DOCUMENT_QUERY = `#graphql
  query InvoiceDocument($id: ID!) {
    shop {
      name
      contactEmail
    }
    order(id: $id) {
      id
      name
      createdAt
      poNumber
      customAttributes { key value }
      presentmentCurrencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      # The ship date customer service gives, as on the order (HYV-102).
      estimatedShipDate: metafield(namespace: "hyve", key: "estimated_ship_date") { value }
      customer { id }
      billingAddress { company name address1 address2 city province zip country }
      purchasingEntity {
        ... on PurchasingCompany {
          company {
            id
            name
            taxRegistrationNumber: metafield(namespace: "hyve", key: "tax_registration_number") { value }
          }
          location { id name }
        }
      }
      lineItems(first: 100) {
        nodes {
          title
          variantTitle
          sku
          quantity
          customAttributes { key value }
          originalUnitPriceSet { presentmentMoney { amount currencyCode } }
          discountedTotalSet { presentmentMoney { amount currencyCode } }
        }
      }
      shippingLine { title }
      subtotalPriceSet { presentmentMoney { amount currencyCode } }
      totalShippingPriceSet { presentmentMoney { amount currencyCode } }
      totalTaxSet { presentmentMoney { amount currencyCode } }
      totalPriceSet { presentmentMoney { amount currencyCode } }
      totalReceivedSet { presentmentMoney { amount currencyCode } }
      totalOutstandingSet { presentmentMoney { amount currencyCode } }
      paymentTerms {
        paymentTermsName
        paymentSchedules(first: 1) {
          nodes {
            issuedAt
            dueAt
            completedAt
            balanceDue { amount currencyCode }
            totalBalance { amount currencyCode }
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
  const currency = order.presentmentCurrencyCode || order.totalPriceSet?.presentmentMoney?.currencyCode || "";
  const amount = (set) => Number(set?.presentmentMoney?.amount ?? 0);
  const outstanding = amount(order.totalOutstandingSet);
  const paid = Boolean(schedule?.completedAt) || outstanding <= 0;

  const dueAt = schedule?.dueAt ? new Date(schedule.dueAt) : null;
  const overdue = !paid && dueAt ? dueAt.getTime() < Date.now() : false;

  return {
    shopName: LEGAL_NAME,
    shopRegistrationNumber: BUSINESS_REGISTRATION_NUMBER,
    shopEmail: body.data.shop?.contactEmail || "",
    shopAddress: LEGAL_ADDRESS,

    reference: order.name,
    orderName: order.name,
    poNumber: order.poNumber || "",
    currency,

    billTo: billingLines(order, order.purchasingEntity),
    billToTaxNumber: order.purchasingEntity?.company?.taxRegistrationNumber?.value || "",

    issuedLabel: formatDate(schedule?.issuedAt || order.createdAt),
    dueLabel: formatDate(schedule?.dueAt) || "on receipt",
    paidLabel: formatDate(schedule?.completedAt) || formatDate(order.createdAt),
    termsName: order.paymentTerms?.paymentTermsName || "",
    shipDateLabel: formatDate(order.estimatedShipDate?.value),
    status: paid ? "PAID" : overdue ? "OVERDUE" : "DUE",

    lines: (order.lineItems?.nodes || []).map((li) => ({
      title: li.title,
      variantTitle: li.variantTitle || "",
      sku: li.sku || "",
      quantity: li.quantity,
      // K3: the decoration the buyer chose is part of what they are being
      // billed for, so it belongs on the invoice next to the item.
      options: decorationOptions(li.customAttributes, order.customAttributes),
      unitLabel: formatMoney(amount(li.originalUnitPriceSet), currency),
      totalLabel: formatMoney(amount(li.discountedTotalSet), currency),
    })),

    subtotalLabel: formatMoney(amount(order.subtotalPriceSet), currency),
    shippingLabel: formatMoney(amount(order.totalShippingPriceSet), currency),
    // G9: name the rate rather than just "Shipping", so an FOB Ningbo charge is
    // identifiable on the invoice instead of hiding inside a generic total.
    shippingName: order.shippingLine?.title || "Shipping",
    taxLabel: formatMoney(amount(order.totalTaxSet), currency),
    totalLabel: formatMoney(amount(order.totalPriceSet), currency),
    paidAmountLabel: formatMoney(amount(order.totalReceivedSet), currency),
    outstandingLabel: formatMoney(outstanding, currency),
  };
}

/**
 * The decoration and extras recorded on a line at add-to-cart time.
 *
 * Keys beginning with an underscore are Shopify's convention for a hidden
 * property — ours carry plumbing like `_hyve_setup`, which means nothing to a
 * buyer reading an invoice. An uploaded artwork file is recorded as its link,
 * which reads as noise on paper, so the invoice says the file was supplied.
 */
function decorationOptions(attributes, orderAttributes) {
  // Artwork sent after the order is saved on the order, not the line, so a
  // line placed as "Artwork Pending" reads as supplied once it has arrived.
  const supplied = artworkSupplied(attributes, orderAttributes);
  return (attributes || [])
    .filter((attr) => attr?.key && !attr.key.startsWith("_") && attr.value)
    .map((attr) =>
      attr.key === "Artwork" && attr.value === ARTWORK_PENDING && supplied
        ? "Artwork: file supplied"
        : `${attr.key}: ${/^https?:\/\//i.test(attr.value) ? "file supplied" : attr.value}`,
    );
}

/** Who the invoice is addressed to: the company first, then the postal address. */
function billingLines(order, entity) {
  const address = order.billingAddress || {};
  const company = entity?.company?.name || address.company || "";
  const location = entity?.location?.name || "";

  return [
    company,
    // The location name is only worth showing when it isn't just the company
    // or the street again — locations are often named after their address.
    location && location !== company && location !== address.address1 ? location : "",
    address.name || "",
    address.address1 || "",
    address.address2 || "",
    [address.city, address.province, address.zip].filter(Boolean).join(" "),
    address.country || "",
  ].filter(Boolean);
}
