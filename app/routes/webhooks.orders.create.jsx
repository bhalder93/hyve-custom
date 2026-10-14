// app/routes/webhooks.orders.create.jsx
/* global process */

import { authenticate } from "../shopify.server";
import { checkAndAddFobShippingIfStorefrontQuote } from "../lib/order-fob-shipping.server";
import { removeCheckoutWorkingFields } from "../lib/order-internal-fields.server";
import { CUSTOMER_ARRANGED_FREIGHT_TAG } from "../lib/production-statuses";
import { holdOrderForCreditReview } from "../lib/credit-review.server";
import { productionCalendar, productionDueDate } from "../lib/order-status.server";

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

const ORDER_STATUS = "order-placed";

function isFobShipping(payload, order) {
  const titles = [];

  if (order?.shippingLine?.title) {
    titles.push(order.shippingLine.title);
  }

  if (Array.isArray(order?.shippingLines?.nodes)) {
    for (const node of order.shippingLines.nodes) {
      if (node?.title) titles.push(node.title);
    }
  }

  if (Array.isArray(payload?.shipping_lines)) {
    for (const line of payload.shipping_lines) {
      if (line?.title) titles.push(line.title);
    }
  }

  return titles.some((title) => /FOB/i.test(String(title || "").trim()));
}

/* -------------------------------------------------------------------------- */
/*                              GraphQL helpers                               */
/* -------------------------------------------------------------------------- */

async function parseGraphQLResponse(response, operationName) {
  const data = await response.json();

  if (data.errors?.length) {
    console.error(`${operationName} GraphQL errors:`, data.errors);

    throw new Error(data.errors.map((error) => error.message).join(", "));
  }

  return data;
}

function throwUserErrors(userErrors, operationName) {
  if (!userErrors?.length) {
    return;
  }

  console.error(`${operationName} user errors:`, userErrors);

  throw new Error(userErrors.map((error) => error.message).join(", "));
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getOrderGid(payload) {
  if (payload?.admin_graphql_api_id) {
    return payload.admin_graphql_api_id;
  }

  if (payload?.id) {
    return `gid://shopify/Order/${payload.id}`;
  }

  return null;
}

function getNumericOrderId(orderId) {
  return String(orderId || "")
    .split("/")
    .pop();
}

/* -------------------------------------------------------------------------- */
/*                          Line item attribute helpers                       */
/* -------------------------------------------------------------------------- */

function getAttribute(lineItem, attributeKey) {
  const target = normalize(attributeKey);

  return (
    lineItem.customAttributes?.find(
      (attribute) => normalize(attribute.key) === target,
    ) || null
  );
}

function hasTruthyAttribute(lineItem, attributeKey) {
  const attribute = getAttribute(lineItem, attributeKey);

  if (!attribute) {
    return false;
  }

  const value = normalize(attribute.value);

  return ["yes", "true", "1", "y"].includes(value);
}

/* -------------------------------------------------------------------------- */
/*                              Blank order rule                              */
/* -------------------------------------------------------------------------- */

/**
 * Business rule:
 *
 * If EVERY line item has zero customAttributes,
 * the order is a blank order.
 *
 * Blank orders:
 * - are not production orders
 * - do not get hyve-status:order-placed
 * - do not get production_status
 * - do not get status_changed_at
 * - do not get production status history
 * - should not appear in Production Orders
 * - should not be processed by SLA
 */
function isBlankOrder(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return true;
  }

  // A blank order has no "Artwork" attribute on any line item.
  return lineItems.every((lineItem) => {
    const attr = getAttribute(lineItem, "Artwork");
    return !(attr && attr.value && attr.value.trim());
  });
}

/* -------------------------------------------------------------------------- */
/*                          Decoration analysis helpers                       */
/* -------------------------------------------------------------------------- */

