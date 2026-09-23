/**
 * Orders list for the account portal.
 *
 * Built to the requirements rather than the mockup, where the two differ:
 *  - J1  order number, date, PO number in its own column, status, total; the
 *        filters are the six J3 words and nothing else; search matches order
 *        number, PO number and product name.
 *  - J3  six customer-visible statuses (see portal.server.js for the mapping
 *        from the stored production status).
 *  - J10 the chain ends at Shipped. There is no Delivered filter or state, so
 *        the mockup's "Delivery Confirmed" row is deliberately absent.
 *  - J9  each row carries the action that fits its status.
 *  - J12 an order waiting on the distributor shows what is needed and by when.
 *
 * Search and filtering run client-side: every order is already in the markup,
 * so switching a filter costs no round trip.
 */
import { esc } from "./account-shell.server";
import { zonesFromAttributes } from "./artwork-zones.server";
import { orderModal, MODAL_STYLES, MODAL_SCRIPT } from "./account-order-modal.server";
import {
  VISIBLE_STATUSES,
  AWAITING_DISTRIBUTOR,
  orderStatusKey,
  statusByKey,
  formatMoney,
  formatDate,
} from "./portal.server";

/**
 * Map Admin API order nodes into the shape the row renderer wants.
 * @param {Array<object>} nodes `customer.orders.nodes`
 */
export function mapOrders(nodes = []) {
  return nodes.map((node) => {
    const lineItems = node?.lineItems?.nodes || [];
    const fulfillment = (node?.fulfillments || [])[0] || null;
    const tracking = (fulfillment?.trackingInfo || [])[0] || null;
    const statusKey = orderStatusKey(node);
    const money = node?.totalPriceSet?.shopMoney || {};

    return {
      // Reorder and the invoice PDF both act on the order itself, so the row
      // has to carry its ID and not just its name.
      id: node?.id || "",
      name: node?.name || "",
      poNumber: node?.poNumber || "",
      // Only an order on terms has an invoice — a prepaid one was settled at
      // checkout and there is no paperwork to hand over.
      hasInvoice: Boolean(node?.paymentTerms),
      // Set where this order began life as a quote, so the detail can offer
      // that quote's PDF alongside the invoice.
      quoteHref: node?.quoteDraftId
        ? `/apps/account/quotes/pdf?draft=${encodeURIComponent(node.quoteDraftId)}`
        : "",
      statusKey,
      items: itemsSummary(lineItems),
      date: formatDate(node?.createdAt),
      total: formatMoney(money.amount, money.currencyCode),
      icon: iconFor(lineItems[0]?.title || ""),
      viewHref: node?.statusPageUrl || "",
      trackHref: tracking?.url || "",
      carrier: tracking?.company || "",
      trackingNumber: tracking?.number || "",
      // Set when the proof is approved, and the same date the buyer is sent in
      // the "Proof approved — production starting" email.
      productionTarget: formatDate(node?.productionDueAt?.value),
      proofUrl: node?.proofUrl?.value || "",
      onHoldReason: node?.onHoldReason?.value || "",

      // Order detail modal (J2)
      // The modal lists payment terms as a header fact. It read a field nobody
      // set, so the line was silently dropped on every order.
      paymentTerms: node?.paymentTerms?.paymentTermsName || "",
      productionPhotoUrl: node?.productionPhotoUrl?.value || "",
      note: node?.note || "",
      shippingAddress: node?.shippingAddress || null,
      shippingMethod: node?.shippingLine?.title || "",
      lines: lineItems.map((li) => ({
        title: li.title,
        quantity: li.quantity,
        variantTitle: li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : "",
        sku: li.sku || "",
        // J2 wants the decoration method and placement on the line. They were
        // chosen at add-to-cart and live on the line's properties; underscore
        // keys are Shopify's hidden-property convention and carry our plumbing,
        // and the per-zone artwork is shown by the artwork panel instead.
        options: (li.customAttributes || [])
          .filter(
            (attr) =>
              attr?.key && !attr.key.startsWith("_") && !attr.key.startsWith("Artwork:") && attr.value,
          )
          .map((attr) => `${attr.key}: ${attr.value}`),
        // F11: where this line is decorated, so a send-later order can be
        // completed against the same positions the buyer chose.
        zones: zonesFromAttributes(li.customAttributes, node?.customAttributes),
        unitPrice: formatMoney(
          li.originalUnitPriceSet?.shopMoney?.amount,
          li.originalUnitPriceSet?.shopMoney?.currencyCode,
        ),
        lineTotal: formatMoney(
          li.discountedTotalSet?.shopMoney?.amount,
          li.discountedTotalSet?.shopMoney?.currencyCode,
        ),
      })),
    };
  });
}

