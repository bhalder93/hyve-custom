import { formatDateTime as formatDate } from "../utils/date.js";
/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import {
  approveCreditReview,
  declineCreditReview,
  loadCreditReviewQueue,
} from "../lib/credit-review.server";

/**
 * Credit review queue (HYV-162). Orders placed on terms by a company that
 * submits orders for review wait here as drafts until Hyve approves or
 * declines them. See credit-review.server.js.
 */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    return { orders: await loadCreditReviewQueue(admin), shop: session?.shop || "", error: null };
  } catch (error) {
    console.error("[credit-review] queue failed", error?.message || error);
    return { orders: [], shop: session?.shop || "", error: error?.message || "Couldn't load the queue." };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const id = String(form.get("id") || "");
  // A draft waiting for review, or an order from a quote link held On Hold.
  if (!/^gid:\/\/shopify\/(DraftOrder|Order)\/\d+$/.test(id)) return { ok: false, id, error: "Missing order." };

  try {
    if (intent === "approve") {
      const result = await approveCreditReview(admin, id);
      return result.ok
        ? {
            ok: true,
            id,
            message: result.released
              ? `Approved. Order ${result.orderName} released to ${result.releasedTo || "Order Received"}.`
              : `Approved. Order ${result.orderName} created; Shopify emails the buyer the confirmation.`,
          }
        : { ok: false, id, error: result.error };
    }
    if (intent === "decline") {
      const result = await declineCreditReview(admin, id, form.get("reason"));
      return result.ok
        ? {
            ok: true,
            id,
            message: `Declined${result.emailed ? " and the buyer emailed" : ", but the buyer email didn't send"}.${
              result.warning ? ` ${result.warning}` : ""
            }`,
          }
        : { ok: false, id, error: result.error };
    }
  } catch (error) {
    console.error("[credit-review] action failed", intent, id, error?.message || error);
    return { ok: false, id, error: error?.message || "Something went wrong." };
  }
  return { ok: false, id, error: "Unknown action." };
};



// One fetcher for the page: a decided order leaves the list, and its row with
// it, so the confirmation is shown from here.
function ReviewOrder({ order, shop, fetcher }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const pending = fetcher.state !== "idle";
  const busy = pending && fetcher.formData?.get("id") === order.id;
  const intent = fetcher.formData?.get("intent");
  const result = fetcher.data?.id === order.id ? fetcher.data : null;

  const submit = (data) => fetcher.submit({ id: order.id, ...data }, { method: "post" });
  const store = shop.replace(".myshopify.com", "");

  return (
    <s-section
      heading={`${order.name} · ${order.company || order.buyer || "Distributor"}${
        order.kind === "order" ? " · from a quote, on hold" : ""
      }`}
    >
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">Amount</s-text>
            <s-text type="strong">{order.total || "—"}</s-text>
          </s-stack>
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">Payment terms</s-text>
            <s-text>{order.terms || "—"}</s-text>
          </s-stack>
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">PO number</s-text>
            <s-text>{order.poNumber || "—"}</s-text>
          </s-stack>
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">Submitted</s-text>
            <s-text>{formatDate(order.submittedAt)}</s-text>
          </s-stack>
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">Buyer</s-text>
            <s-text>{[order.buyer, order.buyerEmail].filter(Boolean).join(" · ") || "—"}</s-text>
          </s-stack>
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">Sales rep</s-text>
            <s-text>{order.salesRep || "—"}</s-text>
          </s-stack>
        </s-grid>
        {order.items ? <s-paragraph color="subdued">{order.items}</s-paragraph> : null}

        {result && !result.ok ? (
          <s-banner tone="critical">
            <s-paragraph>{result.error}</s-paragraph>
          </s-banner>
        ) : null}

        {declining ? (
          <s-stack direction="block" gap="small">
            <s-text-area
              label="Reason for declining (sent to the buyer)"
              rows={3}
              value={reason}
              onInput={(event) => setReason(event.currentTarget.value)}
            />
            <s-stack direction="inline" gap="small">
              <s-button
                tone="critical"
                variant="primary"
                disabled={pending || !reason.trim()}
                loading={busy && intent === "decline"}
                onClick={() => submit({ intent: "decline", reason })}
              >
                {order.kind === "order" ? "Decline, cancel the order and tell the buyer" : "Decline and tell the buyer"}
              </s-button>
              <s-button disabled={busy} onClick={() => setDeclining(false)}>
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        ) : (
          <s-stack direction="inline" gap="small">
            <s-button
              variant="primary"
              disabled={pending}
              loading={busy && intent === "approve"}
              onClick={() => submit({ intent: "approve" })}
            >
              {order.kind === "order" ? "Approve and release the order" : "Approve and create order"}
            </s-button>
            <s-button tone="critical" disabled={pending} onClick={() => setDeclining(true)}>
              Decline
            </s-button>
            {store ? (
              <s-button
                variant="tertiary"
                href={`https://admin.shopify.com/store/${store}/${order.kind === "order" ? "orders" : "draft_orders"}/${order.numericId}`}
                target="_blank"
              >
                {order.kind === "order" ? "Open order" : "Open draft"}
              </s-button>
            ) : null}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

export default function CreditReviewPage() {
  const { orders, shop, error } = useLoaderData();
  const fetcher = useFetcher();

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.message) shopify.toast.show(fetcher.data.message);
  }, [fetcher.data]);

  return (
    <s-page heading="Credit review" inlineSize="large">
      {error ? (
        <s-section>
          <s-banner tone="critical" heading="We couldn't load the queue">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <s-section>
        <s-paragraph>
          Orders placed on payment terms by a company that submits orders for review. The buyer sees them as Credit
          Under Review. Approve creates the order (payment pending on its terms) and it starts at Order Received.
          Decline needs a reason, which the buyer is emailed and sees in their Orders. An order placed from a quote
          link arrives already created and waits On Hold: Approve releases it, Decline cancels it.
        </s-paragraph>
      </s-section>

      {orders.length === 0 && !error ? (
        <s-section>
          <s-paragraph>No orders are waiting for a credit review.</s-paragraph>
        </s-section>
      ) : (
        orders.map((order) => <ReviewOrder key={order.id} order={order} shop={shop} fetcher={fetcher} />)
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("[credit-review] render failed:", error);
  return (
    <s-page heading="Credit review">
      <s-section>
        <s-banner tone="critical" heading="We couldn't load the queue">
          <s-paragraph>{error?.message || "Please reload the page."}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}
