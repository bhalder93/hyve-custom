import { authenticate, unauthenticated } from "../shopify.server";
import {
  artworkFromOrderPayload,
  recordOrderArtwork,
  artworkOwnerGid,
  companyGidForCustomer,
} from "../lib/artwork.server";

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
 *
 * Input:
 * [
 *   { key: "Artwork", value: "Provided now" },
 *   { key: "Rush Production", value: "Yes" }
 * ]
 *
 * Output:
 * {
 *   Artwork: "Provided now",
 *   "Rush Production": "Yes"
 * }
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

  const normalized = String(value)
    .trim()
    .toLowerCase();

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

  const imprint = parseImprint(
    attributes["_imprint"],
  );

  /**
   * Current Hyve storefront rule:
   *
   * A line is decorated if it contains decoration/artwork
   * data.
   *
   * Blank products, like your BrüMate sample, have none
   * of these properties.
   */
  const decorated = Boolean(
    attributes["_imprint"] ||
      attributes["Imprint Locations"] ||
      attributes["Artwork"],
  );

  /**
   * Rush is already stored by the storefront as:
   *
   * Rush Production = Yes
   */
  const rush =
    String(
      attributes["Rush Production"] ?? "",
    )
      .trim()
      .toLowerCase() === "yes";

  /**
   * Find customer-uploaded artwork properties.
   *
   * Example:
   *
   * Artwork: Transfer - FRONT
   */
  const artworkFiles = Object.entries(attributes)
    .filter(([key, value]) => {
      return (
        key.startsWith("Artwork:") &&
        Boolean(value)
      );
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

    imprintMethod:
      imprint?.method ?? null,

    imprintLocationCount:
      imprint?.locations ?? 0,

    imprintLocations:
      attributes["Imprint Locations"] ??
      null,

    artworkChoice:
      attributes["Artwork"] ?? null,

    artworkStatus:
      normalizeArtworkStatus(
        attributes["Artwork"],
      ),

    designBrief:
      attributes["Design Brief"] ?? null,

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
  const response = await admin.graphql(
    GET_ORDER_QUERY,
    {
      variables: {
        id: orderGid,
      },
    },
  );

  const result = await response.json();

  if (result?.errors?.length) {
    throw new Error(
      result.errors
        .map((error) => error.message)
        .join(", "),
    );
  }

  const order = result?.data?.order;

  if (!order) {
    throw new Error(
      `Order not found: ${orderGid}`,
    );
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
async function initializeHyveOrder(
  admin,
  payload,
  shop,
) {
  const orderGid =
    payload?.admin_graphql_api_id ||
    (payload?.id
      ? `gid://shopify/Order/${payload.id}`
      : null);

  if (!orderGid) {
    console.error(
      "[orders/create] Missing order GID",
      {
        shop,
        orderId: payload?.id,
      },
    );

    return;
  }

  /**
   * Fetch the actual order structure.
   */
  const order = await getHyveOrder(
    admin,
    orderGid,
  );

  /**
   * PDF requirement:
   * ignore test orders.
   */
  if (order.test === true) {
    console.log(
      `[orders/create] ${order.name} is a test order. HYVE initialization skipped.`,
    );

    return;
  }

  const analyzedLines =
    order.lineItems?.nodes?.map(
      analyzeLineItem,
    ) ?? [];

  /**
   * If ANY line is decorated, the order requires artwork.
   *
   * Example:
   *
   * decorated
   * decorated
   * decorated
   * blank
   *
   * => artwork_required = true
   */
  const artworkRequired =
    analyzedLines.some(
      (line) => line.decorated,
    );

  /**
   * Current order-level rush rule:
   *
   * if ANY line has Rush Production = Yes
   * then hyve.rush = true
   */
  const isRushOrder =
    analyzedLines.some(
      (line) => line.rush,
    );

  console.log(
    "[orders/create] HYVE order analysis",
    {
      shop,
      orderId: order.id,
      orderName: order.name,

      artworkRequired,
      rush: isRushOrder,

      lines: analyzedLines.map(
        (line) => ({
          id: line.id,
          sku: line.sku,
          title: line.title,

          decorated:
            line.decorated,

          rush:
            line.rush,

          imprintMethod:
            line.imprintMethod,

          imprintLocations:
            line.imprintLocations,

          artworkStatus:
            line.artworkStatus,

          artworkFiles:
            line.artworkFiles.length,
        }),
      ),
    },
  );

  /**
   * -----------------------------------------------------
   * STEP 1
   * Add initial production status tag
   * -----------------------------------------------------
   */
  try {
    const response = await admin.graphql(
      TAGS_ADD_MUTATION,
      {
        variables: {
          id: order.id,

          tags: [
            "hyve-status:order-placed",
          ],
        },
      },
    );

    const result = await response.json();

    logUserErrors(
      "tagsAdd",
      result?.data?.tagsAdd
        ?.userErrors ?? [],
    );
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
   * -----------------------------------------------------
   * STEP 2
   * Set EXISTING metafield values
   * -----------------------------------------------------
   */
  try {
    const response = await admin.graphql(
      METAFIELDS_SET_MUTATION,
      {
        variables: {
          metafields: [
            /**
             * Existing definition:
             * hyve.production_status
             */
            {
              ownerId: order.id,

              namespace: "hyve",

              key:
                "production_status",

              type:
                "single_line_text_field",

              value:
                "Order Placed",
            },

            /**
             * Existing definition:
             * hyve.status_changed_at
             */
            {
              ownerId: order.id,

              namespace: "hyve",

              key:
                "status_changed_at",

              type: "date_time",

              value:
                order.createdAt,
            },

            /**
             * Existing definition:
             * hyve.artwork_required
             */
            {
              ownerId: order.id,

              namespace: "hyve",

              key:
                "artwork_required",

              type: "boolean",

              value:
                String(
                  artworkRequired,
                ),
            },

            /**
             * Existing definition:
             * hyve.rush
             */
            {
              ownerId: order.id,

              namespace: "hyve",

              key: "rush",

              type: "boolean",

              value:
                String(
                  isRushOrder,
                ),
            },
          ],
        },
      },
    );

    const result = await response.json();

    const errors =
      result?.data?.metafieldsSet
        ?.userErrors ?? [];

    const hasErrors =
      logUserErrors(
        "metafieldsSet",
        errors,
      );

    if (!hasErrors) {
      console.log(
        "[orders/create] HYVE metafields updated",
        {
          order:
            order.name,

          productionStatus:
            "Order Placed",

          statusChangedAt:
            order.createdAt,

          artworkRequired,

          rush:
            isRushOrder,
        },
      );
    }
  } catch (error) {
    console.error(
      "[orders/create] Failed setting HYVE metafields",
      {
        shop,
        order:
          order.name,

        error,
      },
    );
  }

  return {
    order,
    analyzedLines,
    artworkRequired,
    isRushOrder,
  };
}

/**
 * =========================================================
 * ORDERS_CREATE WEBHOOK
 * =========================================================
 *
 * Responsibilities:
 *
 * 1. Set Hyve production state.
 * 2. Set Hyve production metafields.
 * 3. Save uploaded artwork into Saved Artwork.
 *
 * Existing artwork functionality is preserved.
 */
export const action = async ({
  request,
}) => {
  const {
    shop,
    topic,
    payload,
  } =
    await authenticate.webhook(
      request,
    );

  console.log(
    `[${topic}] Received ${payload?.name ?? payload?.id}`,
  );

  /**
   * Webhooks do not have an online browser session.
   *
   * Open an offline Admin API context and reuse it
   * for both production initialization and artwork sync.
   */
  let admin;

  try {
    const context =
      await unauthenticated.admin(
        shop,
      );

    admin = context.admin;
  } catch (error) {
    console.error(
      "[orders/create] Could not create Admin API client",
      {
        shop,
        error,
      },
    );

    /**
     * Preserve your current strategy:
     *
     * Don't cause Shopify webhook retry storms.
     */
    return new Response();
  }

  /**
   * =====================================================
   * PART 1
   * HYVE PRODUCTION INITIALIZATION
   * =====================================================
   */
  try {
    await initializeHyveOrder(
      admin,
      payload,
      shop,
    );
  } catch (error) {
    /**
     * Do not stop artwork sync if production
     * initialization fails.
     */
    console.error(
      "[orders/create] HYVE initialization failed",
      {
        shop,
        order:
          payload?.name,

        error,
      },
    );
  }

  /**
   * =====================================================
   * PART 2
   * EXISTING SAVED ARTWORK FUNCTIONALITY
   * =====================================================
   */
  try {
    const customerId =
      payload?.customer?.id;

    /**
     * Important:
     *
     * We no longer return before HYVE initialization.
     *
     * Production initialization should work even when
     * there is no customer record.
     */
    if (!customerId) {
      console.log(
        `[${topic}] ${payload?.name}: no customer found, Saved Artwork sync skipped`,
      );

      return new Response();
    }

    const artworks =
      artworkFromOrderPayload(
        payload,
      );

    if (!artworks.length) {
      console.log(
        `[${topic}] ${payload?.name}: no uploaded artwork found`,
      );

      return new Response();
    }

    /**
     * The Saved Artwork library belongs to the company
     * where the buyer has one.
     */
    const customerGid =
      `gid://shopify/Customer/${customerId}`;

    const companyId =
      await companyGidForCustomer(
        admin,
        customerGid,
      );

    const result =
      await recordOrderArtwork(
        admin,

        artworkOwnerGid({
          companyId,
          customerId,
        }),

        artworks,

        {
          id:
            payload
              ?.admin_graphql_api_id ||
            `gid://shopify/Order/${payload.id}`,

          name:
            payload?.name ||
            `#${
              payload
                ?.order_number ||
              payload?.id
            }`,

          createdAt:
            payload?.created_at ||
            new Date().toISOString(),
        },
      );

    console.log(
      `[${topic}] ${payload?.name}: ${artworks.length} artwork file(s) recorded`,
      result.ok,
    );
  } catch (error) {
    /**
     * Preserve your original behavior:
     * never fail the Shopify webhook due to
     * Saved Artwork sync.
     */
    console.error(
      "[orders/create] artwork sync failed",
      error,
    );
  }

  return new Response();
};