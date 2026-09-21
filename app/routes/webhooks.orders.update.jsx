import {
  authenticate,
  unauthenticated,
} from "../shopify.server";

import {
  STATUS_TAGS,
  TAG_TO_STATUS,
  ALLOWED_TRANSITIONS,
} from "../lib/order-status.constants";

import {
  sendCustomerStatusEmail,
  sendInternalAlertEmail,
} from "../lib/order-notifications.server";

import {
  scheduleOrderSlaJob,
  cancelOrderSlaJobs,
} from "../lib/order-sla.server";

/**
 * ======================================================
 * GRAPHQL
 * ======================================================
 */

const GET_ORDER_QUERY = `#graphql
  query GetHyveOrderState($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      tags


lineItems(first: 250) {
  nodes {
    id
    title
    sku
    quantity

    customAttributes {
      key
      value
    }
  }
}


      customer {
        id
        displayName

        defaultEmailAddress {
          emailAddress
        }
      }

      productionStatus: metafield(
        namespace: "hyve"
        key: "production_status"
      ) {
        value
      }

      statusChangedAt: metafield(
        namespace: "hyve"
        key: "status_changed_at"
      ) {
        value
      }

      artworkRequired: metafield(
        namespace: "hyve"
        key: "artwork_required"
      ) {
        value
      }

      rush: metafield(
        namespace: "hyve"
        key: "rush"
      ) {
        value
      }

      proofUrl: metafield(
        namespace: "hyve"
        key: "proof_url"
      ) {
        value
      }

      proofVersion: metafield(
        namespace: "hyve"
        key: "proof_version"
      ) {
        value
      }

      productionDueAt: metafield(
        namespace: "hyve"
        key: "production_due_at"
      ) {
        value
      }

      productionPhotoUrl: metafield(
        namespace: "hyve"
        key: "production_photo_url"
      ) {
        value
      }

      onHoldReason: metafield(
        namespace: "hyve"
        key: "on_hold_reason"
      ) {
        value
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `#graphql
  mutation AddTags(
    $id: ID!,
    $tags: [String!]!
  ) {
    tagsAdd(
      id: $id,
      tags: $tags
    ) {
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

const TAGS_REMOVE_MUTATION = `#graphql
  mutation RemoveTags(
    $id: ID!,
    $tags: [String!]!
  ) {
    tagsRemove(
      id: $id,
      tags: $tags
    ) {
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

const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet(
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
        type
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
 * ======================================================
 * HELPERS
 * ======================================================
 */

function getOrderGid(payload) {
  return (
    payload?.admin_graphql_api_id ||
    (
      payload?.id
        ? `gid://shopify/Order/${payload.id}`
        : null
    )
  );
}

async function getOrder(
  admin,
  orderId,
) {
  const response =
    await admin.graphql(
      GET_ORDER_QUERY,
      {
        variables: {
          id: orderId,
        },
      },
    );

  const result =
    await response.json();

  if (result?.errors?.length) {
    throw new Error(
      result.errors
        .map(
          (error) =>
            error.message,
        )
        .join(", "),
    );
  }

  const order =
    result?.data?.order;

  if (!order) {
    throw new Error(
      `Order not found: ${orderId}`,
    );
  }

  return order;
}

/**
 * Current processed status is taken from the tag.
 *
 * The metafield is what the admin edits.
 *
 * Therefore:
 *
 * tag == metafield
 * => already processed
 *
 * tag != metafield
 * => admin changed dropdown
 */
function getCurrentStatusFromTags(
  tags = [],
) {
  const hyveTags =
    tags.filter(
      (tag) =>
        tag.startsWith(
          "hyve-status:",
        ),
    );

  if (!hyveTags.length) {
    return {
      status: null,
      tags: [],
    };
  }

  if (hyveTags.length > 1) {
    console.error(
      "[orders/updated] multiple HYVE status tags",
      hyveTags,
    );
  }

  const statusTag =
    hyveTags[0];

  return {
    status:
      TAG_TO_STATUS[
        statusTag
      ] ?? null,

    tags: hyveTags,
  };
}

