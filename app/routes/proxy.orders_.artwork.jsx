import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { loadOrderForAction } from "../lib/order-action.server";
import { changeProductionStatus, productionStatusOf, recordStatusHistory, SOURCES } from "../lib/order-status.server";
import { attachArtworkToOrder } from "../lib/order-artwork.server";
import { zonesFromAttributes } from "../lib/artwork-zones.server";
import { artworkPending } from "../lib/portal.server";
import {
  uploadArtwork,
  recordOrderArtwork,
  artworkOwnerGid,
  artworkRulesFor,
  extensionOf,
} from "../lib/artwork.server";

/**
 * Outstanding artwork supplied from the order.
 * Storefront: POST /apps/account/orders/artwork
 *
 * One file per decoration position on each line, named `zone:<key>:file` for
 * an upload or `zone:<key>:saved` for something already in the buyer's library,
 * where the key is the position and its line (lateArtworkKey) — the same
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

    // The positions on this order's lines, by the key their files are saved under.
    const zonesByKey = new Map(
      (order.lineItems?.nodes || []).flatMap((line) =>
        zonesFromAttributes(line.customAttributes, order.customAttributes, line.id, line).map((zone) => [
          zone.lateKey,
          { ...zone, line: [line.title, line.variantTitle].filter(Boolean).join(" — ") },
        ]),
      ),
    );

    // Every file is checked against its position before anything is uploaded,
    // so a refused file never leaves the others half sent. A laser position
    // takes vector files only, as on the product page (artworkRulesFor).
    const chosen = [];
    for (const [field, value] of form.entries()) {
      if (!field.startsWith("zone:")) continue;
      const zoneKey = field.slice("zone:".length).replace(/:(file|saved)$/, "");
      if (!zonesByKey.has(zoneKey)) {
        return backToOrders({ error: "That position isn't on this order. Please reopen the order and try again." });
      }

      if (field.endsWith(":saved")) {
        const url = String(value || "").trim();
        if (url) chosen.push({ zone: zoneKey, url, filename: filenameOf(url) });
        continue;
      }

      // An untouched file input still posts, as an empty file.
      if (!value || typeof value.arrayBuffer !== "function" || !value.size) continue;
      chosen.push({ zone: zoneKey, file: value, filename: String(value.name || "artwork") });
    }

    for (const item of chosen) {
      const zone = zonesByKey.get(item.zone);
      const rules = artworkRulesFor(zone.key);
      if (!rules.allowed.includes(extensionOf(item.filename))) {
        return backToOrders({ error: `${zone.label}: ${rules.reject}` });
      }
    }

    const supplied = [];
    for (const item of chosen) {
      const zone = zonesByKey.get(item.zone);
      if (!item.file) {
        supplied.push({
          zone: item.zone,
          legacyZone: zone?.legacyKey,
          url: item.url,
          filename: item.filename,
        });
        continue;
      }
      const uploaded = await uploadArtwork(admin, owner, item.file);
      if (!uploaded.ok) return backToOrders({ error: uploaded.error });
      supplied.push({
        zone: item.zone,
        legacyZone: zone?.legacyKey,
        url: uploaded.url,
        filename: uploaded.filename,
      });
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

    // The order as it is now, with these files on it. The status email lists
    // the lines from it, so these files read as received there too.
    const attributes = new Map((order.customAttributes || []).map((attr) => [attr.key, attr.value]));
    for (const item of supplied) {
      if (item.legacyZone && item.legacyZone !== item.zone) attributes.delete(item.legacyZone);
      attributes.set(item.zone, item.url);
    }
    const updated = {
      ...order,
      customAttributes: [...attributes].map(([key, value]) => ({ key, value })),
    };
    const stillPending = artworkPending(updated);

    const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
    const userAgent = request.headers.get("user-agent") || "";
    const changedBy = chrome.customer?.name || chrome.customer?.email || "Customer";

    const artworkNote = `Sent artwork from the portal${stillPending ? " (awaiting remaining artwork)" : ""}:\n${supplied
      .map((item) => {
        // Staff read the line and position, not the key the file is saved under.
        const zone = zonesByKey.get(item.zone);
        return `• ${zone.line}, ${zone.label}: ${item.filename}\n  ${item.url}`;
      })
      .join("\n")}`;

    // Only an order still waiting on its artwork moves, and only once every
    // send-later line has its files, so the buyer can still send the rest and
    // no proof starts with artwork missing (HYV-212). One that staff have
    // already moved on keeps its place; the files are on it either way.
    if (productionStatusOf(order) === "order-placed" && !stillPending) {
      const moved = await changeProductionStatus(admin, updated, {
        to: "artwork-received",
        changedBy,
        source: SOURCES.portal,
        note: artworkNote,
        ipAddress,
        userAgent,
      });
      if (!moved.ok) return backToOrders({ error: moved.error });
    } else {
      // Record this upload in the audit trail even if status does not advance
      // (e.g. partial upload awaiting remaining files, or order already moved on),
      // so staff can see every file the customer sends.
      const currentStatus = productionStatusOf(order) || "order-placed";
      await recordStatusHistory(admin, {
        order: updated,
        from: currentStatus,
        to: currentStatus,
        changedAt: new Date().toISOString(),
        changedBy,
        source: SOURCES.portal,
        note: artworkNote,
        ipAddress,
        userAgent,
      });
    }

    const count = supplied.length;
    return backToOrders({
      notice: stillPending
        ? `Thanks — ${count} file${count === 1 ? "" : "s"} received for ${order.name}. Please send the rest of your artwork so we can prepare your Artwork Proof.`
        : `Thanks — ${count} file${count === 1 ? "" : "s"} received for ${order.name}. We'll prepare your Artwork Proof.`,
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
