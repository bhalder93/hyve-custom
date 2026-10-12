
/* eslint-disable react/prop-types */
import { useState, useMemo, useCallback } from "react";
import { useLoaderData, useRouteError, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadStaffQuotes } from "../lib/account-quotes.server";
import { STAFF_QUOTE_LABELS, STAFF_QUOTE_TONES } from "../lib/quote-labels";

const PAGE_SIZE_OPTIONS = [10, 20, 50];

const STATUS_KEYS = {
  ALL: "all",
  CREATED: "created",
  SENT: "sent",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  EXPIRED: "expired",
};

const TABS = [
  { id: STATUS_KEYS.ALL, label: "All Quotes" },
  { id: STATUS_KEYS.CREATED, label: STAFF_QUOTE_LABELS.created },
  { id: STATUS_KEYS.SENT, label: STAFF_QUOTE_LABELS.sent },
  { id: STATUS_KEYS.ACCEPTED, label: STAFF_QUOTE_LABELS.accepted },
  { id: STATUS_KEYS.DECLINED, label: STAFF_QUOTE_LABELS.declined },
  { id: STATUS_KEYS.EXPIRED, label: STAFF_QUOTE_LABELS.expired },
];

function formatDate(dateStr) {
  if (!dateStr) return "—";

  try {
    const date = new Date(dateStr);

    if (Number.isNaN(date.getTime())) return dateStr;

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return dateStr;
  }
}