function isValidTransition(
  currentStatus,
  nextStatus,
) {
  if (!currentStatus) {
    return false;
  }

  const allowed =
    ALLOWED_TRANSITIONS[
      currentStatus
    ] ?? [];

  return allowed.includes(
    nextStatus,
  );
}

async function removeTags(
  admin,
  orderId,
  tags,
) {
  if (!tags?.length) {
    return;
  }

  const response =
    await admin.graphql(
      TAGS_REMOVE_MUTATION,
      {
        variables: {
          id: orderId,
          tags,
        },
      },
    );

  const result =
    await response.json();

  const errors =
    result?.data
      ?.tagsRemove
      ?.userErrors ?? [];

  if (errors.length) {
    throw new Error(
      errors
        .map(
          (error) =>
            error.message,
        )
        .join(", "),
    );
  }
}

async function addTags(
  admin,
  orderId,
  tags,
) {
  if (!tags?.length) {
    return;
  }

  const response =
    await admin.graphql(
      TAGS_ADD_MUTATION,
      {
        variables: {
          id: orderId,
          tags,
        },
      },
    );

  const result =
    await response.json();

  const errors =
    result?.data
      ?.tagsAdd
      ?.userErrors ?? [];

  if (errors.length) {
    throw new Error(
      errors
        .map(
          (error) =>
            error.message,
        )
        .join(", "),
    );
  }
}

async function setMetafields(
  admin,
  metafields,
) {
  const response =
    await admin.graphql(
      METAFIELDS_SET_MUTATION,
      {
        variables: {
          metafields,
        },
      },
    );

  const result =
    await response.json();

  const errors =
    result?.data
      ?.metafieldsSet
      ?.userErrors ?? [];

  if (errors.length) {
    throw new Error(
      errors
        .map(
          (error) =>
            error.message,
        )
        .join(", "),
    );
  }

  return result;
}

/**
 * Restore the metafield when somebody selects an
 * invalid transition from the Admin dropdown.
 */
async function revertProductionStatus(
  admin,
  order,
  status,
) {
  if (!status) {
    return;
  }

  await setMetafields(
    admin,
    [
      {
        ownerId:
          order.id,

        namespace:
          "hyve",

        key:
          "production_status",

        type:
          "single_line_text_field",

        value:
          status,
      },
    ],
  );
}

/**
 * ======================================================
 * BUSINESS-DAY CALCULATION
 * ======================================================
 *
 * For now weekends are excluded.
 *
 * Holiday support should be added later once the
 * production-market calendar is confirmed.
 */

function addBusinessDays(
  source,
  numberOfDays,
) {
  const date =
    new Date(source);

  let added = 0;

  while (
    added <
    numberOfDays
  ) {
    date.setUTCDate(
      date.getUTCDate() + 1,
    );

    const day =
      date.getUTCDay();

    const weekend =
      day === 0 ||
      day === 6;

    if (!weekend) {
      added += 1;
    }
  }

  return date;
}

/**
 * ======================================================
 * TRANSITION VALIDATION
 * ======================================================
 */

function validateRequiredData(
  order,
  nextStatus,
) {
  if (
    nextStatus ===
    "Proof Sent"
  ) {
    if (
      !order
        ?.proofUrl
        ?.value
    ) {
      throw new Error(
        "Proof URL is required before changing status to Proof Sent.",
      );
    }
  }

  if (
    nextStatus ===
    "Production Complete"
  ) {
    if (
      !order
        ?.productionPhotoUrl
        ?.value
    ) {
      throw new Error(
        "Production photo URL is required before changing status to Production Complete.",
      );
    }
  }
}

/**
 * ======================================================
 * CUSTOMER / INTERNAL NOTIFICATIONS
 * ======================================================
 */

