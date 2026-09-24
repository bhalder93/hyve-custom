// app/routes/app.production-orders.$orderId.jsx

import { useEffect, useMemo, useState } from "react";

import {
  useActionData,
  useLoaderData,
  useNavigation,
  useNavigate,
  useSubmit,
} from "react-router";

import { authenticate } from "../shopify.server";

import {
  sendArtworkReceivedEmail,
  sendProofSentEmail,
  sendProofApprovedEmail,
  sendProductionCompleteEmail,
} from "../utils/email.server";
import { proofDecisionLinks } from "../lib/proof.server";
import { artworkPending } from "../lib/portal.server";
const STATUS_OPTIONS = [
  {
    label: "Order Placed",
    value: "order-placed",
  },
  {
    label: "Artwork Received",
    value: "artwork-received",
  },
  {
    label: "Proof Sent",
    value: "proof-sent",
  },
  {
    label: "Proof Approved",
    value: "proof-approved",
  },
  {
    label: "In Production",
    value: "in-production",
  },
  {
    label: "Production Complete",
    value: "production-complete",
  },
  {
    label: "Shipped",
    value: "shipped",
  },
  {
    label: "Delivered",
    value: "delivered",
  },
  {
    label: "On Hold",
    value: "on-hold",
  },
];

const STATUS_TRANSITIONS = {
  "order-placed": ["artwork-received", "proof-approved", "on-hold"],

  "artwork-received": ["proof-sent", "on-hold"],

  "proof-sent": ["proof-approved", "on-hold"],

  "proof-approved": ["in-production", "on-hold"],

  "in-production": ["production-complete", "on-hold"],

  "production-complete": ["shipped", "on-hold"],

  shipped: ["delivered", "on-hold"],

  delivered: [],

  "on-hold": [
    "proof-sent",
    "proof-approved",
    "in-production",
    "production-complete",
  ],
};

const CUSTOMER_EMAIL_STATUSES = new Set([
  "artwork-received",
  "proof-sent",
  "proof-approved",
  "production-complete",
]);

const VALID_STATUSES = new Set(STATUS_OPTIONS.map((status) => status.value));

const PRODUCTION_MARKET = "CN";

const RUSH_DAYS = 4;

function getStatusLabel(value) {
  return (
    STATUS_OPTIONS.find((item) => item.value === value)?.label ||
    value ||
    "Not set"
  );
}

function statusTone(status) {
  switch (status) {
    case "production-complete":
    case "shipped":
    case "delivered":
      return "success";

    case "on-hold":
      return "critical";

    case "proof-sent":
    case "proof-approved":
    case "in-production":
      return "info";

    case "artwork-received":
      return "warning";

    default:
      return "neutral";
  }
}

function formatDate(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Singapore",
  }).format(date);
}

function formatMoney(amount, currency) {
  const numeric = Number(amount);

  if (Number.isNaN(numeric)) {
    return `${currency || ""} ${amount}`.trim();
  }

  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency: currency || "USD",
    }).format(numeric);
  } catch {
    return `${currency || ""} ${numeric.toFixed(2)}`.trim();
  }
}

