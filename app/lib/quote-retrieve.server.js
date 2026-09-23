/**
 * Retrieve a Quote — the page an end client uses to find their quote.
 *
 * The person approving a quote is usually at the distributor's own client and
 * has no account here, so this page sits outside the portal: quote number plus
 * the email the quote was sent to, and nothing else.
 *
 * It deliberately gives one answer for "no such quote" and "wrong email", so
 * the form cannot be used to find out which quote numbers exist.
 */
import { esc } from "./account-shell.server";

const STYLES = `
<style>
  .hyve-rq { max-width: 560px; margin: 64px auto; padding: 0 20px;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0F172A; }
  .hyve-rq__title { font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; font-size: 24px; font-weight: 800; margin: 0 0 6px; }
  .hyve-rq__sub { color: #64748B; font-size: 14px; margin: 0 0 24px; }
  .hyve-rq__card { border: 1px solid #E2E8F0; border-radius: 14px; padding: 22px; background: #fff; }
  .hyve-rq__field { display: block; margin-bottom: 14px; }
  .hyve-rq__label { display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 5px; }
  .hyve-rq__input { width: 100%; box-sizing: border-box; border: 1px solid #CBD5E1; border-radius: 9px;
    padding: 10px 12px; font: inherit; font-size: 14px; color: #0F172A; }
  .hyve-rq__input:focus { outline: 2px solid rgba(110,222,225,0.45); outline-offset: 1px; border-color: #0F766E; }
  .hyve-rq__hint { font-size: 11.5px; color: #94A3B8; margin: 4px 0 0; }
  .hyve-rq__btn { display: inline-block; border: 0; cursor: pointer;
    background: linear-gradient(135deg, #A3EA6E 0%, #6EDEE1 100%); color: #0A1414;
    font: inherit; font-weight: 700; font-size: 14px; padding: 11px 22px; border-radius: 10px; }
  .hyve-rq__btn:hover { filter: brightness(0.96); }
  .hyve-rq__error { background: #FEE2E2; color: #991B1B; border-radius: 9px; padding: 10px 12px; font-size: 13px; margin: 0 0 16px; }

  .hyve-rq__found-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
  .hyve-rq__ref { font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; font-size: 18px; font-weight: 800; }
  .hyve-rq__total { font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; font-size: 18px; font-weight: 800; }
  .hyve-rq__meta { font-size: 12.5px; color: #64748B; margin: 0 0 16px; }
  .hyve-rq__lines { border-top: 1px solid #E2E8F0; margin-bottom: 16px; }
  .hyve-rq__line { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid #F1F5F9; font-size: 13px; }
  .hyve-rq__line-qty { color: #64748B; }
  .hyve-rq__actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .hyve-rq__secondary { display: inline-block; border: 1px solid #CBD5E1; border-radius: 10px; padding: 10px 18px;
    text-decoration: none; color: #334155; font-weight: 600; font-size: 14px; font-family: inherit;
    background: #fff; cursor: pointer; }
  .hyve-rq__secondary:hover { border-color: #0F172A; color: #0F172A; }
</style>`;

/**
 * @param {object} opts
 * @param {string} [opts.reference]  what they typed, so it survives an error
 * @param {string} [opts.email]
 * @param {string} [opts.error]
 */
export function retrieveQuotePage({ reference = "", email = "", error = "" } = {}) {
  return `
    ${STYLES}
    <div class="hyve-rq">
      <h1 class="hyve-rq__title">Retrieve a quote</h1>
      <p class="hyve-rq__sub">Enter your quote number and the email address it was sent to. No account needed.</p>

      <div class="hyve-rq__card">
        ${error ? `<p class="hyve-rq__error">${esc(error)}</p>` : ""}
        <form method="post" action="/apps/account/quotes/retrieve">
          <label class="hyve-rq__field">
            <span class="hyve-rq__label">Quote number</span>
            <input class="hyve-rq__input" type="text" name="reference" value="${esc(reference)}"
              placeholder="Q-1042" required autocomplete="off">
            <span class="hyve-rq__hint">On your quote and in the email we sent.</span>
          </label>

          <label class="hyve-rq__field">
            <span class="hyve-rq__label">Email address</span>
            <input class="hyve-rq__input" type="email" name="email" value="${esc(email)}"
              placeholder="you@company.com" required>
          </label>

          <button type="submit" class="hyve-rq__btn">Find my quote</button>
        </form>
      </div>
    </div>`;
}

/** The quote itself, once the number and email match. */
export function retrievedQuotePage(quote) {
  const lines = (quote.lines || [])
    .map(
      (line) => `
      <div class="hyve-rq__line">
        <span>${esc(line.title)} <span class="hyve-rq__line-qty">&times; ${esc(line.quantity)}</span></span>
        <strong>${esc(line.total)}</strong>
      </div>`,
    )
    .join("");

  return `
    ${STYLES}
    <div class="hyve-rq">
      <h1 class="hyve-rq__title">Your quote</h1>
      <p class="hyve-rq__sub">Review it below, download a copy, or place the order.</p>

      <div class="hyve-rq__card">
        <div class="hyve-rq__found-head">
          <span class="hyve-rq__ref">${esc(quote.reference)}</span>
          <span class="hyve-rq__total">${esc(quote.total)}</span>
        </div>
        <p class="hyve-rq__meta">Issued ${esc(quote.createdAt)}${quote.status ? ` &middot; ${esc(quote.status)}` : ""}</p>

        <div class="hyve-rq__lines">${lines}</div>

        <div class="hyve-rq__actions">
          ${
            quote.invoiceUrl
              ? `<a class="hyve-rq__btn" href="${esc(quote.invoiceUrl)}">Review &amp; order</a>`
              : ""
          }
          <form method="post" action="/apps/account/quotes/retrieve">
            <input type="hidden" name="reference" value="${esc(quote.reference)}">
            <input type="hidden" name="email" value="${esc(quote.email)}">
            <input type="hidden" name="intent" value="pdf">
            <button type="submit" class="hyve-rq__secondary">Download PDF</button>
          </form>
        </div>
      </div>
    </div>`;
}

/**
 * A quote that has passed its validity. The quote itself is gone, so there is
 * nothing to pay or download — only an honest explanation and a way to ask for
 * a fresh one.
 */
export function expiredQuotePage(quote) {
  return `
    ${STYLES}
    <div class="hyve-rq">
      <h1 class="hyve-rq__title">This quote has expired</h1>
      <p class="hyve-rq__sub">Quotes are held for a limited time, after which prices are no longer guaranteed.</p>

      <div class="hyve-rq__card">
        <div class="hyve-rq__found-head">
          <span class="hyve-rq__ref">${esc(quote.reference)}</span>
          <span class="hyve-rq__total" style="text-decoration: line-through; color: #94A3B8;">${esc(quote.total)}</span>
        </div>
        <p class="hyve-rq__meta">Raised ${esc(quote.date)}${quote.items ? ` &middot; ${esc(quote.items)}` : ""}</p>

        <p class="hyve-rq__sub">Ask your Hyve contact for an updated quote and we will price it again.</p>

        <div class="hyve-rq__actions">
          <a class="hyve-rq__btn" href="https://hyve.promo/pages/contact">Request a new quote</a>
        </div>
      </div>
    </div>`;
}
