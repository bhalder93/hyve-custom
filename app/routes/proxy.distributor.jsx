import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { portalChrome } from "../lib/account-data.server";
import { distributorPage } from "../lib/account-distributor.server";
import { errorState } from "../lib/account-error.server";
import {
  getCustomerApplication,
  createDistributorApplication,
} from "../lib/distributor-metaobject.server";
import { uploadToShopifyFiles } from "../lib/shopify-files.server";

/**
 * Customer Account Portal — Apply for Distributor Portal Route.
 * Storefront: /apps/account/distributor -> <app>/proxy/distributor
 *
 * Implements:
 *   - Application form matching the exact UI design
 *   - Saves submission into Shopify 'distributor_application' metaobject
 *   - If customer already applied, displays the professional "Application Received & Under Review" view
 *   - Responsive on all devices
 */

const ADMIN_TIMEOUT_MS = 5000;

export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const notice = url.searchParams.get("notice");
    const errorParam = url.searchParams.get("error");
    const loginHref =
      "/customer_authentication/login?return_to=" +
      encodeURIComponent("/apps/account/distributor");

    // Signed out -> prompt sign in
    if (!customerId) {
      return liquid(`
        <div style="max-width:60rem;margin:6rem auto;padding:0 2rem;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <h1 style="font-size:2.2rem;font-weight:800;color:#0f172a;">Apply for Distributor Portal</h1>
          <p style="color:#64748b;">Please sign in to your account to apply for our distributor network.</p>
          <a href="${loginHref}" style="display:inline-block;margin-top:1rem;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;padding:0.9rem 1.8rem;border-radius:0.7rem;">Sign in</a>
        </div>
      `);
    }

    const { customer } = await fetchCustomerDetails(admin, customerId);

    // Check if customer has already submitted a distributor application in metaobjects
    const existingApplication = await getCustomerApplication(admin, customerId);

    return liquid(
      accountShell({
        active: "distributor",
        main: distributorPage({
          customer,
          application: existingApplication,
          notice,
          error: errorParam,
        }),
        customer,
      
        ...(await portalChrome(admin, new URL(request.url).searchParams.get("logged_in_customer_id"))),
      }),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[account] distributor loader failed", error);
    return liquid(
      accountShell({
        active: "distributor",
        main: errorState({
          heading: "We couldn't load the distributor page",
          retryHref: "/apps/account/distributor",
        }),
      
        ...(await portalChrome(admin, new URL(request.url).searchParams.get("logged_in_customer_id"))),
      }),
    );
  }
};