function hasValidImprintJson(lineItem) {
  const imprint = getAttribute(lineItem, "_imprint");

  if (!imprint?.value) {
    return false;
  }

  try {
    const parsed = JSON.parse(imprint.value);

    const method = String(parsed?.method || "").trim();

    const locations = Number(parsed?.locations || 0);

    return Boolean(method && locations > 0);
  } catch {
    /**
     * Malformed _imprint still indicates
     * custom production data exists.
     */
    return Boolean(String(imprint.value).trim());
  }
}

function hasImprintLocations(lineItem) {
  const attribute = getAttribute(lineItem, "Imprint Locations");

  return Boolean(attribute?.value?.trim());
}

function hasArtworkFileAttribute(lineItem) {
  return Boolean(
    lineItem.customAttributes?.some((attribute) => {
      const key = String(attribute.key || "").trim();

      const value = String(attribute.value || "").trim();

      return key.toLowerCase().startsWith("artwork:") && Boolean(value);
    }),
  );
}

function isDecoratedLineItem(lineItem) {
  return (
    hasValidImprintJson(lineItem) ||
    hasImprintLocations(lineItem) ||
    hasArtworkFileAttribute(lineItem)
  );
}

/* -------------------------------------------------------------------------- */
/*                    Artwork-required production rule                        */
/* -------------------------------------------------------------------------- */

/**
 * Updated rule:
 *
 * Any line item containing at least one
 * custom attribute means this is a production order.
 *
 * This matches the blank-order definition.
 */
function determineArtworkRequired(lineItems) {
  return !isBlankOrder(lineItems);
}

/* -------------------------------------------------------------------------- */
/*                                 Rush rule                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rush when every line being produced (the ones with artwork) is rushed. An
 * order ships in one go, so a mixed order is ready at the standard time: rush
 * is still charged per rushed line, but the order's production due date
 * follows its slowest line (HYV-82, option b, Oct 9). Charge lines and blank
 * samples aren't produced, so they don't count.
 */
function determineRush(lineItems) {
  const produced = lineItems.filter((lineItem) => getAttribute(lineItem, "Artwork")?.value?.trim());
  return produced.length > 0 && produced.every((lineItem) => hasTruthyAttribute(lineItem, "Rush Production"));
}

/* -------------------------------------------------------------------------- */
/*                              Analysis helpers                              */
/* -------------------------------------------------------------------------- */

function getArtworkState(lineItem) {
  const artwork = getAttribute(lineItem, "Artwork");

  return artwork?.value?.trim() || "";
}

/**
 * Which artwork paths the order took, as staff read them: "Uploaded",
 * "Sending later", "Design it for me", or several for a mixed order (HYV-120).
 */
const ARTWORK_PATH_LABELS = {
  "provided now": "Uploaded",
  "artwork pending": "Sending later",
  "design it for me": "Design it for me",
};

function artworkPathOf(lineItems) {
  const paths = lineItems
    .map((lineItem) => ARTWORK_PATH_LABELS[getArtworkState(lineItem).toLowerCase()])
    .filter(Boolean);
  return [...new Set(paths)].join(", ");
}

function analyzeLineItems(lineItems) {
  return lineItems.map((lineItem) => ({
    id: lineItem.id,

    title: lineItem.title,

    sku: lineItem.sku,

    attributeCount: Array.isArray(lineItem.customAttributes)
      ? lineItem.customAttributes.length
      : 0,

    hasCustomAttributes:
      Array.isArray(lineItem.customAttributes) &&
      lineItem.customAttributes.length > 0,

    decorated: isDecoratedLineItem(lineItem),

    rush: hasTruthyAttribute(lineItem, "Rush Production"),

    artworkState: getArtworkState(lineItem),

    hasArtworkFile: hasArtworkFileAttribute(lineItem),
  }));
}

/* -------------------------------------------------------------------------- */
/*                                Get order                                   */
/* -------------------------------------------------------------------------- */

