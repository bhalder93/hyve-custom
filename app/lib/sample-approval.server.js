import { createHmac, timingSafeEqual } from "node:crypto";
import { loadOrder } from "./order-action.server";
import { productionCalendar, productionDueDate, recordStatusHistory, SOURCES } from "./order-status.server";

const LINK_PATH = "/apps/account/sample-decision";

function linkSignature(orderId, version) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("SHOPIFY_API_SECRET is not set, so sample links can't be signed.");
  return createHmac("sha256", secret).update(`sample-decision|${orderId}|${version}`).digest("base64url");
}

export function readSampleLink(params) {
  const orderId = String(params.get("order") || "");
  const version = String(params.get("v") || "");
  const given = Buffer.from(String(params.get("sig") || ""));
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

  history.sort((a, b) => (b.sampleVersion || 0) - (a.sampleVersion || 0));
  const latestSample = history[0] || {};

  if (latestSample.status === "approved") {
    return { ok: false, error: `The physical sample for ${order.name} has already been approved.` };
  }
  // Only the latest sample, while it waits for an answer: an older email's
  // link, or one already answered, can't move the order again.
  if (latestSample.status !== "sent" || String(latestSample.sampleVersion) !== String(link.version)) {
    return { ok: false, error: `This link is for a physical sample of ${order.name} that has already been answered.` };
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
  const recipient = order.customer?.defaultEmailAddress?.emailAddress || order.email;
  const who = recipient ? `Sample email link (sent to ${recipient})` : "Sample email link";
  const now = new Date().toISOString();

  const status = decision === "approve" ? "approved" : "changes_requested";

  const newHistoryEntry = {
    sampleVersion: currentVersion,
    status,
    response: message || (decision === "approve" ? "Approved via secure email link" : ""),
    responseDate: now,
    approvedBy: who,
    approvalSource: "email_link",
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

  // Update tags
  const currentStatusTags = (order.tags || []).filter(
    (t) => t.startsWith("hyve-status:") || t === "hyve-status:on-hold" || t === "hyve-status:sample-review",
  );

  if (currentStatusTags.length) {
    try {
      await admin.graphql(
        `#graphql mutation RemoveTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
        { variables: { id: orderGid, tags: currentStatusTags } },
      );
    } catch (tagErr) {
      console.error("[sample-link] failed to remove tags", tagErr);
    }
  }

  const tagsToAdd = [`hyve-status:${nextStatus}`];
  if (decision === "approve") {
    tagsToAdd.push("hyve-sample-approved");
  }

  try {
    await admin.graphql(
      `#graphql mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { variables: { id: orderGid, tags: tagsToAdd } },
    );
  } catch (addTagErr) {
    console.error("[sample-link] failed to add tags", addTagErr);
  }

  // Record audit history
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
    ipAddress,
    userAgent,
  });

  return { ok: true, orderName: order.name, decision };
}
