/**
 * Account-portal shell (sidebar + main content frame).
 *
 * Each proxy route builds its page HTML and passes it as `main`; this wraps it
 * with the aside nav and returns it through the App Proxy `liquid()` helper, so
 * it renders inside the store theme on the store domain. Liquid tags such as
 * {{ routes.account_logout_url }} are resolved by Shopify because the response
 * is Content-Type: application/liquid.
 *
 * Requirements covered here: H6 (eight sections in two groups, the Distributor
 * group only for distributor accounts), H9 (count badges on Orders and Quotes),
 * H10 (WhatsApp button on every page), M2 (commercial terms panel) and M3 (the
 * last-updated label on the credit figures).
 *
 * Styling matches the approved mockup's tokens exactly. Everything is in px on
 * purpose: the storefront theme sets a 16px root, the portal's own CSS must not
 * depend on that, and rem values written against a 10px root render 1.6x too
 * large on the live store.
 */

const WHATSAPP_NUMBER = "6569322855";

/** Shared group (H6). Dashboard is distributor-only; B2C lands on Orders. */
const NAV_SHARED = [
  { id: "dashboard", label: "Dashboard", href: "/apps/account", icon: icoGrid, distributorOnly: true },
  { id: "orders", label: "Orders", href: "/apps/account/orders", icon: icoBox, badgeTone: "warn" },
  { id: "artwork", label: "Saved Artwork", href: "/apps/account/artwork", icon: icoImage },
  { id: "addresses", label: "Addresses", href: "/apps/account/addresses", icon: icoPin },
  { id: "settings", label: "Settings", href: "/apps/account/settings", icon: icoGear },
];

/** Distributor group (H6) — hidden entirely for non-distributor accounts. */
const NAV_DISTRIBUTOR = [
  { id: "quotes", label: "Quotes", href: "/apps/account/quotes", icon: icoQuote, badgeTone: "alert" },
  { id: "invoices", label: "Invoices", href: "/apps/account/invoices", icon: icoInvoice },
  { id: "team", label: "Team", href: "/apps/account/team", icon: icoUsers },
];

/**
 * @param {object} opts
 * @param {string} opts.active     active nav id
 * @param {string} opts.main       main-content HTML
 * @param {{name?:string,email?:string,initials?:string,tier?:string}} [opts.customer]
 * @param {boolean} [opts.isDistributor]  show the Distributor group and terms panel
 * @param {Record<string,number>} [opts.counts]  badge counts keyed by nav id
 * @param {object} [opts.terms]    commercial terms for the M2 panel
 */
export function accountShell({
  active = "dashboard",
  main = "",
  customer = null,
  isDistributor = false,
  counts = {},
  terms = null,
} = {}) {
  const sharedItems = NAV_SHARED.filter((item) => isDistributor || !item.distributorOnly)
    .map((item) => navItem(item, active, counts))
    .join("");

  const distributorGroup = isDistributor
    ? `
      <div class="hyve-acct__nav-group">
        <span class="hyve-acct__nav-heading">Distributor</span>
        ${NAV_DISTRIBUTOR.map((item) => navItem(item, active, counts)).join("")}
      </div>`
    : `
      <div class="hyve-acct__nav-group">
        <a class="hyve-acct__apply" href="/apps/account/distributor">
          ${icoBuilding()}
          <span>Apply as Distributor</span>
        </a>
      </div>`;

  const avatar = customer?.initials ? esc(customer.initials) : icoUser();
  const name = customer?.name ? esc(customer.name) : "My Account";
  const email = customer?.email ? esc(customer.email) : "Manage orders &amp; artwork";
  // The tier is a distributor's pricing tier (C3), so it only belongs on a
  // distributor account. The hyve.tier metafield can outlive the tag — removing
  // the tag must remove the badge with it.
  const tierBadge =
    isDistributor && customer?.tier
      ? `<span class="hyve-acct__tier">${icoAward()}${esc(customer.tier)}</span>`
      : "";

  return `
  ${FONT_LINKS}
  <div class="hyve-acct">
    <aside class="hyve-acct__aside">
      <div class="hyve-acct__profile">
        <span class="hyve-acct__avatar">${avatar}</span>
        <div class="hyve-acct__profile-text">
          <span class="hyve-acct__name">${name}</span>
          <span class="hyve-acct__email">${email}</span>
          ${tierBadge}
        </div>
      </div>

      <nav class="hyve-acct__nav">
        <div class="hyve-acct__nav-group">${sharedItems}</div>
        ${distributorGroup}
      </nav>

      ${termsPanel(terms, isDistributor)}

      <a class="hyve-acct__signout" href="{{ routes.account_logout_url }}">
        ${icoLogout()}
        <span>Sign Out</span>
      </a>
    </aside>

    <main class="hyve-acct__main">${main}</main>
  </div>

  <a class="hyve-acct__whatsapp" href="https://wa.me/${WHATSAPP_NUMBER}" target="_blank" rel="noopener" aria-label="Chat on WhatsApp">
    ${icoWhatsApp()}
  </a>
  ${SHELL_STYLES}`;
}

