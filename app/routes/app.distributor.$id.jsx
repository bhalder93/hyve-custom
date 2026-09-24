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
import {
  getDistributorApplicationById,
  updateDistributorApplication,
  deleteDistributorApplication,
} from "../lib/distributor-metaobject.server";
import {
  approveAndCreateB2BCustomer,
  getCompanyDetails,
  getPaymentTermsTemplates,
  parseAddressDetails,
} from "../lib/distributor-b2b.server";

/* ==========================================================================
   Constants
   ========================================================================== */

const APPLICATION_STATUSES = {
  PENDING: "Pending Review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

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

  const application = await getDistributorApplicationById(admin, id);

  if (!application) {
    throw new Response("Distributor Application Not Found", {
      status: 404,
    });
  }

  let company = null;

  const companyId = application?.company_id;
  const companyName = application?.company_name;

  if (companyId || application?.status === APPLICATION_STATUSES.APPROVED) {
    company = await getCompanyDetails(admin, companyId, companyName);
  }

  const paymentTermsTemplates = await getPaymentTermsTemplates(admin);

  const addressDetails = parseAddressDetails(
    application?.registered_address,
    application?.country_based || "Singapore",
  );

  return {
    application,
    company,
    paymentTermsTemplates,
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
    const shippingProvince = String(formData.get("shippingProvince") || "").trim();
    const shippingZip = String(formData.get("shippingZip") || "").trim();
    const shippingCountryCode = String(formData.get("shippingCountryCode") || "").trim();

    const salesRep = String(formData.get("salesRep") || "").trim();
    const salesRepEmail = String(formData.get("salesRepEmail") || "").trim();
    const salesRepPhone = String(formData.get("salesRepPhone") || "").trim();
    const catalogTitle = String(formData.get("catalogTitle") || "").trim();

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

      // The metafields must exist with the right types before anything is
      // written to them — a value whose type doesn't match is silently rejected.
      const definitions = await ensureCommercialDefinitions(admin);
      onboardingSteps = definitions.steps;

      const structuredAddress = {
        address1: shippingAddress1,
        address2: shippingAddress2,
        city: shippingCity,
        province: shippingProvince,
        zip: shippingZip,
        countryCode: shippingCountryCode,
      };

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

      // The company exists but Shopify refused its location, so the steps below
      // can only report it missing. This says why — usually the address.
      if (b2bResult.locationError) {
        onboardingSteps.push({
          name: "location",
          ok: false,
          detail: `Shopify refused the company location: ${b2bResult.locationError}`,
        });
      }

      // Finish the setup: ordering role, payment terms, tier catalog, sales rep.
      // Each step reports its own outcome so a partial setup is visible.
      const onboarding = await completeB2BOnboarding(admin, b2bResult.companyId, {
        paymentTerms: paymentTermsTemplateId || null,
        catalogTitle: catalogTitle || null,
        salesRep,
        salesRepEmail,
        salesRepPhone: salesRepPhone || null,
        taxRegistrationNumber: application?.tax_registration_number || null,
      });
      onboardingSteps = onboardingSteps.concat(onboarding.steps);

      const formattedAddr = [
        shippingAddress1,
        shippingAddress2,
        shippingCity,
        shippingProvince,
        shippingZip,
        shippingCountryCode,
      ]
        .filter(Boolean)
        .join(", ");

      if (formattedAddr) {
        updates.registered_address = formattedAddr;
      }

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
    : application?.registered_address || "—";

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
  const [shippingCity, setShippingCity] = useState(addressDetails?.city || "Singapore");
  const [shippingProvince, setShippingProvince] = useState(addressDetails?.province || "");
  const [shippingZip, setShippingZip] = useState(addressDetails?.zip || "");
  const [shippingCountryCode, setShippingCountryCode] = useState(addressDetails?.countryCode || "SG");

  // Reported by the action: one row per B2B setup step, so a partial setup is
  // visible rather than looking like plain success.
  const setupSteps = fetcher.data?.onboardingSteps || [];

  const [salesRep, setSalesRep] = useState("");

  const [salesRepEmail, setSalesRepEmail] = useState("");
  const [salesRepPhone, setSalesRepPhone] = useState("");
  const [catalogTitle, setCatalogTitle] = useState("");

  // Every distributor gets a named contact, so approval waits for one.
  const repEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(salesRepEmail.trim());
  const repComplete = Boolean(salesRep.trim()) && repEmailValid;

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
    if (isSubmitting || !isPending || !repComplete) {
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
        shippingProvince,
        shippingZip,
        shippingCountryCode,
        salesRep,
        salesRepEmail,
        salesRepPhone,
        catalogTitle,
        rejectionMessage: "",
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
          {/* 
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

                <s-stack direction="block" gap="none">
                  <s-text color="subdued" type="small">
                    Registered Business Address
                  </s-text>
                  <s-text>
                    {application?.registered_address || formattedCompanyAddress || "—"}
                  </s-text>
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
                          <s-text color="subdued">Due on Receipt / Prepayment</s-text>
                        )}
                      </div>
                    </s-stack>
                  </s-grid>

                  {formattedCompanyAddress && formattedCompanyAddress !== "—" && (
                    <s-stack direction="block" gap="none">
                      <s-text color="subdued" type="small">
                        Company Shipping Address
                      </s-text>
                      <s-text>{formattedCompanyAddress}</s-text>
                    </s-stack>
                  )}
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

          {/* 
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

                        {/* Company Shipping Address in Shopify Required Format */}
                        <s-stack direction="block" gap="extra-small">
                          <s-text type="strong">Company Shipping Address</s-text>
                        
                          <s-text-field
                            label="Address Line 1"
                            placeholder="Street address (e.g. 123 Orchard Road)"
                            value={shippingAddress1}
                            onInput={(e) => setShippingAddress1(e?.currentTarget?.value ?? e?.target?.value ?? "")}
                          />
                          <s-text-field
                            label="Address Line 2 (optional)"
                            placeholder="Apartment, suite, unit, etc."
                            value={shippingAddress2}
                            onInput={(e) => setShippingAddress2(e?.currentTarget?.value ?? e?.target?.value ?? "")}
                          />
                          <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="small">
                            <s-text-field
                              label="City"
                              placeholder="City (e.g. Singapore)"
                              value={shippingCity}
                              onInput={(e) => setShippingCity(e?.currentTarget?.value ?? e?.target?.value ?? "")}
                            />
                            <s-text-field
                              label="State / Province"
                              placeholder="State or Province"
                              value={shippingProvince}
                              onInput={(e) => setShippingProvince(e?.currentTarget?.value ?? e?.target?.value ?? "")}
                            />
                          </s-grid>
                          <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="small">
                            <s-text-field
                              label="Postal / ZIP Code"
                              placeholder="Postal / ZIP (e.g. 238888)"
                              value={shippingZip}
                              onInput={(e) => setShippingZip(e?.currentTarget?.value ?? e?.target?.value ?? "")}
                            />
                            <s-text-field
                              label="Country Code"
                              placeholder="2-letter ISO code (e.g. SG, US, MY)"
                              value={shippingCountryCode}
                              onInput={(e) => setShippingCountryCode((e?.currentTarget?.value ?? e?.target?.value ?? "").toUpperCase())}
                            />
                          </s-grid>
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
                          <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="small">
                            <s-text-field
                              label="WhatsApp number (optional)"
                              placeholder="+65 9123 4567"
                              value={salesRepPhone}
                              onInput={(e) => setSalesRepPhone(e?.currentTarget?.value ?? e?.target?.value ?? "")}
                            />
                            <s-text-field
                              label="Pricing tier (optional)"
                              placeholder="Gold Member"
                              value={catalogTitle}
                              onInput={(e) => setCatalogTitle(e?.currentTarget?.value ?? e?.target?.value ?? "")}
                            />
                          </s-grid>
                          <s-text color="subdued" type="small">
                            The tier is the B2B catalog to attach. Blank means retail pricing.
                          </s-text>
                        </s-stack>

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
                          Approving creates the B2B Company, designates the contact as Main Contact, adds the shipping address, and assigns payment terms.
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
                            disabled={isSubmitting || !repComplete}
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
                    <s-banner tone="success" heading="Application Approved">
                      This application has been approved. The B2B Company, Main Contact, and Payment Terms are active in Shopify.
                    </s-banner>

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

