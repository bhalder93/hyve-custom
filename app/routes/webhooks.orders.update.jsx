// app/routes/webhooks.orders.updated.jsx
// ✅ correct
import shopify from "../shopify.server";


export async function action({ request }) {
  const { topic, shop, payload } = await shopify.webhooks.process(request);

  if (topic !== "ORDERS_UPDATED") {
    console.warn("Unexpected topic on /webhooks/orders/updated:", topic);
    return new Response("Ignored", { status: 200 });
  }

  console.log("Order updated:", payload.id, payload.name, "from", shop);

  // Your custom logic here

  return new Response("OK", { status: 200 });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}