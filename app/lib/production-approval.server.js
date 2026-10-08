import { recordStatusHistory, SOURCES } from "./order-status.server";
import { loadOrderForAction } from "./order-action.server";

export async function recordProductionDecision(admin, orderGid, decision, by = {}) {
  const found = await loadOrderForAction(admin, orderGid, by);
  if (!found.ok) return found;
  
  return decide(admin, found.order, decision, by);
}

async function decide(admin, order, decision, by = {}) {
  const message = cleanMessage(by.message);
  
  if (decision !== "approve" && decision !== "changes") {
    return { ok: false, error: "That isn't a decision we can record." };
  }
  if (decision === "changes" && !message) {
    return { ok: false, error: "Tell us what needs changing." };
  }

  const currentStatus = order.productionStatus?.value || "";

  if (currentStatus !== "production-complete" && currentStatus !== "production-completed") {
    return { ok: false, error: "A production photo decision can only be made when the order is Production Complete." };
  }

  const at = new Date().toISOString();
  const metafields = [
    {
      ownerId: order.id,
      namespace: "$app",
      key: "production_approval_status",
      type: "single_line_text_field",
      value: decision === "approve" ? "approved" : "declined",
    },
  ];

  if (decision === "approve") {
    metafields.push({
      ownerId: order.id,
      namespace: "$app",
      key: "production_approval_at",
      type: "date_time",
      value: at,
    });
  } else {
    metafields.push({
      ownerId: order.id,
      namespace: "$app",
      key: "production_approval_note",
      type: "multi_line_text_field",
      value: message,
    });
  }

  const response = await admin.graphql(
    `#graphql
      mutation SetProductionApprovalDecision(
        $metafields: [MetafieldsSetInput!]!
      ) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
    { variables: { metafields } }
  );

  const body = await response.json();
  const error = body?.data?.metafieldsSet?.userErrors?.[0]?.message;
  if (error) return { ok: false, error };

  if (decision === "changes") {
    const { changeProductionStatus } = await import("./order-status.server.js");
    const moved = await changeProductionStatus(admin, order, {
      to: "on-hold",
      changedBy: by.who || "The buyer",
      source: SOURCES.portal,
      ipAddress: by.ipAddress,
      userAgent: by.userAgent,
      note: `Production photo declined by customer: ${message}`,
      onHoldReason: `Changes requested to Production Photo: ${message}`,
    });
    if (!moved.ok) return moved;
  } else {
    const note = "Production photo approved by customer. Order may proceed to shipping.";

    await recordStatusHistory(admin, {
      order,
      from: currentStatus,
      to: currentStatus,
      changedAt: at,
      changedBy: by.who || "The buyer",
      source: SOURCES.portal,
      note,
      ipAddress: by.ipAddress,
      userAgent: by.userAgent,
    });
  }

  return { ok: true, orderName: order.name };
}

export async function recordEmailProductionDecision(admin, link, decision, rawMessage, ipAddress = "", userAgent = "") {
  const message = cleanMessage(rawMessage);
  
  if (decision !== "approve" && decision !== "changes") {
    return { ok: false, error: "That isn't a decision we can record." };
  }
  if (decision === "changes" && !message) {
    return { ok: false, error: "Tell us what needs changing." };
  }

  const found = await loadProductionPhotoFromLink(admin, link);
  if (!found.ok) return found;

  const order = found.order;
  const recipient = order.customer?.defaultEmailAddress?.emailAddress || order.email;
  const who = recipient ? `Production photo email link (sent to ${recipient})` : "Production photo email link";

  return decide(admin, order, decision, {
    who,
    message,
    ipAddress,
    userAgent,
  });
}

export async function loadProductionPhotoFromLink(admin, link) {
  const { loadOrder } = await import("./order-action.server.js");
  const order = await loadOrder(admin, link.orderGid);
  if (!order) return { ok: false, error: "We couldn't find that order." };

  const currentStatus = order.productionStatus?.value || "";
  if (currentStatus !== "production-complete" && currentStatus !== "production-completed") {
    return { ok: false, error: `There's no Production Photo waiting for a decision on ${order.name}.` };
  }
  if (String(order.productionPhotoVersion?.value || "1") !== link.version) {
    return { ok: false, error: `This link is for an earlier Production Photo of ${order.name}. Please use the links in the latest email.` };
  }
  return { ok: true, order };
}

import { createHmac, timingSafeEqual } from "node:crypto";

export function readProductionLink(params) {
  const orderId = String(params.get("order") || "");
  const version = String(params.get("v") || "");
  const given = Buffer.from(String(params.get("sig") || ""));
  if (!/^\d+$/.test(orderId) || !/^\d+$/.test(version)) return null;

  const expected = Buffer.from(linkSignature(orderId, version));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  return { orderGid: `gid://shopify/Order/${orderId}`, version };
}

export async function productionDecisionLinks(admin, orderGid, version) {
  const response = await admin.graphql(`
    query ProofLinkDomain {
      shop { primaryDomain { url } }
    }
  `);
  const body = await response.json();
  const shop = body.data.shop;

  const orderId = String(orderGid).split("/").pop();
  const link = (decision) => {
    const url = new URL("/apps/account/production-decision", shop.primaryDomain.url);
    url.searchParams.set("order", orderId);
    url.searchParams.set("v", String(version));
    url.searchParams.set("sig", linkSignature(orderId, String(version)));
    url.searchParams.set("decision", decision);
    return url.toString();
  };

  return { approveUrl: link("approve"), changesUrl: link("changes") };
}

function linkSignature(orderId, version) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("SHOPIFY_API_SECRET is not set, so links can't be signed.");
  return createHmac("sha256", secret).update(`production-decision|${orderId}|${version}`).digest("base64url");
}

function cleanMessage(message) {
  return String(message || "").trim().slice(0, 900);
}
