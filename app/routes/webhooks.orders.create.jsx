import { authenticate, unauthenticated } from "../shopify.server";
import {
  artworkFromOrderPayload,
  recordOrderArtwork,
  artworkOwnerGid,
  companyGidForCustomer,
} from "../lib/artwork.server";

/**
 * Normalize an Admin ID to a GID.
 *
 * If it's already a GID, return as‑is.
 * If it's a numeric ID, wrap it in a gid://shopify/... GID.
 */
function toGid(resource, id) {
  if (!id) return null;
  const idStr = String(id);
  if (idStr.startsWith("gid://")) {
    return idStr;
  }
  return `gid://shopify/${resource}/${idStr}`;
}

/**
 * Query the newly created order using Admin GraphQL.
 *
 * We use GraphQL because your real order structure exposes
 * line-item properties as:
 *
 * lineItems.nodes[].customAttributes
 */
const GET_ORDER_QUERY = `#graphql
  query GetHyveOrder($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      test

      customer {
        id
        displayName
        defaultEmailAddress {
          emailAddress
        }
      }

      lineItems(first: 250) {
        nodes {
          id
          title
          sku
          quantity

          originalUnitPriceSet {
            shopMoney {
              amount
              currencyCode
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
`;

/**
 * Add tags to the Shopify order.
 */
