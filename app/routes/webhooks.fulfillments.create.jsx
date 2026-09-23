// app/routes/webhooks.fulfillments.create.jsx

import { authenticate } from "../shopify.server";

const SHIPPED_STATUS = "shipped";
const SHIPPED_TAG = `hyve-status:${SHIPPED_STATUS}`;

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

async function parseGraphQLResponse(response, operationName) {
  const data = await response.json();

  if (data.errors?.length) {
    console.error(`${operationName} GraphQL errors:`, data.errors);

    throw new Error(data.errors.map((error) => error.message).join(", "));
  }

  return data;
}

function throwUserErrors(errors, operationName) {
  if (!errors?.length) {
    return;
  }

  console.error(`${operationName} user errors:`, errors);

  throw new Error(errors.map((error) => error.message).join(", "));
}

function getFulfillmentGid(payload) {
  if (payload?.admin_graphql_api_id) {
    return payload.admin_graphql_api_id;
  }

  if (payload?.id) {
    return `gid://shopify/Fulfillment/${payload.id}`;
  }

  return null;
}

function getNumericOrderId(orderId) {
  return String(orderId || "")
    .split("/")
    .pop();
}

function getCurrentStatus(order) {
  const statusFromTag =
    (order.tags ?? [])
      .find((tag) => tag.startsWith("hyve-status:"))
      ?.replace("hyve-status:", "") || "";

  return order.productionStatus?.value || statusFromTag || "";
}

/* -------------------------------------------------------------------------- */
/*                              Get fulfillment                               */
/* -------------------------------------------------------------------------- */

async function getFulfillment(admin, fulfillmentId) {
  const response = await admin.graphql(
    `#graphql
        query GetFulfillment(
          $id: ID!
        ) {
          fulfillment(id: $id) {
            id
            name
            createdAt
            updatedAt
            status

            trackingInfo(first: 20) {
              company
              number
              url
            }

            order {
              id
              name
              tags

              displayFulfillmentStatus

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

              productionDueAt: metafield(
                namespace: "$app"
                key: "production_due_at"
              ) {
                value
              }

              productionPhotoUrl: metafield(
                namespace: "$app"
                key: "production_photo_url"
              ) {
                value
              }

              onHoldReason: metafield(
                namespace: "$app"
                key: "on_hold_reason"
              ) {
                value
              }
            }
          }
        }
      `,
    {
      variables: {
        id: fulfillmentId,
      },
    },
  );

  const data = await parseGraphQLResponse(response, "GetFulfillment");

  const fulfillment = data.data?.fulfillment;

  if (!fulfillment) {
    throw new Error(`Fulfillment ${fulfillmentId} not found.`);
  }

  if (!fulfillment.order) {
    throw new Error("Fulfillment does not contain an order.");
  }

  return fulfillment;
}

/* -------------------------------------------------------------------------- */
/*                                  Tags                                      */
/* -------------------------------------------------------------------------- */

async function removeTags(admin, orderId, tags) {
  if (!tags?.length) {
    return;
  }

  const response = await admin.graphql(
    `#graphql
        mutation RemoveProductionStatusTags(
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
        tags,
      },
    },
  );

  const data = await parseGraphQLResponse(
    response,
    "RemoveProductionStatusTags",
  );

  throwUserErrors(
    data.data?.tagsRemove?.userErrors,
    "RemoveProductionStatusTags",
  );
}

async function addTags(admin, orderId, tags) {
  if (!tags?.length) {
    return;
  }

  const response = await admin.graphql(
    `#graphql
        mutation AddProductionStatusTags(
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
        tags,
      },
    },
  );

  const data = await parseGraphQLResponse(response, "AddProductionStatusTags");

  throwUserErrors(data.data?.tagsAdd?.userErrors, "AddProductionStatusTags");
}

/* -------------------------------------------------------------------------- */
/*                          Delete on-hold reason                             */
/* -------------------------------------------------------------------------- */

