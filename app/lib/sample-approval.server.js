import { createHmac, timingSafeEqual } from "node:crypto";
import { loadOrder } from "./order-action.server";
import { productionCalendar, productionDueDate, recordStatusHistory, SOURCES } from "./order-status.server";
import { syncSampleStatusTags } from "./sample-status-tags.server";

const LINK_PATH = "/apps/account/sample-decision";

function linkSignature(orderId, version) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("SHOPIFY_API_SECRET is not set, so sample links can't be signed.");
  return createHmac("sha256", secret).update(`sample-decision|${orderId}|${version}`).digest("base64url");
}

export function readSampleLink(params, form = null) {
  const orderId = String((form && form.get("order")) || (params && params.get("order")) || "");
  const version = String((form && form.get("v")) || (params && params.get("v")) || "");
  const sig = String((form && form.get("sig")) || (params && params.get("sig")) || "");
  const given = Buffer.from(sig);
  if (!/^\d+$/.test(orderId) || !/^\d+$/.test(version)) return null;

  const expected = Buffer.from(linkSignature(orderId, version));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  return { orderGid: `gid://shopify/Order/${orderId}`, version };
}

export async function sampleDecisionLinks(admin, orderGid, version) {
  const response = await admin.graphql(`
    query SampleLinkDomain {
      shop { primaryDomain { url } }
    }
  `);
  const body = await response.json();
  const shop = body?.data?.shop;

  const orderId = String(orderGid).split("/").pop();
  const link = (decision) => {
    const url = new URL(LINK_PATH, shop.primaryDomain.url);
    url.searchParams.set("order", orderId);
    url.searchParams.set("v", String(version));
    url.searchParams.set("sig", linkSignature(orderId, String(version)));
    if (decision) url.searchParams.set("decision", decision);
    return url.toString();
  };

  return {
    approveUrl: link("approve"),
    changesUrl: link("changes"),
    reviewUrl: link(""),
  };
}

/**
 * True while the order waits for the buyer's answer on a sent sample: Sample
 * Review, or an order from the old flow, which left a sent sample at Proof
 * Approved or put it On Hold ("Waiting for physical sample approval"). Staff
 * putting the order On Hold for another reason, or moving it on, ends the
 * wait. The caller checks the latest sample is the one sent.
 */
export function awaitingSampleDecision(productionStatus, onHoldReason = "", latestSampleStatus = "") {
  if (latestSampleStatus === "sent") return true;
  if (productionStatus === "sample-review" || productionStatus === "proof-approved" || productionStatus === "sample-preparation") return true;
  const reason = String(onHoldReason || "").trim().toLowerCase();
  return (
    productionStatus === "on-hold" &&
    (reason.startsWith("physical sample") || reason === "waiting for physical sample approval" || reason.includes("sample"))
  );
}

async function onHoldReasonOf(admin, orderGid) {
  const response = await admin.graphql(
    `#graphql
      query SampleOrderHoldReason($id: ID!) {
        order(id: $id) {
          onHoldReason: metafield(namespace: "$app", key: "on_hold_reason") { value }
        }
      }
    `,
    { variables: { id: orderGid } },
  );
  const body = await response.json();
  return body?.data?.order?.onHoldReason?.value || "";
}

export async function loadSampleFromLink(admin, link) {
  const order = await loadOrder(admin, link.orderGid);
  if (!order) return { ok: false, error: "We couldn't find that order." };

  let history = [];
  try {
    if (order.physicalSampleHistory?.value) {
      history = JSON.parse(order.physicalSampleHistory.value) || [];
    }
  } catch (e) {
    // ignore
  }

  history.sort((a, b) => (Number(b.sampleVersion) || 0) - (Number(a.sampleVersion) || 0));
  const latestSample = history[0] || {};

  if (latestSample.status === "approved") {
    return {
      ok: false,
      alreadyDecided: true,
      decision: "approve",
      order,
      sample: latestSample,
      error: `The physical sample for ${order.name} has already been approved.`,
    };
  }
  if (latestSample.status === "changes_requested") {
    return {
      ok: false,
      alreadyDecided: true,
      decision: "changes",
      order,
      sample: latestSample,
      error: `Change request for ${order.name} (version ${latestSample.sampleVersion}) has already been received.`,
    };
  }
  // Only the latest sample, while it waits for an answer: an older email's
  // link, or one already answered, can't move the order again.
  if (latestSample.status !== "sent" || String(latestSample.sampleVersion) !== String(link.version)) {
    return {
      ok: false,
      alreadyDecided: true,
      decision: latestSample.status === "approved" ? "approve" : "changes",
      order,
      sample: latestSample,
      error: `This link is for a physical sample of ${order.name} that has already been answered.`,
    };
  }

  const productionStatus = order.productionStatus?.value || (order.tags || []).find((t) => t.startsWith("hyve-status:"))?.replace("hyve-status:", "") || "";
  const onHoldReason = productionStatus === "on-hold" ? await onHoldReasonOf(admin, order.id) : "";
  if (!awaitingSampleDecision(productionStatus, onHoldReason, latestSample.status)) {
    return { ok: false, error: `${order.name} isn't waiting for a physical sample decision.` };
  }

  return { ok: true, order, sample: latestSample, history };
}

