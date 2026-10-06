import { useState, useEffect, useMemo } from "react";

import {

  useLoaderData,

  useFetcher,

  useRouteError,

  useParams,

  useNavigate,

} from "react-router";

import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";

import { ensureCommercialDefinitions } from "../lib/commercial-metafields.server";

import { completeB2BOnboarding } from "../lib/b2b-onboarding.server";
import { addressErrors, shopifyAddressInput } from "../lib/address-formats.server";
import { ADDRESS_FORMATS } from "../lib/address-formats.data";

import { sendApplicationDecisionEmail } from "../lib/application-emails.server";

import {

  getDistributorApplicationById,

  updateDistributorApplication,

  deleteDistributorApplication,

  withAccessState,

} from "../lib/distributor-metaobject.server";

import {

  approveAndCreateB2BCustomer,

  assignLocationAddress,

  getCompanyDetails,

  getPaymentTermsTemplates,

} from "../lib/distributor-b2b.server";



/* ==========================================================================

   Constants

   ========================================================================== */



const APPLICATION_STATUSES = {

  PENDING: "Pending Review",

  APPROVED: "Approved",

  REJECTED: "Rejected",

};

const EMPTY_REGISTERED_ADDRESS = {
  address1: "",
  address2: "",
  barangay: "",
  city: "",
  country: "",
  province: "",
  provinceCode: "",
  zip: "",
  phone: "",
};

function normalizeRegisteredAddress(application) {
  const value = application?.registered_address_json;

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      address1: String(value.address1 || "").trim(),
      address2: String(value.address2 || "").trim(),
      barangay: String(value.barangay || "").trim(),
      city: String(value.city || "").trim(),
      country: String(value.country || "").trim(),
      province: String(value.province || "").trim(),
      provinceCode: String(value.provinceCode || "").trim(),
      zip: String(value.zip || "").trim(),
      phone: String(value.phone || "").trim(),
    };
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return normalizeRegisteredAddress({ registered_address_json: parsed });
      }
    } catch {
      // Fall through to legacy address support.
    }
  }

  if (application?.registered_address) {
    return {
      ...EMPTY_REGISTERED_ADDRESS,
      address1: String(application.registered_address).trim(),
      country: String(application.country_based || "").trim(),
    };
  }

  return {
    ...EMPTY_REGISTERED_ADDRESS,
    country: String(application?.country_based || "").trim(),
  };
}

function countryToCode(country, fallback = "SG") {
  const value = String(country || "").trim();

  if (/^[A-Za-z]{2}$/.test(value)) {
    return value.toUpperCase();
  }

  const countryCodes = {
    singapore: "SG",
    malaysia: "MY",
    "hong kong": "HK",
    philippines: "PH",
    thailand: "TH",
    indonesia: "ID",
    vietnam: "VN",
    china: "CN",
    india: "IN",
    japan: "JP",
    taiwan: "TW",
    australia: "AU",
    "new zealand": "NZ",
    "united states": "US",
    usa: "US",
    "united kingdom": "GB",
    uk: "GB",
  };

  return countryCodes[value.toLowerCase()] || fallback || "";
}

function formatRegisteredAddress(address) {
  if (!address) return "";

  return [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.provinceCode,
    address.zip,
    address.country,
  ]
    .filter(Boolean)
    .join(", ");
}


async function fetchAllCatalogs(admin) {
  const response = await admin.graphql(
    `#graphql
    query CompanyLocationCatalogs {
      catalogs(first: 20) {
        nodes {
          __typename
          id
          title
          status

          ... on CompanyLocationCatalog {
            companyLocations(first: 50) {
              nodes {
                id
              }
            }
          }
        }
      }
    }
    `,
  );

  const body = await response.json();

  if (body?.errors?.length) {
    throw new Error(
      body.errors.map((error) => error.message).filter(Boolean).join(", ") ||
        "Unable to load Shopify catalogs.",
    );
  }

  return (body?.data?.catalogs?.nodes || [])
    .filter((catalog) => catalog?.__typename === "CompanyLocationCatalog")
    .map((catalog) => ({
      id: catalog.id,
      title: catalog.title,
      status: catalog.status,
      __typename: catalog.__typename,
      companyLocationIds: (catalog?.companyLocations?.nodes || [])
        .map((location) => location?.id)
        .filter(Boolean),
    }))
    .sort((a, b) =>
      String(a?.title || "").localeCompare(String(b?.title || "")),
    );
}

