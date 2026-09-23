// app/utils/sla-engine.server.js

import {
  sendInternalSlaAlert,
  sendProofReminderEmail,
} from "./email.server";

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

const STATUS_TAG_PREFIX =
  "hyve-status:";

const BREACH_TAG_PREFIX =
  "hyve-breach:";

const NOTIFIED_TAG_PREFIX =
  "hyve-notified:";

const FREIGHT_CUSTOMER_ARRANGED =
  "hyve-freight:customer-arranged";

const ON_HOLD_REASON =
  "No proof approval after day 10";

/**
 * Default SLA rules.
 *
 * These match the Release 1 requirements.
 *
 * Later these can be completely replaced by
 * $app:sla_rule metaobjects if you want all
 * durations to be configurable.
 */
const SLA_RULES = {
  "order-placed": {
    hours: 24,

    breachTag:
      "hyve-breach:order-placed",

    eventType:
      "artwork-not-received",

    templateCode:
      "MSG-10",

    recipientRoles: [
      "CUSTOMER_SERVICE",
    ],
  },

  "artwork-received": {
    hours: 48,

    breachTag:
      "hyve-breach:artwork-received",

    eventType:
      "proof-not-sent",

    templateCode:
      "MSG-11",

    recipientRoles: [
      "ARTWORK_COORDINATOR",
      "CUSTOMER_SERVICE",
    ],
  },

  "proof-approved": {
    hours: 24,

    breachTag:
      "hyve-breach:proof-approved",

    eventType:
      "not-in-production",

    templateCode:
      "MSG-13",

    recipientRoles: [
      "PRODUCTION",
    ],
  },

  "in-production": {
    breachTag:
      "hyve-breach:in-production",

    eventType:
      "production-overdue",

    templateCode:
      "MSG-14",

    recipientRoles: [
      "PRODUCTION",
    ],
  },

  "production-complete": {
    hours: 48,

    breachTag:
      "hyve-breach:production-complete",

    eventType:
      "not-shipped",

    templateCode:
      "MSG-15",

    recipientRoles: [
      "PRODUCTION",
    ],
  },

  shipped: {
    hours: 48,

    breachTag:
      "hyve-breach:shipped",

    eventType:
      "no-delivery-scan",

    templateCode:
      "MSG-16",

    recipientRoles: [
      "CUSTOMER_SERVICE",
      "PRODUCTION",
    ],
  },
};

const PROOF_REMINDERS = [
  {
    day: 2,
    tag:
      "hyve-notified:proof-reminder-day-2",
  },

  {
    day: 5,
    tag:
      "hyve-notified:proof-reminder-day-5",
  },

  {
    day: 10,
    tag:
      "hyve-notified:proof-reminder-day-10",
  },
];

const ACTIVE_STATUSES = [
  "order-placed",
  "artwork-received",
  "proof-sent",
  "proof-approved",
  "in-production",
  "production-complete",
  "shipped",
];

/* -------------------------------------------------------------------------- */
/*                              GraphQL helpers                               */
/* -------------------------------------------------------------------------- */

async function parseGraphQLResponse(
  response,
  operationName,
) {
  const data =
    await response.json();

  if (data.errors?.length) {
    console.error(
      `${operationName} GraphQL errors:`,
      data.errors,
    );

    throw new Error(
      data.errors
        .map(
          (error) =>
            error.message,
        )
        .join(", "),
    );
  }

  return data;
}

function throwUserErrors(
  errors,
  operationName,
) {
  if (!errors?.length) {
    return;
  }

  console.error(
    `${operationName} user errors:`,
    errors,
  );

  throw new Error(
    errors
      .map(
        (error) =>
          error.message,
      )
      .join(", "),
  );
}

/* -------------------------------------------------------------------------- */
/*                            Blank order detection                           */
/* -------------------------------------------------------------------------- */

/**
 * Application rule:
 *
 * If ALL line items have zero custom attributes,
 * the order is a blank order.
 *
 * Blank orders:
 *
 * - are not production orders
 * - are ignored by SLA engine
 * - do not receive artwork/proof/production emails
 */
export function isBlankOrder(
  order,
) {
  const lineItems =
    order?.lineItems?.nodes ||
    [];

  if (!lineItems.length) {
    return true;
  }

  return lineItems.every(
    (lineItem) => {
      const attributes =
        lineItem
          ?.customAttributes;

      return (
        !Array.isArray(
          attributes,
        ) ||
        attributes.length ===
          0
      );
    },
  );
}

