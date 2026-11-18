import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLimit,
  buildOrdersFilterQuery,
  isDistributorOrder,
  getOrderType,
  normalizeOrderNode,
  fetchShopifyOrders,
  isAuthorized,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  extractDecoration,
  extractArtworkFiles,
  extractDesignBrief,
  normalizeSingleLineItem,
  normalizeSingleOrderDetail,
  fetchShopifyOrderById,
  handleSingleOrderRequest,
  CORS_HEADERS,
} from "../app/lib/orders-api.server.js";

test("parseLimit handles default, custom, and maximum bounds", () => {
  assert.equal(parseLimit(null), DEFAULT_PAGE_SIZE);
  assert.equal(parseLimit(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(parseLimit(""), DEFAULT_PAGE_SIZE);
  assert.equal(parseLimit("0"), DEFAULT_PAGE_SIZE);
  assert.equal(parseLimit("-10"), DEFAULT_PAGE_SIZE);
  assert.equal(parseLimit("invalid"), DEFAULT_PAGE_SIZE);

  assert.equal(parseLimit("25"), 25);
  assert.equal(parseLimit(100), 100);
  assert.equal(parseLimit(250), 250);
  assert.equal(parseLimit("500"), MAX_PAGE_SIZE); // capped at 250
  assert.equal(parseLimit(1000), MAX_PAGE_SIZE);
});

test("buildOrdersFilterQuery constructs Shopify GraphQL order search query correctly", () => {
  // Empty params
  assert.equal(buildOrdersFilterQuery({}), "");

  // updated_since
  assert.equal(
    buildOrdersFilterQuery({ updated_since: "2026-11-01T00:00:00Z" }),
    "updated_at:>='2026-11-01T00:00:00Z'",
  );

  // created_since
  assert.equal(
    buildOrdersFilterQuery({ created_since: "2026-11-05" }),
    "created_at:>='2026-11-05'",
  );

  // from and to
  assert.equal(
    buildOrdersFilterQuery({ from: "2026-11-01", to: "2026-11-15" }),
    "created_at:>='2026-11-01' created_at:<='2026-11-15'",
  );

  // financial_status and fulfillment_status
  assert.equal(
    buildOrdersFilterQuery({ financial_status: "PAID", fulfillment_status: "UNFULFILLED" }),
    "financial_status:paid fulfillment_status:unfulfilled",
  );

  // order_id with GID or numeric
  assert.equal(
    buildOrdersFilterQuery({ order_id: "gid://shopify/Order/6123456789" }),
    "id:6123456789",
  );
  assert.equal(buildOrdersFilterQuery({ order_id: "987654321" }), "id:987654321");

  // order_number with and without #
  assert.equal(buildOrdersFilterQuery({ order_number: "#1024" }), "name:1024");
  assert.equal(buildOrdersFilterQuery({ order_number: "2048" }), "name:2048");

  // combined query
  const combined = buildOrdersFilterQuery({
    updated_since: "2026-11-10T10:00:00Z",
    financial_status: "paid",
    fulfillment_status: "unfulfilled",
    order_number: "#1050",
  });
  assert.ok(combined.includes("updated_at:>='2026-11-10T10:00:00Z'"));
  assert.ok(combined.includes("financial_status:paid"));
  assert.ok(combined.includes("fulfillment_status:unfulfilled"));
  assert.ok(combined.includes("name:1050"));
});

test("isDistributorOrder and getOrderType distinguish B2B distributor vs retail orders", () => {
  // B2B order with purchasingEntity.company
  const b2bOrder = {
    id: "gid://shopify/Order/1",
    purchasingEntity: {
      company: { id: "gid://shopify/Company/100", name: "Apex Distributing" },
      location: { id: "gid://shopify/CompanyLocation/200", name: "HQ" },
    },
  };
  assert.equal(isDistributorOrder(b2bOrder), true);
  assert.equal(getOrderType(b2bOrder), "distributor");

  // Retail D2C order without company
  const retailOrder = {
    id: "gid://shopify/Order/2",
    customer: { id: "gid://shopify/Customer/50", displayName: "Alice Wong" },
  };
  assert.equal(isDistributorOrder(retailOrder), false);
  assert.equal(getOrderType(retailOrder), "retail");

  // Order with B2B / distributor tag
  const taggedOrder = {
    id: "gid://shopify/Order/3",
    tags: ["b2b", "hyve-portal"],
  };
  assert.equal(isDistributorOrder(taggedOrder), true);
  assert.equal(getOrderType(taggedOrder), "distributor");
});

test("normalizeOrderNode formats order without returning line items details, sending line item count", () => {
  const mockNode = {
    id: "gid://shopify/Order/6123456789",
    name: "#1024",
    createdAt: "2026-11-10T12:00:00Z",
    updatedAt: "2026-11-15T15:30:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    poNumber: "PO-9912",
    currencyCode: "USD",
    subtotalLineItemsQuantity: 150,
    currentTotalPriceSet: { presentmentMoney: { amount: "1500.00", currencyCode: "USD" } },
    currentSubtotalPriceSet: { presentmentMoney: { amount: "1400.00", currencyCode: "USD" } },
    totalTaxSet: { presentmentMoney: { amount: "100.00", currencyCode: "USD" } },
    totalDiscountsSet: { presentmentMoney: { amount: "0.00", currencyCode: "USD" } },
    tags: ["b2b", "fast-shipping"],
    statusPageUrl: "https://checkout.shopify.com/status/123",
    customer: {
      id: "gid://shopify/Customer/555",
      displayName: "Jane Doe",
      email: "jane@example.com",
      phone: "+6591234567",
    },
    purchasingEntity: {
      company: { id: "gid://shopify/Company/888", name: "Hyve Partner Co" },
      location: { id: "gid://shopify/CompanyLocation/999", name: "Main Hub" },
      contact: {
        customer: { id: "gid://shopify/Customer/555", displayName: "Jane Doe", email: "jane@example.com" },
      },
    },
    lineItems: {
      nodes: [{ id: "gid://shopify/LineItem/1" }, { id: "gid://shopify/LineItem/2" }, { id: "gid://shopify/LineItem/3" }],
    },
  };

  const normalized = normalizeOrderNode(mockNode);

  assert.equal(normalized.id, "gid://shopify/Order/6123456789");
  assert.equal(normalized.order_id, "6123456789");
  assert.equal(normalized.order_number, "#1024");
  assert.equal(normalized.order_type, "distributor");
  assert.equal(normalized.is_distributor, true);
  assert.equal(normalized.financial_status, "PAID");
  assert.equal(normalized.fulfillment_status, "UNFULFILLED");
  assert.equal(normalized.currency, "USD");
  assert.equal(normalized.total_price, 1500);
  assert.equal(normalized.subtotal_price, 1400);
  assert.equal(normalized.total_tax, 100);
  assert.equal(normalized.total_discounts, 0);

  // Line items count verification
  assert.equal(normalized.line_item_count, 3);
  assert.equal(normalized.total_quantity, 150);
  assert.equal(normalized.line_items, undefined); // Line items array must NOT be in the response

  // Customer and company
  assert.equal(normalized.customer.name, "Jane Doe");
  assert.equal(normalized.customer.email, "jane@example.com");
  assert.equal(normalized.company.name, "Hyve Partner Co");
  assert.equal(normalized.company.location_name, "Main Hub");
  assert.equal(normalized.po_number, "PO-9912");
});

test("fetchShopifyOrders executes query with sort by UPDATED_AT, pagination, and filters", async () => {
  let executedQuery = null;
  let executedVariables = null;

  const mockAdmin = {
    graphql: async (query, { variables } = {}) => {
      executedQuery = query;
      executedVariables = variables;
      return {
        json: async () => ({
          data: {
            orders: {
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor_abc_123",
              },
              nodes: [
                {
                  id: "gid://shopify/Order/1001",
                  name: "#1001",
                  createdAt: "2026-11-10T00:00:00Z",
                  updatedAt: "2026-11-16T12:00:00Z",
                  displayFinancialStatus: "PAID",
                  displayFulfillmentStatus: "FULFILLED",
                  currencyCode: "USD",
                  currentTotalPriceSet: { presentmentMoney: { amount: "250.00" } },
                  purchasingEntity: {
                    company: { id: "gid://shopify/Company/1", name: "Distributor One" },
                  },
                  lineItems: { nodes: [{ id: "li1" }, { id: "li2" }] },
                },
                {
                  id: "gid://shopify/Order/1002",
                  name: "#1002",
                  createdAt: "2026-11-12T00:00:00Z",
                  updatedAt: "2026-11-15T09:00:00Z",
                  displayFinancialStatus: "PENDING",
                  displayFulfillmentStatus: "UNFULFILLED",
                  currencyCode: "USD",
                  currentTotalPriceSet: { presentmentMoney: { amount: "80.00" } },
                  customer: { id: "gid://shopify/Customer/2", displayName: "Retail Buyer" },
                  lineItems: { nodes: [{ id: "li3" }] },
                },
              ],
            },
          },
        }),
      };
    },
  };

  const res = await fetchShopifyOrders(mockAdmin, {
    limit: "25",
    cursor: "start_cur",
    updated_since: "2026-11-01T00:00:00Z",
    financial_status: "paid",
  });

  assert.equal(res.success, true);
  assert.equal(res.count, 2);
  assert.equal(res.has_more, true);
  assert.equal(res.next_cursor, "cursor_abc_123");
  assert.equal(res.pagination.limit, 25);
  assert.equal(res.pagination.sort_by, "updated_at");

  // Check GraphQL query variables
  assert.equal(executedVariables.first, 25);
  assert.equal(executedVariables.after, "start_cur");
  assert.equal(executedVariables.sortKey, "UPDATED_AT");
  assert.ok(executedVariables.query.includes("updated_at:>='2026-11-01T00:00:00Z'"));
  assert.ok(executedVariables.query.includes("financial_status:paid"));

  // Check orders data
  assert.equal(res.orders[0].order_number, "#1001");
  assert.equal(res.orders[0].order_type, "distributor");
  assert.equal(res.orders[0].line_item_count, 2);
  assert.equal(res.orders[0].line_items, undefined);

  assert.equal(res.orders[1].order_number, "#1002");
  assert.equal(res.orders[1].order_type, "retail");
  assert.equal(res.orders[1].line_item_count, 1);
});

test("fetchShopifyOrders filters by order_type correctly", async () => {
  const mockAdmin = {
    graphql: async () => ({
      json: async () => ({
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/Order/1",
                name: "#1",
                purchasingEntity: { company: { id: "c1", name: "Company" } },
                lineItems: { nodes: [] },
              },
              {
                id: "gid://shopify/Order/2",
                name: "#2",
                customer: { id: "cust1" },
                lineItems: { nodes: [] },
              },
            ],
          },
        },
      }),
    }),
  };

  const distOnly = await fetchShopifyOrders(mockAdmin, { order_type: "distributor" });
  assert.equal(distOnly.orders.length, 1);
  assert.equal(distOnly.orders[0].order_number, "#1");
  assert.equal(distOnly.orders[0].order_type, "distributor");

  const retailOnly = await fetchShopifyOrders(mockAdmin, { order_type: "retail" });
  assert.equal(retailOnly.orders.length, 1);
  assert.equal(retailOnly.orders[0].order_number, "#2");
  assert.equal(retailOnly.orders[0].order_type, "retail");
});

