// app/routes/webhooks.orders.create.jsx
import { authenticate, unauthenticated } from "../shopify.server";

export async function action({ request }) {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    if (topic !== "ORDERS_CREATE") {
      return new Response("Ignored", { status: 200 });
    }

    console.log("ORDERS_CREATE from", shop, "order", payload?.id, payload?.name);

    // 1. Get an Admin client (offline) for this shop
    let admin;
    try {
      const context = await unauthenticated.admin(shop);
      admin = context.admin;
    } catch (err) {
      console.error("[ORDERS_CREATE] Could not create Admin client", {
        shop,
        err,
      });
      return new Response("Admin context unavailable", { status: 200 });
    }

    const orderGid =
      payload.admin_graphql_api_id ||
      `gid://shopify/Order/${payload.id}`;

    const metafields = [
      {
        ownerId: orderGid,
        namespace: "hyve",
        key: "production_status",
        type: "single_line_text_field", // must match existing definition
        value: "Order Placed",
      },
    ];

    const METAFIELDS_SET_MUTATION = `#graphql
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
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
    `;

    // 2. Try/catch around metafieldsSet
    try {
      const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
        variables: { metafields },
      });
      const result = await response.json();

      if (result?.errors?.length) {
        console.error("[ORDERS_CREATE] metafieldsSet top-level errors", result.errors);
      }

      const userErrors = result?.data?.metafieldsSet?.userErrors ?? [];
      if (userErrors.length) {
        console.error("[ORDERS_CREATE] metafieldsSet userErrors", userErrors);
      } else {
        console.log("[ORDERS_CREATE] metafields updated for", orderGid);
      }
    } catch (err) {
      console.error("[ORDERS_CREATE] metafieldsSet call failed", {
        shop,
        orderGid,
        err,
      });
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("[ORDERS_CREATE] webhook processing failed", error);
    // Usually still return 200 to avoid retry storms
    return new Response("OK", { status: 200 });
  }
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}