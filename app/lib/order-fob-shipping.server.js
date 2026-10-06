// app/lib/order-fob-shipping.server.js

export const FOB_SHIPPING_TITLE = "FOB (Freight Arranged Separately)";
export const STOREFRONT_QUOTE_TAG = "storefront-quote";

/**
 * Checks whether an order was placed from a draft order and contains
 * the tag 'storefront-quote'.
 */
export function isStorefrontQuoteOrder(payload, order) {
  const allTags = [
    ...(order?.tags || []),
    ...(typeof payload?.tags === "string"
      ? payload.tags.split(",")
      : Array.isArray(payload?.tags)
        ? payload.tags
        : []),
  ].map((t) => String(t).trim().toLowerCase());

  const hasTag = allTags.includes(STOREFRONT_QUOTE_TAG.toLowerCase());
  if (!hasTag) return false;

  const sourceName = String(
    payload?.source_name || order?.sourceName || "",
  ).trim().toLowerCase();

  const isDraftSource =
    sourceName === "draft_order" ||
    sourceName === "shopify_draft_order" ||
    payload?.draft_order_id != null ||
    String(payload?.landing_site || "").includes("/invoices/") ||
    String(order?.sourceIdentifier || "").toLowerCase().includes("draft");

  // Having the storefront-quote tag identifies it as originating from a
  // quote draft order (whether completed via admin or checkout invoice URL).
  return hasTag;
}

/**
 * Checks whether an order already has a shipping method assigned.
 */
export function hasShippingMethod(payload, order) {
  // 1. Check payload shipping lines (webhook payload)
  if (Array.isArray(payload?.shipping_lines) && payload.shipping_lines.length > 0) {
    const title = String(payload.shipping_lines[0]?.title || "").trim();
    if (title.length > 0) return true;
  }

  // 2. Check GraphQL order single shippingLine
  if (order?.shippingLine?.title && String(order.shippingLine.title).trim().length > 0) {
    return true;
  }

  // 3. Check GraphQL order shippingLines nodes
  if (Array.isArray(order?.shippingLines?.nodes) && order.shippingLines.nodes.length > 0) {
    const title = String(order.shippingLines.nodes[0]?.title || "").trim();
    if (title.length > 0) return true;
  }

  return false;
}

const ORDER_BASIC_QUERY = `#graphql
  query OrderBasicShippingInfo($id: ID!) {
    order(id: $id) {
      id
      name
      tags
      sourceName
      sourceIdentifier
      currencyCode
      shippingLine {
        title
        originalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
      shippingLines(first: 5) {
        nodes {
          title
        }
      }
    }
  }`;

