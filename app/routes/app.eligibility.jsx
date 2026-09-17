import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { syncCustomerEligibility } from "../lib/eligibility-sync.server";

/**
 * Test bench for the eligibility flow.
 *
 * Enter a customer (email or numeric id), and this calls the dummy API, writes
 * the verdict to the customer's app-owned metafield, and shows both — which is
 * exactly what the checkout validation function reads a moment later.
 */
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const email = String(formData.get("email") || "").trim();
  const customerId = String(formData.get("customerId") || "").trim();

  if (!email && !customerId) {
    return { ok: false, error: "Enter a customer email or id." };
  }

  try {
    const result = await syncCustomerEligibility(admin, { email, customerId });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error?.message || "Sync failed" };
  }
};

export default function EligibilityTester() {
  const fetcher = useFetcher();
  const isLoading = ["loading", "submitting"].includes(fetcher.state);
  const data = fetcher.data;

  return (
    <s-page heading="Checkout eligibility">
      <s-section heading="Check a customer">
        <s-paragraph>
          Calls the dummy eligibility API and stores the verdict on the customer
          so the checkout validation function can block ineligible buyers.
        </s-paragraph>

        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field label="Customer email" name="email" placeholder="sarah@acmecorp.sg" />
            <s-text-field label="or Customer ID" name="customerId" placeholder="1234567890" />
            <s-button type="submit" variant="primary" loading={isLoading}>
              Check and sync
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      {data?.ok === false && (
        <s-section heading="Error">
          <s-banner tone="critical">
            <s-paragraph>{data.error}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      {data?.ok && (
        <s-section heading={`Verdict for ${data.customer.displayName || data.customer.email}`}>
          <s-banner tone={data.verdict.eligible ? "success" : "critical"}>
            <s-paragraph>
              {data.verdict.eligible ? "Eligible" : "Blocked"} — {data.verdict.reason}
            </s-paragraph>
          </s-banner>

          <s-paragraph>
            Tags: {data.customer.tags.length ? data.customer.tags.join(", ") : "none"}
          </s-paragraph>
          <s-paragraph>
            Metafield: {data.metafield ? `${data.metafield.namespace}.${data.metafield.key} written` : "not written"}
          </s-paragraph>
          {data.userErrors?.length > 0 && (
            <s-paragraph>Errors: {JSON.stringify(data.userErrors)}</s-paragraph>
          )}
        </s-section>
      )}
    </s-page>
  );
}