async function getOrder(admin, orderId) {
  const response = await admin.graphql(
    `#graphql
        query InitializeProductionOrder(
          $id: ID!
        ) {
          order(id: $id) {
            id
            name
            createdAt
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

            productionStatus: metafield(
              namespace: "$app"
              key: "production_status"
            ) {
              value
            }

            statusChangedAt: metafield(
              namespace: "$app"
              key: "status_changed_at"
            ) {
              value
            }

            artworkRequired: metafield(
              namespace: "$app"
              key: "artwork_required"
            ) {
              value
            }

            rush: metafield(
              namespace: "$app"
              key: "rush"
            ) {
              value
            }

            productionDueAt: metafield(
              namespace: "$app"
              key: "production_due_at"
            ) {
              value
            }

            customer {
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
                variant {
                  id
                }

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
      `,
    {
      variables: {
        id: orderId,
      },
    },
  );

  const data = await parseGraphQLResponse(
    response,
    "InitializeProductionOrder",
  );

  const order = data.data?.order;

  if (!order) {
    throw new Error(`Order ${orderId} was not found.`);
  }

  return order;
}

/* -------------------------------------------------------------------------- */
/*                                  Add tags                                  */
/* -------------------------------------------------------------------------- */

async function addTags(admin, orderId, tags) {
  if (!tags?.length) {
    return;
  }

  const uniqueTags = [...new Set(tags.filter(Boolean))];

  if (!uniqueTags.length) {
    return;
  }

  const response = await admin.graphql(
    `#graphql
        mutation AddProductionOrderTags(
          $id: ID!
          $tags: [String!]!
        ) {
          tagsAdd(
            id: $id
            tags: $tags
          ) {
            userErrors {
              field
              message
            }
          }
        }
      `,
    {
      variables: {
        id: orderId,

        tags: uniqueTags,
      },
    },
  );

  const data = await parseGraphQLResponse(response, "AddProductionOrderTags");

  throwUserErrors(data.data?.tagsAdd?.userErrors, "AddProductionOrderTags");
}

/* -------------------------------------------------------------------------- */
/*                                Remove tags                                 */
/* -------------------------------------------------------------------------- */

async function removeTags(admin, orderId, tags) {
  if (!tags?.length) {
    return;
  }

  const uniqueTags = [...new Set(tags.filter(Boolean))];

  if (!uniqueTags.length) {
    return;
  }

  const response = await admin.graphql(
    `#graphql
        mutation RemoveProductionOrderTags(
          $id: ID!
          $tags: [String!]!
        ) {
          tagsRemove(
            id: $id
            tags: $tags
          ) {
            userErrors {
              field
              message
            }
          }
        }
      `,
    {
      variables: {
        id: orderId,

        tags: uniqueTags,
      },
    },
  );

  const data = await parseGraphQLResponse(
    response,
    "RemoveProductionOrderTags",
  );

  throwUserErrors(
    data.data?.tagsRemove?.userErrors,
    "RemoveProductionOrderTags",
  );
}

/* -------------------------------------------------------------------------- */
/*                             Set metafields                                 */
/* -------------------------------------------------------------------------- */

