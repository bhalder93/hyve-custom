/* eslint-disable react/prop-types */
import { useState, useMemo, useEffect, useCallback } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

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

function formatDate(dateStr) {
  if (!dateStr) return "—";
  try {
    const d = new Date(dateStr);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return dateStr;
  }
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
          metafield(namespace: "app", key: "hyve_status") {
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
    const metafieldId = String(formData.get("metafieldId") || "").trim();

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
                  namespace: "app",
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
        let targetMetafieldId = metafieldId;
        if (!targetMetafieldId) {
          const fetchRes = await admin.graphql(
            `#graphql
            query GetDraftOrderMetafield($id: ID!) {
              draftOrder(id: $id) {
                id
                metafield(namespace: "app", key: "hyve_status") {
                  id
                }
              }
            }`,
            { variables: { id: draftOrderId } },
          );
          const fetchJson = await fetchRes.json();
          targetMetafieldId = fetchJson?.data?.draftOrder?.metafield?.id;
        }

        if (targetMetafieldId) {
          const delRes = await admin.graphql(
            `#graphql
            mutation DeleteDraftOrderHyveStatus($input: MetafieldDeleteInput!) {
              metafieldDelete(input: $input) {
                deletedId
                userErrors {
                  field
                  message
                }
              }
            }`,
            {
              variables: {
                input: {
                  id: targetMetafieldId,
                },
              },
            },
          );

          const delJson = await delRes.json();
          const errors = delJson?.data?.metafieldDelete?.userErrors;
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
          metafieldId: quote.metafield?.id || "",
        },
        { method: "post" },
      );
    },
    [fetcher, quote.id, quote.metafield?.id],
  );

  const isSubmitting = fetcher.state !== "idle";
  const shopifyAdminUrl = useMemo(
    () => getShopifyAdminDraftOrderUrl(quote.id, shop),
    [quote.id, shop],
  );

  const isAccepted = quote.quoteStatus.key === STATUS_KEYS.ACCEPTED;
  const isRejected = quote.quoteStatus.key === STATUS_KEYS.REJECTED;
  const isAwaiting = quote.quoteStatus.key === STATUS_KEYS.AWAITING_ACTION;

  const pageTitle = quote.name || `Quote #${quote.numericId}`;
  const customerInitials = useMemo(
    () => getInitials(quote.customer?.displayName),
    [quote.customer?.displayName],
  );

  return (
    <s-page heading={pageTitle} inlineSize="large">
      {/* Breadcrumb back to Quotes */}
      <s-link slot="breadcrumb-actions" href="/app/quotes">Quotes</s-link>

      {/* Primary Action Slot: View Draft Order in Shopify Admin */}
      <s-button
        slot="primary-action"
        variant="primary"
        href={shopifyAdminUrl}
        target="_blank"
        onClick={() => {
          if (shopifyAdminUrl) window.open(shopifyAdminUrl, "_blank");
        }}
      >
        View Draft Order in Shopify ↗
      </s-button>

      {/* Secondary Action Slot: Checkout Invoice Link */}
      {quote.invoiceUrl && (
        <s-button
          slot="secondary-actions"
          variant="secondary"
          href={quote.invoiceUrl}
          target="_blank"
        >
          Checkout Invoice ↗
        </s-button>
      )}

      <s-stack direction="block" gap="large">
        {/* Top Status Banner */}
        {isAwaiting && (
          <s-banner tone="warning" heading="Awaiting Action">
            <s-paragraph>
              This quote was submitted via the storefront B2B portal and is waiting for merchant review. You can accept or reject it below.
            </s-paragraph>
          </s-banner>
        )}

        {isAccepted && (
          <s-banner tone="success" heading="Quote Accepted">
            <s-paragraph>
              This quote has been approved. The customer sees this quote marked as Accepted in their portal.
            </s-paragraph>
          </s-banner>
        )}

        {isRejected && (
          <s-banner tone="critical" heading="Quote Rejected">
            <s-paragraph>
              This quote has been declined. The customer sees this quote marked as Declined in their portal.
            </s-paragraph>
          </s-banner>
        )}

        {/* Main Grid: Details + Summary */}
        <s-grid gridTemplateColumns="2fr 1fr" gap="large">
          {/* Left Column: Items and Customer Info */}
          <s-stack direction="block" gap="large">
            {/* Quote Items Table */}
            <s-box padding="none" background="base" border="small base solid" borderRadius="base">
              <s-section heading="Quote Items" padding="base">
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Item &amp; Description</s-table-header>
                    <s-table-header>SKU</s-table-header>
                    <s-table-header format="numeric">Quantity</s-table-header>
                    <s-table-header format="currency">Unit Price</s-table-header>
                    <s-table-header format="currency">Total</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {(quote.lineItems?.nodes || []).map((item) => {
                      const unitPrice =
                        item.discountedUnitPriceSet?.shopMoney ||
                        item.originalUnitPriceSet?.shopMoney;
                      const lineTotal =
                        Number(unitPrice?.amount || 0) * (item.quantity || 1);

                      return (
                        <s-table-row key={item.id}>
                          <s-table-cell>
                            <s-stack direction="block" gap="extra-small">
                              <s-text type="strong">{item.title || item.name}</s-text>
                            </s-stack>
                          </s-table-cell>
                          <s-table-cell>
                            <s-text tone="subdued">{item.sku || "—"}</s-text>
                          </s-table-cell>
                          <s-table-cell>
                            <s-text>{item.quantity}</s-text>
                          </s-table-cell>
                          <s-table-cell>
                            <s-text>
                              {formatMoney(unitPrice?.amount, unitPrice?.currencyCode)}
                            </s-text>
                          </s-table-cell>
                          <s-table-cell>
                            <s-text type="strong">
                              {formatMoney(lineTotal, unitPrice?.currencyCode)}
                            </s-text>
                          </s-table-cell>
                        </s-table-row>
                      );
                    })}
                  </s-table-body>
                </s-table>
              </s-section>
            </s-box>

            {/* Customer Information Card */}
            <s-box padding="large" background="base" borderRadius="base">
              <s-section heading="Customer &amp; Contact Information" padding="none">
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-avatar initials={customerInitials} size="large" />
                    <s-stack direction="block" gap="extra-small">
                      <s-text type="strong">
                        {quote.customer?.displayName || "Guest Customer"}
                      </s-text>
                      <s-text tone="subdued" type="small">
                        {quote.customer?.email || "No email address provided"}
                      </s-text>
                    </s-stack>
                  </s-stack>

                  <s-divider />

                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-box>
                      <s-text type="strong">Contact Phone</s-text>
                      <s-paragraph tone="subdued">
                        {quote.customer?.phone || quote.shippingAddress?.phone || "—"}
                      </s-paragraph>
                    </s-box>
                    <s-box>
                      <s-text type="strong">Shopify Customer ID</s-text>
                      <s-paragraph tone="subdued">
                        {quote.customer?.id ? quote.customer.id.replace("gid://shopify/Customer/", "") : "—"}
                      </s-paragraph>
                    </s-box>
                  </s-grid>

                  <s-divider />

                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-box>
                      <s-text type="strong">Shipping Address</s-text>
                      <s-paragraph tone="subdued">
                        {quote.shippingAddress
                          ? [
                            quote.shippingAddress.name,
                            quote.shippingAddress.address1,
                            quote.shippingAddress.address2,
                            quote.shippingAddress.city,
                            quote.shippingAddress.province,
                            quote.shippingAddress.zip,
                            quote.shippingAddress.country,
                          ]
                            .filter(Boolean)
                            .join(", ")
                          : "No shipping address on file"}
                      </s-paragraph>
                    </s-box>
                    <s-box>
                      <s-text type="strong">Billing Address</s-text>
                      <s-paragraph tone="subdued">
                        {quote.billingAddress
                          ? [
                            quote.billingAddress.name,
                            quote.billingAddress.address1,
                            quote.billingAddress.address2,
                            quote.billingAddress.city,
                            quote.billingAddress.province,
                            quote.billingAddress.zip,
                            quote.billingAddress.country,
                          ]
                            .filter(Boolean)
                            .join(", ")
                          : "Same as shipping address"}
                      </s-paragraph>
                    </s-box>
                  </s-grid>
                </s-stack>
              </s-section>
            </s-box>
          </s-stack>

          {/* Right Column: Financials & Admin Jump */}
          <s-stack direction="block" gap="large">
            {/* Financial Breakdown Card */}
            <s-box padding="large" background="base" border="small base solid" borderRadius="base">
              <s-section heading="Financial Summary" padding="none">
                <s-stack direction="block" gap="small-200">
                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text tone="subdued">Subtotal</s-text>
                    <s-text>
                      {formatMoney(
                        quote.subtotalPriceSet?.shopMoney?.amount,
                        quote.subtotalPriceSet?.shopMoney?.currencyCode,
                      )}
                    </s-text>
                  </s-stack>

                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text tone="subdued">Estimated Taxes</s-text>
                    <s-text>
                      {formatMoney(
                        quote.totalTaxSet?.shopMoney?.amount,
                        quote.totalTaxSet?.shopMoney?.currencyCode,
                      )}
                    </s-text>
                  </s-stack>

                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text tone="subdued">Shipping</s-text>
                    <s-text>
                      {formatMoney(
                        quote.totalShippingPriceSet?.shopMoney?.amount,
                        quote.totalShippingPriceSet?.shopMoney?.currencyCode,
                      )}
                    </s-text>
                  </s-stack>

                  <s-divider />

                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-text type="strong">Total Amount</s-text>
                    <s-heading>
                      {formatMoney(
                        quote.totalPriceSet?.shopMoney?.amount,
                        quote.totalPriceSet?.shopMoney?.currencyCode,
                      )}
                    </s-heading>
                  </s-stack>
                </s-stack>
              </s-section>
            </s-box>
          </s-stack>
        </s-grid>


        {/* Status Decision Controls Card */}
        <s-box padding="large" background="base" border="small base solid" borderRadius="base">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-stack direction="block" gap="extra-small">
                <s-heading>Quote Decision &amp; Workflow Status</s-heading>

              </s-stack>

              <s-badge tone={quote.quoteStatus.tone} size="base">
                {quote.quoteStatus.label}
              </s-badge>
            </s-stack>

            <s-divider />

            <s-stack direction="inline" gap="small-300" alignItems="center">
              {/* Accept Button */}
              <s-button
                variant={isAccepted ? "primary" : "secondary"}
                tone="success"
                disabled={isSubmitting || isAccepted}
                loading={isSubmitting && fetcher.formData?.get("targetStatus") === "accepted"}
                onClick={() => handleUpdateStatus("accepted")}
              >
                ✓ Mark as Accepted
              </s-button>

              {/* Reject Button */}
              <s-button
                variant={isRejected ? "primary" : "secondary"}
                tone="critical"
                disabled={isSubmitting || isRejected}
                loading={isSubmitting && fetcher.formData?.get("targetStatus") === "rejected"}
                onClick={() => handleUpdateStatus("rejected")}
              >
                ✕ Mark as Rejected
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>

      </s-stack>


    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