async function deleteOnHoldReason(admin, orderId) {
  const response = await admin.graphql(
    `#graphql
        mutation DeleteOnHoldReason(
          $metafields: [MetafieldIdentifierInput!]!
        ) {
          metafieldsDelete(
            metafields: $metafields
          ) {
            deletedMetafields {
              ownerId
              namespace
              key
            }

            userErrors {
              field
              message
            }
          }
        }
      `,
    {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: "$app",
            key: "on_hold_reason",
          },
        ],
      },
    },
  );

  const data = await parseGraphQLResponse(response, "DeleteOnHoldReason");

  throwUserErrors(
    data.data?.metafieldsDelete?.userErrors,
    "DeleteOnHoldReason",
  );
}

/* -------------------------------------------------------------------------- */
/*                         Update shipped metafields                          */
/* -------------------------------------------------------------------------- */

async function setShippedMetafields(admin, { orderId, changedAt }) {
  const response = await admin.graphql(
    `#graphql
        mutation SetShippedMetafields(
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
        metafields: [
          {
            ownerId: orderId,
            namespace: "$app",
            key: "production_status",
            type: "single_line_text_field",
            value: SHIPPED_STATUS,
          },
          {
            ownerId: orderId,
            namespace: "$app",
            key: "status_changed_at",
            type: "date_time",
            value: changedAt,
          },
        ],
      },
    },
  );

  const data = await parseGraphQLResponse(response, "SetShippedMetafields");

  throwUserErrors(data.data?.metafieldsSet?.userErrors, "SetShippedMetafields");

  /**
   * Shipped is no longer On Hold.
   */
  await deleteOnHoldReason(admin, orderId);

  return data.data?.metafieldsSet?.metafields ?? [];
}

/* -------------------------------------------------------------------------- */
/*                           Status history                                   */
/* -------------------------------------------------------------------------- */

async function upsertShippedHistory(
  admin,
  { orderId, orderName, fromStatus, changedAt, fulfillmentId, trackingInfo },
) {
  const numericOrderId = getNumericOrderId(orderId);

  const numericFulfillmentId = String(fulfillmentId || "")
    .split("/")
    .pop();

  const handle = `order-${numericOrderId}-shipped-${numericFulfillmentId}`;

  const fields = [
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
      value: SHIPPED_STATUS,
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
      value: "FULFILLMENTS_CREATE_WEBHOOK",
    },
  ];

  if (fromStatus?.trim()) {
    fields.push({
      key: "from_status",
      value: fromStatus.trim(),
    });
  }

  const trackingSummary = (trackingInfo ?? [])
    .map((item) => {
      const parts = [];

      if (item.company) {
        parts.push(`Carrier: ${item.company}`);
      }

      if (item.number) {
        parts.push(`Tracking: ${item.number}`);
      }

      if (item.url) {
        parts.push(`URL: ${item.url}`);
      }

      return parts.join(", ");
    })
    .filter(Boolean)
    .join("\n");

  if (trackingSummary) {
    fields.push({
      key: "note",
      value: trackingSummary,
    });
  }

  const response = await admin.graphql(
    `#graphql
        mutation UpsertShippedHistory(
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
          fields,
        },
      },
    },
  );

  const data = await parseGraphQLResponse(response, "UpsertShippedHistory");

  throwUserErrors(
    data.data?.metaobjectUpsert?.userErrors,
    "UpsertShippedHistory",
  );

  return data.data?.metaobjectUpsert?.metaobject ?? null;
}

/* -------------------------------------------------------------------------- */
/*                                  Action                                    */
/* -------------------------------------------------------------------------- */

