
// app/routes/webhooks.orders.create.jsx

import { authenticate } from "../shopify.server";

export async function action({ request }) {
  try {
    console.log(
      "Order created ---------------- Order created ----------------"
    );

    const {
      topic,
      shop,
      payload,
      admin,
      session,
    } = await authenticate.webhook(request);

    if (topic !== "ORDERS_CREATE") {
      console.warn(
        "Unexpected topic on /webhooks/orders/create:",
        topic
      );

      return new Response("Ignored", { status: 200 });
    }

    console.log(
      "Order created:",
      payload?.id,
      payload?.name,
      "from",
      shop
    );

    if (!session) {
      console.error(
        "No Shopify session available for shop:",
        shop
      );

      return new Response("Shop session unavailable", {
        status: 200,
      });
    }

    if (!admin) {
      console.error(
        "Shopify Admin API context is unavailable for shop:",
        shop
      );

      return new Response("Admin context unavailable", {
        status: 200,
      });
    }

    if (!payload?.id) {
      console.error("Webhook payload does not contain an order ID");

      return new Response("Missing order ID", {
        status: 200,
      });
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

    const variables = {
      id: payload.id,
      tags: ["my-custom-tag"],
    };

    console.log(
      "GraphQL variables:",
      JSON.stringify(variables)
    );

    console.log("GraphQL Call ----------------");

    const response = await admin.graphql(mutation, {
      variables,
    });

    const result = await response.json();

    console.log(
      "tagsAdd result:",
      JSON.stringify(result, null, 2)
    );

    const userErrors = result?.data?.tagsAdd?.userErrors || [];

    if (userErrors.length > 0) {
      console.error(
        "Error adding tag:",
        JSON.stringify(userErrors, null, 2)
      );

      return new Response("Tag update failed", {
        status: 200,
      });
    }

    console.log(
      "Successfully added tag to order:",
      payload.id
    );

    // Add your additional custom logic here.

    return new Response("OK", {
      status: 200,
    });
  } catch (error) {
    console.error(
      "Error processing ORDERS_CREATE webhook:"
    );

    console.error(error);

    return new Response("Webhook processing failed", {
      status: 500,
    });
  }
}

export function loader() {
  return new Response("Method Not Allowed", {
    status: 405,
  });
}

