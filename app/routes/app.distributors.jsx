/* eslint-disable react/prop-types */

// app/routes/app.distributors.jsx
// Or use your existing route filename.

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

import {
  getAllDistributorApplications,
  withAccessState,
} from "../lib/distributor-metaobject.server";

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

const PAGE_SIZE_OPTIONS = [10, 20, 50];

const STATUS = {
  ALL: "all",
  PENDING: "pending review",
  APPROVED: "approved",
  REJECTED: "rejected",
};

const TABS = [
  {
    id: STATUS.ALL,
    label: "All",
  },

  {
    id: STATUS.PENDING,
    label: "Pending",
  },

  {
    id: STATUS.APPROVED,
    label: "Approved",
  },

  {
    id: STATUS.REJECTED,
    label: "Declined",
  },
];

/* ========================================================================== */
/* Existing helpers                                                           */
/* ========================================================================== */

function statusKey(application) {
  return String(application?.status || "Pending Review")
    .trim()
    .toLowerCase();
}

function statusLabel(application) {
  const key = statusKey(application);

  if (key === STATUS.APPROVED && application?.access_removed) {
    return "Approved · access removed";
  }

  if (key === STATUS.APPROVED) {
    return "Approved";
  }

  if (key === STATUS.REJECTED) {
    return "Declined";
  }

  return "Pending review";
}

function statusTone(application) {
  const key = statusKey(application);

  if (key === STATUS.APPROVED && application?.access_removed) {
    return "critical";
  }

  if (key === STATUS.APPROVED) {
    return "success";
  }

  if (key === STATUS.REJECTED) {
    return "critical";
  }

  return "warning";
}

function wantsCredit(application) {
  return (
    application?.request_credit === "true" ||
    application?.request_credit === true
  );
}