test("isAuthorized validates Bearer token, x-api-key, and query token against env", () => {
  const origApiToken = process.env.API_TOKEN;
  const origOrdersToken = process.env.ORDERS_API_TOKEN;
  const origCronSecret = process.env.CRON_SECRET;

  // When API_TOKEN and ORDERS_API_TOKEN are unset, leaves open for dev/testing
  delete process.env.API_TOKEN;
  delete process.env.ORDERS_API_TOKEN;
  const unauthReq = new Request("https://example.com/api/orders", {
    headers: { authorization: "" },
  });
  assert.equal(isAuthorized(unauthReq), true);

  // When API_TOKEN is set, enforce validation
  process.env.API_TOKEN = "test-secret-123";

  // Valid bearer
  const req1 = new Request("https://example.com/api/orders", {
    headers: { authorization: "Bearer test-secret-123" },
  });
  assert.equal(isAuthorized(req1), true);

  // Valid Hyve-Api-Key
  const reqHyveKey = new Request("https://example.com/api/orders", {
    headers: { "hyve-api-key": "test-secret-123" },
  });
  assert.equal(isAuthorized(reqHyveKey), true);

  // Valid x-api-key (backwards compatibility)
  const req2 = new Request("https://example.com/api/orders", {
    headers: { "x-api-key": "test-secret-123" },
  });
  assert.equal(isAuthorized(req2), true);

  // Valid query param
  const req3 = new Request("https://example.com/api/orders?api_key=test-secret-123");
  assert.equal(isAuthorized(req3), true);

  // Invalid token
  const req4 = new Request("https://example.com/api/orders", {
    headers: { authorization: "Bearer wrong-token" },
  });
  assert.equal(isAuthorized(req4), false);

  // Empty header when token is configured
  const req5 = new Request("https://example.com/api/orders", {
    headers: { authorization: "" },
  });
  assert.equal(isAuthorized(req5), false);

  // Cleanup
  if (origApiToken !== undefined) process.env.API_TOKEN = origApiToken;
  else delete process.env.API_TOKEN;
  if (origOrdersToken !== undefined) process.env.ORDERS_API_TOKEN = origOrdersToken;
  else delete process.env.ORDERS_API_TOKEN;
  if (origCronSecret !== undefined) process.env.CRON_SECRET = origCronSecret;
  else delete process.env.CRON_SECRET;
});