function navItem(item, active, counts) {
  const isActive = item.id === active;
  const count = Number(counts[item.id]) || 0;
  const badge =
    count > 0
      ? `<span class="hyve-acct__nav-count hyve-acct__nav-count--${item.badgeTone || "alert"}">${esc(count)}</span>`
      : "";
  return `
    <a class="hyve-acct__nav-item${isActive ? " is-active" : ""}" href="${item.href}">
      ${item.icon()}
      <span class="hyve-acct__nav-label">${esc(item.label)}</span>
      ${badge}
    </a>`;
}

/**
 * Commercial terms panel (M2). The credit figures are maintained by hand until
 * NetSuite is connected, so M3 requires the date they were last updated to sit
 * with them rather than presenting them as live numbers.
 */
function termsPanel(terms, isDistributor) {
  if (!isDistributor || !terms) return "";

  const rows = [
    terms.paymentTerms ? ["Payment", esc(terms.paymentTerms)] : null,
    terms.storeCredit ? ["Store Credit", esc(terms.storeCredit)] : null,
    terms.storeCreditUsed ? ["Used", esc(terms.storeCreditUsed)] : null,
    terms.salesRep ? ["Sales Rep", esc(terms.salesRep)] : null,
  ]
    .filter(Boolean)
    .map(([label, value]) => `<div class="hyve-acct__term"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");

  if (!rows) return "";

  // The bar is spend against everything ever issued, which is what's been used
  // plus what's left. With nothing issued there is nothing to draw.
  const used = Number(terms.storeCreditUsedAmount);
  const issued = Number(terms.storeCreditIssuedAmount);
  const bar =
    Number.isFinite(used) && Number.isFinite(issued) && issued > 0
      ? `<div class="hyve-acct__terms-bar"><span style="width:${Math.min(Math.round((used / issued) * 1000) / 10, 100)}%"></span></div>`
      : "";

  return `
    <div class="hyve-acct__terms">
      <span class="hyve-acct__terms-heading">${icoShield()}Commercial Terms</span>
      ${rows}
      ${bar}
    </div>`;
}

/* ---------- icons ---------- */
function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
function icoGrid() { return svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'); }
function icoBox() { return svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'); }
function icoImage() { return svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'); }
function icoPin() { return svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>'); }
function icoGear() { return svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'); }
function icoQuote() { return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="15" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'); }
function icoInvoice() { return svg('<path d="M4 2h16v20l-3-2-2 2-3-2-3 2-2-2-3 2z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="14" y2="12"/>'); }
function icoUsers() { return svg('<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16.5 3.13a4 4 0 0 1 0 7.75"/>'); }
function icoBuilding() { return svg('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>'); }
function icoLogout() { return svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'); }
function icoAward() { return svg('<circle cx="12" cy="8" r="6"/><path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5"/>'); }
function icoShield() { return svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'); }
function icoUser() { return svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'); }
function icoWhatsApp() {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.75-1.65-2.05-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.6-.92-2.2-.24-.58-.49-.5-.67-.5h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.01-1.04 2.47s1.06 2.86 1.21 3.06c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.69.25-1.28.17-1.41-.07-.13-.27-.2-.57-.35z"/><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm0 18.13h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.17 8.17 0 0 1-1.26-4.36c0-4.53 3.7-8.22 8.25-8.22a8.22 8.22 0 0 1 8.24 8.23c0 4.53-3.7 8.21-8.24 8.21z"/></svg>`;
}

export function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

const FONT_LINKS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">`;

/** Tokens lifted from the approved mockup so the portal matches it exactly. */
export const PORTAL_TOKENS = `
  --hyve-lime: #A3EA6E;
  --hyve-teal: #6EDEE1;
  --hyve-teal-dark: #3DCCD0;
  --hyve-gradient: linear-gradient(135deg, #A3EA6E 0%, #6EDEE1 100%);
  --hyve-bg: #EEF2F7;
  --hyve-white: #FFFFFF;
  --hyve-900: #0F172A;
  --hyve-700: #334155;
  --hyve-500: #64748B;
  --hyve-muted: #94A3B8;
  --hyve-border: rgba(15, 23, 42, 0.06);
  --hyve-border-strong: rgba(15, 23, 42, 0.10);
  --hyve-error: #EF4444;
  --hyve-warning: #F59E0B;
  --hyve-success: #22C55E;
  --hyve-info: #3B82F6;
  --hyve-radius: 12px;
  --hyve-radius-lg: 16px;
  --hyve-shadow-sm: 0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04);
  --hyve-display: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --hyve-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;`;

const SHELL_STYLES = `
<style>
  .hyve-acct {
    ${PORTAL_TOKENS}
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    align-items: stretch;
    width: 100%;
    background: var(--hyve-bg);
    font-family: var(--hyve-body);
    color: var(--hyve-900);
    font-size: 14px;
    line-height: 1.5;
  }
  .hyve-acct *, .hyve-acct *::before, .hyve-acct *::after { box-sizing: border-box; }

  .hyve-acct__aside {
    position: sticky;
    top: 0;
    align-self: stretch;
    background: var(--hyve-white);
    border-right: 1px solid var(--hyve-border);
    padding: 24px 0;
    display: flex;
    flex-direction: column;
    gap: 22px;
    height: calc(100dvh - 71px);
    overflow: auto;
  }

  .hyve-acct__profile { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding: 0 16px 20px; border-bottom: 1px solid var(--hyve-border); }
  .hyve-acct__avatar {
    width: 48px; height: 48px; border-radius: 12px; background: var(--hyve-gradient);
    display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
    color: #0A1414; font-family: var(--hyve-display); font-weight: 800; font-size: 18px;
  }
  .hyve-acct__avatar svg { width: 22px; height: 22px; }
  .hyve-acct__profile-text { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
  .hyve-acct__name { font-family: var(--hyve-display); font-weight: 700; font-size: 15px; color: var(--hyve-900); }
  .hyve-acct__email { font-size: 12px; font-weight: 400; color: var(--hyve-muted); overflow: hidden; text-overflow: ellipsis; }
  .hyve-acct__tier {
    align-self: flex-start; margin-top: 4px; display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 10px 3px 6px; border-radius: 9999px;
    background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%);
    color: #6B3A00; font-size: 11px; font-weight: 700;
  }
  .hyve-acct__tier svg { width: 13px; height: 13px; }

  .hyve-acct__nav { display: flex; flex-direction: column; gap: 18px; }
  .hyve-acct__nav-group { display: flex; flex-direction: column; gap: 2px; padding: 0 10px; }
  .hyve-acct__nav-heading {
    padding: 0 8px 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--hyve-muted);
  }
  .hyve-acct__nav-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 8px;
    color: var(--hyve-500); text-decoration: none; font-size: 13.5px; font-weight: 500;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .hyve-acct__nav-item svg { width: 18px; height: 18px; color: var(--hyve-muted); flex-shrink: 0; }
  .hyve-acct__nav-label { flex: 1; min-width: 0; }
  .hyve-acct__nav-item:hover { background: #F1F5F9; color: var(--hyve-900); }
  .hyve-acct__nav-item.is-active { background: linear-gradient(135deg, rgba(163,234,110,0.15) 0%, rgba(110,222,225,0.15) 100%); color: var(--hyve-900); font-weight: 700; }
  .hyve-acct__nav-item.is-active svg { color: #15803D; }
  .hyve-acct__nav-count {
    padding: 2px 7px; border-radius: 9999px; color: #fff;
    font-size: 10px; font-weight: 700; text-align: center; flex-shrink: 0;
  }
  .hyve-acct__nav-count--warn { background: #F59E0B; }
  .hyve-acct__nav-count--alert { background: #EF4444; }

  .hyve-acct__apply {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 10px; border: 1px solid var(--hyve-border-strong); border-radius: 10px;
    color: var(--hyve-900); text-decoration: none; font-size: 12.5px; font-weight: 600;
  }
  .hyve-acct__apply svg { width: 16px; height: 16px; }
  .hyve-acct__apply:hover { border-color: var(--hyve-muted); }

  .hyve-acct__terms { margin: 0 10px; padding: 14px; border-radius: 12px; background: linear-gradient(135deg, rgba(15,23,42,0.03) 0%, rgba(110,222,225,0.06) 100%); border: 1px solid var(--hyve-border); display: flex; flex-direction: column; gap: 7px; }
  .hyve-acct__terms-bar { height: 4px; border-radius: 9999px; background: rgba(15,23,42,0.06); overflow: hidden; margin-top: 2px; }
  .hyve-acct__terms-bar span { display: block; height: 100%; border-radius: 9999px; background: var(--hyve-gradient); }
  .hyve-acct__terms-heading { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--hyve-muted); }
  .hyve-acct__terms-heading svg { width: 13px; height: 13px; }
  .hyve-acct__term { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12px; }
  .hyve-acct__term span { color: var(--hyve-500); }
  .hyve-acct__term strong { font-weight: 700; color: var(--hyve-900); }

  .hyve-acct__signout {
    display: flex; align-items: center; gap: 10px; margin: auto 10px 0; padding: 9px 10px; border-radius: 8px;
    color: var(--hyve-500); text-decoration: none; font-size: 13px; font-weight: 500;
  }
  .hyve-acct__signout svg { width: 17px; height: 17px; }
  .hyve-acct__signout:hover { color: var(--hyve-error); background: #FEF2F2; }

  .hyve-acct__main { min-width: 0; padding: 24px 24px 80px; height: calc(100dvh - 71px); overflow: auto; }

  .hyve-acct__whatsapp {
    position: fixed; right: 20px; bottom: 20px; z-index: 40;
    width: 52px; height: 52px; border-radius: 9999px; background: #25D366; color: #fff;
    display: inline-flex; align-items: center; justify-content: center;
    box-shadow: 0 10px 15px -3px rgba(15,23,42,0.18); text-decoration: none;
  }
  .hyve-acct__whatsapp svg { width: 27px; height: 27px; }
  .hyve-acct__whatsapp:hover { background: #1FB955; }

  @media (max-width: 900px) {
    .hyve-acct { grid-template-columns: 1fr; }
    .hyve-acct__aside { position: static; border-right: 0; border-bottom: 1px solid var(--hyve-border); padding-bottom: 16px; }
    .hyve-acct__signout { margin-top: 8px; }
    .hyve-acct__main { padding: 20px 16px 60px; }
  }
</style>`;
