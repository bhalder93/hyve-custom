/**
 * Invoices page. Every figure comes from `loadInvoices`, which derives it from
 * the payment schedule Shopify already holds on each Net 30 order.
 */
import { esc } from "./account-shell.server";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "paid", label: "Paid" },
  { key: "overdue", label: "Overdue" },
];

export function invoicesPage({
  invoices = [],
  storeCredit = "",
  storeCreditUsed = "",
  storeCreditIssued = "",
  storeCreditPercentUsed = null,
  paymentTerms = "",
  salesRep = "",
  salesRepEmail = "",
  salesRepPhone = "",
  tier = "",
} = {}) {
  return `
    <div class="hyve-inv" data-invoices>
      <h1 class="hyve-inv__title">Invoices</h1>
      <p class="hyve-inv__sub">View and download your invoices</p>

      ${creditPanel({ storeCredit, storeCreditUsed, storeCreditIssued, storeCreditPercentUsed, paymentTerms, tier })}
      ${salesRep ? repBar(salesRep, salesRepEmail, salesRepPhone) : ""}

      <div class="hyve-inv__card">
        <div class="hyve-inv__controls">
          <label class="hyve-inv__search">
            ${icoSearch()}
            <input type="search" placeholder="Search invoices..." aria-label="Search invoices" data-inv-search>
          </label>
          <div class="hyve-inv__tabs" role="group" aria-label="Filter invoices">
            ${FILTERS.map(
              (f, i) => `<button type="button" class="hyve-inv__tab${i === 0 ? " is-active" : ""}" data-filter="${f.key}">${esc(f.label)}</button>`,
            ).join("")}
          </div>
        </div>

        ${
          invoices.length
            ? `<div class="hyve-inv__list">${invoices.map(row).join("")}</div>
               <p class="hyve-inv__none" hidden>No invoices match your search.</p>`
            : `<div class="hyve-inv__empty">No invoices yet. Orders placed on payment terms will appear here.</div>`
        }
      </div>
    </div>
    ${INVOICE_STYLES}
    ${INVOICE_SCRIPT}`;
}

/**
 * Store credit is Shopify's own prepaid balance on the company location, which
 * Shopify redeems at checkout. There is no outstanding total or payment
 * breakdown here: Shopify gives a buyer no way to settle a terms balance
 * themselves, so a figure they can't act on doesn't belong on the page.
 */
function creditPanel({
  storeCredit,
  storeCreditUsed,
  storeCreditIssued,
  storeCreditPercentUsed,
  paymentTerms,
  tier,
}) {
  if (!storeCredit && !paymentTerms) return "";

  const hasBar = Number.isFinite(storeCreditPercentUsed);

  return `
    <div class="hyve-inv__summary">
      <section class="hyve-inv__panel">
        <div class="hyve-inv__panel-head">
          <span class="hyve-inv__label">Store Credit Available</span>
          ${tier ? `<span class="hyve-inv__tier">${esc(tier)}</span>` : ""}
        </div>
        ${storeCredit ? `<span class="hyve-inv__big hyve-inv__big--credit">${esc(storeCredit)}</span>` : ""}
        <span class="hyve-inv__muted">Applied automatically at checkout</span>
        ${
          storeCreditUsed
            ? `<div class="hyve-inv__credit-grid">
                 <div><span class="hyve-inv__muted">Issued</span><strong>${esc(storeCreditIssued)}</strong></div>
                 <div><span class="hyve-inv__muted">Used</span><strong>${esc(storeCreditUsed)}</strong></div>
               </div>`
            : ""
        }
        ${
          paymentTerms
            ? `<div class="hyve-inv__terms"><span class="hyve-inv__muted">Terms</span><strong>${esc(paymentTerms)}</strong></div>`
            : ""
        }
        ${hasBar ? `<div class="hyve-inv__meter"><span style="width:${esc(storeCreditPercentUsed)}%"></span></div>` : ""}
        ${
          hasBar
            ? `<div class="hyve-inv__meter-legend">
                 <span class="hyve-inv__muted">${esc(storeCreditUsed)} used</span>
                 <span class="hyve-inv__free">${esc(Math.round((100 - storeCreditPercentUsed) * 10) / 10)}% left</span>
               </div>`
            : ""
        }
      </section>
    </div>`;
}