test("extractDecoration correctly parses decoration method, locations, and count", () => {
  // 1. Digital on BARREL
  const digitalDecor = extractDecoration([
    { key: "Imprint Locations", value: "Digital: BARREL" },
  ]);
  assert.equal(digitalDecor.is_decorated, true);
  assert.equal(digitalDecor.method, "Digital");
  assert.deepEqual(digitalDecor.locations, ["BARREL"]);
  assert.equal(digitalDecor.locations_summary, "Digital: BARREL");
  assert.equal(digitalDecor.location_count, 1);

  // 2. Laser multi-position (Front, Back)
  const laserDecor = extractDecoration([
    { key: "Imprint Locations", value: "Laser: Front, Back" },
  ]);
  assert.equal(laserDecor.is_decorated, true);
  assert.equal(laserDecor.method, "Laser");
  assert.deepEqual(laserDecor.locations, ["Front", "Back"]);
  assert.equal(laserDecor.locations_summary, "Laser: Front, Back");
  assert.equal(laserDecor.location_count, 2);

  // 3. Full Colour Wrap
  const wrapDecor = extractDecoration([{ key: "Full Colour Wrap", value: "true" }]);
  assert.equal(wrapDecor.is_decorated, true);
  assert.equal(wrapDecor.method, "Full Colour Wrap");
  assert.deepEqual(wrapDecor.locations, ["Full Wrap"]);
  assert.equal(wrapDecor.locations_summary, "Full Colour Wrap");
  assert.equal(wrapDecor.location_count, 1);

  // 4. Fallback _imprint JSON
  const jsonDecor = extractDecoration([
    { key: "_imprint", value: JSON.stringify({ method: "Screen Print", locations: ["Side A", "Side B"] }) },
  ]);
  assert.equal(jsonDecor.is_decorated, true);
  assert.equal(jsonDecor.method, "Screen Print");
  assert.deepEqual(jsonDecor.locations, ["Side A", "Side B"]);
  assert.equal(jsonDecor.location_count, 2);

  // 5. Undecorated / Blank item
  const blankDecor = extractDecoration([]);
  assert.equal(blankDecor.is_decorated, false);
  assert.equal(blankDecor.method, null);
  assert.deepEqual(blankDecor.locations, []);
  assert.equal(blankDecor.location_count, 0);
});

