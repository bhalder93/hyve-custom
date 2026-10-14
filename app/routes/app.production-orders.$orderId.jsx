import { singaporeDayDiff, singaporeDateKey, addCalendarDays } from "../utils/date.js";
import { formatDateTime as formatDate, formatDay } from "../utils/date.js";
// app/routes/app.production-orders.$orderId.jsx
/* eslint-disable react/prop-types */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  useActionData,
  useLoaderData,
  useNavigation,
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
  sendPhysicalSampleEmail,
} from "../utils/email.server";
import { proofDecisionLinks } from "../lib/proof.server";
import {
  notifyCustomerServiceOrderOnHold,
  productionCalendar,
  productionDueDate,
} from "../lib/order-status.server";
import { productionDecisionLinks } from "../lib/production-approval.server";
import { sampleDecisionLinks } from "../lib/sample-approval.server";
import { orderRequiresPhysicalSample } from "../lib/portal.server";
import { CREDIT_HOLD_TAG } from "../lib/credit-review.server";
import {
  syncLineItemArtworkReceived,
  updateLineItemArtworkAttributesInPayload,
} from "../lib/order-artwork.server";
import { loadPickupConfig } from "../lib/pickup-config.server";
import { loadInvoiceDocument } from "../lib/invoice-document.server";
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
import { incotermFromShipping } from "../lib/incoterm";

/** Set once a paid physical sample has been approved (ORS-03, HYV-102). */
const SAMPLE_APPROVED_TAG = "hyve-sample:approved";
/** Set by the buyer's (portal or email) and staff physical sample approvals. */
const SAMPLE_APPROVED_TAGS = [SAMPLE_APPROVED_TAG, "hyve-sample-approved"];
/** The intents that move an order's production status. */
const STATUS_INTENTS = new Set([
  "approve_proof",
  "request_proof_changes",
  "approve_production",
  "decline_production",
  "resubmit_production_photo",
  "send_physical_sample",
  "admin_approve_physical_sample",
  "admin_request_sample_changes",
  "approve_sample",
  "change_status",
]);
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
    case "sample-preparation":
    case "in-production":
      return "info";

    case "sample-review":
    case "artwork-received":
      return "warning";

    default:
      return "neutral";
  }
}



/**
 * A due date as the day alone, in Singapore time. The time of day it carries
 * is only the time the proof was approved, which read as a deadline hour.
 */


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

/** The latest physical sample's status, read as the loader reads it. */
function latestSampleStatus(order) {
  try {
    const history = JSON.parse(order?.physicalSampleHistory?.value || "[]") || [];
    return [...history].sort((a, b) => (b.sampleVersion || 0) - (a.sampleVersion || 0))[0]?.status || "";
  } catch {
    return "";
  }
}

function physicalSampleStatusLabel(status) {
  if (status === "sent") return "AWAITING CUSTOMER APPROVAL";
  if (status === "changes_requested") return "CHANGES REQUESTED";
  return status ? status.replaceAll("_", " ").toUpperCase() : "NOT SENT";
}

