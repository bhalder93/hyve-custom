/**
 * Distributor dashboard — the landing page for a distributor account (A4).
 *
 * H1 specifies the layout: four summary cards, five quick actions, a payment
 * due banner, and a recent orders list. Two corrections to the mockup apply:
 *  - K5  the Pay Now button is hidden at launch, not shown inactive.
 *  - K11 the bank remittance details take its place on the banner.
 *
 * Cards whose source system does not exist yet (quotes, invoices) render an
 * honest zero or empty state rather than a placeholder figure.
 */
import { esc } from "./account-shell.server";
import { orderRow, ORDER_ROW_STYLES } from "./account-orders.server";
import { orderModal, MODAL_STYLES, MODAL_SCRIPT } from "./account-order-modal.server";

const QUICK_ACTIONS = [
  { label: "Reorder", href: "/apps/account/orders", icon: icoRepeat },
  { label: "Track Order", href: "/apps/account/orders?filter=shipped", icon: icoTruck },
  { label: "Upload Artwork", href: "/apps/account/artwork", icon: icoUpload },
  { label: "Get a Quote", href: "/apps/account/quotes", icon: icoQuote },
  { label: "Contact Support", href: "https://hyve.promo/pages/contact", icon: icoSupport },
];

/**
 * @param {object} opts
 * @param {{firstName?:string}} [opts.customer]
 * @param {{totalOrders:number, pendingProofs:number, activeQuotes:number,
 *          storeCredit:?string}} opts.stats
 * @param {?object} [opts.payment]  outstanding invoice, when one is known
 * @param {Array<object>} [opts.recentOrders]
 */
export function dashboardPage({ customer = null, stats = {}, payment = null, recentOrders = [] } = {}) {
  const firstName = customer?.firstName || customer?.name || "";

  return `
    ${DASHBOARD_STYLES}
    <div class="hyve-dash">
      <h1 class="hyve-dash__title">Welcome back${firstName ? `, ${esc(firstName)}` : ""}</h1>
      <p class="hyve-dash__sub">Here's what's happening with your orders</p>

      <div class="hyve-dash__stats">
        ${statCard(icoBox(), "lime", stats.totalOrders ?? 0, "Total Orders")}
        ${statCard(icoClock(), "amber", stats.pendingProofs ?? 0, "Pending Proofs")}
        ${statCard(icoQuote(), "blue", stats.activeQuotes ?? 0, "Active Quotes")}
        ${statCard(
          icoWallet(),
          "teal",
          stats.storeCredit || "&mdash;",
          "Store Credit",
          // M3: the figure never appears undated.
          // stats.storeCreditIssuedAt ? `Issued ${esc(stats.storeCreditIssuedAt)}` : "",
        )}
      </div>

      <div class="hyve-dash__actions">
        ${QUICK_ACTIONS.map(
          (a) => `
          <a class="hyve-dash__action" href="${a.href}">
            <span class="hyve-dash__action-icon">${a.icon()}</span>
            <span class="hyve-dash__action-label">${esc(a.label)}</span>
          </a>`,
        ).join("")}
      </div>

      ${paymentBanner(payment)}

      <section class="hyve-dash__panel">
        <div class="hyve-dash__panel-head">
          <h2 class="hyve-dash__panel-title">Recent Orders</h2>
          <a class="hyve-dash__view-all" href="/apps/account/orders">View All</a>
        </div>
        ${
          recentOrders.length
            ? `<div class="hyve-ord__list">${recentOrders.map((o) => orderRow(o)).join("")}</div>`
            : `<div class="hyve-dash__empty">Your orders will appear here.</div>`
        }
      </section>
    </div>
    ${recentOrders.map(orderModal).join("")}
    ${MODAL_SCRIPT}`;
}

function statCard(icon, tone, value, label, note = "") {
  return `
    <div class="hyve-dash__stat">
      <span class="hyve-dash__stat-icon hyve-dash__stat-icon--${tone}">${icon}</span>
      <span class="hyve-dash__stat-value">${typeof value === "number" ? esc(value) : value}</span>
      <span class="hyve-dash__stat-label">${esc(label)}</span>
      ${note ? `<span class="hyve-dash__stat-note">${note}</span>` : ""}
    </div>`;
}

/**
 * K11: until online payment arrives in Release 2 the banner carries the bank
 * transfer details — account name, bank, account number and the reference to
 * quote — and they take the place of the Pay Now button rather than sitting
 * alongside it (K5).
 */
function paymentBanner(payment) {
  if (!payment) return "";

  const remittance = payment.remittance;
  const details = remittance
    ? `
      <div class="hyve-dash__remit">
        <span class="hyve-dash__remit-head">Pay by bank transfer</span>
        <div class="hyve-dash__remit-grid">
          ${remitRow("Account name", remittance.accountName)}
          ${remitRow("Bank", remittance.bank)}
          ${remitRow("Account number", remittance.accountNumber)}
          ${remitRow("Reference", remittance.reference)}
        </div>
      </div>`
    : "";

  return `
    <section class="hyve-dash__payment">
      <div class="hyve-dash__payment-main">
        <span class="hyve-dash__payment-icon">${icoCard()}</span>
        <div>
          <p class="hyve-dash__payment-title">${esc(payment.headline)}</p>
          <p class="hyve-dash__payment-sub">${esc(payment.detail)}</p>
        </div>
        <div class="hyve-dash__payment-amount">
          <span class="hyve-dash__payment-total">${esc(payment.amount)}</span>
          <span class="hyve-dash__payment-word">outstanding</span>
        </div>
      </div>
      ${details}
    </section>`;
}

