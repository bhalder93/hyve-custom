// app/utils/sla-engine.server.js

import {
  sendArtworkReminderEmail,
  sendBreachDigestEmail,
  sendInternalSlaAlert,
  sendProofReminderEmail,
} from "./email.server";
import { proofDecisionLinks } from "../lib/proof.server";
import { productionStatusOf, recordStatusHistory, SOURCES } from "../lib/order-status.server";
import { customerArrangesFreight, STATUS_OPTIONS } from "../lib/production-statuses";
import { RECIPIENT_ROLES } from "./metaobjects/notification-recipients.server";
import { adminOrderUrl } from "../lib/admin-links.server";

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

const STATUS_TAG_PREFIX =
  "hyve-status:";

const BREACH_TAG_PREFIX =
  "hyve-breach:";

const NOTIFIED_TAG_PREFIX =
  "hyve-notified:";

/**
 * Staff can pause one order's automatic messages on a known delay (HYV-110):
 * the proof reminders, the day-10 On Hold and the late-order alerts. Status
 * emails still go out. Set from the order's Production Orders page.
 */
export const NOTIFICATIONS_PAUSED_TAG = "hyve-notifications:paused";

/**
 * The day after a proof is sent on which an undecided order goes On Hold.
 * The portal shows the buyer the same date as their deadline (HYV-102).
 */
export const PROOF_HOLD_DAY = 10;

const ON_HOLD_REASON =
  `No proof approval after day ${PROOF_HOLD_DAY}`;

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
      "SUPERVISOR",
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
      "SUPERVISOR",
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
      "SUPERVISOR",
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
      "SUPERVISOR",
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
      "LOGISTICS",
      "SUPERVISOR",
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
      "LOGISTICS",
      "SUPERVISOR",
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
    day: PROOF_HOLD_DAY,
    tag:
      `hyve-notified:proof-reminder-day-${PROOF_HOLD_DAY}`,
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
  // Decided when the order was created (orders/create): no line has artwork.
  // The same answer here, so a blank order isn't alerted on (HYV-120).
  if (
    order
      ?.artworkRequired
      ?.value ===
    "false"
  ) {
    return true;
  }

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

  // "5 hours", "1 day", "2 days 3 hours": as staff say it, not "1.0 days"
  // (HYV-127).
  const whole = Math.max(0, Math.floor(hours));
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (whole < 24) return plural(whole, "hour");
  const days = Math.floor(whole / 24);
  const rest = whole % 24;
  return rest ? `${plural(days, "day")} ${plural(rest, "hour")}` : plural(days, "day");
}

/**
 * The artwork paths an order's lines took, from the product page's "Artwork"
 * choice: "provided now", "artwork pending" (sending later) or "design it for
 * me" (HYV-120).
 */
function artworkPaths(order) {
  return new Set(
    (order?.lineItems?.nodes || [])
      .map((line) => (line?.customAttributes || []).find((attr) => attr?.key === "Artwork")?.value)
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase()),
  );
}

/** Who gets the daily breach digest (HYV-132), on top of the per-order alerts (HYV-127). */
const DIGEST_ROLES = [
  "DIGEST",
];

/** The alert names staff read, by template code (HYV-127). */
const ALERT_NAMES = {
  "MSG-10": "Artwork not received after 24 hours",
  "MSG-11": "Proof not sent after 48 hours",
  "MSG-12": "Proof not approved by day 10",
  "MSG-13": "Not in production after 24 hours",
  "MSG-14": "Production not complete on target",
  "MSG-15": "Not shipped after 48 hours",
  "MSG-16": "No delivery scan after 48 hours",
};

/** A production status as Hyve Custom shows it: "Order Received", not "order-placed". */
function statusLabel(value) {
  return STATUS_OPTIONS.find((option) => option.value === value)?.label || value || "—";
}

