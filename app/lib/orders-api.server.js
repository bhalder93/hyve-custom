import process from "node:process";
import { authenticate, unauthenticated } from "../shopify.server.js";
import prisma from "../db.server.js";
import { zonesFromAttributes } from "./artwork-zones.server.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 250;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Hyve-Api-Key, X-Api-Key, Accept, Origin, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

export const GET_ORDERS_QUERY = `#graphql
  query GetOrders(
    $first: Int!
    $after: String
    $query: String
    $sortKey: OrderSortKeys
    $reverse: Boolean
  ) {
    orders(
      first: $first
      after: $after
      query: $query
      sortKey: $sortKey
      reverse: $reverse
    ) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      nodes {
        id
        name
        createdAt
        updatedAt
        displayFinancialStatus
        displayFulfillmentStatus
        poNumber
        currencyCode
        subtotalLineItemsQuantity
        currentTotalPriceSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        currentSubtotalPriceSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        totalTaxSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        totalDiscountsSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        tags
        statusPageUrl
        customer {
          id
          displayName
          email
          phone
        }
        purchasingEntity {
          ... on PurchasingCompany {
            company {
              id
              name
            }
            location {
              id
              name
            }
            contact {
              id
              customer {
                id
                displayName
                email
              }
            }
          }
        }
        lineItems(first: 250) {
          nodes {
            id
          }
        }
      }
    }
  }`;

/**
 * Checks if the caller is authorized via Bearer token, Hyve-Api-Key, or URL query token.
 * Reads API_TOKEN (or ORDERS_API_TOKEN) from process.env:
 * - If API_TOKEN / ORDERS_API_TOKEN is configured, requires caller to supply it (or CRON_SECRET / SHOPIFY_API_SECRET).
 * - If API_TOKEN / ORDERS_API_TOKEN is not configured, leaves the endpoint open for local development and testing.
 * @param {Request} request
 * @returns {boolean}
 */
export function isAuthorized(request) {
  const token = (process.env.API_TOKEN || process.env.ORDERS_API_TOKEN || "").trim();
  if (!token) return true;

  const authHeader = request.headers.get("authorization") || "";
  const apiKeyHeader =
    request.headers.get("hyve-api-key") ||
    request.headers.get("x-api-key") ||
    "";
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("api_key") || url.searchParams.get("token") || "";

  let bearerToken = "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    bearerToken = authHeader.slice(7).trim();
  }

  const provided = bearerToken || apiKeyHeader.trim() || queryToken.trim();
  return (
    provided === token ||
    (Boolean(process.env.CRON_SECRET) && provided === process.env.CRON_SECRET) ||
    (Boolean(process.env.SHOPIFY_API_SECRET) && provided === process.env.SHOPIFY_API_SECRET)
  );
}

/**
 * Resolves an authenticated Shopify admin GraphQL client.
 * Tries session-based authentication first, then falls back to unauthenticated admin client.
 * @param {Request} request
 * @param {string} [shopQuery]
 * @returns {Promise<{admin: object, shop: string}>}
 */
export async function getAdminClient(request, shopQuery) {
  // 1. Try session-based auth (e.g. within Shopify admin app)
  if (request) {
    try {
      const auth = await authenticate.admin(request);
      if (auth?.admin) {
        return {
          admin: auth.admin,
          shop: auth.session?.shop || process.env.SHOPIFY_SHOP || "",
        };
      }
    } catch {
      // Fallback to offline unauthenticated admin
    }
  }

  // 2. Unauthenticated admin for external API callers
  let shop = (shopQuery || process.env.SHOPIFY_SHOP || "").trim().toLowerCase();
  if (!shop || !shop.endsWith(".myshopify.com")) {
    const session = await prisma.session.findFirst({
      where: { shop: { contains: "myshopify.com" } },
      orderBy: { id: "desc" },
    });
    if (session?.shop) {
      shop = session.shop;
    }
  }

  if (!shop || !shop.endsWith(".myshopify.com")) {
    throw new Error(
      "Shopify shop domain is missing or invalid. Set SHOPIFY_SHOP in environment or supply 'shop' parameter.",
    );
  }

  const { admin } = await unauthenticated.admin(shop);
  return { admin, shop };
}

/**
 * Determines whether an order is a B2B distributor order.
 * If order customer is B2B (purchasingEntity has company), then it is a distributor order.
 * @param {object} order
 * @returns {boolean}
 */
