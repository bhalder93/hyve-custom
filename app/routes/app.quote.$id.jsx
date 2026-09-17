/* eslint-disable react/prop-types */
import { useState, useMemo, useEffect, useCallback } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { AdminTheme, Pill } from "../lib/admin-theme";

/* ==========================================================================
   Constants & Helpers
   ========================================================================== */

const STATUS_KEYS = {
  AWAITING_ACTION: "awaiting_action",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
};

function cleanDraftOrderId(id) {
  if (!id) return "";
  return String(id).replace("gid://shopify/DraftOrder/", "");
}

function getShopifyAdminDraftOrderUrl(id, shop) {
  const numericId = cleanDraftOrderId(id);
  if (!numericId) return "";
  const shopHandle = String(shop || "").replace(".myshopify.com", "");
  if (shopHandle) {
    return `https://admin.shopify.com/store/${shopHandle}/draft_orders/${numericId}`;
  }
  return `https://${shop}/admin/draft_orders/${numericId}`;
}

function parseQuoteStatus(metafield) {
  if (!metafield || metafield.value === null || metafield.value === undefined || metafield.value === "") {
    return {
      key: STATUS_KEYS.AWAITING_ACTION,
      label: "Awaiting Action",
      tone: "warning",
      rawBool: null,
    };
  }

  const val = String(metafield.value).trim().toLowerCase();
  if (val === "true") {
    return {
      key: STATUS_KEYS.ACCEPTED,
      label: "Accepted",
      tone: "success",
      rawBool: true,
    };
  }

  if (val === "false") {
    return {
      key: STATUS_KEYS.REJECTED,
      label: "Rejected",
      tone: "critical",
      rawBool: false,
    };
  }

  return {
    key: STATUS_KEYS.AWAITING_ACTION,
    label: "Awaiting Action",
    tone: "warning",
    rawBool: null,
  };
}

