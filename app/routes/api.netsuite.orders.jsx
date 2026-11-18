import {
  CORS_HEADERS,
  isAuthorized,
  getAdminClient,
  fetchShopifyOrders,
} from "../lib/orders-api.server.js";

export const headers = () => CORS_HEADERS;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!isAuthorized(request)) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const params = {
    updated_since: url.searchParams.get("updated_since") || undefined,
    created_since: url.searchParams.get("created_since") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    financial_status: url.searchParams.get("financial_status") || undefined,
    fulfillment_status: url.searchParams.get("fulfillment_status") || undefined,
    order_id: url.searchParams.get("order_id") || undefined,
    order_number: url.searchParams.get("order_number") || undefined,
    limit: url.searchParams.get("limit") || undefined,
    cursor: url.searchParams.get("cursor") || url.searchParams.get("after") || undefined,
    order_type: url.searchParams.get("order_type") || undefined,
    sort_direction:
      url.searchParams.get("sort_direction") || url.searchParams.get("direction") || undefined,
    query: url.searchParams.get("query") || undefined,
  };

  const shopQuery = url.searchParams.get("shop") || undefined;

  try {
    const { admin } = await getAdminClient(request, shopQuery);
    const result = await fetchShopifyOrders(admin, params);
    return json(result, 200);
  } catch (err) {
    return json({ success: false, error: err?.message || String(err) }, 500);
  }
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!isAuthorized(request)) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  let body = {};
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON body provided." }, 400);
    }
  } else if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const formData = await request.formData();
      body = Object.fromEntries(formData.entries());
    } catch {
      // fallback to empty body
    }
  }

  const params = {
    updated_since: body.updated_since ?? url.searchParams.get("updated_since") ?? undefined,
    created_since: body.created_since ?? url.searchParams.get("created_since") ?? undefined,
    from: body.from ?? url.searchParams.get("from") ?? undefined,
    to: body.to ?? url.searchParams.get("to") ?? undefined,
    financial_status:
      body.financial_status ?? url.searchParams.get("financial_status") ?? undefined,
    fulfillment_status:
      body.fulfillment_status ?? url.searchParams.get("fulfillment_status") ?? undefined,
    order_id: body.order_id ?? url.searchParams.get("order_id") ?? undefined,
    order_number: body.order_number ?? url.searchParams.get("order_number") ?? undefined,
    limit: body.limit ?? url.searchParams.get("limit") ?? undefined,
    cursor: body.cursor ?? body.after ?? url.searchParams.get("cursor") ?? url.searchParams.get("after") ?? undefined,
    order_type: body.order_type ?? url.searchParams.get("order_type") ?? undefined,
    sort_direction:
      body.sort_direction ??
      body.direction ??
      url.searchParams.get("sort_direction") ??
      url.searchParams.get("direction") ??
      undefined,
    query: body.query ?? url.searchParams.get("query") ?? undefined,
  };

  const shopQuery = body.shop ?? url.searchParams.get("shop") ?? undefined;

  try {
    const { admin } = await getAdminClient(request, shopQuery);
    const result = await fetchShopifyOrders(admin, params);
    return json(result, 200);
  } catch (err) {
    return json({ success: false, error: err?.message || String(err) }, 500);
  }
};
