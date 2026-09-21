/**
 * Invoices, built from Shopify's own B2B payment terms.
 *
 * Nothing here is stored by us. A Net 30 order carries a payment schedule with
 * an issue date, a due date, a balance and a completion date, so the invoice
 * list, the outstanding total, the due dates and the overdue/upcoming split are
 * all derived from real order data.
 *
 */
import { formatMoney, formatDate, orderStatusKey } from "./portal.server";

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
          tags
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          totalOutstandingSet { shopMoney { amount currencyCode } }
          lineItems(first: 3) { nodes { title quantity } }
          paymentTerms {
            paymentTermsName
            overdue
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
      }
    }
  }`;

/**
 * An order belongs to one company location, so a buyer who is a contact on
 * more than one location has invoices spread across them. Reading a single
 * location hid the rest, which looked to the buyer like the invoice was never
 * raised.
 *
 * @param {string|string[]} locationGids company location(s) the buyer orders for
 */
export async function loadInvoices(admin, locationGids) {
  const ids = (Array.isArray(locationGids) ? locationGids : [locationGids]).filter(Boolean);
  if (!admin || !ids.length) return { invoices: [], failed: true };

  try {
    // Measured at 66 requested / 10 actual cost per location against a 20,000
    // point bucket, so these run together rather than one after another.
    const results = await Promise.all(ids.map((id) => ordersForLocation(admin, id)));
    if (results.some((r) => r.failed)) return { invoices: [], failed: true };

    const seen = new Set();
    const invoices = results
      .flatMap((r) => r.orders)
      // Only orders on terms produce an invoice; a prepaid order is already settled.
      .filter((o) => o.paymentTerms)
      // K8: no invoice exists until sales has confirmed the order, so an order
      // still sitting in Credit Under Review is not listed.
      .filter((o) => orderStatusKey(o) !== "credit-under-review")
      .map(toInvoice)
      .filter((invoice) => {
        if (!invoice || seen.has(invoice.orderId)) return false;
        seen.add(invoice.orderId);
        return true;
      })
      .sort((a, b) => String(b.orderId).localeCompare(String(a.orderId), undefined, { numeric: true }));

    return { invoices, failed: false };
  } catch (error) {
    console.warn("[invoices] query threw", error?.message || error);
    return { invoices: [], failed: true };
  }
}

async function ordersForLocation(admin, locationGid) {
  const response = await admin.graphql(INVOICES_QUERY, {
    variables: { id: locationGid, first: 50 },
  });
  const body = await response.json();
  if (body?.errors) {
    console.warn("[invoices] query failed", JSON.stringify(body.errors));
    return { orders: [], failed: true };
  }
  return { orders: body?.data?.companyLocation?.orders?.nodes || [], failed: false };
}

function toInvoice(order) {
  const schedule = order.paymentTerms?.paymentSchedules?.nodes?.[0];
  if (!schedule) return null;

  const currency =
    order.totalPriceSet?.shopMoney?.currencyCode ||
    schedule.totalBalance?.currencyCode ||
    "";
  const outstanding = Number(order.totalOutstandingSet?.shopMoney?.amount ?? 0);
  // The amount billed, which is the order's total. A schedule's `totalBalance`
  // drops to zero the moment it is settled, so reading the invoice amount from
  // it made every paid invoice display as nil.
  const total = Number(order.totalPriceSet?.shopMoney?.amount ?? schedule.totalBalance?.amount ?? 0);
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
