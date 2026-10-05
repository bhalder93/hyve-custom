import process from "node:process";
import { unauthenticated } from "../shopify.server";
import { startInBackground } from "../lib/tier-prices.server";

/**
 * Daily tier price update (HYV-80), called by a Shopify Flow scheduled
 * workflow the same way as /api/sla: POST with `Authorization: Bearer
 * <CRON_SECRET>`. A run takes a minute or two, longer than Flow waits for a
 * reply, so this answers at once and the update carries on in the background.
 * The Tier Prices page shows how it went.
 */
const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const loader = () => json({ service: "Hyve tier prices", status: "available" }, 200);

export async function action({ request }) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ success: false, error: "CRON_SECRET is not configured." }, 500);
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  const shop = process.env.SHOPIFY_SHOP?.trim().toLowerCase();
  if (!shop?.endsWith(".myshopify.com")) return json({ success: false, error: "SHOPIFY_SHOP is missing or invalid." }, 500);

  try {
    const { admin } = await unauthenticated.admin(shop);
    const started = startInBackground(admin, { trigger: "daily" });
    return started
      ? json({ success: true, started: true }, 202)
      : json({ success: true, started: false, reason: "A tier price update is already running." }, 200);
  } catch (error) {
    console.error("[tier-prices] daily run could not start", error);
    return json({ success: false, error: error?.message || String(error) }, 500);
  }
}
