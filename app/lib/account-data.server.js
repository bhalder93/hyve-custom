/**
 * One Admin API read backing every account-portal page.
 *
 * Returns the signed-in customer, whether they are an approved distributor
 * (A2, by customer tag), their commercial terms (M2/M3) and their recent
 * orders. `failed` is true when the data could not be trusted — missing
 * scopes, GraphQL errors or a timeout — so the caller shows the error panel
 * instead of an empty portal.
 */
import { quoteDecision } from "./account-quotes.server";
import {
  isDistributor,
  orderStatusKey,
  AWAITING_DISTRIBUTOR,
  CUSTOMER_METAFIELDS,
  formatMoney,
  formatDate,
} from "./portal.server";

/** Give up before Shopify gives up on the proxy response. */
const ADMIN_TIMEOUT_MS = 4000;

/**
 * Order fields.
 *
 * The production fields — proof, production photo, on-hold reason, production
 * due date and when the status last changed — are written by the SLA engine and
 * the Production Orders screen under the app's own namespace, so they are read
 * from `$app`. The commercial fields customer service types in by hand (ship
 * date, proof due, PO, incoterm, forwarder) live under `hyve`.
 */
const PORTAL_ORDER_FIELDS = `#graphql
  fragment PortalOrder on Order {
          id
          name
          createdAt
          tags
          poNumber
          statusPageUrl
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          paymentTerms { paymentTermsName }
          poNumberMeta: metafield(namespace: "hyve", key: "po_number") { value }
          estimatedShipDate: metafield(namespace: "hyve", key: "estimated_ship_date") { value }
          productionDueAt: metafield(namespace: "$app", key: "production_due_at") { value }
          proofDueAt: metafield(namespace: "hyve", key: "proof_due_at") { value }
          proofUrl: metafield(namespace: "$app", key: "proof_url") { value }
          onHoldReason: metafield(namespace: "$app", key: "on_hold_reason") { value }
          incoterm: metafield(namespace: "hyve", key: "incoterm") { value }
          forwarder: metafield(namespace: "hyve", key: "forwarder") { value }
          statusChangedAt: metafield(namespace: "$app", key: "status_changed_at") { value }
          productionPhotoUrl: metafield(namespace: "$app", key: "production_photo_url") { value }
          note
          customAttributes { key value }
          shippingAddress { name company address1 address2 city provinceCode zip countryCodeV2 }
          shippingLine { title }
          lineItems(first: 10) {
            nodes {
              title
              quantity
              variantTitle
              sku
              customAttributes { key value }
              variant { id }
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              discountedTotalSet { shopMoney { amount currencyCode } }
            }
          }
          fulfillments(first: 1) {
            displayStatus
            deliveredAt
            trackingInfo(first: 1) { company number url }
          }
        }`;

const ACCOUNT_QUERY = `#graphql
  query PortalAccount($id: ID!, $first: Int!, $draftQuery: String!) {
    customer(id: $id) {
      firstName
      lastName
      displayName
      defaultEmailAddress { emailAddress }
      tags
      companyContactProfiles {
        isMainContact
        company {
          id
          name
          locations(first: 20) {
            nodes {
              id
              name
              buyerExperienceConfiguration {
                paymentTermsTemplate { name dueInDays }
              }
              catalogs(first: 1) { nodes { id title } }
              storeCreditAccounts(first: 1) {
                nodes {
                  id
                  balance { amount currencyCode }
                  transactions(first: 250, query: "type:debit OR type:debit_revert") {
                    nodes {
                      __typename
                      amount { amount currencyCode }
                    }
                  }
                  credits: transactions(first: 250, query: "type:credit", sortKey: CREATED_AT, reverse: true) {
                    nodes { createdAt amount { amount } }
                  }
                  expiries: transactions(first: 250, query: "type:expiration") {
                    nodes { amount { amount } }
                  }
                }
              }
              salesRep: metafield(namespace: "hyve", key: "sales_rep") { value }
              salesRepEmail: metafield(namespace: "hyve", key: "sales_rep_email") { value }
              salesRepPhone: metafield(namespace: "hyve", key: "sales_rep_phone") { value }
            }
          }

          # Everyone on the company works from the same orders and quotes, so
          # these are read from the company rather than the person signed in.
          orders(first: $first, sortKey: CREATED_AT, reverse: true) {
            nodes { ...PortalOrder }
          }
          draftOrders(first: 50, sortKey: UPDATED_AT, reverse: true) {
            nodes {
              id
              order { id }
              hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
            }
          }
        }
      }

      # A shopper with no company still has their own orders.
      orders(first: $first, sortKey: CREATED_AT, reverse: true) {
        nodes { ...PortalOrder }
      }
    }

    # And their own quotes, which hang off the shop rather than the customer.
    draftOrders(first: 50, query: $draftQuery) {
      nodes {
        id
        order { id }
        hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
      }
    }
  }
  ${PORTAL_ORDER_FIELDS}`;

