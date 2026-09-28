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
 * Shopify holds on it. Nothing here is stored by this app. No credit figure
 * is shown for launch (HYV-135).
 */
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
              salesRep: chrome.terms?.salesRep || "",
              salesRepEmail: chrome.terms?.salesRepEmail || "",
              salesRepPhone: chrome.terms?.salesRepPhone || "",
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