const TAGS_ADD_MUTATION = `#graphql
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }

      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Set existing order metafield values.
 *
 * NOTE:
 * The metafield definitions already exist.
 * This mutation is only writing values to them.
 */
const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        type
        value
      }

      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Convert Shopify customAttributes into a simple object.
 */
function customAttributesToMap(customAttributes = []) {
  return customAttributes.reduce((result, attribute) => {
    if (!attribute?.key) {
      return result;
    }

    result[attribute.key] = attribute.value ?? "";

    return result;
  }, {});
}

/**
 * Safely parse the private _imprint line-item property.
 *
 * Example:
 * {"method":"Embroidery","locations":1}
 */
function parseImprint(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    console.error("[orders/create] Invalid _imprint JSON", {
      value,
      error,
    });

    return null;
  }
}

/**
 * Normalize storefront artwork choices.
 */
function normalizeArtworkStatus(value) {
  if (!value) {
    return "NOT_REQUIRED";
  }

  const normalized = String(value).trim().toLowerCase();

  switch (normalized) {
    case "design it for me":
      return "DESIGN_REQUIRED";

    case "artwork pending":
      return "PENDING";

    case "provided now":
      return "PROVIDED";

    default:
      return "UNKNOWN";
  }
}

/**
 * Analyze one line item.
 */
function analyzeLineItem(lineItem) {
  const attributes = customAttributesToMap(
    lineItem?.customAttributes ?? [],
  );

  const imprint = parseImprint(attributes["_imprint"]);

  const decorated = Boolean(
    attributes["_imprint"] ||
      attributes["Imprint Locations"] ||
      attributes["Artwork"],
  );

  const rush =
    String(attributes["Rush Production"] ?? "")
      .trim()
      .toLowerCase() === "yes";

  const artworkFiles = Object.entries(attributes)
    .filter(([key, value]) => {
      return key.startsWith("Artwork:") && Boolean(value);
    })
    .map(([key, value]) => ({
      label: key,
      url: value,
    }));

  return {
    id: lineItem?.id ?? null,
    title: lineItem?.title ?? null,
    sku: lineItem?.sku ?? null,
    quantity: lineItem?.quantity ?? 0,

    decorated,
    rush,

    imprintMethod: imprint?.method ?? null,

    imprintLocationCount: imprint?.locations ?? 0,

    imprintLocations: attributes["Imprint Locations"] ?? null,

    artworkChoice: attributes["Artwork"] ?? null,

    artworkStatus: normalizeArtworkStatus(attributes["Artwork"]),

    designBrief: attributes["Design Brief"] ?? null,

    artworkFiles,

    attributes,
  };
}

/**
 * Log Shopify GraphQL userErrors.
 */
function logUserErrors(operation, errors = []) {
  if (!errors.length) {
    return false;
  }

  console.error(
    `[orders/create] ${operation} userErrors`,
    errors,
  );

  return true;
}

/**
 * Fetch the order from Admin GraphQL.
 */
async function getHyveOrder(admin, orderGid) {
  const response = await admin.graphql(GET_ORDER_QUERY, {
    variables: {
      id: orderGid,
    },
  });

  const result = await response.json();

  if (result?.errors?.length) {
    console.error("[orders/create] getHyveOrder top-level errors", result.errors);
    throw new Error(
      result.errors.map((error) => error.message).join(", "),
    );
  }

  const order = result?.data?.order;

  if (!order) {
    throw new Error(`Order not found: ${orderGid}`);
  }

  return order;
}

/**
 * Initialize Hyve order production state.
 *
 * Existing metafield definitions:
 *
 * hyve.production_status
 * hyve.status_changed_at
 * hyve.artwork_required
 * hyve.rush
 */
async function initializeHyveOrder(admin, payload, shop) {
  const rawOrderGid =
    payload?.admin_graphql_api_id || payload?.id || null;

  const orderGid = toGid("Order", rawOrderGid);

  if (!orderGid) {
    console.error("[orders/create] Missing order GID", {
      shop,
      rawOrderId: payload?.id,
      admin_graphql_api_id: payload?.admin_graphql_api_id,
    });

    return;
  }

  console.log("[orders/create] Using order GID", {
    shop,
    orderGid,
  });

  const order = await getHyveOrder(admin, orderGid);

  if (order.test === true) {
    console.log(
      `[orders/create] ${order.name} is a test order. HYVE initialization skipped.`,
    );

    return;
  }

  const analyzedLines = order.lineItems?.nodes?.map(analyzeLineItem) ?? [];

  const artworkRequired = analyzedLines.some((line) => line.decorated);
  const isRushOrder = analyzedLines.some((line) => line.rush);

  console.log("[orders/create] HYVE order analysis", {
    shop,
    orderId: order.id,
    orderName: order.name,

    artworkRequired,
    rush: isRushOrder,

    lines: analyzedLines.map((line) => ({
      id: line.id,
      sku: line.sku,
      title: line.title,

      decorated: line.decorated,
      rush: line.rush,
      imprintMethod: line.imprintMethod,
      imprintLocations: line.imprintLocations,
      artworkStatus: line.artworkStatus,
      artworkFiles: line.artworkFiles.length,
    })),
  });

  /**
   * STEP 1: Add initial production status tag
   */
  try {
    const response = await admin.graphql(TAGS_ADD_MUTATION, {
      variables: {
        id: order.id, // already a GID from GraphQL
        tags: ["hyve-status:order-placed"],
      },
    });

    const result = await response.json();

    if (result?.errors?.length) {
      console.error("[orders/create] tagsAdd top-level errors", result.errors);
    }

    logUserErrors("tagsAdd", result?.data?.tagsAdd?.userErrors ?? []);
  } catch (error) {
    console.error(
      "[orders/create] Failed adding production status tag",
      {
        shop,
        order: order.name,
        error,
      },
    );
  }

  /**
   * STEP 2: Set EXISTING metafield values
   *
   * IMPORTANT:
   * The 'type' strings below MUST match your existing metafield definitions.
   * If they don't, metafieldsSet will return userErrors.
   */
  try {
    const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
      variables: {
        metafields: [
          {
            ownerId: order.id,
            namespace: "hyve",
            key: "production_status",
            type: "single_line_text_field",
            value: "Order Placed",
          },
          {
            ownerId: order.id,
            namespace: "hyve",
            key: "status_changed_at",
            type: "date_time",
            value: order.createdAt,
          },
          {
            ownerId: order.id,
            namespace: "hyve",
            key: "artwork_required",
            type: "boolean", // ensure your definition is also boolean
            value: String(artworkRequired), // "true" or "false"
          },
          {
            ownerId: order.id,
            namespace: "hyve",
            key: "rush",
            type: "boolean", // ensure your definition is also boolean
            value: String(isRushOrder),
          },
        ],
      },
    });

    const result = await response.json();

    if (result?.errors?.length) {
      console.error("[orders/create] metafieldsSet top-level errors", result.errors);
    }

    const errors = result?.data?.metafieldsSet?.userErrors ?? [];
    const hasErrors = logUserErrors("metafieldsSet", errors);

    if (!hasErrors) {
      console.log("[orders/create] HYVE metafields updated", {
        order: order.name,
        productionStatus: "Order Placed",
        statusChangedAt: order.createdAt,
        artworkRequired,
        rush: isRushOrder,
      });
    }
  } catch (error) {
    console.error("[orders/create] Failed setting HYVE metafields", {
      shop,
      order: order.name,
      error,
    });
  }

  return {
    order,
    analyzedLines,
    artworkRequired,
    isRushOrder,
  };
}

/**
 * ORDERS_CREATE WEBHOOK
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(
    `[${topic}] Received order`,
    {
      shop,
      admin_graphql_api_id: payload?.admin_graphql_api_id,
      id: payload?.id,
      name: payload?.name,
    },
  );

  let admin;

  try {
    const context = await unauthenticated.admin(shop);
    admin = context.admin;
  } catch (error) {
    console.error(
      "[orders/create] Could not create Admin API client",
      {
        shop,
        error,
      },
    );

    return new Response();
  }

  /**
   * PART 1: HYVE PRODUCTION INITIALIZATION
   */
  try {
    await initializeHyveOrder(admin, payload, shop);
  } catch (error) {
    console.error("[orders/create] HYVE initialization failed", {
      shop,
      order: payload?.name,
      error,
    });
  }

  /**
   * PART 2: EXISTING SAVED ARTWORK FUNCTIONALITY
   */
  try {
    const rawCustomerId = payload?.customer?.id;

    if (!rawCustomerId) {
      console.log(
        `[${topic}] ${payload?.name}: no customer found, Saved Artwork sync skipped`,
      );

      return new Response();
    }

    const customerGid = toGid("Customer", rawCustomerId);

    console.log("[orders/create] Customer IDs", {
      rawCustomerId,
      customerGid,
    });

    const artworks = artworkFromOrderPayload(payload);

    if (!artworks.length) {
      console.log(
        `[${topic}] ${payload?.name}: no uploaded artwork found`,
      );

      return new Response();
    }

    const companyId = await companyGidForCustomer(admin, customerGid);

    const orderGidForArtwork =
      payload?.admin_graphql_api_id ||
      toGid("Order", payload?.id);

    const result = await recordOrderArtwork(
      admin,
      artworkOwnerGid({
        companyId,
        customerId: rawCustomerId, // keep original behavior for your helper
      }),
      artworks,
      {
        id: orderGidForArtwork,
        name:
          payload?.name ||
          `#${payload?.order_number || payload?.id}`,
        createdAt:
          payload?.created_at || new Date().toISOString(),
      },
    );

    console.log(
      `[${topic}] ${payload?.name}: ${artworks.length} artwork file(s) recorded`,
      result.ok,
    );
  } catch (error) {
    console.error(
      "[orders/create] artwork sync failed",
      error,
    );
  }

  return new Response();
};