async function processNotifications({
  shop,
  order,
  status,
}) {
  switch (status) {
    /**
     * Order Placed
     *
     * Native Shopify order confirmation.
     * No custom customer email.
     */
    case "Order Placed":
      break;

    /**
     * MSG-02
     */
    case "Artwork Received":
      await sendCustomerStatusEmail({
        shop,
        order,

        template:
          "MSG-02",

        data: {
          status:
            "Artwork Received",

          message:
            "Artwork received. Proof target is within 48 hours.",
        },
      });

      break;

    /**
     * MSG-03
     */
    case "Proof Sent":
      await sendCustomerStatusEmail({
        shop,
        order,

        template:
          "MSG-03",

        data: {
          status:
            "Proof Sent",

          proofUrl:
            order
              ?.proofUrl
              ?.value,

          proofVersion:
            order
              ?.proofVersion
              ?.value,

          message:
            "Proof ready for approval.",
        },
      });

      break;

    /**
     * MSG-05
     *
     * Covers Proof Approved + In Production.
     */
    case "Proof Approved":
      await sendCustomerStatusEmail({
        shop,
        order,

        template:
          "MSG-05",

        data: {
          status:
            "Proof Approved",

          productionDueAt:
            order
              ?.productionDueAt
              ?.value,

          message:
            "Proof approved and production has started.",
        },
      });

      break;

    /**
     * No customer email.
     *
     * MSG-05 already covered this.
     */
    case "In Production":
      break;

    /**
     * MSG-07
     */
    case "Production Complete":
      await sendCustomerStatusEmail({
        shop,
        order,

        template:
          "MSG-07",

        data: {
          status:
            "Production Complete",

          productionPhotoUrl:
            order
              ?.productionPhotoUrl
              ?.value,
        },
      });

      break;

    /**
     * Shopify native shipping notification.
     */
    case "Shipped":
      break;

    /**
     * Release 2 customer notification.
     */
    case "Delivered":
      break;

    /**
     * On Hold gets an internal alert.
     */
    case "On Hold":
      await sendInternalAlertEmail({
        shop,
        order,

        template:
          "MSG-17",

        recipients: [
          "CS",
        ],

        data: {
          reason:
            order
              ?.onHoldReason
              ?.value ??
            "Order placed on hold",
        },
      });

      break;

    default:
      break;
  }
}

/**
 * ======================================================
 * SLA JOB CREATION
 * ======================================================
 */

