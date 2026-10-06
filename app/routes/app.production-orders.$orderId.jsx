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
  sendReadyForCollectionEmail,
  sendEstimatedShipDateEmail,
} from "../utils/email.server";
import { proofDecisionLinks } from "../lib/proof.server";
import {
  notifyCustomerServiceOrderOnHold,
  productionCalendar,
  productionDueDate,
} from "../lib/order-status.server";
import {
  syncLineItemArtworkReceived,
  updateLineItemArtworkAttributesInPayload,
} from "../lib/order-artwork.server";
import { staffMemberLabel } from "../lib/staff-member.server";
import { NOTIFICATIONS_PAUSED_TAG } from "../utils/sla-engine.server";
import { statusEmailWanted } from "../lib/notification-preferences.server";
import {
  CUSTOMER_EMAIL_STATUSES,
  customerArrangesFreight,
  STATUS_OPTIONS,
  allowedMoves,
} from "../lib/production-statuses";
import { ShopifyFileUpload } from "../components/ShopifyFileUpload";

/** Set once a paid physical sample has been approved (ORS-03, HYV-102). */
const SAMPLE_APPROVED_TAG = "hyve-sample:approved";
const READY_FOR_COLLECTION_STATUS = "ready-for-collection";

/** An order carrying the paid physical sample charge, chosen at checkout. */
function hasPhysicalSample(order) {
  return (order?.lineItems?.nodes || []).some((line) =>
    (line?.customAttributes || []).some(
      (attr) => attr?.key === "_hyve_sample" && String(attr.value) === "true",
    ),
  );
}
const VALID_STATUSES = new Set(STATUS_OPTIONS.map((status) => status.value));

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
    case READY_FOR_COLLECTION_STATUS:
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

/**
 * A due date as the day alone, in Singapore time. The time of day it carries
 * is only the time the proof was approved, which read as a deadline hour.
 */
