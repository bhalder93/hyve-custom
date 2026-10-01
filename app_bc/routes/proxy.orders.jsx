import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { errorState } from "../lib/account-error.server";
import { loadAccount } from "../lib/account-data.server";
import {
  awaitingActionCount,
  loadReviewOrders,
  mapOrders,
  ordersPage,
  withArtworkDeadlines,
} from "../lib/account-orders.server";
import { listArtwork, artworkOwnerGid } from "../lib/artwork.server";
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

    const { customer, isDistributor, terms, orderNodes, reviewDraftIds, awaitingQuotes, failed } = await loadAccount(
      admin,
      customerId,
    );
    if (failed) {
      return liquid(accountShell({ active: "orders", main: errorState(), customer }));
    }

    // Terms orders still under credit review lead the list: they are the
    // newest, and waiting on Hyve rather than on the buyer.
    const orders = [...(await loadReviewOrders(admin, reviewDraftIds)), ...mapOrders(orderNodes)];
    // The artwork "by" date on orders still waiting for it (HYV-102).
    await withArtworkDeadlines(admin, orders);

    // The artwork panel offers the buyer's saved files, but only an order still
    // waiting on artwork can use them — so the library is fetched only then.
    const needsArtwork = orders.some((order) => order.statusKey === "awaiting-artwork");
    const library = needsArtwork
      ? (
          await listArtwork(
            admin,
            artworkOwnerGid({ companyId: terms?.companyId, customerId }),
            `gid://shopify/Customer/${customerId}`,
          )
        ).files
      : [];

    return liquid(
      accountShell({
        active: "orders",
        main: ordersPage({
          orders,
          library,
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
