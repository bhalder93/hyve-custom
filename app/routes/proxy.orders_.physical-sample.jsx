import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";

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
    const message = String(form.get("message") || "");

    if (!orderGid.startsWith("gid://shopify/Order/")) {
      return backToOrders({ error: "We couldn't work out which order that was." });
    }

    const chrome = await portalChrome(admin, customerId);

    // Fetch the current order state
    const orderResponse = await admin.graphql(
      `#graphql
        query OrderPhysicalSample($id: ID!) {
          order(id: $id) {
            name
            tags
            productionStatus: metafield(namespace: "$app", key: "production_status") { value }
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

    const currentVersion = currentHistory.reduce((max, entry) => Math.max(max, entry.sampleVersion || 0), 0);
    const status = decision === "approve" ? "approved" : "changes_requested";
    const responseDate = new Date().toISOString();
    const respondedBy = chrome.customer?.name || chrome.customer?.email || "The buyer";

    const newHistoryEntry = {
      sampleVersion: currentVersion,
      status,
      response: message,
      responseDate,
      approvedBy: respondedBy,
      approvalSource: "customer_portal",
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

      const ipAddress = (request.headers.get("true-client-ip") || request.headers.get("x-shopify-client-ip") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "").split(",")[0].trim();
      const userAgent = String(form.get("client_user_agent") || "").trim() || request.headers.get("user-agent") || "";

      // Add a history item for the transition
      const historyFields = [
        { key: "order_id", value: orderGid },
        { key: "order_name", value: order.name },
        { key: "from_status", value: order.productionStatus?.value || "on-hold" },
        { key: "to_status", value: "in-production" },
        { key: "changed_at", value: inProdAt },
        { key: "changed_by", value: "System" },
        { key: "source", value: "CUSTOMER_PORTAL" },
        { key: "note", value: "Automatically moved to In Production after Physical Sample Approved." },
        ...(ipAddress ? [{ key: "ip_address", value: ipAddress }] : []),
        ...(userAgent ? [{ key: "user_agent", value: userAgent }] : [])
      ];

      try {
        await admin.graphql(
          `#graphql
            mutation CreateHistory($metaobject: MetaobjectCreateInput!) {
              metaobjectCreate(metaobject: $metaobject) { userErrors { message } }
            }
          `,
          { variables: { metaobject: { type: "$app:order_status_history", fields: historyFields } } }
        );
      } catch (e) {
        console.error("CreateHistory Error:", e, e.graphQLErrors);
      }

      // Update tags
      const currentStatusTags = (order.tags || []).filter(t => t.startsWith("hyve-status:"));
      if (currentStatusTags.length) {
        try {
          await admin.graphql(
            `#graphql mutation RemoveTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
            { variables: { id: orderGid, tags: currentStatusTags } }
          );
        } catch (e) {
          console.error("RemoveTags Error:", e, e.graphQLErrors);
        }
      }
      try {
        await admin.graphql(
          `#graphql mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { variables: { id: orderGid, tags: ["hyve-status:in-production", "hyve-sample-approved"] } }
        );
      } catch (e) {
        console.error("AddTags Error:", e, e.graphQLErrors);
      }
    } else {
      const heldAt = new Date().toISOString();
      metafields.push(
        { ownerId: orderGid, namespace: "$app", key: "production_status", type: "single_line_text_field", value: "on-hold" },
        { ownerId: orderGid, namespace: "$app", key: "status_changed_at", type: "date_time", value: heldAt },
        { ownerId: orderGid, namespace: "$app", key: "on_hold_reason", type: "single_line_text_field", value: `Changes requested to Physical Sample: ${message}` }
      );

      const ipAddress = (request.headers.get("true-client-ip") || request.headers.get("x-shopify-client-ip") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "").split(",")[0].trim();
      const userAgent = String(form.get("client_user_agent") || "").trim() || request.headers.get("user-agent") || "";

      // Add a history item for the transition
      const historyFields = [
        { key: "order_id", value: orderGid },
        { key: "order_name", value: order.name },
        { key: "from_status", value: order.productionStatus?.value || "" },
        { key: "to_status", value: "on-hold" },
        { key: "changed_at", value: heldAt },
        { key: "changed_by", value: "System" },
        { key: "source", value: "CUSTOMER_PORTAL" },
        { key: "note", value: `Changes requested to Physical Sample: ${message}` },
        ...(ipAddress ? [{ key: "ip_address", value: ipAddress }] : []),
        ...(userAgent ? [{ key: "user_agent", value: userAgent }] : [])
      ];

      try {
        await admin.graphql(
          `#graphql
            mutation CreateHistory($metaobject: MetaobjectCreateInput!) {
              metaobjectCreate(metaobject: $metaobject) { userErrors { message } }
            }
          `,
          { variables: { metaobject: { type: "$app:order_status_history", fields: historyFields } } }
        );
      } catch (e) {
        console.error("CreateHistory Error:", e, e.graphQLErrors);
      }

      // Update tags
      const currentStatusTags = (order.tags || []).filter(t => t.startsWith("hyve-status:"));
      if (currentStatusTags.length) {
        try {
          await admin.graphql(
            `#graphql mutation RemoveTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
            { variables: { id: orderGid, tags: currentStatusTags } }
          );
        } catch (e) {
          console.error("RemoveTags Error:", e, e.graphQLErrors);
        }
      }
      try {
        await admin.graphql(
          `#graphql mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { variables: { id: orderGid, tags: ["hyve-status:on-hold"] } }
        );
      } catch (e) {
        console.error("AddTags Error:", e, e.graphQLErrors);
      }
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
          : `Thanks — we've passed your change request for ${order.name} to the team.`,
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