async function initializeMetafields(
  admin,
  {
    orderId,
    changedAt,
    artworkRequired,
    rush,
    setInitialStatus,
    setArtworkRequired,
    setRush,
    physicalSampleRequired,
    productionDueAt,
    artworkPath = "",
  },
) {
  const metafields = [];

  if (artworkPath) {
    metafields.push({
      ownerId: orderId,
      namespace: "$app",
      key: "artwork_path",
      type: "single_line_text_field",
      value: artworkPath,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Initial production status                                              */
  /* ---------------------------------------------------------------------- */

  if (setInitialStatus) {
    const initialStatus = ORDER_STATUS;

    metafields.push(
      {
        ownerId: orderId,

        namespace: "$app",

        key: "production_status",

        type: "single_line_text_field",

        value: initialStatus,
      },

      {
        ownerId: orderId,

        namespace: "$app",

        key: "status_changed_at",

        type: "date_time",

        value: changedAt,
      },
    );

    if (physicalSampleRequired) {
      metafields.push({
        ownerId: orderId,
        namespace: "$app",
        key: "physical_sample_required",
        type: "boolean",
        value: "true",
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Production due date                                                    */
  /* ---------------------------------------------------------------------- */

  if (productionDueAt) {
    metafields.push({
      ownerId: orderId,
      namespace: "$app",
      key: "production_due_at",
      type: "date_time",
      value: productionDueAt,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Artwork required                                                       */
  /* ---------------------------------------------------------------------- */

  if (setArtworkRequired) {
    metafields.push({
      ownerId: orderId,

      namespace: "$app",

      key: "artwork_required",

      type: "boolean",

      value: String(Boolean(artworkRequired)),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Rush                                                                   */
  /* ---------------------------------------------------------------------- */

  if (setRush) {
    metafields.push({
      ownerId: orderId,

      namespace: "$app",

      key: "rush",

      type: "boolean",

      value: String(Boolean(rush)),
    });
  }

  if (!metafields.length) {
    return [];
  }

  const response = await admin.graphql(
    `#graphql
        mutation InitializeOrderMetafields(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
            metafields: $metafields
          ) {
            metafields {
              id
              namespace
              key
              value
            }

            userErrors {
              field
              message
              code
            }
          }
        }
      `,
    {
      variables: {
        metafields,
      },
    },
  );

  const data = await parseGraphQLResponse(
    response,
    "InitializeOrderMetafields",
  );

  throwUserErrors(
    data.data?.metafieldsSet?.userErrors,
    "InitializeOrderMetafields",
  );

  return data.data?.metafieldsSet?.metafields ?? [];
}

/* -------------------------------------------------------------------------- */
/*                        Remove production metafields                        */
/* -------------------------------------------------------------------------- */

/**
 * Used when an order is a blank order but old/stale
 * production initialization data already exists.
 *
 * We intentionally keep:
 * - artwork_required
 * - rush
 *
 * because these should be false and describe the order.
 *
 * We remove only production workflow state fields.
 */
async function removeProductionWorkflowMetafields(admin, order) {
  const identifiers = [];

  if (order.productionStatus?.value) {
    identifiers.push({
      ownerId: order.id,

      namespace: "$app",

      key: "production_status",
    });
  }

  if (order.statusChangedAt?.value) {
    identifiers.push({
      ownerId: order.id,

      namespace: "$app",

      key: "status_changed_at",
    });
  }

  if (!identifiers.length) {
    return;
  }

  const response = await admin.graphql(
    `#graphql
        mutation RemoveBlankOrderProductionState(
          $metafields: [MetafieldIdentifierInput!]!
        ) {
          metafieldsDelete(
            metafields: $metafields
          ) {
            userErrors {
              field
              message
            }
          }
        }
      `,
    {
      variables: {
        metafields: identifiers,
      },
    },
  );

  const data = await parseGraphQLResponse(
    response,
    "RemoveBlankOrderProductionState",
  );

  throwUserErrors(
    data.data?.metafieldsDelete?.userErrors,
    "RemoveBlankOrderProductionState",
  );
}

/* -------------------------------------------------------------------------- */
/*                           Initial status history                           */
/* -------------------------------------------------------------------------- */

async function upsertInitialHistory(admin, { orderId, orderName, changedAt, initialStatus }) {
  const numericId = getNumericOrderId(orderId);

  /**
   * Deterministic handle makes the webhook
   * safe against Shopify retries.
   */
  const handle = `order-${numericId}-order-placed`;

  const response = await admin.graphql(
    `#graphql
        mutation InitializeOrderStatusHistory(
          $handle: MetaobjectHandleInput!
          $metaobject: MetaobjectUpsertInput!
        ) {
          metaobjectUpsert(
            handle: $handle
            metaobject: $metaobject
          ) {
            metaobject {
              id
              handle
            }

            userErrors {
              field
              message
              code
            }
          }
        }
      `,
    {
      variables: {
        handle: {
          type: "$app:order_status_history",

          handle,
        },

        metaobject: {
          fields: [
            {
              key: "order_id",

              value: orderId,
            },

            {
              key: "order_name",

              value: orderName,
            },

            {
              key: "to_status",

              value: initialStatus || ORDER_STATUS,
            },

            {
              key: "changed_at",

              value: changedAt,
            },

            {
              key: "changed_by",

              value: "System",
            },

            {
              key: "source",

              value: "ORDERS_CREATE_WEBHOOK",
            },
          ],
        },
      },
    },
  );

  const data = await parseGraphQLResponse(
    response,
    "InitializeOrderStatusHistory",
  );

  throwUserErrors(
    data.data?.metaobjectUpsert?.userErrors,
    "InitializeOrderStatusHistory",
  );

  return data.data?.metaobjectUpsert?.metaobject || null;
}

/* -------------------------------------------------------------------------- */
/*                                   Action                                   */
/* -------------------------------------------------------------------------- */

export async function action({ request }) {
  try {
    const { admin, payload, shop, topic, webhookId } =
      await authenticate.webhook(request);

    console.log(`[${topic}] received`, {
      shop,

      webhookId,

      orderId: payload?.admin_graphql_api_id || payload?.id,
    });

    /* -------------------------------------------------------------------- */
    /* Admin session                                                        */
    /* -------------------------------------------------------------------- */

    if (!admin) {
      console.error("ORDERS_CREATE webhook has no Admin API session.", {
        shop,
        webhookId,
      });

      return new Response(null, {
        status: 200,
      });
    }

    /* -------------------------------------------------------------------- */
    /* Order ID                                                             */
    /* -------------------------------------------------------------------- */

    const orderId = getOrderGid(payload);

    if (!orderId) {
      console.error("ORDERS_CREATE webhook missing order ID.", {
        shop,
        webhookId,
      });

      return new Response(null, {
        status: 200,
      });
    }

    /* -------------------------------------------------------------------- */
    /* Load complete order                                                  */
    /* -------------------------------------------------------------------- */

    const order = await getOrder(admin, orderId);

    /* -------------------------------------------------------------------- */
    /* Check & attach FOB shipping if storefront-quote with no shipping    */
    /* -------------------------------------------------------------------- */
    await checkAndAddFobShippingIfStorefrontQuote(admin, {
      payload,
      orderId,
      order,
    });

    /* -------------------------------------------------------------------- */
    /* Customer-arranged freight (FOB) tagging                              */
    /* -------------------------------------------------------------------- */
    if (isFobShipping(payload, order)) {
      const existingTags = Array.isArray(order.tags)
        ? order.tags
        : typeof order.tags === "string"
          ? order.tags.split(",").map((t) => t.trim())
          : [];

      if (!existingTags.includes(CUSTOMER_ARRANGED_FREIGHT_TAG)) {
        console.log(
          `Order ${order.name} shipping method contains FOB. Adding tag "${CUSTOMER_ARRANGED_FREIGHT_TAG}".`,
        );
        await addTags(admin, order.id, [CUSTOMER_ARRANGED_FREIGHT_TAG]);
        if (!Array.isArray(order.tags)) {
          order.tags = [...existingTags];
        }
        order.tags.push(CUSTOMER_ARRANGED_FREIGHT_TAG);
      }
    }

    // Checkout's `_hyve_*` working fields aren't for staff (HYV-176).
    await removeCheckoutWorkingFields(admin, orderId, payload?.note_attributes);

    const lineItems = order.lineItems?.nodes ?? [];

    /* -------------------------------------------------------------------- */
    /* Analyze blank / production order                                     */
    /* -------------------------------------------------------------------- */

    const blankOrder = isBlankOrder(lineItems);

    const artworkRequired = determineArtworkRequired(lineItems);

    /**
     * Blank order should never be treated
     * as rush production.
     */
    const rush = blankOrder ? false : determineRush(lineItems);

    const analysis = analyzeLineItems(lineItems);

    console.log(`Production initialization analysis for ${order.name}`, {
      blankOrder,

      artworkRequired,

      rush,

      lineItems: analysis,
    });

    /* -------------------------------------------------------------------- */
    /* Existing production state                                            */
    /* -------------------------------------------------------------------- */

    const statusTags = (order.tags ?? []).filter((tag) =>
      tag.startsWith("hyve-status:"),
    );

    const metafieldStatus = order.productionStatus?.value?.trim() || "";

    const hasProgressedStatus = Boolean(
      metafieldStatus && metafieldStatus !== ORDER_STATUS,
    );

    const changedAt = order.createdAt || new Date().toISOString();

    /* ==================================================================== */
    /* BLANK ORDER                                                          */
    /* ==================================================================== */

    if (blankOrder) {
      console.log(
        `Order ${order.name} identified as blank order. Production initialization skipped.`,
      );

      /* ------------------------------------------------------------------ */
      /* Remove any incorrect production status tags                       */
      /* ------------------------------------------------------------------ */

      if (statusTags.length) {
        console.warn(
          `Removing production status tags from blank order ${order.name}`,
          statusTags,
        );

        await removeTags(admin, order.id, statusTags);
      }

      /* ------------------------------------------------------------------ */
      /* Remove stale production state metafields                           */
      /* ------------------------------------------------------------------ */

      await removeProductionWorkflowMetafields(admin, order);

      /* ------------------------------------------------------------------ */
      /* Set blank-order flags                                              */
      /* ------------------------------------------------------------------ */

      const setArtworkRequired = order.artworkRequired?.value !== "false";

      const setRush = order.rush?.value !== "false";

      // If this blank order originates from a storefront quote, set its production_status to Ready For Collection
      const hasStorefrontQuoteTag = (order.tags ?? []).includes("storefront-quote");

      if (hasStorefrontQuoteTag) {
        // Update the production_status metafield directly
        await admin.graphql(
          `#graphql
          mutation SetReadyForCollection($id: ID!, $value: String!) {
            metafieldsSet(metafields: [{
              ownerId: $id,
              namespace: "$app",
              key: "production_status",
              type: "single_line_text_field",
              value: $value
            }]) {
              userErrors { field message }
            }
          }`,
          {
            variables: {
              id: order.id,
              value: "ready-for-collection",
            },
          },
        );
        // Optionally handle errors (omitted for brevity)
      }

      await initializeMetafields(admin, {
        orderId: order.id,

        changedAt,

        artworkRequired: false,

        rush: false,

        setInitialStatus: false,

        setArtworkRequired,

        setRush,
      });

      // HYV-162: a blank order from a cart quote's link is held for credit
      // review too, as a decorated one is below.
      try {
        const held = await holdOrderForCreditReview(admin, order.id);
        if (held.held) console.log(`Order ${order.name} held for credit review`);
      } catch (holdError) {
        console.error(`Credit review hold failed for ${order.name}:`, holdError?.message || holdError);
      }

      console.log(`Blank order initialization complete: ${order.name}`, {
        orderId: order.id,

        blankOrder: true,

        artworkRequired: false,

        rush: false,

        productionStatus: null,

        statusTagsRemoved: statusTags,
      });

      return new Response(null, {
        status: 200,
      });
    }

    /* ==================================================================== */
    /* PRODUCTION ORDER                                                     */
    /* ==================================================================== */

    const setInitialStatus = !hasProgressedStatus;

    /**
     * If these metafields already exist we don't
     * overwrite them on webhook retry.
     */
    const setArtworkRequired = order.artworkRequired == null;

    const setRush = order.rush == null;

    /* -------------------------------------------------------------------- */
    /* Physical Sample Detection                                            */
    /* -------------------------------------------------------------------- */
    
    const PHYSICAL_SAMPLE_VARIANT_ID = process.env.PHYSICAL_SAMPLE_VARIANT_ID || "gid://shopify/ProductVariant/52315361280216";
    const physicalSampleRequired = lineItems.some(
      (line) => String(line.variant?.id) === PHYSICAL_SAMPLE_VARIANT_ID
    );

    const initialStatusString = ORDER_STATUS;
    const initialStatusTag = `hyve-status:${initialStatusString}`;

    /* -------------------------------------------------------------------- */
    /* Initial status tags                                                  */
    /* -------------------------------------------------------------------- */

    if (setInitialStatus) {
      const incorrectStatusTags = statusTags.filter(
        (tag) => tag !== initialStatusTag,
      );

      if (incorrectStatusTags.length) {
        console.warn(
          `Removing incorrect production status tags from new order ${order.name}`,
          incorrectStatusTags,
        );

        await removeTags(admin, order.id, incorrectStatusTags);
      }

      /**
       * Ensure exactly the correct initial
       * production status exists.
       */
      if (!statusTags.includes(initialStatusTag)) {
        await addTags(admin, order.id, [initialStatusTag]);
      }
    } else {
      /**
       * Delayed/retried webhook must not
       * move an already-progressed order
       * backwards.
       */
      console.log(
        `Order ${order.name} already progressed to "${metafieldStatus}". Initial status will not be reset.`,
      );
    }

    /* -------------------------------------------------------------------- */
    /* Production due date                                                  */
    /* -------------------------------------------------------------------- */

    let productionDueAt = order.productionDueAt?.value || null;
    if (!productionDueAt) {
      try {
        const calendar = await productionCalendar(admin);
        productionDueAt = productionDueDate(calendar, changedAt, rush);
      } catch (err) {
        console.error(
          `Failed to calculate initial production due date for ${order.name}:`,
          err,
        );
      }
    }

    /* -------------------------------------------------------------------- */
    /* Initialize metafields                                                */
    /* -------------------------------------------------------------------- */

    await initializeMetafields(admin, {
      orderId: order.id,

      changedAt,

      artworkRequired,

      rush,

      setInitialStatus,

      setArtworkRequired,

      setRush,

      physicalSampleRequired,

      productionDueAt,

      artworkPath: artworkPathOf(lineItems),
    });

    /* -------------------------------------------------------------------- */
    /* Initial history                                                      */
    /* -------------------------------------------------------------------- */

    if (setInitialStatus) {
      await upsertInitialHistory(admin, {
        orderId: order.id,

        orderName: order.name,

        changedAt,

        initialStatus: initialStatusString,
      });

      // HYV-162: an order from a cart quote's link, for a company whose orders
      // are reviewed, waits On Hold in Credit Review. Logged, not retried: the
      // order is set up either way, and a retry would redo all of the above.
      try {
        const held = await holdOrderForCreditReview(admin, order.id);
        if (held.held) console.log(`Order ${order.name} held for credit review`);
      } catch (holdError) {
        console.error(`Credit review hold failed for ${order.name}:`, holdError?.message || holdError);
      }
    }

    /* -------------------------------------------------------------------- */
    /* Final log                                                            */
    /* -------------------------------------------------------------------- */

    console.log(`Production order initialization complete: ${order.name}`, {
      orderId: order.id,

      blankOrder: false,

      productionStatus: hasProgressedStatus ? metafieldStatus : ORDER_STATUS,

      artworkRequired,

      rush,

      repairedStatusTags: setInitialStatus,

      previousStatusTags: statusTags,
    });

    return new Response(null, {
      status: 200,
    });
  } catch (error) {
    console.error("ORDERS_CREATE webhook processing failed:", error);

    /**
     * Non-2xx causes Shopify to retry
     * temporary webhook processing failures.
     */
    return new Response("Webhook processing failed", {
      status: 500,
    });
  }
}