async function getCompanyLocationIds(admin, companyId) {
  const ids = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
      query CompanyLocationsForCatalogAssignment(
        $companyId: ID!
        $first: Int!
        $after: String
      ) {
        company(id: $companyId) {
          id
          locations(first: $first, after: $after) {
            nodes {
              id
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
      `,
      {
        variables: {
          companyId,
          first: 100,
          after,
        },
      },
    );

    const body = await response.json();

    if (body?.errors?.length) {
      throw new Error(
        body.errors.map((error) => error.message).filter(Boolean).join(", ") ||
          "Unable to load company locations.",
      );
    }

    const company = body?.data?.company;

    if (!company) {
      throw new Error("Shopify company was not found while assigning the catalog.");
    }

    const connection = company.locations;

    ids.push(...(connection?.nodes || []).map((location) => location.id).filter(Boolean));

    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = connection?.pageInfo?.endCursor || null;
  }

  return [...new Set(ids)];
}

async function assignCatalogToCompany({ admin, companyId, catalogId }) {
  if (!admin || !companyId || !catalogId) {
    throw new Error("Company ID and catalog ID are required to assign a catalog.");
  }

  const companyLocationIds = await getCompanyLocationIds(admin, companyId);

  if (!companyLocationIds.length) {
    throw new Error("Company has no locations to attach the catalog to.");
  }

  const response = await admin.graphql(
    `#graphql
    mutation AssignCatalogToCompanyLocations(
      $catalogId: ID!
      $contextsToAdd: CatalogContextInput!
    ) {
      catalogContextUpdate(
        catalogId: $catalogId
        contextsToAdd: $contextsToAdd
      ) {
        catalog {
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
        contextsToAdd: {
          companyLocationIds,
        },
      },
    },
  );

  const body = await response.json();

  if (body?.errors?.length) {
    throw new Error(
      body.errors.map((error) => error.message).filter(Boolean).join(", ") ||
        "Unable to assign the catalog.",
    );
  }

  const payload = body?.data?.catalogContextUpdate;
  const userErrors = payload?.userErrors || [];

  if (userErrors.length) {
    throw new Error(
      userErrors
        .map((error) => {
          const path = Array.isArray(error?.field) ? ` (${error.field.join(".")})` : "";
          return `${error?.message || "Catalog assignment failed"}${path}`;
        })
        .join(", "),
    );
  }

  if (!payload?.catalog?.id) {
    throw new Error("Shopify did not return the assigned catalog.");
  }

  return {
    catalog: payload.catalog,
    companyLocationIds,
  };
}


async function removeCatalogFromCompanyLocations({
  admin,
  catalogId,
  companyLocationIds,
}) {
  if (!catalogId || !companyLocationIds?.length) {
    return null;
  }

  const response = await admin.graphql(
    `#graphql
    mutation RemoveCatalogFromCompanyLocations(
      $catalogId: ID!
      $contextsToRemove: CatalogContextInput!
    ) {
      catalogContextUpdate(
        catalogId: $catalogId
        contextsToRemove: $contextsToRemove
      ) {
        catalog {
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
        contextsToRemove: {
          companyLocationIds,
        },
      },
    },
  );

  const body = await response.json();

  if (body?.errors?.length) {
    throw new Error(
      body.errors.map((error) => error.message).filter(Boolean).join(", ") ||
        "Unable to remove the previous catalog assignment.",
    );
  }

  const payload = body?.data?.catalogContextUpdate;
  const userErrors = payload?.userErrors || [];

  if (userErrors.length) {
    throw new Error(
      userErrors
        .map((error) => {
          const path = Array.isArray(error?.field) ? ` (${error.field.join(".")})` : "";
          return `${error?.message || "Catalog removal failed"}${path}`;
        })
        .join(", "),
    );
  }

  return payload?.catalog || null;
}

async function changeCompanyCatalog({ admin, companyId, catalogId }) {
  if (!admin || !companyId || !catalogId) {
    throw new Error("Company ID and catalog ID are required to change the catalog.");
  }

  const catalogs = await fetchAllCatalogs(admin);
  const selectedCatalog = catalogs.find((catalog) => catalog.id === catalogId);

  if (!selectedCatalog) {
    throw new Error("Select a valid CompanyLocationCatalog.");
  }

  const companyLocationIds = await getCompanyLocationIds(admin, companyId);

  if (!companyLocationIds.length) {
    throw new Error("Company has no locations to attach the catalog to.");
  }

  const locationIdSet = new Set(companyLocationIds);
  const removedCatalogs = [];

  for (const catalog of catalogs) {
    if (catalog.id === catalogId) continue;

    const matchingLocationIds = (catalog.companyLocationIds || []).filter((locationId) =>
      locationIdSet.has(locationId),
    );

    if (!matchingLocationIds.length) continue;

    const removed = await removeCatalogFromCompanyLocations({
      admin,
      catalogId: catalog.id,
      companyLocationIds: matchingLocationIds,
    });

    removedCatalogs.push({
      id: catalog.id,
      title: removed?.title || catalog.title,
      locationCount: matchingLocationIds.length,
    });
  }

  const assigned = await assignCatalogToCompany({
    admin,
    companyId,
    catalogId,
  });

  return {
    ...assigned,
    removedCatalogs,
  };
}

async function removeCompanyCatalogs({ admin, companyId }) {
  if (!admin || !companyId) {
    throw new Error("Company ID is required to remove the catalog.");
  }

  const catalogs = await fetchAllCatalogs(admin);
  const companyLocationIds = await getCompanyLocationIds(admin, companyId);

  if (!companyLocationIds.length) {
    throw new Error("Company has no locations to remove from catalogs.");
  }

  const locationIdSet = new Set(companyLocationIds);
  const removedCatalogs = [];

  for (const catalog of catalogs) {
    const matchingLocationIds = (catalog.companyLocationIds || []).filter((locationId) =>
      locationIdSet.has(locationId),
    );

    if (!matchingLocationIds.length) continue;

    const removed = await removeCatalogFromCompanyLocations({
      admin,
      catalogId: catalog.id,
      companyLocationIds: matchingLocationIds,
    });

    removedCatalogs.push({
      id: catalog.id,
      title: removed?.title || catalog.title,
      locationCount: matchingLocationIds.length,
    });
  }

  return {
    companyLocationIds,
    removedCatalogs,
  };
}



/* ==========================================================================

   Loader

   ========================================================================== */



export const loader = async ({ request, params }) => {

  const { admin, session } = await authenticate.admin(request);

  const shop = session?.shop || "";



  const id = params?.id;



  if (!id) {

    throw new Response("Distributor Application ID is required.", {

      status: 400,

    });

  }



  const found = await getDistributorApplicationById(admin, id);



  if (!found) {

    throw new Response("Distributor Application Not Found", {

      status: 404,

    });

  }



  const [application] = await withAccessState(admin, [found]);



  let company = null;



  const companyId = application?.company_id;

  const companyName = application?.company_name;



  if (companyId || application?.status === APPLICATION_STATUSES.APPROVED) {

    company = await getCompanyDetails(admin, companyId, companyName);

  }



  const [paymentTermsTemplates, catalogs] = await Promise.all([

    getPaymentTermsTemplates(admin),

    fetchAllCatalogs(admin),

  ]);

  const companyLocationIds = (company?.locations?.edges || [])
    .map((edge) => edge?.node?.id)
    .filter(Boolean);

  const assignedCatalog = catalogs.find((catalog) =>
    (catalog.companyLocationIds || []).some((locationId) =>
      companyLocationIds.includes(locationId),
    ),
  );



  const addressDetails = normalizeRegisteredAddress(application);

  addressDetails.countryCode = countryToCode(
    addressDetails.country,
    countryToCode(application?.country_based, "SG"),
  );



  return {

    application,

    company,

    paymentTermsTemplates,

    catalogs,

    assignedCatalogId: assignedCatalog?.id || "",

    assignedCatalogTitle: assignedCatalog?.title || "",

    addressDetails,

    shop,

  };

};



/* ==========================================================================

   Action

   ========================================================================== */



export const action = async ({ request, params }) => {

  try {

    const { admin } = await authenticate.admin(request);

    const formData = await request.formData();



    const intent = String(formData.get("intent") || "").trim();



    const metaobjectId = String(

      formData.get("metaobjectId") || params?.id || "",

    ).trim();



    if (!metaobjectId) {

      return {

        success: false,

        error: "Distributor application ID is missing.",

      };

    }



    const application = await getDistributorApplicationById(

      admin,

      metaobjectId,

    );



    if (!application) {

      return {

        success: false,

        error: "Application record not found in Shopify.",

      };

    }



    const targetGid = application.id || metaobjectId;

    const catalogId = String(formData.get("catalogId") || "").trim();

    if (intent === "update_catalog") {
      const existingStatus = String(
        application.status || APPLICATION_STATUSES.PENDING,
      ).trim();

      if (existingStatus !== APPLICATION_STATUSES.APPROVED) {
        return {
          success: false,
          error: "Catalog can only be changed after the application is approved.",
          status: existingStatus,
        };
      }

      if (!application.company_id) {
        return {
          success: false,
          error: "This approved application is not linked to a Shopify company.",
          status: existingStatus,
        };
      }

      if (!catalogId) {
        return {
          success: false,
          error: "Choose a catalog before saving.",
          status: existingStatus,
        };
      }

      const catalogChange = await changeCompanyCatalog({
        admin,
        companyId: application.company_id,
        catalogId,
      });

      return {
        success: true,
        catalogUpdated: true,
        status: APPLICATION_STATUSES.APPROVED,
        catalogId: catalogChange.catalog.id,
        catalogTitle: catalogChange.catalog.title || "Selected catalog",
        removedCatalogs: catalogChange.removedCatalogs,
        message: `${catalogChange.catalog.title || "Selected catalog"} is now assigned to the distributor.`,
      };
    }

    if (intent === "remove_catalog") {
      const existingStatus = String(
        application.status || APPLICATION_STATUSES.PENDING,
      ).trim();

      if (existingStatus !== APPLICATION_STATUSES.APPROVED) {
        return {
          success: false,
          error: "Catalog can only be removed after the application is approved.",
          status: existingStatus,
        };
      }

      if (!application.company_id) {
        return {
          success: false,
          error: "This approved application is not linked to a Shopify company.",
          status: existingStatus,
        };
      }

      const catalogRemoval = await removeCompanyCatalogs({
        admin,
        companyId: application.company_id,
      });

      return {
        success: true,
        catalogRemoved: true,
        status: APPLICATION_STATUSES.APPROVED,
        catalogId: "",
        removedCatalogs: catalogRemoval.removedCatalogs,
        message: catalogRemoval.removedCatalogs.length
          ? "Price Tier Catalog removed from the distributor company."
          : "No Price Tier Catalog was assigned to this distributor company.",
      };
    }



    /* ----------------------------------------------------------------------

       Save the application's address to a company location that has none.

       Approvals used to create the location blank when the applicant already

       had an account, so this repairs a company approved before the fix.

       ---------------------------------------------------------------------- */

    if (intent === "save_location_address") {

      const company = await getCompanyDetails(admin, application.company_id, application.company_name);

      const location = company?.locations?.edges?.[0]?.node;

      if (!location?.id) {

        return { success: false, error: "This company has no location in Shopify." };

      }

      const address = normalizeRegisteredAddress(application);

      if (!address.address1) {
        return {
          success: false,
          error: "The application has no registered address to save.",
        };
      }

      // The region goes as Shopify's code and the Barangay on the apartment
      // line, the same as at approval (HYV-143).
      const input = shopifyAddressInput({
        ...address,
        country: address.country || application.country_based,
      });

      const saved = await assignLocationAddress(admin, location.id, {
        address1: input.address1,
        address2: input.address2,
        city: input.city,
        // CompanyAddressInput takes the region as zoneCode; `province`
        // makes Shopify reject the whole address.
        zoneCode: input.zoneCode,
        zip: input.zip,
        countryCode: input.countryCode || countryToCode(application.country_based, "SG"),
        recipient: application.company_name || undefined,
      });

      return saved.ok

        ? { success: true, addressSaved: true, status: application.status }

        : { success: false, error: `Shopify didn't save the address: ${saved.error}` };

    }



    /* ----------------------------------------------------------------------

       Delete Request (Remove metaobject from Shopify)

       ---------------------------------------------------------------------- */

    if (intent === "delete") {

      const deleteResult = await deleteDistributorApplication(

        admin,

        targetGid,

      );



      if (!deleteResult || !deleteResult.success) {

        return {

          success: false,

          error:

            deleteResult?.error ||

            "Unable to delete the distributor application from Shopify.",

        };

      }



      return {

        success: true,

        deleted: true,

        message: "Distributor application was permanently deleted.",

      };

    }



    const status = String(

      formData.get("status") || APPLICATION_STATUSES.PENDING,

    ).trim();



    const rejectionMessage = String(

      formData.get("rejectionMessage") || "",

    ).trim();



    const paymentTermsTemplateId = String(

      formData.get("paymentTermsTemplateId") || "",

    ).trim();



    const shippingAddress1 = String(formData.get("shippingAddress1") || "").trim();

    const shippingAddress2 = String(formData.get("shippingAddress2") || "").trim();

    const shippingCity = String(formData.get("shippingCity") || "").trim();

    const shippingCountry = String(formData.get("shippingCountry") || "").trim();

    const shippingProvince = String(formData.get("shippingProvince") || "").trim();

    const shippingProvinceCode = String(
      formData.get("shippingProvinceCode") || "",
    )
      .trim()
      .toUpperCase();

    const shippingZip = String(formData.get("shippingZip") || "").trim();

    const shippingBarangay = String(formData.get("shippingBarangay") || "").trim();

    const shippingPhone = String(formData.get("shippingPhone") || "").trim();

    const shippingCountryCode = String(
      formData.get("shippingCountryCode") || "",
    )
      .trim()
      .toUpperCase();



    const salesRep = String(formData.get("salesRep") || "").trim();

    const salesRepEmail = String(formData.get("salesRepEmail") || "").trim();

    const salesRepPhone = String(formData.get("salesRepPhone") || "").trim();

    if (!Object.values(APPLICATION_STATUSES).includes(status)) {

      return {

        success: false,

        error: "Invalid application status.",

      };

    }



    /*

     * Finalized applications cannot be modified.

     * This is also enforced server-side for security.

     */

    const existingStatus = String(

      application.status || APPLICATION_STATUSES.PENDING,

    ).trim();



    if (

      existingStatus === APPLICATION_STATUSES.APPROVED ||

      existingStatus === APPLICATION_STATUSES.REJECTED

    ) {

      return {

        success: false,

        error:

          "This application has already been finalized and cannot be changed from this screen.",

        status: existingStatus,

        rejectionMessage: application.rejection_message || "",

        customerId: application.customer_id || "",

        companyId: application.company_id || "",

      };

    }



    if (

      status === APPLICATION_STATUSES.REJECTED &&

      !rejectionMessage

    ) {

      return {

        success: false,

        error:

          "A rejection reason is required before rejecting the application.",

        status: APPLICATION_STATUSES.PENDING,

      };

    }



    const updates = {

      status,

    };



    let b2bResult = null;

    let onboardingSteps = [];



    /* ----------------------------------------------------------------------

       Approval

       ---------------------------------------------------------------------- */



    if (status === APPLICATION_STATUSES.APPROVED) {

      // Every distributor gets a named contact they can reach. The form blocks

      // this too, but the action is what creates the company, so it decides.

      if (!salesRep || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(salesRepEmail)) {

        return {

          success: false,

          error: "Add the sales representative's name and a valid email before approving.",

          status: APPLICATION_STATUSES.PENDING,

        };

      }

      // Checked with Shopify's fields for the country (HYV-143): Singapore
      // has no city or region, Hong Kong no postal code, and so on.
      const approvalAddress = {
        address1: shippingAddress1,
        address2: shippingAddress2,
        barangay: shippingBarangay,
        city: shippingCity,
        country: shippingCountryCode || shippingCountry,
        province: shippingProvince,
        provinceCode: shippingProvinceCode,
        zip: shippingZip,
      };

      const addressProblem = Object.values(addressErrors(approvalAddress))[0];

      if (addressProblem || !shippingPhone) {
        return {
          success: false,
          error: `${addressProblem || "Phone is required."} Fix the address before approving the application.`,
          status: APPLICATION_STATUSES.PENDING,
        };
      }

      if (!/^\+?[0-9()\-\s]{7,20}$/.test(shippingPhone)) {
        return {
          success: false,
          error: "Enter a valid registered address phone number.",
          status: APPLICATION_STATUSES.PENDING,
        };
      }



      // The metafields must exist with the right types before anything is

      // written to them — a value whose type doesn't match is silently rejected.

      const definitions = await ensureCommercialDefinitions(admin);

      onboardingSteps = definitions.steps;



      // Shopify's region code, not its name, and the Barangay on the
      // apartment line.
      const structuredAddress = shopifyAddressInput(approvalAddress);



      b2bResult = await approveAndCreateB2BCustomer(

        admin,

        application,

        { shippingAddress: structuredAddress },

      );



      if (b2bResult?.error) {

        return {

          success: false,

          error:

            b2bResult.error ||

            "Unable to create or link the Shopify B2B customer/company.",

          status: APPLICATION_STATUSES.PENDING,

        };

      }



      if (b2bResult?.customerId) {

        updates.customer_id = b2bResult.customerId;

      }



      // A customer with tags but no company is not a distributor: the portal

      // and the pricing both key off company membership.

      if (!b2bResult?.companyId) {

        return {

          success: false,

          error:

            b2bResult?.companyError ||

            "The Shopify B2B company could not be created, so this application was not approved.",

          status: APPLICATION_STATUSES.PENDING,

        };

      }



      updates.company_id = b2bResult.companyId;



      // The company exists but its location has no address, so orders from it

      // can't be shipped. This says why.

      if (b2bResult.locationError) {

        onboardingSteps.push({

          name: "location address",

          ok: false,

          detail: `The company address wasn't saved in Shopify: ${b2bResult.locationError}`,

        });

      }

      // The applicant isn't a contact on the company, so they can't order for it.

      if (b2bResult.contactError) {

        onboardingSteps.push({

          name: "company contact",

          ok: false,

          detail: `The applicant wasn't added to the company: ${b2bResult.contactError}`,

        });

      }



      // Finish the setup: ordering role, payment terms, tier catalog, sales rep.

      // Each step reports its own outcome so a partial setup is visible.

      const onboarding = await completeB2BOnboarding(admin, b2bResult.companyId, {

        paymentTerms: paymentTermsTemplateId || null,

        // Catalog is intentionally NOT passed here. Catalog assignment is
        // optional and handled explicitly below only when catalogId exists.
        // This avoids sending null/empty to any GraphQL $catalogId: ID! variable.

        salesRep,

        salesRepEmail,

        salesRepPhone: salesRepPhone || null,

        taxRegistrationNumber: application?.tax_registration_number || null,

        preferredCurrency: application?.preferred_currency || null,

      });

      onboardingSteps = onboardingSteps.concat(onboarding.steps);

      if (catalogId) {
        try {
          const catalogAssignment = await assignCatalogToCompany({
            admin,
            companyId: b2bResult.companyId,
            catalogId,
          });

          onboardingSteps.push({
            name: "catalog assignment",
            ok: true,
            detail: `${catalogAssignment.catalog.title || "Selected catalog"} assigned to ${catalogAssignment.companyLocationIds.length} company location${catalogAssignment.companyLocationIds.length === 1 ? "" : "s"}.`,
          });
        } catch (catalogError) {
          onboardingSteps.push({
            name: "catalog assignment",
            ok: false,
            detail: catalogError?.message || "The selected catalog could not be assigned to the company.",
          });
        }
      }



      updates.registered_address_json = {
        address1: shippingAddress1,
        address2: shippingAddress2,
        barangay: approvalAddress.barangay,
        city: shippingCity,
        country: shippingCountry,
        province: shippingProvince,
        provinceCode: shippingProvinceCode,
        zip: shippingZip,
        phone: shippingPhone,
      };



      updates.rejection_message = "";

    }



    /* ----------------------------------------------------------------------

       Rejection

       ---------------------------------------------------------------------- */



    if (status === APPLICATION_STATUSES.REJECTED) {

      updates.rejection_message = rejectionMessage;

    }



    /* ----------------------------------------------------------------------

       Save

       ---------------------------------------------------------------------- */



    const updateResult = await updateDistributorApplication(

      admin,

      targetGid,

      updates,

    );



    if (!updateResult || updateResult.error) {

      return {

        success: false,

        error:

          updateResult?.error ||

          "Unable to update the distributor application.",

        status: APPLICATION_STATUSES.PENDING,

        rejectionMessage,

      };

    }



    // HYV-110: the applicant hears the outcome. An approval waits until every

    // setup step worked, so nobody is invited into an account without its

    // pricing or terms; staff see that it was held back.

    const setupComplete = onboardingSteps.every((step) => step.ok);

    if (status === APPLICATION_STATUSES.REJECTED) {

      await sendApplicationDecisionEmail(admin, application, { approved: false });

    } else if (status === APPLICATION_STATUSES.APPROVED && setupComplete) {

      await sendApplicationDecisionEmail(admin, application, { approved: true, salesRep, salesRepEmail });

    } else if (status === APPLICATION_STATUSES.APPROVED) {

      onboardingSteps.push({

        name: "approval email",

        ok: false,

        detail: "Not sent, because a setup step above needs attention. Email the distributor once it's fixed.",

      });

    }



    return {

      success: true,

      status,

      rejectionMessage:

        status === APPLICATION_STATUSES.REJECTED

          ? rejectionMessage

          : "",

      customerId:

        updates.customer_id ||

        application.customer_id ||

        "",

      companyId:

        updates.company_id ||

        application.company_id ||

        "",

      company: b2bResult?.company || null,

      onboardingSteps,

      b2bCreated: Boolean(b2bResult?.customerId),

      companyCreated: Boolean(b2bResult?.companyId),

    };

  } catch (error) {

    // Shopify throws a Response to re-authenticate or redirect. Swallowing it

    // turns a fixable auth prompt into "Unexpected Server Error", so it has to

    // travel on untouched.

    if (error instanceof Response) throw error;



    console.error(

      "[distributor.action] Error during application decision:",

      error,

    );



    return {

      success: false,

      error:

        error?.message ||

        "An unexpected error occurred while processing the application.",

    };

  }

};



/* ==========================================================================

   Helpers

   ========================================================================== */



function normalizeStatus(value) {

  const normalized = String(value || "")

    .trim()

    .toLowerCase();



  if (normalized === "approved") {

    return APPLICATION_STATUSES.APPROVED;

  }



  if (normalized === "rejected") {

    return APPLICATION_STATUSES.REJECTED;

  }



  return APPLICATION_STATUSES.PENDING;

}



function cleanShopifyId(value, resourceType) {

  if (!value) {

    return "";

  }



  const stringValue = String(value).trim();



  if (!stringValue) {

    return "";

  }



  const gidPrefix = `gid://shopify/${resourceType}/`;



  if (stringValue.startsWith(gidPrefix)) {

    return stringValue.replace(gidPrefix, "");

  }



  return stringValue;

}



function normalizeWebsiteUrl(value) {

  if (!value) {

    return "";

  }



  const website = String(value).trim();



  if (!website) {

    return "";

  }



  if (/^https?:\/\//i.test(website)) {

    return website;

  }



  return `https://${website}`;

}



function formatDate(value) {

  if (!value) {

    return "—";

  }



  const date = new Date(value);



  if (Number.isNaN(date.getTime())) {

    return String(value);

  }



  return new Intl.DateTimeFormat(undefined, {

    year: "numeric",

    month: "short",

    day: "numeric",

  }).format(date);

}



function formatBoolean(value) {

  return value === true || value === "true";

}





/* ==========================================================================

   Main Page

   ========================================================================== */



export default function DistributorDetailPage() {

  const {

    application,

    company: initialCompany,

    paymentTermsTemplates = [],

    catalogs = [],

    assignedCatalogId = "",

    assignedCatalogTitle = "",

    addressDetails = {},

    shop = "",

  } = useLoaderData();

  const params = useParams();

  const navigate = useNavigate();

  const fetcher = useFetcher();

  const shopify = useAppBridge();



  const company = fetcher.data?.company || initialCompany;



  const initialStatus = normalizeStatus(application?.status);

  const [status, setStatus] = useState(initialStatus);

  const [rejectionMessage, setRejectionMessage] = useState(

    application?.rejection_message || "",

  );

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);



  const isSubmitting = fetcher.state !== "idle";

  const currentStatus = normalizeStatus(status);



  const isPending = currentStatus === APPLICATION_STATUSES.PENDING;

  const isApproved = currentStatus === APPLICATION_STATUSES.APPROVED;

  const isRejected = currentStatus === APPLICATION_STATUSES.REJECTED;



  const currentRejectionMessage =

    fetcher.data?.success &&

      fetcher.data?.status === APPLICATION_STATUSES.REJECTED

      ? fetcher.data?.rejectionMessage || ""

      : rejectionMessage;



  const customerId = fetcher.data?.success

    ? fetcher.data?.customerId || application?.customer_id || ""

    : application?.customer_id || "";



  const companyId = fetcher.data?.success

    ? fetcher.data?.companyId || application?.company_id || ""

    : application?.company_id || "";



  const cleanCustomerId = useMemo(

    () => cleanShopifyId(customerId, "Customer"),

    [customerId],

  );



  const cleanCompanyId = useMemo(

    () => cleanShopifyId(companyId, "Company"),

    [companyId],

  );



  const customerAdminUrl = useMemo(() => {

    if (!cleanCustomerId) return null;

    if (shop) return `https://${shop}/admin/customers/${cleanCustomerId}`;

    return `shopify:admin/customers/${cleanCustomerId}`;

  }, [cleanCustomerId, shop]);



  const companyAdminUrl = useMemo(() => {

    if (!cleanCompanyId) return null;

    if (shop) return `https://${shop}/admin/companies/${cleanCompanyId}`;

    return `shopify:admin/companies/${cleanCompanyId}`;

  }, [cleanCompanyId, shop]);



  const websiteUrl = useMemo(

    () => normalizeWebsiteUrl(application?.company_website),

    [application?.company_website],

  );



  const primaryLocation = company?.locations?.edges?.[0]?.node;

  const shippingAddress = primaryLocation?.shippingAddress;

  const assignedPaymentTerms =

    primaryLocation?.buyerExperienceConfiguration?.paymentTermsTemplate;



  const formattedCompanyAddress = shippingAddress

    ? [

      shippingAddress.address1,

      shippingAddress.address2,

      shippingAddress.city,

      shippingAddress.province,

      shippingAddress.zip,

      shippingAddress.country,

    ]

      .filter(Boolean)

      .join(", ")

    : "";



  /* ==========================================================================

     Notifications

     ========================================================================== */



  useEffect(() => {

    if (!fetcher.data) {

      return;

    }



    if (fetcher.data.deleted) {

      shopify?.toast?.show?.("Distributor request removed from Shopify.");

      navigate("/app/distributors", { replace: true });

      return;

    }



    if (fetcher.data.addressSaved) {

      shopify?.toast?.show?.("Address saved to the company in Shopify.");

      return;

    }

    if (fetcher.data.catalogUpdated) {
      const nextCatalogId = fetcher.data.catalogId || "";
      setApprovedCatalogId(nextCatalogId);
      setCatalogChangeId(nextCatalogId);
      shopify?.toast?.show?.(
        fetcher.data.message || "Distributor catalog updated successfully.",
      );
      return;
    }

    if (fetcher.data.catalogRemoved) {
      setApprovedCatalogId("");
      setCatalogChangeId("");
      shopify?.toast?.show?.(
        fetcher.data.message || "Price Tier Catalog removed successfully.",
      );
      return;
    }



    if (fetcher.data.success) {

      const resultStatus = normalizeStatus(fetcher.data.status);

      setStatus(resultStatus);



      if (resultStatus === APPLICATION_STATUSES.APPROVED) {

        setRejectionMessage("");



        const failed = (fetcher.data.onboardingSteps || []).filter((step) => !step.ok);

        shopify?.toast?.show?.(

          failed.length

            ? `Approved, but ${failed.length} setup step${failed.length === 1 ? "" : "s"} need attention.`

            : "Application approved. B2B company, main contact, terms and tier are set up.",

        );

        return;

      }



      if (resultStatus === APPLICATION_STATUSES.REJECTED) {

        setRejectionMessage(fetcher.data.rejectionMessage || "");

        shopify?.toast?.show?.("Application rejected successfully.");

        return;

      }



      shopify?.toast?.show?.("Application updated successfully.");

      return;

    }



    if (fetcher.data.error) {

      shopify?.toast?.show?.(`Error: ${fetcher.data.error}`);

    }

  }, [fetcher.data, shopify, navigate]);



  /* ==========================================================================

     Actions & Form States

     ========================================================================== */



  const [selectedDecision, setSelectedDecision] = useState("approve");

  const [validationError, setValidationError] = useState("");



  const defaultTermsId = useMemo(() => {

    if (!paymentTermsTemplates || paymentTermsTemplates.length === 0) return "";

    const wantsCredit =

      application?.request_credit === "true" || application?.request_credit === true;

    if (wantsCredit) {

      const net30 = paymentTermsTemplates.find(

        (t) =>

          /30/i.test(t.name) ||

          /net_?30/i.test(t.id) ||

          /net_?30/i.test(t.paymentTermsType),

      );

      if (net30) return net30.id;

      const anyNet = paymentTermsTemplates.find(

        (t) => /net/i.test(t.name) || /net/i.test(t.paymentTermsType),

      );

      if (anyNet) return anyNet.id;

    }

    return "";

  }, [application?.request_credit, paymentTermsTemplates]);



  const [selectedPaymentTerms, setSelectedPaymentTerms] = useState(defaultTermsId);



  const [shippingAddress1, setShippingAddress1] = useState(addressDetails?.address1 || "");

  const [shippingAddress2, setShippingAddress2] = useState(addressDetails?.address2 || "");

  const [shippingCity, setShippingCity] = useState(addressDetails?.city || "");

  const [shippingCountry, setShippingCountry] = useState(
    addressDetails?.country || application?.country_based || "",
  );

  const [shippingProvince, setShippingProvince] = useState(addressDetails?.province || "");

  const [shippingProvinceCode, setShippingProvinceCode] = useState(
    addressDetails?.provinceCode || "",
  );

  const [shippingZip, setShippingZip] = useState(addressDetails?.zip || "");

  const [shippingBarangay, setShippingBarangay] = useState(addressDetails?.barangay || "");

  const [shippingPhone, setShippingPhone] = useState(
    addressDetails?.phone || application?.contact_phone || "",
  );

  const [shippingCountryCode, setShippingCountryCode] = useState(
    addressDetails?.countryCode ||
      countryToCode(addressDetails?.country || application?.country_based, "SG"),
  );

  // The country's address layout from Shopify's data: by name, else by code.
  const addressFormat = useMemo(() => {
    if (ADDRESS_FORMATS[shippingCountry]) return { name: shippingCountry, ...ADDRESS_FORMATS[shippingCountry] };
    const entry = Object.entries(ADDRESS_FORMATS).find(([, format]) => format.code === shippingCountryCode);
    return entry ? { name: entry[0], ...entry[1] } : null;
  }, [shippingCountry, shippingCountryCode]);

  const addressRows = addressFormat?.rows || [["address1"], ["address2"], ["city", "province", "zip"]];

  const addressField = (key) => {
    const labels = addressFormat?.labels || {};
    const read = (e) => e?.currentTarget?.value ?? e?.target?.value ?? "";
    if (key === "province") {
      return (
        <s-select
          key={key}
          label={labels.province || "Province"}
          value={shippingProvince}
          required
          onChange={(e) => {
            const name = read(e);
            if (name === shippingProvince) return;
            setShippingProvince(name);
            setShippingProvinceCode(addressFormat?.zones.find((zone) => zone.name === name)?.code || "");
          }}
        >
          <s-option value="" selected={!shippingProvince || undefined}>
            {`Select a ${String(labels.province || "province").toLowerCase()}`}
          </s-option>
          {(addressFormat?.zones || []).map((zone) => (
            <s-option key={zone.code} value={zone.name} selected={zone.name === shippingProvince || undefined}>
              {zone.name}
            </s-option>
          ))}
        </s-select>
      );
    }
    const fields = {
      address1: [labels.address1 || "Address", shippingAddress1, setShippingAddress1],
      address2: [`${labels.address2 || "Apartment, suite, etc"} (optional)`, shippingAddress2, setShippingAddress2],
      barangay: [labels.barangay || "Barangay", shippingBarangay, setShippingBarangay],
      city: [labels.city || "City", shippingCity, setShippingCity],
      zip: [labels.zip || "Postal code", shippingZip, setShippingZip],
    };
    const [label, value, set] = fields[key] || [];
    if (!set) return null;
    return (
      <s-text-field
        key={key}
        label={label}
        value={value}
        required={key !== "address2" || undefined}
        onInput={(e) => set(read(e))}
      />
    );
  };



  // Reported by the action: one row per B2B setup step, so a partial setup is

  // visible rather than looking like plain success.

  const setupSteps = fetcher.data?.onboardingSteps || [];



  const [salesRep, setSalesRep] = useState("");



  const [salesRepEmail, setSalesRepEmail] = useState("");

  const [salesRepPhone, setSalesRepPhone] = useState("");

  const [catalogId, setCatalogId] = useState("");

  const [approvedCatalogId, setApprovedCatalogId] = useState(assignedCatalogId || "");

  const [catalogChangeId, setCatalogChangeId] = useState(assignedCatalogId || "");



  // Every distributor gets a named contact, so approval waits for one.

  const repEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(salesRepEmail.trim());

  const repComplete = Boolean(salesRep.trim()) && repEmailValid;

  // Price Tier Catalog is optional during approval.
  const approvalComplete = repComplete;



  useEffect(() => {

    if (defaultTermsId && !selectedPaymentTerms) {

      setSelectedPaymentTerms(defaultTermsId);

    }

  }, [defaultTermsId, selectedPaymentTerms]);



  const initials = useMemo(() => {

    const name = (application?.contact_person || application?.company_name || "").trim();

    if (!name) return "DA";

    const parts = name.split(/\s+/).filter(Boolean);

    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();

  }, [application?.contact_person, application?.company_name]);



  const handleApprove = () => {

    if (isSubmitting || !isPending || !approvalComplete) {

      return;

    }



    setValidationError("");

    fetcher.submit(

      {

        metaobjectId: application?.id || params?.id || "",

        status: APPLICATION_STATUSES.APPROVED,

        paymentTermsTemplateId: selectedPaymentTerms,

        shippingAddress1,

        shippingAddress2,

        shippingCity,

        shippingCountry,

        shippingProvince,

        shippingProvinceCode,

        shippingZip,

        shippingBarangay,

        shippingPhone,

        shippingCountryCode,

        salesRep,

        salesRepEmail,

        salesRepPhone,

        catalogId,

        rejectionMessage: "",

      },

      {

        method: "post",

      },

    );

  };



  const handleChangeCatalog = () => {
    if (isSubmitting || !isApproved) {
      return;
    }

    // Selecting "No catalog" means remove the current catalog assignment.
    if (!catalogChangeId) {
      if (!approvedCatalogId) {
        return;
      }

      fetcher.submit(
        {
          intent: "remove_catalog",
          metaobjectId: application?.id || params?.id || "",
        },
        {
          method: "post",
        },
      );

      return;
    }

    if (catalogChangeId === approvedCatalogId) {
      return;
    }

    fetcher.submit(
      {
        intent: "update_catalog",
        metaobjectId: application?.id || params?.id || "",
        catalogId: catalogChangeId,
      },
      {
        method: "post",
      },
    );
  };


  const handleRemoveCatalog = () => {
    if (isSubmitting || !isApproved || !approvedCatalogId) {
      return;
    }

    fetcher.submit(
      {
        intent: "remove_catalog",
        metaobjectId: application?.id || params?.id || "",
      },
      {
        method: "post",
      },
    );
  };



  const handleRejectWithValidation = () => {

    const reason = rejectionMessage.trim();



    if (isSubmitting || !isPending) {

      return;

    }



    if (!reason) {

      setValidationError("A reason is required before declining the application.");

      return;

    }



    setValidationError("");

    fetcher.submit(

      {

        metaobjectId: application?.id || params?.id || "",

        status: APPLICATION_STATUSES.REJECTED,

        rejectionMessage: reason,

      },

      {

        method: "post",

      },

    );

  };



  const isDeleting = isSubmitting && fetcher.formData?.get("intent") === "delete";



  const handleConfirmDelete = () => {

    fetcher.submit(

      {

        intent: "delete",

        metaobjectId: application?.id || params?.id || "",

      },

      {

        method: "post",

      },

    );

  };



  /* ==========================================================================

     Render

     ========================================================================== */



  const pageHeading = application?.company_name

    ? `${application.company_name}`

    : "Distributor Application Review";



  const submittedDate =

    application?.submitted_at || formatDate(application?.updatedAt) || "Recent";



  const hasCreditTerms = formatBoolean(application?.request_credit);

  const registeredAddress = normalizeRegisteredAddress(application);

  const formattedRegisteredAddress = formatRegisteredAddress(registeredAddress);



  return (

    <s-page heading={pageHeading} inlineSize="large">

      {/* ----------------------------------------------------------------------

          Breadcrumb

          ---------------------------------------------------------------------- */}

      <s-link slot="breadcrumb-actions" href="/app/distributors">Distributor Applications</s-link>





      <s-stack direction="block" gap="large">

        {/* ----------------------------------------------------------------------

            Top Header Card (Applicant & Status & Actions)

            ---------------------------------------------------------------------- */}

        <s-box

          background="base"

          padding="large"

          borderRadius="base"

          border="small subdued solid"

        >

          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">

            <s-stack direction="inline" gap="base" alignItems="center">

              <s-avatar initials={initials} size="large" />

              <s-stack direction="block" gap="extra-small">

                <s-stack direction="inline" gap="small" alignItems="center">

                  <s-text type="strong">

                    {application?.contact_person || application?.company_name || "Applicant"}

                  </s-text>

                  {application?.company_name && application?.contact_person ? (

                    <s-text color="subdued">({application.company_name})</s-text>

                  ) : null}

                </s-stack>

                <s-stack direction="inline" gap="small" alignItems="center">

                  <s-badge

                    tone={

                      isApproved

                        ? "success"

                        : isRejected

                          ? "critical"

                          : "warning"

                    }

                  >

                    {currentStatus}

                  </s-badge>

                  <s-text color="subdued" type="small">

                    Submitted on {submittedDate}

                  </s-text>

                </s-stack>

              </s-stack>

            </s-stack>



            {/* Delete Request Button */}

            <s-button

              variant="secondary"

              tone="critical"

              onClick={() => setShowDeleteConfirm((prev) => !prev)}

              disabled={isSubmitting}

            >

              {isDeleting ? "Deleting..." : "Delete request"}

            </s-button>

          </s-stack>

        </s-box>



        {/* Delete Confirmation Banner */}

        {showDeleteConfirm && (

          <s-banner tone="critical" heading="Delete Distributor Request">

            <s-stack direction="block" gap="small">

              <s-paragraph>

                Are you sure you want to delete this distributor application for{" "}

                <strong>{application?.company_name || "this applicant"}</strong>? This will permanently remove the metaobject record from Shopify.

              </s-paragraph>

              <s-stack direction="inline" gap="base">

                <s-button

                  variant="primary"

                  tone="critical"

                  onClick={handleConfirmDelete}

                  disabled={isSubmitting}

                >

                  {isDeleting ? "Deleting from Shopify..." : "Yes, permanently delete"}

                </s-button>

                <s-button

                  variant="secondary"

                  onClick={() => setShowDeleteConfirm(false)}

                  disabled={isSubmitting}

                >

                  Cancel

                </s-button>

              </s-stack>

            </s-stack>

          </s-banner>

        )}



        {/* ----------------------------------------------------------------------

            Main Content: 2-Column Layout

            ---------------------------------------------------------------------- */}

        <s-grid gridTemplateColumns="2fr 1fr" gap="large" alignItems="start">

          {/*&#x20;

            LEFT COLUMN: Application Details

          */}

          <s-stack direction="block" gap="large">

            {/* Card 1: Applicant & Contact Details */}

            <s-box

              background="base"

              padding="large"

              borderRadius="base"

              border="small subdued solid"

            >

              <s-stack direction="block" gap="large">

                <s-text type="strong">Applicant & Contact Details</s-text>



                {/* 2x2 Grid for Basic Info */}

                <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="large">

                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Contact Person

                    </s-text>

                    <s-text>{application?.contact_person || "—"}</s-text>

                  </s-stack>

                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Customer Email

                    </s-text>

                    {application?.customer_email ? (

                      <s-link href={`mailto:${application.customer_email}`}>

                        {application.customer_email}

                      </s-link>

                    ) : (

                      <s-text>—</s-text>

                    )}

                  </s-stack>

                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Company Legal Name

                    </s-text>

                    <s-text>{application?.company_name || "—"}</s-text>

                  </s-stack>

                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Contact Phone

                    </s-text>

                    {application?.contact_phone ? (

                      <s-link href={`tel:${application.contact_phone}`}>

                        {application.contact_phone}

                      </s-link>

                    ) : (

                      <s-text>—</s-text>

                    )}

                  </s-stack>

                </s-grid>



              </s-stack>

            </s-box>



            {/* Card 2: Company & Operating Details */}

            <s-box

              background="base"

              padding="large"

              borderRadius="base"

              border="small subdued solid"

            >

              <s-stack direction="block" gap="large">

                <s-text type="strong">Company & Operating Details</s-text>



                <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="large">

                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Company Website

                    </s-text>

                    {websiteUrl ? (

                      <s-link href={websiteUrl} target="_blank">

                        {application?.company_website} ↗

                      </s-link>

                    ) : (

                      <s-text>—</s-text>

                    )}

                  </s-stack>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Country Based In

                    </s-text>

                    <s-text>{application?.country_based || "Singapore"}</s-text>

                  </s-stack>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Business Type

                    </s-text>

                    <s-text>{application?.business_type || "—"}</s-text>

                  </s-stack>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Relation to the Business

                    </s-text>

                    <s-text>{application?.relation_to_business || "—"}</s-text>

                  </s-stack>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Preferred Currency

                    </s-text>

                    <s-text>{application?.preferred_currency || "—"}</s-text>

                  </s-stack>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Business Registration (UEN)

                    </s-text>

                    <s-text>{application?.registration_number || "—"}</s-text>

                  </s-stack>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Tax Registration Number

                    </s-text>

                    <s-text>{application?.tax_registration_number || "—"}</s-text>

                  </s-stack>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Expected Annual Volume

                    </s-text>

                    <s-text>{application?.expected_annual_volume || "—"}</s-text>

                  </s-stack>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Markets Sold Into

                    </s-text>

                    <s-text>{application?.markets_sold || "Singapore"}</s-text>

                  </s-stack>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Payment Terms Requested

                    </s-text>

                    <div>

                      {hasCreditTerms ? (

                        <s-badge tone="info">Net 30/60 Terms Requested</s-badge>

                      ) : (

                        <s-text color="subdued">Prepayment (Standard)</s-text>

                      )}

                    </div>

                  </s-stack>

                </s-grid>



                <s-stack direction="block" gap="small">
                  <s-text color="subdued" type="small">
                    Registered Business Address
                  </s-text>

                  {registeredAddress?.address1 ? (
                    <s-box padding="base" background="subdued" borderRadius="base">
                      <s-grid
                        gridTemplateColumns="repeat(2, minmax(0, 1fr))"
                        gap="base"
                      >
                        <s-stack direction="block" gap="none">
                          <s-text color="subdued" type="small">Address Line 1</s-text>
                          <s-text>{registeredAddress.address1 || "—"}</s-text>
                        </s-stack>

                        <s-stack direction="block" gap="none">
                          <s-text color="subdued" type="small">Address Line 2</s-text>
                          <s-text>{registeredAddress.address2 || "—"}</s-text>
                        </s-stack>

                        <s-stack direction="block" gap="none">
                          <s-text color="subdued" type="small">City</s-text>
                          <s-text>{registeredAddress.city || "—"}</s-text>
                        </s-stack>

                        <s-stack direction="block" gap="none">
                          <s-text color="subdued" type="small">Country</s-text>
                          <s-text>{registeredAddress.country || "—"}</s-text>
                        </s-stack>

                        <s-stack direction="block" gap="none">
                          <s-text color="subdued" type="small">Province / State</s-text>
                          <s-text>{registeredAddress.province || "—"}</s-text>
                        </s-stack>

                        <s-stack direction="block" gap="none">
                          <s-text color="subdued" type="small">Province / State Code</s-text>
                          <s-text>{registeredAddress.provinceCode || "—"}</s-text>
                        </s-stack>

                        <s-stack direction="block" gap="none">
                          <s-text color="subdued" type="small">ZIP / Postal Code</s-text>
                          <s-text>{registeredAddress.zip || "—"}</s-text>
                        </s-stack>

                        <s-stack direction="block" gap="none">
                          <s-text color="subdued" type="small">Phone</s-text>
                          {registeredAddress.phone ? (
                            <s-link href={`tel:${registeredAddress.phone}`}>
                              {registeredAddress.phone}
                            </s-link>
                          ) : (
                            <s-text>—</s-text>
                          )}
                        </s-stack>
                      </s-grid>
                    </s-box>
                  ) : (
                    <s-text color="subdued">
                      {formattedRegisteredAddress || formattedCompanyAddress || "No registered address provided."}
                    </s-text>
                  )}
                </s-stack>

              </s-stack>

            </s-box>



            {/* Card 3: Supporting Documents */}

            <s-box

              background="base"

              padding="large"

              borderRadius="base"

              border="small subdued solid"

            >

              <s-stack direction="block" gap="base">

                <s-text type="strong">Supporting Documentation</s-text>

                {application?.registration_document_url ? (

                  <s-box padding="small" background="subdued" borderRadius="base">

                    <s-stack

                      direction="inline"

                      gap="base"

                      alignItems="center"

                      justifyContent="space-between"

                    >

                      <s-stack direction="inline" gap="small" alignItems="center">

                        <s-text type="strong">

                          {application.registration_document_name || "Business Registration Document"}

                        </s-text>

                        <s-badge tone="success">Uploaded</s-badge>

                      </s-stack>

                      <s-button

                        variant="secondary"

                        href={application.registration_document_url}

                        target="_blank"

                      >

                        View Document ↗

                      </s-button>

                    </s-stack>

                  </s-box>

                ) : (

                  <s-text color="subdued">

                    No business registration document was uploaded with this application.

                  </s-text>

                )}

              </s-stack>

            </s-box>



            {/* Card 4: Shopify B2B Records (When Approved or Linked) */}

            {(isApproved || cleanCustomerId || cleanCompanyId || company) && (

              <s-box

                background="base"

                padding="large"

                borderRadius="base"

                border="small subdued solid"

              >

                <s-stack direction="block" gap="large">

                  <s-stack direction="inline" gap="small" alignItems="center">

                    <s-text type="strong">Shopify B2B Integration</s-text>

                    <s-badge tone="success">Active</s-badge>

                  </s-stack>



                  <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="large">

                    <s-stack direction="block" gap="none">

                      <s-text color="subdued" type="small">

                        Shopify Customer ID

                      </s-text>

                      {customerAdminUrl ? (

                        <s-link href={customerAdminUrl} target="_blank">

                          {cleanCustomerId} ↗

                        </s-link>

                      ) : (

                        <s-text>{cleanCustomerId || "Not linked"}</s-text>

                      )}

                    </s-stack>



                    <s-stack direction="block" gap="none">

                      <s-text color="subdued" type="small">

                        Shopify Company ID

                      </s-text>

                      {companyAdminUrl ? (

                        <s-link href={companyAdminUrl} target="_blank">

                          {cleanCompanyId} ↗

                        </s-link>

                      ) : (

                        <s-text>{cleanCompanyId || "Not linked"}</s-text>

                      )}

                    </s-stack>



                    {company?.name && (

                      <s-stack direction="block" gap="none">

                        <s-text color="subdued" type="small">

                          Company Name

                        </s-text>

                        {companyAdminUrl ? (

                          <s-link href={companyAdminUrl} target="_blank">

                            {company.name} ↗

                          </s-link>

                        ) : (

                          <s-text>{company.name}</s-text>

                        )}

                      </s-stack>

                    )}



                    {company?.mainContact?.customer && (

                      <s-stack direction="block" gap="none">

                        <s-text color="subdued" type="small">

                          Main Contact

                        </s-text>

                        <s-text>

                          {[company.mainContact.customer.firstName, company.mainContact.customer.lastName].filter(Boolean).join(" ") || "Contact"}{company.mainContact.customer.email ? ` (${company.mainContact.customer.email})` : ""}

                        </s-text>

                      </s-stack>

                    )}



                    {primaryLocation?.name && (

                      <s-stack direction="block" gap="none">

                        <s-text color="subdued" type="small">

                          Primary Location

                        </s-text>

                        <s-text>{primaryLocation.name}</s-text>

                      </s-stack>

                    )}



                    <s-stack direction="block" gap="none">

                      <s-text color="subdued" type="small">

                        Assigned Payment Terms

                      </s-text>

                      <div>

                        {assignedPaymentTerms?.name ? (

                          <s-badge tone="info">{assignedPaymentTerms.name}</s-badge>

                        ) : (

                          <s-text color="subdued">None</s-text>

                        )}

                      </div>

                    </s-stack>

                  </s-grid>



                  <s-stack direction="block" gap="none">

                    <s-text color="subdued" type="small">

                      Company Shipping Address

                    </s-text>

                    {formattedCompanyAddress ? (

                      <s-text>{formattedCompanyAddress}</s-text>

                    ) : !cleanCompanyId ? (

                      // No company yet: approving creates it with this address.

                      <s-text color="subdued">Saved to the company when the application is approved.</s-text>

                    ) : (

                      <s-stack direction="block" gap="small">

                        <s-text tone="critical">No address saved in Shopify, so orders from this company have nowhere to ship.</s-text>

                        {registeredAddress?.address1 && (

                          <s-button

                            disabled={isSubmitting}

                            onClick={() =>

                              fetcher.submit(

                                { intent: "save_location_address", metaobjectId: application?.id || params?.id || "" },

                                { method: "post" },

                              )

                            }

                          >

                            Save address to Shopify

                          </s-button>

                        )}

                      </s-stack>

                    )}

                  </s-stack>

                </s-stack>

              </s-box>

            )}



            {/* Card 5: Decline Details (When Rejected) */}

            {isRejected && (

              <s-box

                background="base"

                padding="large"

                borderRadius="base"

                border="small subdued solid"

              >

                <s-stack direction="block" gap="small">

                  <s-text type="strong" tone="critical">

                    Decline Record

                  </s-text>

                  <s-banner tone="critical" heading="Application Declined">

                    <s-paragraph>

                      <strong>Reason:</strong>{" "}

                      {currentRejectionMessage || "No specific decline reason was recorded."}

                    </s-paragraph>

                  </s-banner>

                </s-stack>

              </s-box>

            )}

          </s-stack>



          {/*&#x20;

            RIGHT COLUMN: Decision & Checklist

          */}

          <s-stack direction="block" gap="large">

            {/* Decision Card */}

            <s-box

              background="base"

              padding="large"

              borderRadius="base"

              border="small subdued solid"

            >

              <s-stack direction="block" gap="large">

                <s-text type="strong">Your Decision</s-text>



                {isPending ? (

                  <>

                    <s-choice-list

                      name="decision"

                      label="Decision"

                      labelAccessibilityVisibility="exclusive"

                      values={[selectedDecision]}

                      onInput={(e) => {

                        const val = e?.currentTarget?.values?.[0] || e?.target?.value;

                        if (val) {

                          setSelectedDecision(val);

                          setValidationError("");

                        }

                      }}

                    >

                      <s-choice value="approve">Approve application</s-choice>

                      <s-choice value="reject">Decline application</s-choice>

                    </s-choice-list>



                    {selectedDecision === "approve" ? (

                      <s-stack direction="block" gap="base">

                        {/* Payment Terms Dropdown as per Shopify */}

                        <s-stack direction="block" gap="extra-small">

                          <s-text type="strong">Payment Terms</s-text>

                          <s-select

                            label="Payment terms"

                            labelAccessibilityVisibility="exclusive"

                            name="paymentTermsTemplateId"

                            value={selectedPaymentTerms}

                            onInput={(e) => {

                              setSelectedPaymentTerms(

                                e?.currentTarget?.value ?? e?.target?.value ?? "",

                              );

                            }}

                          >

                            <s-option value="">None (Due on receipt / Prepayment)</s-option>

                            {paymentTermsTemplates.map((term) => (

                              <s-option key={term.id} value={term.id}>

                                {term.name}{term.dueInDays ? ` (${term.dueInDays} days)` : ""}

                              </s-option>

                            ))}

                          </s-select>

                          <s-text color="subdued" type="small">

                            {selectedPaymentTerms

                              ? "Selected payment terms will be assigned to the company's primary location in Shopify."

                              : "No credit terms selected — distributor must pay upon checkout."}

                          </s-text>

                        </s-stack>



                        {/* Company Shipping Address */}

                        <s-stack direction="block" gap="extra-small">
                          <s-text type="strong">Company Shipping Address</s-text>

                          <s-text color="subdued" type="small">
                            Pre-filled from the distributor&apos;s registered business address. Review before approving.
                          </s-text>

                          {/* Shopify's fields, wording and order for the
                              country, as on the application form (HYV-143). */}
                          <s-select
                            label="Country/region"
                            value={addressFormat?.name || ""}
                            onChange={(e) => {
                              const name = e?.currentTarget?.value ?? e?.target?.value ?? "";
                              // The select can report its own value when the page
                              // loads; only a different country clears the region.
                              if (!name || name === addressFormat?.name) return;
                              setShippingCountry(name);
                              setShippingCountryCode(ADDRESS_FORMATS[name]?.code || "");
                              setShippingProvince("");
                              setShippingProvinceCode("");
                            }}
                          >
                            {!addressFormat ? <s-option value="">Choose a country</s-option> : null}
                            {Object.keys(ADDRESS_FORMATS).map((name) => (
                              <s-option key={name} value={name}>
                                {name}
                              </s-option>
                            ))}
                          </s-select>
                          {addressRows.map((row) => (
                            <s-grid
                              key={row.join("-")}
                              gridTemplateColumns={`repeat(${row.length}, minmax(0, 1fr))`}
                              gap="small"
                            >
                              {row.map((key) => addressField(key))}
                            </s-grid>
                          ))}
                          <s-text-field
                            label="Phone"
                            placeholder="+65 9123 4567"
                            value={shippingPhone}
                            required
                            onInput={(e) =>
                              setShippingPhone(e?.currentTarget?.value ?? e?.target?.value ?? "")
                            }
                          />
                        </s-stack>



                        {/* Sales representative — the portal shows this

                            person and its contact buttons use these details. */}

                        <s-stack direction="block" gap="extra-small">

                          <s-text type="strong">Sales representative (required)</s-text>

                          <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="small">

                            <s-text-field

                              label="Name"

                              placeholder="James Tan"

                              value={salesRep}

                              onInput={(e) => setSalesRep(e?.currentTarget?.value ?? e?.target?.value ?? "")}

                            />

                            <s-text-field

                              label="Email"

                              placeholder="james@hyve.promo"

                              value={salesRepEmail}

                              onInput={(e) => setSalesRepEmail(e?.currentTarget?.value ?? e?.target?.value ?? "")}

                            />

                          </s-grid>

                          <s-text-field

                            label="WhatsApp number (optional)"

                            placeholder="+65 9123 4567"

                            value={salesRepPhone}

                            onInput={(e) => setSalesRepPhone(e?.currentTarget?.value ?? e?.target?.value ?? "")}

                          />

                        </s-stack>

                        {/* Price Tier Catalog is intentionally separate from the sales representative. */}
                        <s-box padding="base" background="subdued" borderRadius="base">
                          <s-stack direction="block" gap="small">
                            <s-stack direction="block" gap="extra-small">
                              <s-text type="strong">Price Tier Catalog</s-text>
                              <s-text color="subdued" type="small">
                                Optional during approval. You can assign, change, or remove the catalog after approval.
                              </s-text>
                            </s-stack>

                            <s-select
                              label="Price Tier Catalog"
                              value={catalogId}
                              onInput={(e) =>
                                setCatalogId(e?.currentTarget?.value ?? e?.target?.value ?? "")
                              }
                            >
                              <s-option value="">No catalog</s-option>
                              {catalogs.map((catalog) => (
                                <s-option key={catalog.id} value={catalog.id}>
                                  {catalog.title}
                                  {catalog.status === "ACTIVE"
                                    ? ""
                                    : ` (${String(catalog.status || "").toLowerCase()})`}
                                </s-option>
                              ))}
                            </s-select>

                            <s-text color="subdued" type="small">
                              {catalogs.length
                                ? `${catalogs.length} Price Tier Catalog${catalogs.length === 1 ? "" : "s"} available.`
                                : "No CompanyLocationCatalog records were found. Approval can still continue without a catalog."}
                            </s-text>
                          </s-stack>
                        </s-box>



                        <s-text-area

                          label="Reviewer note (optional)"

                          placeholder="Add any internal approval notes or remarks..."

                          rows={2}

                          maxLength={500}

                          value={rejectionMessage}

                          onInput={(e) => {

                            setRejectionMessage(e?.currentTarget?.value ?? e?.target?.value ?? "");

                            setValidationError("");

                          }}

                        />



                        {validationError && (

                          <s-banner tone="critical">{validationError}</s-banner>

                        )}



                        <s-paragraph color="subdued" type="small">

                          Approving creates or links the B2B Company, designates the contact as Main Contact, adds the shipping address, and assigns payment terms. If a Price Tier Catalog is selected, it is assigned to every company location.

                        </s-paragraph>



                        {!repComplete && (

                          <s-banner tone="warning">

                            {salesRep.trim() && salesRepEmail.trim() && !repEmailValid

                              ? "That doesn't look like an email address."

                              : "Add the sales representative's name and email to approve."}

                          </s-banner>

                        )}

                        <s-stack direction="inline" gap="base">

                          <s-button

                            variant="primary"

                            onClick={handleApprove}

                            disabled={isSubmitting || !approvalComplete}

                          >

                            {isSubmitting ? "Approving & creating..." : "Approve application"}

                          </s-button>

                          <s-button

                            variant="secondary"

                            tone="critical"

                            onClick={() => {

                              setSelectedDecision("reject");

                              setValidationError("");

                            }}

                            disabled={isSubmitting}

                          >

                            Switch to Decline

                          </s-button>

                        </s-stack>

                      </s-stack>

                    ) : (

                      <s-stack direction="block" gap="base">

                        <s-text-area

                          label="Reason for declining (required)"

                          placeholder="Enter the reason for declining this application..."

                          rows={4}

                          maxLength={500}

                          value={rejectionMessage}

                          onInput={(e) => {

                            setRejectionMessage(e?.currentTarget?.value ?? e?.target?.value ?? "");

                            setValidationError("");

                          }}

                        />



                        {validationError && (

                          <s-banner tone="critical">{validationError}</s-banner>

                        )}



                        <s-paragraph color="subdued" type="small">

                          Declining will set the application status to Rejected and record your reason.

                        </s-paragraph>



                        <s-stack direction="inline" gap="base">

                          <s-button

                            variant="primary"

                            tone="critical"

                            onClick={handleRejectWithValidation}

                            disabled={isSubmitting}

                          >

                            {isSubmitting ? "Declining..." : "Decline application"}

                          </s-button>

                          <s-button

                            variant="secondary"

                            onClick={() => {

                              setSelectedDecision("approve");

                              setValidationError("");

                            }}

                            disabled={isSubmitting}

                          >

                            Switch to Approve

                          </s-button>

                        </s-stack>

                      </s-stack>

                    )}

                  </>

                ) : isApproved ? (

                  <s-stack direction="block" gap="base">

                    {application?.access_removed ? (

                      <s-banner tone="warning" heading="Approved, but access removed">

                        This application was approved, but the applicant is no longer a contact on the company in

                        Shopify, so they can't use the distributor portal. Their application page lets them apply again.

                      </s-banner>

                    ) : (

                      <s-banner tone="success" heading="Application Approved">

                        This application has been approved. The B2B Company, Main Contact, and Payment Terms are active in Shopify.

                      </s-banner>

                    )}



                    <s-box padding="base" background="subdued" borderRadius="base">
                      <s-stack direction="block" gap="base">
                        <s-stack direction="block" gap="extra-small">
                          <s-text type="strong">Price Tier Catalog</s-text>
                          <s-text color="subdued" type="small">
                            {approvedCatalogId
                              ? `Current catalog: ${catalogs.find((catalog) => catalog.id === approvedCatalogId)?.title || assignedCatalogTitle || "Assigned catalog"}`
                              : "No Price Tier Catalog is currently assigned to this distributor."}
                          </s-text>
                        </s-stack>

                        <s-select
                          label="Price Tier Catalog"
                          value={catalogChangeId}
                          disabled={isSubmitting}
                          onInput={(e) =>
                            setCatalogChangeId(
                              e?.currentTarget?.value ?? e?.target?.value ?? "",
                            )
                          }
                        >
                          <s-option value="">No catalog</s-option>
                          {catalogs.map((catalog) => (
                            <s-option key={catalog.id} value={catalog.id}>
                              {catalog.title}
                              {catalog.status === "ACTIVE"
                                ? ""
                                : ` (${String(catalog.status || "").toLowerCase()})`}
                            </s-option>
                          ))}
                        </s-select>

                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-button
                            variant="primary"
                            onClick={handleChangeCatalog}
                            disabled={
                              isSubmitting ||
                              !catalogChangeId ||
                              catalogChangeId === approvedCatalogId
                            }
                          >
                            {isSubmitting && fetcher.formData?.get("intent") === "update_catalog"
                              ? "Updating catalog..."
                              : approvedCatalogId
                                ? "Change catalog"
                                : "Assign catalog"}
                          </s-button>

                          {approvedCatalogId ? (
                            <s-button
                              variant="secondary"
                              tone="critical"
                              onClick={handleRemoveCatalog}
                              disabled={isSubmitting}
                            >
                              {isSubmitting && fetcher.formData?.get("intent") === "remove_catalog"
                                ? "Removing catalog..."
                                : "Remove catalog"}
                            </s-button>
                          ) : null}

                          {catalogChangeId && catalogChangeId === approvedCatalogId ? (
                            <s-badge tone="success">Currently assigned</s-badge>
                          ) : null}
                        </s-stack>

                        <s-text color="subdued" type="small">
                          You can assign a different Price Tier Catalog or remove the current catalog without changing the approved application status.
                        </s-text>
                      </s-stack>
                    </s-box>



                    {setupSteps.length > 0 && (

                      <s-box padding="base" background="subdued" borderRadius="base">

                        <s-stack direction="block" gap="small">

                          <s-text type="strong">B2B setup</s-text>

                          {setupSteps.map((step) => (

                            <s-stack key={step.name} direction="inline" gap="small" alignItems="center">

                              <s-badge tone={step.ok ? "success" : "critical"}>

                                {step.ok ? "Done" : "Check"}

                              </s-badge>

                              <s-text type="strong">{step.name}</s-text>

                              <s-text color="subdued">{step.detail}</s-text>

                            </s-stack>

                          ))}

                        </s-stack>

                      </s-box>

                    )}



                    <s-paragraph color="subdued" type="small">

                      This application is finalized and active in Shopify B2B.

                    </s-paragraph>

                  </s-stack>

                ) : (

                  <s-stack direction="block" gap="small">

                    <s-banner tone="critical" heading="Application Declined">

                      This distributor application has been declined.

                    </s-banner>

                    {currentRejectionMessage && (

                      <s-paragraph color="subdued" type="small">

                        Reason: {currentRejectionMessage}

                      </s-paragraph>

                    )}

                    <s-paragraph color="subdued" type="small">

                      This application is finalized and cannot be modified from this screen.

                    </s-paragraph>

                  </s-stack>

                )}

              </s-stack>

            </s-box>





          </s-stack>

        </s-grid>

      </s-stack>

    </s-page>

  );

}



/* ==========================================================================

   Error Boundary

   ========================================================================== */



export function ErrorBoundary() {

  const error = useRouteError();



  const errorMessage =

    error?.data ||

    error?.message ||

    (typeof error === "string"

      ? error

      : "An unexpected error occurred.");



  return (

    <s-page

      heading="Distributor Application"

      inlineSize="large"

    >

      <s-link

        slot="breadcrumb"

        href="/app/distributors"

      >

        Distributor Applications

      </s-link>



      <s-box

        padding="base"

        background="base"

        borderRadius="base"

      >

        <s-stack

          direction="block"

          gap="base"

        >

          <s-banner

            tone="critical"

            heading="Unable to load application"

          >

            {String(errorMessage)}

          </s-banner>



          <s-box>

            <s-button

              href="/app/distributors"

              variant="primary"

            >

              Return to Distributor Applications

            </s-button>

          </s-box>

        </s-stack>

      </s-box>

    </s-page>

  );

}