/** Who owns the alert: the people it goes to, with their role. Supervisors are copied, not owners (HYV-127). */
function ownerLabel(recipients) {
  const roleName = (role) => RECIPIENT_ROLES.find((r) => r.value === role)?.label || role;
  const owners = recipients.filter((r) => r.role !== "SUPERVISOR");
  return [...new Set((owners.length ? owners : recipients).map((r) => (r.name ? `${r.name} (${roleName(r.role)})` : roleName(r.role))))].join(", ");
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

                shippingLine {
                  title
                }

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

  const matched = (
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

  if (matched.length > 0) {
    return matched;
  }

  if (roleSet.has("CUSTOMER_SERVICE") && process.env.HYVE_CS_EMAILS) {
    const csEmails = process.env.HYVE_CS_EMAILS.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    return csEmails.map((email) => ({
      id: `env-${email}`,
      name: "Customer Service",
      role: "CUSTOMER_SERVICE",
      email,
    }));
  }

  return [];
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
    // ISO, not a display date: the daily digest reads it back (HYV-132).
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
  // Each alert goes to its owners and the supervisors (HYV-127).
  const roles =
    rule.recipientRoles;

  const recipients =
    await getNotificationRecipients(
      admin,
      roles,
    );

  // Nobody set up for these roles: logged as an error, and the breach is
  // still tagged and logged so the morning digest lists it.
  if (!recipients.length) {
    console.error(
      `[sla] No enabled notification recipients configured for ${roles.join(
        ", ",
      )}; ${order.name} is in the daily digest only.`,
    );

    return {
      recipients: [],
    };
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
      `[Hyve ${rule.templateCode}] ${order.name} - ${ALERT_NAMES[rule.templateCode] || rule.eventType}`,

    orderName:
      order.name,

    customerName:
      order.customer
        ?.displayName ||
      "",

    status:
      statusLabel(
        getCurrentStatus(
          order,
        ),
      ),

    elapsed,

    assignedRole:
      ownerLabel(
        recipients,
      ),

    // Opens the order inside the Shopify admin (HYV-127).
    adminUrl:
      await adminOrderUrl(
        admin,
        order.id,
      ),

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

  // Artwork not received (HYV-120): Design it for me is with the design team,
  // so an order with only that path has no clock. Uploaded at checkout and
  // sending later both do.
  const paths = rule.templateCode === "MSG-10" ? artworkPaths(order) : new Set();
  if (
    rule.templateCode === "MSG-10" &&
    paths.has("design it for me") &&
    !paths.has("artwork pending") &&
    !paths.has("send artwork later") &&
    !paths.has("provided now")
  ) {
    return {
      skipped: true,
      reason:
        "Design it for me: with the design team",
    };
  }

  const alert = await sendInternalAlert({
    admin,

    order,

    rule,

    elapsed:
      formatElapsedHours(
        elapsedHours,
      ),

    message:
      `${order.name} has remained in ${statusLabel(
        getCurrentStatus(
          order,
        ),
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

  // The buyer's own reminder, once, alongside the alert, when artwork is
  // still to come from them (HYV-120). Its failure doesn't undo the alert.
  if (rule.templateCode === "MSG-10" && (paths.has("artwork pending") || paths.has("send artwork later"))) {
    const customerEmail = getCustomerEmail(order);
    if (customerEmail) {
      await sendArtworkReminderEmail({
        customerEmail,
        customerName: order.customer?.displayName || "Customer",
        orderName: order.name,
        orderDate: order.createdAt,
        lineItems: order?.lineItems?.nodes || [],
      }).catch((error) => console.error(`[sla] artwork reminder failed for ${order.name}:`, error?.message || error));
    }
  }

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
    // Counted as an alert only when an email went (HYV-132).
    emailed: alert.recipients.length > 0,
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

  const alert = await sendInternalAlert({
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
    // Counted as an alert only when an email went (HYV-132).
    emailed: alert.recipients.length > 0,
  };
}

/* -------------------------------------------------------------------------- */
/*                               On Hold                                      */
/* -------------------------------------------------------------------------- */

async function moveOrderToOnHold(
  admin,
  order,
) {
  // Read before the move, for the timeline entry below.
  const fromStatus = productionStatusOf(order);

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

  // The hold stands even if its timeline entry can't be written.
  try {
    await recordStatusHistory(admin, {
      order,
      from: fromStatus,
      to: "on-hold",
      changedAt,
      changedBy: "System",
      source: SOURCES.sla,
      note: ON_HOLD_REASON,
    });
  } catch (error) {
    console.error(`[sla] timeline entry for the automatic hold on ${order.name} failed`, error);
  }

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

      // Approve and Request changes straight from the reminder (HYV-110).
      ...(await proofDecisionLinks(admin, order.id, proofVersion)),

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
    elapsedDays < PROOF_HOLD_DAY
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
      "SUPERVISOR",
    ],
  };

  const alert = await sendInternalAlert({
    admin,

    order,

    rule:
      holdRule,

    elapsed:
      formatElapsedHours(
        elapsedDays * 24,
      ),

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

  result.emailed =
    alert.recipients.length > 0;

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
    customerArrangesFreight(
      order,
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

  /*
   * Staff paused this order's automatic messages.
   */
  if (hasTag(order, NOTIFICATIONS_PAUSED_TAG)) {
    summary.skipped += 1;

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

      if (result.emailed) {
        summary.alertsSent +=
          1;
      }
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
      if (result.emailed) {
        summary.alertsSent +=
          1;
      }
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
      if (result.emailed) {
        summary.alertsSent +=
          1;
      }
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
    if (result.emailed) {
      summary.alertsSent +=
        1;
    }
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
/* -------------------------------------------------------------------------- */
/*                         Daily breach digest (HYV-132)                      */
/* -------------------------------------------------------------------------- */

const DIGEST_ORDERS_QUERY = `#graphql
  query BreachDigestOrders($query: String!, $after: String) {
    orders(first: 50, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        name
        tags
        customer { displayName }
        productionStatus: metafield(namespace: "$app", key: "production_status") { value }
        breachLog: metafield(namespace: "$app", key: "breach_log") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/**
 * One email a day to the Daily Digest recipients with the breaches of the
 * last 24 hours, grouped by the status each order is in now. Read from each
 * order's breach log, which every alert writes with its time, so an order breached twice
 * shows both. Sent even when there were none, so a quiet day reads as quiet
 * rather than as a missing email.
 * @returns {Promise<{sent:boolean, orders:number, breaches:number, to?:string[], reason?:string}>}
 */
export async function sendBreachDigest(admin, { now = new Date() } = {}) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const breachTags = [
    ...Object.values(SLA_RULES).map((rule) => rule.breachTag),
    `${BREACH_TAG_PREFIX}proof-sent`,
  ];
  // Every order carrying a breach tag, newest first; which breaches fall in
  // the last 24 hours is read from each order's own breach log below.
  const query = breachTags.map((tag) => `tag:'${tag}'`).join(" OR ");

  const orders = [];
  let after = null;
  for (let page = 0; page < 10; page += 1) {
    const response = await admin.graphql(DIGEST_ORDERS_QUERY, { variables: { query, after } });
    const data = await parseGraphQLResponse(response, "BreachDigestOrders");
    const connection = data.data?.orders;
    orders.push(...(connection?.nodes || []));
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  const groups = new Map();
  let breaches = 0;
  for (const order of orders) {
    const entries = String(order.breachLog?.value || "")
      .split("\n")
      .map((line) => line.match(/^\[([^\]]+)\]\s*(MSG-\d+)/))
      .filter((match) => match && new Date(match[1]) >= since && new Date(match[1]) <= now)
      .map((match) => ({ at: match[1], name: ALERT_NAMES[match[2]] || match[2], code: match[2] }));
    if (!entries.length) continue;
    breaches += entries.length;
    const status = statusLabel(getCurrentStatus(order));
    if (!groups.has(status)) groups.set(status, []);
    groups.get(status).push({
      orderName: order.name,
      customerName: order.customer?.displayName || "",
      breaches: entries.map((entry) => `${entry.code} ${entry.name}`),
      adminUrl: await adminOrderUrl(admin, order.id),
    });
  }

  const recipients = await getNotificationRecipients(admin, DIGEST_ROLES);
  const orderCount = [...groups.values()].reduce((n, rows) => n + rows.length, 0);
  if (!recipients.length) return { sent: false, orders: orderCount, breaches, reason: "No Daily Digest recipients" };

  const to = [...new Set(recipients.map((recipient) => recipient.email))];
  const statusOrder = STATUS_OPTIONS.map((option) => option.label);
  await sendBreachDigestEmail({
    to,
    since,
    now,
    groups: [...groups.entries()]
      .sort(([a], [b]) => statusOrder.indexOf(a) - statusOrder.indexOf(b))
      .map(([status, rows]) => ({ status, orders: rows })),
  });
  return { sent: true, orders: orderCount, breaches, to };
}