function formatDay(value) {
  const date = value ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
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
      // The code, not a symbol: en-SG prints SGD as a bare "$" (HYV-143).
      currencyDisplay: "code",
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

/** On Hold's moves depend on where it was held, so it takes the history (HYV-100). */
function canTransition(currentStatus, nextStatus, history = []) {
  if (
    currentStatus === "production-complete" &&
    nextStatus === READY_FOR_COLLECTION_STATUS
  ) {
    return true;
  }

  return allowedMoves(currentStatus, history).includes(nextStatus);
}

function getCustomerEmail(order) {
  return (
    order.customer?.defaultEmailAddress?.emailAddress ||
    order.customer?.email ||
    order.email ||
    ""
  );
}

function getCustomerNotificationTag(
  status,
  proofVersion,
  productionPhotoVersion,
) {
  if (status === "proof-sent") {
    return `hyve-notified:proof-sent-v${proofVersion}`;
  }

  if (status === "production-complete") {
    return `hyve-notified:production-complete-v${productionPhotoVersion || 1}`;
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
            shippingLine {
              title
            }
totalPriceSet {
              presentmentMoney {
                amount
                currencyCode
              }
            }

            subtotalPriceSet {
              presentmentMoney {
                amount
                currencyCode
              }
            }

            totalShippingPriceSet {
              presentmentMoney {
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
      presentmentMoney {
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

            productionPhotoVersion: metafield(
              namespace: "$app"
              key: "production_photo_version"
            ) {
              value
            }

            productionApprovalStatus: metafield(
              namespace: "$app"
              key: "production_approval_status"
            ) {
              value
            }

            productionApprovalAt: metafield(
              namespace: "$app"
              key: "production_approval_at"
            ) {
              value
            }

            productionApprovalNote: metafield(
              namespace: "$app"
              key: "production_approval_note"
            ) {
              value
            }

            onHoldReason: metafield(
              namespace: "$app"
              key: "on_hold_reason"
            ) {
              value
            }

            estimatedShipDate: metafield(
              namespace: "hyve"
              key: "estimated_ship_date"
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

  const currentStatus =
    order.productionStatus?.value ||
    (order.tags || [])
      .find((t) => t.startsWith("hyve-status:"))
      ?.slice("hyve-status:".length) ||
    "";

  if (currentStatus && currentStatus !== "order-placed") {
    if (order.lineItems?.nodes) {
      order.lineItems.nodes = updateLineItemArtworkAttributesInPayload(
        order.lineItems.nodes,
      );
    }
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

async function setProductionApprovalDecision(
  admin,
  { orderId, status, note = "", approvedAt = null },
) {
  const metafields = [
    {
      ownerId: orderId,
      namespace: "$app",
      key: "production_approval_status",
      type: "single_line_text_field",
      value: status,
    },
  ];

  if (approvedAt) {
    metafields.push({
      ownerId: orderId,
      namespace: "$app",
      key: "production_approval_at",
      type: "date_time",
      value: approvedAt,
    });
  }

  if (note?.trim()) {
    metafields.push({
      ownerId: orderId,
      namespace: "$app",
      key: "production_approval_note",
      type: "multi_line_text_field",
      value: note.trim(),
    });
  }

  const response = await admin.graphql(
    `#graphql
      mutation SetProductionApprovalDecision(
        $metafields: [MetafieldsSetInput!]!
      ) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    { variables: { metafields } },
  );

  const data = await parseGraphQL(response, "SetProductionApprovalDecision");

  throwUserErrors(
    data.data?.metafieldsSet?.userErrors,
    "SetProductionApprovalDecision",
  );
}

async function clearProductionApprovalDecision(admin, orderId) {
  const response = await admin.graphql(
    `#graphql
      mutation ClearProductionApprovalDecision(
        $metafields: [MetafieldIdentifierInput!]!
      ) {
        metafieldsDelete(metafields: $metafields) {
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
            key: "production_approval_at",
          },
          {
            ownerId: orderId,
            namespace: "$app",
            key: "production_approval_note",
          },
        ],
      },
    },
  );

  const data = await parseGraphQL(response, "ClearProductionApprovalDecision");

  throwUserErrors(
    data.data?.metafieldsDelete?.userErrors,
    "ClearProductionApprovalDecision",
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
    productionPhotoVersion,
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
    metafields.push(
      {
        ownerId: orderId,
        namespace: "$app",
        key: "production_photo_url",
        type: "url",
        value: productionPhotoUrl.trim(),
      },
      {
        ownerId: orderId,
        namespace: "$app",
        key: "production_photo_version",
        type: "number_integer",
        value: String(productionPhotoVersion || 1),
      },
      {
        ownerId: orderId,
        namespace: "$app",
        key: "production_approval_status",
        type: "single_line_text_field",
        value: "pending",
      },
    );
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
  productionPhotoVersion,
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

    case "proof-approved": {
      let estimatedShipDate = order.estimatedShipDate?.value;
      if (!estimatedShipDate && productionDueAt) {
        const d = new Date(productionDueAt);
        d.setDate(d.getDate() + 5);
        estimatedShipDate = d.toISOString();
      }
      return sendProofApprovedEmail({
        ...common,

        productionDueAt,
        estimatedShipDate,
      });
    }

    case "production-complete":
      return sendProductionCompleteEmail({
        ...common,

        productionPhotoUrl,
        productionPhotoVersion,
      });

    case READY_FOR_COLLECTION_STATUS:
      return sendReadyForCollectionEmail({
        ...common,
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
  productionPhotoVersion,
}) {
  if (!CUSTOMER_EMAIL_STATUSES.has(status)) {
    return {
      sent: false,
      alreadySent: false,
      notificationTag: null,
      messageId: null,
    };
  }

  const notificationTag = getCustomerNotificationTag(
    status,
    proofVersion,
    productionPhotoVersion,
  );

  const alreadySent = await hasOrderTag(admin, orderId, notificationTag);

  if (alreadySent) {
    return {
      sent: false,
      alreadySent: true,
      notificationTag,
      messageId: null,
    };
  }

  // The buyer switched status emails off in Settings (HYV-110).
  if (!(await statusEmailWanted(admin, order.customer?.id, status))) {
    return {
      sent: false,
      alreadySent: false,
      optedOut: true,
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
    productionPhotoVersion,
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

        // HYV-102 / HYV-110 staff controls.
        estimatedShipDate: order.estimatedShipDate?.value || "",

        notificationsPaused: (order.tags ?? []).includes(
          NOTIFICATIONS_PAUSED_TAG,
        ),

        customerArrangedFreight: customerArrangesFreight(order),

        hasPhysicalSample: hasPhysicalSample(order),

        sampleApproved: (order.tags ?? []).includes(SAMPLE_APPROVED_TAG),

        productionPhotoUrl: order.productionPhotoUrl?.value || "",

        productionPhotoVersion: Number(
          order.productionPhotoVersion?.value || 0,
        ),

        productionApprovalStatus: order.productionApprovalStatus?.value || "",

        productionApprovalAt: order.productionApprovalAt?.value || "",

        productionApprovalNote: order.productionApprovalNote?.value || "",

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
  const { admin, sessionToken } = await authenticate.admin(request);

  try {
    if (!params.orderId) {
      throw new Error("Order ID is missing.");
    }

    const orderId = `gid://shopify/Order/${params.orderId}`;

    const formData = await request.formData();

    const intent = String(formData.get("intent") || "").trim();

    // HYV-110: pause or resume this order's automatic messages.
    if (intent === "toggle_notifications") {
      const order = await getOrder(admin, orderId);
      const paused = (order.tags ?? []).includes(NOTIFICATIONS_PAUSED_TAG);
      if (paused) await removeTags(admin, orderId, [NOTIFICATIONS_PAUSED_TAG]);
      else await addTags(admin, orderId, [NOTIFICATIONS_PAUSED_TAG]);
      return {
        success: true,
        message: paused
          ? "Automatic messages resumed for this order."
          : "Automatic messages paused for this order. Status emails still go out.",
      };
    }

    if (intent === "send_estimated_ship_date_email") {
      const order = await getOrder(admin, orderId);
      let estimatedShipDate = order.estimatedShipDate?.value;
      if (!estimatedShipDate && order.productionDueAt?.value) {
        const d = new Date(order.productionDueAt.value);
        d.setDate(d.getDate() + 5);
        estimatedShipDate = d.toISOString();
      }

      if (!estimatedShipDate) {
        return {
          success: false,
          formError: "Cannot send email: both estimated ship date and production due date are missing.",
        };
      }

      const customerEmail = getCustomerEmail(order);
      if (!customerEmail) {
        return { success: false, formError: "Customer email is missing." };
      }

      await sendEstimatedShipDateEmail({
        customerEmail,
        customerName: order.customer?.displayName || order.shippingAddress?.name || "Customer",
        orderName: order.name,
        orderDate: order.createdAt,
        estimatedShipDate,
        lineItems: order.lineItems?.nodes || [],
      });

      return {
        success: true,
        message: "Estimated ship date email sent to the customer.",
      };
    }

    // HYV-102: the ship date customer service gives the buyer, shown in the
    // portal in place of the calculated production date. Blank clears it.
    if (intent === "set_ship_date") {
      const value = String(formData.get("estimatedShipDate") || "").trim();
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { success: false, formError: "Enter the ship date as a date." };
      }
      const identifier = {
        ownerId: orderId,
        namespace: "hyve",
        key: "estimated_ship_date",
      };
      const response = await admin.graphql(
        value
          ? `#graphql
            mutation ShipDateSet($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) { userErrors { field message } }
            }`
          : `#graphql
            mutation ShipDateClear($metafields: [MetafieldIdentifierInput!]!) {
              metafieldsDelete(metafields: $metafields) { userErrors { field message } }
            }`,
        {
          variables: {
            metafields: [
              value ? { ...identifier, type: "date", value } : identifier,
            ],
          },
        },
      );
      const body = await response.json();
      const error =
        body?.errors?.[0]?.message ||
        body?.data?.metafieldsSet?.userErrors?.[0]?.message ||
        body?.data?.metafieldsDelete?.userErrors?.[0]?.message;
      if (error) return { success: false, formError: error };
      return {
        success: true,
        message: value
          ? "Estimated ship date saved."
          : "Estimated ship date cleared; the calculated date shows again.",
      };
    }

    // HYV-102: the buyer approved their paid physical sample, so the full
    // production run can start.
    if (intent === "approve_sample") {
      await addTags(admin, orderId, [SAMPLE_APPROVED_TAG]);
      return {
        success: true,
        message: "Sample approved. The order can now move into production.",
      };
    }

    if (intent === "approve_production") {
      const order = await getOrder(admin, orderId);
      const currentStatus = order.productionStatus?.value || "";

      if (currentStatus !== "production-complete") {
        return {
          success: false,
          fieldErrors: {},
          formError:
            "Production can only be approved while the order is Production Complete.",
        };
      }

      if (!order.productionPhotoUrl?.value) {
        return {
          success: false,
          fieldErrors: {},
          formError: "A production photo is required before approval.",
        };
      }

      const approvedAt = new Date().toISOString();

      await setProductionApprovalDecision(admin, {
        orderId,
        status: "approved",
        approvedAt,
      });

      const changedBy =
        (await staffMemberLabel(request, sessionToken)) || "Shopify Admin";

      await createHistory(admin, {
        orderId,
        orderName: order.name,
        fromStatus: "production-complete",
        toStatus: "production-complete",
        changedAt: approvedAt,
        changedBy,
        note: "Production photo approved. Order may proceed to shipping.",
      });

      return {
        success: true,
        message:
          "Production photo approved. The order can now proceed to shipping.",
      };
    }

    if (intent === "decline_production") {
      const order = await getOrder(admin, orderId);
      const currentStatus = order.productionStatus?.value || "";
      const approvalNote = String(
        formData.get("productionApprovalNote") || "",
      ).trim();

      if (currentStatus !== "production-complete") {
        return {
          success: false,
          fieldErrors: {},
          formError:
            "Production changes can only be requested while the order is Production Complete.",
        };
      }

      if (!approvalNote) {
        return {
          success: false,
          fieldErrors: {
            productionApprovalNote: "Enter the requested production changes.",
          },
          formError: "Please enter why the production photo was declined.",
        };
      }

      const declinedAt = new Date().toISOString();

      await setProductionApprovalDecision(admin, {
        orderId,
        status: "declined",
        note: approvalNote,
      });

      const changedBy =
        (await staffMemberLabel(request, sessionToken)) || "Shopify Admin";

      await createHistory(admin, {
        orderId,
        orderName: order.name,
        fromStatus: "production-complete",
        toStatus: "production-complete",
        changedAt: declinedAt,
        changedBy,
        note: `Production photo declined: ${approvalNote}`,
      });

      return {
        success: true,
        message:
          "Production changes requested. The order remains Production Complete.",
      };
    }

    if (intent === "resubmit_production_photo") {
      const order = await getOrder(admin, orderId);
      const currentStatus = order.productionStatus?.value || "";
      const revisedPhotoUrl = String(
        formData.get("productionPhotoUrl") || "",
      ).trim();

      if (currentStatus !== "production-complete") {
        return {
          success: false,
          fieldErrors: {},
          formError:
            "A revised production photo can only be submitted while the order is Production Complete.",
        };
      }

      if (!revisedPhotoUrl || !validateHttpUrl(revisedPhotoUrl)) {
        return {
          success: false,
          fieldErrors: {
            productionPhotoUrl: "Enter a valid production photo URL.",
          },
          formError: "A valid production photo is required.",
        };
      }

      const nextProductionPhotoVersion =
        Number(order.productionPhotoVersion?.value || 0) + 1;

      await setOrderMetafields(admin, {
        orderId,
        status: "production-complete",
        changedAt: order.statusChangedAt?.value || new Date().toISOString(),
        productionDueAt: null,
        onHoldReason: null,
        proofUrl: null,
        proofVersion: null,
        productionPhotoUrl: revisedPhotoUrl,
        productionPhotoVersion: nextProductionPhotoVersion,
      });

      await clearProductionApprovalDecision(admin, orderId);

      const changedBy =
        (await staffMemberLabel(request, sessionToken)) || "Shopify Admin";

      await createHistory(admin, {
        orderId,
        orderName: order.name,
        fromStatus: "production-complete",
        toStatus: "production-complete",
        changedAt: new Date().toISOString(),
        changedBy,
        note: `Production photo version ${nextProductionPhotoVersion} submitted for approval: ${revisedPhotoUrl}`,
      });

      let emailWarning = null;
      try {
        await sendCurrentCustomerStatusEmail({
          admin,
          order,
          orderId,
          status: "production-complete",
          proofUrl: order.proofUrl?.value || "",
          proofVersion: Number(order.proofVersion?.value || 0),
          productionDueAt: order.productionDueAt?.value || null,
          productionPhotoUrl: revisedPhotoUrl,
          productionPhotoVersion: nextProductionPhotoVersion,
        });
      } catch (error) {
        emailWarning =
          error instanceof Error
            ? `Revised production photo saved, but the customer email could not be sent: ${error.message}`
            : "Revised production photo saved, but the customer email could not be sent.";
      }

      return {
        success: true,
        message: `Production photo version ${nextProductionPhotoVersion} submitted for approval.`,
        emailWarning,
      };
    }

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
          productionPhotoVersion: null,
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

    const customerArrangedFreight = customerArrangesFreight(order);

    if (
      currentStatus === "production-complete" &&
      customerArrangedFreight &&
      nextStatus === "shipped"
    ) {
      return {
        success: false,
        fieldErrors: {
          nextStatus:
            "Customer-arranged freight orders must be marked Ready For Collection instead of Shipped.",
        },
        formError:
          "This order uses customer-arranged freight. Move it to Ready For Collection.",
      };
    }

    if (
      nextStatus === READY_FOR_COLLECTION_STATUS &&
      (!customerArrangedFreight || currentStatus !== "production-complete")
    ) {
      return {
        success: false,
        fieldErrors: {
          nextStatus:
            "Ready For Collection is only available for customer-arranged freight orders after Production Complete.",
        },
        formError: "Ready For Collection is not valid for this order.",
      };
    }

    if (
      currentStatus === "production-complete" &&
      [
        customerArrangedFreight ? READY_FOR_COLLECTION_STATUS : "shipped",
      ].includes(nextStatus) &&
      order.productionApprovalStatus?.value !== "approved"
    ) {
      return {
        success: false,
        fieldErrors: {
          nextStatus: customerArrangedFreight
            ? "Production photo approval is required before the order can be marked Ready For Collection."
            : "Production photo approval is required before the order can be marked Shipped.",
        },
        formError:
          "The production photo must be approved before this order can proceed.",
      };
    }

    if (currentStatus === nextStatus) {
      return {
        success: false,

        fieldErrors: {
          nextStatus: "Select a different production status.",
        },

        formError: "The order is already in this production status.",
      };
    }

    // Where an order On Hold can go depends on the step it was held at, which
    // the history records (HYV-100).
    const history =
      currentStatus === "on-hold" ? await getStatusHistory(admin, orderId) : [];

    if (!canTransition(currentStatus, nextStatus, history)) {
      return {
        success: false,

        fieldErrors: {
          nextStatus: currentStatus
            ? `Cannot move directly from ${getStatusLabel(
              currentStatus,
            )} to ${getStatusLabel(nextStatus)}.`
            : "The first production status must be Order Received.",
        },

        formError: "Invalid production status transition.",
      };
    }

    // A paid physical sample ships and is approved before the full run
    // (ORS-03).
    if (
      nextStatus === "in-production" &&
      hasPhysicalSample(order) &&
      !(order.tags ?? []).includes(SAMPLE_APPROVED_TAG)
    ) {
      return {
        success: false,

        fieldErrors: {
          nextStatus:
            "This order has a paid physical sample. Mark the sample approved before starting production.",
        },

        formError: "Waiting for the sample to be approved.",
      };
    }

    const changedAt = new Date().toISOString();

    let productionDueAt = null;

    let nextProofVersion = null;
    let nextProductionPhotoVersion = null;

    if (nextStatus === "proof-sent") {
      const currentVersion = Number(order.proofVersion?.value || 0);

      nextProofVersion = currentVersion + 1;
    }
    if (nextStatus === "production-complete") {
      nextProductionPhotoVersion =
        Number(order.productionPhotoVersion?.value || 0) + 1;
    }

    if (nextStatus === "proof-approved") {
      // The same production time and holiday calendar as a proof the buyer
      // approves from the email or the portal: the standard or rush time in
      // Commercial Settings (HYV-133).
      productionDueAt = productionDueDate(
        await productionCalendar(admin),
        changedAt,
        order.rush?.value === "true",
      );
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

      productionPhotoVersion:
        nextStatus === "production-complete"
          ? nextProductionPhotoVersion
          : null,
    });

    if (nextStatus === "production-complete") {
      await clearProductionApprovalDecision(admin, orderId);
    }

    // The staff member making the move (HYV-100). "Shopify Admin" only when
    // Shopify can't say who.
    const changedBy =
      (await staffMemberLabel(request, sessionToken)) || "Shopify Admin";

    let historyNote = note;

    if (nextStatus === "proof-sent") {
      const proofAudit = `Proof version ${nextProofVersion} sent: ${proofUrl}`;

      historyNote = historyNote ? `${historyNote}\n${proofAudit}` : proofAudit;
    }

    if (nextStatus === "production-complete") {
      const photoAudit = `Production photo: ${productionPhotoUrl}`;

      historyNote = historyNote ? `${historyNote}\n${photoAudit}` : photoAudit;
    }

    if (nextStatus === READY_FOR_COLLECTION_STATUS) {
      const collectionAudit =
        "Customer-arranged freight order marked Ready For Collection. Customer collection email triggered.";
      historyNote = historyNote
        ? `${historyNote}
${collectionAudit}`
        : collectionAudit;
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

    let emailOptedOut = false;

    if (nextStatus === "on-hold") {
      try {
        const csResult = await notifyCustomerServiceOrderOnHold(admin, {
          order,
          onHoldReason,
          changedBy,
          note: historyNote,
        });
        if (csResult?.sent) {
          emailSent = true;
        }
      } catch (csError) {
        console.error("On-hold Customer Service notification failed:", csError);
      }
    }

    if (nextStatus === "artwork-received") {
      try {
        await syncLineItemArtworkReceived(admin, order);
      } catch (artError) {
        console.error("On Artwork Received line item update failed:", artError);
      }
    }

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

          productionPhotoVersion:
            nextStatus === "production-complete"
              ? nextProductionPhotoVersion
              : Number(order.productionPhotoVersion?.value || 0),
        });

        emailSent = result.sent;

        emailOptedOut = Boolean(result.optedOut);

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

    if (nextStatus === "on-hold" && emailSent) {
      message += " Customer Service notified.";
    } else if (emailSent) {
      message += " Customer email sent.";
    }

    if (emailAlreadySent) {
      message += " Customer notification had already been sent.";
    }

    if (emailOptedOut) {
      message += " No email sent: the buyer has switched status emails off.";
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

  const [productionApprovalNote, setProductionApprovalNote] = useState(
    order?.productionApprovalNote || "",
  );

  const [shipDate, setShipDate] = useState(order?.estimatedShipDate || "");
  useEffect(() => {
    setProofUrl(order?.proofUrl || "");
  }, [order?.proofUrl]);

  useEffect(() => {
    setProductionPhotoUrl(order?.productionPhotoUrl || "");
  }, [order?.productionPhotoUrl]);

  useEffect(() => {
    setProductionApprovalNote(order?.productionApprovalNote || "");
  }, [order?.productionApprovalNote]);

  useEffect(() => {
    if (actionData?.success && actionData?.message) {
      shopify.toast.show(actionData.message);

      setNextStatus("");
      setNote("");
      setOnHoldReason("");
      setProductionApprovalNote("");
    }
  }, [actionData]);

  const busy = navigation.state !== "idle";
  const allowedStatuses = useMemo(() => {
    if (!order) {
      return [];
    }

    const moves = allowedMoves(
      order.productionStatus,
      loaderData.history || [],
    );

    if (order.productionStatus === "production-complete") {
      if (order.customerArrangedFreight) {
        const withoutShipped = moves.filter((status) => status !== "shipped");

        if (order.productionApprovalStatus === "approved") {
          return [...new Set([...withoutShipped, READY_FOR_COLLECTION_STATUS])];
        }

        return withoutShipped;
      }

      if (order.productionApprovalStatus !== "approved") {
        return moves.filter((status) => status !== "shipped");
      }
    }

    return moves;
  }, [order, loaderData.history]);

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

    if (
      nextStatus &&
      !canTransition(
        order.productionStatus,
        nextStatus,
        loaderData.history || [],
      )
    ) {
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

  function approveProduction() {
    submitIntent("approve_production");
  }

  function declineProduction() {
    if (!productionApprovalNote.trim()) {
      setClientErrors((current) => ({
        ...current,
        productionApprovalNote: "Enter the requested production changes.",
      }));
      return;
    }

    clearFieldError("productionApprovalNote");
    submitIntent("decline_production", {
      productionApprovalNote: productionApprovalNote.trim(),
    });
  }

  function resubmitProductionPhoto() {
    if (!productionPhotoUrl || !validateHttpUrl(productionPhotoUrl)) {
      setClientErrors((current) => ({
        ...current,
        productionPhotoUrl: "Enter a valid production photo URL.",
      }));
      return;
    }

    clearFieldError("productionPhotoUrl");
    submitIntent("resubmit_production_photo", {
      productionPhotoUrl,
    });
  }

  function submitIntent(intent, fields = {}) {
    const formData = new FormData();

    formData.set("intent", intent);

    for (const [key, value] of Object.entries(fields)) formData.set(key, value);

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

  const money = order.totalPriceSet?.presentmentMoney;

  const shipping = order.shippingAddress;

  const nextProofVersion = Number(order.proofVersion || 0) + 1;

  const canRetryProofEmail =
    order.productionStatus === "proof-sent" &&
    Boolean(order.proofUrl) &&
    Number(order.proofVersion) > 0 &&
    !order.proofEmailSent;

  return (
    <s-page heading={order.name} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/production-orders">
        Production Orders
      </s-link>

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

                {order.customerArrangedFreight && (
                  <s-badge tone="info">Customer-arranged freight</s-badge>
                )}

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

                  <s-heading>{formatDay(order.productionDueAt)}</s-heading>
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
                      <s-heading>Artwork Proof</s-heading>

                      <s-banner tone="info">
                        <s-paragraph>
                          Upload the Artwork Proof, or paste a link to it. The
                          customer receives it by email once the status is
                          updated.
                        </s-paragraph>
                      </s-banner>

                      <ShopifyFileUpload
                        label="Upload Artwork Proof"
                        prefix={`${order.name}-proof-v${nextProofVersion}`}
                        onUploaded={(url) => {
                          setProofUrl(url);

                          clearFieldError("proofUrl");
                        }}
                      />

                      <s-text-field
                        label="Artwork Proof URL"
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
                      <s-heading>Production Photo</s-heading>

                      <s-banner tone="info">
                        <s-paragraph>
                          A Production Photo is required. Upload it, or paste a
                          direct link from Content › Files. A PNG or JPEG shows
                          in the Production Completed email; a PDF or SVG is
                          linked instead.
                        </s-paragraph>
                      </s-banner>

                      <ShopifyFileUpload
                        label="Upload Production Photo"
                        prefix={`${order.name}-photo`}
                        onUploaded={(url) => {
                          setProductionPhotoUrl(url);

                          clearFieldError("productionPhotoUrl");
                        }}
                      />

                      <s-text-field
                        label="Production Photo URL"
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
                    details="The customer sees this reason on the order in their account."
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
                    const price = item.originalUnitPriceSet?.presentmentMoney;

                    const imprint = item.customAttributes?.find(
                      (attribute) => attribute.key === "Imprint Locations",
                    );

                    const artwork = item.customAttributes?.find(
                      (attribute) =>
                        String(attribute.key || "").trim().toLowerCase() ===
                        "artwork",
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

                            {artwork?.value && (
                              <s-text tone="subdued">
                                Artwork: {artwork.value}
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

                {order.hasPhysicalSample && (
                  <s-stack direction="block" gap="small">
                    <s-stack
                      direction="inline"
                      justifyContent="space-between"
                      alignItems="center"
                    >
                      <s-text>Paid physical sample</s-text>

                      <s-badge
                        tone={order.sampleApproved ? "success" : "warning"}
                      >
                        {order.sampleApproved
                          ? "Approved"
                          : "Awaiting approval"}
                      </s-badge>
                    </s-stack>

                    {!order.sampleApproved && (
                      <s-button
                        variant="secondary"
                        onClick={() => submitIntent("approve_sample")}
                      >
                        Mark sample approved
                      </s-button>
                    )}
                  </s-stack>
                )}

                <s-divider />

                <s-stack direction="block" gap="small">
                  <s-date-field
                    label="Estimated ship date"
                    details="Shown to the buyer instead of the calculated production date. Leave blank to show the calculated one."
                    value={shipDate}
                    onChange={(event) => setShipDate(event.currentTarget.value)}
                  />

                  <s-button
                    variant="secondary"
                    onClick={() =>
                      submitIntent("set_ship_date", {
                        estimatedShipDate: shipDate,
                      })
                    }
                  >
                    Save ship date
                  </s-button>

                  <s-button
                    variant="secondary"
                    onClick={() =>
                      submitIntent("send_estimated_ship_date_email")
                    }
                  >
                    Send Estimated ship date email
                  </s-button>
                </s-stack>

                <s-stack direction="block" gap="small">
                  <s-stack
                    direction="inline"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <s-text>Automatic messages</s-text>

                    <s-badge
                      tone={order.notificationsPaused ? "warning" : "success"}
                    >
                      {order.notificationsPaused ? "Paused" : "On"}
                    </s-badge>
                  </s-stack>

                  <s-text tone="subdued">
                    Proof reminders, the day-10 On Hold and late-order alerts.
                    Status emails are not affected.
                  </s-text>

                  <s-button
                    variant="secondary"
                    onClick={() => submitIntent("toggle_notifications")}
                  >
                    {order.notificationsPaused
                      ? "Resume automatic messages"
                      : "Pause automatic messages"}
                  </s-button>
                </s-stack>

                <s-divider />

                <s-stack direction="block" gap="small">
                  <s-text tone="subdued">Status changed</s-text>

                  <s-text>{formatDate(order.statusChangedAt)}</s-text>
                </s-stack>

                <s-stack direction="block" gap="small">
                  <s-text tone="subdued">Production due</s-text>

                  <s-text>{formatDay(order.productionDueAt)}</s-text>
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
                  <s-stack direction="block" gap="small">
                    <s-button href={order.productionPhotoUrl} target="_blank">
                      View production photo
                    </s-button>

                    <s-stack
                      direction="inline"
                      justifyContent="space-between"
                      alignItems="center"
                    >
                      <s-text>Production approval</s-text>

                      <s-badge
                        tone={
                          order.productionApprovalStatus === "approved"
                            ? "success"
                            : order.productionApprovalStatus === "declined"
                              ? "critical"
                              : "warning"
                        }
                      >
                        {order.productionApprovalStatus === "approved"
                          ? "Approved"
                          : order.productionApprovalStatus === "declined"
                            ? "Changes requested"
                            : "Pending"}
                      </s-badge>
                    </s-stack>

                    <s-text tone="subdued">
                      Production photo version{" "}
                      {order.productionPhotoVersion || 1}
                    </s-text>

                    {order.productionApprovalAt && (
                      <s-text tone="subdued">
                        Approved {formatDate(order.productionApprovalAt)}
                      </s-text>
                    )}

                    {order.productionApprovalNote && (
                      <s-banner
                        tone="warning"
                        heading="Requested production changes"
                      >
                        <s-paragraph>
                          {order.productionApprovalNote}
                        </s-paragraph>
                      </s-banner>
                    )}

                    {order.productionStatus === "production-complete" &&
                      order.productionApprovalStatus !== "approved" && (
                        <>
                          <s-divider />

                          <s-text-area
                            label="Approval / change note"
                            value={productionApprovalNote}
                            placeholder="Enter requested changes when declining"
                            error={
                              clientErrors.productionApprovalNote ||
                              actionData?.fieldErrors?.productionApprovalNote ||
                              undefined
                            }
                            onInput={(event) => {
                              setProductionApprovalNote(
                                event.currentTarget.value,
                              );
                              clearFieldError("productionApprovalNote");
                            }}
                          />

                          <s-stack direction="inline" gap="small">
                            <s-button
                              variant="primary"
                              disabled={busy}
                              onClick={approveProduction}
                            >
                              {busy ? "Updating..." : "Approve production"}
                            </s-button>

                            <s-button
                              tone="critical"
                              disabled={busy}
                              onClick={declineProduction}
                            >
                              Request changes
                            </s-button>
                          </s-stack>

                          {order.productionApprovalStatus === "declined" && (
                            <s-box
                              padding="base"
                              border="base"
                              borderRadius="base"
                            >
                              <s-stack direction="block" gap="small">
                                <s-heading>
                                  Submit revised production photo
                                </s-heading>

                                <ShopifyFileUpload
                                  label="Upload Revised Production Photo"
                                  prefix={`${order.name}-photo-v${Number(order.productionPhotoVersion || 0) +
                                    1
                                    }`}
                                  onUploaded={(url) => {
                                    setProductionPhotoUrl(url);
                                    clearFieldError("productionPhotoUrl");
                                  }}
                                />

                                <s-text-field
                                  label="Revised Production Photo URL"
                                  type="url"
                                  placeholder="https://..."
                                  value={productionPhotoUrl}
                                  error={
                                    clientErrors.productionPhotoUrl ||
                                    actionData?.fieldErrors
                                      ?.productionPhotoUrl ||
                                    undefined
                                  }
                                  onInput={(event) => {
                                    setProductionPhotoUrl(
                                      event.currentTarget.value,
                                    );
                                    clearFieldError("productionPhotoUrl");
                                  }}
                                />

                                <s-button
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={resubmitProductionPhoto}
                                >
                                  {busy
                                    ? "Submitting..."
                                    : "Send revised photo for approval"}
                                </s-button>
                              </s-stack>
                            </s-box>
                          )}
                        </>
                      )}
                  </s-stack>
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