function validateHttpUrl(value) {
  try {
    const url = new URL(value);

    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function canTransition(currentStatus, nextStatus) {
  if (!currentStatus) {
    return nextStatus === "order-placed";
  }

  return Boolean(STATUS_TRANSITIONS[currentStatus]?.includes(nextStatus));
}

function addBusinessDays(start, days, holidays = []) {
  const date = new Date(start);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid production SLA start date.");
  }

  const totalDays = Number(days);

  if (!Number.isInteger(totalDays) || totalDays <= 0) {
    throw new Error("Production SLA duration must be greater than zero.");
  }

  const holidaySet = new Set(
    holidays.map((value) => String(value).slice(0, 10)),
  );

  let added = 0;

  while (added < totalDays) {
    date.setUTCDate(date.getUTCDate() + 1);

    const weekday = date.getUTCDay();

    const dateKey = date.toISOString().slice(0, 10);

    const weekend = weekday === 0 || weekday === 6;

    const holiday = holidaySet.has(dateKey);

    if (!weekend && !holiday) {
      added += 1;
    }
  }

  return date;
}

function getCustomerEmail(order) {
  return (
    order.customer?.defaultEmailAddress?.emailAddress ||
    order.customer?.email ||
    order.email ||
    ""
  );
}

function getCustomerNotificationTag(status, proofVersion) {
  if (status === "proof-sent") {
    return `hyve-notified:proof-sent-v${proofVersion}`;
  }

  return `hyve-notified:${status}`;
}

function validateStatusChange(payload) {
  const errors = {};

  if (!payload.nextStatus) {
    errors.nextStatus = "Select the next production status.";
  } else if (!VALID_STATUSES.has(payload.nextStatus)) {
    errors.nextStatus = "Invalid production status.";
  }

  if (payload.nextStatus === "on-hold" && !payload.onHoldReason?.trim()) {
    errors.onHoldReason = "On hold reason is required.";
  }

  if (payload.nextStatus === "proof-sent") {
    const proofUrl = payload.proofUrl?.trim();

    if (!proofUrl) {
      errors.proofUrl =
        "Proof URL is required when setting status to Proof Sent.";
    } else if (!validateHttpUrl(proofUrl)) {
      errors.proofUrl = "Enter a valid http or https proof URL.";
    }
  }

  if (payload.nextStatus === "production-complete") {
    const productionPhotoUrl = payload.productionPhotoUrl?.trim();

    if (!productionPhotoUrl) {
      errors.productionPhotoUrl =
        "Production photo URL is required before setting Production Complete.";
    } else if (!validateHttpUrl(productionPhotoUrl)) {
      errors.productionPhotoUrl =
        "Enter a valid http or https production photo URL.";
    }
  }

  return errors;
}
async function parseGraphQL(response, operationName = "GraphQL") {
  const data = await response.json();

  if (data.errors?.length) {
    console.error(`${operationName} GraphQL errors:`, data.errors);

    throw new Error(data.errors.map((error) => error.message).join(", "));
  }

  return data;
}

function throwUserErrors(errors, operationName = "Shopify operation") {
  if (!errors?.length) {
    return;
  }

  console.error(`${operationName} user errors:`, errors);

  throw new Error(errors.map((error) => error.message).join(", "));
}

async function getOrder(admin, orderId) {
  const response = await admin.graphql(
    `#graphql
        query ProductionOrderDetails(
          $id: ID!
        ) {
          order(id: $id) {
            id
            name
            createdAt
            processedAt
            tags
            email
            phone
            note

            displayFinancialStatus
            displayFulfillmentStatus

            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            subtotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            totalShippingPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            customer {
              id
              displayName
              email
              phone

              defaultEmailAddress {
                emailAddress
              }
            }

            shippingAddress {
              name
              address1
              address2
              city
              province
              zip
              country
              phone
            }

            lineItems(first: 100) {
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

    originalUnitPriceSet {
      shopMoney {
        amount
        currencyCode
      }
    }

    image {
      url
      altText
    }

    variant {
      id
      image {
        url
        altText
      }
    }

    product {
      id
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
          }
        }
      `,
    {
      variables: {
        id: orderId,
      },
    },
  );

  const data = await parseGraphQL(response, "ProductionOrderDetails");

  const order = data.data?.order;

  if (!order) {
    throw new Error("Order not found.");
  }

  return order;
}
async function getStatusHistory(admin, orderId) {
  const response = await admin.graphql(
    `#graphql
        query OrderStatusHistory {
          metaobjects(
            type: "$app:order_status_history"
            first: 250
          ) {
            nodes {
              id
              handle

              orderId: field(
                key: "order_id"
              ) {
                value
              }

              fromStatus: field(
                key: "from_status"
              ) {
                value
              }

              toStatus: field(
                key: "to_status"
              ) {
                value
              }

              changedAt: field(
                key: "changed_at"
              ) {
                value
              }

              changedBy: field(
                key: "changed_by"
              ) {
                value
              }

              source: field(
                key: "source"
              ) {
                value
              }

              note: field(
                key: "note"
              ) {
                value
              }
            }
          }
        }
      `,
  );

  const data = await parseGraphQL(response, "OrderStatusHistory");

  return (data.data?.metaobjects?.nodes ?? [])
    .filter((item) => item.orderId?.value === orderId)
    .map((item) => ({
      id: item.id,

      fromStatus: item.fromStatus?.value || "",

      toStatus: item.toStatus?.value || "",

      changedAt: item.changedAt?.value || "",

      changedBy: item.changedBy?.value || "Shopify Admin",

      source: item.source?.value || "",

      note: item.note?.value || "",
    }))
    .sort(
      (a, b) =>
        new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime(),
    );
}

async function addTags(admin, orderId, tags) {
  if (!tags?.length) {
    return;
  }

  const response = await admin.graphql(
    `#graphql
        mutation AddOrderTags(
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

  const data = await parseGraphQL(response, "AddOrderTags");

  throwUserErrors(data.data?.tagsAdd?.userErrors, "AddOrderTags");
}

async function removeTags(admin, orderId, tags) {
  if (!tags?.length) {
    return;
  }

  const response = await admin.graphql(
    `#graphql
        mutation RemoveOrderTags(
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

  const data = await parseGraphQL(response, "RemoveOrderTags");

  throwUserErrors(data.data?.tagsRemove?.userErrors, "RemoveOrderTags");
}

async function hasOrderTag(admin, orderId, tag) {
  const response = await admin.graphql(
    `#graphql
        query CheckOrderTag(
          $id: ID!
        ) {
          order(id: $id) {
            id
            tags
          }
        }
      `,
    {
      variables: {
        id: orderId,
      },
    },
  );

  const data = await parseGraphQL(response, "CheckOrderTag");

  return Boolean(data.data?.order?.tags?.includes(tag));
}

async function getProductionSlaDays(admin) {
  const response = await admin.graphql(
    `#graphql
        query ProductionSla {
          metaobjects(
            type: "$app:sla_rule"
            first: 100
          ) {
            nodes {
              status: field(
                key: "status"
              ) {
                value
              }

              duration: field(
                key: "duration"
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

  const data = await parseGraphQL(response, "ProductionSla");

  const rule = (data.data?.metaobjects?.nodes ?? []).find(
    (item) =>
      item.status?.value === "in-production" && item.enabled?.value !== "false",
  );

  return Number(rule?.duration?.value) || 7;
}

async function getHolidays(admin) {
  const response = await admin.graphql(
    `#graphql
        query ProductionHolidays {
          metaobjects(
            type: "$app:business_holiday"
            first: 250
          ) {
            nodes {
              market: field(
                key: "market"
              ) {
                value
              }

              date: field(
                key: "date"
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

  const data = await parseGraphQL(response, "ProductionHolidays");

  return (data.data?.metaobjects?.nodes ?? [])
    .filter(
      (item) =>
        item.enabled?.value !== "false" &&
        item.market?.value === PRODUCTION_MARKET &&
        item.date?.value,
    )
    .map((item) => item.date.value);
}

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

  const data = await parseGraphQL(response, "DeleteOnHoldReason");

  throwUserErrors(
    data.data?.metafieldsDelete?.userErrors,
    "DeleteOnHoldReason",
  );
}


async function setOrderMetafields(
  admin,
  {
    orderId,
    status,
    changedAt,
    productionDueAt,
    onHoldReason,
    proofUrl,
    proofVersion,
    productionPhotoUrl,
  },
) {
  const metafields = [
    {
      ownerId: orderId,

      namespace: "$app",

      key: "production_status",

      type: "single_line_text_field",

      value: status,
    },

    {
      ownerId: orderId,

      namespace: "$app",

      key: "status_changed_at",

      type: "date_time",

      value: changedAt,
    },
  ];

  if (productionDueAt) {
    metafields.push({
      ownerId: orderId,

      namespace: "$app",

      key: "production_due_at",

      type: "date_time",

      value: productionDueAt,
    });
  }

  if (status === "proof-sent" && proofUrl?.trim()) {
    metafields.push({
      ownerId: orderId,

      namespace: "$app",

      key: "proof_url",

      type: "url",

      value: proofUrl.trim(),
    });

    metafields.push({
      ownerId: orderId,

      namespace: "$app",

      key: "proof_version",

      type: "number_integer",

      value: String(proofVersion),
    });
  }

  if (status === "production-complete" && productionPhotoUrl?.trim()) {
    metafields.push({
      ownerId: orderId,

      namespace: "$app",

      key: "production_photo_url",

      type: "url",

      value: productionPhotoUrl.trim(),
    });
  }

  if (status === "on-hold" && onHoldReason?.trim()) {
    metafields.push({
      ownerId: orderId,

      namespace: "$app",

      key: "on_hold_reason",

      type: "single_line_text_field",

      value: onHoldReason.trim(),
    });
  }

  const response = await admin.graphql(
    `#graphql
        mutation SetProductionMetafields(
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

  const data = await parseGraphQL(response, "SetProductionMetafields");

  throwUserErrors(
    data.data?.metafieldsSet?.userErrors,
    "SetProductionMetafields",
  );

  if (status !== "on-hold") {
    await deleteOnHoldReason(admin, orderId);
  }

  return data.data?.metafieldsSet?.metafields ?? [];
}

async function createHistory(
  admin,
  { orderId, orderName, fromStatus, toStatus, changedAt, changedBy, note },
) {
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

      value: toStatus,
    },

    {
      key: "changed_at",

      value: changedAt,
    },

    {
      key: "changed_by",

      value: changedBy || "Shopify Admin",
    },

    {
      key: "source",

      value: "HYVE_APP",
    },
  ];

  if (fromStatus?.trim()) {
    fields.push({
      key: "from_status",

      value: fromStatus.trim(),
    });
  }

  if (note?.trim()) {
    fields.push({
      key: "note",

      value: note.trim(),
    });
  }

  const response = await admin.graphql(
    `#graphql
        mutation CreateOrderStatusHistory(
          $metaobject: MetaobjectCreateInput!
        ) {
          metaobjectCreate(
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
        metaobject: {
          type: "$app:order_status_history",

          fields,
        },
      },
    },
  );

  const data = await parseGraphQL(response, "CreateOrderStatusHistory");

  throwUserErrors(
    data.data?.metaobjectCreate?.userErrors,
    "CreateOrderStatusHistory",
  );
}

async function sendCustomerStatusEmail({
  admin,
  orderId,
  order,
  status,
  proofUrl,
  proofVersion,
  productionDueAt,
  productionPhotoUrl,
}) {
  const customerEmail = getCustomerEmail(order);

  if (!customerEmail) {
    throw new Error("Customer email address is missing.");
  }

  const common = {
    customerEmail,

    customerName:
      order.customer?.displayName || order.shippingAddress?.name || "Customer",

    orderName: order.name,

    orderDate: order.createdAt,

    lineItems: order.lineItems?.nodes || [],
  };

  switch (status) {
    case "artwork-received":
      return sendArtworkReceivedEmail(common);

    case "proof-sent":
      // Approve and Request changes work straight from the email (ART-03).
      return sendProofSentEmail({
        ...common,

        proofUrl,

        proofVersion,

        ...(await proofDecisionLinks(admin, orderId, proofVersion)),
      });

    case "proof-approved":
      return sendProofApprovedEmail({
        ...common,

        productionDueAt,
      });

    case "production-complete":
      return sendProductionCompleteEmail({
        ...common,

        productionPhotoUrl,
      });

    default:
      return null;
  }
}

async function sendCurrentCustomerStatusEmail({
  admin,
  order,
  orderId,
  status,
  proofUrl,
  proofVersion,
  productionDueAt,
  productionPhotoUrl,
}) {
  if (!CUSTOMER_EMAIL_STATUSES.has(status)) {
    return {
      sent: false,
      alreadySent: false,
      notificationTag: null,
      messageId: null,
    };
  }

  const notificationTag = getCustomerNotificationTag(status, proofVersion);

  const alreadySent = await hasOrderTag(admin, orderId, notificationTag);

  if (alreadySent) {
    return {
      sent: false,
      alreadySent: true,
      notificationTag,
      messageId: null,
    };
  }

  const result = await sendCustomerStatusEmail({
    admin,
    orderId,
    order,
    status,
    proofUrl,
    proofVersion,
    productionDueAt,
    productionPhotoUrl,
  });

  if (!result) {
    return {
      sent: false,
      alreadySent: false,
      notificationTag,
      messageId: null,
    };
  }

  await addTags(admin, orderId, [notificationTag]);

  return {
    sent: true,
    alreadySent: false,
    notificationTag,
    messageId: result.messageId || null,
  };
}

export async function loader({ request, params }) {
  const { admin } = await authenticate.admin(request);

  try {
    if (!params.orderId) {
      throw new Error("Order ID is missing.");
    }

    const orderId = `gid://shopify/Order/${params.orderId}`;

    const [order, history] = await Promise.all([
      getOrder(admin, orderId),

      getStatusHistory(admin, orderId),
    ]);

    const statusTag = (order.tags ?? []).find((tag) =>
      tag.startsWith("hyve-status:"),
    );

    const statusFromTag = statusTag?.replace("hyve-status:", "") || "";

    const proofVersion = Number(order.proofVersion?.value || 0);

    const proofNotificationTag =
      proofVersion > 0
        ? getCustomerNotificationTag("proof-sent", proofVersion)
        : null;

    const proofEmailSent = proofNotificationTag
      ? (order.tags ?? []).includes(proofNotificationTag)
      : false;

    return {
      order: {
        ...order,

        productionStatus: order.productionStatus?.value || statusFromTag || "",

        statusChangedAt: order.statusChangedAt?.value || "",

        productionDueAt: order.productionDueAt?.value || "",

        artworkRequired: order.artworkRequired?.value === "true",

        rush: order.rush?.value === "true",

        proofUrl: order.proofUrl?.value || "",

        proofVersion,

        proofEmailSent,

        productionPhotoUrl: order.productionPhotoUrl?.value || "",

        onHoldReason: order.onHoldReason?.value || "",
      },

      history,

      loaderError: null,
    };
  } catch (error) {
    console.error("Production order loader error:", error);

    return {
      order: null,

      history: [],

      loaderError:
        error instanceof Error
          ? error.message
          : "Unable to load production order.",
    };
  }
}

export async function action({ request, params }) {
  const { admin, session } = await authenticate.admin(request);

  try {
    if (!params.orderId) {
      throw new Error("Order ID is missing.");
    }

    const orderId = `gid://shopify/Order/${params.orderId}`;

    const formData = await request.formData();

    const intent = String(formData.get("intent") || "").trim();

    if (intent === "retry_proof_email") {
      const order = await getOrder(admin, orderId);

      const currentStatus = order.productionStatus?.value || "";

      if (currentStatus !== "proof-sent") {
        return {
          success: false,

          fieldErrors: {},

          formError:
            "Proof email can only be retried while the order is in Proof Sent status.",
        };
      }

      const proofUrl = order.proofUrl?.value || "";

      const proofVersion = Number(order.proofVersion?.value || 0);

      if (!proofUrl || !proofVersion) {
        return {
          success: false,

          fieldErrors: {},

          formError:
            "This order does not have a valid proof URL and proof version.",
        };
      }

      try {
        const result = await sendCurrentCustomerStatusEmail({
          admin,

          order,

          orderId,

          status: "proof-sent",

          proofUrl,

          proofVersion,

          productionDueAt: null,

          productionPhotoUrl: null,
        });

        if (result.alreadySent) {
          return {
            success: true,

            message: `Proof version ${proofVersion} was already emailed to the customer.`,

            emailSent: false,

            emailAlreadySent: true,

            fieldErrors: {},

            formError: null,
          };
        }

        return {
          success: true,

          message: `Proof version ${proofVersion} email sent successfully.`,

          emailSent: true,

          emailAlreadySent: false,

          fieldErrors: {},

          formError: null,
        };
      } catch (error) {
        console.error("Retry proof email failed:", error);

        return {
          success: false,

          fieldErrors: {},

          formError:
            error instanceof Error
              ? error.message
              : "Unable to send proof email.",
        };
      }
    }

    if (intent !== "change_status") {
      return {
        success: false,

        fieldErrors: {},

        formError: "Unsupported action.",
      };
    }

    const nextStatus = String(formData.get("nextStatus") || "").trim();

    const note = String(formData.get("note") || "").trim();

    const onHoldReason = String(formData.get("onHoldReason") || "").trim();

    const proofUrl = String(formData.get("proofUrl") || "").trim();

    const productionPhotoUrl = String(
      formData.get("productionPhotoUrl") || "",
    ).trim();

    const fieldErrors = validateStatusChange({
      nextStatus,
      onHoldReason,
      proofUrl,
      productionPhotoUrl,
    });

    if (Object.keys(fieldErrors).length > 0) {
      return {
        success: false,

        fieldErrors,

        formError: "Please correct the highlighted fields.",
      };
    }

    const order = await getOrder(admin, orderId);

    const productionTags = (order.tags ?? []).filter((tag) =>
      tag.startsWith("hyve-status:"),
    );

    const currentStatus =
      order.productionStatus?.value ||
      productionTags[0]?.replace("hyve-status:", "") ||
      "";

    if (currentStatus === nextStatus) {
      return {
        success: false,

        fieldErrors: {
          nextStatus: "Select a different production status.",
        },

        formError: "The order is already in this production status.",
      };
    }

    if (!canTransition(currentStatus, nextStatus)) {
      return {
        success: false,

        fieldErrors: {
          nextStatus: currentStatus
            ? `Cannot move directly from ${getStatusLabel(
              currentStatus,
            )} to ${getStatusLabel(nextStatus)}.`
            : "The first production status must be Order Placed.",
        },

        formError: "Invalid production status transition.",
      };
    }

    // An order placed with its artwork to follow waits at Awaiting Artwork
    // (ART-03), so it can't skip straight to approval and into production.
    if (
      currentStatus === "order-placed" &&
      nextStatus === "proof-approved" &&
      artworkPending(order)
    ) {
      return {
        success: false,

        fieldErrors: {
          nextStatus:
            "This order is waiting for the buyer's artwork. Set Artwork Received first.",
        },

        formError: "The order is on hold for artwork.",
      };
    }

    const changedAt = new Date().toISOString();

    let productionDueAt = null;

    let nextProofVersion = null;
    if (nextStatus === "proof-sent") {
      const currentVersion = Number(order.proofVersion?.value || 0);

      nextProofVersion = currentVersion + 1;
    }
    if (nextStatus === "proof-approved") {
      const isRush = order.rush?.value === "true";

      const productionDays = isRush
        ? RUSH_DAYS
        : await getProductionSlaDays(admin);

      const holidays = await getHolidays(admin);

      productionDueAt = addBusinessDays(
        changedAt,
        productionDays,
        holidays,
      ).toISOString();
    }

    await removeTags(admin, orderId, productionTags);

    await addTags(admin, orderId, [`hyve-status:${nextStatus}`]);

    await setOrderMetafields(admin, {
      orderId,

      status: nextStatus,

      changedAt,

      productionDueAt,

      onHoldReason,

      proofUrl: nextStatus === "proof-sent" ? proofUrl : null,

      proofVersion: nextStatus === "proof-sent" ? nextProofVersion : null,

      productionPhotoUrl:
        nextStatus === "production-complete" ? productionPhotoUrl : null,
    });

    const user = session?.onlineAccessInfo?.associated_user;

    const changedBy =
      user?.email ||
      [user?.first_name, user?.last_name].filter(Boolean).join(" ") ||
      "Shopify Admin";

    let historyNote = note;

    if (nextStatus === "proof-sent") {
      const proofAudit = `Proof version ${nextProofVersion} sent: ${proofUrl}`;

      historyNote = historyNote ? `${historyNote}\n${proofAudit}` : proofAudit;
    }

    if (nextStatus === "production-complete") {
      const photoAudit = `Production photo: ${productionPhotoUrl}`;

      historyNote = historyNote ? `${historyNote}\n${photoAudit}` : photoAudit;
    }

    await createHistory(admin, {
      orderId,

      orderName: order.name,

      fromStatus: currentStatus,

      toStatus: nextStatus,

      changedAt,

      changedBy,

      note: historyNote,
    });

    let emailSent = false;

    let emailWarning = null;

    let emailAlreadySent = false;

    if (CUSTOMER_EMAIL_STATUSES.has(nextStatus)) {
      try {
        const result = await sendCurrentCustomerStatusEmail({
          admin,

          order,

          orderId,

          status: nextStatus,

          proofUrl:
            nextStatus === "proof-sent"
              ? proofUrl
              : order.proofUrl?.value || "",

          proofVersion:
            nextStatus === "proof-sent"
              ? nextProofVersion
              : Number(order.proofVersion?.value || 0),

          productionDueAt,

          productionPhotoUrl:
            nextStatus === "production-complete"
              ? productionPhotoUrl
              : order.productionPhotoUrl?.value || "",
        });

        emailSent = result.sent;

        emailAlreadySent = result.alreadySent;
      } catch (emailError) {
        console.error(`${nextStatus} customer email failed:`, emailError);

        emailWarning =
          emailError instanceof Error
            ? `The production status was saved, but the customer email could not be sent: ${emailError.message}`
            : "The production status was saved, but the customer email could not be sent.";
      }
    }

    /* -------------------------------------------------------------------- */
    /* Response                                                             */
    /* -------------------------------------------------------------------- */

    let message = `${order.name} moved to ${getStatusLabel(nextStatus)}.`;

    if (nextStatus === "proof-sent") {
      message += ` Proof version ${nextProofVersion} saved.`;
    }

    if (nextStatus === "production-complete") {
      message += " Production photo saved.";
    }

    if (productionDueAt) {
      message += ` Production due ${formatDate(productionDueAt)}.`;
    }

    if (emailSent) {
      message += " Customer email sent.";
    }

    if (emailAlreadySent) {
      message += " Customer notification had already been sent.";
    }

    return {
      success: true,

      message,

      productionDueAt,

      proofVersion: nextProofVersion,

      emailSent,

      emailWarning,

      emailAlreadySent,

      fieldErrors: {},

      formError: null,
    };
  } catch (error) {
    console.error("Production order action error:", error);

    return {
      success: false,

      fieldErrors: {},

      formError:
        error instanceof Error
          ? error.message
          : "Unable to update production order.",
    };
  }
}

function TimelineItem({ item, isLatest }) {
  return (
    <s-box paddingBlockEnd="base">
      <s-grid gridTemplateColumns="32px 1fr" gap="base">
        <s-stack direction="block" alignItems="center">
          <s-badge tone={isLatest ? "success" : "neutral"}>
            {isLatest ? "●" : "○"}
          </s-badge>
        </s-stack>

        <s-box padding="base" border="base" borderRadius="base">
          <s-stack direction="block" gap="small">
            <s-stack
              direction="inline"
              justifyContent="space-between"
              gap="base"
            >
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone={statusTone(item.toStatus)}>
                  {getStatusLabel(item.toStatus)}
                </s-badge>

                {item.fromStatus && (
                  <s-text tone="subdued">
                    from {getStatusLabel(item.fromStatus)}
                  </s-text>
                )}
              </s-stack>

              <s-text tone="subdued">{formatDate(item.changedAt)}</s-text>
            </s-stack>

            <s-text tone="subdued">Changed by {item.changedBy}</s-text>

            {item.source && (
              <s-text tone="subdued">Source: {item.source}</s-text>
            )}

            {item.note && (
              <s-box padding="small" background="subdued" borderRadius="base">
                <s-paragraph>{item.note}</s-paragraph>
              </s-box>
            )}
          </s-stack>
        </s-box>
      </s-grid>
    </s-box>
  );
}

export default function ProductionOrderDetailsPage() {
  const loaderData = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const navigate = useNavigate();

  const submit = useSubmit();

  const order = loaderData?.order;

  const [nextStatus, setNextStatus] = useState("");

  const [note, setNote] = useState("");

  const [onHoldReason, setOnHoldReason] = useState("");

  const [proofUrl, setProofUrl] = useState(order?.proofUrl || "");

  const [productionPhotoUrl, setProductionPhotoUrl] = useState(
    order?.productionPhotoUrl || "",
  );

  const [clientErrors, setClientErrors] = useState({});
  useEffect(() => {
    setProofUrl(order?.proofUrl || "");
  }, [order?.proofUrl]);

  useEffect(() => {
    setProductionPhotoUrl(order?.productionPhotoUrl || "");
  }, [order?.productionPhotoUrl]);

  useEffect(() => {
    if (actionData?.success && actionData?.message) {
      shopify.toast.show(actionData.message);

      setNextStatus("");
      setNote("");
      setOnHoldReason("");
    }
  }, [actionData]);

  const busy = navigation.state !== "idle";
  const allowedStatuses = useMemo(() => {
    if (!order) {
      return [];
    }

    if (!order.productionStatus) {
      return ["order-placed"];
    }

    return STATUS_TRANSITIONS[order.productionStatus] ?? [];
  }, [order]);

  function clearFieldError(field) {
    setClientErrors((current) => ({
      ...current,

      [field]: undefined,
    }));
  }

  function saveStatus() {
    if (!order) {
      return;
    }

    const errors = validateStatusChange({
      nextStatus,
      onHoldReason,
      proofUrl,
      productionPhotoUrl,
    });

    if (nextStatus && !canTransition(order.productionStatus, nextStatus)) {
      errors.nextStatus = "This production status transition is not allowed.";
    }

    if (Object.keys(errors).length > 0) {
      setClientErrors(errors);

      return;
    }

    setClientErrors({});

    const formData = new FormData();

    formData.set("intent", "change_status");

    formData.set("nextStatus", nextStatus);

    formData.set("note", note);

    formData.set("onHoldReason", onHoldReason);

    formData.set("proofUrl", nextStatus === "proof-sent" ? proofUrl : "");

    formData.set(
      "productionPhotoUrl",
      nextStatus === "production-complete" ? productionPhotoUrl : "",
    );

    submit(formData, {
      method: "post",
    });
  }


  function retryProofEmail() {
    const formData = new FormData();

    formData.set("intent", "retry_proof_email");

    submit(formData, {
      method: "post",
    });
  }

  if (loaderData?.loaderError) {
    return (
      <s-page heading="Production Order" inlineSize="large">
        <s-banner tone="critical" heading="Unable to load order">
          <s-paragraph>{loaderData.loaderError}</s-paragraph>
        </s-banner>
      </s-page>
    );
  }

  if (!order) {
    return null;
  }

  const money = order.totalPriceSet?.shopMoney;

  const shipping = order.shippingAddress;

  const nextProofVersion = Number(order.proofVersion || 0) + 1;

  const canRetryProofEmail =
    order.productionStatus === "proof-sent" &&
    Boolean(order.proofUrl) &&
    Number(order.proofVersion) > 0 &&
    !order.proofEmailSent;

  return (
    <s-page heading={order.name} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/production-orders">Production Orders</s-link>

      {actionData?.success === false && actionData?.formError && (
        <s-banner tone="critical" heading="Unable to complete action">
          <s-paragraph>{actionData.formError}</s-paragraph>
        </s-banner>
      )}
      {actionData?.success && actionData?.emailWarning && (
        <s-banner
          tone="warning"
          heading="Status updated, but customer email was not sent"
        >
          <s-paragraph>{actionData.emailWarning}</s-paragraph>
        </s-banner>
      )}

      <s-stack direction="block" gap="base">
        <s-section>
          <s-stack direction="block" gap="base">
            <s-stack
              direction="inline"
              justifyContent="space-between"
              alignItems="center"
              gap="base"
            >
              <s-stack direction="block" gap="small">
                <s-heading>Production overview</s-heading>

                <s-text tone="subdued">
                  Ordered {formatDate(order.createdAt)}
                </s-text>
              </s-stack>

              <s-stack direction="inline" gap="small">
                {order.rush && <s-badge tone="critical">Rush</s-badge>}

                {order.artworkRequired && (
                  <s-badge tone="info">Artwork required</s-badge>
                )}

                <s-badge tone={statusTone(order.productionStatus)}>
                  {getStatusLabel(order.productionStatus)}
                </s-badge>
              </s-stack>
            </s-stack>

            <s-grid gridTemplateColumns="repeat(4, minmax(0, 1fr))" gap="base">
              <s-box padding="base" border="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-text tone="subdued">Order total</s-text>

                  <s-heading>
                    {formatMoney(
                      money?.amount || "0",

                      money?.currencyCode || "USD",
                    )}
                  </s-heading>
                </s-stack>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-text tone="subdued">Financial</s-text>

                  <s-heading>{order.displayFinancialStatus || "—"}</s-heading>
                </s-stack>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-text tone="subdued">Fulfillment</s-text>

                  <s-heading>{order.displayFulfillmentStatus || "—"}</s-heading>
                </s-stack>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-text tone="subdued">Production due</s-text>

                  <s-heading>{formatDate(order.productionDueAt)}</s-heading>
                </s-stack>
              </s-box>
            </s-grid>
          </s-stack>
        </s-section>

        <s-grid gridTemplateColumns="2fr 1fr" gap="base" alignItems="start">
          <s-stack direction="block" gap="base">
            <s-section heading="Update production status">
              <s-stack direction="block" gap="base">
                <s-select
                  label="Next status"
                  value={nextStatus}
                  error={
                    clientErrors.nextStatus ||
                    actionData?.fieldErrors?.nextStatus ||
                    undefined
                  }
                  onChange={(event) => {
                    const value = event.currentTarget.value;

                    setNextStatus(value);

                    clearFieldError("nextStatus");

                    if (value !== "on-hold") {
                      setOnHoldReason("");
                    }
                  }}
                >
                  <s-option value="">Select next status</s-option>

                  {STATUS_OPTIONS.filter((status) =>
                    allowedStatuses.includes(status.value),
                  ).map((status) => (
                    <s-option key={status.value} value={status.value}>
                      {status.label}
                    </s-option>
                  ))}
                </s-select>
                {nextStatus === "proof-sent" && (
                  <s-box padding="base" border="base" borderRadius="base">
                    <s-stack direction="block" gap="base">
                      <s-heading>Proof details</s-heading>

                      <s-banner tone="info">
                        <s-paragraph>
                          The customer will receive the proof link after the
                          status is updated.
                        </s-paragraph>
                      </s-banner>

                      <s-text-field
                        label="Proof URL"
                        type="url"
                        placeholder="https://..."
                        value={proofUrl}
                        error={
                          clientErrors.proofUrl ||
                          actionData?.fieldErrors?.proofUrl ||
                          undefined
                        }
                        onInput={(event) => {
                          setProofUrl(event.currentTarget.value);

                          clearFieldError("proofUrl");
                        }}
                      />

                      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                        <s-box>
                          <s-text tone="subdued">Current proof version</s-text>

                          <s-heading>{order.proofVersion || 0}</s-heading>
                        </s-box>

                        <s-box>
                          <s-text tone="subdued">New proof version</s-text>

                          <s-heading>{nextProofVersion}</s-heading>
                        </s-box>
                      </s-grid>

                      {proofUrl && validateHttpUrl(proofUrl) && (
                        <s-button href={proofUrl} target="_blank">
                          Preview proof
                        </s-button>
                      )}
                    </s-stack>
                  </s-box>
                )}

                {nextStatus === "production-complete" && (
                  <s-box padding="base" border="base" borderRadius="base">
                    <s-stack direction="block" gap="base">
                      <s-heading>Production photo</s-heading>

                      <s-banner tone="info">
                        <s-paragraph>
                          A production photo URL is required. Use a direct link
                          to the image, such as one copied from Content › Files,
                          so the photo shows in the Production Completed email.
                        </s-paragraph>
                      </s-banner>

                      <s-text-field
                        label="Production photo URL"
                        type="url"
                        placeholder="https://..."
                        value={productionPhotoUrl}
                        error={
                          clientErrors.productionPhotoUrl ||
                          actionData?.fieldErrors?.productionPhotoUrl ||
                          undefined
                        }
                        onInput={(event) => {
                          setProductionPhotoUrl(event.currentTarget.value);

                          clearFieldError("productionPhotoUrl");
                        }}
                      />

                      {productionPhotoUrl &&
                        validateHttpUrl(productionPhotoUrl) && (
                          <s-button href={productionPhotoUrl} target="_blank">
                            Preview production photo
                          </s-button>
                        )}
                    </s-stack>
                  </s-box>
                )}
                {nextStatus === "on-hold" && (
                  <s-text-field
                    label="On hold reason"
                    value={onHoldReason}
                    error={
                      clientErrors.onHoldReason ||
                      actionData?.fieldErrors?.onHoldReason ||
                      undefined
                    }
                    onInput={(event) => {
                      setOnHoldReason(event.currentTarget.value);

                      clearFieldError("onHoldReason");
                    }}
                  />
                )}

                <s-text-area
                  label="Internal note"
                  value={note}
                  placeholder="Optional note about this status change"
                  onInput={(event) => setNote(event.currentTarget.value)}
                />

                <s-stack direction="inline" justifyContent="end">
                  <s-button
                    variant="primary"
                    disabled={busy || !nextStatus}
                    onClick={saveStatus}
                  >
                    {busy ? "Updating..." : "Update status"}
                  </s-button>
                </s-stack>
              </s-stack>
            </s-section>

            <s-section heading="Products">
              <s-stack direction="block" gap="base">
                {order.lineItems?.nodes?.length ? (
                  order.lineItems.nodes.map((item) => {
                    const price = item.originalUnitPriceSet?.shopMoney;

                    const imprint = item.customAttributes?.find(
                      (attribute) => attribute.key === "Imprint Locations",
                    );

                    return (
                      <s-box
                        key={item.id}
                        padding="base"
                        border="base"
                        borderRadius="base"
                      >
                        <s-grid
                          gridTemplateColumns="2fr 1fr 1fr"
                          gap="base"
                          alignItems="center"
                        >
                          <s-stack direction="block" gap="small">
                            <s-text>{item.title}</s-text>

                            <s-text tone="subdued">
                              SKU: {item.sku || "—"}
                            </s-text>

                            {item.variantTitle && (
                              <s-text tone="subdued">
                                {item.variantTitle}
                              </s-text>
                            )}

                            {imprint?.value && (
                              <s-text tone="subdued">
                                Decoration: {imprint.value}
                              </s-text>
                            )}
                          </s-stack>

                          <s-text>Qty: {item.quantity}</s-text>

                          <s-text>
                            {formatMoney(
                              price?.amount || "0",

                              price?.currencyCode || "USD",
                            )}
                          </s-text>
                        </s-grid>
                      </s-box>
                    );
                  })
                ) : (
                  <s-paragraph>No products found.</s-paragraph>
                )}
              </s-stack>
            </s-section>
            <s-section heading="Production timeline">
              <s-stack direction="block" gap="small">
                {loaderData.history?.length === 0 ? (
                  <s-box padding="base" border="base" borderRadius="base">
                    <s-paragraph>
                      No production status history has been recorded yet.
                    </s-paragraph>
                  </s-box>
                ) : (
                  loaderData.history.map((item, index) => (
                    <TimelineItem
                      key={item.id}
                      item={item}
                      isLatest={index === 0}
                    />
                  ))
                )}
              </s-stack>
            </s-section>
          </s-stack>
          <s-stack direction="block" gap="base">

            <s-section heading="Customer">
              <s-stack direction="block" gap="small">
                <s-text>
                  {order.customer?.displayName ||
                    shipping?.name ||
                    "Guest customer"}
                </s-text>

                <s-text tone="subdued">
                  {getCustomerEmail(order) || "No email"}
                </s-text>

                {(order.customer?.phone || order.phone) && (
                  <s-text tone="subdued">
                    {order.customer?.phone || order.phone}
                  </s-text>
                )}
              </s-stack>
            </s-section>
            <s-section heading="Shipping address">
              {shipping ? (
                <s-stack direction="block" gap="small">
                  <s-text>{shipping.name}</s-text>

                  <s-text tone="subdued">{shipping.address1}</s-text>

                  {shipping.address2 && (
                    <s-text tone="subdued">{shipping.address2}</s-text>
                  )}

                  <s-text tone="subdued">
                    {[shipping.city, shipping.province, shipping.zip]
                      .filter(Boolean)
                      .join(", ")}
                  </s-text>

                  <s-text tone="subdued">{shipping.country}</s-text>

                  {shipping.phone && (
                    <s-text tone="subdued">{shipping.phone}</s-text>
                  )}
                </s-stack>
              ) : (
                <s-text tone="subdued">No shipping address.</s-text>
              )}
            </s-section>
            <s-section heading="Production">
              <s-stack direction="block" gap="base">
                <s-stack
                  direction="inline"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-text>Status</s-text>

                  <s-badge tone={statusTone(order.productionStatus)}>
                    {getStatusLabel(order.productionStatus)}
                  </s-badge>
                </s-stack>

                <s-stack direction="inline" justifyContent="space-between">
                  <s-text>Artwork required</s-text>

                  <s-badge tone={order.artworkRequired ? "info" : "neutral"}>
                    {order.artworkRequired ? "Yes" : "No"}
                  </s-badge>
                </s-stack>

                <s-stack direction="inline" justifyContent="space-between">
                  <s-text>Rush</s-text>

                  <s-badge tone={order.rush ? "critical" : "neutral"}>
                    {order.rush ? "Yes" : "No"}
                  </s-badge>
                </s-stack>

                <s-divider />

                <s-stack direction="block" gap="small">
                  <s-text tone="subdued">Status changed</s-text>

                  <s-text>{formatDate(order.statusChangedAt)}</s-text>
                </s-stack>

                <s-stack direction="block" gap="small">
                  <s-text tone="subdued">Production due</s-text>

                  <s-text>{formatDate(order.productionDueAt)}</s-text>
                </s-stack>

                {order.onHoldReason && (
                  <s-banner tone="critical" heading="Order on hold">
                    <s-paragraph>{order.onHoldReason}</s-paragraph>
                  </s-banner>
                )}
              </s-stack>
            </s-section>
            <s-section heading="Artwork & proof">
              <s-stack direction="block" gap="base">
                <s-stack
                  direction="inline"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-text>Proof version</s-text>

                  <s-badge>{order.proofVersion || 0}</s-badge>
                </s-stack>

                {order.proofUrl ? (
                  <>
                    <s-button href={order.proofUrl} target="_blank">
                      View current proof
                    </s-button>

                    {order.proofEmailSent ? (
                      <s-banner tone="success" heading="Proof email sent">
                        <s-paragraph>
                          Proof version {order.proofVersion} has been sent to
                          the customer.
                        </s-paragraph>
                      </s-banner>
                    ) : (
                      order.productionStatus === "proof-sent" && (
                        <s-banner
                          tone="warning"
                          heading="Proof email not confirmed"
                        >
                          <s-stack direction="block" gap="small">
                            <s-paragraph>
                              The current proof does not have its notification
                              tag.
                            </s-paragraph>

                            {canRetryProofEmail && (
                              <s-button
                                disabled={busy}
                                onClick={retryProofEmail}
                              >
                                {busy ? "Sending..." : "Retry proof email"}
                              </s-button>
                            )}
                          </s-stack>
                        </s-banner>
                      )
                    )}
                  </>
                ) : (
                  <s-text tone="subdued">No proof has been sent yet.</s-text>
                )}

                <s-divider />

                {order.productionPhotoUrl ? (
                  <s-button href={order.productionPhotoUrl} target="_blank">
                    View production photo
                  </s-button>
                ) : (
                  <s-text tone="subdued">No production photo uploaded.</s-text>
                )}
              </s-stack>
            </s-section>
            {order.note && (
              <s-section heading="Order note">
                <s-paragraph>{order.note}</s-paragraph>
              </s-section>
            )}
          </s-stack>
        </s-grid>
      </s-stack>
    </s-page>
  );
}