function repBar(salesRep, email, phone) {
  // Each button only appears when the rep actually has that contact detail on
  // their company location, so nothing on the page is a dead link.
  const wa = String(phone || "").replace(/[^0-9]/g, "");

  return `
    <section class="hyve-inv__rep">
      <span class="hyve-inv__rep-avatar">${esc(initials(salesRep))}</span>
      <div class="hyve-inv__rep-main">
        <p><strong>${esc(salesRep)}</strong> <span class="hyve-inv__muted">— Your Dedicated Sales Representative</span></p>
        <p class="hyve-inv__muted">Need help with custom terms, bundles or a wraparound quote?</p>
      </div>
      <div class="hyve-inv__rep-actions">
        ${
          wa
            ? `<a class="hyve-inv__btn" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">${icoChat()}<span>Chat on WhatsApp</span></a>`
            : ""
        }
        ${
          email
            ? `<a class="hyve-inv__btn" href="mailto:${esc(email)}">${icoMail()}<span>Email Representative</span></a>`
            : ""
        }
      </div>
    </section>`;
}

function row(inv) {
  const tone = inv.status === "paid" ? "ok" : inv.status === "overdue" ? "error" : "warn";
  const label = inv.status === "paid" ? "Paid" : inv.status === "overdue" ? "Overdue" : "Pending";
  const haystack = [inv.reference, inv.orderName, inv.items, label].join(" ").toLowerCase();

  return `
    <article class="hyve-inv__row" data-status="${esc(inv.status)}" data-search="${esc(haystack)}">
      <div class="hyve-inv__row-main">
        <div class="hyve-inv__row-head">
          <span class="hyve-inv__ref">${esc(inv.reference)}</span>
          <span class="hyve-inv__badge hyve-inv__badge--${tone}">${esc(label)}</span>
        </div>
        <p class="hyve-inv__row-items">Order ${esc(inv.orderName)}${inv.items ? ` — ${esc(inv.items)}` : ""}</p>
        <p class="hyve-inv__row-dates">
          Issued: ${esc(inv.issuedLabel)}
          ${inv.status === "paid" ? ` &middot; Paid: ${esc(inv.paidLabel)}` : ` &middot; <span class="${inv.status === "overdue" ? "is-overdue" : "is-due"}">Due: ${esc(inv.dueLabel)}</span>`}
        </p>
      </div>
      <span class="hyve-inv__amt">${esc(inv.totalLabel)}</span>
      <div class="hyve-inv__row-actions">
        ${
          inv.downloadHref
            ? `<a class="hyve-inv__btn" href="${esc(inv.downloadHref)}">${icoDownload()}<span>Download</span></a>`
            : ""
        }
      </div>
    </article>`;
}

function initials(name) {
  return String(name)
    .split(/\s+/)
    .map((p) => p[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
function icoSearch() { return svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'); }
function icoDownload() { return svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'); }
function icoMail() { return svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'); }
function icoChat() { return svg('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.9-.9L3 20.5l1.5-4.6A8.4 8.4 0 0 1 3.6 11.5a8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 9 8.4Z"/>'); }

const INVOICE_STYLES = `
<style>
  .hyve-inv__title { font-family: var(--hyve-display); font-size: 22px; font-weight: 800; margin: 0; }
  .hyve-inv__sub { color: var(--hyve-muted); font-size: 13px; margin: 2px 0 20px; }
  .hyve-inv__summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
  .hyve-inv__panel { background: var(--hyve-white); border: 1px solid var(--hyve-border); border-radius: var(--hyve-radius); padding: 18px 20px; display: flex; flex-direction: column; gap: 6px; }
  .hyve-inv__label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--hyve-muted); }
  .hyve-inv__big { font-family: var(--hyve-display); font-size: 26px; font-weight: 800; line-height: 1.15; }
  .hyve-inv__big--credit { color: #15803D; }
  .hyve-inv__muted { font-size: 11.5px; color: var(--hyve-muted); display: inline-flex; align-items: center; gap: 5px; }
  .hyve-inv__muted svg { width: 13px; height: 13px; }

  .hyve-inv__credit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
  .hyve-inv__credit-grid div { display: flex; flex-direction: column; background: #F8FAFC; border-radius: 8px; padding: 8px 10px; }
  .hyve-inv__credit-grid strong { font-size: 13px; font-weight: 700; }
  .hyve-inv__meter { height: 6px; border-radius: 9999px; background: #E2E8F0; overflow: hidden; margin-top: 6px; }
  .hyve-inv__meter span { display: block; height: 100%; background: var(--hyve-gradient); }
  .hyve-inv__meter-legend { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .hyve-inv__free { font-size: 11.5px; font-weight: 700; color: #15803D; }
  .hyve-inv__panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .hyve-inv__tier { background: #FEF3C7; color: #B45309; border-radius: 9999px; padding: 3px 10px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
  .hyve-inv__terms { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--hyve-border); margin-top: 8px; padding-top: 10px; }
  .hyve-inv__terms strong { font-size: 12.5px; font-weight: 700; }

  .hyve-inv__rep { display: flex; align-items: center; gap: 12px; background: var(--hyve-white); border: 1px solid var(--hyve-border); border-radius: var(--hyve-radius); padding: 14px 18px; margin-bottom: 14px; }
  .hyve-inv__rep-avatar { width: 34px; height: 34px; border-radius: 9999px; background: var(--hyve-gradient); color: #0A1414; display: inline-flex; align-items: center; justify-content: center; font-family: var(--hyve-display); font-weight: 800; font-size: 12px; flex-shrink: 0; }
  .hyve-inv__rep-main { flex: 1; min-width: 0; }
  .hyve-inv__rep strong { font-size: 13px; }
  .hyve-inv__rep p { margin: 2px 0 0; }
  .hyve-inv__rep-main p:first-child { margin: 0; }
  .hyve-inv__rep-actions { display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0; }

  .hyve-inv__card { background: var(--hyve-white); border: 1px solid var(--hyve-border); border-radius: var(--hyve-radius); padding: 0; overflow: hidden; }
  .hyve-inv__controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 16px; }
  .hyve-inv__search { display: flex; align-items: center; gap: 8px; flex: 0 1 240px; padding: 0 14px; height: 36px; border: 1px solid var(--hyve-border-strong); border-radius: 9999px; background: rgba(15,23,42,0.03); }
  .hyve-inv__search svg { width: 16px; height: 16px; color: var(--hyve-muted); flex-shrink: 0; }
  .hyve-inv__search input { border: 0; outline: none; background: transparent; width: 100%; font-size: 13px; font-family: inherit; color: var(--hyve-900); }
  .hyve-inv__tabs { display: flex; flex-wrap: wrap; gap: 6px; }
  .hyve-inv__tab { border: 0; background: rgba(15,23,42,0.04); color: var(--hyve-500); border-radius: 9999px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
  .hyve-inv__tab.is-active { background: linear-gradient(135deg, rgba(163,234,110,0.15) 0%, rgba(110,222,225,0.15) 100%); color: var(--hyve-900); font-weight: 700; }

  .hyve-inv__list { display: flex; flex-direction: column; padding: 16px; }
  .hyve-inv__row { display: flex; align-items: center; gap: 14px; padding: 14px 4px; border-top: 1px solid var(--hyve-border); }
  .hyve-inv__row[hidden] { display: none; }
  .hyve-inv__row:first-child { border-top: 0; }
  .hyve-inv__row-main { flex: 1; min-width: 0; }
  .hyve-inv__row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .hyve-inv__ref { font-family: var(--hyve-display); font-size: 14px; font-weight: 700; }
  .hyve-inv__badge { border-radius: 9999px; padding: 2px 9px; font-size: 11px; font-weight: 700; }
  .hyve-inv__badge--ok { background: #DCFCE7; color: #15803D; }
  .hyve-inv__badge--warn { background: #FEF3C7; color: #B45309; }
  .hyve-inv__badge--error { background: #FEE2E2; color: #B91C1C; }
  .hyve-inv__row-items { font-size: 12.5px; color: var(--hyve-700); margin: 3px 0 0; }
  .hyve-inv__row-dates { font-size: 11.5px; color: var(--hyve-muted); margin: 2px 0 0; }
  .hyve-inv__row-dates .is-overdue { color: #B91C1C; font-weight: 600; }
  .hyve-inv__row-dates .is-due { color: #B45309; font-weight: 600; }
  .hyve-inv__amt { font-family: var(--hyve-display); font-size: 15px; font-weight: 800; white-space: nowrap; }
  .hyve-inv__btn { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--hyve-border-strong); color: var(--hyve-500); background: #fff; text-decoration: none; font-size: 11.5px; font-weight: 600; padding: 6px 12px; border-radius: 6px; }
  .hyve-inv__btn svg { width: 14px; height: 14px; }
  .hyve-inv__row-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .hyve-inv__none, .hyve-inv__empty { border: 1px dashed #CBD5E1; border-radius: var(--hyve-radius); padding: 36px 20px; text-align: center; color: var(--hyve-muted); font-size: 13px; margin: 16px; }
  .hyve-inv__none[hidden] { display: none; }

  @media (max-width: 980px) { .hyve-inv__summary { grid-template-columns: 1fr; } }
  @media (max-width: 860px) {
    .hyve-inv__rep { flex-wrap: wrap; }
    .hyve-inv__rep-actions { width: 100%; }
  }
  @media (max-width: 700px) {
    .hyve-inv__row { flex-wrap: wrap; }
    .hyve-inv__row-actions { width: 100%; }
  }
</style>`;

const INVOICE_SCRIPT = `
<script>
(function () {
  var root = document.querySelector('[data-invoices]');
  if (!root) return;
  var rows = Array.prototype.slice.call(root.querySelectorAll('.hyve-inv__row'));
  var tabs = Array.prototype.slice.call(root.querySelectorAll('.hyve-inv__tab'));
  var search = root.querySelector('[data-inv-search]');
  var none = root.querySelector('.hyve-inv__none');
  var filter = 'all';

  function apply() {
    var q = ((search && search.value) || '').trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (row) {
      var okTab = filter === 'all' || row.getAttribute('data-status') === filter;
      var okQ = !q || (row.getAttribute('data-search') || '').indexOf(q) !== -1;
      row.hidden = !(okTab && okQ);
      if (!row.hidden) shown += 1;
    });
    if (none) none.hidden = shown !== 0 || rows.length === 0;
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.remove('is-active'); });
      tab.classList.add('is-active');
      filter = tab.getAttribute('data-filter') || 'all';
      apply();
    });
  });
  if (search) search.addEventListener('input', apply);
})();
</script>`;