export const action = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  const isAjax =
    request.headers.get("accept")?.includes("application/json") ||
    request.headers.get("x-requested-with") === "XMLHttpRequest";

  if (!customerId) {
    if (isAjax) {
      return Response.json({ error: "Customer not authenticated" }, { status: 401 });
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location:
          "/customer_authentication/login?return_to=" +
          encodeURIComponent("/apps/account/distributor"),
      },
    });
  }

  const gidCustomerId = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "").trim();

    if (intent === "applyDistributor") {
      const companyName = String(formData.get("companyName") || "").trim();
      const companyWebsite = String(formData.get("companyWebsite") || "").trim();
      const contactPerson = String(formData.get("contactPerson") || "").trim();
      const contactPhone = String(formData.get("contactPhone") || "").trim();
      const countryBased = String(formData.get("countryBased") || "Singapore").trim();
      const marketsArray = formData.getAll("markets");
      const marketsSold = marketsArray.length ? marketsArray.join(", ") : "Singapore";
      const requestCredit = formData.get("requestCredit") === "true";
      const registrationNumber = String(formData.get("registrationNumber") || "").trim();
      const expectedVolume = String(formData.get("expectedVolume") || "").trim();
      const registeredAddress = String(formData.get("registeredAddress") || "").trim();

      // Handle uploaded business registration profile document -> Save directly in Shopify Files
      const docFile = formData.get("registrationDoc");
      let registrationDocName = "";
      let registrationDocUrl = "";

      if (
        docFile &&
        typeof docFile === "object" &&
        typeof docFile.arrayBuffer === "function" &&
        docFile.size > 0
      ) {
        registrationDocName = docFile.name || "Business_Registration_Profile.pdf";
        try {
          const uploadResult = await uploadToShopifyFiles(admin, docFile);
          registrationDocUrl = uploadResult.url || "";
        } catch (uploadErr) {
          console.error("[account] Failed to upload document to Shopify Files:", uploadErr);
        }
      }

      // Retrieve customer email for the record
      const { customer } = await fetchCustomerDetails(admin, customerId);
      const customerEmail = customer?.email || "";

      // Save application into Shopify Metaobject
      const result = await createDistributorApplication(admin, {
        companyName,
        companyWebsite,
        contactPerson,
        contactPhone,
        customerId: gidCustomerId,
        customerEmail,
        countryBased,
        marketsSold,
        requestCredit,
        registrationNumber,
        expectedVolume,
        registeredAddress,
        registrationDocName,
        registrationDocUrl,
      });

      if (result.error) {
        return respond(isAjax, { error: result.error });
      }

      const submittedApplication = {
        id: result.metaobject?.id || `app-${Date.now()}`,
        handle: result.metaobject?.handle || `app-${Date.now()}`,
        company_name: companyName,
        company_website: companyWebsite,
        contact_person: contactPerson,
        contact_phone: contactPhone,
        customer_id: gidCustomerId,
        customer_email: customerEmail,
        country_based: countryBased,
        markets_sold: marketsSold,
        request_credit: requestCredit ? "true" : "false",
        registration_number: registrationNumber,
        expected_annual_volume: expectedVolume,
        registered_address: registeredAddress,
        registration_document_name: registrationDocName,
        registration_document_url: registrationDocUrl,
        status: "Pending Review",
        submitted_at: new Date().toLocaleDateString("en-SG", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
      };

      if (isAjax) {
        return Response.json({
          success: true,
          application: submittedApplication,
          notice: "Your distributor application has been submitted successfully!",
        });
      }

      // Immediately render the professional evaluation UI
      return liquid(
        accountShell({
          active: "distributor",
          main: distributorPage({
            customer,
            application: submittedApplication,
            notice: "Your distributor application has been submitted successfully!",
          }),
          customer,
        
        ...(await portalChrome(admin, new URL(request.url).searchParams.get("logged_in_customer_id"))),
      }),
      );
    }

    return respond(isAjax, { error: "Invalid intent" });
  } catch (err) {
    console.error("[account] distributor action error", err);
    return respond(isAjax, {
      error: "Unable to submit application. Please try again.",
    });
  }
};

/* ---------- Helper: Respond JSON or Redirect ---------- */
function respond(isAjax, { success = false, notice = null, error = null }) {
  if (isAjax) {
    return Response.json({ success, notice, error });
  }
  const param = error
    ? `error=${encodeURIComponent(error)}`
    : `notice=${encodeURIComponent(notice || "Application received")}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/apps/account/distributor?${param}`,
    },
  });
}

/* ---------- GraphQL: Customer query ---------- */
async function fetchCustomerDetails(admin, customerId) {
  if (!admin || !customerId) return { customer: null };

  const gid = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
        query GetCustomerForDistributor($id: ID!) {
          customer(id: $id) {
            id
            firstName
            lastName
            displayName
            defaultEmailAddress { emailAddress }
            phone
            defaultAddress {
              company
              phone
            }
          }
        }`,
        { variables: { id: gid } },
      ),
      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();
    const c = body?.data?.customer;
    if (!c) return { customer: null };

    const first = c.firstName || "";
    const last = c.lastName || "";
    const name = c.displayName || `${first} ${last}`.trim();

    return {
      customer: {
        id: c.id,
        name,
        email: c.defaultEmailAddress?.emailAddress || "",
        phone: c.phone || c.defaultAddress?.phone || "",
        company: c.defaultAddress?.company || "",
      },
    };
  } catch (err) {
    console.warn("[account] fetchCustomerDetails threw", err?.message || err);
    return { customer: null };
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Admin API timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