export async function loadAccount(admin, customerId, { first = 25 } = {}) {
  const empty = {
    customer: null,
    isDistributor: false,
    terms: null,
    orderNodes: [],
    awaitingQuotes: 0,
    failed: true,
  };
  if (!admin || !customerId) return empty;

  try {
    const response = await withTimeout(
      admin.graphql(ACCOUNT_QUERY, {
        variables: {
          id: `gid://shopify/Customer/${customerId}`,
          first,
          draftQuery: `customer_id:${String(customerId).replace(/\D/g, "")}`,
        },
      }),
      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();
    const c = body?.data?.customer;
    if (!c) {
      console.warn("[portal] account query failed", JSON.stringify(body?.errors || body));
      return empty;
    }

    const first_ = c.firstName || "";
    const last = c.lastName || "";
    const name = c.displayName || `${first_} ${last}`.trim();
    const initials =
      ((first_[0] || "") + (last[0] || "")).toUpperCase() || (name ? name[0].toUpperCase() : "");

    const orderNodes = companyOrders(c) || c.orders?.nodes || [];
    const distributor = isDistributor(c);

    // An order carries no link back to the quote it came from, but the quote
    // records the order it became — so the pairing is read from that side and
    // hung on the order for the detail view to offer the quote PDF.
    const quotes = companyQuotes(c) || body?.data?.draftOrders?.nodes || [];
    const quoteByOrder = new Map(
      quotes.filter((q) => q.order?.id).map((q) => [q.order.id, q.id]),
    );
    for (const order of orderNodes) {
      order.quoteDraftId = quoteByOrder.get(order.id) || null;
    }

    return {
      customer: {
        firstName: first_,
        name: name || "My Account",
        email: c.defaultEmailAddress?.emailAddress || "",
        initials,
        tier: catalogTier(c),
      },
      isDistributor: distributor,
      terms: distributor ? buildTerms(c, orderNodes) : null,
      orderNodes,
      // Quotes awaiting the buyer's decision, for the nav badge.
      awaitingQuotes: distributor ? quotes.filter((n) => quoteDecision(n) == null).length : 0,
      failed: false,
    };
  } catch (error) {
    console.warn("[portal] account query threw", error?.message || error);
    return empty;
  }
}

/**
 * Commercial terms for the sidebar panel (M2) and the credit card on the
 * dashboard.
 *
 * M3 asks for a date against every credit figure. The balance itself is live
 * from Shopify and can't be stale, and a store credit account carries no
 * "updated at" — so the date shown is when credit was last issued, taken from
 * the most recent credit transaction. That dates the Issued figure, which is
 * the one a buyer would ask "since when?" about.
 */
function buildTerms(customer, orderNodes) {
  const fallbackCurrency = orderNodes[0]?.totalPriceSet?.shopMoney?.currencyCode || "";

  // Everything here is real Shopify data. Payment terms come from the company
  // location's buyer experience configuration, the tier is the catalog assigned
  // to that location, and the credit figure is the location's own store credit
  // balance — Shopify's native prepaid balance, redeemed at checkout by Shopify
  // itself.
  const profiles = customer.companyContactProfiles || [];
  const location = profiles[0]?.company?.locations?.nodes?.[0] || null;

  // A buyer can be a contact on several companies, and a company can trade from
  // several locations. Orders are placed against one specific location, so
  // anything that lists a buyer's orders has to look at all of them — reading
  // only the first silently hid every order placed against any other location.
  const locationIds = profiles
    .flatMap((profile) => profile?.company?.locations?.nodes || [])
    .map((node) => node?.id)
    .filter(Boolean);

  const account = location?.storeCreditAccounts?.nodes?.[0] || null;
  const balance = account?.balance ? Number(account.balance.amount) : null;
  const currency = account?.balance?.currencyCode || fallbackCurrency;
  const used = storeCreditUsed(account);
  // Counted from the credits themselves. Working it out as "spent plus left"
  // was wrong the moment any credit expired: expiry takes money off the
  // balance without anyone spending it, so 2,000 issued with 400 spent and
  // 1,600 expired reported as 400 ever issued.
  const issued = sumAmounts(account?.credits?.nodes);
  const expired = sumAmounts(account?.expiries?.nodes);

  return {
    locationIds,
    // The saved artwork library hangs off the company, so it is shared by
    // everyone on it rather than trapped on one person's record (F4).
    companyId: profiles[0]?.company?.id || null,
    company: location ? profiles[0].company.name : "",
    paymentTerms: location?.buyerExperienceConfiguration?.paymentTermsTemplate?.name || "",
    salesRep: location?.salesRep?.value || "",
    // The rep's own contact details, so "Email Representative" and the WhatsApp
    // button reach the person named above rather than a general inbox.
    salesRepEmail: location?.salesRepEmail?.value || "",
    salesRepPhone: location?.salesRepPhone?.value || "",
    storeCredit: Number.isFinite(balance) ? formatMoney(balance, currency) : "",
    storeCreditAmount: Number.isFinite(balance) ? balance : null,
    storeCreditUsed: Number.isFinite(used) ? formatMoney(used, currency) : "",
    storeCreditUsedAmount: Number.isFinite(used) ? used : null,
    storeCreditIssued: Number.isFinite(issued) ? formatMoney(issued, currency) : "",
    storeCreditIssuedAmount: Number.isFinite(issued) ? issued : null,
    storeCreditIssuedAt: formatDate(account?.credits?.nodes?.[0]?.createdAt) || "",
    // Only shown when some has actually lapsed, so the figures add up: what was
    // issued, less what was spent, less what expired, is what is left.
    storeCreditExpired: expired > 0 ? formatMoney(expired, currency) : "",
    currency,
  };
}

/**
 * How much store credit has been spent.
 *
 * Shopify only exposes the balance, so the spend is the account's own debit
 * history: every debit, less any that were reverted. An account that has never
 * been debited returns 0, not null — nothing spent is a real answer.
 */
/** Totals a set of transactions by magnitude — Shopify signs them by direction. */
function sumAmounts(nodes) {
  if (!Array.isArray(nodes)) return null;
  return nodes.reduce((total, tx) => {
    const amount = Math.abs(Number(tx?.amount?.amount));
    return Number.isFinite(amount) ? total + amount : total;
  }, 0);
}

function storeCreditUsed(account) {
  const nodes = account?.transactions?.nodes;
  if (!Array.isArray(nodes)) return null;

  // Shopify signs these from the account's point of view: a debit is negative
  // because it takes the balance down, a revert is positive because it puts it
  // back. "Used" is the opposite view — money spent — so each amount is taken
  // by magnitude and the revert subtracts. Summing the raw values instead made
  // spend come out negative, which then made Issued smaller than the balance.
  return nodes.reduce((total, tx) => {
    const amount = Math.abs(Number(tx?.amount?.amount));
    if (!Number.isFinite(amount)) return total;
    // A revert puts credit back, so it cancels out part of the spend.
    return tx.__typename === "StoreCreditAccountDebitRevertTransaction"
      ? total - amount
      : total + amount;
  }, 0);
}

/** Reject rather than let a slow Admin API hold the proxy response open. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Admin API timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Namespace/keys the setup guide documents, re-exported for convenience. */
export { CUSTOMER_METAFIELDS };

/* -------------------------------------------------------------------------- */

const CHROME_QUERY = `#graphql
  query PortalChrome($id: ID!, $draftQuery: String!) {
    customer(id: $id) {
      firstName
      lastName
      displayName
      defaultEmailAddress { emailAddress }
      tags
      companyContactProfiles {
        isMainContact
        company {
          id
          name
          locations(first: 20) {
            nodes {
              id
              name
              buyerExperienceConfiguration {
                paymentTermsTemplate { name dueInDays }
              }
              catalogs(first: 1) { nodes { id title } }
              storeCreditAccounts(first: 1) {
                nodes {
                  id
                  balance { amount currencyCode }
                  transactions(first: 250, query: "type:debit OR type:debit_revert") {
                    nodes {
                      __typename
                      amount { amount currencyCode }
                    }
                  }
                  credits: transactions(first: 250, query: "type:credit", sortKey: CREATED_AT, reverse: true) {
                    nodes { createdAt amount { amount } }
                  }
                  expiries: transactions(first: 250, query: "type:expiration") {
                    nodes { amount { amount } }
                  }
                }
              }
              salesRep: metafield(namespace: "hyve", key: "sales_rep") { value }
              salesRepEmail: metafield(namespace: "hyve", key: "sales_rep_email") { value }
              salesRepPhone: metafield(namespace: "hyve", key: "sales_rep_phone") { value }
            }
          }

          # The badge counts have to match the pages, which show the company's
          # orders and quotes rather than the signed-in person's.
          orders(first: 50, sortKey: CREATED_AT, reverse: true) {
            nodes {
              tags
              displayFulfillmentStatus
              totalPriceSet { shopMoney { currencyCode } }
            }
          }
          draftOrders(first: 50, sortKey: UPDATED_AT, reverse: true) {
            nodes {
              id
              order { id }
              hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
            }
          }
        }
      }
      orders(first: 50, sortKey: CREATED_AT, reverse: true) {
        nodes {
          tags
          displayFulfillmentStatus
          totalPriceSet { shopMoney { currencyCode } }
        }
      }
    }

    # A shopper with no company has their own quotes, which hang off the shop
    # rather than the customer.
    draftOrders(first: 50, query: $draftQuery) {
      nodes {
        id
        order { id }
        hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
      }
    }
  }`;

/**
 * Everything the shell needs, for pages that fetch their own content.
 *
 * Without this a page can't know the customer is a distributor, so the shell
 * falls back to the B2C nav — which is what happened on the pages that render
 * their own data. Deliberately lighter than `loadAccount`: it pulls only what
 * the two nav badges need, not full order or quote detail.
 *
 * Both counts are worked out here so every page shows both badges. A page that
 * computed its own only ever lit up its own tab.
 *
 * Returns an object safe to spread into `accountShell({...})`, and `{}` when
 * anything is missing so the caller's own values stand.
 */
export async function portalChrome(admin, customerId) {
  if (!admin || !customerId) return {};

  try {
    const response = await withTimeout(
      admin.graphql(CHROME_QUERY, {
        variables: {
          id: `gid://shopify/Customer/${customerId}`,
          draftQuery: `customer_id:${String(customerId).replace(/\D/g, "")}`,
        },
      }),
      ADMIN_TIMEOUT_MS,
    );
    const body = await response.json();
    const c = body?.data?.customer;
    if (!c) return {};

    const first = c.firstName || "";
    const last = c.lastName || "";
    const name = c.displayName || `${first} ${last}`.trim();
    const orderNodes = companyOrders(c) || c.orders?.nodes || [];
    const distributor = isDistributor(c);

    const awaiting = orderNodes.filter((node) =>
      AWAITING_DISTRIBUTOR.includes(orderStatusKey(node)),
    ).length;

    // A quote needs the buyer's attention until staff mark it approved or
    // rejected, which they do with the hyve_status metafield on the draft order.
    const awaitingQuotes = (companyQuotes(c) || body?.data?.draftOrders?.nodes || []).filter(
      (node) => quoteDecision(node) == null,
    ).length;

    return {
      customer: {
        firstName: first,
        name: name || "My Account",
        email: c.defaultEmailAddress?.emailAddress || "",
        initials:
          ((first[0] || "") + (last[0] || "")).toUpperCase() ||
          (name ? name[0].toUpperCase() : ""),
        tier: catalogTier(c),
      },
      isDistributor: distributor,
      counts: { orders: awaiting, quotes: distributor ? awaitingQuotes : 0 },
      terms: distributor ? buildTerms(c, orderNodes) : null,
    };
  } catch (error) {
    console.warn("[portal] chrome query failed", error?.message || error);
    return {};
  }
}

/**
 * The company's orders, or null when this shopper has no company.
 *
 * Everyone on a company works from the same records, so the company's list is
 * the list. Returning null rather than [] keeps "no company" separate from "a
 * company with no orders yet".
 */
function companyOrders(customer) {
  const company = customer?.companyContactProfiles?.[0]?.company;
  return company ? company.orders?.nodes || [] : null;
}

/** The company's quotes, on the same terms. */
function companyQuotes(customer) {
  const company = customer?.companyContactProfiles?.[0]?.company;
  return company ? company.draftOrders?.nodes || [] : null;
}

/** The pricing tier a B2B buyer sees is the catalog on their company location (C3). */
function catalogTier(customer) {
  const location = customer?.companyContactProfiles?.[0]?.company?.locations?.nodes?.[0];
  return location?.catalogs?.nodes?.[0]?.title || "";
}