export function isProductionOrder(
  order,
) {
  return !isBlankOrder(
    order,
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function getNumericOrderId(
  gid,
) {
  return String(
    gid || "",
  )
    .split("/")
    .pop();
}

function getCurrentStatus(
  order,
) {
  const metafieldStatus =
    order
      ?.productionStatus
      ?.value
      ?.trim();

  if (metafieldStatus) {
    return metafieldStatus;
  }

  const statusTag =
    (
      order?.tags ||
      []
    ).find((tag) =>
      tag.startsWith(
        STATUS_TAG_PREFIX,
      ),
    );

  return statusTag
    ? statusTag.replace(
        STATUS_TAG_PREFIX,
        "",
      )
    : "";
}

function getCustomerEmail(
  order,
) {
  return (
    order?.customer
      ?.defaultEmailAddress
      ?.emailAddress ||
    order?.email ||
    ""
  );
}

function hasTag(
  order,
  tag,
) {
  return (
    order?.tags ||
    []
  ).includes(tag);
}

function hoursSince(
  value,
) {
  if (!value) {
    return 0;
  }

  const start =
    new Date(value);

  if (
    Number.isNaN(
      start.getTime(),
    )
  ) {
    return 0;
  }

  return (
    Date.now() -
    start.getTime()
  ) /
    1000 /
    60 /
    60;
}

function daysSince(
  value,
) {
  return (
    hoursSince(value) /
    24
  );
}

function formatElapsedHours(
  hours,
) {
  if (
    !Number.isFinite(
      hours,
    )
  ) {
    return "Unknown";
  }

  if (hours < 24) {
    return `${Math.max(
      0,
      Math.floor(hours),
    )} hours`;
  }

  const days =
    hours / 24;

  return `${days.toFixed(
    1,
  )} days`;
}

/* -------------------------------------------------------------------------- */
/*                              Get SLA orders                                */
/* -------------------------------------------------------------------------- */

async function getOrdersByStatus(
  admin,
  status,
) {
  const orders = [];

  let cursor = null;
  let hasNextPage =
    true;

  /**
   * Keep pagination because a store can have more
   * than 100 orders sitting in the same status.
   */
  while (hasNextPage) {
    const response =
      await admin.graphql(
        `#graphql
          query GetSlaOrders(
            $query: String!
            $after: String
          ) {
            orders(
              first: 100
              after: $after
              query: $query
              sortKey: UPDATED_AT
            ) {
              nodes {
                id
                name
                createdAt
                updatedAt
                email
                tags

                customer {
                  displayName

                  defaultEmailAddress {
                    emailAddress
                  }
                }

                lineItems(
                  first: 100
                ) {
                  nodes {
                    id
                    title
                    quantity
                    sku
                    variantTitle

                    customAttributes {
                      key
                      value
                    }

                    image {
                      url
                      altText
                    }

                    variant {
                      image {
                        url
                        altText
                      }
                    }

                    product {
                      featuredImage {
                        url
                        altText
                      }
                    }
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

                productionDueAt: metafield(
                  namespace: "$app"
                  key: "production_due_at"
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

                proofUrl: metafield(
                  namespace: "$app"
                  key: "proof_url"
                ) {
                  value
                }

                proofVersion: metafield(
                  namespace: "$app"
                  key: "proof_version"
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

                breachLog: metafield(
                  namespace: "$app"
                  key: "breach_log"
                ) {
                  value
                }
              }

              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        {
          variables: {
            query:
              `tag:"hyve-status:${status}"`,

            after:
              cursor,
          },
        },
      );

    const data =
      await parseGraphQLResponse(
        response,
        `GetSlaOrders:${status}`,
      );

    const connection =
      data.data?.orders;

    orders.push(
      ...(
        connection?.nodes ||
        []
      ),
    );

    hasNextPage =
      Boolean(
        connection
          ?.pageInfo
          ?.hasNextPage,
      );

    cursor =
      connection
        ?.pageInfo
        ?.endCursor ||
      null;
  }

  return orders;
}

/* -------------------------------------------------------------------------- */
/*                                    Tags                                    */
/* -------------------------------------------------------------------------- */

async function addTags(
  admin,
  orderId,
  tags,
) {
  const values =
    [
      ...new Set(
        (
          tags ||
          []
        ).filter(
          Boolean,
        ),
      ),
    ];

  if (!values.length) {
    return;
  }

  const response =
    await admin.graphql(
      `#graphql
        mutation AddSlaTags(
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
          id:
            orderId,

          tags:
            values,
        },
      },
    );

  const data =
    await parseGraphQLResponse(
      response,
      "AddSlaTags",
    );

  throwUserErrors(
    data.data
      ?.tagsAdd
      ?.userErrors,
    "AddSlaTags",
  );
}

async function removeTags(
  admin,
  orderId,
  tags,
) {
  const values =
    [
      ...new Set(
        (
          tags ||
          []
        ).filter(
          Boolean,
        ),
      ),
    ];

  if (!values.length) {
    return;
  }

  const response =
    await admin.graphql(
      `#graphql
        mutation RemoveSlaTags(
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
          id:
            orderId,

          tags:
            values,
        },
      },
    );

  const data =
    await parseGraphQLResponse(
      response,
      "RemoveSlaTags",
    );

  throwUserErrors(
    data.data
      ?.tagsRemove
      ?.userErrors,
    "RemoveSlaTags",
  );
}

/* -------------------------------------------------------------------------- */
/*                        Notification recipient resolver                     */
/* -------------------------------------------------------------------------- */

async function getNotificationRecipients(
  admin,
  roles,
) {
  if (
    !roles?.length
  ) {
    return [];
  }

  const response =
    await admin.graphql(
      `#graphql
        query GetSlaNotificationRecipients {
          metaobjects(
            type: "$app:notification_recipient"
            first: 250
          ) {
            nodes {
              id

              name: field(
                key: "name"
              ) {
                value
              }

              role: field(
                key: "role"
              ) {
                value
              }

              email: field(
                key: "email"
              ) {
                value
              }

              enabled: field(
                key: "enabled"
              ) {
                value
              }
            }
          }
        }
      `,
    );

  const data =
    await parseGraphQLResponse(
      response,
      "GetSlaNotificationRecipients",
    );

  const roleSet =
    new Set(roles);

  return (
    data.data
      ?.metaobjects
      ?.nodes ||
    []
  )
    .filter(
      (recipient) => {
        const enabled =
          recipient
            ?.enabled
            ?.value !==
          "false";

        const role =
          recipient
            ?.role
            ?.value ||
          "";

        const email =
          recipient
            ?.email
            ?.value
            ?.trim();

        return (
          enabled &&
          email &&
          roleSet.has(
            role,
          )
        );
      },
    )
    .map(
      (recipient) => ({
        id:
          recipient.id,

        name:
          recipient
            ?.name
            ?.value ||
          "",

        role:
          recipient
            ?.role
            ?.value ||
          "",

        email:
          recipient
            ?.email
            ?.value
            ?.trim()
            .toLowerCase() ||
          "",
      }),
    );
}

/* -------------------------------------------------------------------------- */
/*                               Breach log                                   */
/* -------------------------------------------------------------------------- */

async function appendBreachLog(
  admin,
  order,
  message,
) {
  const previous =
    order
      ?.breachLog
      ?.value ||
    "";

  const entry =
    `[${new Date().toISOString()}] ${message}`;

  const value =
    previous
      ? `${previous}\n${entry}`
      : entry;

  const response =
    await admin.graphql(
      `#graphql
        mutation AppendBreachLog(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
            metafields: $metafields
          ) {
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
              ownerId:
                order.id,

              namespace:
                "$app",

              key:
                "breach_log",

              type:
                "multi_line_text_field",

              value,
            },
          ],
        },
      },
    );

  const data =
    await parseGraphQLResponse(
      response,
      "AppendBreachLog",
    );

  throwUserErrors(
    data.data
      ?.metafieldsSet
      ?.userErrors,
    "AppendBreachLog",
  );

  /**
   * Keep the local object in sync during
   * the same SLA run.
   */
  order.breachLog = {
    value,
  };
}

