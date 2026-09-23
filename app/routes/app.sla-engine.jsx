// app/routes/app.sla-engine.jsx

import { useEffect, useState } from "react";

import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";

import { authenticate } from "../shopify.server";

import {
  sendProofReminderEmail,
  sendInternalSlaAlert,
} from "../utils/email.server";


const STATUS_TAG_PREFIX = "hyve-status:";

const BREACH_TAG_PREFIX = "hyve-breach:";

const NOTIFIED_TAG_PREFIX = "hyve-notified:";

const ON_HOLD_REASON = "No proof approval after day 10";

const SLA_RULES = {
  "order-placed": {
    hours: 24,

    breachTag: "hyve-breach:order-placed",

    eventType: "artwork-not-received",

    templateCode: "MSG-10",

    recipientRoles: ["CUSTOMER_SERVICE"],
  },

  "artwork-received": {
    hours: 48,

    breachTag: "hyve-breach:artwork-received",

    eventType: "proof-not-sent",

    templateCode: "MSG-11",

    recipientRoles: ["ARTWORK_COORDINATOR", "CUSTOMER_SERVICE"],
  },

  "proof-approved": {
    hours: 24,

    breachTag: "hyve-breach:proof-approved",

    eventType: "not-in-production",

    templateCode: "MSG-13",

    recipientRoles: ["PRODUCTION"],
  },

  "in-production": {
    breachTag: "hyve-breach:in-production",

    eventType: "production-overdue",

    templateCode: "MSG-14",

    recipientRoles: ["PRODUCTION"],
  },

  "production-complete": {
    hours: 48,

    breachTag: "hyve-breach:production-complete",

    eventType: "not-shipped",

    templateCode: "MSG-15",

    recipientRoles: ["PRODUCTION"],
  },

  shipped: {
    hours: 48,

    breachTag: "hyve-breach:shipped",

    eventType: "no-delivery-scan",

    templateCode: "MSG-16",

    recipientRoles: ["CUSTOMER_SERVICE", "PRODUCTION"],
  },
};

const PROOF_REMINDERS = [
  {
    day: 2,
    tag: "hyve-notified:proof-reminder-day-2",
  },
  {
    day: 5,
    tag: "hyve-notified:proof-reminder-day-5",
  },
  {
    day: 10,
    tag: "hyve-notified:proof-reminder-day-10",
  },
];


async function parseGraphQL(response, operationName) {
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

function getNumericOrderId(orderId) {
  return String(orderId || "")
    .split("/")
    .pop();
}

function getCustomerEmail(order) {
  return order.customer?.defaultEmailAddress?.emailAddress || order.email || "";
}

function getCurrentStatus(order) {
  const tagStatus =
    (order.tags ?? [])
      .find((tag) => tag.startsWith(STATUS_TAG_PREFIX))
      ?.replace(STATUS_TAG_PREFIX, "") || "";

  return order.productionStatus?.value || tagStatus || "";
}

function hoursSince(value) {
  const start = new Date(value);

  if (Number.isNaN(start.getTime())) {
    return 0;
  }

  return (Date.now() - start.getTime()) / 1000 / 60 / 60;
}

function daysSince(value) {
  return hoursSince(value) / 24;
}

function formatElapsed(hours) {
  if (hours < 24) {
    return `${Math.floor(hours)} hours`;
  }

  const days = hours / 24;

  return `${days.toFixed(1)} days`;
}

function hasTag(order, tag) {
  return (order.tags ?? []).includes(tag);
}

async function getOrdersByStatus(admin, status) {
  const response = await admin.graphql(
    `#graphql
        query SlaOrders(
          $query: String!
        ) {
          orders(
            first: 100
            query: $query
            sortKey: UPDATED_AT
          ) {
            nodes {
              id
              name
              createdAt
              tags
              email

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
                  title
                  quantity
                  sku

                  customAttributes {
                    key
                    value
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

              breachLog: metafield(
                namespace: "$app"
                key: "breach_log"
              ) {
                value
              }
            }
          }
        }
      `,
    {
      variables: {
        query: `tag:"hyve-status:${status}"`,
      },
    },
  );

  const data = await parseGraphQL(response, `SlaOrders:${status}`);

  return data.data?.orders?.nodes ?? [];
}


async function addTags(admin, orderId, tags) {
  if (!tags?.length) {
    return;
  }

  const response = await admin.graphql(
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
        id: orderId,

        tags,
      },
    },
  );

  const data = await parseGraphQL(response, "AddSlaTags");

  throwUserErrors(data.data?.tagsAdd?.userErrors, "AddSlaTags");
}

