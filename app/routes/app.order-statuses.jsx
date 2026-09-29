import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { customerStatusLabel, statusByKey } from "../lib/portal.server";
import { OPTIONAL_STATUS_EMAILS } from "../lib/notification-preferences.server";
import { PROOF_HOLD_DAY } from "../utils/sla-engine.server";
import {
  CUSTOMER_EMAIL_STATUSES,
  STATUS_OPTIONS,
  STATUS_TRANSITIONS,
} from "../lib/production-statuses";

/**
 * Order statuses (HYV-135): the full list staff choose from on an order, in
 * the order they run, with what the buyer sees for each, whether it emails
 * them, and where it can move next. Read-only, and built from the same lists
 * the order page, the portal and the emails use, so it can't drift from them.
 */

/** What the buyer sees, where one status can show two ways in the portal. */
const BUYER_SEES_TOO = {
  "order-placed": `, or ${statusByKey("awaiting-artwork")?.label} while their artwork is still to come`,
};

/** Emails that aren't the app's own status emails. */
const OTHER_EMAIL = {
  "order-placed": "No. Shopify's order confirmation goes when the order is placed",
  shipped: "Only Shopify's shipping email, when you fulfil the order in Shopify",
};

/** Where the move list depends on the order, described rather than listed. */
const MOVES_DESCRIBED = {
  "on-hold": "Back to the step it was held at, or the step after it",
};

/** Moves the dropdown offers but the order page refuses until something is done. */
const HELD_UNTIL = {
  "proof-approved": "In Production only once a paid Physical Sample is approved",
};

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const labelOf = (value) => STATUS_OPTIONS.find((status) => status.value === value)?.label || value;
  const emailFor = (value) => {
    if (OTHER_EMAIL[value]) return OTHER_EMAIL[value];
    if (!CUSTOMER_EMAIL_STATUSES.has(value)) return "No";
    return OPTIONAL_STATUS_EMAILS.has(value) ? "Yes, unless the buyer has switched status emails off" : "Yes, always";
  };

  return {
    statuses: STATUS_OPTIONS.map(({ label, value }) => ({
      label,
      value,
      customerLabel: (customerStatusLabel(value) || "—") + (BUYER_SEES_TOO[value] || ""),
      email: emailFor(value),
      next: MOVES_DESCRIBED[value] ? [MOVES_DESCRIBED[value]] : (STATUS_TRANSITIONS[value] || []).map(labelOf),
      heldUntil: HELD_UNTIL[value] || "",
    })),
    // The moves made for staff, outside the dropdown.
    automatic: [
      ["The buyer sends their artwork from their account", "Order Received → Artwork Received"],
      ["The buyer approves the Artwork Proof, from the email or their account", "Proof Sent → Proof Approved"],
      ["The buyer requests changes", "Proof Sent → On Hold"],
      [`No decision ${PROOF_HOLD_DAY} days after the Artwork Proof was sent`, "Proof Sent → On Hold"],
      ["The whole order is fulfilled in Shopify", "Any status except Delivered → Shipped"],
    ],
  };
};

export default function OrderStatuses() {
  const { statuses, automatic } = useLoaderData();

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
                  <s-table-cell>
                    {status.next.length ? status.next.join(", ") : "Nothing (final)"}
                    {status.heldUntil ? ` (${status.heldUntil})` : ""}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>

      <s-section heading="Moves that happen by themselves">
        <s-stack direction="block" gap="base">
          <s-paragraph>These change the status without anyone using the dropdown.</s-paragraph>

          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">When</s-table-header>
              <s-table-header listSlot="labeled">Status change</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {automatic.map(([when, change]) => (
                <s-table-row key={when}>
                  <s-table-cell>{when}</s-table-cell>
                  <s-table-cell>{change}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>
    </s-page>
  );
}
