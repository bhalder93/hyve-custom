import { Link, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { getAllDistributorApplications } from "../lib/distributor-metaobject.server";
import { quoteDecision } from "../lib/account-quotes.server";
import {
  AdminTheme,
  Metric,
  Pill,
  IconInbox,
  IconCheck,
  IconQuote,
  IconClock,
  Row,
} from "../lib/admin-theme";

/**
 * Staff dashboard — the landing page inside the Shopify admin.
 *
 * Two queues run this business day to day: distributor applications waiting on
 * a decision, and quotes waiting on the buyer. Everything here is counted from
 * live records, so a zero is a real zero rather than a placeholder.
 */

const QUOTES_QUERY = `#graphql
  query DashboardQuotes {
    draftOrders(first: 100, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        totalPriceSet { shopMoney { amount currencyCode } }
        customer { displayName }
        hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
      }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const applications = await getAllDistributorApplications(admin);

  let quotes = [];
  try {
    const response = await admin.graphql(QUOTES_QUERY);
    const body = await response.json();
    quotes = body?.data?.draftOrders?.nodes || [];
  } catch (error) {
    console.warn("[dashboard] quotes query failed:", error?.message || error);
  }

  const isStatus = (application, value) =>
    String(application.status || "Pending Review").toLowerCase() === value;

  // An unset metafield means nobody has decided yet.
  const decision = (quote) => quoteDecision(quote);

  return {
    applications: {
      total: applications.length,
      pending: applications.filter((a) => isStatus(a, "pending review")).length,
      approved: applications.filter((a) => isStatus(a, "approved")).length,
      recent: applications.slice(0, 5).map((a) => ({
        id: a.id,
        company: a.company_name || "Unnamed company",
        contact: a.customer_email || a.contact_person || "",
        status: a.status || "Pending Review",
        submittedAt: a.submitted_at || a.updatedAt || "",
      })),
    },
    quotes: {
      total: quotes.length,
      awaiting: quotes.filter((q) => decision(q) == null).length,
      approved: quotes.filter((q) => decision(q) === true).length,
      rejected: quotes.filter((q) => decision(q) === false).length,
      recent: quotes.slice(0, 5).map((q) => ({
        id: q.id,
        // The quote detail route is keyed on the bare draft order number, the
        // same as the quotes list uses. Passing the GID put encoded slashes in
        // the path segment, which is not the address that route answers on.
        numericId: String(q.id).replace("gid://shopify/DraftOrder/", ""),
        name: quoteReference(q.name),
        customer: q.customer?.displayName || "—",
        total: money(q.totalPriceSet?.shopMoney),
        decision: decision(q) === true ? "approved" : decision(q) === false ? "rejected" : "awaiting",
      })),
    },
  };
};

function quoteReference(name) {
  const raw = String(name || "");
  if (raw.startsWith("#D")) return `Q-${raw.slice(2)}`;
  if (raw.startsWith("#")) return `Q-${raw.slice(1)}`;
  return raw || "Quote";
}

function money(shopMoney) {
  if (!shopMoney) return "—";
  const amount = Number(shopMoney.amount) || 0;
  return `${shopMoney.currencyCode} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

function statusTone(status) {
  const value = String(status).toLowerCase();
  if (value === "approved") return "success";
  if (value === "rejected" || value === "declined") return "critical";
  return "warning";
}

export default function DashboardPage() {
  const { applications, quotes } = useLoaderData();

  const needsAttention = applications.pending + quotes.awaiting;

  return (
    <s-page heading="Hyve distributor portal" inlineSize="large">
      <s-button slot="primary-action" href="/app/distributors" variant="primary">
        Review applications
      </s-button>
      <s-button slot="secondary-actions" href="/app/quotes">
        Manage quotes
      </s-button>

      <s-section padding="base">
        <div className="hyv">
          <AdminTheme />

          <div className="hyv-stack">
            <div className="hyv-card">
              <div className="hyv-hero">
                <div>
                  <h2 className="hyv-hero__title">
                    {needsAttention === 0 ? "You're all caught up" : `${needsAttention} waiting on you`}
                  </h2>
                  <p className="hyv-hero__sub">
                    {needsAttention === 0
                      ? "Every application has been decided and no quote is outstanding."
                      : `${applications.pending} application${applications.pending === 1 ? "" : "s"} to decide · ${quotes.awaiting} quote${quotes.awaiting === 1 ? "" : "s"} with the buyer`}
                  </p>
                </div>
                <Pill tone={needsAttention === 0 ? "success" : "warning"}>
                  {needsAttention === 0 ? "Nothing to action" : "Action needed"}
                </Pill>
              </div>
            </div>

            <div className="hyv-metrics">
              <Metric
                label="Applications pending"
                value={applications.pending}
                foot={`${applications.total} received in total`}
                icon={<IconInbox />}
                accent="#8a6116"
                soft="#fdf5e4"
                href="/app/distributors"
              />
              <Metric
                label="Approved distributors"
                value={applications.approved}
                foot="Trading with B2B pricing"
                icon={<IconCheck />}
                accent="#116b45"
                soft="#eef7f1"
                href="/app/distributors"
              />
              <Metric
                label="Quotes awaiting buyer"
                value={quotes.awaiting}
                foot={`${quotes.total} raised in total`}
                icon={<IconClock />}
                accent="#1f5199"
                soft="#eef3fd"
                href="/app/quotes"
              />
              <Metric
                label="Quotes accepted"
                value={quotes.approved}
                foot={`${quotes.rejected} declined`}
                icon={<IconQuote />}
                accent="#5a3ea8"
                soft="#f1edfb"
                href="/app/quotes"
              />
            </div>

            <div className="hyv-split">
              <div className="hyv-panel">
                <div className="hyv-panel__head">
                  <span className="hyv-panel__title">Latest quotes</span>
                  <Link className="hyv-panel__link" to="/app/quotes">
                    View all
                  </Link>
                </div>
                <div className="hyv-panel__body">
                  {quotes.recent.length === 0 ? (
                    <div className="hyv-empty">
                      <div className="hyv-empty__title">No quotes yet</div>
                      <p className="hyv-empty__text">
                        Quotes raised from the storefront or the portal land here.
                      </p>
                    </div>
                  ) : (
                    quotes.recent.map((quote) => (
                      <Row
                        key={quote.id}
                        href={`/app/quote/${encodeURIComponent(quote.numericId)}`}
                        columns="minmax(0,1fr) auto auto"
                        primary={quote.name}
                        sub={quote.customer}
                      >
                        <span className="hyv-row__value">{quote.total}</span>
                        <Pill
                          tone={
                            quote.decision === "approved"
                              ? "success"
                              : quote.decision === "rejected"
                                ? "critical"
                                : "info"
                          }
                        >
                          {quote.decision === "approved"
                            ? "Accepted"
                            : quote.decision === "rejected"
                              ? "Declined"
                              : "Awaiting"}
                        </Pill>
                      </Row>
                    ))
                  )}
                </div>
              </div>

              <div className="hyv-panel">
                <div className="hyv-panel__head">
                  <span className="hyv-panel__title">Latest applications</span>
                  <Link className="hyv-panel__link" to="/app/distributors">
                    View all
                  </Link>
                </div>
                <div className="hyv-panel__body">
                  {applications.recent.length === 0 ? (
                    <div className="hyv-empty">
                      <div className="hyv-empty__title">No applications yet</div>
                      <p className="hyv-empty__text">Submissions from the storefront land here.</p>
                    </div>
                  ) : (
                    applications.recent.map((application) => (
                      <Row
                        key={application.id}
                        href={`/app/distributor/${encodeURIComponent(application.id)}`}
                        primary={application.company}
                        sub={`${application.contact || "No contact"} · ${formatDate(application.submittedAt)}`}
                      >
                        <Pill tone={statusTone(application.status)}>{application.status}</Pill>
                      </Row>
                    ))
                  )}
                </div>
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
  console.error("[dashboard] render failed:", error);

  return (
    <s-page heading="Hyve distributor portal">
      <s-section>
        <s-banner tone="critical" heading="We couldn't load the dashboard">
          <s-paragraph>{error?.message || "Please reload the page."}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}
