// app/routes/webhooks.orders.create.jsx
import { shopifyApp } from "~/shopify.server";

const shopify = shopifyApp();

export async function action({ request }) {
  const { topic, shop, payload } = await shopify.webhooks.process(request);

  if (topic !== "ORDERS_CREATE") {
    console.warn("Unexpected topic on /webhooks/orders/create:", topic);
    return new Response("Ignored", { status: 200 });
  }

  // payload is the order JSON
  console.log("Order created:", payload.id, payload.name, "from", shop);

  // Your custom logic here (DB write, external API call, etc.)

  return new Response("OK", { status: 200 });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}