function cleanMessage(message) {
  return String(message || "").trim().slice(0, 900);
}

export async function recordEmailSampleDecision(admin, link, decision, rawMessage, ipAddress = "", userAgent = "") {
  const message = cleanMessage(rawMessage);

  if (decision !== "approve" && decision !== "changes") {
    return { ok: false, error: "That isn't a decision we can record." };
  }
  if (decision === "changes" && !message) {
    return { ok: false, error: "Tell us what needs changing so we can prepare the next physical sample." };
  }

  const found = await loadSampleFromLink(admin, link);
  if (!found.ok) return found;

  const { order, history } = found;
  const currentVersion = Number(link.version);
  const customerName =
    order.customer?.displayName ||
    order.shippingAddress?.name ||
    "";
  const customerEmail = order.customer?.defaultEmailAddress?.emailAddress || order.email || "";
  const who = customerName
    ? `${customerName}${customerEmail ? ` (${customerEmail})` : ""}`
    : (customerEmail ? `Customer (${customerEmail})` : "Customer");
  const now = new Date().toISOString();

  const status = decision === "approve" ? "approved" : "changes_requested";

  const newHistoryEntry = {
    sampleVersion: currentVersion,
    status,
    response: message || (decision === "approve" ? "Approved via secure email link" : ""),
    responseDate: now,
    approvedBy: who,
    approvalSource: "email_link",
    ...(ipAddress ? { ipAddress: String(ipAddress).trim().slice(0, 255) } : {}),
    ...(userAgent ? { userAgent: String(userAgent).trim().slice(0, 255) } : {}),
  };

  // Find existing version or unshift
  const updatedHistory = [...history];
  const existingIndex = updatedHistory.findIndex((h) => Number(h.sampleVersion) === currentVersion);
  if (existingIndex >= 0) {
    updatedHistory[existingIndex] = {
      ...updatedHistory[existingIndex],
      ...newHistoryEntry,
    };
  } else {
    updatedHistory.unshift(newHistoryEntry);
  }

  const orderGid = order.id;
  const nextStatus = decision === "approve" ? "in-production" : "sample-preparation";

  const metafields = [
    {
      ownerId: orderGid,
      namespace: "$app",
      key: "physical_sample_history",
      type: "json",
      value: JSON.stringify(updatedHistory),
    },
    {
      ownerId: orderGid,
      namespace: "$app",
      key: "production_status",
      type: "single_line_text_field",
      value: nextStatus,
    },
    {
      ownerId: orderGid,
      namespace: "$app",
      key: "status_changed_at",
      type: "date_time",
      value: now,
    },
  ];

  if (decision === "approve") {
    try {
      const calendar = await productionCalendar(admin);
      const productionDueAt = productionDueDate(calendar, now, order.rush?.value === "true");
      if (productionDueAt) {
        metafields.push({
          ownerId: orderGid,
          namespace: "$app",
          key: "production_due_at",
          type: "date_time",
          value: productionDueAt,
        });
      }
    } catch (e) {
      console.error("Could not calculate production due date on sample approval:", e);
    }
  }

  const updateResponse = await admin.graphql(
    `#graphql
      mutation UpdateSampleDecision($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
    { variables: { metafields } },
  );

  const updateBody = await updateResponse.json();
  const error = updateBody?.data?.metafieldsSet?.userErrors?.[0]?.message;
  if (error) return { ok: false, error };

  // Clear on_hold_reason
  try {
    await admin.graphql(
      `#graphql
        mutation ClearOnHoldReason($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          metafields: [{ ownerId: orderGid, namespace: "$app", key: "on_hold_reason" }],
        },
      },
    );
  } catch (delErr) {
    console.error("[sample-link] failed to clear on_hold_reason", delErr);
  }

  try {
    await syncSampleStatusTags(
      admin,
      orderGid,
      order.tags,
      nextStatus,
      decision === "approve" ? ["hyve-sample-approved", "in-production"] : [],
    );
  } catch (tagErr) {
    console.error("[sample-link] failed to sync sample status tags:", tagErr);
  }

  // Record audit history safely
  try {
    const note = decision === "approve"
      ? `Physical Sample v${currentVersion} Approved via email link`
      : `Changes requested to Physical Sample v${currentVersion}: ${message}`;

    await recordStatusHistory(admin, {
      order,
      from: order.productionStatus?.value || "sample-review",
      to: nextStatus,
      changedAt: now,
      changedBy: who,
      source: SOURCES.proofEmail,
      note,
      ipAddress: String(ipAddress || "").trim().slice(0, 255),
      userAgent: String(userAgent || "").trim().slice(0, 255),
    });
  } catch (histErr) {
    console.error("[sample-link] failed to record status history:", histErr);
  }

  return { ok: true, orderName: order.name, decision };
}
