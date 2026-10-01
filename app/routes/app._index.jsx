import { Link, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { getAllDistributorApplications } from "../lib/distributor-metaobject.server";
import { DRAFT_ORIGIN_FIELDS, QUOTE_STATUSES, quoteStatus, submittedForReview } from "../lib/account-quotes.server";
import { formatMoney } from "../lib/portal.server";
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
        status
        invoiceSentAt
        tags
        order { id name }
        totalPriceSet { presentmentMoney { amount currencyCode } }
        customer { displayName }
        hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
        ${DRAFT_ORIGIN_FIELDS}
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
    // A terms order waiting on its credit review is a draft too, but it is an
    // order, not a quote (HYV-99), so it is not counted here.
    quotes = (body?.data?.draftOrders?.nodes || []).filter((node) => !submittedForReview(node));
  } catch (error) {
    console.warn("[dashboard] quotes query failed:", error?.message || error);
  }

  const isStatus = (application, value) =>
    String(application.status || "Pending Review").toLowerCase() === value;

  // The same statuses the buyer sees in the portal: Accepted once the quote
  // became an order, so Q-35 no longer read Awaiting after it became #1064.
  const count = (status) => quotes.filter((q) => quoteStatus(q) === status).length;

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
      awaiting: count(QUOTE_STATUSES.SENT),
      approved: count(QUOTE_STATUSES.ACCEPTED),
      rejected: count(QUOTE_STATUSES.DECLINED),
      recent: quotes.slice(0, 5).map((q) => ({
        id: q.id,
        // The quote detail route is keyed on the bare draft order number, the
        // same as the quotes list uses. Passing the GID put encoded slashes in
        // the path segment, which is not the address that route answers on.
        numericId: String(q.id).replace("gid://shopify/DraftOrder/", ""),
        name: quoteReference(q.name),
        customer: q.customer?.displayName || "—",
        total: q.totalPriceSet?.presentmentMoney
          ? formatMoney(q.totalPriceSet.presentmentMoney.amount, q.totalPriceSet.presentmentMoney.currencyCode)
          : "—",
        status: quoteStatus(q),
      })),
    },
  };
};

/** The dashboard's short form of the portal's quote statuses. */
const QUOTE_LABELS = { created: "Created", sent: "Sent", accepted: "Accepted", declined: "Declined" };
const QUOTE_TONES = { created: "info", sent: "info", accepted: "success", declined: "critical" };

function quoteReference(name) {
  const raw = String(name || "");
  if (raw.startsWith("#D")) return `Q-${raw.slice(2)}`;
  if (raw.startsWith("#")) return `Q-${raw.slice(1)}`;
  return raw || "Quote";
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

  // Only applications wait on Hyve. A quote sitting with the buyer is not
  // staff work, and counting it here made the headline claim work that was not
  // theirs to do.
  const needsAttention = applications.pending;
  // Still worth saying, but as information rather than as work owed.
  const withBuyer = quotes.awaiting
    ? `${quotes.awaiting} quote${quotes.awaiting === 1 ? "" : "s"} with the buyer`
    : "";

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
                    {[
                      needsAttention === 0
                        ? "Every application has been decided"
                        : `${needsAttention} application${needsAttention === 1 ? "" : "s"} to decide`,
                      withBuyer,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
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
                        <Pill tone={QUOTE_TONES[quote.status] || "info"}>
                          {QUOTE_LABELS[quote.status] || "Sent"}
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
          
          <s-paragraph> {error?.message || "Please reload the page."}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}
