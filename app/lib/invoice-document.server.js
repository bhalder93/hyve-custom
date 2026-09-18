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
import { formatMoney, formatDate } from "./portal.server";

const DOCUMENT_QUERY = `#graphql
  query InvoiceDocument($id: ID!) {
    shop {
      name
      contactEmail
      shopAddress { formatted }
    }
    order(id: $id) {
      id
      name
      createdAt
      poNumber
      currencyCode
      displayFinancialStatus
      customer { id }
      billingAddress { company name address1 address2 city province zip country }
      purchasingEntity {
        ... on PurchasingCompany {
          company { id name }
          location { id name }
        }
      }
      lineItems(first: 100) {
        nodes {
          title
          variantTitle
          sku
          quantity
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountedTotalSet { shopMoney { amount currencyCode } }
        }
      }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      totalReceivedSet { shopMoney { amount currencyCode } }
      totalOutstandingSet { shopMoney { amount currencyCode } }
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
 * @param {{customerGid?:string, locationGids?:string[]}} owner who is asking
 * @returns {Promise<?object>} null when the order is missing or isn't theirs
 */
export async function loadInvoiceDocument(admin, orderGid, { customerGid, locationGids } = {}) {
  const locations = (Array.isArray(locationGids) ? locationGids : [locationGids]).filter(Boolean);
  if (!admin || !orderGid || (!customerGid && !locations.length)) return null;

  const response = await admin.graphql(DOCUMENT_QUERY, { variables: { id: orderGid } });
  const body = await response.json();
  if (body?.errors) {
    console.warn("[invoice-pdf] query failed", JSON.stringify(body.errors));
    return null;
  }

  const order = body?.data?.order;
  if (!order) return null;

  // Theirs either personally or through the company they buy for.
  const ownedByCustomer = customerGid && order.customer?.id === customerGid;
  const ownedByCompany = locations.includes(order.purchasingEntity?.location?.id);
  if (!ownedByCustomer && !ownedByCompany) return null;

  // Only an order on terms has a schedule; a prepaid one was settled at checkout.
  const schedule = order.paymentTerms?.paymentSchedules?.nodes?.[0] || null;

  const currency = order.currencyCode || order.totalPriceSet?.shopMoney?.currencyCode || "";
  const amount = (set) => Number(set?.shopMoney?.amount ?? 0);
  const outstanding = amount(order.totalOutstandingSet);
  const paid = Boolean(schedule?.completedAt) || outstanding <= 0;

  const dueAt = schedule?.dueAt ? new Date(schedule.dueAt) : null;
  const overdue = !paid && dueAt ? dueAt.getTime() < Date.now() : false;

  return {
    shopName: body.data.shop?.name || "",
    shopEmail: body.data.shop?.contactEmail || "",
    shopAddress: body.data.shop?.shopAddress?.formatted || [],

    reference: order.name,
    orderName: order.name,
    poNumber: order.poNumber || "",
    currency,

    billTo: billingLines(order, order.purchasingEntity),

    issuedLabel: formatDate(schedule?.issuedAt || order.createdAt),
    dueLabel: formatDate(schedule?.dueAt) || "on receipt",
    paidLabel: formatDate(schedule?.completedAt) || formatDate(order.createdAt),
    termsName: order.paymentTerms?.paymentTermsName || "",
    status: paid ? "PAID" : overdue ? "OVERDUE" : "DUE",

    lines: (order.lineItems?.nodes || []).map((li) => ({
      title: li.title,
      variantTitle: li.variantTitle || "",
      sku: li.sku || "",
      quantity: li.quantity,
      unitLabel: formatMoney(amount(li.originalUnitPriceSet), currency),
      totalLabel: formatMoney(amount(li.discountedTotalSet), currency),
    })),

    subtotalLabel: formatMoney(amount(order.subtotalPriceSet), currency),
    shippingLabel: formatMoney(amount(order.totalShippingPriceSet), currency),
    taxLabel: formatMoney(amount(order.totalTaxSet), currency),
    totalLabel: formatMoney(amount(order.totalPriceSet), currency),
    paidAmountLabel: formatMoney(amount(order.totalReceivedSet), currency),
    outstandingLabel: formatMoney(outstanding, currency),
  };
}

/** Who the invoice is addressed to: the company first, then the postal address. */
function billingLines(order, entity) {
  const address = order.billingAddress || {};
  const company = entity?.company?.name || address.company || "";
  const location = entity?.location?.name || "";

  return [
    company,
    // The location name is only worth showing when it isn't just the company again.
    location && location !== company ? location : "",
    address.name || "",
    address.address1 || "",
    address.address2 || "",
    [address.city, address.province, address.zip].filter(Boolean).join(" "),
    address.country || "",
  ].filter(Boolean);
}
