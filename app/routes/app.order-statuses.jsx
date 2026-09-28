import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { customerStatusLabel } from "../lib/portal.server";
import {
  CUSTOMER_EMAIL_STATUSES,
  STATUS_OPTIONS,
  STATUS_TRANSITIONS,
} from "../lib/production-statuses";

/**
 * Order statuses (HYV-135): the full list staff choose from on an order, in
 * the order they run, with what the buyer sees for each, whether it emails
 * them, and where it can move next. Read-only, and built from the same lists
 * the order page uses, so it can't drift from what the dropdown offers.
 */
export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const labelOf = (value) => STATUS_OPTIONS.find((status) => status.value === value)?.label || value;

  return {
    statuses: STATUS_OPTIONS.map(({ label, value }) => ({
      label,
      value,
      customerLabel: customerStatusLabel(value) || "—",
      email: CUSTOMER_EMAIL_STATUSES.has(value)
        ? "Yes"
        : value === "shipped"
          ? "Shopify's shipping email, when the order is fulfilled"
          : "No",
      next: (STATUS_TRANSITIONS[value] || []).map(labelOf),
    })),
  };
};

export default function OrderStatuses() {
  const { statuses } = useLoaderData();

  return (
    <s-page heading="Order Statuses">
      <s-section heading="Production statuses">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            These are the statuses you choose from on a production order, in the order they run. The order page only
            offers the moves in the last column. The buyer sees the portal wording in the second column.
          </s-paragraph>

          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Status</s-table-header>
              <s-table-header listSlot="labeled">Buyer sees</s-table-header>
              <s-table-header listSlot="labeled">Emails the buyer</s-table-header>
              <s-table-header listSlot="labeled">Can move to</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {statuses.map((status) => (
                <s-table-row key={status.value}>
                  <s-table-cell>{status.label}</s-table-cell>
                  <s-table-cell>{status.customerLabel}</s-table-cell>
                  <s-table-cell>{status.email}</s-table-cell>
                  <s-table-cell>{status.next.length ? status.next.join(", ") : "Nothing (final)"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>
    </s-page>
  );
}
