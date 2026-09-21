// app/routes/webhooks.orders.create.jsx

import { authenticate } from "../shopify.server";

export async function action({ request }) {
  console.log("Order created--------------------");

  // Verify HMAC + parse webhook
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    console.warn("Unexpected topic on /webhooks/orders/create:", topic);
    return new Response("Ignored", { status: 200 });
  }

  console.log("Order created:", payload?.id, payload?.name, "from", shop);

  // --- Add tag to the order using Admin GraphQL ---
  const { admin } = await authenticate.admin(request);

  const mutation = `
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
    id: payload.id,               // e.g. "gid://shopify/Order/1234567890"
    tags: ["my-custom-tag"],      // change to whatever tag(s) you want
  };

  const response = await admin.graphql(mutation, { variables });
  const result = await response.json();
  console.log("tagsAdd result:", JSON.stringify(result, null, 2));

  if (result.data?.tagsAdd?.userErrors?.length) {
    console.error("Error adding tag:", result.data.tagsAdd.userErrors);
  }

  // Your additional custom logic here

  return new Response("OK", { status: 200 });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}