test("extractArtworkFiles handles immediate checkout files and portal late uploads", () => {
  const line = {
    id: "gid://shopify/LineItem/5001",
    title: "MagSnap Key Cable",
    variantTitle: "Black",
  };

  // Immediate upload at checkout
  const immediateAttrs = [
    { key: "Imprint Locations", value: "Digital: BARREL" },
    { key: "Artwork: Digital - BARREL", value: "https://cdn.shopify.com/files/logo_barrel.pdf" },
  ];
  const files1 = extractArtworkFiles(immediateAttrs, [], line.id, line);
  assert.equal(files1.length, 1);
  assert.equal(files1[0].location, "BARREL");
  assert.equal(files1[0].decoration_method, "Digital");
  assert.equal(files1[0].file_url, "https://cdn.shopify.com/files/logo_barrel.pdf");
  assert.equal(files1[0].filename, "logo_barrel.pdf");
  assert.equal(files1[0].status, "uploaded");
  assert.equal(files1[0].is_supplied_later, false);
  assert.equal(files1[0].source, "checkout");

  // Late upload after order placement (saved on order attributes)
  const pendingAttrs = [
    { key: "Imprint Locations", value: "Digital: BARREL" },
    { key: "Artwork: Digital - BARREL", value: "Artwork Pending" },
  ];
  const orderAttrs = [
    {
      key: "MagSnap Key Cable — Black, Digital — BARREL",
      value: "https://cdn.shopify.com/files/customer_upload_later.ai",
    },
  ];
  const files2 = extractArtworkFiles(pendingAttrs, orderAttrs, line.id, line);
  assert.equal(files2.length, 1);
  assert.equal(files2[0].file_url, "https://cdn.shopify.com/files/customer_upload_later.ai");
  assert.equal(files2[0].filename, "customer_upload_later.ai");
  assert.equal(files2[0].status, "uploaded");
  assert.equal(files2[0].is_supplied_later, true);
  assert.equal(files2[0].source, "customer_portal");
});

