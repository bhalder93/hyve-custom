// app/routes/app.production-orders._index.jsx
/* eslint-disable react/prop-types */

import { useState } from "react";
import { useLoaderData, useNavigate } from "react-router";

import { authenticate } from "../shopify.server";
import { STATUS_OPTIONS } from "../lib/production-statuses";
import { productionCalendar, productionDueDate } from "../lib/order-status.server";

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50];

/**
 * Filter queries for production tabs using single quotes for Shopify tag matching.
 */
const ALL_PRODUCTION_QUERY = STATUS_OPTIONS.map(
  (status) => `tag:'hyve-status:${status.value}'`,
).join(" OR ");

const TAB_CONFIG = {
  all: {
    id: "all",
    label: "All Orders",
    query: ALL_PRODUCTION_QUERY,
  },
  artwork: {
    id: "artwork",
    label: "Artwork & Proof",
    query:
      "tag:'hyve-status:order-placed' OR tag:'hyve-status:artwork-received' OR tag:'hyve-status:proof-sent'",
  },
  production: {
    id: "production",
    label: "In Production",
    query:
      "tag:'hyve-status:proof-approved' OR tag:'hyve-status:in-production'",
  },
  dispatch: {
    id: "dispatch",
    label: "Ready / Dispatch",
    query:
      "tag:'hyve-status:production-complete' OR tag:'hyve-status:ready-for-collection' OR tag:'hyve-status:shipped'",
  },
  hold: {
    id: "hold",
    label: "On Hold",
    query: "tag:'hyve-status:on-hold'",
  },
  delivered: {
    id: "delivered",
    label: "Completed",
    query: "tag:'hyve-status:delivered'",
  },
};

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function getStatusLabel(value) {
  return (
    STATUS_OPTIONS.find((item) => item.value === value)?.label ||
    value ||
    "Not set"
  );
}

function statusTone(status) {
  switch (status) {
    case "production-complete":
    case "ready-for-collection":
    case "shipped":
    case "delivered":
      return "success";

    case "on-hold":
      return "critical";

    case "proof-sent":
    case "proof-approved":
    case "in-production":
      return "info";

    case "artwork-received":
      return "warning";

    default:
      return "neutral";
  }
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Singapore",
  }).format(date);
}

function formatDay(value) {
  if (!value) return "—";

  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const mIdx = parseInt(month, 10) - 1;
    if (mIdx >= 0 && mIdx < 12) {
      return `${parseInt(day, 10)} ${months[mIdx]} ${year}`;
    }
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Singapore",
  }).format(date);
}

function formatMoney(amount, currency) {
  const numeric = Number(amount);
  if (Number.isNaN(numeric)) {
    return `${currency || ""} ${amount}`.trim();
  }

  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency: currency || "USD",
    }).format(numeric);
  } catch {
    return `${currency || ""} ${numeric.toFixed(2)}`;
  }
}

function extractOrderNumericId(gid) {
  if (!gid) return "";
  return gid.split("/").pop();
}

/**
 * Intelligent production due date & SLA countdown helper.
 */