/** Orders waiting on the distributor — the H9 badge: Proof Sent or Awaiting Artwork. */
export function awaitingActionCount(orders = []) {
  return orders.filter((o) => AWAITING_DISTRIBUTOR.includes(o.statusKey)).length;
}

/**
 * @param {object} opts
 * @param {Array<object>} opts.orders
 * @param {boolean} [opts.showDistributorPromo]  only for non-distributor accounts
 */
export function ordersPage({ orders = [], library = [], showDistributorPromo = false, notice = "", error = "" } = {}) {
  const tabs = [{ key: "all", label: "All" }, ...VISIBLE_STATUSES]
    .map(
      (tab, i) => `
        <button type="button" class="hyve-ord__tab${i === 0 ? " is-active" : ""}" data-filter="${tab.key}">
          ${esc(tab.label)}
        </button>`,
    )
    .join("");

  const list = orders.length
    ? `<div class="hyve-ord__list">${orders.map(orderRow).join("")}</div>
       <p class="hyve-ord__none" hidden>No orders match your search.</p>`
    : `<div class="hyve-ord__empty">You have not placed any orders yet.</div>`;

  // One modal per order, rendered alongside the list and toggled client-side.
  const modals = orders.map((order) => orderModal(order, library)).join("");

  return `
    ${ORDERS_STYLES}
    <div class="hyve-ord" data-orders>
      <h1 class="hyve-ord__title">Orders</h1>
      <p class="hyve-ord__sub">Track, manage and reorder your purchases</p>

      ${notice ? `<p class="hyve-ord__flash is-ok">${esc(notice)}</p>` : ""}
      ${error ? `<p class="hyve-ord__flash is-bad">${esc(error)}</p>` : ""}

      <div class="hyve-ord__card">
        <div class="hyve-ord__controls">
          <label class="hyve-ord__search">
            ${icoSearch()}
            <input type="search" placeholder="Search orders..." aria-label="Search orders" data-orders-search>
          </label>
          <div class="hyve-ord__tabs" role="group" aria-label="Filter orders by status">${tabs}</div>
        </div>

        ${showDistributorPromo ? promoCard() : ""}
        ${list}
      </div>
    </div>
    ${modals}
    ${ORDERS_SCRIPT}
    ${MODAL_SCRIPT}`;
}

/**
 * One order row. Exported so the dashboard's recent-orders list is the same
 * component rather than a second implementation that drifts.
 */
export function orderRow(order) {
  const status = statusByKey(order.statusKey) || VISIBLE_STATUSES[0];
  const haystack = [order.name, order.poNumber, order.items, status.label].join(" ").toLowerCase();
  const meta = metaLine(order, status.key);

  return `
    <article class="hyve-ord__row" data-status="${esc(order.statusKey)}" data-search="${esc(haystack)}">
      <span class="hyve-ord__icon">${order.icon}</span>

      <div class="hyve-ord__body">
        <div class="hyve-ord__head">
          <span class="hyve-ord__name">${esc(order.name)}</span>
          <span class="hyve-ord__badge hyve-ord__badge--${status.tone}">${esc(status.label)}</span>
        </div>
        <p class="hyve-ord__items">${esc(order.items)}</p>
        <p class="hyve-ord__date">
          ${esc(order.date)}
          ${order.poNumber ? `<span class="hyve-ord__po">PO ${esc(order.poNumber)}</span>` : ""}
        </p>
        ${meta}
      </div>

      <div class="hyve-ord__side">
        <span class="hyve-ord__total">${esc(order.total)}</span>
        <div class="hyve-ord__actions">${rowActions(order, status.key)}</div>
      </div>
    </article>`;
}