export async function action({ request }) {
  try {
    const { admin, payload, shop, topic, webhookId } =
      await authenticate.webhook(request);

    console.log(`[${topic}] fulfillment webhook received`, {
      shop,
      webhookId,

      fulfillmentId: payload?.admin_graphql_api_id || payload?.id,
    });

    if (!admin) {
      console.error("FULFILLMENTS_CREATE webhook has no Admin API client.", {
        shop,
        webhookId,
      });

      return new Response(null, {
        status: 200,
      });
    }

    const fulfillmentId = getFulfillmentGid(payload);

    if (!fulfillmentId) {
      console.error("FULFILLMENTS_CREATE missing fulfillment ID.", {
        shop,
        webhookId,
      });

      return new Response(null, {
        status: 200,
      });
    }

    const fulfillment = await getFulfillment(admin, fulfillmentId);

    const order = fulfillment.order;

    const currentStatus = getCurrentStatus(order);

    console.log(`Fulfillment created for ${order.name}`, {
      fulfillmentId: fulfillment.id,

      currentStatus,

      fulfillmentStatus: fulfillment.status,

      orderFulfillmentStatus: order.displayFulfillmentStatus,

      trackingInfo: fulfillment.trackingInfo,
    });

    /* -------------------------------------------------------------------- */
    /* Important: partial fulfillment                                      */
    /* -------------------------------------------------------------------- */

    /**
     * fulfillments/create can fire when only SOME
     * order items are fulfilled.
     *
     * The Hyve document says "Order fulfilled",
     * so only move production status to Shipped
     * after the complete Shopify order is fulfilled.
     */
    if (order.displayFulfillmentStatus !== "FULFILLED") {
      console.log(
        `Order ${order.name} is not fully fulfilled yet. Current Shopify fulfillment status: ${order.displayFulfillmentStatus}.`,
      );

      return new Response(null, {
        status: 200,
      });
    }

    /* -------------------------------------------------------------------- */
    /* Duplicate / protection                                              */
    /* -------------------------------------------------------------------- */

    if (currentStatus === "shipped") {
      console.log(`Order ${order.name} is already shipped.`);

      return new Response(null, {
        status: 200,
      });
    }

    /**
     * Never move Delivered backwards to Shipped.
     */
    if (currentStatus === "delivered") {
      console.log(
        `Order ${order.name} is already delivered. Shipped update skipped.`,
      );

      return new Response(null, {
        status: 200,
      });
    }

    const changedAt = fulfillment.createdAt || new Date().toISOString();

    /* -------------------------------------------------------------------- */
    /* Remove current production status tags                               */
    /* -------------------------------------------------------------------- */

    const productionStatusTags = (order.tags ?? []).filter((tag) =>
      tag.startsWith("hyve-status:"),
    );

    if (productionStatusTags.length) {
      await removeTags(admin, order.id, productionStatusTags);
    }

    /* -------------------------------------------------------------------- */
    /* Add shipped tag                                                      */
    /* -------------------------------------------------------------------- */

    await addTags(admin, order.id, [SHIPPED_TAG]);

    /* -------------------------------------------------------------------- */
    /* Update metafields                                                    */
    /* -------------------------------------------------------------------- */

    await setShippedMetafields(admin, {
      orderId: order.id,

      changedAt,
    });

    /* -------------------------------------------------------------------- */
    /* History                                                              */
    /* -------------------------------------------------------------------- */

    await upsertShippedHistory(admin, {
      orderId: order.id,

      orderName: order.name,

      fromStatus: currentStatus,

      changedAt,

      fulfillmentId: fulfillment.id,

      trackingInfo: fulfillment.trackingInfo,
    });

    /* -------------------------------------------------------------------- */
    /* Customer-arranged freight                                           */
    /* -------------------------------------------------------------------- */

    const customerArrangedFreight = (order.tags ?? []).includes(
      "hyve-freight:customer-arranged",
    );

    console.log(`Order ${order.name} moved to shipped.`, {
      orderId: order.id,

      previousStatus: currentStatus,

      productionStatus: SHIPPED_STATUS,

      tag: SHIPPED_TAG,

      fulfillmentId: fulfillment.id,

      customerArrangedFreight,

      changedAt,
    });

    /**
     * Do NOT send a custom customer email here.
     *
     * Shopify native fulfillment/shipping
     * notification handles the Shipped customer email.
     *
     * Later SLA processor:
     *
     * if customer-arranged freight:
     *   no delivery-scan SLA
     *
     * otherwise:
     *   after 48 hours check delivery scan
     *   if missing:
     *     internal alert to CS + Production
     *     add hyve-breach:shipped
     */

    return new Response(null, {
      status: 200,
    });
  } catch (error) {
    console.error("FULFILLMENTS_CREATE webhook processing failed:", error);

    return new Response("Webhook processing failed", {
      status: 500,
    });
  }
}