function formatDate(value) {
  if (!value) {
    return "—";
  }

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

/* ========================================================================== */
/* Shopify helpers                                                            */
/* ========================================================================== */

function normalizeCompanyId(value) {
  const id = String(value || "").trim();

  if (!id) {
    return "";
  }

  if (id.startsWith("gid://shopify/Company/")) {
    return id;
  }

  if (/^\d+$/.test(id)) {
    return `gid://shopify/Company/${id}`;
  }

  return "";
}

async function parseGraphQL(response, operationName) {
  const body = await response.json();

  if (body.errors?.length) {
    console.error(`[${operationName}] GraphQL errors:`, body.errors);

    throw new Error(body.errors.map((error) => error.message).join(", "));
  }

  return body.data;
}

function throwUserErrors(errors, operationName) {
  if (!errors?.length) {
    return;
  }

  console.error(`[${operationName}] user errors:`, errors);

  throw new Error(errors.map((error) => error.message).join(", "));
}

/* ========================================================================== */
/* Company Location Catalogs                                                  */
/* ========================================================================== */

async function getAllCompanyLocationCatalogs(admin) {
  const catalogs = [];

  let after = null;

  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
          query DistributorCompanyLocationCatalogs(
            $after: String
          ) {
            catalogs(
              first: 100
              after: $after
            ) {
              nodes {
                __typename

                id

                title

                status

                ... on CompanyLocationCatalog {
                  companyLocationsCount {
                    count
                  }

                  priceList {
                    id
                    name
                  }
                }
              }

              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
      {
        variables: {
          after,
        },
      },
    );

    const data = await parseGraphQL(
      response,
      "DistributorCompanyLocationCatalogs",
    );

    const nodes = data.catalogs?.nodes || [];

    /*
     * IMPORTANT:
     *
     * Only B2B Company Location catalogs
     * are allowed on this page.
     */
    const companyCatalogs = nodes.filter(
      (catalog) => catalog.__typename === "CompanyLocationCatalog",
    );

    catalogs.push(...companyCatalogs);

    hasNextPage = Boolean(data.catalogs?.pageInfo?.hasNextPage);

    after = data.catalogs?.pageInfo?.endCursor || null;
  }

  return catalogs;
}

/* ========================================================================== */
/* Company + locations + current catalogs                                     */
/* ========================================================================== */

async function getCompanyCatalogDetails(admin, rawCompanyId) {
  const companyId = normalizeCompanyId(rawCompanyId);

  if (!companyId) {
    throw new Error("A valid Shopify Company ID is required.");
  }

  const response = await admin.graphql(
    `#graphql
        query DistributorCompanyCatalogDetails(
          $id: ID!
        ) {
          company(
            id: $id
          ) {
            id

            name

            locations(
              first: 250
            ) {
              nodes {
                id

                name

                externalId

                catalogs(
                  first: 100
                ) {
                  nodes {
                    __typename

                    id

                    title

                    status

                    ... on CompanyLocationCatalog {
                      priceList {
                        id
                        name
                      }
                    }
                  }
                }
              }

              pageInfo {
                hasNextPage
              }
            }
          }
        }
      `,
    {
      variables: {
        id: companyId,
      },
    },
  );

  const data = await parseGraphQL(response, "DistributorCompanyCatalogDetails");

  const company = data.company;

  if (!company) {
    throw new Error("Shopify company was not found.");
  }

  const locations = (company.locations?.nodes || []).map((location) => {
    const catalogs = (location.catalogs?.nodes || []).filter(
      (catalog) => catalog.__typename === "CompanyLocationCatalog",
    );

    return {
      id: location.id,

      name: location.name,

      externalId: location.externalId,

      catalogs,
    };
  });

  /*
   * Build one unique list of
   * CompanyLocationCatalogs currently
   * assigned anywhere in the company.
   */
  const catalogMap = new Map();

  for (const location of locations) {
    for (const catalog of location.catalogs) {
      if (!catalogMap.has(catalog.id)) {
        catalogMap.set(catalog.id, catalog);
      }
    }
  }

  const currentCatalogs = Array.from(catalogMap.values());

  /*
   * Detect a catalog that is assigned
   * to ALL company locations.
   *
   * This becomes the current primary
   * selection in the UI.
   */
  let commonCatalog = null;

  if (locations.length > 0) {
    commonCatalog =
      currentCatalogs.find((catalog) =>
        locations.every((location) =>
          location.catalogs.some((item) => item.id === catalog.id),
        ),
      ) || null;
  }

  return {
    company: {
      id: company.id,

      name: company.name,
    },

    locations,

    currentCatalogs,

    commonCatalog,

    hasMoreLocations: Boolean(company.locations?.pageInfo?.hasNextPage),
  };
}

/* ========================================================================== */
/* Catalog context mutation                                                   */
/* ========================================================================== */

async function updateCatalogContext(
  admin,
  { catalogId, contextsToAdd, contextsToRemove },
) {
  const response = await admin.graphql(
    `#graphql
        mutation DistributorCatalogContextUpdate(
          $catalogId: ID!
          $contextsToAdd: CatalogContextInput
          $contextsToRemove: CatalogContextInput
        ) {
          catalogContextUpdate(
            catalogId: $catalogId
            contextsToAdd: $contextsToAdd
            contextsToRemove: $contextsToRemove
          ) {
            catalog {
              __typename

              id

              title

              status
            }

            userErrors {
              field

              message

              code
            }
          }
        }
      `,
    {
      variables: {
        catalogId,

        contextsToAdd: contextsToAdd || null,

        contextsToRemove: contextsToRemove || null,
      },
    },
  );

  const data = await parseGraphQL(response, "DistributorCatalogContextUpdate");

  throwUserErrors(
    data.catalogContextUpdate?.userErrors,
    "DistributorCatalogContextUpdate",
  );

  return data.catalogContextUpdate?.catalog || null;
}

/* ========================================================================== */
/* Assign / update company catalog                                            */
/* ========================================================================== */

async function assignOrUpdateCompanyCatalog(admin, { companyId, catalogId }) {
  /*
   * Re-fetch all company/location state
   * immediately before mutation.
   */
  const details = await getCompanyCatalogDetails(admin, companyId);

  const locations = details.locations;

  if (!locations.length) {
    throw new Error(
      "This company does not have any Shopify company locations.",
    );
  }

  if (details.hasMoreLocations) {
    throw new Error(
      "This company has more than 250 locations. Pagination must be completed before catalog assignment.",
    );
  }

  const allLocationIds = locations.map((location) => location.id);

  /*
   * Create:
   *
   * Catalog ID -> locations currently
   * using that catalog.
   */
  const catalogLocations = new Map();

  for (const location of locations) {
    for (const catalog of location.catalogs) {
      if (!catalogLocations.has(catalog.id)) {
        catalogLocations.set(catalog.id, []);
      }

      catalogLocations.get(catalog.id).push(location.id);
    }
  }

  /*
   * STEP 1
   *
   * Assign selected catalog to every
   * company location first.
   *
   * Doing the ADD before removals avoids
   * leaving locations without a catalog
   * if a later request fails.
   */
  await updateCatalogContext(admin, {
    catalogId,

    contextsToAdd: {
      companyLocationIds: allLocationIds,
    },

    contextsToRemove: null,
  });

  /*
   * STEP 2
   *
   * Remove every OTHER
   * CompanyLocationCatalog from these
   * company locations.
   *
   * Market catalogs are never returned
   * from getCompanyCatalogDetails(), so
   * they cannot be removed here.
   */
  for (const [existingCatalogId, locationIds] of catalogLocations.entries()) {
    if (existingCatalogId === catalogId) {
      continue;
    }

    if (!locationIds.length) {
      continue;
    }

    await updateCatalogContext(admin, {
      catalogId: existingCatalogId,

      contextsToAdd: null,

      contextsToRemove: {
        companyLocationIds: locationIds,
      },
    });
  }

  return getCompanyCatalogDetails(admin, companyId);
}

/* ========================================================================== */
/* Loader                                                                     */
/* ========================================================================== */

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const [applications, catalogs] = await Promise.all([
    withAccessState(
      admin,

      await getAllDistributorApplications(admin),
    ),

    getAllCompanyLocationCatalogs(admin),
  ]);

  return {
    applications,

    catalogs,
  };
};