/** J9: the action that fits the status. View is always available. */
function rowActions(order, statusKey) {
  // Everything the buyer does with an order happens in its detail, so the row
  // has one button that opens it. Where there is something waiting on them,
  // that button says so instead of a generic "View" — two buttons opening the
  // same panel is just two buttons.
  const openDetail = (icon, label, variant) =>
    `<button type="button" class="hyve-ord__btn hyve-ord__btn--${variant}" data-modal-open="order-${esc(order.name)}">${icon}<span>${esc(label)}</span></button>`;

  const actions = [];

  if (statusKey === "proof-sent") {
    actions.push(openDetail(icoProof(), "Review Proof", "primary"));
  } else if (statusKey === "awaiting-artwork") {
    actions.push(openDetail(icoUpload(), "Upload Artwork", "primary"));
  } else {
    actions.push(openDetail(icoEye(), "View", "ghost"));
  }

  if (statusKey === "shipped" && order.trackHref) {
    actions.push(action(order.trackHref, icoTruck(), "Track"));
  }
  // J9: the invoice is downloadable from the order it belongs to, not only
  // from the Invoices page.
  if (order.hasInvoice && order.id) {
    actions.push(
      action(
        `/apps/account/invoices/download?order=${encodeURIComponent(order.id)}`,
        icoInvoice(),
        "Invoice",
      ),
    );
  }
  if (["shipped", "production-completed"].includes(statusKey) && order.id) {
    // Reorder places a real order, so it posts rather than following a link.
    actions.push(`
      <form method="post" action="/apps/account/orders/reorder" class="hyve-ord__reorder">
        <input type="hidden" name="order" value="${esc(order.id)}">
        <button type="submit" class="hyve-ord__btn hyve-ord__btn--primary">
          ${icoRepeat()}<span>Reorder</span>
        </button>
      </form>`);
  }

  return actions.filter(Boolean).join("");
}

/** J12 action-required line, plus the status-specific detail lines. */
function metaLine(order, statusKey) {
  if (statusKey === "proof-sent") {
    return `<p class="hyve-ord__meta is-action">${icoClock()}<span>Action Required: Approve your artwork proof to avoid delays</span></p>`;
  }
  if (statusKey === "awaiting-artwork") {
    return `<p class="hyve-ord__meta is-action">${icoUpload()}<span>Action Required: Upload your artwork so production can start</span></p>`;
  }
  if (statusKey === "on-hold" && order.onHoldReason) {
    return `<p class="hyve-ord__meta is-action">${icoClock()}<span>On Hold: ${esc(order.onHoldReason)}</span></p>`;
  }
  if (statusKey === "shipped" && (order.carrier || order.trackingNumber)) {
    const carrier = order.carrier ? `Carrier: ${esc(order.carrier)}` : "";
    const number = order.trackingNumber ? `Tracking: <strong>${esc(order.trackingNumber)}</strong>` : "";
    return `<p class="hyve-ord__meta">${icoTruck()}<span>${[carrier, number].filter(Boolean).join(" &middot; ")}</span></p>`;
  }
  if (statusKey === "in-production" && order.productionTarget) {
    return `<p class="hyve-ord__meta">${icoCalendar()}<span>Production target: <strong>${esc(order.productionTarget)}</strong></span></p>`;
  }
  return "";
}

function action(href, icon, label, variant = "ghost") {
  return `<a class="hyve-ord__btn hyve-ord__btn--${variant}" href="${esc(href)}">${icon}<span>${esc(label)}</span></a>`;
}

function promoCard() {
  return `
    <section class="hyve-promo" data-promo>
      <span class="hyve-promo__icon">${icoAward()}</span>
      <div class="hyve-promo__body">
        <h2 class="hyve-promo__title">
          Grow Your Business with Our Distributor Program
          <span class="hyve-promo__tag">EXCLUSIVE B2B</span>
        </h2>
        <p class="hyve-promo__sub">Unlock enterprise benefits by joining the Hyve distributor network. Perfect for marketing agencies, wholesalers, and corporate procurement teams.</p>
        <ul class="hyve-promo__perks">
          <li>${icoCard()}<span>Special Commercial Payment Terms (Net 30)</span></li>
          <li>${icoTag()}<span>Exclusive Tier Pricing (Up to Platinum)</span></li>
          <li>${icoTruck()}<span>Flexible Shipping Terms (FOB/EXW)</span></li>
        </ul>
      </div>
      <a class="hyve-promo__cta" href="/apps/account/distributor">Apply Now ${icoArrow()}</a>
      <button type="button" class="hyve-promo__close" aria-label="Dismiss" data-promo-close>${icoClose()}</button>
    </section>`;
}

/* ---------- helpers ---------- */