function physicalSampleStatusTone(status) {
  if (status === "approved") return "success";
  if (status === "sent" || status === "changes_requested") return "warning";
  return "neutral";
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
function canTransition(currentStatus, nextStatus, history = [], options = {}) {
  if (
    (currentStatus === "production-complete" || currentStatus === "on-hold") &&
    nextStatus === READY_FOR_COLLECTION_STATUS
  ) {
    return true;
  }

  return allowedMoves(currentStatus, history, options).includes(nextStatus);
}

function getCustomerEmail(order) {
  return (
    order.customer?.defaultEmailAddress?.emailAddress ||
    order.customer?.email ||
    order.email ||
    ""
  );
}

/**
 * Calculates the next step in the strictly linear, one-direction production workflow.
 * Identifies whether a customer response is required and generates professional action messages.
 */
export function getNextStepInfo(order, history = []) {
  const currentStatus = order?.productionStatus || "order-placed";

  if (currentStatus === "on-hold") {
    const heldFrom = history?.find((entry) => entry?.toStatus === "on-hold")?.fromStatus || "";
    const isCustomerFreight = Boolean(order?.customerArrangedFreight);
    const isPhotoApproved =
      order?.productionApprovalStatus === "approved" ||
      (history?.some((h) => h?.note?.includes("Production photo approved")) &&
        !history?.some((h) => h?.note?.includes("Production photo declined")));

    // Special handling when held during or after production-complete
    if (heldFrom === "production-complete" || heldFrom === "ready-for-collection") {
      if (isPhotoApproved) {
        const targetStatus = isCustomerFreight ? READY_FOR_COLLECTION_STATUS : "shipped";
        const targetLabel = isCustomerFreight ? "Ready For Collection" : "Shipped";
        return {
          nextStatus: targetStatus,
          nextLabel: targetLabel,
          actionVerb: isCustomerFreight ? "Submit Collection Details & Mark Ready" : "Resume Order (Ready to Ship)",
          isWaitingCustomer: false,
          waitingReason: null,
          currentAction: `Production is paused On Hold. Reason: "${order?.onHoldReason || "No reason specified"}". Pre-shipment photo was approved — ready to continue shipping once hold is released.`,
          stageTitle: "Order On Hold (Ready to Ship)",
          description: isCustomerFreight
            ? "This order was placed on hold after the production photo was approved. Enter collection details below to resume and notify the customer that their freight is ready for pickup."
            : "This order was placed on hold after the production photo was approved. Resume this order back to Production Complete or fulfill the order in Shopify Admin to provide customer tracking information.",
          canProceed: true,
          heldFrom,
          isPhotoApproved: true,
        };
      } else {
        const targetStatus = isCustomerFreight ? READY_FOR_COLLECTION_STATUS : "shipped";
        const targetLabel = isCustomerFreight ? "Ready For Collection" : "Shipped";
        return {
          nextStatus: targetStatus,
          nextLabel: targetLabel,
          actionVerb: isCustomerFreight ? "Mark Ready For Collection" : "Mark Shipped",
          isWaitingCustomer: true,
          waitingReason: "The pre-shipment production photo was submitted to the customer for review. The order cannot be marked for collection or shipment until the customer approves the photo.",
          currentAction: `Production is paused On Hold. Reason: "${order?.onHoldReason || "No reason specified"}". Awaiting customer pre-shipment photo approval (Photo v${order?.productionPhotoVersion || 1}).`,
          stageTitle: "Order On Hold (Photo Review Pending)",
          description: "Waiting for the customer to confirm the production photo before freight packaging and dispatch.",
          canProceed: false,
          heldFrom,
          isPhotoApproved: false,
        };
      }
    }

    const resumeStep = heldFrom && heldFrom !== "on-hold" ? heldFrom : "proof-sent";
    return {
      nextStatus: resumeStep,
      nextLabel: getStatusLabel(resumeStep),
      actionVerb: `Resume to ${getStatusLabel(resumeStep)}`,
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: `Production is paused On Hold. Reason: "${order.onHoldReason || "No reason specified"}".`,
      stageTitle: "Order On Hold",
      description: `This order is currently On Hold. When ready to proceed, resume production back to ${getStatusLabel(resumeStep)}.`,
      canProceed: true,
      heldFrom,
      isPhotoApproved: false,
    };
  }

  // A blank order needs no artwork, so it goes straight to production
  // (HYV-120, Michael's F20).
  if (currentStatus === "order-placed" && order.noArtwork) {
    return {
      nextStatus: "in-production",
      nextLabel: "In Production",
      actionVerb: "Start Production",
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: "Order received. This order has no decoration, so there is no artwork or proof.",
      stageTitle: "1. Order Received",
      description: "No artwork is needed for this order. Start production when it is ready.",
      canProceed: true,
    };
  }

  if (currentStatus === "order-placed") {
    const artworkNeeded = Boolean(order.artworkRequired);
    return {
      nextStatus: "artwork-received",
      nextLabel: "Artwork Received",
      actionVerb: "Confirm Artwork Received",
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: artworkNeeded
        ? "Order received. Awaiting custom artwork upload from customer."
        : "Order received. Ready to review artwork and proceed to proof preparation.",
      stageTitle: "1. Order Received",
      description: "Confirm that artwork files have been received and verified to proceed with digital proof preparation.",
      canProceed: true,
    };
  }

  if (currentStatus === "artwork-received") {
    return {
      nextStatus: "proof-sent",
      nextLabel: "Proof Sent",
      actionVerb: "Send Artwork Proof to Customer",
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: `Artwork confirmed. Preparing digital proof (Version ${Number(order.proofVersion || 0) + 1}) for customer sign-off.`,
      stageTitle: "2. Artwork Received",
      description: `Upload the digital artwork proof or enter its URL. When submitted, Proof v${Number(order.proofVersion || 0) + 1} will be emailed to the customer for approval.`,
      canProceed: true,
    };
  }

  if (currentStatus === "proof-sent") {
    const recipient = getCustomerEmail(order) || "the customer";
    return {
      nextStatus: "proof-approved",
      nextLabel: "Proof Approved",
      actionVerb: "Approve Artwork Proof",
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: `Artwork Proof v${order.proofVersion || 1} sent to ${recipient}. Ready for customer sign-off or admin decision.`,
      stageTitle: "3. Artwork Proof Sent",
      description: "Review the Artwork Proof. You can approve the proof to start production, or request changes to revise the artwork.",
      canProceed: true,
    };
  }

  const isSampleOrder = Boolean(order.physicalSampleRequired || order.hasPhysicalSample);

  if (currentStatus === "sample-review" || (isSampleOrder && (order.physicalSampleStatus === "sent" || currentStatus === "on-hold" && order.physicalSampleStatus === "sent"))) {
    const version = order.physicalSampleVersion || 1;
    return {
      nextStatus: "in-production",
      nextLabel: "In Production",
      actionVerb: "Start Production",
      isWaitingCustomer: true,
      waitingReason: `Physical sample v${version} has been sent to the customer. Bulk production cannot start until the customer inspects and approves the sample.`,
      currentAction: `Awaiting customer approval on Physical Sample v${version}.`,
      stageTitle: "Physical Sample Awaiting Approval",
      description: "The physical sample has been sent. Bulk production cannot begin until the customer approves it.",
      canProceed: false,
    };
  }

  if (currentStatus === "sample-preparation" || (isSampleOrder && currentStatus === "proof-approved" && order.physicalSampleStatus !== "approved" && !order.sampleApproved)) {
    return {
      nextStatus: "sample-review",
      nextLabel: "Awaiting Sample Approval",
      actionVerb: "Dispatch Physical Sample",
      isWaitingCustomer: false,
      waitingReason: "This order requires a physical pre-production sample to be manufactured, sent, and approved by the customer before mass manufacturing can begin.",
      currentAction: "Physical sample required prior to mass production.",
      stageTitle: "Physical Sample Preparation",
      description: "Prepare the physical sample, then send it with Dispatch Physical Sample below. Production has not started.",
      canProceed: false,
    };
  }

  if (currentStatus === "proof-approved") {

    return {
      nextStatus: "in-production",
      nextLabel: "In Production",
      actionVerb: "Start Production",
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: "Artwork proof approved. All pre-production requirements satisfied. Ready to begin manufacturing.",
      stageTitle: "4. Proof Approved",
      description: "Advance the order to In Production to release manufacturing to the factory floor.",
      canProceed: true,
    };
  }

  if (currentStatus === "in-production") {
    return {
      nextStatus: "production-complete",
      nextLabel: "Production Complete",
      actionVerb: "Complete Production & Upload Photo",
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: `Goods are actively in production at the factory${order.productionDueAt ? ` (Due: ${formatDay(order.productionDueAt)})` : ""}.`,
      stageTitle: "5. In Production",
      description: "When factory manufacturing finishes, upload a pre-shipment production photo. The photo will be submitted to the customer for final review.",
      canProceed: true,
    };
  }

  if (currentStatus === "production-complete") {
    const isApproved = order.productionApprovalStatus === "approved";
    const isCustomerFreight = Boolean(order.customerArrangedFreight);
    const targetStatus = isCustomerFreight ? READY_FOR_COLLECTION_STATUS : "shipped";
    const targetLabel = isCustomerFreight ? "Ready For Collection" : "Shipped";

    if (!isApproved) {
      return {
        nextStatus: targetStatus,
        nextLabel: targetLabel,
        actionVerb: isCustomerFreight ? "Mark Ready For Collection" : "Mark Shipped",
        isWaitingCustomer: true,
        waitingReason: "The pre-shipment production photo was submitted to the customer for review. The order cannot be marked for collection or shipment until the customer approves the photo.",
        currentAction: `Production complete. Awaiting customer pre-shipment photo approval (Photo v${order.productionPhotoVersion || 1}).`,
        stageTitle: "6. Production Complete (Photo Review Pending)",
        description: "Waiting for the customer to confirm the production photo before freight packaging and dispatch.",
        canProceed: false,
      };
    }

    return {
      nextStatus: targetStatus,
      nextLabel: targetLabel,
      actionVerb: isCustomerFreight ? "Submit Collection Details & Mark Ready" : "Proceed to Fulfillment in Shopify",
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: isCustomerFreight
        ? "Production photo approved! Package finished goods and enter carton/weight dimensions for customer freight pickup."
        : "Production photo approved! Order is ready for fulfillment and courier dispatch.",
      stageTitle: "6. Production Complete (Photo Approved)",
      description: isCustomerFreight
        ? "Enter collection details (cartons, weight, CBM, ready date) to notify the customer that their freight is ready for collection."
        : "Fulfill the order in Shopify Admin to provide customer tracking information.",
      canProceed: true,
    };
  }

  if (currentStatus === "ready-for-collection") {
    return {
      nextStatus: "delivered",
      nextLabel: "Delivered",
      actionVerb: "Mark Order Delivered",
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: "Finished goods are packed and staged for freight collection by customer courier.",
      stageTitle: "7. Ready For Collection",
      description: "Mark the order as Delivered once customer freight collection has taken place and goods have been received.",
      canProceed: true,
    };
  }

  if (currentStatus === "shipped") {
    return {
      nextStatus: "delivered",
      nextLabel: "Delivered",
      actionVerb: "Mark Order Delivered",
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: "Order fulfilled and in transit with courier to destination.",
      stageTitle: "7. Shipped",
      description: "Mark the order as Delivered once courier tracking confirms delivery.",
      canProceed: true,
    };
  }

  if (currentStatus === "delivered") {
    return {
      nextStatus: null,
      nextLabel: "Order Complete",
      actionVerb: null,
      isWaitingCustomer: false,
      waitingReason: null,
      currentAction: "Production and fulfillment lifecycle is successfully completed.",
      stageTitle: "8. Delivered",
      description: "Order is completed and delivered. No further production steps required.",
      canProceed: false,
    };
  }

  return {
    nextStatus: null,
    nextLabel: null,
    actionVerb: null,
    isWaitingCustomer: false,
    waitingReason: null,
    currentAction: "Production status: " + currentStatus,
    stageTitle: currentStatus,
    description: "",
    canProceed: false,
  };
}

function getCustomerNotificationTag(
  status,
  proofVersion,
  productionPhotoVersion,
  sampleVersion,
) {
  if (status === "proof-sent") {
    return `hyve-notified:proof-sent-v${proofVersion}`;
  }

  if (status === "production-complete") {
    return `hyve-notified:production-complete-v${productionPhotoVersion || 1}`;
  }

  if (status === "sample-review") {
    return `hyve-notified:sample-review-v${sampleVersion || 1}`;
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
    const isResumingFromHold = payload.currentStatus === "on-hold";
    const productionPhotoUrl = payload.productionPhotoUrl?.trim();

    if (!isResumingFromHold && !productionPhotoUrl) {
      errors.productionPhotoUrl =
        "Production photo URL is required before setting Production Complete.";
    } else if (productionPhotoUrl && !validateHttpUrl(productionPhotoUrl)) {
      errors.productionPhotoUrl =
        "Enter a valid http or https production photo URL.";
    }
  }

  if (payload.nextStatus === "ready-for-collection") {
    if (!payload.readyDate?.trim()) errors.readyDate = "Ready date is required.";
    if (!payload.numberOfCartons?.trim()) errors.numberOfCartons = "Number of cartons is required.";
    if (!payload.grossWeight?.trim()) errors.grossWeight = "Gross weight is required.";
    if (!payload.cbm?.trim()) errors.cbm = "CBM is required.";
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

            physicalSampleRequired: metafield(
              namespace: "$app"
              key: "physical_sample_required"
            ) {
              value
            }

            physicalSampleHistory: metafield(
              namespace: "$app"
              key: "physical_sample_history"
            ) {
              value
            }

            collectionReadyDate: metafield(
              namespace: "$app"
              key: "collection_ready_date"
            ) {
              value
            }

            collectionCartons: metafield(
              namespace: "$app"
              key: "collection_cartons"
            ) {
              value
            }

            collectionGrossWeight: metafield(
              namespace: "$app"
              key: "collection_gross_weight"
            ) {
              value
            }

            collectionCbm: metafield(
              namespace: "$app"
              key: "collection_cbm"
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
            sortKey: "updated_at"
            reverse: true
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

              ipAddress: field(
                key: "ip_address"
              ) {
                value
              }

              userAgent: field(
                key: "user_agent"
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

      ipAddress: item.ipAddress?.value || "",

      userAgent: item.userAgent?.value || "",
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
    preserveProductionApproval,
    readyDate,
    numberOfCartons,
    grossWeight,
    cbm,
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
    );

    if (!preserveProductionApproval) {
      metafields.push({
        ownerId: orderId,
        namespace: "$app",
        key: "production_approval_status",
        type: "single_line_text_field",
        value: "pending",
      });
    }
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
  if (status === "ready-for-collection" || readyDate || numberOfCartons || grossWeight || cbm) {
    if (readyDate) {
      metafields.push({
        ownerId: orderId,
        namespace: "$app",
        key: "collection_ready_date",
        type: "single_line_text_field",
        value: readyDate.trim(),
      });
    }
    if (numberOfCartons) {
      metafields.push({
        ownerId: orderId,
        namespace: "$app",
        key: "collection_cartons",
        type: "single_line_text_field",
        value: numberOfCartons.trim(),
      });
    }
    if (grossWeight) {
      metafields.push({
        ownerId: orderId,
        namespace: "$app",
        key: "collection_gross_weight",
        type: "single_line_text_field",
        value: grossWeight.trim(),
      });
    }
    if (cbm) {
      metafields.push({
        ownerId: orderId,
        namespace: "$app",
        key: "collection_cbm",
        type: "single_line_text_field",
        value: cbm.trim(),
      });
    }
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
  { orderId, orderName, fromStatus, toStatus, changedAt, changedBy, note, ipAddress, userAgent },
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

  if (ipAddress?.trim()) {
    fields.push({
      key: "ip_address",
      value: ipAddress.trim(),
    });
  }

  if (userAgent?.trim()) {
    fields.push({
      key: "user_agent",
      value: userAgent.trim(),
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
  readyDate,
  numberOfCartons,
  grossWeight,
  cbm,
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
    case "sample-preparation": {
      let estimatedShipDate = order.estimatedShipDate?.value;
      if (!estimatedShipDate && productionDueAt) {
        const d = new Date(productionDueAt);
        d.setUTCDate(d.getUTCDate() + 5);
        estimatedShipDate = d.toISOString();
      }
      const isSample = order.physicalSampleRequired?.value === "true" || hasPhysicalSample(order) || status === "sample-preparation";
      return sendProofApprovedEmail({
        ...common,

        productionDueAt,
        estimatedShipDate,
        isSampleOrder: isSample,
      });
    }

    case "sample-review": {
      let sampleHistory = [];
      try {
        if (order.physicalSampleHistory?.value) {
          sampleHistory = JSON.parse(order.physicalSampleHistory.value) || [];
        }
      } catch (e) {
        // ignore
      }
      const latestSample = sampleHistory[0] || {};
      const currentVersion = Number(latestSample.sampleVersion || order.physicalSampleVersion || 1);
      const links = await sampleDecisionLinks(admin, orderId, currentVersion);
      return sendPhysicalSampleEmail({
        ...common,
        sampleVersion: currentVersion,
        fileUrl: latestSample.fileUrl || "",
        note: latestSample.response || "",
        approveUrl: links.approveUrl,
        changesUrl: links.changesUrl,
        reviewUrl: links.reviewUrl,
      });
    }

    case "production-complete":
      return sendProductionCompleteEmail({
        ...common,

        productionPhotoUrl,
        productionPhotoVersion,

        ...(await productionDecisionLinks(admin, orderId, productionPhotoVersion || 1)),
      });

    case READY_FOR_COLLECTION_STATUS: {
      const pickupConfig = await loadPickupConfig(admin);
      const collectionDetails = { readyDate, numberOfCartons, grossWeight, cbm };
      return sendReadyForCollectionEmail({
        ...common,
        collectionDetails,
        pickupConfig: pickupConfig.values || {},
        attachments: await collectionDocuments(admin, orderId, collectionDetails),
      });
    }

    default:
      return null;
  }
}

/**
 * The commercial invoice and the packing list, attached to the Ready For
 * Collection email for the buyer's forwarder (HYV-160). The invoice is the
 * order's own invoice, as the portal's Invoice button gives it. Either one
 * that can't be built is left off, and the email says only what's attached.
 */
async function collectionDocuments(admin, orderId, collectionDetails) {
  const attachments = [];
  try {
    const doc = await loadInvoiceDocument(admin, orderId, { system: true });
    if (!doc) return attachments;
    const reference = String(doc.reference || "").replace(/[^A-Za-z0-9._-]/g, "");
    try {
      const { buildInvoicePdf } = await import("../lib/invoice-pdf.server.jsx");
      // Without the product photos: they made the email heavy and slow to
      // build, and a forwarder doesn't need them.
      const textOnly = { ...doc, rows: (doc.rows || []).map((row) => ({ ...row, image: "" })) };
      attachments.push({ kind: "invoice", filename: `commercial-invoice-${reference}.pdf`, content: await buildInvoicePdf(textOnly) });
    } catch (error) {
      console.error("[ready-for-collection] commercial invoice not built:", error?.message || error);
    }
    try {
      const { buildPackingListPdf } = await import("../lib/packing-list-pdf.server.jsx");
      attachments.push({ kind: "packing-list", filename: `packing-list-${reference}.pdf`, content: await buildPackingListPdf(doc, collectionDetails) });
    } catch (error) {
      console.error("[ready-for-collection] packing list not built:", error?.message || error);
    }
  } catch (error) {
    console.error("[ready-for-collection] order documents not loaded:", error?.message || error);
  }
  return attachments;
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
  readyDate,
  numberOfCartons,
  grossWeight,
  cbm,
}) {
  if (!CUSTOMER_EMAIL_STATUSES.has(status)) {
    return {
      sent: false,
      alreadySent: false,
      notificationTag: null,
      messageId: null,
    };
  }

  let sampleVersion = null;
  if (status === "sample-review") {
    let sampleHistory = [];
    try {
      if (order.physicalSampleHistory?.value) {
        sampleHistory = JSON.parse(order.physicalSampleHistory.value) || [];
      }
    } catch (e) {
      // ignore
    }
    sampleVersion = Number(sampleHistory[0]?.sampleVersion || order.physicalSampleVersion || 1);
  }

  const notificationTag = getCustomerNotificationTag(
    status,
    proofVersion,
    productionPhotoVersion,
    sampleVersion,
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
    readyDate,
    numberOfCartons,
    grossWeight,
    cbm,
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

    const [order, history, pickupConfigData] = await Promise.all([
      getOrder(admin, orderId),
      getStatusHistory(admin, orderId),
      loadPickupConfig(admin),
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

    let physicalSampleHistory = [];
    try {
      if (order.physicalSampleHistory?.value) {
        physicalSampleHistory = JSON.parse(order.physicalSampleHistory.value) || [];
      }
    } catch (e) {
      console.error("Failed to parse physicalSampleHistory", e);
    }

    // Sort descending by sampleVersion
    physicalSampleHistory.sort((a, b) => (b.sampleVersion || 0) - (a.sampleVersion || 0));

    const latestSample = physicalSampleHistory[0] || {};

    let productionDueAt = order.productionDueAt?.value || "";
    if (!productionDueAt && order.createdAt) {
      try {
        const calendar = await productionCalendar(admin);
        productionDueAt = productionDueDate(
          calendar,
          order.createdAt,
          order.rush?.value === "true",
        );
        // Persist so the metafield is saved for this order
        await admin.graphql(
          `#graphql
          mutation SaveOrderProductionDue($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }`,
          {
            variables: {
              metafields: [
                {
                  ownerId: order.id,
                  namespace: "$app",
                  key: "production_due_at",
                  type: "date_time",
                  value: productionDueAt,
                },
              ],
            },
          },
        );
      } catch (e) {
        console.error("Failed to auto-generate productionDueAt in loader:", e);
      }
    }

    return {
      order: {
        ...order,

        productionStatus: order.productionStatus?.value || statusFromTag || "",

        statusChangedAt: order.statusChangedAt?.value || "",

        productionDueAt,

        artworkRequired: order.artworkRequired?.value === "true",
        // Set false only for a blank order; an order without the field keeps
        // the artwork steps.
        noArtwork: order.artworkRequired?.value === "false",

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

        creditReviewHold: (order.tags ?? []).includes(CREDIT_HOLD_TAG),

        productionPhotoUrl: order.productionPhotoUrl?.value || "",

        productionPhotoVersion: Number(
          order.productionPhotoVersion?.value || 0,
        ),

        productionApprovalStatus: order.productionApprovalStatus?.value || "",

        productionApprovalAt: order.productionApprovalAt?.value || "",

        productionApprovalNote: order.productionApprovalNote?.value || "",

        onHoldReason: order.onHoldReason?.value || "",

        // Freight Collection Details (FOB)
        collectionReadyDate: order.collectionReadyDate?.value || "",
        collectionCartons: order.collectionCartons?.value || "",
        collectionGrossWeight: order.collectionGrossWeight?.value || "",
        collectionCbm: order.collectionCbm?.value || "",

        // Physical Sample Approval Workflow
        physicalSampleRequired: order.physicalSampleRequired?.value === "true",
        physicalSampleVersion: Number(latestSample.sampleVersion || 0),
        physicalSampleStatus: latestSample.status || "",
        physicalSampleSentAt: latestSample.sentAt || "",
        physicalSampleSentBy: latestSample.sentBy || "",
        physicalSampleApprovedBy: latestSample.approvedBy || "",
        physicalSampleApprovedAt: latestSample.responseDate || "", // renamed for compatibility
        physicalSampleApprovalSource: latestSample.approvalSource || "",
        physicalSampleResponse: latestSample.response || "",
      },

      history,

      physicalSampleHistory,

      pickupConfig: pickupConfigData?.values || {},

      loaderError: null,
    };
  } catch (error) {
    console.error("Production order loader error:", error);

    return {
      order: null,

      pickupConfig: {},

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

    const ipAddress = (request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "").split(",")[0].trim();
    const userAgent = request.headers.get("user-agent") || "";

    // An order held for credit review moves only from Credit Review.
    if (STATUS_INTENTS.has(intent)) {
      const tagsResponse = await admin.graphql(
        `#graphql
          query ProductionOrderTags($id: ID!) {
            order(id: $id) { tags }
          }
        `,
        { variables: { id: orderId } },
      );
      const tagsData = await parseGraphQL(tagsResponse, "ProductionOrderTags");
      if ((tagsData.data?.order?.tags ?? []).includes(CREDIT_HOLD_TAG)) {
        return {
          success: false,
          fieldErrors: {},
          formError: "This order is waiting for a credit review. Approve or decline it in Credit Review.",
        };
      }
    }

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
        d.setUTCDate(d.getUTCDate() + 5);
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

    if (intent === "resend_ready_for_collection_email") {
      const order = await getOrder(admin, orderId);
      const currentStatus =
        order.productionStatus?.value ||
        (order.tags ?? []).find((tag) => tag.startsWith("hyve-status:"))?.replace("hyve-status:", "") ||
        "";

      if (currentStatus !== READY_FOR_COLLECTION_STATUS) {
        return {
          success: false,
          formError: "The Ready for Collection email can only be resent while the order is Ready For Collection.",
        };
      }

      const customerEmail = getCustomerEmail(order);
      if (!customerEmail) {
        return { success: false, formError: "Customer email is missing." };
      }

      const pickupConfig = await loadPickupConfig(admin);
      const collectionDetails = {
        readyDate: order.collectionReadyDate?.value || "",
        numberOfCartons: order.collectionCartons?.value || "",
        grossWeight: order.collectionGrossWeight?.value || "",
        cbm: order.collectionCbm?.value || "",
      };
      await sendReadyForCollectionEmail({
        customerEmail,
        customerName: order.customer?.displayName || order.shippingAddress?.name || "Customer",
        orderName: order.name,
        orderDate: order.createdAt,
        lineItems: order.lineItems?.nodes || [],
        collectionDetails,
        pickupConfig: pickupConfig.values || {},
        // The same commercial invoice and packing list as the first email,
        // with the figures as saved now (HYV-160).
        attachments: await collectionDocuments(admin, orderId, collectionDetails),
      });

      return {
        success: true,
        message: `Ready for Collection email resent to ${customerEmail}.`,
      };
    }

    if (intent === "set_production_due_date") {
      const value = String(formData.get("productionDueAt") || "").trim();
      if (value && !/^\d{4}-\d{2}-\d{2}/.test(value)) {
        return { success: false, formError: "Enter the production due date as a date." };
      }
      const isoValue = value
        ? (value.includes("T") ? new Date(value).toISOString() : new Date(`${value}T12:00:00+08:00`).toISOString())
        : null;
      const identifier = {
        ownerId: orderId,
        namespace: "$app",
        key: "production_due_at",
      };
      const response = await admin.graphql(
        isoValue
          ? `#graphql
            mutation ProductionDueSet($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) { userErrors { field message } }
            }`
          : `#graphql
            mutation ProductionDueClear($metafields: [MetafieldIdentifierInput!]!) {
              metafieldsDelete(metafields: $metafields) { userErrors { field message } }
            }`,
        {
          variables: {
            metafields: [
              isoValue ? { ...identifier, type: "date_time", value: isoValue } : identifier,
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
        message: isoValue
          ? `Production due date updated to ${formatDate(isoValue)}.`
          : "Production due date cleared.",
        productionDueAt: isoValue,
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

    if (intent === "update_collection_details") {
      const readyDate = String(formData.get("readyDate") || "").trim();
      const numberOfCartons = String(formData.get("numberOfCartons") || "").trim();
      const grossWeight = String(formData.get("grossWeight") || "").trim();
      const cbm = String(formData.get("cbm") || "").trim();

      if (!readyDate) {
        return {
          success: false,
          fieldErrors: { readyDate: "Ready date is required." },
          formError: "Please provide the collection ready date.",
        };
      }

      await setOrderMetafields(admin, {
        orderId,
        readyDate,
        numberOfCartons,
        grossWeight,
        cbm,
      });

      return {
        success: true,
        message: "Freight collection package details updated successfully.",
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

    if (intent === "approve_proof") {
      const order = await getOrder(admin, orderId);
      const currentStatus = order.productionStatus?.value || "";

      if (currentStatus !== "proof-sent") {
        return {
          success: false,
          fieldErrors: {},
          formError:
            "Artwork Proof can only be approved while the order is Proof Sent.",
        };
      }

      if (!order.proofUrl?.value) {
        return {
          success: false,
          fieldErrors: {},
          formError: "A proof URL is required before approving the artwork proof.",
        };
      }

      const changedAt = new Date().toISOString();
      // A sample order goes to Sample Preparation, as when the buyer approves
      // (proof.server.js); its production date is set when the sample is
      // approved.
      const isSampleOrder = orderRequiresPhysicalSample(order);
      const approvedStatus = isSampleOrder ? "sample-preparation" : "proof-approved";
      const productionDueAt = isSampleOrder
        ? null
        : productionDueDate(
          await productionCalendar(admin),
          changedAt,
          order.rush?.value === "true",
        );

      const changedBy =
        (await staffMemberLabel(request, sessionToken)) || "Shopify Admin";

      await setOrderMetafields(admin, {
        orderId,
        status: approvedStatus,
        changedAt,
        productionDueAt,
      });

      const productionTags = (order.tags ?? []).filter((tag) =>
        tag.startsWith("hyve-status:"),
      );
      await removeTags(admin, orderId, productionTags);
      await addTags(admin, orderId, [`hyve-status:${approvedStatus}`]);

      const proofVersion = order.proofVersion?.value || "1";
      const proofNote = String(formData.get("proofNote") || "").trim();
      const auditNote = [
        `Artwork Proof v${proofVersion} approved by ${changedBy}`,
        proofNote ? `Note: "${proofNote}"` : "",
        order.proofUrl?.value ? `IMAGE: ${order.proofUrl.value}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      await createHistory(admin, {
        orderId,
        orderName: order.name,
        fromStatus: "proof-sent",
        toStatus: approvedStatus,
        changedAt,
        changedBy,
        note: auditNote,
        ipAddress,
        userAgent,
      });

      let emailSent = false;
      let emailWarning = null;

      try {
        const result = await sendCurrentCustomerStatusEmail({
          admin,
          order,
          orderId,
          status: approvedStatus,
          productionDueAt,
        });
        emailSent = result.sent;
      } catch (emailError) {
        console.error("Proof approved customer email failed:", emailError);
        emailWarning =
          emailError instanceof Error
            ? `The proof was approved, but the customer email could not be sent: ${emailError.message}`
            : "The proof was approved, but the customer email could not be sent.";
      }

      return {
        success: true,
        message: `Artwork Proof v${proofVersion} approved. ${isSampleOrder ? "Moved to Sample Preparation." : `Production due ${formatDate(productionDueAt)}.`}${emailSent ? " Customer email sent." : ""}`,
        emailWarning,
        emailRetryStatus: emailWarning ? approvedStatus : null,
      };
    }

    if (intent === "request_proof_changes") {
      const order = await getOrder(admin, orderId);
      const currentStatus = order.productionStatus?.value || "";
      const proofNote = String(formData.get("proofNote") || "").trim();

      if (currentStatus !== "proof-sent") {
        return {
          success: false,
          fieldErrors: {},
          formError:
            "Artwork Proof changes can only be requested while the order is Proof Sent.",
        };
      }

      if (!proofNote) {
        return {
          success: false,
          fieldErrors: {
            proofNote: "Enter the requested artwork changes.",
          },
          formError: "Please enter details for the requested artwork changes.",
        };
      }

      const changedAt = new Date().toISOString();
      const changedBy =
        (await staffMemberLabel(request, sessionToken)) || "Shopify Admin";
      const proofVersion = order.proofVersion?.value || "1";
      const onHoldReason = `Changes requested to Artwork Proof v${proofVersion}: ${proofNote}`;

      await setOrderMetafields(admin, {
        orderId,
        status: "on-hold",
        changedAt,
        onHoldReason,
      });

      const productionTags = (order.tags ?? []).filter((tag) =>
        tag.startsWith("hyve-status:"),
      );
      await removeTags(admin, orderId, productionTags);
      await addTags(admin, orderId, ["hyve-status:on-hold"]);

      const auditNote = [
        `Changes requested to Artwork Proof v${proofVersion} by ${changedBy}:`,
        `"${proofNote}"`,
        order.proofUrl?.value ? `IMAGE: ${order.proofUrl.value}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      await createHistory(admin, {
        orderId,
        orderName: order.name,
        fromStatus: "proof-sent",
        toStatus: "on-hold",
        changedAt,
        changedBy,
        note: auditNote,
        ipAddress,
        userAgent,
      });

      try {
        await notifyCustomerServiceOrderOnHold(admin, {
          order,
          onHoldReason,
          changedBy,
          note: auditNote,
        });
      } catch (csError) {
        console.error(
          `[proof-changes] on-hold Customer Service notification failed for ${order.name}:`,
          csError,
        );
      }

      return {
        success: true,
        message: `Changes requested for Artwork Proof v${proofVersion}. The order has been placed On Hold for revisions.`,
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
        note: `Production photo approved${order.productionPhotoUrl?.value ? `\nIMAGE: ${order.productionPhotoUrl.value}` : ""}`,
        ipAddress,
        userAgent,
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

      await setOrderMetafields(admin, {
        orderId,
        status: "on-hold",
        changedAt: declinedAt,
        onHoldReason: `Changes requested to Production Photo: ${approvalNote}`,
      });

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
        fromStatus: currentStatus,
        toStatus: "on-hold",
        changedAt: declinedAt,
        changedBy,
        note: `Production photo declined: ${approvalNote}`,
        ipAddress,
        userAgent,
      });

      return {
        success: true,
        message:
          "Production changes requested. The order has been placed On Hold.",
      };
    }

    if (intent === "resubmit_production_photo") {
      const order = await getOrder(admin, orderId);
      const currentStatus = order.productionStatus?.value || "";
      const revisedPhotoUrl = String(
        formData.get("productionPhotoUrl") || "",
      ).trim();

      if (currentStatus !== "production-complete" && currentStatus !== "on-hold") {
        return {
          success: false,
          fieldErrors: {},
          formError:
            "A revised production photo can only be submitted while the order is Production Complete or On Hold.",
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
        ipAddress,
        userAgent,
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
        emailRetryStatus: emailWarning ? "production-complete" : null,
      };
    }

    if (intent === "retry_customer_status_email") {
      const order = await getOrder(admin, orderId);
      const status = String(formData.get("status") || "");
      const currentStatus =
        order.productionStatus?.value ||
        (order.tags ?? []).find((tag) => tag.startsWith("hyve-status:"))?.replace("hyve-status:", "") ||
        "";

      if (!CUSTOMER_EMAIL_STATUSES.has(status) || currentStatus !== status) {
        return {
          success: false,
          fieldErrors: {},
          formError: "The order status has changed. Refresh the page before retrying its email.",
        };
      }

      try {
        const result = await sendCurrentCustomerStatusEmail({
          admin,
          order,
          orderId,
          status,
          proofUrl: order.proofUrl?.value || "",
          proofVersion: Number(order.proofVersion?.value || 0),
          productionDueAt: order.productionDueAt?.value || null,
          productionPhotoUrl: order.productionPhotoUrl?.value || "",
          productionPhotoVersion: Number(order.productionPhotoVersion?.value || 0),
          readyDate: order.collectionReadyDate?.value || "",
          numberOfCartons: order.collectionCartons?.value || "",
          grossWeight: order.collectionGrossWeight?.value || "",
          cbm: order.collectionCbm?.value || "",
        });

        if (result.sent) {
          return {
            success: true,
            message: `Customer email for ${getStatusLabel(status)} sent successfully.`,
          };
        }

        if (result.alreadySent) {
          return {
            success: true,
            message: `The customer email for ${getStatusLabel(status)} was already sent.`,
          };
        }

        if (result.optedOut) {
          return {
            success: true,
            message: "The customer has turned off status emails, so no email was sent.",
          };
        }

        return {
          success: false,
          fieldErrors: {},
          formError: "This status does not have a customer email to resend.",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to send the customer email.";
        return {
          success: true,
          message: "The production status remains saved.",
          emailWarning: `The customer email could not be sent: ${message}`,
          emailRetryStatus: status,
        };
      }
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

    if (intent === "send_physical_sample") {
      const order = await getOrder(admin, orderId);

      let currentHistory = [];
      try {
        if (order.physicalSampleHistory?.value) {
          currentHistory = JSON.parse(order.physicalSampleHistory.value) || [];
        }
      } catch (e) {
        // ignore
      }

      // We determine version based on the largest version in history
      const currentVersion = currentHistory.reduce((max, entry) => Math.max(max, entry.sampleVersion || 0), 0);
      const nextVersion = currentVersion + 1;
      const sentAt = new Date().toISOString();
      const sentBy = (await staffMemberLabel(request, sessionToken)) || "Shopify Admin";

      const fileUrl = String(formData.get("fileUrl") || "").trim();
      const note = String(formData.get("note") || "").trim();

      const newHistoryEntry = {
        sampleVersion: nextVersion,
        status: "sent",
        sentAt,
        sentBy,
        fileUrl,
        response: note,
      };

      currentHistory.unshift(newHistoryEntry);

      // 1. Update order metafield and set on-hold status
      const metafields = [
        {
          ownerId: orderId,
          namespace: "$app",
          key: "physical_sample_history",
          type: "json",
          value: JSON.stringify(currentHistory),
        },
      ];

      const response = await admin.graphql(
        `#graphql
            mutation SendPhysicalSample($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors { field message code }
              }
            }
          `,
        { variables: { metafields } },
      );
      const data = await parseGraphQL(response, "SendPhysicalSample");
      throwUserErrors(data.data?.metafieldsSet?.userErrors, "SendPhysicalSample");

      // 2. Put order in sample-review (NOT on-hold)
      const productionTags = (order.tags ?? []).filter((tag) =>
        tag.startsWith("hyve-status:") || tag === "hyve-status:on-hold" || tag === "hyve-status:sample-review",
      );
      const currentStatus =
        order.productionStatus?.value ||
        productionTags[0]?.replace("hyve-status:", "") ||
        "sample-preparation";

      await setOrderMetafields(admin, {
        orderId,
        status: "sample-review",
        changedAt: sentAt,
      });

      // Clear any prior on_hold_reason
      await deleteOnHoldReason(admin, orderId);

      await removeTags(admin, orderId, productionTags);
      await addTags(admin, orderId, [`hyve-status:sample-review`]);

      await createHistory(admin, {
        orderId,
        orderName: order.name,
        fromStatus: currentStatus,
        toStatus: "sample-review",
        changedAt: sentAt,
        changedBy: sentBy,
        ipAddress,
        userAgent,
        note: `Physical Sample Version ${nextVersion} dispatched.\nNote: ${note}${fileUrl ? `\nFile: ${fileUrl}` : ''}`,
      });

      // 3. Send email to customer with secure, sign-in-free approval link
      let emailWarning = null;
      let emailSent = false;
      const customerEmail = getCustomerEmail(order);
      if (!customerEmail) {
        emailWarning = "Physical sample marked as dispatched, but customer email address is missing so notification email was not sent.";
      } else {
        try {
          const links = await sampleDecisionLinks(admin, orderId, nextVersion);
          await sendPhysicalSampleEmail({
            customerEmail,
            customerName: order.customer?.displayName || order.shippingAddress?.name || "Customer",
            orderName: order.name,
            orderDate: order.createdAt,
            sampleVersion: nextVersion,
            fileUrl,
            note,
            orderId,
            approveUrl: links.approveUrl,
            changesUrl: links.changesUrl,
            reviewUrl: links.reviewUrl,
          });
          emailSent = true;
          await addTags(admin, orderId, [
            "hyve-notified:sample-review",
            `hyve-notified:sample-review-v${nextVersion}`,
          ]);
        } catch (error) {
          console.error("Failed to send physical sample email:", error);
          emailWarning =
            error instanceof Error
              ? `Physical sample dispatched, but email could not be sent: ${error.message}`
              : "Physical sample dispatched, but email could not be sent.";
        }
      }

      return {
        success: true,
        message: emailSent
          ? `Physical Sample Version ${nextVersion} dispatched and "Physical Sample Ready For Review" email sent to ${customerEmail}.`
          : `Physical Sample Version ${nextVersion} dispatched.`,
        emailWarning,
        emailRetryStatus: emailWarning && customerEmail ? "sample-review" : null,
      };
    }

    if (intent === "admin_approve_physical_sample") {
      const order = await getOrder(admin, orderId);

      let currentHistory = [];
      try {
        if (order.physicalSampleHistory?.value) {
          currentHistory = JSON.parse(order.physicalSampleHistory.value) || [];
        }
      } catch (e) {
        // ignore
      }

      const currentVersion = currentHistory.reduce((max, entry) => Math.max(max, entry.sampleVersion || 0), 0);
      const approvedAt = new Date().toISOString();
      const approvedBy = (await staffMemberLabel(request, sessionToken)) || "Shopify Admin";

      let fileUrl = "";
      if (currentHistory && currentHistory.length > 0) fileUrl = currentHistory[0].fileUrl || "";

      const newHistoryEntry = {
        sampleVersion: currentVersion,
        status: "approved",
        response: "Approved by admin on behalf of the customer",
        responseDate: approvedAt,
        approvedBy,
        approvalSource: "admin",
      };

      currentHistory.unshift(newHistoryEntry);

      // 1. Update order metafield
      const metafields = [
        {
          ownerId: orderId,
          namespace: "$app",
          key: "physical_sample_history",
          type: "json",
          value: JSON.stringify(currentHistory),
        },
      ];

      const response = await admin.graphql(
        `#graphql
            mutation ApprovePhysicalSample($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors { field message code }
              }
            }
          `,
        { variables: { metafields } },
      );
      const data = await parseGraphQL(response, "ApprovePhysicalSample");
      throwUserErrors(data.data?.metafieldsSet?.userErrors, "ApprovePhysicalSample");

      // 2. Put order in-production
      const productionTags = (order.tags ?? []).filter((tag) =>
        tag.startsWith("hyve-status:") || tag === "hyve-status:on-hold" || tag === "hyve-status:sample-review",
      );
      const currentStatus =
        order.productionStatus?.value ||
        productionTags[0]?.replace("hyve-status:", "") ||
        "sample-review";

      let inProductionDueAt = null;
      try {
        const calendar = await productionCalendar(admin);
        inProductionDueAt = productionDueDate(calendar, approvedAt, order.rush?.value === "true");
      } catch (err) {
        console.error("Failed to calculate production due date on sample approval:", err);
      }

      await setOrderMetafields(admin, {
        orderId,
        status: "in-production",
        changedAt: approvedAt,
        productionDueAt: inProductionDueAt,
      });

      // Clear the on hold reason metafield
      await deleteOnHoldReason(admin, orderId);

      await removeTags(admin, orderId, productionTags);
      await addTags(admin, orderId, [`hyve-status:in-production`, `hyve-sample-approved`]);

      await createHistory(admin, {
        orderId,
        orderName: order.name,
        fromStatus: currentStatus,
        toStatus: "in-production",
        changedAt: approvedAt,
        changedBy: approvedBy,
        ipAddress,
        userAgent,
        note: `Physical Sample Approved${fileUrl ? `\nIMAGE: ${fileUrl}` : ''}\n(Approved on behalf of customer)`,
      });

      return {
        success: true,
        message: `Physical Sample Version ${currentVersion} approved on behalf of customer.`,
      };
    }

    if (intent === "admin_request_sample_changes") {
      const order = await getOrder(admin, orderId);
      const currentStatus = order.productionStatus?.value || "";
      const changeNote = String(formData.get("physicalSampleDecisionNote") || "").trim();

      if (currentStatus !== "sample-review") {
        return {
          success: false,
          fieldErrors: {},
          formError: "Sample changes can only be requested while the customer review is pending.",
        };
      }

      if (!changeNote) {
        return {
          success: false,
          fieldErrors: {},
          formError: "Enter the changes required for the physical sample.",
        };
      }

      let currentHistory = [];
      try {
        currentHistory = JSON.parse(order.physicalSampleHistory?.value || "[]") || [];
      } catch {
        currentHistory = [];
      }

      const latestSample = currentHistory.reduce(
        (latest, entry) => (Number(entry.sampleVersion) > Number(latest?.sampleVersion) ? entry : latest),
        null,
      );
      if (!latestSample || latestSample.status !== "sent") {
        return {
          success: false,
          fieldErrors: {},
          formError: "There is no dispatched physical sample awaiting a decision.",
        };
      }

      const changedAt = new Date().toISOString();
      const changedBy = (await staffMemberLabel(request, sessionToken)) || "Shopify Admin";
      const updatedHistory = currentHistory.map((entry) =>
        entry === latestSample
          ? {
              ...entry,
              status: "changes_requested",
              response: changeNote,
              responseDate: changedAt,
              approvedBy: changedBy,
              approvalSource: "admin",
            }
          : entry,
      );

      const response = await admin.graphql(
        `#graphql
          mutation RequestPhysicalSampleChanges($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message code }
            }
          }
        `,
        {
          variables: {
            metafields: [{
              ownerId: orderId,
              namespace: "$app",
              key: "physical_sample_history",
              type: "json",
              value: JSON.stringify(updatedHistory),
            }],
          },
        },
      );
      const data = await parseGraphQL(response, "RequestPhysicalSampleChanges");
      throwUserErrors(data.data?.metafieldsSet?.userErrors, "RequestPhysicalSampleChanges");

      await setOrderMetafields(admin, {
        orderId,
        status: "sample-preparation",
        changedAt,
      });

      const productionTags = (order.tags ?? []).filter((tag) => tag.startsWith("hyve-status:"));
      await removeTags(admin, orderId, productionTags);
      await addTags(admin, orderId, ["hyve-status:sample-preparation"]);

      await createHistory(admin, {
        orderId,
        orderName: order.name,
        fromStatus: currentStatus,
        toStatus: "sample-preparation",
        changedAt,
        changedBy,
        ipAddress,
        userAgent,
        note: `Changes requested to Physical Sample v${latestSample.sampleVersion}: ${changeNote}`,
      });

      return {
        success: true,
        message: `Changes requested for Physical Sample v${latestSample.sampleVersion}. Prepare and dispatch a revised sample.`,
      };
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

    const readyDate = String(formData.get("readyDate") || "").trim();
    const numberOfCartons = String(formData.get("numberOfCartons") || "").trim();
    const grossWeight = String(formData.get("grossWeight") || "").trim();
    const cbm = String(formData.get("cbm") || "").trim();

    const order = await getOrder(admin, orderId);

    const productionTags = (order.tags ?? []).filter((tag) =>
      tag.startsWith("hyve-status:"),
    );

    const currentStatus =
      order.productionStatus?.value ||
      productionTags[0]?.replace("hyve-status:", "") ||
      "";

    const fieldErrors = validateStatusChange({
      currentStatus,
      nextStatus,
      onHoldReason,
      proofUrl,
      productionPhotoUrl,
      readyDate,
      numberOfCartons,
      grossWeight,
      cbm,
    });

    if (Object.keys(fieldErrors).length > 0) {
      return {
        success: false,

        fieldErrors,

        formError: "Please correct the highlighted fields.",
      };
    }

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
      (!customerArrangedFreight || (currentStatus !== "production-complete" && currentStatus !== "on-hold"))
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
      (currentStatus === "production-complete" || currentStatus === "on-hold") &&
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

    if (!canTransition(currentStatus, nextStatus, history, { noArtwork: order.artworkRequired?.value === "false" })) {
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


    const sampleRequired = order.physicalSampleRequired?.value === "true";
    const sampleApproved =
      latestSampleStatus(order) === "approved" ||
      (order.tags ?? []).some((tag) => SAMPLE_APPROVED_TAGS.includes(tag));

    if (
      nextStatus === "in-production" &&
      sampleRequired &&
      !sampleApproved
    ) {
      return {
        success: false,
        fieldErrors: {
          nextStatus: "The Physical Sample must be approved by the customer before starting production.",
        },
        formError: "Waiting for the Physical Sample to be approved.",
      };
    }

    // A paid physical sample ships and is approved before the full run
    // (ORS-03).
    if (
      nextStatus === "in-production" &&
      hasPhysicalSample(order) &&
      !sampleApproved
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
    const isResumingToProductionComplete =
      currentStatus === "on-hold" && nextStatus === "production-complete";

    const isAlreadyApproved =
      order.productionApprovalStatus?.value === "approved" ||
      ((order.tags ?? []).includes("hyve-photo:approved"));

    if (nextStatus === "production-complete") {
      if (isResumingToProductionComplete && !productionPhotoUrl) {
        nextProductionPhotoVersion =
          Number(order.productionPhotoVersion?.value || 1);
      } else {
        nextProductionPhotoVersion =
          Number(order.productionPhotoVersion?.value || 0) + 1;
      }
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
    await setOrderMetafields(admin, {
      orderId,

      status: nextStatus,

      changedAt,

      productionDueAt,

      onHoldReason,

      proofUrl: nextStatus === "proof-sent" ? proofUrl : null,

      proofVersion: nextStatus === "proof-sent" ? nextProofVersion : null,

      productionPhotoUrl:
        nextStatus === "production-complete"
          ? (productionPhotoUrl || order.productionPhotoUrl?.value || null)
          : null,

      productionPhotoVersion:
        nextStatus === "production-complete"
          ? nextProductionPhotoVersion
          : null,

      preserveProductionApproval: isResumingToProductionComplete && isAlreadyApproved,

      readyDate,
      numberOfCartons,
      grossWeight,
      cbm,
    });

    if (nextStatus === "production-complete" && !isResumingToProductionComplete) {
      await clearProductionApprovalDecision(admin, orderId);
    }

    await removeTags(admin, orderId, productionTags);

    const tagsToAdd = [`hyve-status:${nextStatus}`];
    if (nextStatus === "in-production" && (sampleRequired || hasPhysicalSample(order)) && latestSampleStatus(order) === "approved") {
      tagsToAdd.push("hyve-sample-approved");
    }
    await addTags(admin, orderId, tagsToAdd);

    if (nextStatus !== "on-hold") {
      await deleteOnHoldReason(admin, orderId);
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
      if (isResumingToProductionComplete) {
        const resumeAudit = isAlreadyApproved
          ? "Order resumed from On Hold back to Production Complete (Photo Approved)."
          : "Order resumed from On Hold back to Production Complete.";
        historyNote = historyNote ? `${historyNote}\n${resumeAudit}` : resumeAudit;
      } else {
        const photoAudit = `Production photo: ${productionPhotoUrl}`;
        historyNote = historyNote ? `${historyNote}\n${photoAudit}` : photoAudit;
      }
    }

    if (nextStatus === "proof-approved") {
      const proofVersion = order.proofVersion?.value || "1";
      const approvalAudit = `Artwork Proof v${proofVersion} approved by ${changedBy}${order.proofUrl?.value ? `\nIMAGE: ${order.proofUrl.value}` : ""}`;
      historyNote = historyNote ? `${historyNote}\n${approvalAudit}` : approvalAudit;
    }

    if (nextStatus === READY_FOR_COLLECTION_STATUS) {
      const collectionAudit =
        "Customer-arranged freight order marked Ready For Collection. Customer collection email triggered.";
      historyNote = historyNote
        ? `${historyNote}
${collectionAudit}`
        : collectionAudit;
    }

    if (nextStatus === "on-hold") {
      const holdAudit = onHoldReason ? `Hold Reason: ${onHoldReason}` : "";
      historyNote = historyNote
        ? (holdAudit ? `${historyNote}\n${holdAudit}` : historyNote)
        : holdAudit;
    }

    await createHistory(admin, {
      orderId,

      orderName: order.name,

      fromStatus: currentStatus,

      toStatus: nextStatus,

      changedAt,

      changedBy,

      note: historyNote,

      ipAddress,

      userAgent,
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
        if (order.lineItems?.nodes) {
          order.lineItems.nodes = updateLineItemArtworkAttributesInPayload(
            order.lineItems.nodes,
          );
        }
      } catch (artError) {
        console.error("On Artwork Received line item update failed:", artError);
      }
    }

    if (CUSTOMER_EMAIL_STATUSES.has(nextStatus)) {
      if (nextStatus === "production-complete" && isResumingToProductionComplete && isAlreadyApproved) {
        // Do not re-send photo approval email to customer when resuming an already-approved order from hold
      } else {
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

            readyDate,
            numberOfCartons,
            grossWeight,
            cbm,
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

      emailRetryStatus: emailWarning ? nextStatus : null,

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

function isImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  const clean = url.split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(clean)) return true;
  if (/cdn\.shopify\.com\/(s\/files|shopifycloud)/i.test(url)) {
    if (/\.pdf$/i.test(clean)) return false;
    return true;
  }
  return false;
}

function renderNoteText(text) {
  if (!text) return null;
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) => {
    if (part.match(urlRegex)) {
      if (isImageUrl(part)) {
        return (
          <span key={i} style={{ display: "block", marginTop: "6px", marginBottom: "4px" }}>
            <a
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "inline-block", textDecoration: "none" }}
              title="Open full image in new tab"
            >
              {part ? (
                <s-thumbnail src={part} alt="Production timeline photo" size="base"></s-thumbnail>
              ) : (
                <s-thumbnail alt="No image available" size="base"></s-thumbnail>
              )}
            </a>
          </span>
        );
      }
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "4px", textDecoration: "underline", wordBreak: "break-all" }}>
          {part}
          <svg viewBox="0 0 20 20" style={{ width: "14px", height: "14px", fill: "currentColor", flexShrink: 0 }}>
            <path d="M11 3a1 1 0 1 0 0 2h2.586l-6.293 6.293a1 1 0 1 0 1.414 1.414L15 6.414V9a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-5z" />
            <path d="M5 5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3a1 1 0 1 0-2 0v3H5V7h3a1 1 0 0 0 0-2H5z" />
          </svg>
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function parseTimelineNote(note, isHold) {
  if (!note) return { holdReason: null, cleanNote: null, imageUrl: null };

  let imageUrl = null;
  let text = note;

  if (text.includes("IMAGE:")) {
    const parts = text.split("IMAGE:");
    text = parts[0].trim();
    imageUrl = parts[1]?.trim() || null;
  }

  let extractedReason = null;
  if (isHold) {
    const reasonMatch = text.match(/(?:Hold Reason|Hold on reason|Reason):\s*([^\n]+)/i);
    if (reasonMatch) {
      extractedReason = reasonMatch[1].trim();
      text = text.replace(/(?:Hold Reason|Hold on reason|Reason):\s*[^\n]+/i, "").trim();
    } else if (!text.includes("\n") && !imageUrl) {
      extractedReason = text.trim();
      text = "";
    }
  }

  return {
    holdReason: extractedReason,
    cleanNote: text || null,
    imageUrl,
  };
}

function TimelineItem({ item, isLatest, currentOnHoldReason }) {
  const isHold = item.toStatus === "on-hold";
  const { holdReason, cleanNote, imageUrl } = parseTimelineNote(item.note, isHold);
  const displayHoldReason = isHold
    ? (holdReason || (isLatest ? currentOnHoldReason : null) || currentOnHoldReason || null)
    : null;

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
              </s-stack>

              <s-text tone="subdued">{formatDate(item.changedAt)}</s-text>
            </s-stack>

            <s-stack direction="block" gap="none">
              <s-text tone="subdued">
                <span style={{ fontSize: "13px" }}>
                  Changed by <strong>{item.changedBy}</strong>
                  {item.source ? ` via ${item.source.replace(/_/g, " ")}` : ""}
                  {item.ipAddress ? ` (IP: ${item.ipAddress})` : ""}
                </span>
              </s-text>

              {item.userAgent && (
                <s-text tone="subdued">
                  <span style={{ fontSize: "11px", opacity: 0.7, display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }} title={item.userAgent}>
                    {item.userAgent}
                  </span>
                </s-text>
              )}
            </s-stack>

            {isHold && (
              <s-box
                padding="small"
                borderRadius="base"
                style={{
                  backgroundColor: "#fff5f5",
                  border: "1px solid #fed7d7",
                  borderLeft: "4px solid #e53e3e",
                }}
              >
                <s-stack direction="inline" gap="extra-small" alignItems="baseline">
                  <strong style={{ color: "#c53030", fontSize: "13px" }}>Hold Reason:</strong>
                  <span style={{ fontSize: "13px", color: "#742a2a", fontWeight: "500" }}>
                    {displayHoldReason || "No hold reason specified"}
                  </span>
                </s-stack>
              </s-box>
            )}

            {(cleanNote || imageUrl) && (
              <s-box padding="small" background="subdued" borderRadius="base">
                {imageUrl ? (
                  <s-stack direction="block" gap="small">
                    {cleanNote && (
                      <s-paragraph style={{ whiteSpace: "pre-wrap" }}>
                        {renderNoteText(cleanNote)}
                      </s-paragraph>
                    )}
                    <a href={imageUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: "4px", textDecoration: "none" }} title="Open full image in new tab">
                      {imageUrl ? (
                        <s-thumbnail
                          src={imageUrl}
                          alt="Approval Attachment"
                          size="base"
                        ></s-thumbnail>
                      ) : (
                        <s-thumbnail alt="No image available" size="base"></s-thumbnail>
                      )}
                    </a>
                  </s-stack>
                ) : (
                  <s-paragraph style={{ whiteSpace: "pre-wrap" }}>
                    {renderNoteText(cleanNote)}
                  </s-paragraph>
                )}
              </s-box>
            )}
          </s-stack>
        </s-box>
      </s-grid>
    </s-box>
  );
}

/* -------------------------------------------------------------------------- */
/*                        Workflow Stepper & Helpers                          */
/* -------------------------------------------------------------------------- */

function getWorkflowSteps(order) {
  const isCustomerFreight = Boolean(order?.customerArrangedFreight);
  const requiresPhysicalSample =
    Boolean(order?.physicalSampleRequired || order?.hasPhysicalSample) ||
    ["sample-preparation", "sample-review"].includes(order?.productionStatus);
  const steps = [
    { key: "order-placed", label: "Order Received", stepNumber: 1 },
    { key: "artwork-received", label: "Artwork Received", stepNumber: 2 },
    { key: "proof-sent", label: "Proof Sent", stepNumber: 3 },
    { key: "proof-approved", label: "Proof Approved", stepNumber: 4 },
    ...(requiresPhysicalSample
      ? [{ key: "sample-preparation", label: "Physical Sample" }]
      : []),
    { key: "in-production", label: "In Production", stepNumber: 5 },
    { key: "production-complete", label: "Production Complete", stepNumber: 6 },
    {
      key: isCustomerFreight ? "ready-for-collection" : "shipped",
      label: isCustomerFreight ? "Ready for Collection" : "Shipped",
    },
    { key: "delivered", label: "Delivered" },
  ];

  return steps.map((step, index) => ({ ...step, stepNumber: index + 1 }));
}

function getDueStatus(dueAt, status) {
  if (!dueAt) return null;
  if (status === "delivered" || status === "shipped") {
    return { tone: "neutral", label: "Completed", isOverdue: false, isDueSoon: false };
  }

  const dueDate = new Date(dueAt);
  if (Number.isNaN(dueDate.getTime())) return null;

  const diffDays = singaporeDayDiff(dueDate);

  if (diffDays < 0) {
    return {
      tone: "critical",
      label: `Overdue (${Math.abs(diffDays)}d)`,
      isOverdue: true,
      isDueSoon: false,
    };
  }
  if (diffDays === 0) {
    return {
      tone: "critical",
      label: "Due Today",
      isOverdue: false,
      isDueSoon: true,
    };
  }
  if (diffDays <= 2) {
    return {
      tone: "warning",
      label: `Due in ${diffDays}d`,
      isOverdue: false,
      isDueSoon: true,
    };
  }
  return {
    tone: "neutral",
    label: `In ${diffDays}d`,
    isOverdue: false,
    isDueSoon: false,
  };
}

function ProductionStepper({ order, history = [] }) {
  const steps = getWorkflowSteps(order);
  const currentStatus = order?.productionStatus || "order-placed";
  const isHeld = currentStatus === "on-hold";
  const heldFrom =
    history?.find((h) => h?.toStatus === "on-hold")?.fromStatus || "proof-sent";

  const statusForStep = isHeld ? heldFrom : currentStatus;
  const effectiveStatus = statusForStep === "sample-review"
    ? "sample-preparation"
    : statusForStep;
  const currentStepIndex = steps.findIndex((s) => s.key === effectiveStatus);
  const activeIndex = currentStepIndex >= 0 ? currentStepIndex : 0;

  return (
    <div
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #dfe3e8",
        borderRadius: "8px",
        padding: "16px 20px",
        overflowX: "auto",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          minWidth: "750px",
          position: "relative",
        }}
      >
        {steps.map((step, idx) => {
          const isCompleted = idx < activeIndex;
          const isCurrent = idx === activeIndex;
          const isHoldStep = isHeld && isCurrent;

          let circleBg = "#f4f6f8";
          let circleColor = "#637381";
          let circleBorder = "2px solid #dfe3e8";

          if (isHoldStep) {
            circleBg = "#ffebee";
            circleColor = "#d72c0d";
            circleBorder = "2px solid #d72c0d";
          } else if (isCurrent) {
            circleBg = "#005bd3";
            circleColor = "#ffffff";
            circleBorder = "2px solid #005bd3";
          } else if (isCompleted) {
            circleBg = "#e3f1df";
            circleColor = "#108043";
            circleBorder = "2px solid #108043";
          }

          return (
            <div
              key={step.key}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                position: "relative",
                zIndex: 2,
              }}
            >
              {idx > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: "14px",
                    left: "-50%",
                    right: "50%",
                    height: "3px",
                    backgroundColor:
                      idx <= activeIndex
                        ? isHeld && idx === activeIndex
                          ? "#f1aeb5"
                          : "#108043"
                        : "#e1e3e5",
                    zIndex: -1,
                  }}
                />
              )}

              <div
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  backgroundColor: circleBg,
                  color: circleColor,
                  border: circleBorder,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: "700",
                  fontSize: "12px",
                  marginBottom: "6px",
                  boxShadow: isCurrent
                    ? "0 0 0 3px rgba(0, 91, 211, 0.2)"
                    : "none",
                }}
              >
                {isHoldStep ? "⏸" : isCompleted ? "✓" : step.stepNumber}
              </div>

              <div
                style={{
                  fontSize: "12px",
                  fontWeight: isCurrent ? "700" : "500",
                  color: isHoldStep
                    ? "#d72c0d"
                    : isCurrent
                      ? "#202223"
                      : isCompleted
                        ? "#202223"
                        : "#8c9196",
                  lineHeight: "1.2",
                  maxWidth: "90px",
                }}
              >
                {step.label}
              </div>

              {isHoldStep ? (
                <div style={{ marginTop: "4px" }}>
                  <s-badge tone="critical">ON HOLD</s-badge>
                </div>
              ) : isCurrent ? (
                <div style={{ marginTop: "4px" }}>
                  <s-badge tone="info">ACTIVE</s-badge>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatInputDatePreview(val) {
  return formatDay(val, null);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const DAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function DatePickerInput({
  label = "Date",
  details,
  value: rawValue = "",
  error,
  onChange,
  onClear,
  inline = false,
}) {
  const value = rawValue ? singaporeDateKey(rawValue) : "";
  const containerRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);

  // Initialize view year & month from value or today
  const [viewYear, setViewYear] = useState(() => {
    if (value) {
      const parts = String(value).split("-");
      if (parts[0] && parts[0].length === 4) return Number(parts[0]);
    }
    return Number(singaporeDateKey().slice(0, 4));
  });

  const [viewMonth, setViewMonth] = useState(() => {
    if (value) {
      const parts = String(value).split("-");
      if (parts[1]) return Number(parts[1]) - 1;
    }
    return Number(singaporeDateKey().slice(5, 7)) - 1;
  });

  // Keep view aligned when value changes externally
  useEffect(() => {
    if (value) {
      const parts = String(value).split("-");
      if (parts.length === 3 && parts[0].length === 4) {
        const y = Number(parts[0]);
        const m = Number(parts[1]) - 1;
        if (!Number.isNaN(y) && !Number.isNaN(m)) {
          setViewYear(y);
          setViewMonth(m);
        }
      }
    }
  }, [value]);

  // Close calendar when clicking outside (safe for Shadow DOM & web components)
  useEffect(() => {
    if (!isOpen || inline) return;
    function handleClickOutside(event) {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (
        containerRef.current &&
        (containerRef.current.contains(event.target) || path.includes(containerRef.current))
      ) {
        return;
      }
      setIsOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, inline]);

  const formattedPreview = useMemo(() => {
    return formatInputDatePreview(value);
  }, [value]);

  const todayStr = singaporeDateKey();

  const handlePrevMonth = (e) => {
    e.stopPropagation();
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = (e) => {
    e.stopPropagation();
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleSelectDay = (day) => {
    const mm = String(viewMonth + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const chosen = `${viewYear}-${mm}-${dd}`;
    onChange?.(chosen);
    if (!inline) setIsOpen(false);
  };

  const handleSetToday = (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    onChange?.(todayStr);
    if (!inline) setIsOpen(false);
  };

  const handleSetTomorrow = (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    onChange?.(singaporeDateKey(addCalendarDays(new Date(), 1)));
    if (!inline) setIsOpen(false);
  };

  const handleSetDaysAhead = (days) => (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    onChange?.(singaporeDateKey(addCalendarDays(new Date(), days)));
    if (!inline) setIsOpen(false);
  };

  const handleClear = (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    onChange?.("");
    onClear?.();
    if (!inline) setIsOpen(false);
  };

  // Calendar matrix calculations
  const { leadingBlanks, daysInMonth } = useMemo(() => {
    const firstDay = new Date(Date.UTC(viewYear, viewMonth, 1));
    const leading = (firstDay.getUTCDay() + 6) % 7; // Monday = 0
    const count = new Date(Date.UTC(viewYear, viewMonth + 1, 0)).getUTCDate();
    return { leadingBlanks: leading, daysInMonth: count };
  }, [viewYear, viewMonth]);

  const currentYear = Number(singaporeDateKey().slice(0, 4));
  const yearOptions = useMemo(() => {
    const yrs = [];
    for (let y = currentYear - 2; y <= currentYear + 6; y++) {
      yrs.push(y);
    }
    return yrs;
  }, [currentYear]);

  const calendarContent = (
    <div
      style={{
        width: "100%",
        maxWidth: inline ? "100%" : "290px",
        margin: inline ? "0 auto" : undefined,
        backgroundColor: "#ffffff",
        border: "1px solid #dcdfe3",
        borderRadius: "12px",
        boxShadow: inline ? "none" : "0 8px 24px rgba(0, 0, 0, 0.16)",
        padding: "12px",
        boxSizing: "border-box",
        userSelect: "none",
      }}
    >
      {/* Calendar Header with Month/Year Navigation */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "10px",
        }}
      >
        <button
          type="button"
          onClick={handlePrevMonth}
          title="Previous month"
          style={{
            background: "#f6f6f7",
            border: "1px solid #dcdfe3",
            borderRadius: "6px",
            width: "28px",
            height: "28px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "#202223",
            fontWeight: 700,
            fontSize: "14px",
          }}
        >
          ‹
        </button>

        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <select
            value={viewMonth}
            onChange={(e) => setViewMonth(Number(e.target.value))}
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "#202223",
              border: "1px solid #dcdfe3",
              borderRadius: "6px",
              padding: "4px 8px",
              background: "#ffffff",
              cursor: "pointer",
            }}
          >
            {MONTH_NAMES.map((name, idx) => (
              <option key={name} value={idx}>
                {name}
              </option>
            ))}
          </select>

          <select
            value={viewYear}
            onChange={(e) => setViewYear(Number(e.target.value))}
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "#202223",
              border: "1px solid #dcdfe3",
              borderRadius: "6px",
              padding: "4px 8px",
              background: "#ffffff",
              cursor: "pointer",
            }}
          >
            {yearOptions.map((yr) => (
              <option key={yr} value={yr}>
                {yr}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={handleNextMonth}
          title="Next month"
          style={{
            background: "#f6f6f7",
            border: "1px solid #dcdfe3",
            borderRadius: "6px",
            width: "28px",
            height: "28px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "#202223",
            fontWeight: 700,
            fontSize: "14px",
          }}
        >
          ›
        </button>
      </div>

      {/* Weekday Labels */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: "2px",
          textAlign: "center",
          marginBottom: "6px",
        }}
      >
        {DAY_HEADERS.map((day) => (
          <span
            key={day}
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "#6d7175",
              padding: "4px 0",
            }}
          >
            {day}
          </span>
        ))}
      </div>

      {/* Calendar Days Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: "2px",
        }}
      >
        {Array.from({ length: leadingBlanks }).map((_, idx) => (
          <div key={`blank-${idx}`} style={{ height: "32px" }} />
        ))}

        {Array.from({ length: daysInMonth }).map((_, idx) => {
          const day = idx + 1;
          const mm = String(viewMonth + 1).padStart(2, "0");
          const dd = String(day).padStart(2, "0");
          const dateStr = `${viewYear}-${mm}-${dd}`;
          const isSelected = dateStr === value;
          const isToday = dateStr === todayStr;

          return (
            <button
              key={dateStr}
              type="button"
              onClick={() => handleSelectDay(day)}
              style={{
                height: "32px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "13px",
                fontWeight: isSelected ? 700 : isToday ? 600 : 400,
                color: isSelected ? "#ffffff" : isToday ? "#005bd3" : "#202223",
                backgroundColor: isSelected
                  ? "#005bd3"
                  : isToday
                    ? "#f0f5ff"
                    : "transparent",
                border: isToday && !isSelected ? "1px solid #005bd3" : "none",
                borderRadius: "6px",
                cursor: "pointer",
                transition: "background-color 0.15s, color 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.backgroundColor = "#f1f2f4";
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.backgroundColor = isToday ? "#f0f5ff" : "transparent";
                }
              }}
            >
              {day}
            </button>
          );
        })}
      </div>

      {/* Footer with Quick Action Buttons */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "10px",
          paddingTop: "8px",
          borderTop: "1px solid #f1f2f4",
          flexWrap: "wrap",
          gap: "6px",
        }}
      >
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleSetToday}
            style={{
              background: "#f1f2f4",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 500,
              color: "#202223",
              cursor: "pointer",
            }}
          >
            Today
          </button>
          <button
            type="button"
            onClick={handleSetTomorrow}
            style={{
              background: "#f1f2f4",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 500,
              color: "#202223",
              cursor: "pointer",
            }}
          >
            Tomorrow
          </button>
          <button
            type="button"
            onClick={handleSetDaysAhead(5)}
            style={{
              background: "#f1f2f4",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 500,
              color: "#202223",
              cursor: "pointer",
            }}
          >
            +5d
          </button>
          <button
            type="button"
            onClick={handleSetDaysAhead(10)}
            style={{
              background: "#f1f2f4",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 500,
              color: "#202223",
              cursor: "pointer",
            }}
          >
            +10d
          </button>
        </div>

        <div style={{ display: "flex", gap: "6px" }}>
          
          {!inline && (
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              style={{
                background: "none",
                border: "none",
                padding: "4px 6px",
                fontSize: "11px",
                fontWeight: 500,
                color: "#6d7175",
                cursor: "pointer",
              }}
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        width: "100%",
        gap: "6px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "#303030",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          }}
        >
          {label}
        </label>
      
      </div>

      {details && (
        <span style={{ fontSize: "12px", color: "#616161", marginBottom: "2px" }}>
          {details}
        </span>
      )}

    

      {/* If inline, display the calendar directly. Otherwise render trigger button with popover */}
      {inline ? (
        calendarContent
      ) : (
        <>
          <div
            role="button"
            tabIndex={0}
            onClick={() => setIsOpen((prev) => !prev)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
                e.preventDefault();
                setIsOpen((prev) => !prev);
              } else if (e.key === "Escape") {
                setIsOpen(false);
              } else if (e.key !== "Tab") {
                e.preventDefault(); // Disallow typing
              }
            }}
            title="Click to open calendar date picker"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              height: "36px",
              padding: "6px 12px",
              fontSize: "14px",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
              backgroundColor: "#ffffff",
              border: error
                ? "1px solid #d72c0d"
                : isOpen
                  ? "1px solid #005bd3"
                  : "1px solid #8c9196",
              borderRadius: "8px",
              boxSizing: "border-box",
              cursor: "pointer",
              userSelect: "none",
              boxShadow: error
                ? "0 0 0 1px #d72c0d"
                : isOpen
                  ? "0 0 0 1px #005bd3"
                  : "none",
              transition: "border-color 0.15s, box-shadow 0.15s",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", overflow: "hidden" }}>
              <span
                style={{
                  color: value ? "#202223" : "#8c9196",
                  fontWeight: value ? 500 : 400,
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                  overflow: "hidden",
                }}
              >
                {formattedPreview || "Select date from picker..."}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 20 20"
                fill={isOpen ? "#005bd3" : "#5c5f62"}
                style={{ display: "block", transition: "fill 0.15s" }}
              >
                <path
                  fillRule="evenodd"
                  d="M6 2a1 1 0 0 0-1 1v1H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-1V3a1 1 0 1 0-2 0v1H7V3a1 1 0 0 0-1-1zm9 4H5v2h10V6zm1 4H4v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-6z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>

          {error && (
            <div
              style={{
                fontSize: "12px",
                color: "#d72c0d",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                marginTop: "2px",
              }}
            >
              <span>{error}</span>
            </div>
          )}

          {isOpen && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                zIndex: 9999,
              }}
            >
              {calendarContent}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ProductionOrderDetailsPage() {
  const loaderData = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const submit = useSubmit();

  const order = loaderData?.order;
  const pickupConfig = loaderData?.pickupConfig || {};

  const [note, setNote] = useState("");

  const [proofUrl, setProofUrl] = useState(order?.proofUrl || "");
  const [proofNote, setProofNote] = useState("");

  const [productionPhotoUrl, setProductionPhotoUrl] = useState(
    order?.productionPhotoUrl || "",
  );

  const [clientErrors, setClientErrors] = useState({});

  const [productionApprovalNote, setProductionApprovalNote] = useState(
    order?.productionApprovalNote || "",
  );

  const [readyDate, setReadyDate] = useState(order?.collectionReadyDate || "");
  const [numberOfCartons, setNumberOfCartons] = useState(order?.collectionCartons || "");
  const [grossWeight, setGrossWeight] = useState(order?.collectionGrossWeight || "");
  const [cbm, setCbm] = useState(order?.collectionCbm || "");

  const [shipDate, setShipDate] = useState(order?.estimatedShipDate || "");
  const [physicalSampleFileUrl, setPhysicalSampleFileUrl] = useState("");
  const [physicalSampleNote, setPhysicalSampleNote] = useState("");
  const [physicalSampleDecisionNote, setPhysicalSampleDecisionNote] = useState("");
  const [holdReasonInput, setHoldReasonInput] = useState("");
  const [isEditingCollection, setIsEditingCollection] = useState(false);

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
    setReadyDate(order?.collectionReadyDate || "");
  }, [order?.collectionReadyDate]);

  useEffect(() => {
    setNumberOfCartons(order?.collectionCartons || "");
  }, [order?.collectionCartons]);

  useEffect(() => {
    setGrossWeight(order?.collectionGrossWeight || "");
  }, [order?.collectionGrossWeight]);

  useEffect(() => {
    setCbm(order?.collectionCbm || "");
  }, [order?.collectionCbm]);

  const nextStepInfo = useMemo(() => {
    return getNextStepInfo(order, loaderData?.history || []);
  }, [order, loaderData?.history]);

  useEffect(() => {
    if (actionData?.success && actionData?.message) {
      shopify.toast.show(actionData.message);

      setNote("");
      setHoldReasonInput("");
      setProductionApprovalNote("");
      setPhysicalSampleFileUrl("");
      setPhysicalSampleNote("");
      setPhysicalSampleDecisionNote("");
    }
    if (actionData?.formError) {
      shopify.toast.show(actionData.formError, { isError: true });
    }
    if (actionData?.emailWarning) {
      shopify.toast.show(actionData.emailWarning, { isError: true });
    }
  }, [actionData]);

  const busy = navigation.state !== "idle";
  const dispatchingPhysicalSample =
    busy && navigation.formData?.get("intent") === "send_physical_sample";
  const retryingCustomerEmail =
    busy && navigation.formData?.get("intent") === "retry_customer_status_email";
  const resendingReadyForCollectionEmail =
    busy && navigation.formData?.get("intent") === "resend_ready_for_collection_email";

  function clearFieldError(field) {
    setClientErrors((current) => ({
      ...current,

      [field]: undefined,
    }));
  }


  function openHoldModal() {
    clearFieldError("holdReason");
    try {
      shopify.modal.show("hold-order-modal");
    } catch {
      document.getElementById("hold-order-modal")?.show?.();
    }
  }

  function closeHoldModal() {
    try {
      shopify.modal.hide("hold-order-modal");
    } catch {
      document.getElementById("hold-order-modal")?.hide?.();
    }
  }

  function submitHoldOrder() {
    if (!holdReasonInput.trim()) {
      setClientErrors((current) => ({
        ...current,
        holdReason: "Hold on reason is required.",
      }));
      return;
    }

    clearFieldError("holdReason");

    const formData = new FormData();
    formData.set("intent", "change_status");
    formData.set("nextStatus", "on-hold");
    formData.set("onHoldReason", holdReasonInput.trim());
    formData.set("note", note);

    submit(formData, {
      method: "post",
    });

    closeHoldModal();
  }

  function submitUpdateCollectionDetails() {
    if (!readyDate.trim()) {
      setClientErrors((current) => ({
        ...current,
        readyDate: "Ready date is required.",
      }));
      return;
    }

    clearFieldError("readyDate");
    const formData = new FormData();
    formData.set("intent", "update_collection_details");
    formData.set("readyDate", readyDate.trim());
    formData.set("numberOfCartons", numberOfCartons.trim());
    formData.set("grossWeight", grossWeight.trim());
    formData.set("cbm", cbm.trim());

    submit(formData, {
      method: "post",
    });

    setIsEditingCollection(false);
  }

  function proceedNextStep() {
    if (!order || !nextStepInfo.nextStatus) {
      return;
    }

    if (nextStepInfo.isWaitingCustomer) {
      setClientErrors({
        nextStatus:
          nextStepInfo.waitingReason ||
          "Customer response is required before proceeding to the next step.",
      });
      return;
    }

    const targetStatus = nextStepInfo.nextStatus;

    const errors = validateStatusChange({
      currentStatus: order.productionStatus,
      nextStatus: targetStatus,
      onHoldReason: "",
      proofUrl,
      productionPhotoUrl,
      readyDate,
      numberOfCartons,
      grossWeight,
      cbm,
    });

    if (
      targetStatus &&
      !canTransition(
        order.productionStatus,
        targetStatus,
        loaderData.history || [],
        { noArtwork: order.noArtwork },
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

    formData.set("nextStatus", targetStatus);

    formData.set(
      "note",
      targetStatus === "proof-approved" ? (proofNote.trim() || note) : note,
    );

    formData.set("onHoldReason", "");

    formData.set("proofUrl", targetStatus === "proof-sent" ? proofUrl : "");

    formData.set(
      "productionPhotoUrl",
      targetStatus === "production-complete" ? productionPhotoUrl : "",
    );

    if (targetStatus === "ready-for-collection") {
      formData.set("readyDate", readyDate);
      formData.set("numberOfCartons", numberOfCartons);
      formData.set("grossWeight", grossWeight);
      formData.set("cbm", cbm);
    }

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

  function approveProof() {
    submitIntent("approve_proof", {
      proofNote: proofNote.trim(),
    });
  }

  function requestProofChanges() {
    if (!proofNote.trim()) {
      setClientErrors((current) => ({
        ...current,
        proofNote: "Enter the requested artwork changes.",
      }));
      return;
    }

    clearFieldError("proofNote");
    submitIntent("request_proof_changes", {
      proofNote: proofNote.trim(),
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

  function requestPhysicalSampleChanges() {
    if (!physicalSampleDecisionNote.trim()) {
      shopify.toast.show("Enter the changes required for the physical sample.", { isError: true });
      return;
    }

    submitIntent("admin_request_sample_changes", {
      physicalSampleDecisionNote: physicalSampleDecisionNote.trim(),
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

  const totalUnits = (order.lineItems?.nodes || []).reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0,
  );
  const totalItemsCount = order.lineItems?.nodes?.length || 0;
  const dueStatus = getDueStatus(order.productionDueAt, order.productionStatus);
  const pickupHours = [
    ["Monday", pickupConfig.monday_hours],
    ["Tuesday", pickupConfig.tuesday_hours],
    ["Wednesday", pickupConfig.wednesday_hours],
    ["Thursday", pickupConfig.thursday_hours],
    ["Friday", pickupConfig.friday_hours],
    ["Saturday", pickupConfig.saturday_hours],
    ["Sunday", pickupConfig.sunday_hours],
  ].filter(([, hours]) => hours);

  return (
    <s-page heading={order.name} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/production-orders">
        Production Orders
      </s-link>

      {/* Top Action Header */}
      <s-stack slot="primary-action" direction="inline" gap="small-200" alignItems="center">
        {order.productionStatus !== "on-hold" && order.productionStatus !== "delivered" && (
          <s-button
            tone="critical"
            variant="secondary"
            commandFor="hold-order-modal"
            command="--show"
            onClick={() => openHoldModal()}
          >
            Put on Hold
          </s-button>
        )}
        <s-button
          target="_blank"
          href={`shopify:admin/orders/${order.id.split("/").pop()}`}
        >
          View in Shopify Admin ↗
        </s-button>
      </s-stack>

      {/* Action / Error Banners */}
      {order.creditReviewHold && (
        <s-banner tone="warning" heading="Waiting for credit review">
          <s-paragraph>This order is waiting for a credit review. Approve or decline it in Credit Review.</s-paragraph>
        </s-banner>
      )}
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
          <s-stack direction="block" gap="small">
            <s-paragraph>{actionData.emailWarning}</s-paragraph>
            {actionData.emailRetryStatus && (
              <s-button
                variant="secondary"
                disabled={retryingCustomerEmail ? true : undefined}
                onClick={() => submitIntent("retry_customer_status_email", {
                  status: actionData.emailRetryStatus,
                })}
              >
                {retryingCustomerEmail ? "Sending..." : "Retry customer email"}
              </s-button>
            )}
          </s-stack>
        </s-banner>
      )}

      <s-stack direction="block" gap="base">
        {/* 1. Visual Production Pipeline Stepper */}
        <s-section>
          <ProductionStepper order={order} history={loaderData?.history} />
        </s-section>

        {/* 2. Executive KPI Overview Strip */}
        <s-section padding="base">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 768px) 1fr 1fr, 1fr 1fr 1fr 1fr 1fr"
            gap="small-300"
          >
            {/* Stage */}
            <s-box padding="small-300" border="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-text tone="subdued" style={{ fontSize: 13 }}>Production Stage</s-text>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={statusTone(order.productionStatus)}>
                    {getStatusLabel(order.productionStatus)}
                  </s-badge>
                  {order.rush && <s-badge tone="critical">RUSH</s-badge>}
                </s-stack>
              </s-stack>
            </s-box>

            {/* Total Value */}
            <s-box padding="small-300" border="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-text tone="subdued" style={{ fontSize: 13 }}>Order Total</s-text>
                <s-heading style={{ fontSize: 20, margin: 0 }}>
                  {formatMoney(money?.amount || "0", money?.currencyCode || "USD")}
                </s-heading>
              </s-stack>
            </s-box>

            {/* Production Run Volume */}
            <s-box padding="small-300" border="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-text tone="subdued" style={{ fontSize: 13 }}>Batch Run Volume</s-text>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-heading style={{ fontSize: 20, margin: 0 }}>
                    {totalUnits} units
                  </s-heading>
                  <s-text tone="subdued" style={{ fontSize: 13 }}>({totalItemsCount} items)</s-text>
                </s-stack>
              </s-stack>
            </s-box>

            {/* Production Due & SLA */}
            <s-box padding="small-300" border="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-text tone="subdued" style={{ fontSize: 13 }}>Production Due</s-text>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-heading style={{ fontSize: 16, margin: 0 }}>
                    {order.productionDueAt ? formatDay(order.productionDueAt) : "—"}
                  </s-heading>
                  {dueStatus && <s-badge tone={dueStatus.tone}>{dueStatus.label}</s-badge>}
                </s-stack>
              </s-stack>
            </s-box>

            {/* Logistics & Payment */}
            <s-box padding="small-300" border="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-text tone="subdued" style={{ fontSize: 13 }}>Freight & Payment</s-text>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  {order.customerArrangedFreight ? (
                    <s-badge tone="attention">FOB / Pickup</s-badge>
                  ) : (
                    <s-badge tone="neutral">Courier Delivery</s-badge>
                  )}
                  <s-text tone="subdued" style={{ fontSize: 12 }}>• {order.displayFinancialStatus || "Paid"}</s-text>
                </s-stack>
              </s-stack>
            </s-box>
          </s-grid>
        </s-section>

        {/* 3. Main 2-Column Working Layout */}
        <s-grid gridTemplateColumns="@container (inline-size <= 960px) 1fr, 2fr 1fr" gap="base" alignItems="start">
          {/* Left Column (Primary Operations) */}
          <s-stack direction="block" gap="base">
            {/* Interactive Production Workflow Console */}
            <s-section heading="Production Workflow Action">
              <s-stack direction="block" gap="base">
                {/* Milestone Summary & Status */}
                <s-box padding="base" border="base" borderRadius="base" style={{ backgroundColor: "#ffffff" }}>
                  <s-stack direction="block" gap="small-300">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-heading style={{ fontSize: 18, margin: 0 }}>{nextStepInfo.stageTitle}</s-heading>
                        <s-badge tone={statusTone(order.productionStatus)}>
                          {getStatusLabel(order.productionStatus)}
                        </s-badge>
                      </s-stack>

                      {order.productionStatus !== "on-hold" && order.productionStatus !== "delivered" && (
                        <s-button
                          tone="critical"
                          variant="secondary"
                          commandFor="hold-order-modal"
                          command="--show"
                          onClick={() => openHoldModal()}
                        >
                          Put on Hold
                        </s-button>
                      )}
                    </s-stack>

                    <div style={{ padding: "10px 14px", backgroundColor: "#f6f8fa", borderRadius: "6px", borderLeft: "4px solid #005bd3" }}>
                      <s-text style={{ fontSize: 14 }}>
                        <strong>Current Status:</strong> {nextStepInfo.currentAction}
                      </s-text>
                    </div>

                    {/* Hint for Next Step */}
                    {nextStepInfo.nextLabel && order.productionStatus !== "delivered" && (
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-text tone="subdued">Next milestone after this step:</s-text>
                        <s-badge tone="info">{nextStepInfo.nextLabel}</s-badge>
                      </s-stack>
                    )}
                  </s-stack>
                </s-box>

                {/* On Hold Callout Box */}
                {order.productionStatus === "on-hold" && (
                  <s-banner tone="critical" heading="Order is Currently On Hold">
                    <s-stack direction="block" gap="small">
                      <s-paragraph>
                        <strong>Hold on reason:</strong> {order.onHoldReason || "No hold reason specified"}
                      </s-paragraph>
                      <s-paragraph tone="subdued">
                        Production timeline and automatic SLA timers are suspended. Customer Service has been alerted. When ready, resume the order below.
                      </s-paragraph>
                    </s-stack>
                  </s-banner>
                )}

                {/* Customer Response Required Warning Banner */}
                {nextStepInfo.isWaitingCustomer && (
                  <s-banner tone="warning" heading="Customer Response Required">
                    <s-stack direction="block" gap="small">
                      <s-paragraph>
                        {nextStepInfo.waitingReason}
                      </s-paragraph>
                      <s-paragraph tone="subdued">
                        <strong>Status:</strong> The admin cannot manually advance to <strong>{nextStepInfo.nextLabel}</strong> until the customer submits their review. If changes or delays occur, you can place the order on hold with a specific reason.
                      </s-paragraph>
                    </s-stack>
                  </s-banner>
                )}

                {/* Actionable Execution Canvas */}
                {nextStepInfo.nextStatus && !nextStepInfo.isWaitingCustomer && order.productionStatus !== "delivered" ? (
                  <s-box padding="base" border="base" borderRadius="base" style={{ backgroundColor: "#ffffff" }}>
                    <s-stack direction="block" gap="base">
                      <s-stack direction="block" gap="small-200">
                        <s-text tone="subdued" style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.5px", fontWeight: "600" }}>
                          Execution Step
                        </s-text>
                        <s-heading style={{ fontSize: 18, margin: 0 }}>{nextStepInfo.nextLabel}</s-heading>
                        <s-paragraph tone="subdued">
                          {nextStepInfo.description}
                        </s-paragraph>
                      </s-stack>

                      {/* Contextual input: Proof decision when status is proof-sent */}
                      {order.productionStatus === "proof-sent" && (
                        <s-box padding="base" border="base" borderRadius="base" background="subdued">
                          <s-stack direction="block" gap="base">
                            <s-heading>Artwork Proof Decision</s-heading>
                            <s-banner tone="info">
                              <s-paragraph>
                                Artwork Proof v{order.proofVersion || 1} has been sent to {getCustomerEmail(order) || "the customer"}. You can wait for customer response via email/portal, or manually record an approval or requested changes below.
                              </s-paragraph>
                            </s-banner>

                            {order.proofUrl && (
                              <s-box padding="small-200" border="base" borderRadius="base" style={{ backgroundColor: "#ffffff" }}>
                                <s-stack direction="block" gap="small">
                                  {/[.](jpg|jpeg|png|webp|gif|bmp)$/i.test((order.proofUrl || "").split("?")[0].split("#")[0].trim()) && (
                                    <a href={order.proofUrl} target="_blank" rel="noopener noreferrer" style={{ display: "block", textAlign: "center" }}>
                                      <img
                                        src={order.proofUrl}
                                        alt={`Artwork Proof v${order.proofVersion || 1}`}
                                        style={{ maxWidth: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 6 }}
                                      />
                                    </a>
                                  )}
                                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                    <s-text tone="subdued" style={{ fontSize: 13 }}>Current Proof: Version {order.proofVersion || 1}</s-text>
                                    <s-button href={order.proofUrl} target="_blank">
                                      View Full Proof ↗
                                    </s-button>
                                  </s-stack>
                                </s-stack>
                              </s-box>
                            )}

                            <s-text-area
                              label="Revision / approval note"
                              value={proofNote}
                              placeholder="Required if requesting changes; optional note for approval..."
                              error={clientErrors.proofNote || actionData?.fieldErrors?.proofNote || undefined}
                              onInput={(event) => {
                                setProofNote(event.currentTarget.value);
                                clearFieldError("proofNote");
                              }}
                            />

                            <s-stack direction="inline" gap="small">
                              <s-button
                                variant="primary"
                                disabled={busy}
                                onClick={approveProof}
                              >
                                {busy ? "Updating..." : "Approve Artwork Proof"}
                              </s-button>
                              <s-button
                                tone="critical"
                                disabled={busy}
                                onClick={requestProofChanges}
                              >
                                Request Changes (Place On Hold)
                              </s-button>
                            </s-stack>
                          </s-stack>
                        </s-box>
                      )}

                      {/* Contextual input: Proof upload when moving to proof-sent */}
                      {nextStepInfo.nextStatus === "proof-sent" && (
                        <s-box padding="base" border="base" borderRadius="base" background="subdued">
                          <s-stack direction="block" gap="base">
                            <s-heading>Artwork Proof Preparation</s-heading>
                            <s-banner tone="info">
                              <s-paragraph>
                                Upload the Artwork Proof, or paste a link to it. The customer receives it by email with approval links once sent.
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
                                Preview proof ↗
                              </s-button>
                            )}
                          </s-stack>
                        </s-box>
                      )}

                      {/* Contextual input: Production Photo when moving to production-complete */}
                      {nextStepInfo.nextStatus === "production-complete" && order.productionStatus !== "on-hold" && (
                        <s-box padding="base" border="base" borderRadius="base" background="subdued">
                          <s-stack direction="block" gap="base">
                            <s-heading>Pre-Shipment Production Photo</s-heading>
                            <s-banner tone="info">
                              <s-paragraph>
                                A Production Photo is required. Upload it or paste a direct link. This will be sent to the customer for pre-shipment sign-off.
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

                            {productionPhotoUrl && validateHttpUrl(productionPhotoUrl) && (
                              <s-button href={productionPhotoUrl} target="_blank">
                                Preview production photo ↗
                              </s-button>
                            )}
                          </s-stack>
                        </s-box>
                      )}

                      {/* Freight Collection Specifications when order is Ready for Collection */}
                      {order.productionStatus === "ready-for-collection" && (
                        <s-box padding="base" border="base" borderRadius="base" background="subdued">
                          <s-stack direction="block" gap="base">
                            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                              <s-heading>Freight Collection Specifications (FOB)</s-heading>
                              {/* <s-button
                                variant="secondary"
                                disabled={resendingReadyForCollectionEmail ? true : undefined}
                                onClick={() => submitIntent("resend_ready_for_collection_email")}
                              >
                                {resendingReadyForCollectionEmail ? "Sending..." : "Resend Ready for Collection Email"}
                              </s-button> */}
                            </s-stack>

                            {!isEditingCollection && (order.collectionReadyDate || order.collectionCartons) ? (
                              <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
                                <s-box>
                                  <s-text tone="subdued" style={{ fontSize: 12 }}>Ready Date</s-text>
                                  <s-heading style={{ fontSize: 15, margin: "2px 0 0 0" }}>
                                    {order.collectionReadyDate ? formatDay(order.collectionReadyDate) : "—"}
                                  </s-heading>
                                </s-box>
                                <s-box>
                                  <s-text tone="subdued" style={{ fontSize: 12 }}>Cartons</s-text>
                                  <s-heading style={{ fontSize: 15, margin: "2px 0 0 0" }}>
                                    {order.collectionCartons || "—"}
                                  </s-heading>
                                </s-box>
                                <s-box>
                                  <s-text tone="subdued" style={{ fontSize: 12 }}>Gross Weight</s-text>
                                  <s-heading style={{ fontSize: 15, margin: "2px 0 0 0" }}>
                                    {order.collectionGrossWeight ? `${order.collectionGrossWeight} kg` : "—"}
                                  </s-heading>
                                </s-box>
                                <s-box>
                                  <s-text tone="subdued" style={{ fontSize: 12 }}>Volume (CBM)</s-text>
                                  <s-heading style={{ fontSize: 15, margin: "2px 0 0 0" }}>
                                    {order.collectionCbm ? `${order.collectionCbm} m³` : "—"}
                                  </s-heading>
                                </s-box>
                              </s-grid>
                            ) : (
                              <s-stack direction="block" gap="base">
                                <s-banner tone="info">
                                  <s-paragraph>
                                    Collection package dimensions and ready date. Updating these details keeps logistics records accurate for customer freight collection.
                                  </s-paragraph>
                                </s-banner>

                                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                                  <DatePickerInput
                                    label="Ready Date"
                                    value={readyDate}
                                    error={clientErrors.readyDate || actionData?.fieldErrors?.readyDate || undefined}
                                    onChange={(val) => {
                                      setReadyDate(val);
                                      clearFieldError("readyDate");
                                    }}
                                    onClear={() => {
                                      setReadyDate("");
                                      clearFieldError("readyDate");
                                    }}
                                  />
                                  <s-text-field
                                    label="Number of Cartons"
                                    type="number"
                                    value={numberOfCartons}
                                    error={clientErrors.numberOfCartons || actionData?.fieldErrors?.numberOfCartons || undefined}
                                    onInput={(event) => {
                                      setNumberOfCartons(event.currentTarget.value);
                                      clearFieldError("numberOfCartons");
                                    }}
                                  />
                                  <s-text-field
                                    label="Gross Weight (kg)"
                                    type="number"
                                    value={grossWeight}
                                    error={clientErrors.grossWeight || actionData?.fieldErrors?.grossWeight || undefined}
                                    onInput={(event) => {
                                      setGrossWeight(event.currentTarget.value);
                                      clearFieldError("grossWeight");
                                    }}
                                  />
                                  <s-text-field
                                    label="CBM"
                                    placeholder="Length × Width × Height"
                                    type="number"
                                    step="0.01"
                                    value={cbm}
                                    error={clientErrors.cbm || actionData?.fieldErrors?.cbm || undefined}
                                    onInput={(event) => {
                                      setCbm(event.currentTarget.value);
                                      clearFieldError("cbm");
                                    }}
                                  />
                                </s-grid>

                                <s-stack direction="inline" gap="small">
                                  <s-button
                                    variant="primary"
                                    onClick={() => submitUpdateCollectionDetails()}
                                  >
                                    Save Specifications
                                  </s-button>
                                  {(order.collectionReadyDate || order.collectionCartons) && (
                                    <s-button
                                      variant="secondary"
                                      onClick={() => setIsEditingCollection(false)}
                                    >
                                      Cancel
                                    </s-button>
                                  )}
                                </s-stack>
                              </s-stack>
                            )}
                          </s-stack>
                        </s-box>
                      )}

                      {/* Contextual input: Collection details when moving to ready-for-collection */}
                      {nextStepInfo.nextStatus === "ready-for-collection" && (
                        <s-box padding="base" border="base" borderRadius="base" background="subdued">
                          <s-stack direction="block" gap="base">
                            <s-heading>Freight Collection Details</s-heading>
                            <s-banner tone="info">
                              <s-paragraph>
                                Enter the final collection package dimensions. This information will be sent to the customer so they can coordinate freight pickup.
                              </s-paragraph>
                            </s-banner>

                            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                              <DatePickerInput
                                label="Ready Date"
                                value={readyDate}
                                error={
                                  clientErrors.readyDate ||
                                  actionData?.fieldErrors?.readyDate ||
                                  undefined
                                }
                                onChange={(val) => {
                                  setReadyDate(val);
                                  clearFieldError("readyDate");
                                }}
                                onClear={() => {
                                  setReadyDate("");
                                  clearFieldError("readyDate");
                                }}
                              />
                              <s-text-field
                                label="Number of Cartons"
                                type="number"
                                value={numberOfCartons}
                                error={
                                  clientErrors.numberOfCartons ||
                                  actionData?.fieldErrors?.numberOfCartons ||
                                  undefined
                                }
                                onInput={(event) => {
                                  setNumberOfCartons(event.currentTarget.value);
                                  clearFieldError("numberOfCartons");
                                }}
                              />
                              <s-text-field
                                label="Gross Weight (kg)"
                                type="number"
                                value={grossWeight}
                                error={
                                  clientErrors.grossWeight ||
                                  actionData?.fieldErrors?.grossWeight ||
                                  undefined
                                }
                                onInput={(event) => {
                                  setGrossWeight(event.currentTarget.value);
                                  clearFieldError("grossWeight");
                                }}
                              />
                              <s-text-field
                                label="CBM"
                                placeholder="Length × Width × Height"
                                type="number"
                                step="0.01"
                                value={cbm}
                                error={
                                  clientErrors.cbm ||
                                  actionData?.fieldErrors?.cbm ||
                                  undefined
                                }
                                onInput={(event) => {
                                  setCbm(event.currentTarget.value);
                                  clearFieldError("cbm");
                                }}
                              />
                            </s-grid>
                          </s-stack>
                        </s-box>
                      )}

                      {/* Contextual guidance: Shipped */}
                      {nextStepInfo.nextStatus === "shipped" && (
                        <s-box padding="base" border="base" borderRadius="base" background="subdued">
                          <s-stack direction="block" gap="base">
                            <s-banner tone="warning">
                              <s-paragraph>
                                Please fulfill the order and update tracking from Shopify Admin to notify the customer with carrier tracking.
                              </s-paragraph>
                            </s-banner>
                            <s-button href={`shopify:admin/orders/${order.id.split('/').pop()}`} target="_blank">
                              Open Order in Shopify Admin ↗
                            </s-button>
                          </s-stack>
                        </s-box>
                      )}

                      {nextStepInfo.nextStatus !== "shipped" && (
                        <s-text-area
                          label="Internal production note (Optional)"
                          value={note}
                          placeholder="Optional note recorded in the production history log..."
                          onInput={(event) => setNote(event.currentTarget.value)}
                        />
                      )}

                      {clientErrors.nextStatus && (
                        <s-banner tone="critical">
                          <s-text>{clientErrors.nextStatus}</s-text>
                        </s-banner>
                      )}

                      <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                        <s-stack direction="inline" gap="small">
                          {order.productionStatus !== "on-hold" && order.productionStatus !== "delivered" && (
                            <s-button
                              tone="critical"
                              variant="secondary"
                              commandFor="hold-order-modal"
                              command="--show"
                              onClick={() => openHoldModal()}
                            >
                              Put on Hold
                            </s-button>
                          )}
                        </s-stack>

                        <s-stack direction="inline" gap="small" alignItems="center">
                          {order.productionStatus === "on-hold" && (
                            <s-button
                              variant={nextStepInfo.nextStatus === "shipped" ? "primary" : "secondary"}
                              disabled={busy}
                              onClick={() => {
                                const formData = new FormData();
                                formData.set("intent", "change_status");
                                formData.set("nextStatus", nextStepInfo.heldFrom || "production-complete");
                                formData.set("note", "Resumed order from hold.");
                                submit(formData, { method: "post" });
                              }}
                            >
                              {busy ? "Resuming..." : `Resume Order to ${getStatusLabel(nextStepInfo.heldFrom || "production-complete")}`}
                            </s-button>
                          )}

                          {nextStepInfo.nextStatus !== "shipped" && nextStepInfo.nextStatus !== "sample-review" && (
                            <s-button
                              variant="primary"
                              disabled={busy || order.creditReviewHold}
                              onClick={proceedNextStep}
                            >
                              {busy ? "Updating..." : nextStepInfo.actionVerb}
                            </s-button>
                          )}
                        </s-stack>
                      </s-stack>
                    </s-stack>
                  </s-box>
                ) : order.productionStatus === "delivered" ? (
                  <s-box padding="base" border="base" borderRadius="base">
                    <s-banner tone="success" heading="Production Cycle Complete">
                      <s-text>This order has completed all manufacturing, packing, and fulfillment milestones.</s-text>
                    </s-banner>
                  </s-box>
                ) : null}
              </s-stack>
            </s-section>

            {/* Bill of Materials & Products Manifest */}
            <s-section heading="Products & Customisation Manifest">
              <s-stack direction="block" gap="base">
                {order.lineItems?.nodes?.length ? (
                  order.lineItems.nodes.map((item) => {
                    const price = item.originalUnitPriceSet?.presentmentMoney;
                    const imprint = item.customAttributes?.find(
                      (attribute) => attribute.key === "Imprint Locations",
                    );
                    const artwork = item.customAttributes?.find(
                      (attribute) =>
                        String(attribute.key || "").trim().toLowerCase() === "artwork",
                    );
                    const itemTotal = Number(price?.amount || 0) * Number(item.quantity || 1);

                    return (
                      <s-box
                        key={item.id}
                        padding="base"
                        border="base"
                        borderRadius="base"
                        style={{ backgroundColor: "#ffffff" }}
                      >
                        <s-stack direction="inline" gap="base" alignItems="start">
                          {/* Image thumbnail */}
                          {item.image?.url ? (
                            <img
                              src={item.image.url}
                              alt={item.title}
                              style={{
                                width: 56,
                                height: 56,
                                borderRadius: 8,
                                objectFit: "cover",
                                border: "1px solid #dfe3e8",
                                flexShrink: 0,
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                width: 56,
                                height: 56,
                                borderRadius: 8,
                                backgroundColor: "#f4f6f8",
                                border: "1px solid #dfe3e8",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 18,
                                color: "#8c9196",
                                flexShrink: 0,
                              }}
                            >
                              👕
                            </div>
                          )}

                          {/* Item Details */}
                          <div style={{ flex: 1 }}>
                            <s-stack direction="block" gap="small-200">
                              <s-stack direction="inline" justifyContent="space-between" alignItems="start">
                                <s-stack direction="block" gap="none">
                                  <s-heading style={{ fontSize: 16, margin: 0 }}>{item.title}</s-heading>
                                  {item.variantTitle && (
                                    <s-text color="subdued" style={{ fontSize: 13 }}>
                                      Variant: {item.variantTitle}
                                    </s-text>
                                  )}
                                </s-stack>

                                <s-stack direction="inline" gap="small-200" alignItems="center">
                                  <s-badge tone="neutral">{item.quantity} units</s-badge>
                                  <s-heading style={{ fontSize: 15, margin: 0 }}>
                                    {formatMoney(itemTotal, price?.currencyCode || "USD")}
                                  </s-heading>
                                </s-stack>
                              </s-stack>

                              {/* Badges & Meta */}
                              <s-stack direction="inline" gap="small-200" alignItems="center">
                                {item.sku && (
                                  <s-badge tone="neutral">SKU: {item.sku}</s-badge>
                                )}
                                {imprint?.value && (
                                  <s-badge tone="info">Decoration: {imprint.value}</s-badge>
                                )}
                              </s-stack>

                              {/* Artwork link if present */}
                              {artwork?.value && (
                                <div style={{ marginTop: "4px" }}>
                                  {validateHttpUrl(artwork.value) ? (
                                    <s-button href={artwork.value} target="_blank">
                                      View Customer Artwork File ↗
                                    </s-button>
                                  ) : (
                                    <s-text color="subdued" style={{ fontSize: 13 }}>
                                      Artwork: {artwork.value}
                                    </s-text>
                                  )}
                                </div>
                              )}
                            </s-stack>
                          </div>
                        </s-stack>
                      </s-box>
                    );
                  })
                ) : (
                  <s-box padding="base" border="base" borderRadius="base">
                    <s-paragraph color="subdued">No products found in this order.</s-paragraph>
                  </s-box>
                )}
              </s-stack>
            </s-section>

            {/* Physical Sample Section (if required) */}
            {(order.physicalSampleRequired || order.hasPhysicalSample || ["sample-preparation", "sample-review"].includes(order.productionStatus)) && ["proof-approved", "sample-preparation", "sample-review", "in-production", "production-complete"].includes(
              order.productionStatus === "on-hold"
                ? (loaderData.history?.find(h => h?.toStatus === "on-hold")?.fromStatus || "")
                : order.productionStatus
            ) && (
                <s-section heading="Manage Physical Sample">
                  <s-stack direction="block" gap="base">
                    <s-box padding="base" border="base" borderRadius="base" style={{ backgroundColor: "#ffffff" }}>
                      <s-stack direction="block" gap="base">
                        <s-stack
                          direction="inline"
                          justifyContent="space-between"
                          alignItems="center"
                        >
                          <s-stack direction="block" gap="none">
                            <s-text tone="subdued" style={{ fontSize: 13 }}>Physical Sample Status</s-text>
                            <s-heading style={{ fontSize: 16, margin: 0 }}>
                              Sample v{
                                (order.physicalSampleStatus === "sent" || order.physicalSampleStatus === "approved")
                                  ? (order.physicalSampleVersion || 1)
                                  : ((order.physicalSampleVersion || 0) + 1)
                              }
                            </s-heading>
                          </s-stack>

                          <s-badge tone={physicalSampleStatusTone(order.physicalSampleStatus)}>
                            {physicalSampleStatusLabel(order.physicalSampleStatus)}
                          </s-badge>
                        </s-stack>

                        {(!order.physicalSampleStatus || order.physicalSampleStatus === "changes_requested") && (
                          <s-box padding="base" border="base" borderRadius="base" background="subdued">
                            <s-stack direction="block" gap="base">
                              <s-heading>Send Physical Sample</s-heading>
                              <s-text tone="subdued">
                                Record dispatch of a physical pre-production sample to the customer. The order will then wait for customer approval.
                              </s-text>

                              <ShopifyFileUpload
                                label="Upload Physical Sample Image/Document"
                                prefix={`${order.name}-sample-v${order.physicalSampleVersion + 1}`}
                                onUploaded={(url) => setPhysicalSampleFileUrl(url)}
                              />
                              <s-text-field
                                label="File URL (optional)"
                                type="url"
                                placeholder="https://..."
                                value={physicalSampleFileUrl}
                                onInput={(event) => setPhysicalSampleFileUrl(event.currentTarget.value)}
                              />
                              <s-text-area
                                label="Sample Note (optional)"
                                placeholder="Enter details about this physical sample..."
                                value={physicalSampleNote}
                                onInput={(event) => setPhysicalSampleNote(event.currentTarget.value)}
                              />

                              <s-button
                                variant="primary"
                                disabled={dispatchingPhysicalSample ? true : undefined}
                                onClick={() => {
                                  const formData = new FormData();
                                  formData.set("intent", "send_physical_sample");
                                  formData.set("fileUrl", physicalSampleFileUrl);
                                  formData.set("note", physicalSampleNote);
                                  submit(formData, { method: "post" });
                                }}
                              >
                                {dispatchingPhysicalSample ? "Processing..." : "Dispatch Physical Sample"}
                              </s-button>
                            </s-stack>
                          </s-box>
                        )}

                        {order.physicalSampleStatus === "sent" && (
                          <s-box padding="base" border="base" borderRadius="base" background="subdued">
                            <s-stack direction="block" gap="base">
                              <s-heading>Awaiting Customer Sample Approval</s-heading>
                              <s-text tone="subdued">
                                Physical sample v{order.physicalSampleVersion} is waiting for customer review. Record the customer&apos;s decision here if they responded outside the email.
                              </s-text>
                              <s-text-area
                                label="Change / approval note"
                                placeholder="Enter the requested sample changes..."
                                value={physicalSampleDecisionNote}
                                onInput={(event) => setPhysicalSampleDecisionNote(event.currentTarget.value)}
                              />
                              <s-stack direction="inline" gap="small" alignItems="center">
                                <s-button
                                  variant="primary"
                                  disabled={busy}
                                  commandFor="physical-sample-approve-modal"
                                  command="--show"
                                >
                                  {busy ? "Processing..." : "Approve on behalf of customer"}
                                </s-button>
                                <s-button
                                  tone="critical"
                                  disabled={busy}
                                  onClick={requestPhysicalSampleChanges}
                                >
                                  Request Changes
                                </s-button>
                              </s-stack>
                            </s-stack>
                          </s-box>
                        )}

                        {loaderData.physicalSampleHistory?.length > 0 && (
                          <s-stack direction="block" gap="small">
                            <s-heading>Sample History</s-heading>
                            {loaderData.physicalSampleHistory.map((item, index) => (
                              <s-box key={item.sampleVersion || index} padding="base" border="base" borderRadius="base">
                                <s-stack direction="block" gap="small-200">
                                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                    <s-stack direction="inline" gap="small" alignItems="center">
                                      <s-heading level="3" style={{ margin: 0, fontSize: "14px", fontWeight: "600" }}>Version {item.sampleVersion}</s-heading>
                                      <s-badge tone={item.status === "approved" ? "success" : item.status === "changes_requested" ? "warning" : "info"}>
                                        {item.status ? item.status.replace("_", " ").toUpperCase() : "SENT"}
                                      </s-badge>
                                    </s-stack>
                                    <s-text tone="subdued" style={{ fontSize: "12px" }}>{formatDate(item.sentAt)}</s-text>
                                  </s-stack>

                                  <s-text tone="subdued" style={{ fontSize: "13px" }}>
                                    Sent by <strong>{item.sentBy}</strong>
                                    {item.responseDate && ` • Responded by ${item.approvedBy} on ${formatDate(item.responseDate)}`}
                                  </s-text>

                                  {item.response && (
                                    <s-box padding="small" background="subdued" borderRadius="base">
                                      <s-paragraph style={{ margin: 0, fontSize: "13px" }}>
                                        <strong>{item.status === "changes_requested" ? "Changes: " : "Note: "}</strong>
                                        {item.response}
                                      </s-paragraph>
                                    </s-box>
                                  )}

                                  {item.fileUrl && (
                                    <a href={item.fileUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: "4px", textDecoration: "none" }} title="Open full image in new tab">
                                      <s-thumbnail
                                        src={item.fileUrl}
                                        alt={`Sample v${item.sampleVersion}`}
                                        size="base"
                                      ></s-thumbnail>
                                    </a>
                                  )}
                                </s-stack>
                              </s-box>
                            ))}
                          </s-stack>
                        )}
                      </s-stack>
                    </s-box>
                  </s-stack>
                </s-section>
              )}

            {/* Production Timeline & Audit Trail */}
            <s-section heading="Production Audit Trail">
              <s-stack direction="block" gap="small">
                {loaderData.history?.length === 0 ? (
                  <s-box padding="base" border="base" borderRadius="base" style={{ backgroundColor: "#ffffff" }}>
                    <s-paragraph color="subdued">
                      No production status transitions recorded yet.
                    </s-paragraph>
                  </s-box>
                ) : (
                  loaderData.history.map((item, index) => (
                    <TimelineItem
                      key={item.id}
                      item={item}
                      isLatest={index === 0}
                      currentOnHoldReason={order?.onHoldReason}
                    />
                  ))
                )}
              </s-stack>
            </s-section>
          </s-stack>

          {/* Right Column (Contextual Profiles & Controls) */}
          <s-stack direction="block" gap="base">
            {/* Documents: the proforma invoice for customs and payment (HYV-118). */}
            <s-section heading="Documents">
              <s-stack direction="block" gap="small-300">
                <s-text tone="subdued">For customs and payment before shipment.</s-text>
                <s-button href={`/app/proforma/${order.id.split("/").pop()}`}>Proforma Invoice</s-button>
              </s-stack>
            </s-section>

            {/* Customer & Company Profile Card */}
            <s-section heading="Customer & Company">
              <s-box padding="base" border="base" borderRadius="base" style={{ backgroundColor: "#ffffff" }}>
                <s-stack direction="block" gap="small-300">
                  {order.shippingAddress?.company && (
                    <s-stack direction="block" gap="none">
                      <s-text tone="subdued" style={{ fontSize: 12 }}>Company</s-text>
                      <s-heading style={{ fontSize: 16, margin: 0 }}>{order.shippingAddress.company}</s-heading>
                    </s-stack>
                  )}

                  <s-stack direction="block" gap="none">
                    <s-text tone="subdued" style={{ fontSize: 12 }}>Contact Name</s-text>
                    <s-text type="strong">
                      {order.customer?.displayName || shipping?.name || "Guest customer"}
                    </s-text>
                  </s-stack>

                  {getCustomerEmail(order) && (
                    <s-stack direction="block" gap="none">
                      <s-text tone="subdued" style={{ fontSize: 12 }}>Email</s-text>
                      <s-link href={`mailto:${getCustomerEmail(order)}`}>
                        {getCustomerEmail(order)}
                      </s-link>
                    </s-stack>
                  )}

                  {(order.customer?.phone || order.phone) && (
                    <s-stack direction="block" gap="none">
                      <s-text tone="subdued" style={{ fontSize: 12 }}>Phone</s-text>
                      <s-text>{order.customer?.phone || order.phone}</s-text>
                    </s-stack>
                  )}

                  {order.note && (
                    <div style={{ marginTop: "6px", padding: "8px 12px", backgroundColor: "#f9fafb", borderRadius: "6px", border: "1px solid #e1e3e5" }}>
                      <s-text tone="subdued" style={{ fontSize: 12 }}>Order Note:</s-text>
                      <s-paragraph style={{ margin: "2px 0 0 0", fontSize: 13 }}>{order.note}</s-paragraph>
                    </div>
                  )}
                </s-stack>
              </s-box>
            </s-section>

            {/* Shipping & Freight Address Card */}
            <s-section heading="Logistics & Destination">
              <s-box padding="base" border="base" borderRadius="base" style={{ backgroundColor: "#ffffff" }}>
                <s-stack direction="block" gap="small-300">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-text tone="subdued" style={{ fontSize: 12 }}>Freight Terms</s-text>
                    {order.customerArrangedFreight ? (
                      <s-badge tone="attention">FOB (Pickup)</s-badge>
                    ) : (
                      <s-badge tone="neutral">{incotermFromShipping(order.shippingLine?.title) || "Standard Courier"}</s-badge>
                    )}
                  </s-stack>

                  {shipping ? (
                    <s-stack direction="block" gap="small-200">
                      <s-text type="strong">{shipping.name}</s-text>
                      <s-text color="subdued">{shipping.address1}</s-text>
                      {shipping.address2 && <s-text color="subdued">{shipping.address2}</s-text>}
                      <s-text color="subdued">
                        {[shipping.city, shipping.province, shipping.zip].filter(Boolean).join(", ")}
                      </s-text>
                      <s-text color="subdued">{shipping.country}</s-text>
                      {shipping.phone && <s-text color="subdued">Tel: {shipping.phone}</s-text>}
                    </s-stack>
                  ) : (
                    <s-text tone="subdued">No delivery address provided.</s-text>
                  )}
                  {(pickupConfig?.pickup_address ||
                    pickupConfig?.contact_name ||
                    pickupConfig?.contact_phone ||
                    pickupConfig?.contact_email ||
                    pickupHours.length > 0) && (
                      <div
                        style={{
                          marginTop: "8px",
                          padding: "10px 12px",
                          backgroundColor: "#fbfcfe",
                          borderRadius: "6px",
                          border: "1px solid #e1e3e5",
                        }}
                      >
                        <s-stack direction="block" gap="small-200">
                          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                            <s-text
                              tone="subdued"
                              style={{
                                fontSize: 12,
                                fontWeight: "600",
                                textTransform: "uppercase",
                                letterSpacing: "0.5px",
                              }}
                            >
                              Pickup Location & Contact Details
                            </s-text>

                          </s-stack>

                          {pickupConfig.pickup_address && (
                            <div style={{ marginTop: "2px" }}>
                              <s-text tone="subdued" style={{ fontSize: 11 }}>Address:</s-text>
                              <s-paragraph style={{ margin: "2px 0 0 0", fontSize: 13, whiteSpace: "pre-line" }}>
                                {pickupConfig.pickup_address}
                              </s-paragraph>
                            </div>
                          )}

                          {pickupConfig.contact_name && (
                            <s-stack direction="inline" justifyContent="space-between">
                              <s-text tone="subdued" style={{ fontSize: 13 }}>Contact Name:</s-text>
                              <s-text type="strong" style={{ fontSize: 13 }}>{pickupConfig.contact_name}</s-text>
                            </s-stack>
                          )}

                          {pickupConfig.contact_phone && (
                            <s-stack direction="inline" justifyContent="space-between">
                              <s-text tone="subdued" style={{ fontSize: 13 }}>Contact Phone:</s-text>
                              <s-text type="strong" style={{ fontSize: 13 }}>{pickupConfig.contact_phone}</s-text>
                            </s-stack>
                          )}

                          {pickupConfig.contact_email && (
                            <s-stack direction="inline" justifyContent="space-between">
                              <s-text tone="subdued" style={{ fontSize: 13 }}>Contact Email:</s-text>
                              <s-link href={`mailto:${pickupConfig.contact_email}`} style={{ fontSize: 13 }}>
                                {pickupConfig.contact_email}
                              </s-link>
                            </s-stack>
                          )}

                          {pickupHours.map(([day, hours]) => (
                            <s-stack key={day} direction="inline" justifyContent="space-between">
                              <s-text tone="subdued" style={{ fontSize: 13 }}>{day}:</s-text>
                              <s-text type="strong" style={{ fontSize: 13 }}>{hours}</s-text>
                            </s-stack>
                          ))}
                        </s-stack>
                      </div>
                    )}

                  {order.customerArrangedFreight &&
                    !pickupConfig?.pickup_address &&
                    !pickupConfig?.contact_name &&
                    !pickupConfig?.contact_phone &&
                    !pickupConfig?.contact_email &&
                    pickupHours.length === 0 && (
                      <div
                        style={{
                          marginTop: "8px",
                          padding: "8px 12px",
                          backgroundColor: "#fff8f2",
                          borderRadius: "6px",
                          border: "1px dashed #fabda0",
                        }}
                      >
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                          <s-text tone="subdued" style={{ fontSize: 12 }}>
                            No pickup configuration set.
                          </s-text>
                          <a
                            href="/app/pickup-config"
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: 11,
                              color: "#005bd3",
                              textDecoration: "none",
                              fontWeight: "500",
                            }}
                          >
                            Configure
                          </a>
                        </s-stack>
                      </div>
                    )}

                  {(order.customerArrangedFreight || order.collectionReadyDate || order.collectionCartons || order.collectionGrossWeight || order.collectionCbm) && (
                    <div style={{ marginTop: "8px", padding: "10px 12px", backgroundColor: "#fbfcfe", borderRadius: "6px", border: "1px solid #e1e3e5" }}>
                      <s-stack direction="block" gap="small-200">
                        <s-text tone="subdued" style={{ fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                          Collection Package Details
                        </s-text>
                        <s-stack direction="inline" justifyContent="space-between">
                          <s-text tone="subdued" style={{ fontSize: 13 }}>Ready Date:</s-text>
                          <s-text type="strong" style={{ fontSize: 13 }}>{order.collectionReadyDate ? formatDay(order.collectionReadyDate) : "—"}</s-text>
                        </s-stack>
                        <s-stack direction="inline" justifyContent="space-between">
                          <s-text tone="subdued" style={{ fontSize: 13 }}>Cartons:</s-text>
                          <s-text type="strong" style={{ fontSize: 13 }}>{order.collectionCartons || "—"}</s-text>
                        </s-stack>
                        <s-stack direction="inline" justifyContent="space-between">
                          <s-text tone="subdued" style={{ fontSize: 13 }}>Gross Weight:</s-text>
                          <s-text type="strong" style={{ fontSize: 13 }}>{order.collectionGrossWeight ? `${order.collectionGrossWeight} kg` : "—"}</s-text>
                        </s-stack>
                        <s-stack direction="inline" justifyContent="space-between">
                          <s-text tone="subdued" style={{ fontSize: 13 }}>Volume (CBM):</s-text>
                          <s-text type="strong" style={{ fontSize: 13 }}>{order.collectionCbm ? `${order.collectionCbm} m³` : "—"}</s-text>
                        </s-stack>
                      </s-stack>
                    </div>
                  )}
                </s-stack>
              </s-box>
            </s-section>

            {/* Production Schedule & SLA Controls */}
            <s-section heading="Production Schedule & SLA">
              <s-box padding="base" border="base" borderRadius="base" style={{ backgroundColor: "#ffffff" }}>
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-text tone="subdued">Production Due Date</s-text>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-text type="strong">{order.productionDueAt ? formatDay(order.productionDueAt) : "—"}</s-text>
                      {dueStatus && <s-badge tone={dueStatus.tone}>{dueStatus.label}</s-badge>}
                    </s-stack>
                  </s-stack>

                  <s-divider />

                  <s-stack direction="block" gap="small">
                    <DatePickerInput
                      label="Estimated ship date"
                      details="Shown to the buyer instead of the calculated production date."
                      value={shipDate}
                      onChange={(val) => setShipDate(val)}
                      onClear={() => setShipDate("")}
                    />

                    <s-stack direction="inline" gap="small">
                      <s-button
                        variant="secondary"
                        onClick={() =>
                          submitIntent("set_ship_date", {
                            estimatedShipDate: shipDate,
                          })
                        }
                      >
                        Save date
                      </s-button>

                      <s-button
                        variant="secondary"
                        onClick={() =>
                          submitIntent("send_estimated_ship_date_email")
                        }
                      >
                        Email Customer
                      </s-button>
                    </s-stack>
                  </s-stack>

                  <s-divider />

                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-text>Automated Alerts & Clocks</s-text>
                      <s-badge tone={order.notificationsPaused ? "warning" : "success"}>
                        {order.notificationsPaused ? "Paused" : "Active"}
                      </s-badge>
                    </s-stack>

                    <s-text tone="subdued" style={{ fontSize: 13 }}>
                      Controls proof reminders and day-10 hold triggers.
                    </s-text>

                    <s-button
                      variant="secondary"
                      onClick={() => submitIntent("toggle_notifications")}
                    >
                      {order.notificationsPaused ? "Resume automated alerts" : "Pause automated alerts"}
                    </s-button>
                  </s-stack>

                  <s-divider />

                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text tone="subdued" style={{ fontSize: 13 }}>Ordered Date</s-text>
                    <s-text style={{ fontSize: 13 }}>{formatDate(order.createdAt)}</s-text>
                  </s-stack>

                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text tone="subdued" style={{ fontSize: 13 }}>Status Changed</s-text>
                    <s-text style={{ fontSize: 13 }}>{formatDate(order.statusChangedAt)}</s-text>
                  </s-stack>
                </s-stack>
              </s-box>
            </s-section>

            {/* Artwork Proof & Pre-Shipment Inspection Assets */}
            <s-section heading="Artwork Proof & Inspection Assets">
              <s-box padding="base" border="base" borderRadius="base" style={{ backgroundColor: "#ffffff" }}>
                <s-stack direction="block" gap="base">
                  {/* Proof */}
                  <s-stack direction="block" gap="small-200">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-text type="strong">Artwork Proof</s-text>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-badge tone={order.proofVersion ? "info" : "neutral"}>
                          v{order.proofVersion || 0}
                        </s-badge>
                        {order.productionStatus === "proof-approved" && (
                          <s-badge tone="success">APPROVED</s-badge>
                        )}
                      </s-stack>
                    </s-stack>

                    {order.proofUrl ? (
                      <s-stack direction="block" gap="small-200">
                        {/[.](jpg|jpeg|png|webp|gif|bmp)$/i.test((order.proofUrl || "").split("?")[0].split("#")[0].trim()) && (
                          <a href={order.proofUrl} target="_blank" rel="noopener noreferrer" style={{ display: "block" }}>
                            <img
                              src={order.proofUrl}
                              alt={`Artwork proof v${order.proofVersion || 1}`}
                              style={{ width: "100%", maxHeight: 120, objectFit: "cover", borderRadius: 6, border: "1px solid #dfe3e8" }}
                            />
                          </a>
                        )}
                        <s-button href={order.proofUrl} target="_blank">
                          View Current Proof ↗
                        </s-button>

                        {order.proofEmailSent ? (
                          <s-badge tone="success">Proof email delivered</s-badge>
                        ) : order.productionStatus === "proof-sent" ? (
                          <s-stack direction="block" gap="small-200">
                            <s-badge tone="warning">Email delivery pending</s-badge>
                            {canRetryProofEmail && (
                              <s-button disabled={busy} onClick={retryProofEmail}>
                                {busy ? "Sending..." : "Retry Proof Email"}
                              </s-button>
                            )}
                          </s-stack>
                        ) : null}

                        {order.productionStatus === "proof-sent" && (
                          <s-stack direction="block" gap="small" style={{ marginTop: "8px" }}>
                            <s-text-area
                              label="Change / approval note"
                              value={proofNote}
                              placeholder="Enter note if requesting changes..."
                              error={clientErrors.proofNote || actionData?.fieldErrors?.proofNote || undefined}
                              onInput={(event) => {
                                setProofNote(event.currentTarget.value);
                                clearFieldError("proofNote");
                              }}
                            />
                            <s-stack direction="inline" gap="small">
                              <s-button variant="primary" disabled={busy} onClick={approveProof}>
                                {busy ? "Updating..." : "Approve Proof"}
                              </s-button>
                              <s-button tone="critical" disabled={busy} onClick={requestProofChanges}>
                                Request Changes
                              </s-button>
                            </s-stack>
                          </s-stack>
                        )}
                      </s-stack>
                    ) : (
                      <s-text tone="subdued" style={{ fontSize: 13 }}>No digital proof created yet.</s-text>
                    )}
                  </s-stack>

                  <s-divider />

                  {/* Production Photo */}
                  <s-stack direction="block" gap="small-200">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-text type="strong">Pre-Shipment Photo</s-text>
                      {order.productionPhotoVersion && (
                        <s-badge tone={order.productionApprovalStatus === "approved" ? "success" : order.productionApprovalStatus === "declined" ? "critical" : "warning"}>
                          {order.productionApprovalStatus ? order.productionApprovalStatus.toUpperCase() : "PENDING"}
                        </s-badge>
                      )}
                    </s-stack>

                    {order.productionPhotoUrl ? (
                      <s-stack direction="block" gap="small-200">
                        <a href={order.productionPhotoUrl} target="_blank" rel="noopener noreferrer" style={{ display: "block" }}>
                          <img
                            src={order.productionPhotoUrl}
                            alt="Pre-shipment production"
                            style={{ width: "100%", maxHeight: 140, objectFit: "cover", borderRadius: 6, border: "1px solid #dfe3e8" }}
                          />
                        </a>
                        <s-button href={order.productionPhotoUrl} target="_blank">
                          Open Full Image ↗
                        </s-button>

                        {order.productionApprovalNote && (
                          <s-banner tone="warning" heading="Requested changes">
                            <s-paragraph>{order.productionApprovalNote}</s-paragraph>
                          </s-banner>
                        )}

                        {(order.productionStatus === "production-complete" || order.productionStatus === "on-hold") &&
                          order.productionApprovalStatus !== "approved" && (
                            <s-stack direction="block" gap="small">
                              <s-text-area
                                label="Change / approval note"
                                value={productionApprovalNote}
                                placeholder="Enter note if requesting changes..."
                                onInput={(event) => setProductionApprovalNote(event.currentTarget.value)}
                              />
                              <s-stack direction="inline" gap="small">
                                <s-button variant="primary" disabled={busy} onClick={approveProduction}>
                                  {busy ? "Updating..." : "Approve Photo"}
                                </s-button>
                                <s-button tone="critical" disabled={busy} onClick={declineProduction}>
                                  Request Changes
                                </s-button>
                              </s-stack>

                              {order.productionApprovalStatus === "declined" && (
                                <s-box padding="small-300" border="base" borderRadius="base" background="subdued">
                                  <s-stack direction="block" gap="small-200">
                                    <s-text type="strong" style={{ fontSize: 13 }}>Upload Revised Production Photo</s-text>
                                    <ShopifyFileUpload
                                      label="Upload Revised Photo"
                                      prefix={`${order.name}-photo-v${Number(order.productionPhotoVersion || 0) + 1}`}
                                      onUploaded={(url) => {
                                        setProductionPhotoUrl(url);
                                        clearFieldError("productionPhotoUrl");
                                      }}
                                    />
                                    <s-text-field
                                      label="Revised Photo URL"
                                      type="url"
                                      placeholder="https://..."
                                      value={productionPhotoUrl}
                                      error={clientErrors.productionPhotoUrl}
                                      onInput={(event) => {
                                        setProductionPhotoUrl(event.currentTarget.value);
                                        clearFieldError("productionPhotoUrl");
                                      }}
                                    />
                                    <s-button variant="secondary" disabled={busy} onClick={resubmitProductionPhoto}>
                                      {busy ? "Submitting..." : "Send Revised Photo for Approval"}
                                    </s-button>
                                  </s-stack>
                                </s-box>
                              )}
                            </s-stack>
                          )}
                      </s-stack>
                    ) : (
                      <s-text tone="subdued" style={{ fontSize: 13 }}>No production photo uploaded.</s-text>
                    )}
                  </s-stack>
                </s-stack>
              </s-box>
            </s-section>
          </s-stack>
        </s-grid>
      </s-stack>

      {/* Place Order On Hold Modal */}
      <s-modal
        id="hold-order-modal"
        heading="Place Order On Hold"
      >
        <s-stack direction="block" gap="base">
          <s-banner tone="warning">
            <s-paragraph>
              Placing this order on hold pauses the production process and stops automatic SLA clocks. Customer Service will be notified and the hold reason will be displayed to the customer in their portal.
            </s-paragraph>
          </s-banner>

          <s-text-field
            label="Hold on reason (Required)"
            details="The customer sees this reason on the order in their account."
            placeholder="State why this order is being placed on hold..."
            value={holdReasonInput}
            error={clientErrors.holdReason}
            onInput={(event) => {
              setHoldReasonInput(event.currentTarget.value);
              clearFieldError("holdReason");
            }}
          />

          <s-text-area
            label="Internal note (Optional)"
            placeholder="Optional internal note for team members..."
            value={note}
            onInput={(event) => setNote(event.currentTarget.value)}
          />
        </s-stack>

        <s-button
          slot="secondary-actions"
          commandFor="hold-order-modal"
          command="--hide"
          disabled={busy}
          onClick={closeHoldModal}
        >
          Cancel
        </s-button>

        <s-button
          slot="primary-action"
          tone="critical"
          variant="primary"
          disabled={busy}
          onClick={submitHoldOrder}
        >
          {busy ? "Placing on hold..." : "Confirm Put on Hold"}
        </s-button>
      </s-modal>

      {/* Approve Physical Sample Modal */}
      <s-modal
        id="physical-sample-approve-modal"
        heading="Approve on behalf of customer?"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Are you sure you want to approve this physical sample on behalf of the customer?
          </s-paragraph>
        </s-stack>

        <s-button
          slot="secondary-actions"
          commandFor="physical-sample-approve-modal"
          command="--hide"
          disabled={busy}
        >
          Cancel
        </s-button>

        <s-button
          slot="primary-action"
          variant="primary"
          disabled={busy}
          onClick={() => {
            const formData = new FormData();
            formData.set("intent", "admin_approve_physical_sample");
            submit(formData, { method: "post" });
            try {
              shopify.modal.hide("physical-sample-approve-modal");
            } catch (e) {
              document.getElementById("physical-sample-approve-modal")?.hide();
            }
          }}
        >
          {busy ? "Approving..." : "Approve physical sample"}
        </s-button>
      </s-modal>

    </s-page>
  );
}
