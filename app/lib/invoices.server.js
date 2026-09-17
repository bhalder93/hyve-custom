/**
 * Invoices, built from Shopify's own B2B payment terms.
 *
 * Nothing here is stored by us. A Net 30 order carries a payment schedule with
 * an issue date, a due date, a balance and a completion date, so the invoice
 * list, the outstanding total, the due dates and the overdue/upcoming split are
 * all derived from real order data.
 *
 */
import { formatMoney, formatDate } from "./portal.server";

const DAY_MS = 24 * 60 * 60 * 1000;

const INVOICES_QUERY = `#graphql
  query CompanyInvoices($id: ID!, $first: Int!) {
    companyLocation(id: $id) {
      id
      orders(first: $first, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          createdAt
          poNumber
          displayFinancialStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          totalOutstandingSet { shopMoney { amount currencyCode } }
          lineItems(first: 3) { nodes { title quantity } }
          paymentTerms {
            paymentTermsName
            overdue
            paymentSchedules(first: 5) {
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
      }
    }
  }`;

/**
 * @param {string} locationGid company location the buyer is ordering for
 */
export async function loadInvoices(admin, locationGid) {
  if (!admin || !locationGid) return { invoices: [], failed: true };

  try {
    const response = await admin.graphql(INVOICES_QUERY, {
      variables: { id: locationGid, first: 50 },
    });
    const body = await response.json();
    if (body?.errors) {
      console.warn("[invoices] query failed", JSON.stringify(body.errors));
      return { invoices: [], failed: true };
    }

    const orders = body?.data?.companyLocation?.orders?.nodes || [];
    // Only orders on terms produce an invoice; a prepaid order is already settled.
    const invoices = orders.filter((o) => o.paymentTerms).map(toInvoice).filter(Boolean);

    return { invoices, failed: false };
  } catch (error) {
    console.warn("[invoices] query threw", error?.message || error);
    return { invoices: [], failed: true };
  }
}

function toInvoice(order) {
  const schedule = order.paymentTerms?.paymentSchedules?.nodes?.[0];
  if (!schedule) return null;

  const currency =
    order.totalPriceSet?.shopMoney?.currencyCode ||
    schedule.totalBalance?.currencyCode ||
    "";
  const outstanding = Number(order.totalOutstandingSet?.shopMoney?.amount ?? 0);
  const total = Number(schedule.totalBalance?.amount ?? order.totalPriceSet?.shopMoney?.amount ?? 0);
  const paid = Boolean(schedule.completedAt) || outstanding <= 0;
  const dueAt = schedule.dueAt ? new Date(schedule.dueAt) : null;
  const days = dueAt ? Math.ceil((dueAt.getTime() - Date.now()) / DAY_MS) : null;

  const outstandingNow = paid ? 0 : outstanding;

  return {
    // Shopify has no invoice number, so the order it belongs to is the reference.
    reference: order.name,
    orderName: order.name,
    orderId: order.id,
    poNumber: order.poNumber || "",
    items: (order.lineItems?.nodes || [])
      .map((li) => `${li.title} x${li.quantity}`)
      .join(", "),
    status: paid ? "paid" : days != null && days < 0 ? "overdue" : "pending",
    currency,
    total,
    outstanding: outstandingNow,
    totalLabel: formatMoney(total, currency),
    outstandingLabel: formatMoney(outstandingNow, currency),
    issuedLabel: formatDate(schedule.issuedAt || order.createdAt),
    dueLabel: formatDate(schedule.dueAt),
    paidLabel: formatDate(schedule.completedAt),
    daysUntilDue: days,
    termsName: order.paymentTerms?.paymentTermsName || "",
    // Shopify has no invoice PDF, so we render one from the order.
    downloadHref: order.id
      ? `/apps/account/invoices/download?order=${encodeURIComponent(order.id)}`
      : "",
  };
}