function formatMoney(amount, currency = "USD") {
  const num = Number(amount);

  if (!Number.isFinite(num)) {
    return `${currency} 0.00`;
  }

  try {
    return `${currency} ${num.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  } catch {
    return `${currency} ${num.toFixed(2)}`;
  }
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";

  try {
    const quotes = (await loadStaffQuotes(admin)).map((quote) => ({
      ...quote,
      name: quote.reference,
      draftName: quote.name,
      quoteStatus: {
        key: quote.status,
        label: STAFF_QUOTE_LABELS[quote.status] || quote.status,
        tone: STAFF_QUOTE_TONES[quote.status] || "info",
      },
    }));

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

export default function AdminQuotesListPage() {
  const { quotes, error } = useLoaderData();
  const navigate = useNavigate();

  const [tab, setTab] = useState(STATUS_KEYS.ALL);
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);

  const counts = useMemo(
    () => ({
      all: quotes.length,
      [STATUS_KEYS.CREATED]: quotes.filter(
        (quote) => quote.quoteStatus.key === STATUS_KEYS.CREATED,
      ).length,
      [STATUS_KEYS.SENT]: quotes.filter(
        (quote) => quote.quoteStatus.key === STATUS_KEYS.SENT,
      ).length,
      [STATUS_KEYS.ACCEPTED]: quotes.filter(
        (quote) => quote.quoteStatus.key === STATUS_KEYS.ACCEPTED,
      ).length,
      [STATUS_KEYS.DECLINED]: quotes.filter(
        (quote) => quote.quoteStatus.key === STATUS_KEYS.DECLINED,
      ).length,
      [STATUS_KEYS.EXPIRED]: quotes.filter(
        (quote) => quote.quoteStatus.key === STATUS_KEYS.EXPIRED,
      ).length,
    }),
    [quotes],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return quotes.filter((quote) => {
      if (
        tab !== STATUS_KEYS.ALL &&
        quote.quoteStatus.key !== tab
      ) {
        return false;
      }

      if (!needle) return true;

      const haystack = [
        quote.name,
        quote.draftName,
        quote.companyName,
        quote.customer?.displayName,
        quote.customerEmail,
        ...(quote.lineItems?.nodes || []).map(
          (item) => item.title || item.name,
        ),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(needle);
    });
  }, [quotes, tab, query]);

  const totalPages = Math.max(
    1,
    Math.ceil(filtered.length / pageSize),
  );

  const currentPage = Math.min(page, totalPages);

  const visible = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  const changeTab = useCallback((nextTab) => {
    setTab(nextTab);
    setPage(1);
  }, []);

  const itemsFor = (quote) => {
    const lines = quote.lineItems?.nodes || [];

    if (!lines.length) return "—";

    const firstLine = lines[0];
    const firstTitle = firstLine.title || firstLine.name || "Item";

    const first = `${firstTitle}${firstLine.quantity > 1 ? ` ×${firstLine.quantity}` : ""
      }`;

    return lines.length > 1
      ? `${first} +${lines.length - 1} more`
      : first;
  };

  // Open the Shopify draft order only when clicking outside
  // the Quote column and outside interactive links or buttons.
  const handleRowClick = (event) => {
    const target = event.target;

    if (!(target instanceof Element)) return;

    // Allow the Quote link to navigate to the custom quote page.
    if (target.closest('[data-quote-column="true"]')) {
      return;
    }

    // Preserve the normal behavior of buttons and links.
    if (target.closest("s-link, s-button, a, button")) {
      return;
    }

    const row = target.closest("s-table-row");

    if (!row) return;

    const id = row.getAttribute("data-draft-id");

    if (!id) return;

    window.open(
      `shopify:admin/draft_orders/${id}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  return (
    <s-page heading="Quotes" inlineSize="large">
      <s-button
        target="_blank"
        href="shopify:admin/draft_orders"
        slot="primary-action"
      >
        Open draft orders
      </s-button>

      <s-button
        target="_blank"
        href="shopify:admin/draft_orders/new"
        slot="secondary-actions"
      >
        Create quote
      </s-button>

      {error ? (
        <s-banner tone="critical" heading="We couldn't load quotes">
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section padding="base">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr auto 1fr auto 1fr auto 1fr auto 1fr"
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
            onClick={() => changeTab(STATUS_KEYS.SENT)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Awaiting buyer</s-heading>
              <s-stack
                direction="inline"
                gap="small-200"
                alignItems="center"
              >
                <s-text type="strong">
                  {counts[STATUS_KEYS.SENT]}
                </s-text>
                {counts[STATUS_KEYS.SENT] > 0 ? (
                  <s-badge tone="warning">Open</s-badge>
                ) : null}
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
              <s-text type="strong">
                {counts[STATUS_KEYS.ACCEPTED]}
              </s-text>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            onClick={() => changeTab(STATUS_KEYS.DECLINED)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Declined</s-heading>
              <s-text type="strong">
                {counts[STATUS_KEYS.DECLINED]}
              </s-text>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            onClick={() => changeTab(STATUS_KEYS.EXPIRED)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Expired</s-heading>
              <s-text type="strong">
                {counts[STATUS_KEYS.EXPIRED]}
              </s-text>
            </s-grid>
          </s-clickable>
        </s-grid>
      </s-section>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-grid
            gridTemplateColumns="1fr auto"
            gap="base"
            alignItems="end"
          >
            <s-search-field
              label="Search quotes"
              labelAccessibilityVisibility="exclusive"
              placeholder="Quote number, customer or product"
              value={query}
              onInput={(event) => {
                setQuery(
                  event?.currentTarget?.value ??
                  event?.target?.value ??
                  "",
                );
                setPage(1);
              }}
            />

            <s-select
              label="Per page"
              labelAccessibilityVisibility="exclusive"
              value={String(pageSize)}
              onChange={(event) => {
                const value =
                  event?.currentTarget?.value ??
                  event?.target?.value ??
                  PAGE_SIZE_OPTIONS[0];

                setPageSize(Number(value));
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
            <s-box
              padding="large-100"
              borderRadius="base"
              background="subdued"
            >
              <s-stack
                direction="block"
                gap="small-200"
                alignItems="center"
              >
                <s-heading>No quotes here</s-heading>
                <s-paragraph color="subdued">
                  {quotes.length === 0
                    ? "Quotes raised from the storefront or the distributor portal will appear here."
                    : "Nothing matches this filter. Try another tab or clear the search."}
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table variant="auto" onClick={handleRowClick}>
              <s-table-header-row>
                <s-table-header listSlot="primary">
                  Quote
                </s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Items</s-table-header>
                <s-table-header>Created</s-table-header>
                <s-table-header format="currency">
                  Total
                </s-table-header>
                <s-table-header listSlot="labeled">
                  Status
                </s-table-header>
              </s-table-header-row>

              <s-table-body>
                {visible.map((quote) => (
                  <s-table-row
                    key={quote.numericId || quote.name}
                    data-draft-id={quote.numericId}
                    style={{
                      cursor: quote.numericId ? "pointer" : "default",
                    }}
                  >
                    <s-table-cell data-quote-column="true">
                      {quote.numericId ? (
                        <s-link href={`/app/quote/${quote.numericId}`}>
                          {quote.name}
                        </s-link>
                      ) : (
                        <s-text>{quote.name}</s-text>
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>
                          {quote.companyName ||
                            quote.customer?.displayName ||
                            "Guest"}
                        </s-text>
                        <s-text color="subdued">
                          {quote.customerEmail || ""}
                        </s-text>
                      </s-stack>
                    </s-table-cell>

                    <s-table-cell>
                      {itemsFor(quote)}
                    </s-table-cell>

                    <s-table-cell>
                      {formatDate(quote.createdAt)}
                    </s-table-cell>

                    <s-table-cell>
                      {formatMoney(
                        quote.totalPriceSet?.presentmentMoney?.amount,
                        quote.totalPriceSet?.presentmentMoney?.currencyCode,
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <s-badge tone={quote.quoteStatus.tone}>
                        {quote.quoteStatus.label}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          {totalPages > 1 ? (
            <s-stack
              direction="inline"
              gap="base"
              alignItems="center"
            >
              <s-button
                variant="tertiary"
                disabled={currentPage <= 1}
                onClick={() =>
                  setPage((current) => Math.max(1, current - 1))
                }
              >
                Previous
              </s-button>

              <s-text color="subdued">
                Page {currentPage} of {totalPages} · {filtered.length}{" "}
                quote{filtered.length === 1 ? "" : "s"}
              </s-text>

              <s-button
                variant="tertiary"
                disabled={currentPage >= totalPages}
                onClick={() =>
                  setPage((current) =>
                    Math.min(totalPages, current + 1),
                  )
                }
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