async function removeTags(admin, orderId, tags) {
  if (!tags?.length) {
    return;
  }

  const response = await admin.graphql(
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
        id: orderId,

        tags,
      },
    },
  );

  const data = await parseGraphQL(response, "RemoveSlaTags");

  throwUserErrors(data.data?.tagsRemove?.userErrors, "RemoveSlaTags");
}


async function getNotificationRecipients(admin, roles) {
  const response = await admin.graphql(
    `#graphql
        query SlaNotificationRecipients {
          metaobjects(
            type: "$app:notification_recipient"
            first: 250
          ) {
            nodes {
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

  const data = await parseGraphQL(response, "SlaNotificationRecipients");

  const roleSet = new Set(roles);

  return (data.data?.metaobjects?.nodes ?? [])
    .filter(
      (item) =>
        item.enabled?.value !== "false" &&
        roleSet.has(item.role?.value) &&
        item.email?.value,
    )
    .map((item) => ({
      name: item.name?.value || "",

      role: item.role?.value || "",

      email: item.email?.value || "",
    }));
}

async function updateBreachLog(admin, order, message) {
  const current = order.breachLog?.value || "";

  const entry = `[${new Date().toISOString()}] ${message}`;

  const value = current ? `${current}\n${entry}` : entry;

  const response = await admin.graphql(
    `#graphql
        mutation UpdateBreachLog(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
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
        metafields: [
          {
            ownerId: order.id,

            namespace: "$app",

            key: "breach_log",

            type: "multi_line_text_field",

            value,
          },
        ],
      },
    },
  );

  const data = await parseGraphQL(response, "UpdateBreachLog");

  throwUserErrors(data.data?.metafieldsSet?.userErrors, "UpdateBreachLog");
}


