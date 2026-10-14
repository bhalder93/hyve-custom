import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { esc, PORTAL_TOKENS } from "../lib/account-shell.server";
import { reorderLines } from "../lib/reorder.server";

/**
 * Reorder (HYV-85).
 * Storefront: POST /apps/account/orders/reorder  (order=<gid>)
 *
 * Puts the order's items back in the buyer's cart, with their options and
 * saved artwork, and opens the cart: the buyer checks out as usual, choosing
 * the address, shipping and PO number. The page adds the lines itself, since
 * the cart lives in the buyer's browser. A POST, so nothing is added because
 * something prefetched a URL.
 */
export const action = async ({ request }) => {
  const { admin, liquid } = await authenticate.public.appProxy(request);

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

    const result = await reorderLines(
      admin,
      orderGid,
      `gid://shopify/Customer/${customerId}`,
      chrome.terms?.locationIds || [],
    );
    if (!result.ok) return backToOrders({ error: result.error });

    return liquid(addToCartPage(result));
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] reorder failed", error);
    return backToOrders({ error: "We couldn't add that order to your cart. Please try again later." });
  }
};

/** The button lives on the Orders page, so that's where a problem is shown. */
function backToOrders({ notice, error }) {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice);
  if (error) params.set("error", error);

  return new Response(null, {
    status: 303,
    headers: { Location: `/apps/account/orders?${params.toString()}` },
  });
}

/**
 * Adds each line to the cart, then opens it. A line the store refuses (sold
 * out since, or over the stock) is reported here rather than silently lost.
 */
function addToCartPage({ name, lines, skipped }) {
  // JSON inside the page, escaped so neither HTML nor Liquid reads into it:
  // <, > and & never appear outside a string, and neither do "{{" or "{%".
  // A fresh key per reorder: reloading the page, or coming Back to it, finds
  // the key already used and goes to the cart without adding the items again.
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const data = JSON.stringify({ key, lines, skipped })
    .replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/\{(?=[{%])/g, "\\u007b");
  return `
    <div class="hyve-reorder">
      <div class="hyve-reorder__card">
        <h1 class="hyve-reorder__title">Reorder ${esc(name)}</h1>
        <p class="hyve-reorder__text" data-reorder-status>Adding the items to your cart…</p>
        <a class="hyve-reorder__btn" href="/cart" data-reorder-cart hidden>Go to cart</a>
        <a class="hyve-reorder__link" href="/apps/account/orders">Back to orders</a>
      </div>
    </div>
    <script type="application/json" id="HyveReorder">${data}</script>
    <script>
      (function () {
        var data = JSON.parse(document.getElementById('HyveReorder').textContent);
        var status = document.querySelector('[data-reorder-status]');
        var cartLink = document.querySelector('[data-reorder-cart]');
        // The store's own root, so a language or market folder is kept.
        var root = (window.Shopify && Shopify.routes && Shopify.routes.root) || '/';
        var cartUrl = root + 'cart';
        cartLink.href = cartUrl;
        var doneKey = 'hyve-reorder-' + data.key;
        var alreadyDone = false;
        try { alreadyDone = sessionStorage.getItem(doneKey) === '1'; sessionStorage.setItem(doneKey, '1'); } catch (e) {}
        if (alreadyDone) { window.location.href = cartUrl; return; }
        var failed = 0;
        var chain = Promise.resolve();
        data.lines.forEach(function (line) {
          chain = chain.then(function () {
            return fetch(root + 'cart/add.js', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ items: [line] })
            }).then(function (res) { if (!res.ok) failed += 1; }, function () { failed += 1; });
          });
        });
        chain.then(function () {
          var left = failed + (data.skipped || 0);
          if (left === 0) { window.location.href = cartUrl; return; }
          var added = data.lines.length - failed;
          status.textContent = added
            ? added + ' item' + (added === 1 ? ' is' : 's are') + ' in your cart. ' + left + ' item' + (left === 1 ? '' : 's') + " couldn't be added in full: no longer available, short of stock, or not a store product. Please check your cart."
            : "None of the items could be added: they're no longer available or short of stock.";
          if (added) cartLink.hidden = false;
        });
      })();
    </script>
    <style>
      .hyve-reorder { ${PORTAL_TOKENS} padding: 56px 16px; font-family: var(--hyve-body); color: var(--hyve-900); font-size: 14px; }
      .hyve-reorder__card {
        max-width: 520px; margin: 0 auto; background: var(--hyve-white); border: 1px solid var(--hyve-border-strong);
        border-radius: var(--hyve-radius-lg); box-shadow: var(--hyve-shadow-sm); padding: 28px;
        display: flex; flex-direction: column; gap: 14px;
      }
      .hyve-reorder__title { font-family: var(--hyve-display); font-size: 22px; font-weight: 800; margin: 0; }
      .hyve-reorder__text { margin: 0; line-height: 1.6; color: var(--hyve-700); }
      .hyve-reorder__btn {
        align-self: flex-start; background: var(--hyve-900); color: var(--hyve-white); border-radius: 10px;
        padding: 12px 20px; font-weight: 700; text-decoration: none;
      }
      .hyve-reorder__btn[hidden] { display: none; }
      .hyve-reorder__link { align-self: flex-start; color: var(--hyve-700); font-weight: 600; }
    </style>`;
}
