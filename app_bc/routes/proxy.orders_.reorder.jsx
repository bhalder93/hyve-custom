import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { reorder } from "../lib/reorder.server";

/**
 * Reorder.
 * Storefront: POST /apps/account/orders/reorder  (order=<gid>)
 *
 * Places a real unpaid order for the same items and emails it to the buyer.
 * A POST, not a link, because it charges nothing but does create an order —
 * that shouldn't happen because something prefetched a URL.
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return backToOrders({ error: "Please sign in to reorder." });

    const form = await request.formData();
    const orderGid = String(form.get("order") || "");
    if (!orderGid.startsWith("gid://shopify/Order/")) {
      return backToOrders({ error: "We couldn't work out which order to repeat." });
    }

    const chrome = await portalChrome(admin, customerId);
    if (!chrome.isDistributor) {
      return backToOrders({ error: "Reordering is for distributor accounts." });
    }

    const result = await reorder(admin, orderGid, `gid://shopify/Customer/${customerId}`);
    if (!result.ok) return backToOrders({ error: result.error });

    const dropped = result.skipped
      ? ` ${result.skipped} item${result.skipped === 1 ? "" : "s"} could not be repeated.`
      : "";
    const emailed = result.emailed ? " We've emailed it to you." : "";

    return backToOrders({ notice: `Order ${result.name} placed.${emailed}${dropped}` });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] reorder failed", error);
    return backToOrders({ error: "We couldn't place that order. Please try again later." });
  }
};

/** The button lives on the Orders page, so that's where the outcome is shown. */
function backToOrders({ notice, error }) {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice);
  if (error) params.set("error", error);

  return new Response(null, {
    status: 303,
    headers: { Location: `/apps/account/orders?${params.toString()}` },
  });
}