async function sendInternalAlert({ admin, order, rule, elapsed, message }) {
  const recipients = await getNotificationRecipients(
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

  const emails = [...new Set(recipients.map((recipient) => recipient.email))];

  return sendInternalSlaAlert({
    to: emails,

    subject: `[Hyve ${rule.templateCode}] ${order.name} - ${rule.eventType}`,

    orderName: order.name,

    customerName: order.customer?.displayName || "",

    status: getCurrentStatus(order),

    elapsed,

    assignedRole: rule.recipientRoles.join(", "),

    adminUrl: `${process.env.SHOPIFY_APP_URL}/app/production-orders/${getNumericOrderId(
      order.id,
    )}`,

    message,
  });
}

async function processStandardSla(admin, order, rule) {
  if (hasTag(order, rule.breachTag)) {
    return {
      skipped: true,
      reason: "Already breached",
    };
  }

  const statusChangedAt = order.statusChangedAt?.value;

  if (!statusChangedAt) {
    return {
      skipped: true,
      reason: "Missing status_changed_at",
    };
  }

  const elapsedHours = hoursSince(statusChangedAt);

  if (elapsedHours < rule.hours) {
    return {
      skipped: true,
      reason: "Target not reached",
    };
  }

  await sendInternalAlert({
    admin,

    order,

    rule,

    elapsed: formatElapsed(elapsedHours),

    message: `${order.name} has remained in ${getCurrentStatus(
      order,
    )} beyond the configured SLA target.`,
  });

  await addTags(admin, order.id, [rule.breachTag]);

  await updateBreachLog(
    admin,
    order,
    `${rule.templateCode} ${rule.eventType}. Elapsed ${formatElapsed(
      elapsedHours,
    )}.`,
  );

  return {
    breached: true,
  };
}


async function processProductionDue(admin, order) {
  const rule = SLA_RULES["in-production"];

  if (hasTag(order, rule.breachTag)) {
    return {
      skipped: true,
      reason: "Already breached",
    };
  }

  const productionDueAt = order.productionDueAt?.value;

  if (!productionDueAt) {
    return {
      skipped: true,
      reason: "Missing production_due_at",
    };
  }

  const due = new Date(productionDueAt);

  if (Number.isNaN(due.getTime())) {
    return {
      skipped: true,
      reason: "Invalid production_due_at",
    };
  }

  if (Date.now() <= due.getTime()) {
    return {
      skipped: true,
      reason: "Not overdue",
    };
  }

  const overdueHours = (Date.now() - due.getTime()) / 1000 / 60 / 60;

  await sendInternalAlert({
    admin,

    order,

    rule,

    elapsed: `${formatElapsed(overdueHours)} overdue`,

    message: `${order.name} is past its production due date.`,
  });

  await addTags(admin, order.id, [rule.breachTag]);

  await updateBreachLog(
    admin,
    order,
    `${rule.templateCode} production overdue by ${formatElapsed(
      overdueHours,
    )}.`,
  );

  return {
    breached: true,
  };
}


async function processProofSent(admin, order) {
  const status = getCurrentStatus(order);

  if (status !== "proof-sent") {
    return {
      skipped: true,
    };
  }

  const statusChangedAt = order.statusChangedAt?.value;

  if (!statusChangedAt) {
    return {
      skipped: true,
      reason: "Missing status_changed_at",
    };
  }

  const elapsedDays = daysSince(statusChangedAt);

  const customerEmail = getCustomerEmail(order);

  if (!customerEmail) {
    return {
      skipped: true,
      reason: "Missing customer email",
    };
  }

  const proofUrl = order.proofUrl?.value;

  const proofVersion = Number(order.proofVersion?.value || 0);

  const results = [];

  for (const reminder of PROOF_REMINDERS) {
    if (elapsedDays < reminder.day) {
      continue;
    }

    if (hasTag(order, reminder.tag)) {
      continue;
    }

    await sendProofReminderEmail({
      customerEmail,

      customerName: order.customer?.displayName || "Customer",

      orderName: order.name,

      orderDate: order.createdAt,

      proofUrl,

      proofVersion,

      reminderDay: reminder.day,
    });

    await addTags(admin, order.id, [reminder.tag]);

    results.push(`Day ${reminder.day} reminder sent`);
  }


  if (elapsedDays >= 10) {
    const currentOrder = await getOrdersByStatus(admin, "proof-sent");

    const stillProofSent = currentOrder.find((item) => item.id === order.id);

    if (!stillProofSent) {
      return {
        reminders: results,
      };
    }

    const breachTag = "hyve-breach:proof-sent";

    if (!hasTag(order, breachTag)) {
      await moveOrderToOnHold(admin, order);

      await sendInternalAlert({
        admin,

        order,

        rule: {
          eventType: "proof-not-approved",

          templateCode: "MSG-12",

          recipientRoles: ["CUSTOMER_SERVICE"],
        },

        elapsed: `${elapsedDays.toFixed(1)} days`,

        message: `${order.name} has not received proof approval by day 10 and has been placed On Hold.`,
      });

      await addTags(admin, order.id, [breachTag, "hyve-notified:on-hold"]);

      await updateBreachLog(
        admin,
        order,
        `MSG-12 Proof not approved by day 10. Order placed On Hold.`,
      );

      results.push("Moved to On Hold");
    }
  }

  return {
    reminders: results,
  };
}

async function moveOrderToOnHold(admin, order) {
  const currentStatusTags = (order.tags ?? []).filter((tag) =>
    tag.startsWith(STATUS_TAG_PREFIX),
  );

  await removeTags(admin, order.id, currentStatusTags);

  await addTags(admin, order.id, ["hyve-status:on-hold"]);

  const changedAt = new Date().toISOString();

  const response = await admin.graphql(
    `#graphql
        mutation PutOrderOnHold(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
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
        metafields: [
          {
            ownerId: order.id,

            namespace: "$app",

            key: "production_status",

            type: "single_line_text_field",

            value: "on-hold",
          },
          {
            ownerId: order.id,

            namespace: "$app",

            key: "status_changed_at",

            type: "date_time",

            value: changedAt,
          },
          {
            ownerId: order.id,

            namespace: "$app",

            key: "on_hold_reason",

            type: "single_line_text_field",

            value: ON_HOLD_REASON,
          },
        ],
      },
    },
  );

  const data = await parseGraphQL(response, "PutOrderOnHold");

  throwUserErrors(data.data?.metafieldsSet?.userErrors, "PutOrderOnHold");
}

async function processShipped(admin, order) {
  const rule = SLA_RULES.shipped;

  if (hasTag(order, "hyve-freight:customer-arranged")) {
    return {
      skipped: true,
      reason: "Customer-arranged freight",
    };
  }

  if (hasTag(order, rule.breachTag)) {
    return {
      skipped: true,
      reason: "Already breached",
    };
  }

  const changedAt = order.statusChangedAt?.value;

  if (!changedAt) {
    return {
      skipped: true,
    };
  }

  const elapsedHours = hoursSince(changedAt);

  if (elapsedHours < rule.hours) {
    return {
      skipped: true,
    };
  }


  return {
    skipped: true,

    reason: "Delivery scan integration not yet confirmed",
  };
}


async function runSlaEngine(admin) {
  const summary = {
    checked: 0,

    remindersSent: 0,

    alertsSent: 0,

    ordersOnHold: 0,

    skipped: 0,

    errors: [],
  };

  const statuses = [
    "order-placed",
    "artwork-received",
    "proof-sent",
    "proof-approved",
    "in-production",
    "production-complete",
    "shipped",
  ];

  for (const status of statuses) {
    const orders = await getOrdersByStatus(admin, status);

    for (const order of orders) {
      summary.checked += 1;

      try {
        if (getCurrentStatus(order) === "on-hold") {
          summary.skipped += 1;
          continue;
        }

        if (status === "proof-sent") {
          const result = await processProofSent(admin, order);

          const reminderCount =
            result.reminders?.filter((item) => item.includes("reminder sent"))
              .length || 0;

          summary.remindersSent += reminderCount;

          if (result.reminders?.includes("Moved to On Hold")) {
            summary.ordersOnHold += 1;

            summary.alertsSent += 1;
          }

          continue;
        }

        if (status === "in-production") {
          const result = await processProductionDue(admin, order);

          if (result.breached) {
            summary.alertsSent += 1;
          } else {
            summary.skipped += 1;
          }

          continue;
        }

        if (status === "shipped") {
          const result = await processShipped(admin, order);

          if (result.breached) {
            summary.alertsSent += 1;
          } else {
            summary.skipped += 1;
          }

          continue;
        }

        const rule = SLA_RULES[status];

        if (!rule) {
          summary.skipped += 1;

          continue;
        }

        const result = await processStandardSla(admin, order, rule);

        if (result.breached) {
          summary.alertsSent += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        console.error(`SLA processing failed for ${order.name}`, error);

        summary.errors.push({
          order: order.name,

          message: error instanceof Error ? error.message : "Unknown SLA error",
        });
      }
    }
  }

  return summary;
}


export async function loader({ request }) {
  await authenticate.admin(request);

  return {
    rules: [
      {
        status: "Order Placed",

        target: "24 hours",

        action: "Alert Customer Service",
      },
      {
        status: "Artwork Received",

        target: "48 hours",

        action: "Alert Artwork Coordinator + Customer Service",
      },
      {
        status: "Proof Sent",

        target: "Day 2 / 5 / 10",

        action: "Customer reminders, then On Hold",
      },
      {
        status: "Proof Approved",

        target: "24 hours",

        action: "Alert Production",
      },
      {
        status: "In Production",

        target: "production_due_at",

        action: "Alert Production",
      },
      {
        status: "Production Complete",

        target: "48 hours",

        action: "Alert Production",
      },
      {
        status: "Shipped",

        target: "48 hours",

        action: "Alert CS + Production if no delivery scan",
      },
    ],
  };
}


export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    const formData = await request.formData();

    const intent = String(formData.get("intent") || "");

    if (intent !== "run") {
      return {
        success: false,

        error: "Unsupported action.",
      };
    }

    const summary = await runSlaEngine(admin);

    return {
      success: true,

      summary,

      message: `SLA engine completed. ${summary.checked} orders checked.`,
    };
  } catch (error) {
    console.error("SLA engine error:", error);

    return {
      success: false,

      error:
        error instanceof Error ? error.message : "Unable to run SLA engine.",
    };
  }
}


export default function SlaEnginePage() {
  const loaderData = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const submit = useSubmit();

  const busy = navigation.state !== "idle";

  useEffect(() => {
    if (actionData?.success && actionData?.message) {
      shopify.toast.show(actionData.message);
    }
  }, [actionData]);

  function runEngine() {
    const formData = new FormData();

    formData.set("intent", "run");

    submit(formData, {
      method: "post",
    });
  }

  return (
    <s-page heading="SLA Engine" inlineSize="large">
      <s-button
        variant="primary"
        slot="primary-action"
        disabled={busy}
        onClick={runEngine}
      >
        {busy ? "Running SLA engine..." : "Run SLA engine"}
      </s-button>

      <s-stack direction="block" gap="base">
        <s-banner tone="info" heading="Release 1 SLA processor">
          <s-paragraph>
            This engine checks production orders against the Hyve SLA rules,
            sends proof reminders, sends internal alerts, writes breach tags and
            can place overdue proof orders On Hold.
          </s-paragraph>
        </s-banner>

        {actionData?.success === false && (
          <s-banner tone="critical" heading="SLA engine failed">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        )}

        {actionData?.summary && (
          <s-section heading="Last run">
            <s-grid gridTemplateColumns="repeat(5, 1fr)" gap="base">
              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">Checked</s-text>

                <s-heading>{actionData.summary.checked}</s-heading>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">Alerts</s-text>

                <s-heading>{actionData.summary.alertsSent}</s-heading>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">Reminders</s-text>

                <s-heading>{actionData.summary.remindersSent}</s-heading>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">On Hold</s-text>

                <s-heading>{actionData.summary.ordersOnHold}</s-heading>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">Errors</s-text>

                <s-heading>{actionData.summary.errors.length}</s-heading>
              </s-box>
            </s-grid>
          </s-section>
        )}

        <s-section heading="SLA rules">
          <s-stack direction="block" gap="base">
            {loaderData.rules.map((rule, index) => (
              <s-box
                key={index}
                padding="base"
                border="base"
                borderRadius="base"
              >
                <s-grid gridTemplateColumns="1fr 1fr 2fr" gap="base">
                  <s-text>{rule.status}</s-text>

                  <s-text>{rule.target}</s-text>

                  <s-text tone="subdued">{rule.action}</s-text>
                </s-grid>
              </s-box>
            ))}
          </s-stack>
        </s-section>

        {/* <s-banner tone="warning" heading="Automatic execution still required">
          <s-paragraph>
            This page runs the engine manually. The document requires the
            scheduled workflow to run every 15 minutes. The next step is to
            expose the same engine through a protected scheduler endpoint or
            your hosting cron service.
          </s-paragraph>
        </s-banner> */}
      </s-stack>
    </s-page>
  );
}
