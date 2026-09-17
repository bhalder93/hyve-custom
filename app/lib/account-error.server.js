/**
 * Failure state for the account portal.
 *
 * Anything the proxy route returns with a non-2xx status is replaced by
 * Shopify's own "There was an error in the third-party application." page, so
 * every handled failure here returns HTTP 200 with this panel instead: an
 * explanation, a retry, and a way through to the native Shopify account pages
 * so the customer can still find their orders while we're broken.
 */
import { esc } from "./account-shell.server";

const SUPPORT_EMAIL = "support@hyve.promo";

/** Native Shopify account URL — Liquid resolves this (responses are application/liquid). */
const NATIVE_ACCOUNT_URL = "{{ routes.account_url }}";

/**
 * @param {object} [opts]
 * @param {string} [opts.heading]
 * @param {string} [opts.message]
 * @param {string} [opts.retryHref]  page to retry (defaults to the portal landing page)
 */
export function errorState({
  heading = "We couldn't load your orders",
  message = "This is usually temporary — our system may be busy or briefly offline. Please try again in a few minutes.",
  retryHref = "/apps/account",
} = {}) {
  return `
    <div class="hyve-fail">
      <span class="hyve-fail__icon">${icoCloudOff()}</span>
      <h2 class="hyve-fail__title">${esc(heading)}</h2>
      <p class="hyve-fail__text">${esc(message)}</p>

      <div class="hyve-fail__actions">
        <a class="hyve-fail__btn hyve-fail__btn--primary" href="${esc(retryHref)}">${icoRefresh()}<span>Try Again</span></a>
        <a class="hyve-fail__btn hyve-fail__btn--ghost" href="${NATIVE_ACCOUNT_URL}">${icoBox()}<span>Track Orders in Your Shopify Account</span></a>
      </div>

      <p class="hyve-fail__foot">
        Still stuck? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and we'll look into it.
      </p>
    </div>
    ${FAIL_STYLES}`;
}

/* ---------- icons ---------- */
function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
function icoCloudOff() { return svg('<path d="M22 15.5a4.5 4.5 0 0 0-4.5-4.5h-1.3A7 7 0 0 0 6.3 7.6"/><path d="M5 8.6A4.5 4.5 0 0 0 6.5 19h11"/><line x1="2" y1="2" x2="22" y2="22"/>'); }
function icoRefresh() { return svg('<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>'); }
function icoBox() { return svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'); }

const FAIL_STYLES = `
<style>
  .hyve-fail {
    display: flex; flex-direction: column; align-items: center; text-align: center;
    background: #fff; border: 1px solid #e2e8f0; border-radius: 1.4rem;
    padding: 4.8rem 2.4rem; color: #0f172a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .hyve-fail__icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 6.4rem; height: 6.4rem; border-radius: 50%;
    background: #fef3c7; color: #b45309; margin-bottom: 1.8rem;
  }
  .hyve-fail__icon svg { width: 3rem; height: 3rem; }
  .hyve-fail__title { font-size: 2rem; font-weight: 800; margin: 0 0 0.8rem; }
  .hyve-fail__text { font-size: 1.35rem; color: #64748b; margin: 0 0 2.4rem; max-width: 46rem; line-height: 1.6; }
  .hyve-fail__actions { display: flex; flex-wrap: wrap; gap: 1rem; justify-content: center; }
  .hyve-fail__btn {
    display: inline-flex; align-items: center; gap: 0.8rem; text-decoration: none;
    font-size: 1.3rem; font-weight: 700; padding: 1.2rem 2rem; border-radius: 0.9rem;
  }
  .hyve-fail__btn svg { width: 1.8rem; height: 1.8rem; }
  .hyve-fail__btn--primary { background: linear-gradient(135deg, #a3ea6e, #3dccd0); color: #0a1414; border: 1px solid transparent; }
  .hyve-fail__btn--primary:hover { filter: brightness(0.96); }
  .hyve-fail__btn--ghost { background: #fff; border: 1px solid #e2e8f0; color: #334155; }
  .hyve-fail__btn--ghost:hover { border-color: #94a3b8; }
  .hyve-fail__foot { font-size: 1.2rem; color: #94a3b8; margin: 2.4rem 0 0; }
  .hyve-fail__foot a { color: #0f766e; }

  @media (max-width: 600px) {
    .hyve-fail { padding: 3.2rem 1.6rem; }
    .hyve-fail__btn { width: 100%; justify-content: center; }
  }
</style>`;

/**
 * A2: distributor pages are visible only to approved distributor accounts.
 * Hiding the nav link isn't enough — the URL still resolves — so the
 * distributor-only routes render this instead of their content.
 *
 * @param {string} pageName e.g. "Quotes"
 */
export function distributorOnly(pageName = "This page") {
  return `
    <div class="hyve-fail">
      <span class="hyve-fail__icon">${icoLock()}</span>
      <h2 class="hyve-fail__title">Distributor accounts only</h2>
      <p class="hyve-fail__text">
        ${esc(pageName)} opens up once your distributor application is approved. Apply to get
        commercial payment terms, tier pricing and a shared account for your team.
      </p>
      <div class="hyve-fail__actions">
        <a class="hyve-fail__btn hyve-fail__btn--primary" href="/apps/account/distributor">${icoBuilding()}<span>Apply as Distributor</span></a>
        <a class="hyve-fail__btn hyve-fail__btn--ghost" href="/apps/account/orders">${icoBox()}<span>Back to Orders</span></a>
      </div>
    </div>
    ${FAIL_STYLES}`;
}

function icoLock() { return svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'); }
function icoBuilding() { return svg('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>'); }
