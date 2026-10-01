
import { buyerQuoteNodes, DRAFT_ORIGIN_FIELDS, QUOTE_STATUSES, quoteStatus, submittedForReview } from "./account-quotes.server";
import {
  isDistributor,
  orderStatusKey,
  AWAITING_DISTRIBUTOR,
  CUSTOMER_METAFIELDS,
  orderBelongsTo,
} from "./portal.server";

const ADMIN_TIMEOUT_MS = 4000;

const PORTAL_ORDER_FIELDS = `#graphql
  fragment PortalOrder on Order {
          id
          name
          createdAt
          tags
          poNumber
          statusPageUrl
          displayFulfillmentStatus
          customer { id }
          purchasingEntity { ... on PurchasingCompany { company { id } location { id } } }
          totalPriceSet { presentmentMoney { amount currencyCode } }
          paymentTerms { paymentTermsName }
          productionStatus: metafield(namespace: "$app", key: "production_status") { value }
          productionDueAt: metafield(namespace: "$app", key: "production_due_at") { value }
          proofUrl: metafield(namespace: "$app", key: "proof_url") { value }
          onHoldReason: metafield(namespace: "$app", key: "on_hold_reason") { value }
          statusChangedAt: metafield(namespace: "$app", key: "status_changed_at") { value }
          productionPhotoUrl: metafield(namespace: "$app", key: "production_photo_url") { value }
          estimatedShipDate: metafield(namespace: "hyve", key: "estimated_ship_date") { value }
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
              originalUnitPriceSet { presentmentMoney { amount currencyCode } }
              discountedTotalSet { presentmentMoney { amount currencyCode } }
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
              catalogs(first: 2) { nodes { id title status } }
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
              status
              invoiceSentAt
              tags
              order { id }
              ${DRAFT_ORIGIN_FIELDS}
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
        status
        invoiceSentAt
        tags
        order { id }
        ${DRAFT_ORIGIN_FIELDS}
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
    reviewDraftIds: [],
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

    const orderNodes = companyOrders(c) || personalOrders(c, customerId);
    const distributor = isDistributor(c);

    // An order carries no link back to the quote it came from, but the quote
    // records the order it became — so the pairing is read from that side and
    // hung on the order for the detail view to offer the quote PDF.
    const quotes = buyerQuoteNodes(companyQuotes(c) || [], body?.data?.draftOrders?.nodes || []);
    // A terms order released after its credit review came from a draft too,
    // but that draft was the order, not a quote, so it offers no quote PDF.
    const quoteByOrder = new Map(
      quotes.filter((q) => q.order?.id && !submittedForReview(q)).map((q) => [q.order.id, q.id]),
    );
    // Terms orders still waiting on their credit review. Shopify holds them as
    // drafts until sales releases them, and Orders shows them (HYV-99).
    const reviewDraftIds = distributor
      ? quotes.filter((q) => submittedForReview(q) && q.status !== "COMPLETED" && !q.order?.id).map((q) => q.id)
      : [];
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
      terms: distributor ? buildTerms(c) : null,
      orderNodes,
      reviewDraftIds,
      // Quotes with the buyer and waiting on them, for the nav badge: the same
      // rule as the Quote Sent status on the Quotes page.
      awaitingQuotes: distributor ? quotes.filter((n) => quoteStatus(n) === QUOTE_STATUSES.SENT && !submittedForReview(n)).length : 0,
      failed: false,
    };
  } catch (error) {
    console.warn("[portal] account query threw", error?.message || error);
    return empty;
  }
}
function buildTerms(customer) {

  const profiles = customer.companyContactProfiles || [];
  const location = profiles[0]?.company?.locations?.nodes?.[0] || null;


  const locationIds = profiles
    .flatMap((profile) => profile?.company?.locations?.nodes || [])
    .map((node) => node?.id)
    .filter(Boolean);

  return {
    locationIds,
    companyId: profiles[0]?.company?.id || null,
    company: location ? profiles[0].company.name : "",
    paymentTerms: location?.buyerExperienceConfiguration?.paymentTermsTemplate?.name || "",
    salesRep: location?.salesRep?.value || "",
    salesRepEmail: location?.salesRepEmail?.value || "",
    salesRepPhone: location?.salesRepPhone?.value || "",
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Admin API timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export { CUSTOMER_METAFIELDS };

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
              catalogs(first: 2) { nodes { id title status } }
              salesRep: metafield(namespace: "hyve", key: "sales_rep") { value }
              salesRepEmail: metafield(namespace: "hyve", key: "sales_rep_email") { value }
              salesRepPhone: metafield(namespace: "hyve", key: "sales_rep_phone") { value }
            }
          }

          # The badge counts have to match the pages, which show the company's
          # orders and quotes rather than the signed-in person's. The status and
          # line properties are what tell a proof or artwork is waiting on them.
          orders(first: 50, sortKey: CREATED_AT, reverse: true) {
            nodes {
              tags
              displayFulfillmentStatus
              totalPriceSet { presentmentMoney { currencyCode } }
              productionStatus: metafield(namespace: "$app", key: "production_status") { value }
              customAttributes { key value }
              lineItems(first: 10) { nodes { customAttributes { key value } } }
            }
          }
          draftOrders(first: 50, sortKey: UPDATED_AT, reverse: true) {
            nodes {
              id
              status
              invoiceSentAt
              tags
              order { id }
              ${DRAFT_ORIGIN_FIELDS}
              hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
            }
          }
        }
      }
      orders(first: 50, sortKey: CREATED_AT, reverse: true) {
        nodes {
          tags
          displayFulfillmentStatus
          totalPriceSet { presentmentMoney { currencyCode } }
          productionStatus: metafield(namespace: "$app", key: "production_status") { value }
          customAttributes { key value }
          customer { id }
          purchasingEntity { ... on PurchasingCompany { company { id } location { id } } }
          lineItems(first: 10) { nodes { customAttributes { key value } } }
        }
      }
    }

    # A shopper with no company has their own quotes, which hang off the shop
    # rather than the customer.
    draftOrders(first: 50, query: $draftQuery) {
      nodes {
        id
        status
        invoiceSentAt
        tags
        order { id }
        ${DRAFT_ORIGIN_FIELDS}
        hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
      }
    }
  }`;


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
    const orderNodes = companyOrders(c) || personalOrders(c, customerId);
    const distributor = isDistributor(c);

    const awaiting = orderNodes.filter((node) =>
      AWAITING_DISTRIBUTOR.includes(orderStatusKey(node)),
    ).length;

      const awaitingQuotes = buyerQuoteNodes(companyQuotes(c) || [], body?.data?.draftOrders?.nodes || []).filter(
      (node) => quoteStatus(node) === QUOTE_STATUSES.SENT && !submittedForReview(node),
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
      terms: distributor ? buildTerms(c) : null,
    };
  } catch (error) {
    console.warn("[portal] chrome query failed", error?.message || error);
    return {};
  }
}

function companyOrders(customer) {
  const company = customer?.companyContactProfiles?.[0]?.company;
  return company ? company.orders?.nodes || [] : null;
}

function companyQuotes(customer) {
  const company = customer?.companyContactProfiles?.[0]?.company;
  return company ? company.draftOrders?.nodes || [] : null;
}

function personalOrders(customer, customerId) {
  const customerGid = `gid://shopify/Customer/${String(customerId).replace(/\D/g, "")}`;
  return (customer?.orders?.nodes || []).filter((order) => orderBelongsTo(order, { customerGid }));
}

function catalogTier(customer) {
  const location = customer?.companyContactProfiles?.[0]?.company?.locations?.nodes?.[0];
  return (location?.catalogs?.nodes || []).find((catalog) => catalog?.status === "ACTIVE")?.title || "";
}
