/**
 * Loading an order for an action the buyer takes in the portal.
 *
 * Every such action — approving a proof, uploading outstanding artwork — has
 * to answer the same question first: is this the buyer's order? The rule is
 * the one the invoice download uses, so a buyer can act on their own order or
 * on one placed by a company location they belong to, and on nothing else.
 */
import { gql } from "./order-status.server";

const ORDER_QUERY = `#graphql
  query OrderForAction($id: ID!) {
    order(id: $id) {
      id
      name
      tags
      note
      customer { id }
      purchasingEntity {
        ... on PurchasingCompany {
          location { id }
        }
      }
    }
  }`;

/**
 * @param {{customerGid?:string, locationGids?:string[]}} by who is asking
 * @returns {Promise<{ok:true, order:object}|{ok:false, error:string}>}
 */
export async function loadOrderForAction(admin, orderGid, by = {}) {
  const { order } = await gql(admin, ORDER_QUERY, { id: orderGid });
  if (!order) return { ok: false, error: "We couldn't find that order." };

  const locations = (by.locationGids || []).filter(Boolean);
  const ownedByCustomer = by.customerGid && order.customer?.id === by.customerGid;
  const ownedByCompany = locations.includes(order.purchasingEntity?.location?.id);
  if (!ownedByCustomer && !ownedByCompany) {
    return { ok: false, error: "That order isn't on your account." };
  }

  return { ok: true, order };
}
