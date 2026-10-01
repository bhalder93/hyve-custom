/* eslint-disable react/prop-types */
import { useState, useMemo, useCallback } from "react";
import { useLoaderData, useRouteError, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getAllDistributorApplications } from "../lib/distributor-metaobject.server";

/* ==========================================================================
   Constants & helpers
   ========================================================================== */

const PAGE_SIZE_OPTIONS = [10, 20, 50];

const STATUS = {
  ALL: "all",
  PENDING: "pending review",
  APPROVED: "approved",
  REJECTED: "rejected",
};

const TABS = [
  { id: STATUS.ALL, label: "All" },
  { id: STATUS.PENDING, label: "Pending" },
  { id: STATUS.APPROVED, label: "Approved" },
  { id: STATUS.REJECTED, label: "Declined" },
];

/** The record stores free text, so everything is compared lower-cased. */
function statusKey(application) {
  return String(application?.status || "Pending Review").trim().toLowerCase();
}

function statusLabel(application) {
  const key = statusKey(application);
  if (key === STATUS.APPROVED) return "Approved";
  if (key === STATUS.REJECTED) return "Declined";
  return "Pending review";
}

function statusTone(application) {
  const key = statusKey(application);
  if (key === STATUS.APPROVED) return "success";
  if (key === STATUS.REJECTED) return "critical";
  return "warning";
}

function wantsCredit(application) {
  return application?.request_credit === "true" || application?.request_credit === true;
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

/* ==========================================================================
   Loader
   ========================================================================== */

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const applications = await getAllDistributorApplications(admin);
  return { applications };
};

/* ==========================================================================
   Page
   ========================================================================== */

export default function DistributorApplicationsPage() {
  const { applications = [] } = useLoaderData();
  const navigate = useNavigate();

  const [tab, setTab] = useState(STATUS.ALL);
  const [query, setQuery] = useState("");
  const [creditOnly, setCreditOnly] = useState(false);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);

  const counts = useMemo(
    () => ({
      all: applications.length,
      [STATUS.PENDING]: applications.filter((a) => statusKey(a) === STATUS.PENDING).length,
      [STATUS.APPROVED]: applications.filter((a) => statusKey(a) === STATUS.APPROVED).length,
      [STATUS.REJECTED]: applications.filter((a) => statusKey(a) === STATUS.REJECTED).length,
    }),
    [applications],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return applications.filter((application) => {
      if (tab !== STATUS.ALL && statusKey(application) !== tab) return false;
      if (creditOnly && !wantsCredit(application)) return false;
      if (!needle) return true;

      const haystack = [
        application.company_name,
        application.contact_person,
        application.customer_email,
        application.registration_number,
        application.country_based,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [applications, tab, query, creditOnly]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const changeTab = useCallback((next) => {
    setTab(next);
    setPage(1);
  }, []);

  const hasFilters = tab !== STATUS.ALL || creditOnly || query.trim() !== "";

  return (
    <s-page heading="Distributor applications" inlineSize="large">
      <s-button slot="secondary-actions" href="/app" variant="tertiary">
        Dashboard
      </s-button>

      {counts[STATUS.PENDING] > 0 ? (
        <s-banner
          tone="warning"
          heading={`${counts[STATUS.PENDING]} application${counts[STATUS.PENDING] === 1 ? "" : "s"} awaiting a decision`}
        >
          <s-paragraph>
            Approving creates the Shopify B2B company, links the contact and assigns their pricing
            tier.
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section padding="base">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr auto 1fr auto 1fr auto 1fr"
          gap="small"
        >
          <s-clickable
            onClick={() => changeTab(STATUS.ALL)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Total received</s-heading>
              <s-text type="strong">{counts.all}</s-text>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            onClick={() => changeTab(STATUS.PENDING)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Pending review</s-heading>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text type="strong">{counts[STATUS.PENDING]}</s-text>
                {counts[STATUS.PENDING] > 0 ? <s-badge tone="warning">Action</s-badge> : null}
              </s-stack>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            onClick={() => changeTab(STATUS.APPROVED)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Approved</s-heading>
              <s-text type="strong">{counts[STATUS.APPROVED]}</s-text>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            onClick={() => changeTab(STATUS.REJECTED)}
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Declined</s-heading>
              <s-text type="strong">{counts[STATUS.REJECTED]}</s-text>
            </s-grid>
          </s-clickable>
        </s-grid>
      </s-section>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
            <s-search-field
              label="Search applications"
              labelAccessibilityVisibility="exclusive"
              placeholder="Company, contact, email or registration number"
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
                setPageSize(
                  Number(e?.currentTarget?.value ?? e?.target?.value ?? PAGE_SIZE_OPTIONS[0]),
                );
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

          <s-stack direction="inline" gap="small-200" alignItems="center">
            {TABS.map((item) => (
              <s-button
                key={item.id}
                variant={tab === item.id ? "primary" : "tertiary"}
                onClick={() => changeTab(item.id)}
              >
                {item.label}
              </s-button>
            ))}
            <s-divider direction="block" />
            <s-checkbox
              label="Credit requested only"
              name="creditOnly"
              checked={creditOnly}
              onChange={() => {
                setCreditOnly((value) => !value);
                setPage(1);
              }}
            />
          </s-stack>

          {visible.length === 0 ? (
            <s-box padding="large-100" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200" alignItems="center">
                <s-heading>
                  {applications.length === 0 ? "No applications yet" : "Nothing matches"}
                </s-heading>
                <s-paragraph color="subdued">
                  {applications.length === 0
                    ? "Applications submitted from the storefront will appear here."
                    : "Try another tab, or clear the search and filters."}
                </s-paragraph>
                {hasFilters && applications.length > 0 ? (
                  <s-button
                    variant="tertiary"
                    onClick={() => {
                      setTab(STATUS.ALL);
                      setQuery("");
                      setCreditOnly(false);
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </s-button>
                ) : null}
              </s-stack>
            </s-box>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Company</s-table-header>
                <s-table-header>Contact</s-table-header>
                <s-table-header>Country</s-table-header>
                <s-table-header>Terms</s-table-header>
                <s-table-header>Submitted</s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {visible.map((application) => {
                  const href = `/app/distributor/${encodeURIComponent(application.id)}`;
                  return (
                    <s-table-row key={application.id} onClick={() => navigate(href)}>
                      <s-table-cell>
                        <s-stack direction="block" gap="none">
                          <s-link href={href}>{application.company_name || "Unnamed company"}</s-link>
                          {application.registration_number ? (
                            <s-text color="subdued">UEN {application.registration_number}</s-text>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="none">
                          <s-text>{application.contact_person || "—"}</s-text>
                          <s-text color="subdued">{application.customer_email || ""}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>{application.country_based || "—"}</s-table-cell>
                      <s-table-cell>
                        {wantsCredit(application) ? (
                          <s-badge tone="info">Credit requested</s-badge>
                        ) : (
                          <s-text color="subdued">Prepayment</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {formatDate(application.submitted_at || application.updatedAt)}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={statusTone(application)}>{statusLabel(application)}</s-badge>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
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
                Page {currentPage} of {totalPages} · {filtered.length} application
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
  const error = useRouteError();
  console.error("[distributors] render failed:", error);

  return (
    <s-page heading="Distributor applications">
      <s-section>
        <s-banner tone="critical" heading="We couldn't load applications">
          <s-paragraph>{error?.message || "Please reload the page."}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