/* -------------------------------------------------------------------------- */
/*                         Internal notification                              */
/* -------------------------------------------------------------------------- */

async function sendInternalAlert({
  admin,
  order,
  rule,
  elapsed,
  message,
}) {
  const recipients =
    await getNotificationRecipients(
      admin,
      rule.recipientRoles,
    );

  if (!recipients.length) {
    throw new Error(
      `No enabled notification recipients configured for ${rule.recipientRoles.join(
        ", ",
      )}.`,
    );
  }

  const emails =
    [
      ...new Set(
        recipients.map(
          (recipient) =>
            recipient.email,
        ),
      ),
    ];

  await sendInternalSlaAlert({
    to:
      emails,

    subject:
      `[Hyve ${rule.templateCode}] ${order.name} - ${rule.eventType}`,

    orderName:
      order.name,

    customerName:
      order.customer
        ?.displayName ||
      "",

    status:
      getCurrentStatus(
        order,
      ),

    elapsed,

    assignedRole:
      rule.recipientRoles.join(
        ", ",
      ),

    adminUrl:
      process.env
        .SHOPIFY_APP_URL
        ? `${process.env.SHOPIFY_APP_URL}/app/production-orders/${getNumericOrderId(
            order.id,
          )}`
        : "",

    message,
  });

  return {
    recipients:
      emails,
  };
}

