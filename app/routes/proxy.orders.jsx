import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { errorState } from "../lib/account-error.server";
import { loadAccount } from "../lib/account-data.server";
import { mapOrders, ordersPage, awaitingActionCount } from "../lib/account-orders.server";
import { signedOutPage } from "../lib/account-signed-out.server";

/**
 * Orders list.
 * Storefront: /apps/account/orders  ->  <app>/proxy/orders  (this route)
 *
 * Shared by distributor and non-distributor accounts; the distributor promo
 * card is only shown to accounts that are not distributors already.
 */
export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return liquid(signedOutPage("/apps/account/orders"));

    const { customer, isDistributor, terms, orderNodes, awaitingQuotes, failed } = await loadAccount(admin, customerId);
    if (failed) {
      return liquid(accountShell({ active: "orders", main: errorState(), customer }));
    }

    const orders = mapOrders(orderNodes);

    return liquid(
      accountShell({
        active: "orders",
        main: ordersPage({
          orders,
          showDistributorPromo: !isDistributor,
          notice: url.searchParams.get("notice") || "",
          error: url.searchParams.get("error") || "",
        }),
        customer,
        isDistributor,
        counts: { orders: awaitingActionCount(orders), quotes: awaitingQuotes },
        terms,
      }),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] orders page failed", error);
    return liquid(accountShell({ active: "orders", main: errorState() }));
  }
};
