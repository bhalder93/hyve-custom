import process from "node:process";
import { unauthenticated } from "../shopify.server";
import { sendBreachDigest } from "../utils/sla-engine.server";

/**
 * Daily breach digest (HYV-132), sent to the Daily Digest recipients and
 * called by a Shopify Flow scheduled workflow at 09:00 Singapore time, the
 * same way as /api/sla: POST with `Authorization: Bearer <CRON_SECRET>`. It
 * lists the breaches of the last 24 hours, on top of the per-order alerts.
 */
const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const loader = () => json({ service: "Hyve breach digest", status: "available" }, 200);

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
    const result = await sendBreachDigest(admin);
    console.log("[sla-digest]", JSON.stringify({ ...result, to: result.to?.length || 0 }));
    return json({ success: true, ...result, to: undefined }, 200);
  } catch (error) {
    console.error("[sla-digest] failed", error);
    return json({ success: false, error: error?.message || String(error) }, 500);
  }
}