/* -------------------------------------------------------------------------- */
/*                           Standard SLA breach                              */
/* -------------------------------------------------------------------------- */

async function processStandardSla(
  admin,
  order,
  rule,
) {
  if (
    isBlankOrder(
      order,
    )
  ) {
    return {
      skipped: true,
      reason:
        "Blank order",
    };
  }

  if (
    hasTag(
      order,
      rule.breachTag,
    )
  ) {
    return {
      skipped: true,
      reason:
        "Breach already notified",
    };
  }

  const changedAt =
    order
      ?.statusChangedAt
      ?.value;

  if (!changedAt) {
    return {
      skipped: true,
      reason:
        "Missing status_changed_at",
    };
  }

  const elapsedHours =
    hoursSince(
      changedAt,
    );

  if (
    elapsedHours <
    rule.hours
  ) {
    return {
      skipped: true,
      reason:
        "SLA target not reached",
    };
  }

  await sendInternalAlert({
    admin,

    order,

    rule,

    elapsed:
      formatElapsedHours(
        elapsedHours,
      ),

    message:
      `${order.name} has remained in ${getCurrentStatus(
        order,
      )} longer than the SLA target.`,
  });

  /**
   * Add breach tag immediately after successful email.
   */
  await addTags(
    admin,
    order.id,
    [
      rule.breachTag,
    ],
  );

  order.tags = [
    ...(
      order.tags ||
      []
    ),
    rule.breachTag,
  ];

  await appendBreachLog(
    admin,
    order,
    `${rule.templateCode}: ${rule.eventType}. Elapsed ${formatElapsedHours(
      elapsedHours,
    )}.`,
  );

  return {
    breached: true,
  };
}

/* -------------------------------------------------------------------------- */
/*                         Production due-date SLA                            */
/* -------------------------------------------------------------------------- */

async function processProductionDue(
  admin,
  order,
) {
  if (
    isBlankOrder(
      order,
    )
  ) {
    return {
      skipped: true,
      reason:
        "Blank order",
    };
  }

  const rule =
    SLA_RULES[
      "in-production"
    ];

  if (
    hasTag(
      order,
      rule.breachTag,
    )
  ) {
    return {
      skipped: true,
      reason:
        "Breach already notified",
    };
  }

  const dueValue =
    order
      ?.productionDueAt
      ?.value;

  if (!dueValue) {
    return {
      skipped: true,
      reason:
        "Missing production_due_at",
    };
  }

  const dueDate =
    new Date(
      dueValue,
    );

  if (
    Number.isNaN(
      dueDate.getTime(),
    )
  ) {
    return {
      skipped: true,
      reason:
        "Invalid production_due_at",
    };
  }

  const now =
    new Date();

  if (
    now.getTime() <=
    dueDate.getTime()
  ) {
    return {
      skipped: true,
      reason:
        "Production target not reached",
    };
  }

  const overdueHours =
    (
      now.getTime() -
      dueDate.getTime()
    ) /
    1000 /
    60 /
    60;

  await sendInternalAlert({
    admin,

    order,

    rule,

    elapsed:
      `${formatElapsedHours(
        overdueHours,
      )} overdue`,

    message:
      `${order.name} is past its production due date of ${dueValue}.`,
  });

  await addTags(
    admin,
    order.id,
    [
      rule.breachTag,
    ],
  );

  order.tags = [
    ...(
      order.tags ||
      []
    ),
    rule.breachTag,
  ];

  await appendBreachLog(
    admin,
    order,
    `${rule.templateCode}: production target missed. Overdue ${formatElapsedHours(
      overdueHours,
    )}.`,
  );

  return {
    breached: true,
  };
}