async function processSlaJobs({
  shop,
  order,
  status,
  changedAt,
}) {
  /**
   * Cancel jobs belonging to the previous/current
   * lifecycle before scheduling new status jobs.
   *
   * Real implementation will need more targeted
   * cancellation.
   */
  await cancelOrderSlaJobs({
    shop,
    orderId:
      order.id,
  });

  switch (status) {
    /**
     * Artwork should be received within 24 hours.
     */
    case "Order Placed": {
      if (
        order
          ?.artworkRequired
          ?.value ===
        "false"
      ) {
        break;
      }

      const dueAt =
        new Date(
          changedAt,
        );

      dueAt.setHours(
        dueAt.getHours() +
          24,
      );

      await scheduleOrderSlaJob({
        shop,
        orderId:
          order.id,

        status,

        type:
          "ARTWORK_NOT_RECEIVED",

        dueAt,
      });

      break;
    }

    /**
     * Proof target = 48 hours.
     */
    case "Artwork Received": {
      const dueAt =
        new Date(
          changedAt,
        );

      dueAt.setHours(
        dueAt.getHours() +
          48,
      );

      await scheduleOrderSlaJob({
        shop,
        orderId:
          order.id,

        status,

        type:
          "PROOF_NOT_SENT",

        dueAt,
      });

      break;
    }

    /**
     * Proof reminders:
     * day 2
     * day 5
     * day 10
     */
    case "Proof Sent": {
      const base =
        new Date(
          changedAt,
        );

      for (
        const reminder of [
          {
            type:
              "PROOF_REMINDER_DAY_2",
            days: 2,
          },
          {
            type:
              "PROOF_REMINDER_DAY_5",
            days: 5,
          },
          {
            type:
              "PROOF_REMINDER_DAY_10",
            days: 10,
          },
        ]
      ) {
        const dueAt =
          new Date(base);

        dueAt.setDate(
          dueAt.getDate() +
            reminder.days,
        );

        await scheduleOrderSlaJob({
          shop,

          orderId:
            order.id,

          status,

          type:
            reminder.type,

          dueAt,
        });
      }

      break;
    }

    /**
     * Internal check:
     * In Production should be applied within 24h.
     */
    case "Proof Approved": {
      const dueAt =
        new Date(
          changedAt,
        );

      dueAt.setHours(
        dueAt.getHours() +
          24,
      );

      await scheduleOrderSlaJob({
        shop,

        orderId:
          order.id,

        status,

        type:
          "NOT_IN_PRODUCTION",

        dueAt,
      });

      break;
    }

    /**
     * Production deadline was calculated at
     * Proof Approved.
     */
    case "In Production": {
      const dueAtValue =
        order
          ?.productionDueAt
          ?.value;

      if (
        dueAtValue
      ) {
        await scheduleOrderSlaJob({
          shop,

          orderId:
            order.id,

          status,

          type:
            "PRODUCTION_NOT_COMPLETE",

          dueAt:
            new Date(
              dueAtValue,
            ),
        });
      }

      break;
    }

    /**
     * Production Complete -> Shipped = 48h.
     */
    case "Production Complete": {
      const dueAt =
        new Date(
          changedAt,
        );

      dueAt.setHours(
        dueAt.getHours() +
          48,
      );

      await scheduleOrderSlaJob({
        shop,

        orderId:
          order.id,

        status,

        type:
          "ORDER_NOT_SHIPPED",

        dueAt,
      });

      break;
    }

    /**
     * Delivery scan monitoring.
     */
    case "Shipped": {
      const dueAt =
        new Date(
          changedAt,
        );

      dueAt.setHours(
        dueAt.getHours() +
          48,
      );

      await scheduleOrderSlaJob({
        shop,

        orderId:
          order.id,

        status,

        type:
          "NO_DELIVERY_SCAN",

        dueAt,
      });

      break;
    }

    /**
     * On Hold pauses all SLA jobs.
     */
    case "On Hold":
    case "Delivered":
      break;

    default:
      break;
  }
}

/**
 * ======================================================
 * WEBHOOK
 * ======================================================
 */

