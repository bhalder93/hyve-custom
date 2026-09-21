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

  // Your custom logic here (DB write, external API call, etc.)

  return new Response("OK", { status: 200 });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}