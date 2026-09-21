// app/routes/webhooks.orders.create.jsx

import { authenticate, unauthenticated } from "../shopify.server";

export async function action({ request }) {
  try {
    console.log("Order created ---------------- Order created ----------------");

    // 1. Verify webhook + parse payload
    const { topic, shop, payload } = await authenticate.webhook(request);

    if (topic !== "ORDERS_CREATE") {
      console.warn("Unexpected topic on /webhooks/orders/create:", topic);
      return new Response("Ignored", { status: 200 });
    }

    console.log(
      "Order created:",
      payload?.id,
      payload?.name,
      "from",
      shop,
    );

    if (!payload?.id && !payload?.admin_graphql_api_id) {
      console.error("Webhook payload does not contain an order ID");
      return new Response("Missing order ID", { status: 200 });
    }

    // 2. Create offline Admin API client for this shop
    let admin;
    try {
      const context = await unauthenticated.admin(shop);
      admin = context.admin;
    } catch (error) {
      console.error(
        "Could not create Admin API client for shop:",
        shop,
        error,
      );
      // Return 200 to avoid retry storms
      return new Response("Admin context unavailable", { status: 200 });
    }

    console.log("GraphQL Start ----------------");

    const mutation = `#graphql
      mutation AddTagToOrder($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    // Use the GraphQL GID if present, fall back to REST numeric ID wrapped as a GID
    const orderIdGid =
      payload.admin_graphql_api_id ||
      `gid://shopify/Order/${payload.id}`;

    const variables = {
      id: orderIdGid,
      tags: ["my-custom-tag"],
    };

    console.log("GraphQL variables:", JSON.stringify(variables));

    console.log("GraphQL Call ----------------");

    const response = await admin.graphql(mutation, { variables });
    const result = await response.json();

    console.log("tagsAdd result:", JSON.stringify(result, null, 2));

    if (result?.errors?.length) {
      console.error("Top-level GraphQL errors:", result.errors);
      return new Response("Tag update failed", { status: 200 });
    }

    const userErrors = result?.data?.tagsAdd?.userErrors || [];

    if (userErrors.length > 0) {
      console.error("Error adding tag:", JSON.stringify(userErrors, null, 2));
      return new Response("Tag update failed", { status: 200 });
    }

    console.log("Successfully added tag to order:", orderIdGid);

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Error processing ORDERS_CREATE webhook:", error);
    // To avoid retry storms, you may still want 200 here; keep 500 only while debugging
    return new Response("Webhook processing failed", { status: 500 });
  }
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}