const ORDER_EDIT_BEGIN = `#graphql
  mutation OrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const ORDER_EDIT_ADD_SHIPPING_LINE = `#graphql
  mutation OrderEditAddShippingLine($id: ID!, $shippingLine: OrderEditAddShippingLineInput!) {
    orderEditAddShippingLine(id: $id, shippingLine: $shippingLine) {
      calculatedOrder {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const ORDER_EDIT_COMMIT = `#graphql
  mutation OrderEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order {
        id
        shippingLine {
          title
        }
      }
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * Adds FOB (Freight Arranged Separately) shipping method with cost 0.00
 * to an existing order using the Shopify Order Editing API.
 */
export async function addFobShippingLine(admin, orderId, currencyCode = "USD") {
  try {
    // 1. Begin order editing session
    const beginResponse = await admin.graphql(ORDER_EDIT_BEGIN, {
      variables: { id: orderId },
    });
    const beginData = await beginResponse.json();
    const calculatedOrderId = beginData?.data?.orderEditBegin?.calculatedOrder?.id;
    const beginErrors = beginData?.data?.orderEditBegin?.userErrors || [];

    if (!calculatedOrderId || beginErrors.length > 0) {
      console.warn(`[fob-shipping] orderEditBegin failed for ${orderId}:`, beginErrors);
      return {
        ok: false,
        error: beginErrors[0]?.message || "Could not begin order editing session",
      };
    }

    // 2. Add shipping line: FOB (Freight Arranged Separately) cost 0
    const addLineResponse = await admin.graphql(ORDER_EDIT_ADD_SHIPPING_LINE, {
      variables: {
        id: calculatedOrderId,
        shippingLine: {
          title: FOB_SHIPPING_TITLE,
          price: {
            amount: "0.00",
            currencyCode: currencyCode || "USD",
          },
        },
      },
    });
    const addLineData = await addLineResponse.json();
    const addLineErrors = addLineData?.data?.orderEditAddShippingLine?.userErrors || [];

    if (addLineErrors.length > 0) {
      console.warn(`[fob-shipping] orderEditAddShippingLine failed for ${orderId}:`, addLineErrors);
      return {
        ok: false,
        error: addLineErrors[0]?.message || "Could not add shipping line",
      };
    }

    // 3. Commit order edit (notifyCustomer: false so buyer is not spammed)
    const commitResponse = await admin.graphql(ORDER_EDIT_COMMIT, {
      variables: {
        id: calculatedOrderId,
        notifyCustomer: false,
        staffNote: `Added ${FOB_SHIPPING_TITLE} cost 0 for storefront quote order.`,
      },
    });
    const commitData = await commitResponse.json();
    const commitErrors = commitData?.data?.orderEditCommit?.userErrors || [];

    if (commitErrors.length > 0) {
      console.warn(`[fob-shipping] orderEditCommit failed for ${orderId}:`, commitErrors);
      return {
        ok: false,
        error: commitErrors[0]?.message || "Could not commit order edit",
      };
    }

    console.log(`[fob-shipping] Successfully added "${FOB_SHIPPING_TITLE}" (cost 0) to ${orderId}`);
    return { ok: true };
  } catch (err) {
    console.error(`[fob-shipping] Failed to add FOB shipping line to ${orderId}:`, err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Evaluates an order and adds "FOB (Freight Arranged Separately)" cost 0
 * if the order was placed from a draft order with tag 'storefront-quote'
 * and has no shipping method added.
 */
export async function checkAndAddFobShippingIfStorefrontQuote(
  admin,
  { payload, orderId, order = null },
) {
  try {
    let currentOrder = order;

    // Fetch order details if not already provided
    if (!currentOrder && orderId) {
      const resp = await admin.graphql(ORDER_BASIC_QUERY, {
        variables: { id: orderId },
      });
      const data = await resp.json();
      currentOrder = data?.data?.order;
    }

    const orderName = currentOrder?.name || payload?.name || orderId;

    // Check 1: Is this order from a storefront-quote draft order?
    if (!isStorefrontQuoteOrder(payload, currentOrder)) {
      return {
        evaluated: true,
        applied: false,
        reason: "Order is not a storefront-quote draft order",
      };
    }

    // Check 2: Does it already have a shipping method added?
    if (hasShippingMethod(payload, currentOrder)) {
      console.log(`[fob-shipping] Order ${orderName} already has a shipping method.`);
      return {
        evaluated: true,
        applied: false,
        reason: "Shipping method already present",
      };
    }

    console.log(
      `[fob-shipping] Order ${orderName} placed from storefront-quote draft order with NO shipping method. Adding "${FOB_SHIPPING_TITLE}" cost 0...`,
    );

    const currencyCode =
      currentOrder?.currencyCode || payload?.currency || "USD";

    const result = await addFobShippingLine(admin, orderId, currencyCode);

    if (result.ok && currentOrder) {
      currentOrder.shippingLine = {
        title: FOB_SHIPPING_TITLE,
        originalPriceSet: {
          shopMoney: {
            amount: "0.00",
            currencyCode,
          },
        },
      };
    }

    return { evaluated: true, applied: result.ok, ...result };
  } catch (err) {
    console.error(`[fob-shipping] Unexpected error checking/adding FOB shipping:`, err);
    return { evaluated: true, applied: false, error: err?.message || String(err) };
  }
}
