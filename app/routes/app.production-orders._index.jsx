// app/routes/app.production-orders.jsx

import { useState } from "react";
import { useLoaderData, useNavigate } from "react-router";

import { authenticate } from "../shopify.server";

const PAGE_SIZE = 10;

const STATUS_OPTIONS = [
  { label: "Order Placed", value: "order-placed" },
  { label: "Artwork Received", value: "artwork-received" },
  { label: "Proof Sent", value: "proof-sent" },
  { label: "Proof Approved", value: "proof-approved" },
  { label: "In Production", value: "in-production" },
  { label: "Production Complete", value: "production-complete" },
  { label: "Shipped", value: "shipped" },
  { label: "Delivered", value: "delivered" },
  { label: "On Hold", value: "on-hold" },
];

/**
 * Only orders in the production chain. An order with no customisation never
 * gets a status tag — the order-created webhook skips it — so it has no
 * production to track. Matched tag by tag, because Shopify's order search can't
 * match the start of a tag.
 */
const PRODUCTION_ORDERS_QUERY = STATUS_OPTIONS.map(
  (status) => `tag:"hyve-status:${status.value}"`,
).join(" OR ");

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
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Singapore",
  }).format(date);
}

function extractOrderNumericId(gid) {
  if (!gid) {
    return "";
  }

  return gid.split("/").pop();
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

    const goingBackward = Boolean(before);

    const response = await admin.graphql(
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
                  shopMoney {
                    amount
                    currencyCode
                  }
                }

                customer {
                  displayName
                  email
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
              }
            }
          }
        `,
      {
        variables: {
          first: goingBackward ? null : PAGE_SIZE,
          last: goingBackward ? PAGE_SIZE : null,
          after: goingBackward ? null : after,
          before: goingBackward ? before : null,
          query: search
            ? `(${search}) AND (${PRODUCTION_ORDERS_QUERY})`
            : PRODUCTION_ORDERS_QUERY,
        },
      },
    );

    const data = await response.json();

    if (data.errors?.length) {
      throw new Error(data.errors.map((error) => error.message).join(", "));
    }

    const connection = data.data?.orders;

    const orders = (connection?.nodes ?? []).map((order) => {
      const statusFromTag =
        order.tags
          ?.find((tag) => tag.startsWith("hyve-status:"))
          ?.replace("hyve-status:", "") || "";

      return {
        id: order.id,
        numericId: extractOrderNumericId(order.id),
        name: order.name,
        createdAt: order.createdAt,
        customerName: order.customer?.displayName || "Guest customer",
        email: order.customer?.email || order.email || "",
        financialStatus: order.displayFinancialStatus || "",
        fulfillmentStatus: order.displayFulfillmentStatus || "",
        amount: order.totalPriceSet?.shopMoney?.amount || "0",
        currency: order.totalPriceSet?.shopMoney?.currencyCode || "",
        productionStatus: order.productionStatus?.value || statusFromTag || "",
        statusChangedAt: order.statusChangedAt?.value || "",
        productionDueAt: order.productionDueAt?.value || "",
        artworkRequired: order.artworkRequired?.value === "true",
        rush: order.rush?.value === "true",
      };
    });

    return {
      orders,
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
  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="small">
          <s-link href={`/app/production-orders/${order.numericId}`}>
            {order.name}
          </s-link>
          <s-text color="subdued">{formatDate(order.createdAt)}</s-text>
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <s-stack direction="block" gap="small">
          <s-text>{order.customerName}</s-text>
          <s-text color="subdued">{order.email || "No email"}</s-text>
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <s-stack direction="block" gap="small">
          <s-badge tone={statusTone(order.productionStatus)}>
            {getStatusLabel(order.productionStatus)}
          </s-badge>
          {order.rush && <s-badge tone="critical">Rush</s-badge>}
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <s-stack direction="block" gap="small">
          <s-text>
            {order.currency} {order.amount}
          </s-text>
          <s-text color="subdued">{order.financialStatus || "—"}</s-text>
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <s-stack direction="block" gap="small">
          <s-text>
            {order.productionDueAt ? formatDate(order.productionDueAt) : "—"}
          </s-text>
          <s-text color="subdued">Production due</s-text>
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <s-button href={`/app/production-orders/${order.numericId}`}>
          View
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
  const pageInfo = loaderData?.pageInfo ?? {};

  function submitSearch() {
    const params = new URLSearchParams();

    if (search.trim()) {
      params.set("search", search.trim());
    }

    navigate(
      `/app/production-orders${
        params.toString() ? `?${params.toString()}` : ""
      }`,
    );
  }

  function clearSearch() {
    setSearch("");
    navigate("/app/production-orders");
  }

  function goNext() {
    const params = new URLSearchParams();

    if (loaderData.search) {
      params.set("search", loaderData.search);
    }

    if (pageInfo.endCursor) {
      params.set("after", pageInfo.endCursor);
    }

    navigate(`/app/production-orders?${params.toString()}`);
  }

  function goPrevious() {
    const params = new URLSearchParams();

    if (loaderData.search) {
      params.set("search", loaderData.search);
    }

    if (pageInfo.startCursor) {
      params.set("before", pageInfo.startCursor);
    }

    navigate(`/app/production-orders?${params.toString()}`);
  }

  return (
    <s-page heading="Production Orders" inlineSize="large">
      {loaderData?.loaderError && (
        <s-banner tone="critical" heading="Unable to load orders">
          <s-paragraph>{loaderData.loaderError}</s-paragraph>
        </s-banner>
      )}

      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field
              label="Search orders"
              placeholder="Order number, customer name or email"
              value={search}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />

            <s-button variant="primary" onClick={submitSearch}>
              Search
            </s-button>

            {loaderData.search && (
              <s-button onClick={clearSearch}>Clear</s-button>
            )}
          </s-stack>

          {orders.length === 0 ? (
            <s-box padding="large" border="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-heading>No orders found</s-heading>

                <s-paragraph>
                  No Shopify orders matched the current search.
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Order</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Production status</s-table-header>
                <s-table-header>Total</s-table-header>
                <s-table-header>Production due</s-table-header>
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

          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
          >
            <s-button disabled={!pageInfo.hasPreviousPage} onClick={goPrevious}>
              Previous
            </s-button>

            <s-text tone="neutral">Showing up to {PAGE_SIZE} orders</s-text>

            <s-button disabled={!pageInfo.hasNextPage} onClick={goNext}>
              Next
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}