function formatMoney(amount, currency = "USD") {
  const num = Number(amount) || 0;
  try {
    return `${currency} ${num.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  } catch {
    return `${currency} ${num.toFixed(2)}`;
  }
}

function getInitials(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "CU";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ==========================================================================
   Loader
   ========================================================================== */

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";

  const paramId = params?.id;
  if (!paramId) {
    throw new Response("Draft Order ID is required.", { status: 400 });
  }

  const draftOrderGid = paramId.startsWith("gid://shopify/DraftOrder/")
    ? paramId
    : `gid://shopify/DraftOrder/${paramId}`;

  try {
    const response = await admin.graphql(
      `#graphql
      query GetDraftOrderDetails($id: ID!) {
        draftOrder(id: $id) {
          id
          name
          createdAt
          updatedAt
          status
          invoiceUrl
          tags
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalTaxSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            id
            displayName
            email
            phone
          }
          shippingAddress {
            address1
            address2
            city
            province
            zip
            country
            name
            phone
          }
          billingAddress {
            address1
            address2
            city
            province
            zip
            country
            name
            phone
          }
          lineItems(first: 100) {
            nodes {
              id
              title
              name
              quantity
              sku
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              discountedUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
          customAttributes {
            key
            value
          }
          metafield(namespace: "$app", key: "hyve_status") {
            id
            value
            type
          }
        }
      }`,
      {
        variables: { id: draftOrderGid },
      },
    );

    const json = await response.json();
    const draftOrder = json?.data?.draftOrder;

    if (!draftOrder) {
      throw new Response("Draft Order Not Found", { status: 404 });
    }

    const quoteStatus = parseQuoteStatus(draftOrder.metafield);

    return {
      quote: {
        ...draftOrder,
        numericId: cleanDraftOrderId(draftOrder.id),
        quoteStatus,
      },
      shop,
    };
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[app.quote.$id.loader] Error fetching draft order:", err);
    throw new Response("Error loading draft order details: " + err.message, { status: 500 });
  }
};

/* ==========================================================================
   Action (Update Status Metafield: true = accepted, false = rejected, null = awaiting action)
   ========================================================================== */

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();
  const draftOrderId = String(formData.get("draftOrderId") || "").trim();

  if (!draftOrderId) {
    return { success: false, error: "Missing draft order ID." };
  }

  if (intent === "update_status") {
    const targetStatus = String(formData.get("targetStatus") || "").trim();

    try {
      if (targetStatus === "accepted" || targetStatus === "rejected") {
        const boolValue = targetStatus === "accepted" ? "true" : "false";

        const setRes = await admin.graphql(
          `#graphql
          mutation SetDraftOrderHyveStatus($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
                namespace
                key
                value
                type
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              metafields: [
                {
                  ownerId: draftOrderId,
                  namespace: "$app",
                  key: "hyve_status",
                  type: "boolean",
                  value: boolValue,
                },
              ],
            },
          },
        );

        const setJson = await setRes.json();
        const errors = setJson?.data?.metafieldsSet?.userErrors;
        if (errors && errors.length > 0) {
          return { success: false, error: errors.map((e) => e.message).join(", ") };
        }

        const updatedMetafield = setJson?.data?.metafieldsSet?.metafields?.[0];
        return {
          success: true,
          draftOrderId,
          targetStatus,
          metafield: updatedMetafield,
          message: `Quote marked as ${targetStatus === "accepted" ? "Accepted" : "Rejected"}.`,
        };
      }

      if (targetStatus === "awaiting_action") {
        // Awaiting means the metafield is absent, and a boolean has no third
        // value, so resetting is a delete. `metafieldsDelete` identifies the
        // metafield by owner, namespace and key rather than by its ID.
        //
        // The namespace is read back off the record instead of being passed as
        // "$app": that alias resolves to the app's reserved namespace, and the
        // resolved form is what the delete has to match.
        const lookup = await admin.graphql(
          `#graphql
          query GetDraftOrderHyveStatus($id: ID!) {
            draftOrder(id: $id) {
              id
              metafield(namespace: "$app", key: "hyve_status") {
                id
                namespace
                key
              }
            }
          }`,
          { variables: { id: draftOrderId } },
        );
        const lookupJson = await lookup.json();
        const existing = lookupJson?.data?.draftOrder?.metafield;

        // Nothing stored means it is already awaiting action.
        if (existing?.namespace) {
          const delRes = await admin.graphql(
            `#graphql
            mutation ClearDraftOrderHyveStatus($metafields: [MetafieldIdentifierInput!]!) {
              metafieldsDelete(metafields: $metafields) {
                deletedMetafields { key namespace ownerId }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                metafields: [
                  {
                    ownerId: draftOrderId,
                    namespace: existing.namespace,
                    key: existing.key || "hyve_status",
                  },
                ],
              },
            },
          );

          const delJson = await delRes.json();
          if (delJson?.errors?.length) {
            return { success: false, error: delJson.errors[0]?.message || "Reset failed." };
          }

          const errors = delJson?.data?.metafieldsDelete?.userErrors;
          if (errors && errors.length > 0) {
            return { success: false, error: errors.map((e) => e.message).join(", ") };
          }
        }

        return {
          success: true,
          draftOrderId,
          targetStatus: "awaiting_action",
          metafield: null,
          message: "Quote status reset to Awaiting Action.",
        };
      }

      return { success: false, error: `Invalid status '${targetStatus}'.` };
    } catch (err) {
      console.error("[app.quote.$id.action] Error updating status:", err);
      return { success: false, error: err?.message || "Failed to update quote status." };
    }
  }

  return { success: false, error: "Unsupported intent." };
};

/* ==========================================================================
   Main Component: Redesigned Dedicated Quote Details Page
   ========================================================================== */

function formatDateTime(value) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

