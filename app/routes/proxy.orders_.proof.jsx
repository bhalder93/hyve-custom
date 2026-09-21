import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { recordProofDecision } from "../lib/proof.server";

/**
 * Proof decision.
 * Storefront: POST /apps/account/orders/proof  (order=<gid>, decision=approve|changes)
 *
 * ART-03 requires Approve proof and Request changes to work from the order
 * record as well as from the proof email. A POST rather than a link, because a
 * decision must not be taken by something prefetching a URL.
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return backToOrders({ error: "Please sign in to approve a proof." });

    const form = await request.formData();
    const orderGid = String(form.get("order") || "");
    const decision = String(form.get("decision") || "");
    const message = String(form.get("message") || "");

    if (!orderGid.startsWith("gid://shopify/Order/")) {
      return backToOrders({ error: "We couldn't work out which order that was." });
    }

    const chrome = await portalChrome(admin, customerId);

    const result = await recordProofDecision(admin, orderGid, decision, {
      customerGid: `gid://shopify/Customer/${customerId}`,
      locationGids: chrome.terms?.locationIds || [],
      who: chrome.customer?.name || chrome.customer?.email || "The buyer",
      message,
    });

    if (!result.ok) return backToOrders({ error: result.error });

    return backToOrders({
      notice:
        decision === "approve"
          ? `Thank you — proof approved for ${result.orderName}. We'll start production.`
          : `Thanks — we've passed your change request for ${result.orderName} to the team.`,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] proof decision failed", error);
    return backToOrders({ error: "We couldn't record that decision. Please try again later." });
  }
};

/** The buttons live on the Orders page, so that's where the outcome is shown. */
function backToOrders({ notice, error }) {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice);
  if (error) params.set("error", error);

  return new Response(null, {
    status: 303,
    headers: { Location: `/apps/account/orders?${params.toString()}` },
  });
}
