import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { recordProductionDecision } from "../lib/production-approval.server";

/**
 * Production photo decision.
 * Storefront: POST /apps/account/orders/production-photo  (order=<gid>, decision=approve|changes)
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return backToOrders({ error: "Please sign in to approve a Production Photo." });

    const form = await request.formData();
    const orderGid = String(form.get("order") || "");
    const decision = String(form.get("decision") || "");
    const message = String(form.get("message") || "");

    if (!orderGid.startsWith("gid://shopify/Order/")) {
      return backToOrders({ error: "We couldn't work out which order that was." });
    }

    const chrome = await portalChrome(admin, customerId);

    const ipAddress = (request.headers.get("true-client-ip") || request.headers.get("x-shopify-client-ip") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "").split(",")[0].trim();
    const userAgent = String(form.get("client_user_agent") || "").trim() || request.headers.get("user-agent") || "";

    const result = await recordProductionDecision(admin, orderGid, decision, {
      customerGid: `gid://shopify/Customer/${customerId}`,
      locationGids: chrome.terms?.locationIds || [],
      who: chrome.customer?.name || chrome.customer?.email || "The buyer",
      message,
      ipAddress,
      userAgent,
    });

    if (!result.ok) return backToOrders({ error: result.error });

    return backToOrders({
      notice:
        decision === "approve"
          ? `Thank you — Production Photo approved for ${result.orderName}. We'll release it for shipping.`
          : `Thanks — we've passed your change request for ${result.orderName} to the team.`,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] production decision failed", error);
    return backToOrders({ error: "We couldn't record that decision. Please try again later." });
  }
};

function backToOrders({ notice, error }) {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice);
  if (error) params.set("error", error);

  return new Response(null, {
    status: 303,
    headers: { Location: `/apps/account/orders?${params.toString()}` },
  });
}