function itemsSummary(lineItems) {
  if (!lineItems.length) return "";
  const [first, ...rest] = lineItems;
  const extras = [];
  if (first.variantTitle && first.variantTitle !== "Default Title") extras.push(first.variantTitle);
  rest.forEach((li) => extras.push(`${li.title} x${li.quantity}`));
  const head = `${first.title} x${first.quantity}`;
  return extras.length ? `${head} — ${extras.join(", ")}` : head;
}

function iconFor(title) {
  const t = title.toLowerCase();
  if (/tumbler|bottle|mug|drink|flask/.test(t)) return icoCup();
  if (/bag|backpack|tote|pouch/.test(t)) return icoBag();
  if (/pen|pencil|marker|stylus/.test(t)) return icoPen();
  if (/charger|phone|power|cable|tech|speaker/.test(t)) return icoPhone();
  if (/notebook|journal|book|diary|planner/.test(t)) return icoBook();
  return icoBoxSmall();
}

/* ---------- icons ---------- */
function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
function icoSearch() { return svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'); }
function icoEye() { return svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'); }
function icoTruck() { return svg('<path d="M10 17V6a1 1 0 0 0-1-1H2v11h2"/><path d="M14 17h-4"/><path d="M20 17h2v-4l-3-4h-5v8h2"/><circle cx="7" cy="17.5" r="2.5"/><circle cx="17" cy="17.5" r="2.5"/>'); }
function icoUpload() { return svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'); }
function icoProof() { return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 11 17 15 13"/>'); }
function icoRepeat() { return svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'); }
function icoInvoice() { return svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'); }
function icoClock() { return svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'); }
function icoCalendar() { return svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'); }
function icoAward() { return svg('<circle cx="12" cy="8" r="6"/><path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5"/>'); }
function icoCard() { return svg('<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>'); }
function icoTag() { return svg('<path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>'); }
function icoArrow() { return svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'); }
function icoClose() { return svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'); }
function icoCup() { return svg('<path d="M8 2h8l-1 4H9z"/><path d="M7 6h10l-1 15a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z"/><line x1="9" y1="12" x2="15" y2="12"/>'); }
function icoBag() { return svg('<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a4 4 0 0 1 8 0v2"/><line x1="3" y1="12" x2="21" y2="12"/>'); }
function icoPen() { return svg('<path d="M12 19l7-7-4-4-7 7-1 5z"/><path d="M16 8l2-2a2 2 0 0 0-3-3l-2 2"/><line x1="3" y1="21" x2="8" y2="21"/>'); }
function icoPhone() { return svg('<rect x="6" y="2" width="12" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>'); }
function icoBook() { return svg('<path d="M4 4a2 2 0 0 1 2-2h14v18H6a2 2 0 0 0-2 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/>'); }
function icoBoxSmall() { return svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'); }

/* ---------- styles ---------- */
export const ORDER_ROW_STYLES = `
  .hyve-ord__list { display: flex; flex-direction: column; padding: 16px; }
  .hyve-ord__row { display: flex; align-items: flex-start; gap: 14px; padding: 16px 4px; border-top: 1px solid var(--hyve-border); }
  .hyve-ord__row[hidden] { display: none; }
  .hyve-ord__row:first-child { border-top: 0; }
  .hyve-ord__icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 10px; background: #F1F5F9; color: #475569; flex-shrink: 0; }
  .hyve-ord__icon svg { width: 20px; height: 20px; }
  .hyve-ord__body { flex: 1 1 260px; min-width: 0; }
  .hyve-ord__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 3px; }
  .hyve-ord__name { font-family: var(--hyve-display); font-size: 15px; font-weight: 700; }
  .hyve-ord__badge { display: inline-flex; align-items: center; border-radius: 9999px; padding: 2px 9px; font-size: 11px; font-weight: 700; }
  .hyve-ord__badge--neutral { background: #F1F5F9; color: #475569; }
  .hyve-ord__badge--info { background: #DBEAFE; color: #1D4ED8; }
  .hyve-ord__badge--warn { background: #FEF3C7; color: #B45309; }
  .hyve-ord__badge--indigo { background: #E0E7FF; color: #4338CA; }
  .hyve-ord__badge--teal { background: #CCFBF1; color: #0F766E; }
  .hyve-ord__badge--ok { background: #DCFCE7; color: #15803D; }
  .hyve-ord__badge--error { background: #FEE2E2; color: #B91C1C; }
  .hyve-ord__items { font-size: 13px; color: var(--hyve-700); margin: 0 0 2px; }
  .hyve-ord__date { font-size: 12px; color: var(--hyve-muted); margin: 0; }
  .hyve-ord__po { color: var(--hyve-700); font-weight: 600; }
  .hyve-ord__po::before { content: "·"; margin: 0 6px; color: var(--hyve-muted); font-weight: 400; }
  .hyve-ord__meta { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--hyve-500); margin: 10px 0 0; }
  .hyve-ord__meta svg { width: 13px; height: auto; flex-shrink: 0; }
  .hyve-ord__meta.is-action { color: #B45309; }
  .hyve-ord__side { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-left: auto; }
  .hyve-ord__total { font-family: var(--hyve-display); font-size: 15px; font-weight: 800; white-space: nowrap; }
  .hyve-ord__actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .hyve-ord__btn { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; font-size: 11.5px; font-weight: 600; padding: 6px 12px; border-radius: 6px; white-space: nowrap; font-family: inherit; cursor: pointer; }
  .hyve-ord__reorder { display: inline-flex; margin: 0; }
  .hyve-ord__flash { margin: 0 0 14px; padding: 11px 14px; border-radius: 10px; font-size: 13px; font-weight: 600; }
  .hyve-ord__flash.is-ok { background: #DCFCE7; color: #15803D; border: 1px solid #BBF7D0; }
  .hyve-ord__flash.is-bad { background: #FEE2E2; color: #B91C1C; border: 1px solid #FECACA; }
  .hyve-ord__btn svg { width: 14px; height: 14px; }
  .hyve-ord__btn--ghost { border: 1px solid var(--hyve-border-strong); color: var(--hyve-500); background: #fff; }
  .hyve-ord__btn--ghost:hover { border-color: var(--hyve-muted); }
  .hyve-ord__btn--primary { background: var(--hyve-gradient); color: #0A1414; border: 1px solid transparent; }
  .hyve-ord__btn--primary:hover { filter: brightness(0.96); }

  @media (max-width: 760px) {
    .hyve-ord__row { flex-wrap: wrap; }
    .hyve-ord__side { margin-left: 0; width: 100%; justify-content: space-between; }
  }`;

const ORDERS_STYLES = `
<style>
  .hyve-ord__title { font-family: var(--hyve-display); font-size: 22px; font-weight: 800; margin: 0; }
  .hyve-ord__sub { color: var(--hyve-muted); font-size: 13px; font-weight: 400; margin: 2px 0 20px; }
  /* padding: 0 + overflow: hidden is what lets the promo band run edge to edge,
     the way it does in the demo. Each section below carries its own padding. */
  .hyve-ord__card { background: var(--hyve-white); border: 1px solid var(--hyve-border); border-radius: var(--hyve-radius); padding: 0; overflow: hidden; }

  .hyve-ord__controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 16px; }
  .hyve-ord__search { display: flex; align-items: center; gap: 8px; flex: 0 1 240px; padding: 0 14px; height: 36px; border: 1px solid var(--hyve-border-strong); border-radius: 9999px; background: rgba(15, 23, 42, 0.03); }
  .hyve-ord__search svg { width: 16px; height: 16px; color: var(--hyve-muted); flex-shrink: 0; }
  .hyve-ord__search input { border: 0; outline: none; background: transparent; width: 100%; font-size: 13px; color: var(--hyve-900); font-family: inherit; }
  .hyve-ord__tabs { display: flex; flex-wrap: wrap; gap: 6px; }
  .hyve-ord__tab { border: 0; background: rgba(15, 23, 42, 0.04); color: var(--hyve-500); border-radius: 9999px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; transition: background 0.15s ease, color 0.15s ease; }
  .hyve-ord__tab:hover { background: rgba(15, 23, 42, 0.08); }
  .hyve-ord__tab.is-active { background: linear-gradient(135deg, rgba(163,234,110,0.15) 0%, rgba(110,222,225,0.15) 100%); color: var(--hyve-900); font-weight: 700; }

  .hyve-promo { position: relative; display: flex; align-items: center; gap: 24px; flex-wrap: wrap; padding: 20px 44px 20px 24px; border-top: 1px solid var(--hyve-border); border-bottom: 1px solid var(--hyve-border); background: linear-gradient(135deg, rgba(163, 234, 110, 0.08) 0%, rgba(110, 222, 225, 0.08) 100%); }
  .hyve-promo::before { content: ''; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: var(--hyve-gradient); }
  .hyve-promo[hidden] { display: none; }
  .hyve-promo__icon { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; background: #DCFCE7; color: #15803D; flex-shrink: 0; }
  .hyve-promo__icon svg { width: 19px; height: 19px; }
  .hyve-promo__body { flex: 1 1 300px; min-width: 0; }
  .hyve-promo__title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-family: var(--hyve-display); font-size: 15px; font-weight: 700; margin: 0 0 4px; }
  .hyve-promo__tag { background: #DCFCE7; color: #15803D; border-radius: 9999px; padding: 2px 8px; font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em; }
  .hyve-promo__sub { color: var(--hyve-900); font-size: 12.5px; font-weight: 400; line-height: 1.5; margin: 0 0 12px; }
  .hyve-promo__perks { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; }
  .hyve-promo__perks li { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 600; color: var(--hyve-700); }
  .hyve-promo__perks svg { width: 15px; height: 15px; color: var(--hyve-teal-dark); flex-shrink: 0; }
  .hyve-promo__cta { align-self: flex-end; display: inline-flex; align-items: center; gap: 8px; background: var(--hyve-900); color: #fff; text-decoration: none; font-size: 12.5px; font-weight: 700; padding: 10px 18px; border-radius: 8px; white-space: nowrap; }
  .hyve-promo__cta:hover { background: #1E293B; }
  .hyve-promo__cta svg { width: 16px; height: 16px; }
  .hyve-promo__close { position: absolute; top: 12px; right: 12px; border: 0; background: transparent; color: var(--hyve-muted); cursor: pointer; padding: 4px; line-height: 0; border-radius: 6px; }
  .hyve-promo__close:hover { background: #DCFCE7; color: var(--hyve-900); }
  .hyve-promo__close svg { width: 16px; height: 16px; }


  .hyve-ord__none, .hyve-ord__empty { border: 1px dashed #CBD5E1; border-radius: var(--hyve-radius); padding: 40px 20px; text-align: center; color: var(--hyve-muted); font-size: 13px; margin: 16px; }
  .hyve-ord__none[hidden] { display: none; }

  ${ORDER_ROW_STYLES}
  ${MODAL_STYLES}
</style>`;

const ORDERS_SCRIPT = `
<script>
(function () {
  var root = document.querySelector('[data-orders]');
  if (!root) return;

  var PROMO_KEY = 'hyve-distributor-promo-dismissed';
  var promo = root.querySelector('[data-promo]');
  if (promo) {
    try {
      if (window.localStorage.getItem(PROMO_KEY) === '1') promo.hidden = true;
    } catch (e) {}
    var closeBtn = promo.querySelector('[data-promo-close]');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        promo.hidden = true;
        try { window.localStorage.setItem(PROMO_KEY, '1'); } catch (e) {}
      });
    }
  }

  var rows = Array.prototype.slice.call(root.querySelectorAll('.hyve-ord__row'));
  var tabs = Array.prototype.slice.call(root.querySelectorAll('.hyve-ord__tab'));
  var search = root.querySelector('[data-orders-search]');
  var none = root.querySelector('.hyve-ord__none');
  var filter = 'all';

  function apply() {
    var query = ((search && search.value) || '').trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (row) {
      var matchesTab = filter === 'all' || row.getAttribute('data-status') === filter;
      var matchesQuery = !query || (row.getAttribute('data-search') || '').indexOf(query) !== -1;
      var visible = matchesTab && matchesQuery;
      row.hidden = !visible;
      if (visible) shown += 1;
    });
    if (none) none.hidden = shown !== 0 || rows.length === 0;
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (other) { other.classList.remove('is-active'); });
      tab.classList.add('is-active');
      filter = tab.getAttribute('data-filter') || 'all';
      apply();
    });
  });

  // A link can arrive asking for one status: the dashboard's Track Order
  // shortcut points here with ?filter=shipped. Without this the parameter was
  // ignored and the buyer landed on every order, which is not what the link
  // said it would do.
  var wanted = new URLSearchParams(window.location.search).get('filter');
  var preset = wanted && tabs.filter(function (tab) {
    return tab.getAttribute('data-filter') === wanted;
  })[0];
  if (preset) {
    tabs.forEach(function (other) { other.classList.remove('is-active'); });
    preset.classList.add('is-active');
    filter = wanted;
    apply();
  }

  if (search) search.addEventListener('input', apply);
})();
</script>`;
