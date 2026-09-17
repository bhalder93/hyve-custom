/* eslint-disable react/prop-types */
import { useState, useMemo, useCallback, useRef } from "react";
import { useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { getAllDistributorApplications } from "../lib/distributor-metaobject.server";

const PAGE_SIZE = 10;

const TABS = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Declined" }
];

const STATUS_CHOICES = [
  { value: "Pending Review", label: "Pending Review" },
  { value: "Approved", label: "Approved" },
  { value: "Rejected", label: "Declined" },
];

const CREDIT_CHOICES = [
  { value: "yes", label: "Credit Requested" },
  { value: "no", label: "Prepayment" },
];

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const applications = await getAllDistributorApplications(admin);
  return { applications };
};

export default function DistributorsAdminPage() {
  const { applications } = useLoaderData();

  const [queryValue, setQueryValue] = useState("");
  const [selectedTab, setSelectedTab] = useState(0);
  const [filterModeOpen, setFilterModeOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState([]);
  const [creditFilter, setCreditFilter] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);

  const searchFieldRef = useRef(null);
  const statusPopoverRef = useRef(null);
  const creditPopoverRef = useRef(null);

  const handleTabChange = useCallback((tabIndex) => {
    setSelectedTab(tabIndex);
    setCurrentPage(1);
  }, []);

  const handleCancelFilterMode = useCallback(() => {
    setFilterModeOpen(false);
  }, []);

  const openFilterMode = useCallback(() => {
    setCreditFilter([]);
    if (selectedTab === 1) setStatusFilter(["Pending Review"]);
    else if (selectedTab === 2) setStatusFilter(["Approved"]);
    else if (selectedTab === 3) setStatusFilter(["Rejected"]);
    else if (selectedTab === 4) setCreditFilter(["yes"]);
    else setStatusFilter([]);

    setFilterModeOpen(true);
    setCurrentPage(1);
    requestAnimationFrame(() => {
      const el = searchFieldRef.current;
      if (el?.focus) el.focus();
      else el?.querySelector?.("input")?.focus();
    });
  }, [selectedTab]);

  const handleClearAll = useCallback(() => {
    setStatusFilter([]);
    setCreditFilter([]);
    setQueryValue("");
    setSelectedTab(0);
    setFilterModeOpen(false);
    setCurrentPage(1);
  }, []);

  const statusPinnedLabel = useMemo(() => {
    if (statusFilter.length === 0) return null;
    return `Status: ${statusFilter.join(", ")}`;
  }, [statusFilter]);

  const creditPinnedLabel = useMemo(() => {
    if (creditFilter.length === 0) return null;
    const parts = creditFilter.map((v) => (v === "yes" ? "Credit Requested" : "Prepayment"));
    return `Terms: ${parts.join(", ")}`;
  }, [creditFilter]);

  const showClearAllInFilterRow =
    filterModeOpen &&
    (queryValue.trim() !== "" || statusFilter.length > 0 || creditFilter.length > 0);

  const filteredApplications = useMemo(() => {
    let filtered = [...(applications || [])];

    if (!filterModeOpen) {
      if (selectedTab === 1) {
        filtered = filtered.filter(
          (a) => (a.status || "Pending Review").toLowerCase() === "pending review"
        );
      } else if (selectedTab === 2) {
        filtered = filtered.filter((a) => (a.status || "").toLowerCase() === "approved");
      } else if (selectedTab === 3) {
        filtered = filtered.filter((a) => (a.status || "").toLowerCase() === "rejected");
      } else if (selectedTab === 4) {
        filtered = filtered.filter(
          (a) => a.request_credit === "true" || a.request_credit === true
        );
      }
    } else {
      if (statusFilter.length > 0) {
        filtered = filtered.filter((app) =>
          statusFilter.includes(app.status || "Pending Review")
        );
      }
      if (creditFilter.length > 0) {
        filtered = filtered.filter((app) => {
          const hasCredit = app.request_credit === "true" || app.request_credit === true;
          const status = hasCredit ? "yes" : "no";
          return creditFilter.includes(status);
        });
      }
    }

    if (queryValue.trim()) {
      const q = queryValue.toLowerCase().trim();
      filtered = filtered.filter(
        (app) =>
          (app.company_name || "").toLowerCase().includes(q) ||
          (app.contact_person || "").toLowerCase().includes(q) ||
          (app.customer_email || "").toLowerCase().includes(q) ||
          (app.registration_number || "").toLowerCase().includes(q) ||
          (app.country_based || "").toLowerCase().includes(q) ||
          (app.handle || "").toLowerCase().includes(q)
      );
    }

    return filtered;
  }, [applications, filterModeOpen, selectedTab, statusFilter, creditFilter, queryValue]);

  const totalPages = Math.max(1, Math.ceil(filteredApplications.length / PAGE_SIZE));

  const paginatedApplications = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredApplications.slice(start, start + PAGE_SIZE);
  }, [currentPage, filteredApplications]);

  const getDetailHref = (app) => {
    const rawId = (app.id || app.handle || "").replace("gid://shopify/Metaobject/", "");
    return `/app/distributor/${encodeURIComponent(rawId)}`;
  };

  return (
    <s-page heading="Distributor Applications" inlineSize="large">
      {/* Main Table Controls & Display */}
      <s-stack direction="block" gap="base">
        <s-section padding="none">
          <s-box padding="small">
            {filterModeOpen ? (
              <s-stack direction="block" gap="small">
                <s-grid gridTemplateColumns="1fr auto" gap="small-300">
                  <s-search-field
                    ref={searchFieldRef}
                    label="Search"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Search by company name, contact, email, UEN..."
                    value={queryValue}
                    onInput={(e) => {
                      setQueryValue(e?.currentTarget?.value ?? "");
                      setCurrentPage(1);
                    }}
                  />
                  <s-button variant="secondary" onClick={handleCancelFilterMode}>
                    Cancel
                  </s-button>
                </s-grid>

                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-button
                    variant="secondary"
                    accessibilityLabel={statusPinnedLabel ?? "Status filter"}
                    commandFor="distributors-status-popover"
                    command="--toggle"
                  >
                    {statusPinnedLabel ?? "Status"}
                    <s-icon slot="icon" type="caret-down" />
                  </s-button>
                  <s-popover
                    ref={statusPopoverRef}
                    id="distributors-status-popover"
                    minInlineSize="240px"
                  >
                    <s-box padding="small">
                      <s-stack direction="block" gap="small-500">
                        <s-text variant="headingSm">Status</s-text>
                        <s-choice-list
                          label="Status"
                          labelAccessibilityVisibility="exclusive"
                          multiple
                          values={statusFilter}
                          onInput={(e) => {
                            const target = e?.currentTarget;
                            if (target?.values) {
                              const vals = Array.isArray(target.values) ? target.values : [];
                              setStatusFilter(vals.map((v) => String(v)));
                              setCurrentPage(1);
                            }
                          }}
                        >
                          {STATUS_CHOICES.map((opt) => (
                            <s-choice
                              key={opt.value}
                              value={opt.value}
                              selected={statusFilter.includes(opt.value)}
                            >
                              {opt.label}
                            </s-choice>
                          ))}
                        </s-choice-list>
                        <s-link
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setStatusFilter([]);
                            statusPopoverRef.current?.hideOverlay?.();
                            setCurrentPage(1);
                          }}
                        >
                          Clear
                        </s-link>
                      </s-stack>
                    </s-box>
                  </s-popover>

                  <s-button
                    variant="secondary"
                    accessibilityLabel={creditPinnedLabel ?? "Credit Terms filter"}
                    commandFor="distributors-credit-popover"
                    command="--toggle"
                  >
                    {creditPinnedLabel ?? "Credit Terms"}
                    <s-icon slot="icon" type="caret-down" />
                  </s-button>
                  <s-popover
                    ref={creditPopoverRef}
                    id="distributors-credit-popover"
                    minInlineSize="200px"
                  >
                    <s-box padding="small">
                      <s-stack direction="block" gap="small-500">
                        <s-text variant="headingSm">Credit Terms</s-text>
                        <s-choice-list
                          label="Credit Terms"
                          labelAccessibilityVisibility="exclusive"
                          multiple
                          values={creditFilter}
                          onInput={(e) => {
                            const target = e?.currentTarget;
                            if (target?.values) {
                              const vals = Array.isArray(target.values) ? target.values : [];
                              setCreditFilter(vals.map((v) => String(v)));
                              setCurrentPage(1);
                            }
                          }}
                        >
                          {CREDIT_CHOICES.map((opt) => (
                            <s-choice
                              key={opt.value}
                              value={opt.value}
                              selected={creditFilter.includes(opt.value)}
                            >
                              {opt.label}
                            </s-choice>
                          ))}
                        </s-choice-list>
                        <s-link
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setCreditFilter([]);
                            creditPopoverRef.current?.hideOverlay?.();
                            setCurrentPage(1);
                          }}
                        >
                          Clear
                        </s-link>
                      </s-stack>
                    </s-box>
                  </s-popover>

                  {showClearAllInFilterRow ? (
                    <s-button variant="tertiary" onClick={handleClearAll}>
                      Clear all
                    </s-button>
                  ) : null}
                </s-stack>
              </s-stack>
            ) : (
              <s-stack direction="inline" gap="base" justifyContent="space-between">
                <s-stack direction="inline" gap="small-300">
                  {TABS.map((tab, idx) => (
                    <s-button
                      key={tab.id}
                      variant={selectedTab === idx ? "secondary" : "tertiary"}
                      onClick={() => handleTabChange(idx)}
                    >
                      {tab.label}
                    </s-button>
                  ))}
                </s-stack>
                <s-stack direction="inline" gap="small-300">
                  <s-button
                    icon="search"
                    accessibilityLabel="Search and filter"
                    onClick={openFilterMode}
                  >
                    <s-icon slot="icon" type="search" />
                  </s-button>
                </s-stack>
              </s-stack>
            )}
          </s-box>
        </s-section>

        {/* Data Table Section */}
        <s-section padding="none">
          {filteredApplications.length === 0 ? (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-text tone="subdued">No distributor applications found</s-text>
            </s-box>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Company</s-table-header>
                <s-table-header>Contact</s-table-header>
                <s-table-header>Country / UEN</s-table-header>
                <s-table-header>Credit Terms</s-table-header>
                <s-table-header>Registration Doc</s-table-header>
                <s-table-header>Submitted</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Action</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {paginatedApplications.map((app) => {
                  const status = app.status || "Pending Review";
                  const isApproved = status.toLowerCase() === "approved";
                  const isRejected = status.toLowerCase() === "rejected";
                  const detailHref = getDetailHref(app);

                  return (
                    <s-table-row key={app.id || app.handle}>
                      <s-table-cell>
                        <s-link href={detailHref}>
                          <s-text type="strong">
                            {app.company_name || "Untitled Application"}
                          </s-text>
                        </s-link>
                      </s-table-cell>

                      <s-table-cell>
                        <s-paragraph>{app.contact_person || "—"}</s-paragraph>
                        <s-paragraph color="subdued" type="small">
                          {app.customer_email || ""}
                        </s-paragraph>
                      </s-table-cell>

                      <s-table-cell>
                        <s-paragraph>{app.country_based || "Singapore"}</s-paragraph>
                        <s-paragraph color="subdued" type="small">
                          {app.registration_number ? `UEN: ${app.registration_number}` : "—"}
                        </s-paragraph>
                      </s-table-cell>

                      <s-table-cell>
                        {app.request_credit === "true" || app.request_credit === true ? (
                          <s-badge tone="info">Net 30/60</s-badge>
                        ) : (
                          <s-text color="subdued">Prepayment</s-text>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        {app.registration_document_url ? (
                          <s-link href={app.registration_document_url} target="_blank">
                            View Doc ↗
                          </s-link>
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        <s-text>
                          {app.submitted_at || app.updatedAt?.split("T")[0] || "Recent"}
                        </s-text>
                      </s-table-cell>

                      <s-table-cell>
                        <s-badge
                          tone={
                            isApproved
                              ? "success"
                              : isRejected
                              ? "critical"
                              : "warning"
                          }
                        >
                          {status}
                        </s-badge>
                        {isRejected && app.rejection_message && (
                          <s-paragraph color="subdued" type="small">
                            {app.rejection_message}
                          </s-paragraph>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        <s-button
                          icon="view"
                          variant="tertiary"
                          accessibilityLabel="View application"
                          href={detailHref}
                        />
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}

          {/* Pagination Controls Footer */}
          {filteredApplications.length > 0 && totalPages > 1 && (
            <>
              <s-divider />
              <s-box padding="small-400 small small">
                <s-stack
                  direction="inline"
                  gap="small-300"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-text variant="bodySm" tone="subdued">
                    Page {currentPage} of {totalPages} ({filteredApplications.length} applications)
                  </s-text>
                  <s-stack direction="inline" gap="small-300">
                    <s-button
                      variant="secondary"
                      disabled={currentPage <= 1}
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </s-button>
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
        </s-section>
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const errorMessage =
    error?.data ||
    error?.message ||
    (typeof error === "string" ? error : "An unexpected error occurred");

  return (
    <s-page heading="Distributor Applications" inlineSize="large">
      <s-section heading="Notice">
        <s-banner tone="critical" heading="Could not load applications">
          {String(errorMessage)}
        </s-banner>
        <s-box padding="base">
          <s-button onClick={() => window.location.reload()} variant="primary">
            Reload Page
          </s-button>
        </s-box>
      </s-section>
    </s-page>
  );
}