test("extractDesignBrief pulls instructions from custom attributes", () => {
  assert.equal(
    extractDesignBrief([
      { key: "Design Brief", value: "Please engrave logo centered 2cm from clip" },
    ]),
    "Please engrave logo centered 2cm from clip",
  );

  assert.equal(
    extractDesignBrief([
      { key: "Instructions", value: "PMS 286 Blue imprint required" },
    ]),
    "PMS 286 Blue imprint required",
  );

  assert.equal(extractDesignBrief([]), null);
});

test("normalizeSingleOrderDetail formats full order structure with line item decoration and artwork", () => {
  const mockOrder = {
    id: "gid://shopify/Order/6123456789",
    name: "#1024",
    createdAt: "2026-11-15T12:00:00Z",
    updatedAt: "2026-11-16T14:30:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    currencyCode: "USD",
    currentTotalPriceSet: { presentmentMoney: { amount: "1250.00", currencyCode: "USD" } },
    currentSubtotalPriceSet: { presentmentMoney: { amount: "1150.00", currencyCode: "USD" } },
    totalTaxSet: { presentmentMoney: { amount: "100.00", currencyCode: "USD" } },
    totalDiscountsSet: { presentmentMoney: { amount: "0.00", currencyCode: "USD" } },
    totalShippingPriceSet: { presentmentMoney: { amount: "0.00", currencyCode: "USD" } },
    poNumber: "PO-9999",
    tags: ["VIP", "rush"],
    note: "Rush shipment required",
    statusPageUrl: "https://shop.myshopify.com/orders/status",
    customAttributes: [
      { key: "Order Type", value: "Corporate Event" },
    ],
    customer: {
      id: "gid://shopify/Customer/888",
      displayName: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@company.com",
      phone: "+1234567890",
    },
    purchasingEntity: {
      company: { id: "gid://shopify/Company/444", name: "Acme Corp" },
      location: { id: "gid://shopify/CompanyLocation/555", name: "Main Office" },
    },
    shippingAddress: {
      name: "Jane Doe",
      address1: "123 Business Way",
      city: "New York",
      province: "NY",
      zip: "10001",
      country: "United States",
      countryCodeV2: "US",
    },
    proofMetafield: { value: "https://cdn.shopify.com/proofs/proof-1024.pdf" },
    productionStatusMetafield: { value: "in-production" },
    productionDueDateMetafield: { value: "2026-11-25" },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/7001",
          title: "Satin Pen",
          name: "Satin Pen - Matte Black",
          quantity: 250,
          currentQuantity: 250,
          sku: "PEN-SAT-BLK",
          variantTitle: "Matte Black",
          originalUnitPriceSet: { presentmentMoney: { amount: "4.60", currencyCode: "USD" } },
          originalTotalSet: { presentmentMoney: { amount: "1150.00", currencyCode: "USD" } },
          customAttributes: [
            { key: "Imprint Locations", value: "Digital: BARREL" },
            { key: "Artwork: Digital - BARREL", value: "https://cdn.shopify.com/files/pen_art.png" },
            { key: "Design Brief", value: "White imprint on black pen body" },
          ],
        },
      ],
    },
  };

  const formatted = normalizeSingleOrderDetail(mockOrder);
  assert.equal(formatted.order_id, "6123456789");
  assert.equal(formatted.order_number, "#1024");
  assert.equal(formatted.order_type, "distributor");
  assert.equal(formatted.is_distributor, true);
  assert.equal(formatted.total_price, 1250);
  assert.equal(formatted.company.name, "Acme Corp");
  assert.equal(formatted.production.status, "in-production");
  assert.equal(formatted.production.proof_url, "https://cdn.shopify.com/proofs/proof-1024.pdf");

  assert.equal(formatted.line_items.length, 1);
  const line = formatted.line_items[0];
  assert.equal(line.line_item_id, "7001");
  assert.equal(line.sku, "PEN-SAT-BLK");
  assert.equal(line.decoration.is_decorated, true);
  assert.equal(line.decoration.method, "Digital");
  assert.deepEqual(line.decoration.locations, ["BARREL"]);
  assert.equal(line.decoration.locations_summary, "Digital: BARREL");
  assert.equal(line.artwork_files.length, 1);
  assert.equal(line.artwork_files[0].location, "BARREL");
  assert.equal(line.artwork_files[0].file_url, "https://cdn.shopify.com/files/pen_art.png");
  assert.equal(line.artwork_files[0].filename, "pen_art.png");
  assert.equal(line.design_brief, "White imprint on black pen body");
});

