/**
 * Signed-out prompt for any portal page.
 *
 * A2 keeps distributor pricing, pages and the account area behind a sign-in,
 * so every portal route that needs a customer falls back to this.
 */
import { esc } from "./account-shell.server";

/** @param {string} returnTo storefront path to come back to after sign-in */
export function signedOutPage(returnTo = "/apps/account") {
  const loginHref = `/customer_authentication/login?return_to=${encodeURIComponent(returnTo)}`;

  return `
    <div class="hyve-signin">
      <h1 class="hyve-signin__title">My Account</h1>
      <p class="hyve-signin__text">Please sign in to view your orders, quotes and account.</p>
      <a class="hyve-signin__btn" href="${esc(loginHref)}">Sign in</a>
    </div>
    <style>
      .hyve-signin {
        max-width: 560px; margin: 72px auto; padding: 0 20px; text-align: center;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0F172A;
      }
      .hyve-signin__title { font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; font-size: 24px; font-weight: 800; margin: 0 0 6px; }
      .hyve-signin__text { color: #64748B; font-size: 14px; margin: 0 0 20px; }
      .hyve-signin__btn {
        display: inline-block; background: linear-gradient(135deg, #A3EA6E 0%, #6EDEE1 100%);
        color: #0A1414; text-decoration: none; font-weight: 700; font-size: 14px;
        padding: 11px 22px; border-radius: 10px;
      }
      .hyve-signin__btn:hover { filter: brightness(0.96); }
    </style>`;
}