export function isDistributorOrder(order) {
  if (order?.purchasingEntity?.company?.id || order?.purchasingEntity?.company?.name) {
    return true;
  }
  if (Array.isArray(order?.tags)) {
    const hasTag = order.tags.some((t) => {
      const lower = String(t || "").toLowerCase();
      return lower === "distributor" || lower === "b2b";
    });
    if (hasTag) return true;
  }
  return false;
}

/**
 * Returns "distributor" if B2B, otherwise "retail".
 * @param {object} order
 * @returns {"distributor"|"retail"}
 */
export function getOrderType(order) {
  return isDistributorOrder(order) ? "distributor" : "retail";
}

/**
 * Parses and bounds the requested page size between 1 and MAX_PAGE_SIZE (250).
 * Defaults to 50.
 * @param {string|number} rawLimit
 * @returns {number}
 */
export function parseLimit(rawLimit) {
  if (rawLimit === null || rawLimit === undefined || rawLimit === "") {
    return DEFAULT_PAGE_SIZE;
  }
  const parsed = parseInt(rawLimit, 10);
  if (isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * Builds the Shopify search query string for the orders connection.
 * @param {object} params
 * @returns {string}
 */
export function buildOrdersFilterQuery(params = {}) {
  const parts = [];

  // updated_since
  if (params.updated_since) {
    parts.push(`updated_at:>='${params.updated_since}'`);
  }

  // created_since or from
  if (params.created_since) {
    parts.push(`created_at:>='${params.created_since}'`);
  } else if (params.from) {
    parts.push(`created_at:>='${params.from}'`);
  }

  // to
  if (params.to) {
    parts.push(`created_at:<='${params.to}'`);
  }

  // financial_status
  if (params.financial_status) {
    const status = String(params.financial_status).trim().toLowerCase();
    parts.push(`financial_status:${status}`);
  }

  // fulfillment_status
  if (params.fulfillment_status) {
    const status = String(params.fulfillment_status).trim().toLowerCase();
    parts.push(`fulfillment_status:${status}`);
  }

  // order_id
  if (params.order_id) {
    const numericId = String(params.order_id).replace(/\D/g, "");
    if (numericId) {
      parts.push(`id:${numericId}`);
    }
  }

  // order_number (e.g. #1024 or 1024)
  if (params.order_number) {
    const rawNum = String(params.order_number).replace(/^#/, "").trim();
    if (rawNum) {
      parts.push(`name:${rawNum}`);
    }
  }

  // Free-form additional query
  if (params.query && typeof params.query === "string" && params.query.trim()) {
    parts.push(params.query.trim());
  }

  return parts.join(" ");
}

/**
 * Helper to extract MoneyV2 from MoneySet.
 * Uses presentmentMoney (the currency presented to the customer), falling back to shopMoney.
 * @param {object} moneySet
 * @returns {{amount: string|number, currencyCode: string}|null}
 */
export function getMoney(moneySet) {
  return moneySet?.presentmentMoney || moneySet?.shopMoney || null;
}

/**
 * Formats a Shopify GraphQL order node into the clean API response object.
 * Note: Does NOT return the line items array, only the count of line items.
 * @param {object} node
 * @returns {object}
 */
export function normalizeOrderNode(node) {
  const isDistributor = isDistributorOrder(node);
  const orderType = isDistributor ? "distributor" : "retail";
  const numericId = String(node?.id || "").replace(/\D/g, "");

  // Line item count: do NOT return line item details, only count
  const lineItemCount = node?.lineItems?.nodes?.length || 0;
  const totalQuantity = node?.subtotalLineItemsQuantity ?? lineItemCount;

  // Company details if B2B distributor
  const companyNode = node?.purchasingEntity?.company;
  const locationNode = node?.purchasingEntity?.location;
  const company = companyNode
    ? {
      id: companyNode.id || null,
      name: companyNode.name || null,
      location_id: locationNode?.id || null,
      location_name: locationNode?.name || null,
    }
    : null;

  // Customer details
  const customerNode = node?.purchasingEntity?.contact?.customer || node?.customer;
  const customer = customerNode
    ? {
      id: customerNode.id || null,
      name: customerNode.displayName || null,
      email: customerNode.email || null,
      phone: customerNode.phone || null,
    }
    : null;

  const priceMoney = getMoney(node?.currentTotalPriceSet);
  const currency = priceMoney?.currencyCode || node?.currencyCode || "USD";

  return {
    id: node?.id || "",
    order_id: numericId || node?.id || "",
    order_number: node?.name || "",
    order_type: orderType,
    is_distributor: isDistributor,
    created_at: node?.createdAt || null,
    updated_at: node?.updatedAt || null,
    financial_status: node?.displayFinancialStatus || "UNKNOWN",
    fulfillment_status: node?.displayFulfillmentStatus || "UNFULFILLED",
    currency,
    total_price: Number(priceMoney?.amount) || 0,
    subtotal_price: Number(getMoney(node?.currentSubtotalPriceSet)?.amount) || 0,
    total_tax: Number(getMoney(node?.totalTaxSet)?.amount) || 0,
    total_discounts: Number(getMoney(node?.totalDiscountsSet)?.amount) || 0,
    line_item_count: lineItemCount,
    total_quantity: totalQuantity,
    po_number: node?.poNumber || null,
    customer,
    company,
    tags: node?.tags || [],
    status_page_url: node?.statusPageUrl || null,
  };
}

/**
 * Fetches Shopify orders with pagination, filtering, and distributor/retail classification.
 * @param {object} admin Shopify GraphQL admin client
 * @param {object} params Filter and pagination options
 * @returns {Promise<object>}
 */
export async function fetchShopifyOrders(admin, params = {}) {
  const limit = parseLimit(params.limit);
  const cursor = params.cursor || params.after || null;
  const sortDirection = String(params.sort_direction || params.direction || "desc").toLowerCase();
  const reverse = sortDirection !== "asc"; // Default desc (most recently updated first)
  const orderTypeFilter = params.order_type ? String(params.order_type).trim().toLowerCase() : null;

  const queryString = buildOrdersFilterQuery(params);

  const orders = [];
  let currentCursor = cursor;
  let hasMore = false;
  let nextCursor = null;

  // If filtering by order_type ("retail" or "distributor"), page up to 5 iterations to satisfy requested limit
  const maxIterations = orderTypeFilter && orderTypeFilter !== "all" ? 5 : 1;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const response = await admin.graphql(GET_ORDERS_QUERY, {
      variables: {
        first: limit,
        after: currentCursor,
        query: queryString || null,
        sortKey: "UPDATED_AT",
        reverse,
      },
    });

    const json = await response.json();
    if (json.errors?.length) {
      const errMsg = json.errors.map((e) => e.message).join(", ");
      throw new Error(`Shopify GraphQL Error: ${errMsg}`);
    }

    const connection = json?.data?.orders;
    const nodes = connection?.nodes || [];
    const pageInfo = connection?.pageInfo || {};

    for (const node of nodes) {
      const normalized = normalizeOrderNode(node);
      if (
        !orderTypeFilter ||
        orderTypeFilter === "all" ||
        normalized.order_type === orderTypeFilter
      ) {
        orders.push(normalized);
        if (orders.length >= limit) break;
      }
    }

    hasMore = Boolean(pageInfo.hasNextPage);
    nextCursor = hasMore ? pageInfo.endCursor : null;
    currentCursor = pageInfo.endCursor;

    if (orders.length >= limit || !hasMore) {
      break;
    }
  }

  return {
    success: true,
    count: orders.length,
    has_more: hasMore,
    next_cursor: nextCursor,
    orders,
    pagination: {
      limit,
      count: orders.length,
      has_more: hasMore,
      next_cursor: nextCursor,
      sort_by: "updated_at",
      sort_direction: reverse ? "desc" : "asc",
    },
  };
}

export const GET_ORDER_BY_ID_QUERY = `#graphql
  query GetOrderById($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      updatedAt
      cancelledAt
      cancelReason
      displayFinancialStatus
      displayFulfillmentStatus
      currencyCode
      poNumber
      tags
      note
      statusPageUrl
      currentTotalPriceSet {
        presentmentMoney {
          amount
          currencyCode
        }
      }
      currentSubtotalPriceSet {
        presentmentMoney {
          amount
          currencyCode
        }
      }
      totalTaxSet {
        presentmentMoney {
          amount
          currencyCode
        }
      }
      totalDiscountsSet {
        presentmentMoney {
          amount
          currencyCode
        }
      }
      totalShippingPriceSet {
        presentmentMoney {
          amount
          currencyCode
        }
      }
      customAttributes {
        key
        value
      }
      customer {
        id
        displayName
        firstName
        lastName
        email
        phone
      }
      purchasingEntity {
        ... on PurchasingCompany {
          company {
            id
            name
          }
          location {
            id
            name
          }
          contact {
            id
            customer {
              id
              displayName
              email
            }
          }
        }
      }
      shippingAddress {
        name
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCodeV2
        phone
      }
      billingAddress {
        name
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCodeV2
        phone
      }
      fulfillments {
        id
        status
        createdAt
        updatedAt
        trackingInfo {
          number
          url
          company
        }
      }
      proofMetafield: metafield(namespace: "$app", key: "proof_url") {
        value
      }
      productionStatusMetafield: metafield(namespace: "$app", key: "production_status") {
        value
      }
      productionDueDateMetafield: metafield(namespace: "$app", key: "production_due_date") {
        value
      }
      proofApprovedAtMetafield: metafield(namespace: "$app", key: "proof_approved_at") {
        value
      }
      lineItems(first: 250) {
        nodes {
          id
          title
          name
          quantity
          currentQuantity
          sku
          variantTitle
          vendor
          requiresShipping
          isGiftCard
          taxable
          originalUnitPriceSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
          discountedUnitPriceSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
          originalTotalSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
          discountedTotalSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
          image {
            url
            altText
            width
            height
          }
          product {
            id
            title
            handle
            productType
            vendor
            tags
          }
          variant {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            selectedOptions {
              name
              value
            }
          }
          customAttributes {
            key
            value
          }
        }
      }
    }
  }`;

export const SEARCH_ORDER_BY_NAME_QUERY = `#graphql
  query SearchOrderByName($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        id
        name
        createdAt
        updatedAt
        cancelledAt
        cancelReason
        displayFinancialStatus
        displayFulfillmentStatus
        currencyCode
        poNumber
        tags
        note
        statusPageUrl
        currentTotalPriceSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        currentSubtotalPriceSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        totalTaxSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        totalDiscountsSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        totalShippingPriceSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        customAttributes {
          key
          value
        }
        customer {
          id
          displayName
          firstName
          lastName
          email
          phone
        }
        purchasingEntity {
          ... on PurchasingCompany {
            company {
              id
              name
            }
            location {
              id
              name
            }
            contact {
              id
              customer {
                id
                displayName
                email
              }
            }
          }
        }
        shippingAddress {
          name
          firstName
          lastName
          company
          address1
          address2
          city
          province
          provinceCode
          zip
          country
          countryCodeV2
          phone
        }
        billingAddress {
          name
          firstName
          lastName
          company
          address1
          address2
          city
          province
          provinceCode
          zip
          country
          countryCodeV2
          phone
        }
        fulfillments {
          id
          status
          createdAt
          updatedAt
          trackingInfo {
            number
            url
            company
          }
        }
        proofMetafield: metafield(namespace: "$app", key: "proof_url") {
          value
        }
        productionStatusMetafield: metafield(namespace: "$app", key: "production_status") {
          value
        }
        productionDueDateMetafield: metafield(namespace: "$app", key: "production_due_date") {
          value
        }
        proofApprovedAtMetafield: metafield(namespace: "$app", key: "proof_approved_at") {
          value
        }
        lineItems(first: 250) {
          nodes {
            id
            title
            name
            quantity
            currentQuantity
            sku
            variantTitle
            vendor
            requiresShipping
            isGiftCard
            taxable
            originalUnitPriceSet {
              presentmentMoney {
                amount
                currencyCode
              }
            }
            discountedUnitPriceSet {
              presentmentMoney {
                amount
                currencyCode
              }
            }
            originalTotalSet {
              presentmentMoney {
                amount
                currencyCode
              }
            }
            discountedTotalSet {
              presentmentMoney {
                amount
                currencyCode
              }
            }
            image {
              url
              altText
              width
              height
            }
            product {
              id
              title
              handle
              productType
              vendor
              tags
            }
            variant {
              id
              title
              sku
              barcode
              price
              compareAtPrice
              selectedOptions {
                name
                value
              }
            }
            customAttributes {
              key
              value
            }
          }
        }
      }
    }
  }`;

/**
 * Parses decoration details (method, locations, count) from line item customAttributes.
 * Handles "Full Colour Wrap", "Imprint Locations" ("Digital: BARREL, CLIP"),
 * "_imprint" JSON, and "Artwork: <method> - <location>" patterns.
 *
 * @param {Array<{key?:string, value?:string}>} attributes
 * @param {object} [line]
 * @returns {object}
 */
export function extractDecoration(attributes = [], line = null) {
  const lineProps = {};
  for (const attr of attributes || []) {
    if (attr?.key) lineProps[attr.key] = String(attr.value ?? "");
  }

  // 1. Full Colour Wrap
  if (lineProps["Full Colour Wrap"] || lineProps["_fcw"]) {
    return {
      is_decorated: true,
      method: "Full Colour Wrap",
      locations: ["Full Wrap"],
      locations_summary: "Full Colour Wrap",
      location_count: 1,
      imprint_data: null,
    };
  }

  // 2. Imprint Locations (e.g. "Digital: BARREL, CLIP" or "Laser: Front, Back" or "BARREL")
  const rawImprintLoc = lineProps["Imprint Locations"] || lineProps["Imprint Location"] || "";
  let method = "";
  let locations = [];

  if (rawImprintLoc) {
    const colonIdx = rawImprintLoc.indexOf(":");
    if (colonIdx > -1) {
      method = rawImprintLoc.slice(0, colonIdx).trim();
      locations = rawImprintLoc
        .slice(colonIdx + 1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      locations = rawImprintLoc
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  // 3. Fallback or augment with _imprint JSON
  let imprintData = null;
  if (lineProps["_imprint"]) {
    try {
      imprintData = JSON.parse(lineProps["_imprint"]);
      if (!method && imprintData?.method) {
        method = String(imprintData.method).trim();
      }
      if (locations.length === 0 && imprintData?.locations) {
        if (Array.isArray(imprintData.locations)) {
          locations = imprintData.locations.map((l) => String(l).trim()).filter(Boolean);
        }
      }
    } catch {
      // ignore JSON parse error
    }
  }

  // 4. Fallback method if still empty
  if (!method) {
    if (lineProps["Imprint Method"]) {
      method = lineProps["Imprint Method"].trim();
    } else if (lineProps["Decoration Method"]) {
      method = lineProps["Decoration Method"].trim();
    }
  }

  // 5. Check Artwork: <method> - <location> if no method/locations yet
  if (!method || locations.length === 0) {
    const artworkKeys = Object.keys(lineProps).filter((k) => /^Artwork:\s*/i.test(k));
    for (const k of artworkKeys) {
      const rest = k.replace(/^Artwork:\s*/i, "").trim();
      const dashIdx = rest.indexOf(" - ");
      if (dashIdx > -1) {
        const parsedMethod = rest.slice(0, dashIdx).trim();
        const parsedLoc = rest.slice(dashIdx + 3).trim();
        if (!method && parsedMethod) method = parsedMethod;
        if (parsedLoc && !locations.includes(parsedLoc)) locations.push(parsedLoc);
      } else if (!locations.includes(rest) && rest !== "Artwork Pending") {
        locations.push(rest);
      }
    }
  }

  const isDecorated = Boolean(method || locations.length > 0 || imprintData);
  const locationCount =
    locations.length > 0
      ? locations.length
      : imprintData?.locations && !isNaN(Number(imprintData.locations))
      ? Number(imprintData.locations)
      : method
      ? 1
      : 0;

  const locationsSummary = method
    ? locations.length > 0
      ? `${method}: ${locations.join(", ")}`
      : method
    : locations.join(", ") || null;

  return {
    is_decorated: isDecorated,
    method: method || null,
    locations,
    locations_summary: locationsSummary,
    location_count: locationCount,
    imprint_data: imprintData,
  };
}

/**
 * Extracts all artwork files for a line item from its properties and late-submitted order attributes.
 * Uses zonesFromAttributes for full compatibility with Hyve customer portal artwork uploads.
 *
 * @param {Array<{key?:string, value?:string}>} attributes Line customAttributes
 * @param {Array<{key?:string, value?:string}>} orderAttributes Order customAttributes
 * @param {string} lineId Line item GID
 * @param {object} [line] Line item object
 * @param {object} [decoration] Parsed decoration object from extractDecoration
 * @returns {Array<object>}
 */
export function extractArtworkFiles(
  attributes = [],
  orderAttributes = [],
  lineId = "",
  line = null,
  decoration = null,
) {
  const lineProps = {};
  for (const attr of attributes || []) {
    if (attr?.key) lineProps[attr.key] = String(attr.value ?? "");
  }

  const isHttpUrl = (val) => typeof val === "string" && /^https?:\/\//i.test(val.trim());

  const getFilename = (url) => {
    if (!isHttpUrl(url)) return null;
    try {
      const pathname = new URL(url).pathname;
      const base = pathname.split("/").pop();
      return base ? decodeURIComponent(base) : null;
    } catch {
      return null;
    }
  };

  const zones = zonesFromAttributes(attributes, orderAttributes, lineId, line);
  const results = [];
  const seenKeys = new Set();
  const seenUrls = new Set();

  for (const zone of zones) {
    seenKeys.add(zone.key);
    const hasUrl = isHttpUrl(zone.url);
    if (hasUrl) seenUrls.add(zone.url);

    let loc = "";
    let method = "";
    if (zone.label.includes(" — ")) {
      const parts = zone.label.split(" — ");
      method = parts[0].trim();
      loc = parts.slice(1).join(" — ").trim();
    } else if (zone.label.includes(" - ")) {
      const parts = zone.label.split(" - ");
      method = parts[0].trim();
      loc = parts.slice(1).join(" - ").trim();
    } else {
      loc = zone.label;
    }

    if (!method && decoration?.method) {
      method = decoration.method;
    }

    const filename = getFilename(zone.url);
    const isPending = !hasUrl || /artwork pending/i.test(zone.url);

    results.push({
      label: zone.label,
      location: loc || (decoration?.locations?.[0] ?? null),
      decoration_method: method || null,
      file_url: hasUrl ? zone.url : null,
      filename,
      status: isPending ? "pending" : "uploaded",
      is_supplied_later: Boolean(zone.suppliedLater),
      source: zone.suppliedLater ? "customer_portal" : "checkout",
      property_key: zone.key,
    });
  }

  // Also check if line has general "Artwork" attribute or other art URLs not captured by zones
  for (const [key, val] of Object.entries(lineProps)) {
    if (seenKeys.has(key)) continue;
    if (
      key === "Artwork" ||
      /^artwork/i.test(key) ||
      key === "_artwork_url" ||
      key === "Logo" ||
      key === "Logo URL"
    ) {
      const hasUrl = isHttpUrl(val);
      if (hasUrl && seenUrls.has(val)) continue;

      const filename = getFilename(val);
      const isPending = !hasUrl || /artwork pending/i.test(val);

      results.push({
        label: key,
        location: decoration?.locations?.[0] ?? null,
        decoration_method: decoration?.method ?? null,
        file_url: hasUrl ? val : null,
        filename,
        status: isPending ? "pending" : "uploaded",
        is_supplied_later: false,
        source: "checkout",
        property_key: key,
      });
      seenKeys.add(key);
      if (hasUrl) seenUrls.add(val);
    }
  }

  return results;
}

/**
 * Extracts design brief / instructions text from line item attributes.
 *
 * @param {Array<{key?:string, value?:string}>} attributes
 * @returns {string|null}
 */
export function extractDesignBrief(attributes = []) {
  for (const attr of attributes || []) {
    const key = String(attr?.key || "").trim().toLowerCase();
    if (
      key === "design brief" ||
      key === "artwork brief" ||
      key === "instructions" ||
      key === "special instructions" ||
      key === "imprint note" ||
      key === "imprint notes" ||
      key === "artwork note" ||
      key === "artwork notes"
    ) {
      const val = String(attr?.value || "").trim();
      if (val) return val;
    }
  }
  return null;
}

/**
 * Normalizes a single GraphQL line item node with decoration, location, and artwork details.
 *
 * @param {object} line Line item GraphQL node
 * @param {Array<{key?:string, value?:string}>} orderAttributes Order-level customAttributes
 * @returns {object}
 */
export function normalizeSingleLineItem(line, orderAttributes = []) {
  const numericId = String(line?.id || "").replace(/\D/g, "");
  const customAttributes = Array.isArray(line?.customAttributes) ? line.customAttributes : [];

  const customAttributesMap = {};
  for (const attr of customAttributes) {
    if (attr?.key) {
      customAttributesMap[attr.key] = attr.value;
    }
  }

  const decoration = extractDecoration(customAttributes, line);
  const artworkFiles = extractArtworkFiles(
    customAttributes,
    orderAttributes,
    line?.id || "",
    line,
    decoration,
  );
  const designBrief = extractDesignBrief(customAttributes);

  const origUnit = getMoney(line?.originalUnitPriceSet);
  const discUnit = getMoney(line?.discountedUnitPriceSet);
  const origTotal = getMoney(line?.originalTotalSet);
  const discTotal = getMoney(line?.discountedTotalSet);

  const unitPrice = Number(origUnit?.amount) || 0;
  const discountedUnitPrice = Number(discUnit?.amount) || unitPrice;
  const totalPrice = Number(origTotal?.amount) || 0;
  const discountedTotalPrice = Number(discTotal?.amount) || totalPrice;
  const currency =
    origUnit?.currencyCode ||
    discUnit?.currencyCode ||
    "USD";

  return {
    id: line?.id || "",
    line_item_id: numericId || line?.id || "",
    title: line?.title || "",
    name: line?.name || line?.title || "",
    sku: line?.sku || null,
    quantity: Number(line?.quantity) || 0,
    current_quantity: Number(line?.currentQuantity ?? line?.quantity) || 0,
    variant_title: line?.variantTitle || null,
    vendor: line?.vendor || null,
    requires_shipping: Boolean(line?.requiresShipping),
    taxable: Boolean(line?.taxable),
    is_gift_card: Boolean(line?.isGiftCard),
    currency,
    unit_price: unitPrice,
    discounted_unit_price: discountedUnitPrice,
    total_price: totalPrice,
    discounted_total_price: discountedTotalPrice,
    image: line?.image
      ? {
          url: line.image.url || null,
          alt_text: line.image.altText || null,
          width: line.image.width || null,
          height: line.image.height || null,
        }
      : null,
    product: line?.product
      ? {
          id: line.product.id || null,
          title: line.product.title || null,
          handle: line.product.handle || null,
          product_type: line.product.productType || null,
          vendor: line.product.vendor || null,
          tags: line.product.tags || [],
        }
      : null,
    variant: line?.variant
      ? {
          id: line.variant.id || null,
          title: line.variant.title || null,
          sku: line.variant.sku || null,
          barcode: line.variant.barcode || null,
          price: Number(line.variant.price) || null,
          selected_options: line.variant.selectedOptions || [],
        }
      : null,
    decoration,
    artwork_files: artworkFiles,
    design_brief: designBrief,
    custom_attributes: customAttributes,
    attributes_map: customAttributesMap,
  };
}

/**
 * Normalizes a full GraphQL order node into the comprehensive single order API response.
 *
 * @param {object} order Order GraphQL node
 * @returns {object|null}
 */
export function normalizeSingleOrderDetail(order) {
  if (!order) return null;

  const isDistributor = isDistributorOrder(order);
  const orderType = isDistributor ? "distributor" : "retail";
  const numericId = String(order?.id || "").replace(/\D/g, "");

  // Order custom attributes (note attributes)
  const orderAttributes = Array.isArray(order?.customAttributes) ? order.customAttributes : [];
  const orderAttributesMap = {};
  for (const attr of orderAttributes) {
    if (attr?.key) orderAttributesMap[attr.key] = attr.value;
  }

  // Customer
  const customerNode = order?.purchasingEntity?.contact?.customer || order?.customer;
  const customer = customerNode
    ? {
        id: customerNode.id || null,
        name:
          customerNode.displayName ||
          [customerNode.firstName, customerNode.lastName].filter(Boolean).join(" ") ||
          null,
        first_name: customerNode.firstName || null,
        last_name: customerNode.lastName || null,
        email: customerNode.email || null,
        phone: customerNode.phone || null,
      }
    : null;

  // Company if B2B
  const companyNode = order?.purchasingEntity?.company;
  const locationNode = order?.purchasingEntity?.location;
  const company = companyNode
    ? {
        id: companyNode.id || null,
        name: companyNode.name || null,
        location_id: locationNode?.id || null,
        location_name: locationNode?.name || null,
      }
    : null;

  // Addresses
  const formatAddress = (addr) =>
    addr
      ? {
          name: addr.name || [addr.firstName, addr.lastName].filter(Boolean).join(" ") || null,
          first_name: addr.firstName || null,
          last_name: addr.lastName || null,
          company: addr.company || null,
          address1: addr.address1 || null,
          address2: addr.address2 || null,
          city: addr.city || null,
          province: addr.province || null,
          province_code: addr.provinceCode || null,
          zip: addr.zip || null,
          country: addr.country || null,
          country_code: addr.countryCodeV2 || null,
          phone: addr.phone || null,
        }
      : null;

  // Fulfillments
  const fulfillments = (order?.fulfillments || []).map((f) => ({
    id: f.id || null,
    status: f.status || null,
    created_at: f.createdAt || null,
    updated_at: f.updatedAt || null,
    tracking_info: (f.trackingInfo || []).map((t) => ({
      number: t.number || null,
      url: t.url || null,
      company: t.company || null,
    })),
  }));

  // Line items
  const lineNodes = order?.lineItems?.nodes || [];
  const lineItems = lineNodes.map((line) => normalizeSingleLineItem(line, orderAttributes));
  const totalQuantity = lineItems.reduce((acc, item) => acc + (item.quantity || 0), 0);

  // Production metadata (from metafields)
  const production = {
    status: order?.productionStatusMetafield?.value || "order-placed",
    due_date: order?.productionDueDateMetafield?.value || null,
    proof_url: order?.proofMetafield?.value || null,
    proof_approved_at: order?.proofApprovedAtMetafield?.value || null,
  };

  const orderPrice = getMoney(order?.currentTotalPriceSet);
  const currency = orderPrice?.currencyCode || order?.currencyCode || "USD";

  return {
    id: order?.id || "",
    order_id: numericId || order?.id || "",
    order_number: order?.name || "",
    order_type: orderType,
    is_distributor: isDistributor,
    created_at: order?.createdAt || null,
    updated_at: order?.updatedAt || null,
    cancelled_at: order?.cancelledAt || null,
    cancel_reason: order?.cancelReason || null,
    financial_status: order?.displayFinancialStatus || "UNKNOWN",
    fulfillment_status: order?.displayFulfillmentStatus || "UNFULFILLED",
    currency,
    total_price: Number(orderPrice?.amount) || 0,
    subtotal_price: Number(getMoney(order?.currentSubtotalPriceSet)?.amount) || 0,
    total_tax: Number(getMoney(order?.totalTaxSet)?.amount) || 0,
    total_discounts: Number(getMoney(order?.totalDiscountsSet)?.amount) || 0,
    total_shipping: Number(getMoney(order?.totalShippingPriceSet)?.amount) || 0,
    line_item_count: lineItems.length,
    total_quantity: totalQuantity,
    po_number: order?.poNumber || null,
    note: order?.note || null,
    order_attributes: orderAttributes,
    order_attributes_map: orderAttributesMap,
    tags: order?.tags || [],
    status_page_url: order?.statusPageUrl || null,
    customer,
    company,
    shipping_address: formatAddress(order?.shippingAddress),
    billing_address: formatAddress(order?.billingAddress),
    fulfillments,
    production,
    line_items: lineItems,
  };
}

/**
 * Fetches and normalizes a single order by numeric ID, Shopify GID, or Order Name.
 *
 * @param {object} admin Shopify GraphQL admin client
 * @param {string|number} idParam Order ID, GID, or Name
 * @returns {Promise<object>}
 */
export async function fetchShopifyOrderById(admin, idParam) {
  if (!idParam) {
    throw new Error("Missing required order identifier parameter.");
  }

  const raw = String(idParam).trim();
  let orderNode = null;

  // Case 1: Full Shopify GID
  if (raw.startsWith("gid://shopify/Order/")) {
    const res = await admin.graphql(GET_ORDER_BY_ID_QUERY, {
      variables: { id: raw },
    });
    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join(", "));
    }
    orderNode = json?.data?.order;
  }
  // Case 2: Pure digits (e.g. "6123456789")
  else if (/^\d+$/.test(raw)) {
    const gid = `gid://shopify/Order/${raw}`;
    const res = await admin.graphql(GET_ORDER_BY_ID_QUERY, {
      variables: { id: gid },
    });
    const json = await res.json();
    if (!json.errors?.length && json?.data?.order) {
      orderNode = json.data.order;
    } else {
      // Fallback: It might be an order number like 1024 rather than Shopify order ID
      const searchRes = await admin.graphql(SEARCH_ORDER_BY_NAME_QUERY, {
        variables: { query: `name:${raw}` },
      });
      const searchJson = await searchRes.json();
      if (!searchJson.errors?.length) {
        orderNode = searchJson?.data?.orders?.nodes?.[0] || null;
      }
    }
  }
  // Case 3: Order name with # or alphanumeric (e.g. "#1024", "1024-A")
  else {
    const cleanName = raw.replace(/^#/, "").trim();
    const searchRes = await admin.graphql(SEARCH_ORDER_BY_NAME_QUERY, {
      variables: { query: `name:${cleanName}` },
    });
    const searchJson = await searchRes.json();
    if (searchJson.errors?.length) {
      throw new Error(searchJson.errors.map((e) => e.message).join(", "));
    }
    orderNode = searchJson?.data?.orders?.nodes?.[0] || null;
  }

  if (!orderNode) {
    return {
      success: false,
      error: `Order '${raw}' not found`,
      id: raw,
    };
  }

  const order = normalizeSingleOrderDetail(orderNode);
  return {
    success: true,
    order,
  };
}

/**
 * Common request handler for the /api/orders/:id endpoint.
 * Handles OPTIONS preflight, authorization, parameter validation, and error responses with full CORS headers.
 *
 * @param {{request: Request, params: {id?: string}}} ctx
 * @returns {Promise<Response>}
 */
export async function handleSingleOrderRequest({ request, params }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!isAuthorized(request)) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const orderId = params?.id;
  if (!orderId) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing required order ID in URL path." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }

  const url = new URL(request.url);
  const shopQuery = url.searchParams.get("shop") || undefined;

  try {
    const { admin } = await getAdminClient(request, shopQuery);
    const result = await fetchShopifyOrderById(admin, orderId);

    const status = result.success ? 200 : 404;
    return new Response(JSON.stringify(result), {
      status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        success: false,
        error: err?.message || String(err),
        id: orderId,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }
}