test("fetchShopifyOrderById supports numeric ID, GID, and Order Name", async () => {
  const dummyOrder = {
    id: "gid://shopify/Order/999111",
    name: "#1099",
    createdAt: "2026-11-15T00:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    lineItems: { nodes: [] },
  };

  const mockAdmin = {
    graphql: async (query, { variables }) => {
      // By ID or GID
      if (variables?.id === "gid://shopify/Order/999111") {
        return {
          json: async () => ({
            data: { order: dummyOrder },
          }),
        };
      }
      // By Name
      if (variables?.query === "name:1099" || variables?.query === "name:#1099") {
        return {
          json: async () => ({
            data: { orders: { nodes: [dummyOrder] } },
          }),
        };
      }
      return {
        json: async () => ({
          data: { order: null, orders: { nodes: [] } },
        }),
      };
    },
  };

  // Test numeric ID
  const res1 = await fetchShopifyOrderById(mockAdmin, "999111");
  assert.equal(res1.success, true);
  assert.equal(res1.order.order_number, "#1099");

  // Test full GID
  const res2 = await fetchShopifyOrderById(mockAdmin, "gid://shopify/Order/999111");
  assert.equal(res2.success, true);
  assert.equal(res2.order.order_id, "999111");

  // Test Order Name with #
  const res3 = await fetchShopifyOrderById(mockAdmin, "#1099");
  assert.equal(res3.success, true);
  assert.equal(res3.order.order_number, "#1099");

  // Test Not Found
  const res4 = await fetchShopifyOrderById(mockAdmin, "99999999");
  assert.equal(res4.success, false);
  assert.ok(res4.error.includes("not found"));
});