export const action =
  async ({
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

    try {
      const {
        admin,
      } =
        await unauthenticated.admin(
          shop,
        );

      const orderId =
        getOrderGid(
          payload,
        );

      if (!orderId) {
        console.error(
          "[orders/updated] order id missing",
        );

        return new Response();
      }

      /**
       * -----------------------------------------------
       * Fetch current Shopify order state
       * -----------------------------------------------
       */

      let order =
        await getOrder(
          admin,
          orderId,
        );

      const requestedStatus =
        order
          ?.productionStatus
          ?.value;

      if (!requestedStatus) {
        /**
         * No production status configured.
         *
         * Nothing for this webhook to process.
         */
        return new Response();
      }

      const {
        status:
          processedStatus,

        tags:
          currentStatusTags,
      } =
        getCurrentStatusFromTags(
          order.tags,
        );

      /**
       * -----------------------------------------------
       * Important recursion/idempotency protection
       * -----------------------------------------------
       *
       * When our webhook updates:
       *
       * tags
       * status_changed_at
       * production_due_at
       *
       * Shopify fires orders/updated again.
       *
       * Once the tag and metafield match,
       * the change has already been processed.
       */

      if (
        processedStatus ===
        requestedStatus
      ) {
        return new Response();
      }

      console.log(
        `[${topic}] ${order.name} production status change`,
        {
          from:
            processedStatus,

          to:
            requestedStatus,
        },
      );

      /**
       * -----------------------------------------------
       * Validate status value
       * -----------------------------------------------
       */

      const nextTag =
        STATUS_TAGS[
          requestedStatus
        ];

      if (!nextTag) {
        console.error(
          "[orders/updated] unknown production status",
          requestedStatus,
        );

        await revertProductionStatus(
          admin,
          order,
          processedStatus,
        );

        return new Response();
      }

      /**
       * -----------------------------------------------
       * Validate lifecycle transition
       * -----------------------------------------------
       */

      if (
        !isValidTransition(
          processedStatus,
          requestedStatus,
        )
      ) {
        console.error(
          "[orders/updated] invalid transition",
          {
            order:
              order.name,

            from:
              processedStatus,

            to:
              requestedStatus,
          },
        );

        await revertProductionStatus(
          admin,
          order,
          processedStatus,
        );

        return new Response();
      }

      /**
       * -----------------------------------------------
       * Validate required data
       * -----------------------------------------------
       */

      try {
        validateRequiredData(
          order,
          requestedStatus,
        );
      } catch (error) {
        console.error(
          "[orders/updated] transition validation failed",
          error,
        );

        await revertProductionStatus(
          admin,
          order,
          processedStatus,
        );

        return new Response();
      }

      const changedAt =
        new Date()
          .toISOString();

      /**
       * -----------------------------------------------
       * Proof Approved special processing
       * -----------------------------------------------
       */

      const additionalMetafields =
        [];

      if (
        requestedStatus ===
        "Proof Approved"
      ) {
        const isRush =
          order
            ?.rush
            ?.value ===
          "true";

        const businessDays =
          isRush
            ? 4
            : 7;

        const dueAt =
          addBusinessDays(
            changedAt,
            businessDays,
          );

        additionalMetafields.push(
          {
            ownerId:
              order.id,

            namespace:
              "hyve",

            key:
              "production_due_at",

            type:
              "date_time",

            value:
              dueAt
                .toISOString(),
          },
        );
      }

      /**
       * -----------------------------------------------
       * On Hold reason
       * -----------------------------------------------
       */

      if (
        requestedStatus ===
          "On Hold" &&
        !order
          ?.onHoldReason
          ?.value
      ) {
        additionalMetafields.push(
          {
            ownerId:
              order.id,

            namespace:
              "hyve",

            key:
              "on_hold_reason",

            type:
              "single_line_text_field",

            value:
              "Manually placed on hold",
          },
        );
      }

      /**
       * -----------------------------------------------
       * Synchronize status tags
       * -----------------------------------------------
       */

      await removeTags(
        admin,
        order.id,
        currentStatusTags,
      );

      await addTags(
        admin,
        order.id,
        [
          nextTag,
        ],
      );

      /**
       * -----------------------------------------------
       * Update status timestamp + special metafields
       * -----------------------------------------------
       */

      await setMetafields(
        admin,
        [
          {
            ownerId:
              order.id,

            namespace:
              "hyve",

            key:
              "status_changed_at",

            type:
              "date_time",

            value:
              changedAt,
          },

          ...additionalMetafields,
        ],
      );

      /**
       * Re-fetch because Proof Approved may have just
       * created production_due_at.
       */
      order =
        await getOrder(
          admin,
          orderId,
        );

      /**
       * -----------------------------------------------
       * Send immediate notification required by status
       * -----------------------------------------------
       */

      await processNotifications({
        shop,
        order,
        status:
          requestedStatus,
      });

      /**
       * -----------------------------------------------
       * Schedule SLA/reminder jobs
       * -----------------------------------------------
       */

      await processSlaJobs({
        shop,
        order,
        status:
          requestedStatus,
        changedAt,
      });

      console.log(
        `[orders/updated] ${order.name}: ${processedStatus} -> ${requestedStatus} processed`,
      );
    } catch (error) {
      /**
       * Preserve your webhook strategy.
       *
       * Log the error but acknowledge Shopify.
       */
      console.error(
        "[orders/updated] failed",
        error,
      );
    }

    return new Response();
  };