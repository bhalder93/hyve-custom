/**
 * Withdrawing expired quotes (Michael, Nov 7).
 *
 * A quote is a Shopify draft order, and a draft order has no expiry: its
 * checkout link keeps working for ever. So once a quote passes its validity
 * (quoteValidUntil), the 15-minute SLA run copies it into an `expired_quote`
 * record and deletes the draft, which stops the link. The record keeps it on
 * the buyer's Quotes page as expired with a Requote, and lets the Retrieve
 * page say when it expired (expired-quotes.server.js reads it back).
 *
 * Only a quote the buyer has the link for is withdrawn. A draft still with
 * sales, a request Hyve hasn't priced, and a terms order waiting on its credit
 * review (which is an order and has no expiry, HYV-99) are left alone.
 */
import { QUOTE_VALID_DAYS } from "./quote-document.server";
import { DRAFT_ORIGIN_FIELDS, submittedForReview, withBuyer } from "./account-quotes.server";

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRED_QUOTES = `#graphql
  query QuotesToWithdraw($query: String!) {
    draftOrders(first: 50, query: $query) {
      nodes {
        id
        name
        createdAt
        status
        tags
        invoiceSentAt
        email
        hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
        ${DRAFT_ORIGIN_FIELDS}
        customer { id displayName defaultEmailAddress { emailAddress } }
        purchasingEntity {
          ... on PurchasingCompany {
            contact { customer { id displayName defaultEmailAddress { emailAddress } } }
          }
        }
        lineItems(first: 100) {
          nodes { title quantity discountedTotalSet { presentmentMoney { amount } } }
        }
        totalPriceSet { presentmentMoney { amount currencyCode } }
      }
    }
  }`;

const ARCHIVE = `#graphql
  mutation ArchiveExpiredQuote($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message }
    }
  }`;

const DELETE = `#graphql
  mutation WithdrawExpiredQuote($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }`;

/** The expired_quote record for a draft, in the shape expired-quotes.server.js reads. */
function archiveFields(draft) {
  const person = draft.customer || draft.purchasingEntity?.contact?.customer || null;
  const email = draft.email || person?.defaultEmailAddress?.emailAddress || "";
  const money = draft.totalPriceSet?.presentmentMoney;
  return [
    { key: "quote_number", value: draft.name },
    { key: "quote_date", value: draft.createdAt },
    { key: "customer", value: JSON.stringify({ id: person?.id || "", email, name: person?.displayName || "" }) },
    {
      key: "line_items",
      value: JSON.stringify(
        (draft.lineItems?.nodes || []).map((line) => ({
          title: line.title,
          quantity: line.quantity,
          total: line.discountedTotalSet?.presentmentMoney?.amount ?? "",
        })),
      ),
    },
    { key: "total", value: JSON.stringify({ amount: money?.amount ?? "0", currency_code: money?.currencyCode || "" }) },
  ];
}

/**
 * @param {{now?:Date, dryRun?:boolean}} [options] dryRun lists the quotes it
 *   would withdraw without archiving or deleting them.
 * @returns {Promise<{checked:number, withdrawn:string[], errors:string[]}>}
 */
export async function withdrawExpiredQuotes(admin, { now = new Date(), dryRun = false } = {}) {
  const result = { checked: 0, withdrawn: [], errors: [] };
  const cutoff = new Date(now.getTime() - QUOTE_VALID_DAYS * DAY_MS);
  const response = await admin.graphql(EXPIRED_QUOTES, {
    variables: { query: `status:open created_at:<'${cutoff.toISOString()}'` },
  });
  const body = await response.json();
  if (body?.errors?.length) throw new Error(body.errors[0]?.message || "Expired quote lookup failed.");

  for (const draft of body?.data?.draftOrders?.nodes || []) {
    result.checked += 1;
    if (draft.status !== "OPEN" || !withBuyer(draft) || submittedForReview(draft)) continue;
    if (dryRun) {
      result.withdrawn.push(draft.name);
      continue;
    }

    try {
      // Archived first: a draft is only deleted once its record is saved.
      const archived = (await (await admin.graphql(ARCHIVE, {
        variables: { metaobject: { type: "expired_quote", fields: archiveFields(draft) } },
      })).json())?.data?.metaobjectCreate;
      if (!archived?.metaobject?.id) {
        throw new Error(archived?.userErrors?.[0]?.message || "the expired quote record wasn't saved");
      }
      const deleted = (await (await admin.graphql(DELETE, { variables: { input: { id: draft.id } } })).json())
        ?.data?.draftOrderDelete;
      if (!deleted?.deletedId) throw new Error(deleted?.userErrors?.[0]?.message || "the draft order wasn't deleted");
      result.withdrawn.push(draft.name);
    } catch (error) {
      result.errors.push(`${draft.name}: ${error?.message || error}`);
    }
  }
  return result;
}