test("CORS_HEADERS includes essential cross-origin preflight headers", () => {
  assert.equal(CORS_HEADERS["Access-Control-Allow-Origin"], "*");
  assert.ok(CORS_HEADERS["Access-Control-Allow-Methods"].includes("GET"));
  assert.ok(CORS_HEADERS["Access-Control-Allow-Methods"].includes("OPTIONS"));
  assert.ok(CORS_HEADERS["Access-Control-Allow-Headers"].includes("Authorization"));
  assert.ok(CORS_HEADERS["Access-Control-Allow-Headers"].includes("Hyve-Api-Key"));
});

test("handleSingleOrderRequest handles OPTIONS preflight with 204 No Content and CORS headers", async () => {
  // OPTIONS preflight
  const optionsReq = new Request("https://example.com/api/orders/1024", {
    method: "OPTIONS",
  });
  const optRes = await handleSingleOrderRequest({ request: optionsReq, params: { id: "1024" } });
  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers.get("access-control-allow-origin"), "*");
  assert.equal(optRes.headers.get("access-control-max-age"), "86400");
});

test("handleSingleOrderRequest returns 400 when id param is missing", async () => {
  const token = process.env.API_TOKEN || process.env.ORDERS_API_TOKEN || "test-token";
  const req = new Request("https://example.com/api/orders/", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  const res = await handleSingleOrderRequest({ request: req, params: {} });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const json = await res.json();
  assert.equal(json.success, false);
  assert.ok(json.error.includes("Missing required order ID"));
});

test("handleSingleOrderRequest returns 401 when API_TOKEN is configured and unauthorized", async () => {
  const origToken = process.env.API_TOKEN;
  process.env.API_TOKEN = "mandatory-secret-token";

  const unauthReq = new Request("https://example.com/api/orders/1024", {
    method: "GET",
    headers: { authorization: "Bearer invalid-token" },
  });
  const res = await handleSingleOrderRequest({ request: unauthReq, params: { id: "1024" } });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const json = await res.json();
  assert.equal(json.success, false);
  assert.equal(json.error, "Unauthorized");

  if (origToken !== undefined) process.env.API_TOKEN = origToken;
  else delete process.env.API_TOKEN;
});

test("normalizeOrderNode and normalizeSingleLineItem prioritize presentmentMoney over shopMoney", () => {
  const multiCurrencyOrder = {
    id: "gid://shopify/Order/777",
    name: "#777",
    currencyCode: "USD",
    currentTotalPriceSet: {
      shopMoney: { amount: "100.00", currencyCode: "USD" },
      presentmentMoney: { amount: "135.00", currencyCode: "SGD" },
    },
    currentSubtotalPriceSet: {
      shopMoney: { amount: "90.00", currencyCode: "USD" },
      presentmentMoney: { amount: "120.00", currencyCode: "SGD" },
    },
    totalTaxSet: {
      shopMoney: { amount: "10.00", currencyCode: "USD" },
      presentmentMoney: { amount: "15.00", currencyCode: "SGD" },
    },
    lineItems: { nodes: [] },
  };

  const normalized = normalizeOrderNode(multiCurrencyOrder);
  assert.equal(normalized.currency, "SGD");
  assert.equal(normalized.total_price, 135);
  assert.equal(normalized.subtotal_price, 120);
  assert.equal(normalized.total_tax, 15);

  const multiCurrencyLine = {
    id: "gid://shopify/LineItem/888",
    title: "Test Item",
    quantity: 1,
    originalUnitPriceSet: {
      shopMoney: { amount: "90.00", currencyCode: "USD" },
      presentmentMoney: { amount: "120.00", currencyCode: "SGD" },
    },
    originalTotalSet: {
      shopMoney: { amount: "90.00", currencyCode: "USD" },
      presentmentMoney: { amount: "120.00", currencyCode: "SGD" },
    },
  };

  const normalizedLine = normalizeSingleLineItem(multiCurrencyLine, []);
  assert.equal(normalizedLine.currency, "SGD");
  assert.equal(normalizedLine.unit_price, 120);
  assert.equal(normalizedLine.total_price, 120);
});
