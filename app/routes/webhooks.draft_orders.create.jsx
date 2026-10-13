// app/routes/webhooks.draft_orders.create.jsx

import { authenticate } from "../shopify.server";
import { notifyCreditReview } from "../lib/credit-review.server";

/**
 * Tells Hyve when a terms order is submitted for credit review (HYV-162).
 * Checkout makes it a draft order, so this is where it arrives. Every other
 * draft (quotes, reorders, staff drafts) is skipped by notifyCreditReview.
 *
 * Always answers 200 once Shopify is verified: a retry would only send the
 * alert again, so a failure is logged instead. The app runs as one long-lived
 * server (Render), so the alert carries on after the answer.
 */
export async function action({ request }) {
  const { admin, payload, shop } = await authenticate.webhook(request);

  // Answered at once and sent after: Shopify allows a webhook 5 seconds, and
  // reading who made the draft can take longer, which Shopify would retry.
  const draftGid = payload?.id ? `gid://shopify/DraftOrder/${payload.id}` : "";
  console.log("[draft_orders/create] received", shop, draftGid);
  if (admin && draftGid) {
    notifyCreditReview(admin, draftGid)
      .then((result) => {
        console.log("[draft_orders/create]", shop, draftGid, result.sent ? `alert sent to ${result.to.join(", ")}` : `no alert: ${result.reason}`);
      })
      .catch((error) => console.error("[draft_orders/create] failed", shop, error?.message || error));
  }

  return new Response(null, { status: 200 });
}
