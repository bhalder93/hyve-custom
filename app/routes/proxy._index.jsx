import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { errorState } from "../lib/account-error.server";
import { loadAccount } from "../lib/account-data.server";
import { dashboardPage } from "../lib/account-dashboard.server";
import { mapOrders, ordersPage, awaitingActionCount } from "../lib/account-orders.server";
import { signedOutPage } from "../lib/account-signed-out.server";

/**
 * Account portal landing page.
 * Storefront: /apps/account  ->  <app>/proxy  (this route)
 *
 * A4: a distributor lands on the distributor dashboard. A non-distributor has
 * no dashboard, so they land on their orders.
 *
 * Failures never bubble out as a 5xx: Shopify swaps any non-2xx proxy response
 * for its own error page, so everything we catch returns 200 with the panel.
 */
export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return liquid(signedOutPage("/apps/account"));

    const { customer, isDistributor, terms, orderNodes, awaitingQuotes, failed } = await loadAccount(admin, customerId);
    if (failed) {
      return liquid(accountShell({ active: "dashboard", main: errorState(), customer }));
    }

    const orders = mapOrders(orderNodes);
    const counts = { orders: awaitingActionCount(orders), quotes: awaitingQuotes };

    const main = isDistributor
      ? dashboardPage({
          customer,
          stats: {
            totalOrders: orders.length,
            pendingProofs: counts.orders,
            // Quotes awaiting the buyer's decision — the same figure the nav
            // badge carries, so the two never disagree.
            activeQuotes: counts.quotes,
            // Shopify's own store credit balance for this company location.
            storeCredit: terms?.storeCredit || "",
            storeCreditIssuedAt: terms?.storeCreditIssuedAt || "",
          },
          // Invoices are not built yet, so there is no payment banner to show.
          payment: null,
          recentOrders: orders.slice(0, 3),
        })
      : ordersPage({ orders, showDistributorPromo: true });

    return liquid(
      accountShell({
        active: isDistributor ? "dashboard" : "orders",
        main,
        customer,
        isDistributor,
        counts,
        terms,
      }),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] landing page failed", error);
    return liquid(accountShell({ active: "dashboard", main: errorState() }));
  }
};
