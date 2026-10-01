/**
 * Production due dates after a holiday changes (HYV-135).
 *
 * A due date is worked out once, when the proof is approved, so a holiday
 * added afterwards never reached orders already in production. This works
 * each one out again from the moment its proof was approved, on today's
 * calendar, and saves the ones that move. It runs whenever staff save or
 * delete a holiday.
 *
 * The approval time comes from the order's status history, the record every
 * status change writes. An order with no approval in its history is left
 * alone and reported, rather than given a date counted from a guess.
 */
import { gql, productionCalendar, productionDueDate } from "./order-status.server";

/** Statuses an order is in between proof approval and production finishing. */
const IN_PRODUCTION = ["proof-approved", "in-production"];

/** History is read newest first; this bounds how far back it looks. */
const HISTORY_PAGES = 4;

const ORDERS_QUERY = `#graphql
  query OrdersInProduction($query: String!) {
    orders(first: 250, query: $query) {
      nodes {
        id
        name
        rush: metafield(namespace: "$app", key: "rush") { value }
        productionDueAt: metafield(namespace: "$app", key: "production_due_at") { value }
      }
    }
  }`;

const HISTORY_QUERY = `#graphql
  query ApprovalHistory($after: String) {
    metaobjects(type: "$app:order_status_history", first: 250, after: $after, sortKey: "updated_at", reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        orderId: field(key: "order_id") { value }
        toStatus: field(key: "to_status") { value }
        changedAt: field(key: "changed_at") { value }
      }
    }
  }`;

const DUE_SET = `#graphql
  mutation ProductionDueSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

/** The latest proof approval time for each of `orderIds`, from the history. */
async function approvalTimes(admin, orderIds) {
  const wanted = new Set(orderIds);
  const found = new Map();
  let after = null;

  for (let page = 0; page < HISTORY_PAGES && found.size < wanted.size; page += 1) {
    const data = await gql(admin, HISTORY_QUERY, { after });
    const history = data.metaobjects;
    for (const entry of history?.nodes || []) {
      const orderId = entry.orderId?.value;
      if (entry.toStatus?.value !== "proof-approved" || !wanted.has(orderId)) continue;
      const at = entry.changedAt?.value;
      if (at && (!found.has(orderId) || at > found.get(orderId))) found.set(orderId, at);
    }
    if (!history?.pageInfo?.hasNextPage) break;
    after = history.pageInfo.endCursor;
  }
  return found;
}

/**
 * @returns {Promise<{checked:number, moved:{name:string, from:string, to:string}[], skipped:string[]}>}
 *   `skipped` lists orders whose approval time couldn't be found.
 */
export async function rescheduleProductionDueDates(admin) {
  const query = IN_PRODUCTION.map((status) => `tag:"hyve-status:${status}"`).join(" OR ");
  const orders = (await gql(admin, ORDERS_QUERY, { query })).orders?.nodes || [];
  const result = { checked: orders.length, moved: [], skipped: [] };
  if (!orders.length) return result;

  const [calendar, approvals] = await Promise.all([
    productionCalendar(admin),
    approvalTimes(admin, orders.map((order) => order.id)),
  ]);

  const updates = [];
  for (const order of orders) {
    const approvedAt = approvals.get(order.id);
    if (!approvedAt) {
      result.skipped.push(order.name);
      continue;
    }
    const due = productionDueDate(calendar, approvedAt, order.rush?.value === "true");
    const current = order.productionDueAt?.value || "";
    if (current && new Date(current).getTime() === new Date(due).getTime()) continue;

    updates.push({ ownerId: order.id, namespace: "$app", key: "production_due_at", type: "date_time", value: due });
    result.moved.push({ name: order.name, from: current, to: due });
  }

  // metafieldsSet takes at most 25 at a time.
  for (let i = 0; i < updates.length; i += 25) {
    const data = await gql(admin, DUE_SET, { metafields: updates.slice(i, i + 25) });
    const error = data.metafieldsSet?.userErrors?.[0]?.message;
    if (error) throw new Error(error);
  }
  return result;
}