export default function QuoteDetailPage() {
  const { quote: initialQuote, shop } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [quote, setQuote] = useState(initialQuote);

  useEffect(() => {
    setQuote(initialQuote);
  }, [initialQuote]);

  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.success) {
      const { targetStatus, metafield, message } = fetcher.data;
      shopify?.toast?.show?.(message || "Status updated successfully.");

      const updatedMetafield =
        targetStatus === "awaiting_action"
          ? null
          : metafield || { value: targetStatus === "accepted" ? "true" : "false" };

      setQuote((prev) => ({
        ...prev,
        metafield: updatedMetafield,
        quoteStatus: parseQuoteStatus(updatedMetafield),
      }));
    } else if (fetcher.data.error) {
      shopify?.toast?.show?.(`Error: ${fetcher.data.error}`);
    }
  }, [fetcher.data, shopify]);

  const handleUpdateStatus = useCallback(
    (targetStatus) => {
      fetcher.submit(
        {
          intent: "update_status",
          draftOrderId: quote.id,
          targetStatus,
        },
        { method: "post" },
      );
    },
    [fetcher, quote.id],
  );

  const isSubmitting = fetcher.state !== "idle";
  const shopifyAdminUrl = useMemo(
    () => getShopifyAdminDraftOrderUrl(quote.id, shop),
    [quote.id, shop],
  );

  const isAccepted = quote.quoteStatus.key === STATUS_KEYS.ACCEPTED;
  const isRejected = quote.quoteStatus.key === STATUS_KEYS.REJECTED;
  const decided = isAccepted || isRejected;

  const currency = quote.totalPriceSet?.shopMoney?.currencyCode || "USD";
  const lines = quote.lineItems?.nodes || [];
  const customerName = quote.customer?.displayName || quote.customer?.email || "Guest";

  const address = quote.shippingAddress || quote.billingAddress;
  const addressLines = address
    ? [
        address.name,
        address.address1,
        address.address2,
        [address.city, address.province, address.zip].filter(Boolean).join(" "),
        address.country,
      ].filter(Boolean)
    : [];

  return (
    <s-page heading={`Quote ${quote.name}`} inlineSize="large">
      <s-button slot="primary-action" href={shopifyAdminUrl} target="_blank" variant="primary">
        Open in Shopify
      </s-button>
      {quote.invoiceUrl ? (
        <s-button slot="secondary-actions" href={quote.invoiceUrl} target="_blank">
          Checkout link
        </s-button>
      ) : null}
      <s-button slot="secondary-actions" href="/app/quotes" variant="tertiary">
        All quotes
      </s-button>

      <s-section padding="base">
        <div className="hyv">
          <AdminTheme />

          <div className="hyv-stack">
            {/* Header: who, when, how much, and where it stands */}
            <div className="hyv-panel" style={{ padding: "18px 20px" }}>
              <div className="hyv-hero">
                <div style={{ display: "flex", gap: "12px", alignItems: "center", minWidth: 0 }}>
                  <span className="hyv-avatar">{getInitials(customerName)}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "17px", fontWeight: 700, letterSpacing: "-0.01em" }}>
                        {customerName}
                      </span>
                      <Pill tone={quote.quoteStatus.tone}>{quote.quoteStatus.label}</Pill>
                    </div>
                    <p className="hyv-muted" style={{ margin: "3px 0 0" }}>
                      {quote.customer?.email || "No email on file"} · raised{" "}
                      {formatDateTime(quote.createdAt)}
                    </p>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="hyv-muted" style={{ fontSize: "12px" }}>
                    Total
                  </div>
                  <div className="hyv-hero__value">
                    {formatMoney(quote.totalPriceSet?.shopMoney?.amount, currency)}
                  </div>
                </div>
              </div>
            </div>

            {!decided ? (
              <s-banner tone="warning" heading="Waiting on your decision">
                <s-paragraph>
                  The buyer sees this quote as awaiting action until you accept or decline it.
                </s-paragraph>
              </s-banner>
            ) : null}

            <div className="hyv-split">
              {/* Items */}
              <div className="hyv-panel">
                <div className="hyv-panel__head">
                  <span className="hyv-panel__title">
                    Items ({lines.length})
                  </span>
                </div>
                {lines.length === 0 ? (
                  <div className="hyv-empty">
                    <div className="hyv-empty__title">No line items</div>
                    <p className="hyv-empty__text">This draft order has nothing on it.</p>
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="hyv-table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th className="hyv-num">Qty</th>
                          <th className="hyv-num">Unit</th>
                          <th className="hyv-num">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((line) => {
                          const unit = Number(
                            line.discountedUnitPriceSet?.shopMoney?.amount ??
                              line.originalUnitPriceSet?.shopMoney?.amount ??
                              0,
                          );
                          return (
                            <tr key={line.id}>
                              <td>
                                <div className="hyv-table__title">{line.title || line.name}</div>
                                {line.sku ? (
                                  <div className="hyv-table__meta">SKU {line.sku}</div>
                                ) : null}
                              </td>
                              <td className="hyv-num">{line.quantity}</td>
                              <td className="hyv-num">{formatMoney(unit, currency)}</td>
                              <td className="hyv-num" style={{ fontWeight: 650 }}>
                                {formatMoney(unit * line.quantity, currency)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Summary */}
              <div className="hyv-panel" style={{ padding: "16px 18px" }}>
                <div className="hyv-panel__title" style={{ marginBottom: "8px" }}>
                  Summary
                </div>
                <div className="hyv-total">
                  <span className="hyv-total__key">Subtotal</span>
                  <span className="hyv-total__val">
                    {formatMoney(quote.subtotalPriceSet?.shopMoney?.amount, currency)}
                  </span>
                </div>
                <div className="hyv-total">
                  <span className="hyv-total__key">Shipping</span>
                  <span className="hyv-total__val">
                    {formatMoney(quote.totalShippingPriceSet?.shopMoney?.amount, currency)}
                  </span>
                </div>
                <div className="hyv-total">
                  <span className="hyv-total__key">Tax</span>
                  <span className="hyv-total__val">
                    {formatMoney(quote.totalTaxSet?.shopMoney?.amount, currency)}
                  </span>
                </div>
                <div className="hyv-total hyv-total--grand">
                  <span className="hyv-total__key">Total</span>
                  <span className="hyv-total__val">
                    {formatMoney(quote.totalPriceSet?.shopMoney?.amount, currency)}
                  </span>
                </div>
              </div>
            </div>

            {/* Contact and delivery */}
            <div className="hyv-panel" style={{ padding: "4px 18px 14px" }}>
              <div className="hyv-kv">
                <div className="hyv-kv__item">
                  <div className="hyv-kv__key">Contact email</div>
                  <div className="hyv-kv__val">{quote.customer?.email || "—"}</div>
                </div>
                <div className="hyv-kv__item">
                  <div className="hyv-kv__key">Contact phone</div>
                  <div className="hyv-kv__val">{quote.customer?.phone || "—"}</div>
                </div>
                <div className="hyv-kv__item">
                  <div className="hyv-kv__key">Last updated</div>
                  <div className="hyv-kv__val">{formatDateTime(quote.updatedAt)}</div>
                </div>
                <div className="hyv-kv__item">
                  <div className="hyv-kv__key">Shipping address</div>
                  <div className="hyv-kv__val">
                    {addressLines.length ? addressLines.join(", ") : "None on file"}
                  </div>
                </div>
              </div>
            </div>

            {/* Decision */}
            <div className="hyv-panel" style={{ padding: "16px 18px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "14px",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div className="hyv-panel__title">Decision</div>
                  <p className="hyv-muted" style={{ margin: "3px 0 0" }}>
                    {isAccepted
                      ? "The buyer sees this quote as accepted and can order from it."
                      : isRejected
                        ? "The buyer sees this quote as declined and is offered a requote."
                        : "Accepting or declining updates the buyer's portal straight away."}
                  </p>
                </div>
                <s-stack direction="inline" gap="small-200">
                  <s-button
                    variant="primary"
                    disabled={isSubmitting || isAccepted}
                    loading={isSubmitting && fetcher.formData?.get("targetStatus") === "accepted"}
                    onClick={() => handleUpdateStatus("accepted")}
                  >
                    Accept quote
                  </s-button>
                  <s-button
                    tone="critical"
                    disabled={isSubmitting || isRejected}
                    loading={isSubmitting && fetcher.formData?.get("targetStatus") === "rejected"}
                    onClick={() => handleUpdateStatus("rejected")}
                  >
                    Decline
                  </s-button>
                  {decided ? (
                    <s-button
                      variant="tertiary"
                      disabled={isSubmitting}
                      onClick={() => handleUpdateStatus("awaiting_action")}
                    >
                      Reset
                    </s-button>
                  ) : null}
                </s-stack>
              </div>
            </div>
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("[quote detail] render failed:", error);

  return (
    <s-page heading="Quote">
      <s-section>
        <s-banner tone="critical" heading="We couldn't load this quote">
          <s-paragraph>{error?.message || "Please reload the page."}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
