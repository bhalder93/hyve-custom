// app/routes/webhooks.company_locations.update.jsx

import { authenticate } from "../shopify.server";
import { syncDepositField } from "../lib/deposit.server";

/**
 * Keeps a company location's deposit field in step with Shopify's own deposit
 * setting (HYV-150), so a deposit set by hand in Shopify admin shows Bank
 * transfer and the deposit note at checkout too.
 *
 * Answered at once and synced after: Shopify allows a webhook 5 seconds.
 */
export async function action({ request }) {
  const { admin, payload, shop } = await authenticate.webhook(request);

  const locationGid = payload?.admin_graphql_api_id || (payload?.id ? `gid://shopify/CompanyLocation/${payload.id}` : "");
  if (admin && locationGid) {
    syncDepositField(admin, locationGid)
      .then((result) => {
        if (result.changed) console.log("[company_locations/update]", shop, locationGid, `deposit field set to ${result.percentage || "none"}`);
      })
      .catch((error) => console.error("[company_locations/update] failed", shop, locationGid, error?.message || error));
  }

  return new Response(null, { status: 200 });
}
