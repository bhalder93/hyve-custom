import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { distributorOnly, errorState } from "../lib/account-error.server";
import { signedOutPage } from "../lib/account-signed-out.server";
import { portalChrome } from "../lib/account-data.server";
import { loadInvoices } from "../lib/invoices.server";
import { invoicesPage } from "../lib/account-invoices.server";

/**
 * Invoices.
 * Storefront: /apps/account/invoices -> <app>/proxy/invoices
 *
 * Each invoice is an order placed on terms, read from the payment schedule
 * Shopify holds on it. The credit figure is the company location's native
 * store credit balance. Nothing here is stored by this app.
 */
/** Share of everything ever issued that has been spent. */
function percentUsed(terms) {
  const used = Number(terms?.storeCreditUsedAmount);
  const issued = Number(terms?.storeCreditIssuedAmount);
  if (!Number.isFinite(used) || !Number.isFinite(issued) || issued <= 0) return null;
  // A share of a total is never below nil or above everything, whatever the
  // transactions say.
  return Math.min(Math.max(Math.round((used / issued) * 1000) / 10, 0), 100);
}

export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return liquid(signedOutPage("/apps/account/invoices"));

    const chrome = await portalChrome(admin, customerId);
    if (!chrome.isDistributor) {
      return liquid(accountShell({ active: "invoices", main: distributorOnly("Invoices"), ...chrome }));
    }

    const { invoices, failed } = await loadInvoices(admin, chrome.terms?.locationIds || []);

    return liquid(
      accountShell({
        active: "invoices",
        main: failed
          ? errorState({ heading: "We couldn't load your invoices", retryHref: "/apps/account/invoices" })
          : invoicesPage({
              invoices,
              storeCredit: chrome.terms?.storeCredit || "",
              storeCreditUsed: chrome.terms?.storeCreditUsed || "",
              storeCreditIssued: chrome.terms?.storeCreditIssued || "",
              storeCreditIssuedAt: chrome.terms?.storeCreditIssuedAt || "",
              storeCreditExpired: chrome.terms?.storeCreditExpired || "",
              storeCreditPercentUsed: percentUsed(chrome.terms),
              paymentTerms: chrome.terms?.paymentTerms || "",
              salesRep: chrome.terms?.salesRep || "",
              salesRepEmail: chrome.terms?.salesRepEmail || "",
              salesRepPhone: chrome.terms?.salesRepPhone || "",
              tier: chrome.customer?.tier || "",
            }),
        ...chrome,
      }),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] invoices page failed", error);
    return liquid(accountShell({ active: "invoices", main: errorState() }));
  }
};
