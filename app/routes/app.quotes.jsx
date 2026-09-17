/* eslint-disable react/prop-types */
import { useState, useMemo, useCallback } from "react";
import { useLoaderData, useRouteError, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

/* ==========================================================================
   Constants & Helpers
   ========================================================================== */

const PAGE_SIZE_OPTIONS = [10, 20, 50];

const STATUS_KEYS = {
  ALL: "all",
  AWAITING_ACTION: "awaiting_action",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
};

const TABS = [
  { id: STATUS_KEYS.ALL, label: "All Quotes" },
  { id: STATUS_KEYS.AWAITING_ACTION, label: "Awaiting Action" },
  { id: STATUS_KEYS.ACCEPTED, label: "Accepted" },
  { id: STATUS_KEYS.REJECTED, label: "Rejected" },
];

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

function getShopifyAllDraftOrdersUrl(shop) {
  const shopHandle = String(shop || "").replace(".myshopify.com", "");
  if (shopHandle) {
    return `https://admin.shopify.com/store/${shopHandle}/draft_orders`;
  }
  return `https://${shop}/admin/draft_orders`;
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

/* ==========================================================================
   Loader
   ========================================================================== */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";

  try {
    const response = await admin.graphql(
      `#graphql
      query GetStorefrontQuotesList($query: String!) {
        draftOrders(first: 100, query: $query, sortKey: UPDATED_AT, reverse: true) {
          nodes {
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
            customer {
              id
              displayName
              email
            }
            lineItems(first: 20) {
              nodes {
                id
                title
                name
                quantity
              }
            }
            metafield(namespace: "app", key: "hyve_status") {
              id
              value
              type
            }
          }
        }
      }`,
      {
        variables: {
          query: "tag:storefront-quote",
        },
      },
    );

    const json = await response.json();
    const draftNodes = json?.data?.draftOrders?.nodes || [];

    const quotes = draftNodes.map((node) => {
      const statusInfo = parseQuoteStatus(node.metafield);
      return {
        ...node,
        numericId: cleanDraftOrderId(node.id),
        quoteStatus: statusInfo,
      };
    });

    return {
      quotes,
      shop,
      error: null,
    };
  } catch (err) {
    console.error("[app.quotes.loader] Error fetching quotes:", err);
    return {
      quotes: [],
      shop,
      error: err?.message || "Failed to load storefront quotes.",
    };
  }
};

/* ==========================================================================
   Quotes List Page Component
   ========================================================================== */

export default function AdminQuotesListPage() {
  const { quotes, shop, error: loaderError } = useLoaderData();
  const navigate = useNavigate();

  const [selectedTab, setSelectedTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Status breakdown metrics
  const counts = useMemo(() => {
    let awaiting = 0;
    let accepted = 0;
    let rejected = 0;

    (quotes || []).forEach((q) => {
      if (q.quoteStatus.key === STATUS_KEYS.ACCEPTED) accepted++;
      else if (q.quoteStatus.key === STATUS_KEYS.REJECTED) rejected++;
      else awaiting++;
    });

    return {
      total: (quotes || []).length,
      awaiting,
      accepted,
      rejected,
    };
  }, [quotes]);

  // Client-side filtering by tab and search query
  const filteredQuotes = useMemo(() => {
    const activeTab = TABS[selectedTab]?.id || STATUS_KEYS.ALL;
    const query = searchQuery.trim().toLowerCase();

    return (quotes || []).filter((q) => {
      if (activeTab !== STATUS_KEYS.ALL && q.quoteStatus.key !== activeTab) {
        return false;
      }

      if (query) {
        const nameMatch = (q.name || "").toLowerCase().includes(query);
        const custNameMatch = (q.customer?.displayName || "").toLowerCase().includes(query);
        const custEmailMatch = (q.customer?.email || "").toLowerCase().includes(query);
        const lineItemMatch = (q.lineItems?.nodes || []).some((item) =>
          (item.title || item.name || "").toLowerCase().includes(query),
        );
        return nameMatch || custNameMatch || custEmailMatch || lineItemMatch;
      }

      return true;
    });
  }, [quotes, selectedTab, searchQuery]);

  // Pagination calculations
  const totalPages = Math.max(1, Math.ceil(filteredQuotes.length / pageSize));

  const paginatedQuotes = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredQuotes.slice(start, start + pageSize);
  }, [currentPage, pageSize, filteredQuotes]);

  const startIndex = filteredQuotes.length > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const endIndex = Math.min(currentPage * pageSize, filteredQuotes.length);

  const handleTabChange = useCallback((idx) => {
    setSelectedTab(idx);
    setCurrentPage(1);
  }, []);

  const handleSearchChange = useCallback((val) => {
    setSearchQuery(val);
    setCurrentPage(1);
  }, []);

  return (
    <s-page heading="Quotes" inlineSize="large">
      {/* Secondary / Primary Action Slot */}
      <s-button
        slot="primary-action"
        variant="secondary"
        icon="refresh"
        onClick={() => window.location.reload()}
      >
        Refresh
      </s-button>

      <s-stack direction="block" gap="large">
        {/* Error notification banner if any */}
        {loaderError && (
          <s-banner tone="critical" heading="Could not load quotes">
            <s-paragraph>{loaderError}</s-paragraph>
          </s-banner>
        )}


        {/* Filter Controls & Search Bar */}
        <s-box padding="base" background="base" border="small base solid" borderRadius="base">
          <s-stack direction="block" gap="base">
            {/* Tabs Row */}
            <s-stack direction="inline" gap="small-200" justifyContent="space-between" alignItems="center">
              <s-stack direction="inline" gap="small-200">
                {TABS.map((tab, idx) => (
                  <s-button
                    key={tab.id}
                    variant={selectedTab === idx ? "secondary" : "tertiary"}
                    onClick={() => handleTabChange(idx)}
                  >
                    {tab.label}
                    {tab.id === STATUS_KEYS.ALL && ` (${counts.total})`}
                    {tab.id === STATUS_KEYS.AWAITING_ACTION && ` (${counts.awaiting})`}
                    {tab.id === STATUS_KEYS.ACCEPTED && ` (${counts.accepted})`}
                    {tab.id === STATUS_KEYS.REJECTED && ` (${counts.rejected})`}
                  </s-button>
                ))}
              </s-stack>

              {/* Rows per page selector */}
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text tone="subdued" type="small">Show:</s-text>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <s-button
                    key={size}
                    variant={pageSize === size ? "secondary" : "tertiary"}
                    onClick={() => {
                      setPageSize(size);
                      setCurrentPage(1);
                    }}
                  >
                    {size}
                  </s-button>
                ))}
              </s-stack>
            </s-stack>

            <s-divider />

            {/* Live Search Input */}
            <s-search-field
              label="Search quotes"
              labelAccessibilityVisibility="exclusive"
              placeholder="Filter by quote #, customer name, email, or item title..."
              value={searchQuery}
              onInput={(e) => handleSearchChange(e?.currentTarget?.value ?? e?.target?.value ?? "")}
            />
          </s-stack>
        </s-box>

        {/* Quotes Data Table */}
        <s-box padding="none" background="base" border="small base solid" borderRadius="base">
          {filteredQuotes.length === 0 ? (
            <s-section>
              <s-stack alignItems="center" padding="large-500">

                <s-heading>No results found</s-heading>
                <s-paragraph>
                  Try changing the filters or search term
                </s-paragraph>

              </s-stack>
            </s-section>

          ) : (
            <>
              <s-table>
                <s-table-header-row>
                  <s-table-header>Quote #</s-table-header>
                  <s-table-header>Customer</s-table-header>
                  <s-table-header>Items</s-table-header>
                  <s-table-header>Total Amount</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Submitted Date</s-table-header>
                  <s-table-header>Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {paginatedQuotes.map((quote) => {
                    const detailHref = `/app/quote/${encodeURIComponent(quote.numericId)}`;
                    const adminDraftOrderUrl = getShopifyAdminDraftOrderUrl(quote.id, shop);
                    const totalMoney = quote.totalPriceSet?.shopMoney;
                    const items = quote.lineItems?.nodes || [];
                    const itemsSummary = items.length > 0
                      ? items.map((i) => `${i.title || i.name}${i.quantity > 1 ? ` (x${i.quantity})` : ""}`).slice(0, 2).join(", ") + (items.length > 2 ? ` + ${items.length - 2} more` : "")
                      : "—";

                    return (
                      <s-table-row key={quote.id}>
                        {/* Quote Number / Name */}
                        <s-table-cell>
                          <s-link href={detailHref}>
                            <s-text type="strong">{quote.name || `Quote #${quote.numericId}`}</s-text>
                          </s-link>
                        </s-table-cell>

                        {/* Customer */}
                        <s-table-cell>
                          <s-stack direction="block" gap="extra-small">
                            <s-text>{quote.customer?.displayName || "Guest Customer"}</s-text>
                            <s-text tone="subdued" type="small">
                              {quote.customer?.email || "—"}
                            </s-text>
                          </s-stack>
                        </s-table-cell>

                        {/* Items Summary */}
                        <s-table-cell>
                          <s-paragraph type="small" tone="subdued">
                            {itemsSummary}
                          </s-paragraph>
                        </s-table-cell>

                        {/* Total Amount */}
                        <s-table-cell>
                          <s-text type="strong">
                            {formatMoney(totalMoney?.amount, totalMoney?.currencyCode)}
                          </s-text>
                        </s-table-cell>

                        {/* Status Badge */}
                        <s-table-cell>
                          <s-badge tone={quote.quoteStatus.tone}>
                            {quote.quoteStatus.label}
                          </s-badge>
                        </s-table-cell>

                        {/* Submitted Date */}
                        <s-table-cell>
                          <s-text tone="subdued" type="small">
                            {formatDate(quote.createdAt)}
                          </s-text>
                        </s-table-cell>

                        {/* Actions */}
                        <s-table-cell>
                          <s-stack direction="inline" gap="small-200" alignItems="center">
                            <s-button
                              variant="secondary"
                              href={detailHref}
                              onClick={(e) => {
                                e.preventDefault();
                                navigate(detailHref);
                              }}
                            >
                              View Details
                            </s-button>
                            <s-button
                              variant="tertiary"
                              href={adminDraftOrderUrl}
                              target="_blank"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (adminDraftOrderUrl) window.open(adminDraftOrderUrl, "_blank");
                              }}
                            >
                              Shopify ↗
                            </s-button>
                          </s-stack>
                        </s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>

              {/* Full Pagination Controls */}
              <s-divider />
              <s-box padding="base" background="base">
                <s-stack
                  direction="inline"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-text tone="subdued" type="small">
                    Showing <strong>{startIndex}–{endIndex}</strong> of <strong>{filteredQuotes.length}</strong> quotes
                  </s-text>

                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-button
                      variant="secondary"
                      disabled={currentPage <= 1}
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </s-button>

                    <s-text tone="subdued" type="small">
                      Page {currentPage} of {totalPages}
                    </s-text>

                    <s-button
                      variant="secondary"
                      disabled={currentPage >= totalPages}
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    >
                      Next
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            </>
          )}
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