function getDueStatus(dueAt, status) {
  if (!dueAt) return null;
  if (status === "delivered" || status === "shipped") {
    return { tone: "neutral", label: "Completed", isOverdue: false, isDueSoon: false };
  }

  const dueDate = new Date(dueAt);
  if (Number.isNaN(dueDate.getTime())) return null;

  const now = new Date();
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(
    dueDate.getFullYear(),
    dueDate.getMonth(),
    dueDate.getDate(),
  );

  const diffDays = Math.round(
    (dueDay.getTime() - nowDay.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays < 0) {
    const overdueDays = Math.abs(diffDays);
    return {
      tone: "critical",
      label: `Overdue (${overdueDays}d)`,
      isOverdue: true,
      isDueSoon: false,
    };
  }

  if (diffDays === 0) {
    return {
      tone: "critical",
      label: "Due Today",
      isOverdue: false,
      isDueSoon: true,
    };
  }

  if (diffDays <= 2) {
    return {
      tone: "warning",
      label: `Due in ${diffDays}d`,
      isOverdue: false,
      isDueSoon: true,
    };
  }

  return {
    tone: "neutral",
    label: `In ${diffDays}d`,
    isOverdue: false,
    isDueSoon: false,
  };
}

/**
 * Summarizes line items, total units, and thumbnail for production visibility.
 */
function getLineItemsSummary(lineItems = []) {
  if (!lineItems || !lineItems.length) {
    return {
      totalUnits: 0,
      itemCount: 0,
      firstTitle: "No items",
      firstVariant: "",
      firstSku: "",
      firstImage: null,
      otherCount: 0,
      otherUnits: 0,
    };
  }

  let totalUnits = 0;
  for (const item of lineItems) {
    totalUnits += Number(item.quantity || 0);
  }

  const first = lineItems[0];
  const firstTitle = first.title || "Custom Item";
  const firstVariant =
    first.variantTitle && first.variantTitle !== "Default Title"
      ? first.variantTitle
      : "";
  const firstSku = first.sku || "";
  const firstImage = first.image?.url || null;
  const otherCount = lineItems.length - 1;
  const otherUnits = Math.max(0, totalUnits - Number(first.quantity || 0));

  return {
    totalUnits,
    itemCount: lineItems.length,
    firstTitle,
    firstVariant,
    firstSku,
    firstQuantity: first.quantity || 1,
    firstImage,
    otherCount,
    otherUnits,
  };
}

function isCustomerArrangedFreight(order) {
  if (Array.isArray(order.tags) && order.tags.includes("hyve-freight:customer-arranged")) {
    return true;
  }
  const title = String(order.shippingLineTitle || "").trim();
  return /\bFOB\b/i.test(title);
}

/* -------------------------------------------------------------------------- */
/*                                  Loader                                    */
/* -------------------------------------------------------------------------- */

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  try {
    const url = new URL(request.url);
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");
    const search = url.searchParams.get("search")?.trim() || "";
    const activeTab = url.searchParams.get("tab") || "all";
    const pageSizeParam = Number(url.searchParams.get("pageSize"));
    const pageSize = PAGE_SIZE_OPTIONS.includes(pageSizeParam)
      ? pageSizeParam
      : DEFAULT_PAGE_SIZE;

    const goingBackward = Boolean(before);

    // Determine query string based on active tab
    const baseTabQuery = TAB_CONFIG[activeTab]?.query || ALL_PRODUCTION_QUERY;
    const finalQuery = search
      ? `(${search}) AND (${baseTabQuery})`
      : baseTabQuery;

    // Fetch tab counts and order listing
    const [countsResponse, ordersResponse, calendar] = await Promise.all([
      admin
        .graphql(
          `#graphql
            query ProductionTabCounts {
              all: ordersCount(query: "${TAB_CONFIG.all.query}") { count }
              artwork: ordersCount(query: "${TAB_CONFIG.artwork.query}") { count }
              production: ordersCount(query: "${TAB_CONFIG.production.query}") { count }
              dispatch: ordersCount(query: "${TAB_CONFIG.dispatch.query}") { count }
              onHold: ordersCount(query: "${TAB_CONFIG.hold.query}") { count }
              delivered: ordersCount(query: "${TAB_CONFIG.delivered.query}") { count }
            }
          `,
        )
        .then((res) => res.json())
        .catch(() => null),

      admin.graphql(
        `#graphql
          query ProductionOrders(
            $first: Int
            $last: Int
            $after: String
            $before: String
            $query: String
          ) {
            orders(
              first: $first
              last: $last
              after: $after
              before: $before
              query: $query
              sortKey: CREATED_AT
              reverse: true
            ) {
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }

              nodes {
                id
                name
                createdAt
                tags
                email

                displayFinancialStatus
                displayFulfillmentStatus

                totalPriceSet {
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }

                customer {
                  displayName
                  email
                }

                shippingAddress {
                  company
                  city
                  country
                }

                shippingLine {
                  title
                }

                lineItems(first: 10) {
                  nodes {
                    id
                    title
                    quantity
                    sku
                    variantTitle
                    image {
                      url
                      altText
                    }
                  }
                }

                productionStatus: metafield(
                  namespace: "$app"
                  key: "production_status"
                ) {
                  value
                }

                statusChangedAt: metafield(
                  namespace: "$app"
                  key: "status_changed_at"
                ) {
                  value
                }

                productionDueAt: metafield(
                  namespace: "$app"
                  key: "production_due_at"
                ) {
                  value
                }

                artworkRequired: metafield(
                  namespace: "$app"
                  key: "artwork_required"
                ) {
                  value
                }

                rush: metafield(
                  namespace: "$app"
                  key: "rush"
                ) {
                  value
                }

                onHoldReason: metafield(
                  namespace: "$app"
                  key: "on_hold_reason"
                ) {
                  value
                }

                proofVersion: metafield(
                  namespace: "$app"
                  key: "proof_version"
                ) {
                  value
                }

                productionPhotoVersion: metafield(
                  namespace: "$app"
                  key: "production_photo_version"
                ) {
                  value
                }

                productionApprovalStatus: metafield(
                  namespace: "$app"
                  key: "production_approval_status"
                ) {
                  value
                }
              }
            }
          }
        `,
        {
          variables: {
            first: goingBackward ? null : pageSize,
            last: goingBackward ? pageSize : null,
            after: goingBackward ? null : after,
            before: goingBackward ? before : null,
            query: finalQuery,
          },
        },
      ),
      productionCalendar(admin).catch(() => null),
    ]);

    const ordersData = await ordersResponse.json();

    if (ordersData.errors?.length) {
      throw new Error(
        ordersData.errors.map((error) => error.message).join(", "),
      );
    }

    const connection = ordersData.data?.orders;

    const orders = (connection?.nodes ?? []).map((order) => {
      const statusFromTag =
        order.tags
          ?.find((tag) => tag.startsWith("hyve-status:"))
          ?.replace("hyve-status:", "") || "";

      let productionDueAt = order.productionDueAt?.value || "";
      if (!productionDueAt && calendar && order.createdAt) {
        try {
          productionDueAt = productionDueDate(
            calendar,
            order.createdAt,
            order.rush?.value === "true",
          );
        } catch {
          // ignore
        }
      }

      return {
        id: order.id,
        numericId: extractOrderNumericId(order.id),
        name: order.name,
        createdAt: order.createdAt,
        company: order.shippingAddress?.company || "",
        customerName: order.customer?.displayName || "Guest customer",
        email: order.customer?.email || order.email || "",
        financialStatus: order.displayFinancialStatus || "",
        fulfillmentStatus: order.displayFulfillmentStatus || "",
        amount: order.totalPriceSet?.presentmentMoney?.amount || "0",
        currency: order.totalPriceSet?.presentmentMoney?.currencyCode || "USD",
        shippingLineTitle: order.shippingLine?.title || "",
        lineItems: order.lineItems?.nodes || [],
        productionStatus: order.productionStatus?.value || statusFromTag || "",
        statusChangedAt: order.statusChangedAt?.value || "",
        productionDueAt,
        artworkRequired: order.artworkRequired?.value === "true",
        rush: order.rush?.value === "true",
        onHoldReason: order.onHoldReason?.value || "",
        proofVersion: order.proofVersion?.value || "",
        productionPhotoVersion: order.productionPhotoVersion?.value || "",
        productionApprovalStatus: order.productionApprovalStatus?.value || "",
        tags: order.tags || [],
      };
    });

    const rawCounts = countsResponse?.data;
    const tabCounts = {
      all: rawCounts?.all?.count ?? orders.length,
      artwork: rawCounts?.artwork?.count ?? 0,
      production: rawCounts?.production?.count ?? 0,
      dispatch: rawCounts?.dispatch?.count ?? 0,
      onHold: rawCounts?.onHold?.count ?? 0,
      delivered: rawCounts?.delivered?.count ?? 0,
    };

    return {
      orders,
      tabCounts,
      activeTab,
      pageSize,
      pageInfo: connection?.pageInfo || {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
      search,
      loaderError: null,
    };
  } catch (error) {
    console.error("Production orders loader error:", error);

    return {
      orders: [],
      tabCounts: {
        all: 0,
        artwork: 0,
        production: 0,
        dispatch: 0,
        onHold: 0,
        delivered: 0,
      },
      activeTab: "all",
      pageSize: DEFAULT_PAGE_SIZE,
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
      search: "",
      loaderError:
        error instanceof Error ? error.message : "Unable to load orders.",
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                               Order Row (table)                            */
/* -------------------------------------------------------------------------- */

function OrderRow({ order }) {
  const items = getLineItemsSummary(order.lineItems);
  const dueStatus = getDueStatus(order.productionDueAt, order.productionStatus);
  const isFob = isCustomerArrangedFreight(order);
  const isHeld = order.productionStatus === "on-hold";

  return (
    <s-table-row>
      {/* 1. Order & Priority */}
      <s-table-cell>
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-link href={`/app/production-orders/${order.numericId}`}>
              <s-text type="strong">{order.name}</s-text>
            </s-link>
            {order.rush && (
              <s-badge tone="critical">RUSH</s-badge>
            )}
          </s-stack>
          <s-text color="subdued">{formatDate(order.createdAt)}</s-text>
        </s-stack>
      </s-table-cell>

      {/* 2. Customer & Company */}
      <s-table-cell>
        <s-stack direction="block" gap="none">
          {order.company ? (
            <s-text type="strong">{order.company}</s-text>
          ) : null}
          <s-text color={order.company ? "subdued" : "base"}>
            {order.customerName}
          </s-text>
          {order.email && (
            <s-text color="subdued">{order.email}</s-text>
          )}
        </s-stack>
      </s-table-cell>

      {/* 3. Items & Production Run */}
      <s-table-cell>
        <s-stack direction="inline" gap="small-300" alignItems="center">
          {items.firstImage ? (
            <img
              src={items.firstImage}
              alt={items.firstTitle}
              style={{
                width: 38,
                height: 38,
                borderRadius: 6,
                objectFit: "cover",
                border: "1px solid #dfe3e8",
                flexShrink: 0,
              }}
            />
          ) : (
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 6,
                backgroundColor: "#f4f6f8",
                border: "1px solid #dfe3e8",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                color: "#637381",
                flexShrink: 0,
              }}
            >
              📦
            </div>
          )}

          <s-stack direction="block" gap="none">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-badge tone="neutral">{items.totalUnits} units</s-badge>
              {items.itemCount > 1 && (
                <s-text color="subdued">({items.itemCount} items)</s-text>
              )}
            </s-stack>

            <s-text type="strong" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {items.firstTitle}
            </s-text>

            {items.firstVariant ? (
              <s-text color="subdued">{items.firstVariant}</s-text>
            ) : items.firstSku ? (
              <s-text color="subdued">SKU: {items.firstSku}</s-text>
            ) : null}

            {items.otherCount > 0 && (
              <s-text color="subdued">
                +{items.otherCount} more ({items.otherUnits} pcs)
              </s-text>
            )}
          </s-stack>
        </s-stack>
      </s-table-cell>

      {/* 4. Production Stage & Hold Status */}
      <s-table-cell>
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone={statusTone(order.productionStatus)}>
              {getStatusLabel(order.productionStatus)}
            </s-badge>

            {order.proofVersion ? (
              <s-badge tone="neutral">Proof v{order.proofVersion}</s-badge>
            ) : null}
          </s-stack>

          {/* Prominent On-Hold Reason */}
          {isHeld ? (
            <div
              style={{
                backgroundColor: "#ffebee",
                border: "1px solid #ffcdd2",
                borderRadius: 4,
                padding: "3px 8px",
                maxWidth: 240,
              }}
            >
              <s-text color="critical" type="strong" style={{ fontSize: 12 }}>
                ⚠️ Hold: {order.onHoldReason || "No reason specified"}
              </s-text>
            </div>
          ) : null}

          {/* Production Photo / Sample Status */}
          {order.productionPhotoVersion ? (
            <s-text color="subdued" style={{ fontSize: 12 }}>
              Photo v{order.productionPhotoVersion} (
              {order.productionApprovalStatus || "pending"})
            </s-text>
          ) : null}
        </s-stack>
      </s-table-cell>

      {/* 5. Production Due Date & SLA Countdown */}
      <s-table-cell>
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">
            {order.productionDueAt ? formatDay(order.productionDueAt) : "—"}
          </s-text>
          {dueStatus && (
            <s-badge tone={dueStatus.tone}>{dueStatus.label}</s-badge>
          )}
        </s-stack>
      </s-table-cell>

      {/* 6. Fulfillment / Freight Method */}
      <s-table-cell>
        <s-stack direction="block" gap="small-200">
          {isFob ? (
            <s-badge tone="attention">FOB / Pickup</s-badge>
          ) : (
            <s-badge tone="neutral">Courier Delivery</s-badge>
          )}

          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text color="subdued" style={{ fontSize: 12 }}>
              {order.financialStatus || "—"}
            </s-text>
            <s-text color="subdued" style={{ fontSize: 12 }}>•</s-text>
            <s-text color="subdued" style={{ fontSize: 12 }}>
              {order.fulfillmentStatus || "Unfulfilled"}
            </s-text>
          </s-stack>
        </s-stack>
      </s-table-cell>

      {/* 7. Total Value */}
      <s-table-cell>
        <s-stack direction="block" gap="none">
          <s-text type="strong">
            {formatMoney(order.amount, order.currency)}
          </s-text>
        </s-stack>
      </s-table-cell>

      {/* 8. Action */}
      <s-table-cell>
        <s-button
          variant="primary"
          href={`/app/production-orders/${order.numericId}`}
        >
          Manage Order
        </s-button>
      </s-table-cell>
    </s-table-row>
  );
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

export default function ProductionOrdersPage() {
  const loaderData = useLoaderData();
  const navigate = useNavigate();

  const [search, setSearch] = useState(loaderData?.search || "");

  const orders = loaderData?.orders ?? [];
  const tabCounts = loaderData?.tabCounts ?? {};
  const activeTab = loaderData?.activeTab || "all";
  const pageSize = loaderData?.pageSize || DEFAULT_PAGE_SIZE;
  const pageInfo = loaderData?.pageInfo ?? {};

  function navigateWithParams(updates = {}) {
    const params = new URLSearchParams();

    const newTab = updates.tab !== undefined ? updates.tab : activeTab;
    if (newTab && newTab !== "all") {
      params.set("tab", newTab);
    }

    const newSearch =
      updates.search !== undefined ? updates.search : search.trim();
    if (newSearch) {
      params.set("search", newSearch);
    }

    const newPageSize =
      updates.pageSize !== undefined ? updates.pageSize : pageSize;
    if (newPageSize !== DEFAULT_PAGE_SIZE) {
      params.set("pageSize", String(newPageSize));
    }

    if (updates.after) {
      params.set("after", updates.after);
    } else if (updates.before) {
      params.set("before", updates.before);
    }

    const queryStr = params.toString();
    navigate(`/app/production-orders${queryStr ? `?${queryStr}` : ""}`);
  }

  function handleTabChange(tabKey) {
    navigateWithParams({ tab: tabKey, after: null, before: null });
  }

  function submitSearch() {
    navigateWithParams({ search: search.trim(), after: null, before: null });
  }

  function clearSearch() {
    setSearch("");
    navigateWithParams({ search: "", after: null, before: null });
  }

  function handlePageSizeChange(newSize) {
    navigateWithParams({ pageSize: Number(newSize), after: null, before: null });
  }

  function goNext() {
    if (pageInfo.endCursor) {
      navigateWithParams({ after: pageInfo.endCursor });
    }
  }

  function goPrevious() {
    if (pageInfo.startCursor) {
      navigateWithParams({ before: pageInfo.startCursor });
    }
  }

  return (
    <s-page heading="Production Orders" inlineSize="large">
      {loaderData?.loaderError && (
        <s-banner tone="critical" heading="Unable to load orders">
          <s-paragraph>{loaderData.loaderError}</s-paragraph>
        </s-banner>
      )}

      {/* KPI Overview Metrics Cards */}
      <s-section padding="base">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 768px) 1fr 1fr, 1fr 1fr 1fr 1fr 1fr"
          gap="small-300"
        >
          {/* 1. All Orders */}
          <s-clickable
            onClick={() => handleTabChange("all")}
            paddingBlock="small-300"
            paddingInline="small-200"
            borderRadius="base"
            style={{
              backgroundColor: activeTab === "all" ? "#f1f2f4" : "#f9fafb",
              border: activeTab === "all" ? "2px solid #005bd3" : "1px solid #dfe3e8",
              cursor: "pointer",
            }}
          >
            <s-grid gap="small-200">
              <s-text color="subdued" style={{ fontSize: 13 }}>
                All Production
              </s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading style={{ fontSize: 24, margin: 0 }}>
                  {tabCounts.all ?? 0}
                </s-heading>
              </s-stack>
            </s-grid>
          </s-clickable>

          {/* 2. Artwork & Proofing */}
          <s-clickable
            onClick={() => handleTabChange("artwork")}
            paddingBlock="small-300"
            paddingInline="small-200"
            borderRadius="base"
            style={{
              backgroundColor: activeTab === "artwork" ? "#f1f2f4" : "#f9fafb",
              border:
                activeTab === "artwork" ? "2px solid #005bd3" : "1px solid #dfe3e8",
              cursor: "pointer",
            }}
          >
            <s-grid gap="small-200">
              <s-text color="subdued" style={{ fontSize: 13 }}>
                Artwork & Proof
              </s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading style={{ fontSize: 24, margin: 0 }}>
                  {tabCounts.artwork ?? 0}
                </s-heading>
                {tabCounts.artwork > 0 && (
                  <s-badge tone="warning">Pending</s-badge>
                )}
              </s-stack>
            </s-grid>
          </s-clickable>

          {/* 3. In Production */}
          <s-clickable
            onClick={() => handleTabChange("production")}
            paddingBlock="small-300"
            paddingInline="small-200"
            borderRadius="base"
            style={{
              backgroundColor:
                activeTab === "production" ? "#f1f2f4" : "#f9fafb",
              border:
                activeTab === "production"
                  ? "2px solid #005bd3"
                  : "1px solid #dfe3e8",
              cursor: "pointer",
            }}
          >
            <s-grid gap="small-200">
              <s-text color="subdued" style={{ fontSize: 13 }}>
                In Production
              </s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading style={{ fontSize: 24, margin: 0 }}>
                  {tabCounts.production ?? 0}
                </s-heading>
                {tabCounts.production > 0 && (
                  <s-badge tone="info">Active Floor</s-badge>
                )}
              </s-stack>
            </s-grid>
          </s-clickable>

          {/* 4. Ready / Dispatch */}
          <s-clickable
            onClick={() => handleTabChange("dispatch")}
            paddingBlock="small-300"
            paddingInline="small-200"
            borderRadius="base"
            style={{
              backgroundColor:
                activeTab === "dispatch" ? "#f1f2f4" : "#f9fafb",
              border:
                activeTab === "dispatch"
                  ? "2px solid #005bd3"
                  : "1px solid #dfe3e8",
              cursor: "pointer",
            }}
          >
            <s-grid gap="small-200">
              <s-text color="subdued" style={{ fontSize: 13 }}>
                Ready / Shipped
              </s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading style={{ fontSize: 24, margin: 0 }}>
                  {tabCounts.dispatch ?? 0}
                </s-heading>
                {tabCounts.dispatch > 0 && (
                  <s-badge tone="success">Staged</s-badge>
                )}
              </s-stack>
            </s-grid>
          </s-clickable>

          {/* 5. On Hold */}
          <s-clickable
            onClick={() => handleTabChange("hold")}
            paddingBlock="small-300"
            paddingInline="small-200"
            borderRadius="base"
            style={{
              backgroundColor:
                activeTab === "hold"
                  ? "#ffebee"
                  : tabCounts.onHold > 0
                    ? "#fff8f8"
                    : "#f9fafb",
              border:
                activeTab === "hold"
                  ? "2px solid #d72c0d"
                  : tabCounts.onHold > 0
                    ? "1px solid #e0b4b4"
                    : "1px solid #dfe3e8",
              cursor: "pointer",
            }}
          >
            <s-grid gap="small-200">
              <s-text color={tabCounts.onHold > 0 ? "critical" : "subdued"} style={{ fontSize: 13 }}>
                On Hold
              </s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading style={{ fontSize: 24, margin: 0, color: tabCounts.onHold > 0 ? "#d72c0d" : undefined }}>
                  {tabCounts.onHold ?? 0}
                </s-heading>
                {tabCounts.onHold > 0 && (
                  <s-badge tone="critical">Action Needed</s-badge>
                )}
              </s-stack>
            </s-grid>
          </s-clickable>
        </s-grid>
      </s-section>

      {/* Main Content Section */}
      <s-section>
        <s-stack direction="block" gap="base">
          {/* Tab Navigation and Search Controls */}
          <s-stack direction="block" gap="small-300">
            <s-stack
              direction="inline"
              justifyContent="space-between"
              alignItems="center"
              gap="base"
            >
              {/* Tab Pills */}
              <s-stack direction="inline" gap="small-200">
                {Object.values(TAB_CONFIG).map((tab) => {
                  const count =
                    tab.id === "all"
                      ? tabCounts.all
                      : tab.id === "artwork"
                        ? tabCounts.artwork
                        : tab.id === "production"
                          ? tabCounts.production
                          : tab.id === "dispatch"
                            ? tabCounts.dispatch
                            : tab.id === "hold"
                              ? tabCounts.onHold
                              : tabCounts.delivered;

                  const isSelected = activeTab === tab.id;

                  return (
                    <s-button
                      key={tab.id}
                      variant={isSelected ? "primary" : "tertiary"}
                      onClick={() => handleTabChange(tab.id)}
                    >
                      {tab.label} {count !== undefined ? `(${count})` : ""}
                    </s-button>
                  );
                })}
              </s-stack>

              {/* Per-Page Selector */}
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text color="subdued" style={{ fontSize: 13 }}>Show:</s-text>
                <s-select
                  value={String(pageSize)}
                  onChange={(event) =>
                    handlePageSizeChange(
                      event?.currentTarget?.value ??
                      event?.target?.value ??
                      DEFAULT_PAGE_SIZE,
                    )
                  }
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <s-option key={size} value={String(size)}>
                      {size} orders
                    </s-option>
                  ))}
                </s-select>
              </s-stack>
            </s-stack>

            {/* Search Bar */}
            <s-stack direction="inline" gap="base" alignItems="end">
              <div style={{ flex: 1 }}>
                <s-text-field
                  label="Search production orders"
                  placeholder="Order number (#1042), customer name, company, email or item title..."
                  value={search}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      submitSearch();
                    }
                  }}
                />
              </div>

              <s-button variant="primary" onClick={submitSearch}>
                Search
              </s-button>

              {loaderData.search && (
                <s-button onClick={clearSearch}>Clear Filter</s-button>
              )}
            </s-stack>
          </s-stack>

          {/* Active Filter Hint */}
          {loaderData.search && (
            <s-banner tone="info">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-text>
                  Filtering results for: <strong>&ldquo;{loaderData.search}&rdquo;</strong>
                </s-text>
                <s-button variant="plain" onClick={clearSearch}>
                  Reset search
                </s-button>
              </s-stack>
            </s-banner>
          )}

          {/* Table or Empty State */}
          {orders.length === 0 ? (
            <s-box padding="large" border="base" borderRadius="base">
              <s-stack direction="block" gap="small" alignItems="center">
                <s-heading>No production orders found</s-heading>
                <s-paragraph color="subdued">
                  {loaderData.search
                    ? `No orders matched your search "${loaderData.search}". Try clearing your search query or switching tabs.`
                    : activeTab !== "all"
                      ? `No orders are currently in the "${TAB_CONFIG[activeTab]?.label}" stage.`
                      : "No production orders found in the shop."}
                </s-paragraph>
                {loaderData.search || activeTab !== "all" ? (
                  <s-button
                    onClick={() => {
                      setSearch("");
                      handleTabChange("all");
                    }}
                  >
                    View All Orders
                  </s-button>
                ) : null}
              </s-stack>
            </s-box>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Order & Date</s-table-header>
                <s-table-header>Customer / Company</s-table-header>
                <s-table-header>Items & Volume</s-table-header>
                <s-table-header>Production Stage</s-table-header>
                <s-table-header>Production Due</s-table-header>
                <s-table-header>Fulfillment</s-table-header>
                <s-table-header format="currency">Total</s-table-header>
                <s-table-header>Action</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {orders.map((order) => (
                  <OrderRow key={order.id} order={order} />
                ))}
              </s-table-body>
            </s-table>
          )}

          <s-divider />

          {/* Footer & Pagination */}
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
          >
            <s-button
              disabled={!pageInfo.hasPreviousPage}
              onClick={goPrevious}
            >
              Previous
            </s-button>

            <s-text tone="neutral">
              Showing {orders.length} orders (Page size: {pageSize})
            </s-text>

            <s-button disabled={!pageInfo.hasNextPage} onClick={goNext}>
              Next
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}