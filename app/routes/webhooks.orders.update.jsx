// app/routes/webhooks.orders.update.jsx
import { authenticate } from "../shopify.server";

export async function action({ request }) {
  // Use the authenticate helper – this handles HMAC verification + parsing
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log("Order Updated webhook received", {
    topic,
    shop,
    payloadId: payload?.id,
    payloadName: payload?.name,
  });

  // Topic from Shopify for orders/update is "ORDERS_UPDATED"
  if (topic !== "ORDERS_UPDATED") {
    console.warn("Unexpected topic on /webhooks/orders/update:", topic);
    return new Response("Ignored", { status: 200 });
  }

  console.log(
    "[ORDERS_UPDATED] Order updated:",
    payload?.id,
    payload?.name,
    "from",
    shop,
  );

  // TODO: your custom logic here
  // e.g. call initializeHyveOrder(admin, payload, shop) if you reuse that

  return new Response("OK", { status: 200 });
}

export function loader() {
  // Webhook should be POST only
  return new Response("Method Not Allowed", { status: 405 });
}