function remitRow(label, value) {
  if (!value) return "";
  return `<div class="hyve-dash__remit-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

/* ---------- icons ---------- */
function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
function icoBox() { return svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'); }
function icoClock() { return svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>'); }
function icoQuote() { return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="15" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'); }
function icoWallet() { return svg('<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>'); }
function icoRepeat() { return svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'); }
function icoTruck() { return svg('<path d="M10 17V6a1 1 0 0 0-1-1H2v11h2"/><path d="M14 17h-4"/><path d="M20 17h2v-4l-3-4h-5v8h2"/><circle cx="7" cy="17.5" r="2.5"/><circle cx="17" cy="17.5" r="2.5"/>'); }
function icoUpload() { return svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'); }
function icoSupport() { return svg('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'); }
function icoCard() { return svg('<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>'); }

const DASHBOARD_STYLES = `
<style>
  .hyve-dash__title { font-family: var(--hyve-display); font-size: 22px; font-weight: 800; margin: 0 0 3px; }
  .hyve-dash__sub { color: var(--hyve-500); font-size: 13px; margin: 0 0 20px; }

  .hyve-dash__stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
  .hyve-dash__stat { display: flex; flex-direction: column; gap: 2px; background: var(--hyve-white); border: 1px solid var(--hyve-border); border-radius: var(--hyve-radius); padding: 20px; }
  .hyve-dash__stat-icon { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 10px; margin-bottom: 14px; }
  .hyve-dash__stat-icon svg { width: 19px; height: 19px; }
  .hyve-dash__stat-icon--lime { background: rgba(163,234,110,0.22); color: #4D7C0F; }
  .hyve-dash__stat-icon--amber { background: #FEF3C7; color: #B45309; }
  .hyve-dash__stat-icon--blue { background: #DBEAFE; color: #1D4ED8; }
  .hyve-dash__stat-icon--teal { background: rgba(110,222,225,0.25); color: #0F766E; }
  .hyve-dash__stat-value { font-family: var(--hyve-display); font-size: 26px; font-weight: 800; color: var(--hyve-900); line-height: 1.15; }
  .hyve-dash__stat-label { font-size: 12.5px; font-weight: 500; color: var(--hyve-muted); }
  .hyve-dash__stat-note { font-size: 10.5px; color: var(--hyve-muted); margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--hyve-border-strong); }

  .hyve-dash__actions { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
  .hyve-dash__action { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: var(--hyve-white); border: 1px solid var(--hyve-border); border-radius: var(--hyve-radius); padding: 20px 10px; text-decoration: none; color: var(--hyve-900); transition: border-color 0.15s ease, transform 0.15s ease; }
  .hyve-dash__action:hover { border-color: var(--hyve-teal-dark); transform: translateY(-1px); }
  .hyve-dash__action-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--hyve-900); }
  .hyve-dash__action-icon svg { width: 24px; height: 24px; stroke-width: 1.6; }
  .hyve-dash__action-label { font-size: 13px; font-weight: 600; text-align: center; }

  .hyve-dash__payment { background: var(--hyve-white); border: 1px solid var(--hyve-border); border-left: 3px solid var(--hyve-warning); border-radius: var(--hyve-radius); padding: 16px; margin-bottom: 14px; }
  .hyve-dash__payment-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .hyve-dash__payment-icon { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; background: #FEF3C7; color: #B45309; flex-shrink: 0; }
  .hyve-dash__payment-icon svg { width: 18px; height: 18px; }
  .hyve-dash__payment-title { font-family: var(--hyve-display); font-size: 14.5px; font-weight: 700; margin: 0; }
  .hyve-dash__payment-sub { font-size: 12px; color: var(--hyve-muted); margin: 2px 0 0; }
  .hyve-dash__payment-amount { margin-left: auto; text-align: right; }
  .hyve-dash__payment-total { display: block; font-family: var(--hyve-display); font-size: 18px; font-weight: 800; }
  .hyve-dash__payment-word { font-size: 11px; color: var(--hyve-muted); }
  .hyve-dash__remit { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--hyve-border-strong); }
  .hyve-dash__remit-head { display: block; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--hyve-muted); margin-bottom: 8px; }
  .hyve-dash__remit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px 20px; }
  .hyve-dash__remit-row { display: flex; flex-direction: column; font-size: 12px; }
  .hyve-dash__remit-row span { color: var(--hyve-muted); font-size: 10.5px; }
  .hyve-dash__remit-row strong { font-weight: 700; color: var(--hyve-900); }

  .hyve-dash__panel { background: var(--hyve-white); border: 1px solid var(--hyve-border); border-radius: var(--hyve-radius); padding: 16px; }
  .hyve-dash__panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  .hyve-dash__panel-title { font-family: var(--hyve-display); font-size: 15px; font-weight: 800; margin: 0; }
  .hyve-dash__view-all { font-size: 12.5px; font-weight: 600; color: var(--hyve-teal-dark); text-decoration: none; }
  .hyve-dash__view-all:hover { text-decoration: underline; }
  .hyve-dash__empty { border: 1px dashed #CBD5E1; border-radius: var(--hyve-radius); padding: 32px 20px; text-align: center; color: var(--hyve-muted); font-size: 13px; }


  @media (max-width: 1080px) {
    .hyve-dash__actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (max-width: 760px) {
    .hyve-dash__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hyve-dash__actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hyve-dash__payment-amount { margin-left: 0; text-align: left; }
  }

  ${ORDER_ROW_STYLES}
  ${MODAL_STYLES}
</style>`;
