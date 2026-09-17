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
            metafield(namespace: "$app", key: "hyve_status") {
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
  const { quotes, shop, error } = useLoaderData();
  const navigate = useNavigate();

  const [tab, setTab] = useState(STATUS_KEYS.ALL);
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);

  const counts = useMemo(
    () => ({
      all: quotes.length,
      [STATUS_KEYS.AWAITING_ACTION]: quotes.filter((q) => q.quoteStatus.key === STATUS_KEYS.AWAITING_ACTION).length,
      [STATUS_KEYS.ACCEPTED]: quotes.filter((q) => q.quoteStatus.key === STATUS_KEYS.ACCEPTED).length,
      [STATUS_KEYS.REJECTED]: quotes.filter((q) => q.quoteStatus.key === STATUS_KEYS.REJECTED).length,
    }),
    [quotes],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return quotes.filter((quote) => {
      if (tab !== STATUS_KEYS.ALL && quote.quoteStatus.key !== tab) return false;
      if (!needle) return true;
      const haystack = [
        quote.name,
        quote.customer?.displayName,
        quote.customer?.email,
        ...(quote.lineItems?.nodes || []).map((li) => li.title || li.name),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [quotes, tab, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const changeTab = useCallback((next) => {
    setTab(next);
    setPage(1);
  }, []);

  const itemsFor = (quote) => {
    const lines = quote.lineItems?.nodes || [];
    if (!lines.length) return "—";
    const first = `${lines[0].title || lines[0].name}${lines[0].quantity > 1 ? ` ×${lines[0].quantity}` : ""}`;
    return lines.length > 1 ? `${first} +${lines.length - 1} more` : first;
  };

  return (
    <s-page heading="Quotes" inlineSize="large">
      <s-button
        slot="primary-action"
        href={getShopifyAdminDraftOrderUrl("", shop)}
        target="_blank"
        variant="primary"
      >
        Open draft orders
      </s-button>

      {error ? (
        <s-banner tone="critical" heading="We couldn't load quotes">
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section padding="base">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr auto 1fr auto 1fr auto 1fr"
          gap="small"
        >
          <s-clickable
            onClick={() => changeTab(STATUS_KEYS.ALL)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>All quotes</s-heading>
              <s-text type="strong">{counts.all}</s-text>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            onClick={() => changeTab(STATUS_KEYS.AWAITING_ACTION)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Awaiting action</s-heading>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text type="strong">{counts[STATUS_KEYS.AWAITING_ACTION]}</s-text>
                {counts[STATUS_KEYS.AWAITING_ACTION] > 0 ? <s-badge tone="warning">Open</s-badge> : null}
              </s-stack>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            onClick={() => changeTab(STATUS_KEYS.ACCEPTED)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Accepted</s-heading>
              <s-text type="strong">{counts[STATUS_KEYS.ACCEPTED]}</s-text>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            onClick={() => changeTab(STATUS_KEYS.REJECTED)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Declined</s-heading>
              <s-text type="strong">{counts[STATUS_KEYS.REJECTED]}</s-text>
            </s-grid>
          </s-clickable>
        </s-grid>
      </s-section>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
            <s-search-field
              label="Search quotes"
              labelAccessibilityVisibility="exclusive"
              placeholder="Quote number, customer or product"
              value={query}
              onInput={(e) => {
                setQuery(e?.currentTarget?.value ?? e?.target?.value ?? "");
                setPage(1);
              }}
            />
            <s-select
              label="Per page"
              labelAccessibilityVisibility="exclusive"
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e?.currentTarget?.value ?? e?.target?.value ?? PAGE_SIZE_OPTIONS[0]));
                setPage(1);
              }}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <s-option key={size} value={String(size)}>
                  {size} per page
                </s-option>
              ))}
            </s-select>
          </s-grid>

          <s-stack direction="inline" gap="small-200">
            {TABS.map((item) => (
              <s-button
                key={item.id}
                variant={tab === item.id ? "primary" : "tertiary"}
                onClick={() => changeTab(item.id)}
              >
                {item.label}
              </s-button>
            ))}
          </s-stack>

          {visible.length === 0 ? (
            <s-box padding="large-100" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200" alignItems="center">
                <s-heading>No quotes here</s-heading>
                <s-paragraph color="subdued">
                  {quotes.length === 0
                    ? "Quotes raised from the storefront or the distributor portal will appear here."
                    : "Nothing matches this filter. Try another tab or clear the search."}
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Quote</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Items</s-table-header>
                <s-table-header>Created</s-table-header>
                <s-table-header format="currency">Total</s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {visible.map((quote) => (
                  <s-table-row key={quote.id} onClick={() => navigate(`/app/quote/${quote.numericId}`)}>
                    <s-table-cell>
                      <s-link href={`/app/quote/${quote.numericId}`}>{quote.name}</s-link>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{quote.customer?.displayName || "Guest"}</s-text>
                        <s-text color="subdued">{quote.customer?.email || ""}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{itemsFor(quote)}</s-table-cell>
                    <s-table-cell>{formatDate(quote.createdAt)}</s-table-cell>
                    <s-table-cell>
                      {formatMoney(
                        quote.totalPriceSet?.shopMoney?.amount,
                        quote.totalPriceSet?.shopMoney?.currencyCode,
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={quote.quoteStatus.tone}>{quote.quoteStatus.label}</s-badge>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          {totalPages > 1 ? (
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button
                variant="tertiary"
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </s-button>
              <s-text color="subdued">
                Page {currentPage} of {totalPages} · {filtered.length} quote
                {filtered.length === 1 ? "" : "s"}
              </s-text>
              <s-button
                variant="tertiary"
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </s-button>
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
