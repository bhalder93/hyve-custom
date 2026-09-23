import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { loadOrderForAction } from "../lib/order-action.server";
import { changeProductionStatus, productionStatusOf } from "../lib/order-status.server";
import { attachArtworkToOrder } from "../lib/order-artwork.server";
import { uploadArtwork, recordOrderArtwork, artworkOwnerGid } from "../lib/artwork.server";

/**
 * Outstanding artwork supplied from the order.
 * Storefront: POST /apps/account/orders/artwork
 *
 * One file per decoration position, named `zone:<key>:file` for an upload or
 * `zone:<key>:saved` for something already in the buyer's library — the same
 * positions the product page offered when the order was placed.
 *
 * ART-03: an order placed with send-later artwork waits at Order Placed, shown
 * to the buyer as Awaiting Artwork. Supplying the files moves it to Artwork
 * Received, the same move staff make on the Production Orders screen.
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return backToOrders({ error: "Please sign in to send artwork." });

    const form = await request.formData();
    const orderGid = String(form.get("order") || "");
    if (!orderGid.startsWith("gid://shopify/Order/")) {
      return backToOrders({ error: "We couldn't work out which order that was." });
    }

    const chrome = await portalChrome(admin, customerId);
    const customerGid = `gid://shopify/Customer/${customerId}`;
    // Artwork sent from an order joins the company's library, not one person's.
    const owner = artworkOwnerGid({ companyId: chrome.terms?.companyId, customerId });

    const found = await loadOrderForAction(admin, orderGid, {
      customerGid,
      locationGids: chrome.terms?.locationIds || [],
    });
    if (!found.ok) return backToOrders({ error: found.error });
    const { order } = found;

    const supplied = [];

    for (const [field, value] of form.entries()) {
      if (!field.startsWith("zone:")) continue;
      const zoneKey = field.slice("zone:".length).replace(/:(file|saved)$/, "");

      if (field.endsWith(":saved")) {
        const chosen = String(value || "").trim();
        if (chosen) supplied.push({ zone: zoneKey, url: chosen, filename: filenameOf(chosen) });
        continue;
      }

      // An untouched file input still posts, as an empty file.
      if (!value || typeof value.arrayBuffer !== "function" || !value.size) continue;

      const uploaded = await uploadArtwork(admin, owner, value);
      if (!uploaded.ok) return backToOrders({ error: uploaded.error });
      supplied.push({ zone: zoneKey, url: uploaded.url, filename: uploaded.filename });
    }

    if (!supplied.length) {
      return backToOrders({ error: "Choose or upload a file for at least one position." });
    }

    // The order is where production looks, so the files go onto the order
    // itself — not only into the buyer's own library.
    const attached = await attachArtworkToOrder(admin, order.id, supplied);
    if (!attached.ok) return backToOrders({ error: attached.error });

    await recordOrderArtwork(admin, owner, supplied, {
      id: order.id,
      name: order.name,
      createdAt: new Date().toISOString(),
    });

    // Only an order still waiting on its artwork moves. One that staff have
    // already moved on keeps its place; the files are on it either way.
    if (productionStatusOf(order) === "order-placed") {
      const moved = await changeProductionStatus(admin, order, {
        to: "artwork-received",
        changedBy: chrome.customer?.name || chrome.customer?.email || "Customer",
        note: `Sent artwork from the portal:\n${supplied
          .map((item) => `• ${item.zone}: ${item.filename}\n  ${item.url}`)
          .join("\n")}`,
      });
      if (!moved.ok) return backToOrders({ error: moved.error });
    }

    const count = supplied.length;
    return backToOrders({
      notice: `Thanks — ${count} file${count === 1 ? "" : "s"} received for ${order.name}. We'll prepare your proof.`,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] order artwork upload failed", error);
    return backToOrders({ error: "We couldn't send that artwork. Please try again later." });
  }
};

function filenameOf(url) {
  const path = String(url || "").split("?")[0];
  try {
    return decodeURIComponent(path.split("/").pop() || "Artwork");
  } catch {
    return path.split("/").pop() || "Artwork";
  }
}

/** The form lives on the Orders page, so that's where the outcome is shown. */
function backToOrders({ notice, error }) {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice);
  if (error) params.set("error", error);

  return new Response(null, {
    status: 303,
    headers: { Location: `/apps/account/orders?${params.toString()}` },
  });
}