/* ========================================================================== */
/* Action                                                                     */
/* ========================================================================== */

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    const formData = await request.formData();

    const intent = String(formData.get("intent") || "").trim();

    /* -------------------------------------------------------------------- */
    /* Load current company/catalog configuration                           */
    /* -------------------------------------------------------------------- */

    if (intent === "load_catalog_manager") {
      const companyId = String(formData.get("companyId") || "").trim();

      const details = await getCompanyCatalogDetails(admin, companyId);

      return {
        success: true,

        intent,

        details,
      };
    }

    /* -------------------------------------------------------------------- */
    /* Assign / update catalog                                              */
    /* -------------------------------------------------------------------- */

    if (intent === "save_company_catalog") {
      const companyId = String(formData.get("companyId") || "").trim();

      const catalogId = String(formData.get("catalogId") || "").trim();

      const normalizedCompanyId = normalizeCompanyId(companyId);

      if (!normalizedCompanyId) {
        return {
          success: false,

          intent,

          formError: "A valid Shopify Company ID is required.",
        };
      }

      if (!catalogId) {
        return {
          success: false,

          intent,

          fieldErrors: {
            catalogId: "Select a catalog.",
          },

          formError: "Select a Company Location catalog.",
        };
      }

      /*
       * Security / data validation:
       *
       * Never trust catalog ID supplied
       * by the browser.
       */
      const catalogs = await getAllCompanyLocationCatalogs(admin);

      const catalog = catalogs.find(
        (item) =>
          item.id === catalogId && item.__typename === "CompanyLocationCatalog",
      );

      if (!catalog) {
        return {
          success: false,

          intent,

          fieldErrors: {
            catalogId: "Select a valid Company Location catalog.",
          },

          formError: "The selected catalog is not available.",
        };
      }

      const details = await assignOrUpdateCompanyCatalog(admin, {
        companyId: normalizedCompanyId,

        catalogId: catalog.id,
      });

      return {
        success: true,

        intent,

        details,

        selectedCatalog: catalog,

        message:
          `${catalog.title} has been assigned to all ` +
          `${details.locations.length} location${
            details.locations.length === 1 ? "" : "s"
          } for ${details.company.name}.`,
      };
    }

    return {
      success: false,

      formError: "Unsupported action.",
    };
  } catch (error) {
    console.error("[distributors] catalog action failed:", error);

    return {
      success: false,

      formError:
        error instanceof Error
          ? error.message
          : "Unable to update the company catalog.",
    };
  }
};