/* -------------------------------------------------------------------------- */
/*                               On Hold                                      */
/* -------------------------------------------------------------------------- */

async function moveOrderToOnHold(
  admin,
  order,
) {
  const statusTags =
    (
      order.tags ||
      []
    ).filter((tag) =>
      tag.startsWith(
        STATUS_TAG_PREFIX,
      ),
    );

  if (
    statusTags.length
  ) {
    await removeTags(
      admin,
      order.id,
      statusTags,
    );
  }

  await addTags(
    admin,
    order.id,
    [
      "hyve-status:on-hold",
    ],
  );

  const changedAt =
    new Date().toISOString();

  const response =
    await admin.graphql(
      `#graphql
        mutation MoveOrderToOnHold(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
            metafields: $metafields
          ) {
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
              ownerId:
                order.id,

              namespace:
                "$app",

              key:
                "production_status",

              type:
                "single_line_text_field",

              value:
                "on-hold",
            },

            {
              ownerId:
                order.id,

              namespace:
                "$app",

              key:
                "status_changed_at",

              type:
                "date_time",

              value:
                changedAt,
            },

            {
              ownerId:
                order.id,

              namespace:
                "$app",

              key:
                "on_hold_reason",

              type:
                "single_line_text_field",

              value:
                ON_HOLD_REASON,
            },
          ],
        },
      },
    );

  const data =
    await parseGraphQLResponse(
      response,
      "MoveOrderToOnHold",
    );

  throwUserErrors(
    data.data
      ?.metafieldsSet
      ?.userErrors,
    "MoveOrderToOnHold",
  );

  order.tags =
    (
      order.tags ||
      []
    ).filter(
      (tag) =>
        !tag.startsWith(
          STATUS_TAG_PREFIX,
        ),
    );

  order.tags.push(
    "hyve-status:on-hold",
  );

  order.productionStatus = {
    value:
      "on-hold",
  };

  order.statusChangedAt = {
    value:
      changedAt,
  };

  order.onHoldReason = {
    value:
      ON_HOLD_REASON,
  };
}

/* -------------------------------------------------------------------------- */
/*                         Proof reminder processing                          */
/* -------------------------------------------------------------------------- */

async function processProofSent(
  admin,
  order,
) {
  if (
    isBlankOrder(
      order,
    )
  ) {
    return {
      skipped: true,
      reason:
        "Blank order",
    };
  }

  if (
    getCurrentStatus(
      order,
    ) !==
    "proof-sent"
  ) {
    return {
      skipped: true,
      reason:
        "Order is no longer proof-sent",
    };
  }

  const changedAt =
    order
      ?.statusChangedAt
      ?.value;

  if (!changedAt) {
    return {
      skipped: true,
      reason:
        "Missing status_changed_at",
    };
  }

  const elapsedDays =
    daysSince(
      changedAt,
    );

  const customerEmail =
    getCustomerEmail(
      order,
    );

  if (!customerEmail) {
    return {
      skipped: true,
      reason:
        "Customer email missing",
    };
  }

  const proofUrl =
    order
      ?.proofUrl
      ?.value ||
    "";

  const proofVersion =
    Number(
      order
        ?.proofVersion
        ?.value ||
      1,
    );

  const result = {
    remindersSent:
      0,

    movedToOnHold:
      false,

    actions: [],
  };

  /* ---------------------------------------------------------------------- */
  /* Send reminders                                                         */
  /* ---------------------------------------------------------------------- */

  for (
    const reminder
    of PROOF_REMINDERS
  ) {
    if (
      elapsedDays <
      reminder.day
    ) {
      continue;
    }

    if (
      hasTag(
        order,
        reminder.tag,
      )
    ) {
      continue;
    }

    /**
     * Re-check the status from the currently loaded object.
     *
     * The cron run also fetches status-specific orders,
     * so an already advanced order should not normally
     * reach this block.
     */
    if (
      getCurrentStatus(
        order,
      ) !==
      "proof-sent"
    ) {
      break;
    }

    await sendProofReminderEmail({
      customerEmail,

      customerName:
        order.customer
          ?.displayName ||
        "Customer",

      orderName:
        order.name,

      orderDate:
        order.createdAt,

      proofUrl,

      proofVersion,

      reminderDay:
        reminder.day,

      lineItems:
        order
          ?.lineItems
          ?.nodes ||
        [],
    });

    await addTags(
      admin,
      order.id,
      [
        reminder.tag,
      ],
    );

    order.tags = [
      ...(
        order.tags ||
        []
      ),
      reminder.tag,
    ];

    result.remindersSent +=
      1;

    result.actions.push(
      `Proof reminder day ${reminder.day} sent`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Day 10 On Hold                                                         */
  /* ---------------------------------------------------------------------- */

  if (
    elapsedDays < 10
  ) {
    return result;
  }

  const proofBreachTag =
    `${BREACH_TAG_PREFIX}proof-sent`;

  if (
    hasTag(
      order,
      proofBreachTag,
    )
  ) {
    return result;
  }

  /**
   * Since this execution started from the proof-sent
   * status query, and nothing in this function advances
   * it except the On Hold change below, we can now
   * place it on hold.
   */
  await moveOrderToOnHold(
    admin,
    order,
  );

  const holdRule = {
    eventType:
      "proof-not-approved",

    templateCode:
      "MSG-12",

    recipientRoles: [
      "CUSTOMER_SERVICE",
    ],
  };

  await sendInternalAlert({
    admin,

    order,

    rule:
      holdRule,

    elapsed:
      `${elapsedDays.toFixed(
        1,
      )} days`,

    message:
      `${order.name} has not received proof approval by day 10. The order has been placed On Hold.`,
  });

  await addTags(
    admin,
    order.id,
    [
      proofBreachTag,
      `${NOTIFIED_TAG_PREFIX}on-hold`,
    ],
  );

  order.tags.push(
    proofBreachTag,
    `${NOTIFIED_TAG_PREFIX}on-hold`,
  );

  await appendBreachLog(
    admin,
    order,
    `MSG-12: Proof not approved by day 10. Order moved to On Hold.`,
  );

  result.movedToOnHold =
    true;

  result.actions.push(
    "Order moved to On Hold",
  );

  return result;
}

/* -------------------------------------------------------------------------- */
/*                             Shipped SLA                                    */
/* -------------------------------------------------------------------------- */

async function processShipped(
  admin,
  order,
) {
  if (
    isBlankOrder(
      order,
    )
  ) {
    return {
      skipped: true,
      reason:
        "Blank order",
    };
  }

  if (
    hasTag(
      order,
      FREIGHT_CUSTOMER_ARRANGED,
    )
  ) {
    return {
      skipped: true,
      reason:
        "Customer-arranged freight",
    };
  }

  const rule =
    SLA_RULES.shipped;

  if (
    hasTag(
      order,
      rule.breachTag,
    )
  ) {
    return {
      skipped: true,
      reason:
        "Shipped SLA already notified",
    };
  }

  const changedAt =
    order
      ?.statusChangedAt
      ?.value;

  if (!changedAt) {
    return {
      skipped: true,
      reason:
        "Missing status_changed_at",
    };
  }

  const elapsedHours =
    hoursSince(
      changedAt,
    );

  if (
    elapsedHours <
    rule.hours
  ) {
    return {
      skipped: true,
      reason:
        "48-hour delivery scan window not reached",
    };
  }

  /**
   * IMPORTANT:
   *
   * We currently do not have a reliable field proving
   * that SF Express / ShipKit has generated a delivered
   * event.
   *
   * Do not send MSG-16 until that delivery event source
   * is implemented.
   */
  return {
    skipped: true,

    reason:
      "Waiting for confirmed ShipKit/SF Express delivery-scan integration",
  };
}

/* -------------------------------------------------------------------------- */
/*                         Process single order                               */
/* -------------------------------------------------------------------------- */

async function processOrder(
  admin,
  status,
  order,
  summary,
) {
  /*
   * FIRST CHECK.
   *
   * Blank orders must never be processed by the SLA
   * engine regardless of their production_status
   * metafield or old tags.
   */
  if (
    isBlankOrder(
      order,
    )
  ) {
    summary.blankOrdersSkipped +=
      1;

    summary.skipped +=
      1;

    return;
  }

  const currentStatus =
    getCurrentStatus(
      order,
    );

  /*
   * On Hold pauses all clocks.
   */
  if (
    currentStatus ===
    "on-hold"
  ) {
    summary.skipped +=
      1;

    return;
  }

  /* ---------------------------------------------------------------------- */
  /* Proof Sent                                                             */
  /* ---------------------------------------------------------------------- */

  if (
    status ===
    "proof-sent"
  ) {
    const result =
      await processProofSent(
        admin,
        order,
      );

    summary.remindersSent +=
      result
        ?.remindersSent ||
      0;

    if (
      result
        ?.movedToOnHold
    ) {
      summary.ordersOnHold +=
        1;

      summary.alertsSent +=
        1;
    }

    if (
      result?.skipped
    ) {
      summary.skipped +=
        1;
    }

    return;
  }

  /* ---------------------------------------------------------------------- */
  /* In Production                                                          */
  /* ---------------------------------------------------------------------- */

  if (
    status ===
    "in-production"
  ) {
    const result =
      await processProductionDue(
        admin,
        order,
      );

    if (
      result?.breached
    ) {
      summary.alertsSent +=
        1;
    } else {
      summary.skipped +=
        1;
    }

    return;
  }

  /* ---------------------------------------------------------------------- */
  /* Shipped                                                                */
  /* ---------------------------------------------------------------------- */

  if (
    status ===
    "shipped"
  ) {
    const result =
      await processShipped(
        admin,
        order,
      );

    if (
      result?.breached
    ) {
      summary.alertsSent +=
        1;
    } else {
      summary.skipped +=
        1;
    }

    return;
  }

  /* ---------------------------------------------------------------------- */
  /* Standard SLA                                                           */
  /* ---------------------------------------------------------------------- */

  const rule =
    SLA_RULES[
      status
    ];

  if (!rule) {
    summary.skipped +=
      1;

    return;
  }

  const result =
    await processStandardSla(
      admin,
      order,
      rule,
    );

  if (
    result?.breached
  ) {
    summary.alertsSent +=
      1;
  } else {
    summary.skipped +=
      1;
  }
}

/* -------------------------------------------------------------------------- */
/*                             Main SLA engine                                */
/* -------------------------------------------------------------------------- */

export async function runSlaEngine(
  admin,
) {
  if (!admin) {
    throw new Error(
      "Shopify Admin GraphQL client is required.",
    );
  }

  const startedAt =
    new Date();

  const summary = {
    startedAt:
      startedAt.toISOString(),

    completedAt:
      null,

    checked:
      0,

    productionOrdersChecked:
      0,

    blankOrdersSkipped:
      0,

    alertsSent:
      0,

    remindersSent:
      0,

    ordersOnHold:
      0,

    skipped:
      0,

    errors: [],
  };

  for (
    const status
    of ACTIVE_STATUSES
  ) {
    let orders = [];

    try {
      orders =
        await getOrdersByStatus(
          admin,
          status,
        );
    } catch (error) {
      console.error(
        `Failed loading SLA orders for ${status}:`,
        error,
      );

      summary.errors.push({
        status,

        order:
          null,

        message:
          error instanceof Error
            ? error.message
            : "Unable to load orders.",
      });

      continue;
    }

    for (
      const order
      of orders
    ) {
      summary.checked +=
        1;

      /*
       * Do this before productionOrdersChecked.
       */
      if (
        isBlankOrder(
          order,
        )
      ) {
        summary.blankOrdersSkipped +=
          1;

        summary.skipped +=
          1;

        continue;
      }

      summary.productionOrdersChecked +=
        1;

      try {
        await processOrder(
          admin,
          status,
          order,
          summary,
        );
      } catch (error) {
        console.error(
          `SLA processing failed for ${order.name}:`,
          error,
        );

        summary.errors.push({
          status,

          order:
            order.name,

          orderId:
            order.id,

          message:
            error instanceof Error
              ? error.message
              : "Unknown SLA processing error.",
        });
      }
    }
  }

  const completedAt =
    new Date();

  summary.completedAt =
    completedAt.toISOString();

  summary.durationMs =
    completedAt.getTime() -
    startedAt.getTime();

  console.log(
    "Hyve SLA engine completed.",
    summary,
  );

  return summary;
}