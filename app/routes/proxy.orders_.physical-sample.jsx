import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { loadOrderForAction } from "../lib/order-action.server";
import { productionCalendar, productionDueDate } from "../lib/order-status.server";
import { awaitingSampleDecision } from "../lib/sample-approval.server";
import { syncSampleStatusTags } from "../lib/sample-status-tags.server";

async function parseGraphQL(response, operationName = "GraphQL") {
  const data = await response.json();
  if (data.errors?.length) {
    console.error(`${operationName} GraphQL errors:`, data.errors);
    throw new Error(data.errors.map((error) => error.message).join(", "));
  }
  return data;
}

function throwUserErrors(errors, operationName = "Shopify operation") {
  if (!errors?.length) return;
  console.error(`${operationName} user errors:`, errors);
  throw new Error(errors.map((error) => error.message).join(", "));
}
export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return backToOrders({ error: "Please sign in to approve a Physical Sample." });

    const form = await request.formData();
    const orderGid = String(form.get("order") || "");
    const decision = String(form.get("decision") || "");
    const message = String(form.get("message") || "").trim().slice(0, 900);

    if (!orderGid.startsWith("gid://shopify/Order/")) {
      return backToOrders({ error: "We couldn't work out which order that was." });
    }
    if (decision !== "approve" && decision !== "changes") {
      return backToOrders({ error: "That isn't a decision we can record." });
    }
    if (decision === "changes" && !message) {
      return backToOrders({ error: "Tell us what needs changing so we can prepare the next physical sample." });
    }

    const chrome = await portalChrome(admin, customerId);

    // Only the buyer's own order, or their company's (HYV-114).
    const owned = await loadOrderForAction(admin, orderGid, {
      customerGid: `gid://shopify/Customer/${customerId}`,
      locationGids: chrome.terms?.locationIds || [],
    });
    if (!owned.ok) return backToOrders({ error: owned.error });

    // Fetch the current order state
    const orderResponse = await admin.graphql(
      `#graphql
        query OrderPhysicalSample($id: ID!) {
          order(id: $id) {
            name
            tags
            productionStatus: metafield(namespace: "$app", key: "production_status") { value }
            onHoldReason: metafield(namespace: "$app", key: "on_hold_reason") { value }
            rush: metafield(namespace: "$app", key: "rush") { value }
            physicalSampleHistory: metafield(namespace: "$app", key: "physical_sample_history") { value }
          }
        }
      `,
      { variables: { id: orderGid } }
    );
    const orderData = await orderResponse.json();
    const order = orderData.data?.order;

    if (!order) {
      return backToOrders({ error: "Order not found." });
    }

    let currentHistory = [];
    try {
      if (order.physicalSampleHistory?.value) {
        currentHistory = JSON.parse(order.physicalSampleHistory.value) || [];
      }
    } catch (e) {
      // ignore
    }

    // Only a sample that's been sent and not yet decided, read as the order
    // window reads it: a resubmitted form can't move a later order back.
    const latest = [...currentHistory].sort((a, b) => (b.sampleVersion || 0) - (a.sampleVersion || 0))[0];
    if (latest?.status !== "sent") {
      return backToOrders({ error: "This physical sample has already been answered." });
    }
    // Staff may have put the order On Hold or moved it on since the sample went.
    if (!awaitingSampleDecision(order.productionStatus?.value || "", order.onHoldReason?.value)) {
      return backToOrders({ error: "This order isn't waiting for a sample decision." });
    }

    const currentVersion = currentHistory.reduce((max, entry) => Math.max(max, entry.sampleVersion || 0), 0);
    const status = decision === "approve" ? "approved" : "changes_requested";
    const responseDate = new Date().toISOString();
    const respondedBy = chrome.customer?.name || chrome.customer?.email || "The buyer";

    const ipAddress = (
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("true-client-ip") ||
      request.headers.get("x-shopify-client-ip") ||
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      ""
    ).split(",")[0].trim().slice(0, 255);
    const userAgent = (
      String(form.get("client_user_agent") || "").trim() ||
      request.headers.get("user-agent") ||
      ""
    ).trim().slice(0, 255);

    const newHistoryEntry = {
      sampleVersion: currentVersion,
      status,
      response: message,
      responseDate,
      approvedBy: respondedBy,
      approvalSource: "customer_portal",
      ...(ipAddress ? { ipAddress } : {}),
      ...(userAgent ? { userAgent } : {}),
    };

    currentHistory.unshift(newHistoryEntry);

    // 1. Update the order metafield
    const metafields = [
      {
        ownerId: orderGid,
        namespace: "$app",
        key: "physical_sample_history",
        type: "json",
        value: JSON.stringify(currentHistory),
      }
    ];

    if (decision === "approve") {
      const inProdAt = new Date().toISOString();
      metafields.push(
        { ownerId: orderGid, namespace: "$app", key: "production_status", type: "single_line_text_field", value: "in-production" },
        { ownerId: orderGid, namespace: "$app", key: "status_changed_at", type: "date_time", value: inProdAt }
      );

      try {
        const calendar = await productionCalendar(admin);
        const productionDueAt = productionDueDate(calendar, inProdAt, order.rush?.value === "true");
        if (productionDueAt) {
          metafields.push({
            ownerId: orderGid,
            namespace: "$app",
            key: "production_due_at",
            type: "date_time",
            value: productionDueAt,
          });
        }
      } catch (err) {
        console.error("Failed to calculate production due date on sample approval:", err);
      }

      let fileUrl = "";
      if (order.physicalSampleHistory?.value) {
        try {
          const hist = JSON.parse(order.physicalSampleHistory.value);
          if (hist && hist.length > 0) fileUrl = hist[0].fileUrl || "";
        } catch {
          // ignore
        }
      }

      // Add a history item for the transition
      const historyFields = [
        { key: "order_id", value: orderGid },
        { key: "order_name", value: order.name },
        { key: "from_status", value: order.productionStatus?.value || "sample-review" },
        { key: "to_status", value: "in-production" },
        { key: "changed_at", value: inProdAt },
        { key: "changed_by", value: respondedBy },
        { key: "source", value: "CUSTOMER_PORTAL" },
        { key: "note", value: `Physical Sample Approved${fileUrl ? `\nIMAGE: ${fileUrl}` : ""}` },
        ...(ipAddress ? [{ key: "ip_address", value: ipAddress }] : []),
        ...(userAgent ? [{ key: "user_agent", value: userAgent }] : [])
      ];

      try {
        const histRes = await admin.graphql(
          `#graphql
            mutation CreateHistory($metaobject: MetaobjectCreateInput!) {
              metaobjectCreate(metaobject: $metaobject) { userErrors { message } }
            }
          `,
          { variables: { metaobject: { type: "$app:order_status_history", fields: historyFields } } }
        );
        const histData = await histRes.json();
        if (histData?.data?.metaobjectCreate?.userErrors?.length) {
          console.error("CreateHistory Error:", histData.data.metaobjectCreate.userErrors);
        }
      } catch (e) {
        console.error("CreateHistory Error:", e, e.graphQLErrors);
      }

      // Clear on_hold_reason metafield
      try {
        await admin.graphql(
          `#graphql
            mutation ClearOnHoldReason($metafields: [MetafieldIdentifierInput!]!) {
              metafieldsDelete(metafields: $metafields) { userErrors { message } }
            }
          `,
          { variables: { metafields: [{ ownerId: orderGid, namespace: "$app", key: "on_hold_reason" }] } }
        );
      } catch (e) {
        console.error("ClearOnHoldReason Error:", e);
      }

      await syncSampleStatusTags(admin, orderGid, order.tags, "in-production", ["hyve-sample-approved", "in-production"]);
    } else {
      const heldAt = new Date().toISOString();
      metafields.push(
        { ownerId: orderGid, namespace: "$app", key: "production_status", type: "single_line_text_field", value: "sample-preparation" },
        { ownerId: orderGid, namespace: "$app", key: "status_changed_at", type: "date_time", value: heldAt },
      );

      // Clear on_hold_reason
      try {
        await admin.graphql(
          `#graphql
            mutation ClearOnHoldReason($metafields: [MetafieldIdentifierInput!]!) {
              metafieldsDelete(metafields: $metafields) { userErrors { message } }
            }
          `,
          { variables: { metafields: [{ ownerId: orderGid, namespace: "$app", key: "on_hold_reason" }] } }
        );
      } catch (e) {
        console.error("ClearOnHoldReason Error:", e);
      }

      // Add a history item for the transition
      const historyFields = [
        { key: "order_id", value: orderGid },
        { key: "order_name", value: order.name },
        { key: "from_status", value: order.productionStatus?.value || "sample-review" },
        { key: "to_status", value: "sample-preparation" },
        { key: "changed_at", value: heldAt },
        { key: "changed_by", value: respondedBy },
        { key: "source", value: "CUSTOMER_PORTAL" },
        { key: "note", value: `Changes requested to Physical Sample: ${message}` },
        ...(ipAddress ? [{ key: "ip_address", value: ipAddress }] : []),
        ...(userAgent ? [{ key: "user_agent", value: userAgent }] : [])
      ];

      try {
        const histRes = await admin.graphql(
          `#graphql
            mutation CreateHistory($metaobject: MetaobjectCreateInput!) {
              metaobjectCreate(metaobject: $metaobject) { userErrors { message } }
            }
          `,
          { variables: { metaobject: { type: "$app:order_status_history", fields: historyFields } } }
        );
        const histData = await histRes.json();
        if (histData?.data?.metaobjectCreate?.userErrors?.length) {
          console.error("CreateHistory Error:", histData.data.metaobjectCreate.userErrors);
        }
      } catch (e) {
        console.error("CreateHistory Error:", e, e.graphQLErrors);
      }

      await syncSampleStatusTags(admin, orderGid, order.tags, "sample-preparation");
    }

    try {
      const updateResponse = await admin.graphql(
        `#graphql
            mutation UpdatePhysicalSampleHistory($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors { field message code }
              }
            }
          `,
        { variables: { metafields } }
      );
      const updateData = await parseGraphQL(updateResponse, "UpdatePhysicalSampleHistory");
      throwUserErrors(updateData.data?.metafieldsSet?.userErrors, "UpdatePhysicalSampleHistory");
    } catch (e) {
      console.error("UpdatePhysicalSampleHistory Error:", e, e.graphQLErrors);
      throw e; // rethrow so it fails properly
    }

    return backToOrders({
      notice:
        decision === "approve"
          ? `Thank you — Physical Sample approved for ${order.name}. We'll start production.`
          : `Thanks — we've passed your change request for ${order.name} to the team. We'll prepare the next physical sample.`,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] physical sample decision failed", error);
    return backToOrders({ error: "We couldn't record that decision. Please try again later." });
  }
};

function backToOrders({ notice, error }) {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice);
  if (error) params.set("error", error);

  return new Response(null, {
    status: 303,
    headers: { Location: `/apps/account/orders?${params.toString()}` },
  });
}