/* ========================================================================== */
/* Catalog Modal                                                              */
/* ========================================================================== */

function CatalogManagerModal({
  application,
  catalogs,
  fetcher,
  selectedCatalogId,
  setSelectedCatalogId,
  onClose,
}) {
  const details = fetcher.data?.details;

  const loading = fetcher.state !== "idle";

  const currentCatalog = details?.commonCatalog || null;

  const hasExistingCatalogs = Boolean(details?.currentCatalogs?.length);

  const selectedCatalog = catalogs.find(
    (catalog) => catalog.id === selectedCatalogId,
  );

  useEffect(() => {
    if (details?.commonCatalog?.id && !selectedCatalogId) {
      setSelectedCatalogId(details.commonCatalog.id);
    }
  }, [details, selectedCatalogId, setSelectedCatalogId]);

  function saveCatalog() {
    if (!application?.company_id || !selectedCatalogId) {
      return;
    }

    const data = new FormData();

    data.set("intent", "save_company_catalog");

    data.set("companyId", application.company_id);

    data.set("catalogId", selectedCatalogId);

    fetcher.submit(data, {
      method: "post",
    });
  }

  return (
    <s-modal
      id="catalog-manager-modal"
      heading={
        application
          ? `Catalog — ${application.company_name || "Distributor"}`
          : "Manage catalog"
      }
    >
      <s-stack direction="block" gap="base">
        {loading && !details ? (
          <s-box padding="large-100">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-spinner accessibilityLabel="Loading company catalog" />

              <s-text>Loading Shopify company and catalog information…</s-text>
            </s-stack>
          </s-box>
        ) : null}

        {fetcher.data?.formError ? (
          <s-banner tone="critical" heading="Unable to update catalog">
            <s-paragraph>{fetcher.data.formError}</s-paragraph>
          </s-banner>
        ) : null}

        {fetcher.data?.success &&
        fetcher.data?.intent === "save_company_catalog" &&
        fetcher.data?.message ? (
          <s-banner tone="success" heading="Catalog updated">
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        {application ? (
          <s-box padding="base" border="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-heading>{application.company_name}</s-heading>

              {/* <s-text color="subdued">
                Shopify Company ID: {application.company_id || "Not available"}
              </s-text> */}

              {details?.company ? (
                <s-text>
                  Shopify company: <strong>{details.company.name}</strong>
                </s-text>
              ) : null}
            </s-stack>
          </s-box>
        ) : null}

        {details ? (
          <>
            <s-section heading="Company locations">
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  The selected catalog will be applied to all{" "}
                  {details.locations.length} company location
                  {details.locations.length === 1 ? "" : "s"}.
                </s-paragraph>

                {details.locations.map((location) => (
                  <s-box
                    key={location.id}
                    padding="small-400"
                    border="base"
                    borderRadius="base"
                  >
                    <s-grid
                      gridTemplateColumns="1fr auto"
                      gap="base"
                      alignItems="center"
                    >
                      <s-stack direction="block" gap="none">
                        <s-text type="strong">{location.name}</s-text>

                        {/* <s-text color="subdued">{location.id}</s-text> */}
                      </s-stack>

                      <s-badge>
                        {location.catalogs.length} catalog
                        {location.catalogs.length === 1 ? "" : "s"}
                      </s-badge>
                    </s-grid>
                  </s-box>
                ))}
              </s-stack>
            </s-section>

            <s-section heading="Current catalog">
              {currentCatalog ? (
                <s-box
                  padding="base"
                  border="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-heading>{currentCatalog.title}</s-heading>

                      <s-badge tone="success">Assigned</s-badge>
                    </s-stack>

                    {/* {currentCatalog.priceList?.name ? (
                      <s-text>
                        Price list: {currentCatalog.priceList.name}
                      </s-text>
                    ) : null} */}
                  </s-stack>
                </s-box>
              ) : hasExistingCatalogs ? (
                <s-banner
                  tone="warning"
                  heading="Locations have different catalogs"
                >
                  <s-paragraph>
                    The company locations do not currently share one common
                    catalog. Selecting a catalog below will standardize all
                    locations on that catalog.
                  </s-paragraph>
                </s-banner>
              ) : (
                <s-banner tone="info" heading="No catalog assigned">
                  <s-paragraph>
                    Select a catalog to assign it to every location for this
                    company.
                  </s-paragraph>
                </s-banner>
              )}
            </s-section>

            <s-section
              heading={
                hasExistingCatalogs ? "Update catalog" : "Assign catalog"
              }
            >
              <s-stack direction="block" gap="base">
                <s-select
                  label="Company Location catalog"
                  value={selectedCatalogId}
                  error={fetcher.data?.fieldErrors?.catalogId}
                  onChange={(event) => {
                    setSelectedCatalogId(
                      event?.currentTarget?.value ?? event?.target?.value ?? "",
                    );
                  }}
                >
                  <s-option value="">Select a catalog</s-option>

                  {catalogs.map((catalog) => (
                    <s-option key={catalog.id} value={catalog.id}>
                      {catalog.title}
                      {" — "}
                      {catalog.status}
                    </s-option>
                  ))}
                </s-select>

                {selectedCatalog ? (
                  <s-box
                    padding="base"
                    border="base"
                    borderRadius="base"
                    background="subdued"
                  >
                    <s-stack direction="block" gap="small">
                      <s-stack
                        direction="inline"
                        gap="small"
                        alignItems="center"
                      >
                        <s-heading>{selectedCatalog.title}</s-heading>

                        <s-badge
                          tone={
                            selectedCatalog.status === "ACTIVE"
                              ? "success"
                              : "neutral"
                          }
                        >
                          {selectedCatalog.status}
                        </s-badge>
                      </s-stack>

                      {/* {selectedCatalog.priceList?.name ? (
                        <s-text>
                          Price list: {selectedCatalog.priceList.name}
                        </s-text>
                      ) : null} */}
                    </s-stack>
                  </s-box>
                ) : null}

                <s-banner
                  tone="warning"
                  heading={
                    hasExistingCatalogs
                      ? "This will replace the current company catalog"
                      : "This catalog will apply to all locations"
                  }
                >
                  <s-paragraph>
                    {hasExistingCatalogs
                      ? "Other Company Location catalog assignments for this company will be removed from these locations after the selected catalog is assigned."
                      : "The selected catalog will be assigned to every Shopify company location."}
                  </s-paragraph>
                </s-banner>
              </s-stack>
            </s-section>
          </>
        ) : null}
      </s-stack>

      <s-button
        slot="secondary-actions"
        variant="tertiary"
        disabled={loading}
        onClick={onClose}
      >
        Close
      </s-button>

      <s-button
        slot="primary-action"
        variant="primary"
        loading={
          loading && fetcher.formData?.get("intent") === "save_company_catalog"
        }
        disabled={
          loading ||
          !details ||
          !details.locations?.length ||
          !selectedCatalogId
        }
        onClick={saveCatalog}
      >
        {hasExistingCatalogs ? "Update Catalog" : "Assign Catalog"}
      </s-button>
    </s-modal>
  );
}

/* ========================================================================== */
/* Page                                                                       */
/* ========================================================================== */

export default function DistributorApplicationsPage() {
  const { applications = [], catalogs = [] } = useLoaderData();

  const navigate = useNavigate();

  const catalogFetcher = useFetcher();

  const [tab, setTab] = useState(STATUS.ALL);

  const [query, setQuery] = useState("");

  const [creditOnly, setCreditOnly] = useState(false);

  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  const [page, setPage] = useState(1);

  const [catalogApplication, setCatalogApplication] = useState(null);

  const [selectedCatalogId, setSelectedCatalogId] = useState("");

  /* ------------------------------------------------------------------------ */
  /* Counts                                                                   */
  /* ------------------------------------------------------------------------ */

  const counts = useMemo(
    () => ({
      all: applications.length,

      [STATUS.PENDING]: applications.filter(
        (application) => statusKey(application) === STATUS.PENDING,
      ).length,

      [STATUS.APPROVED]: applications.filter(
        (application) => statusKey(application) === STATUS.APPROVED,
      ).length,

      [STATUS.REJECTED]: applications.filter(
        (application) => statusKey(application) === STATUS.REJECTED,
      ).length,
    }),
    [applications],
  );

  /* ------------------------------------------------------------------------ */
  /* Filter                                                                   */
  /* ------------------------------------------------------------------------ */

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return applications.filter((application) => {
      if (tab !== STATUS.ALL && statusKey(application) !== tab) {
        return false;
      }

      if (creditOnly && !wantsCredit(application)) {
        return false;
      }

      if (!needle) {
        return true;
      }

      const haystack = [
        application.company_name,

        application.contact_person,

        application.customer_email,

        application.registration_number,

        application.country_based,

        application.company_id,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(needle);
    });
  }, [applications, tab, query, creditOnly]);

  const totalPages = Math.max(
    1,

    Math.ceil(filtered.length / pageSize),
  );

  const currentPage = Math.min(page, totalPages);

  const visible = filtered.slice(
    (currentPage - 1) * pageSize,

    currentPage * pageSize,
  );

  const changeTab = useCallback((next) => {
    setTab(next);

    setPage(1);
  }, []);

  const hasFilters = tab !== STATUS.ALL || creditOnly || query.trim() !== "";

  /* ------------------------------------------------------------------------ */
  /* Catalog manager                                                          */
  /* ------------------------------------------------------------------------ */

  function openCatalogManager(application) {
    if (statusKey(application) !== STATUS.APPROVED) {
      shopify.toast.show(
        "Catalogs can only be managed for approved distributors.",
      );

      return;
    }

    if (!application?.company_id) {
      shopify.toast.show(
        "This approved distributor does not have a Shopify Company ID.",
      );

      return;
    }

    setCatalogApplication(application);

    setSelectedCatalogId("");

    const data = new FormData();

    data.set("intent", "load_catalog_manager");

    data.set("companyId", application.company_id);

    catalogFetcher.submit(data, {
      method: "post",
    });

    shopify.modal.show("catalog-manager-modal");
  }

  function closeCatalogManager() {
    shopify.modal.hide("catalog-manager-modal");

    setCatalogApplication(null);

    setSelectedCatalogId("");
  }

  useEffect(() => {
    if (
      catalogFetcher.data?.success &&
      catalogFetcher.data?.intent === "save_company_catalog" &&
      catalogFetcher.data?.message
    ) {
      shopify.toast.show(catalogFetcher.data.message);
    }
  }, [catalogFetcher.data]);

  /* ------------------------------------------------------------------------ */
  /* UI                                                                       */
  /* ------------------------------------------------------------------------ */

  return (
    <s-page heading="Distributor applications" inlineSize="large">
      <s-button slot="secondary-actions" href="/app" variant="tertiary">
        Dashboard
      </s-button>

      {/* Catalog manager */}

      <CatalogManagerModal
        application={catalogApplication}
        catalogs={catalogs}
        fetcher={catalogFetcher}
        selectedCatalogId={selectedCatalogId}
        setSelectedCatalogId={setSelectedCatalogId}
        onClose={closeCatalogManager}
      />

      {/* Pending warning */}

      {counts[STATUS.PENDING] > 0 ? (
        <s-banner
          tone="warning"
          heading={`${counts[STATUS.PENDING]} application${
            counts[STATUS.PENDING] === 1 ? "" : "s"
          } awaiting a decision`}
        >
          <s-paragraph>
            Approving creates the Shopify B2B company, links the contact and
            assigns their pricing tier.
          </s-paragraph>
        </s-banner>
      ) : null}

      {/* Summary */}

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

                {counts[STATUS.PENDING] > 0 ? (
                  <s-badge tone="warning">Action</s-badge>
                ) : null}
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

      {/* Applications */}

      <s-section>
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
            <s-search-field
              label="Search applications"
              labelAccessibilityVisibility="exclusive"
              placeholder="Company, contact, email or registration number"
              value={query}
              onInput={(event) => {
                setQuery(
                  event?.currentTarget?.value ?? event?.target?.value ?? "",
                );

                setPage(1);
              }}
            />

            <s-select
              label="Per page"
              labelAccessibilityVisibility="exclusive"
              value={String(pageSize)}
              onChange={(event) => {
                setPageSize(
                  Number(
                    event?.currentTarget?.value ??
                      event?.target?.value ??
                      PAGE_SIZE_OPTIONS[0],
                  ),
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

          {/* Filters */}

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

            {/* <s-checkbox
              label="Credit requested only"
              name="creditOnly"
              checked={creditOnly}
              onChange={() => {
                setCreditOnly((value) => !value);

                setPage(1);
              }}
            /> */}
          </s-stack>

          {/* Empty */}

          {visible.length === 0 ? (
            <s-box padding="large-100" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200" alignItems="center">
                <s-heading>
                  {applications.length === 0
                    ? "No applications yet"
                    : "Nothing matches"}
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

                <s-table-header>Catalog</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {visible.map((application) => {
                  const href = `/app/distributor/${encodeURIComponent(
                    application.id,
                  )}`;

                  const approved = statusKey(application) === STATUS.APPROVED;

                  const canManageCatalog =
                    approved &&
                    Boolean(application.company_id) &&
                    !application.access_removed;

                  return (
                    <s-table-row key={application.id}>
                      <s-table-cell>
                        <s-stack direction="block" gap="none">
                          <s-link href={href}>
                            {application.company_name || "Unnamed company"}
                          </s-link>

                          {application.registration_number ? (
                            <s-text color="subdued">
                              UEN {application.registration_number}
                            </s-text>
                          ) : null}

                          {application.company_id ? (
                            <s-text color="subdued">
                              Shopify company{" "}
                              {application.company_id.split("/").pop()}
                            </s-text>
                          ) : null}
                        </s-stack>
                      </s-table-cell>

                      <s-table-cell>
                        <s-stack direction="block" gap="none">
                          <s-text>{application.contact_person || "—"}</s-text>

                          <s-text color="subdued">
                            {application.customer_email || ""}
                          </s-text>
                        </s-stack>
                      </s-table-cell>

                      <s-table-cell>
                        {application.country_based || "—"}
                      </s-table-cell>

                      <s-table-cell>
                        {wantsCredit(application) ? (
                          <s-badge tone="info">Credit requested</s-badge>
                        ) : (
                          <s-text color="subdued">Prepayment</s-text>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        {formatDate(
                          application.submitted_at || application.updatedAt,
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        <s-badge tone={statusTone(application)}>
                          {statusLabel(application)}
                        </s-badge>
                      </s-table-cell>

                      <s-table-cell>
                        {canManageCatalog ? (
                          <s-button
                            variant="tertiary"
                            onClick={() => openCatalogManager(application)}
                          >
                            Manage catalog
                          </s-button>
                        ) : approved && !application.company_id ? (
                          <s-badge tone="warning">Company ID missing</s-badge>
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}

          {/* Pagination */}

          {totalPages > 1 ? (
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button
                variant="tertiary"
                disabled={currentPage <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </s-button>

              <s-text color="subdued">
                Page {currentPage} of {totalPages} · {filtered.length}{" "}
                application
                {filtered.length === 1 ? "" : "s"}
              </s-text>

              <s-button
                variant="tertiary"
                disabled={currentPage >= totalPages}
                onClick={() =>
                  setPage((current) =>
                    Math.min(
                      totalPages,

                      current + 1,
                    ),
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

/* ========================================================================== */
/* Error boundary                                                             */
/* ========================================================================== */

export function ErrorBoundary() {
  const error = useRouteError();

  console.error("[distributors] render failed:", error);

  return (
    <s-page heading="Distributor applications">
      <s-section>
        <s-banner tone="critical" heading="We couldn't load applications">
          <s-paragraph>
            {error?.message || "Please reload the page."}
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
