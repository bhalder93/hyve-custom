import { authenticate } from "../shopify.server";

import { accountShell } from "../lib/account-shell.server";

import { portalChrome } from "../lib/account-data.server";

import { distributorPage } from "../lib/account-distributor.server";

import { errorState } from "../lib/account-error.server";

import {
  getCustomerApplication,
  createDistributorApplication,
  withAccessState,
} from "../lib/distributor-metaobject.server";

import { registrationNumberProblem } from "../lib/registration-number.server";

import { validPhone } from "../lib/phone";

import { uploadToShopifyFiles } from "../lib/shopify-files.server";

import { sendApplicationEmails } from "../lib/application-emails.server";

import { supportedCurrencies } from "../lib/store-currencies.server";

import { BUSINESS_TIME_ZONE } from "../lib/portal.server";
import { addressErrors, addressFormatFor, cleanAddress } from "../lib/address-formats.server";


const ADMIN_TIMEOUT_MS = 5000;


/* -------------------------------------------------------------------------- */
/*                                 LOADER                                     */
/* -------------------------------------------------------------------------- */

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
        <div
          style="
            max-width:60rem;
            margin:6rem auto;
            padding:0 2rem;
            text-align:center;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
          "
        >
          <h1
            style="
              font-size:2.2rem;
              font-weight:800;
              color:#0f172a;
            "
          >
            Apply for Distributor Portal
          </h1>

          <p style="color:#64748b;">
            Please sign in to your account to apply for our distributor network.
          </p>

          <a
            href="${loginHref}"
            style="
              display:inline-block;
              margin-top:1rem;
              background:#16a34a;
              color:#fff;
              text-decoration:none;
              font-weight:700;
              padding:0.9rem 1.8rem;
              border-radius:0.7rem;
            "
          >
            Sign in
          </a>
        </div>
      `);
    }


    const { customer } = await fetchCustomerDetails(
      admin,
      customerId,
    );


    // Check if customer has already submitted a distributor application
    // in metaobjects.
    const found = await getCustomerApplication(
      admin,
      customerId,
    );

    const [existingApplication] = found
      ? await withAccessState(admin, [found])
      : [null];


    // Approved, then removed from the company in Shopify (HYV-76):
    // the old approval no longer means anything, so the form shows again.
    const accessEnded = Boolean(
      existingApplication?.access_removed,
    );

    // A declined applicant chose "Apply again": the form shows instead of the
    // decision, and submitting it starts a new application (HYV-143).
    const reapplying =
      url.searchParams.get("reapply") === "1" &&
      String(existingApplication?.status || "").trim().toLowerCase() === "rejected";


    return liquid(
      accountShell({
        active: "distributor",

        main: distributorPage({
          customer,

          application: accessEnded || reapplying
            ? null
            : existingApplication,

          notice:
            notice ||
            (
              accessEnded
                ? "Your distributor access has ended. You can apply again below, or contact us if you think this is a mistake."
                : null
            ),

          error: errorParam,

          currencies: await supportedCurrencies(admin),
        }),

        customer,

        ...(
          await portalChrome(
            admin,
            new URL(request.url).searchParams.get(
              "logged_in_customer_id",
            ),
          )
        ),
      }),
    );
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error(
      "[account] distributor loader failed",
      error,
    );


    return liquid(
      accountShell({
        active: "distributor",

        main: errorState({
          heading:
            "We couldn't load the distributor page",

          retryHref:
            "/apps/account/distributor",
        }),

        ...(
          await portalChrome(
            admin,
            new URL(request.url).searchParams.get(
              "logged_in_customer_id",
            ),
          )
        ),
      }),
    );
  }
};


/* -------------------------------------------------------------------------- */
/*                                  ACTION                                    */
/* -------------------------------------------------------------------------- */

export const action = async ({ request }) => {
  const { liquid, admin } =
    await authenticate.public.appProxy(request);


  const url = new URL(request.url);

  const customerId =
    url.searchParams.get("logged_in_customer_id");


  const isAjax =
    request.headers
      .get("accept")
      ?.includes("application/json") ||
    request.headers.get("x-requested-with") ===
      "XMLHttpRequest";


  /* ------------------------------------------------------------------------ */
  /*                            Authentication                                */
  /* ------------------------------------------------------------------------ */

  if (!customerId) {
    if (isAjax) {
      return Response.json(
        {
          success: false,
          error: "Customer not authenticated",
        },
        {
          status: 401,
        },
      );
    }


    return new Response(null, {
      status: 302,

      headers: {
        Location:
          "/customer_authentication/login?return_to=" +
          encodeURIComponent(
            "/apps/account/distributor",
          ),
      },
    });
  }


  const gidCustomerId =
    customerId.startsWith("gid://")
      ? customerId
      : `gid://shopify/Customer/${customerId}`;


  try {
    const formData =
      await request.formData();

    const intent = String(
      formData.get("intent") || "",
    ).trim();


    if (intent === "applyDistributor") {
      /* -------------------------------------------------------------------- */
      /*                        Basic application fields                       */
      /* -------------------------------------------------------------------- */

      const companyName = String(
        formData.get("companyName") || "",
      ).trim();


      // Typed without https:// is accepted; it's added so the record links (HYV-146).
      const typedWebsite = String(
        formData.get("companyWebsite") || "",
      ).trim();

      const companyWebsite =
        typedWebsite && !/^https?:\/\//i.test(typedWebsite)
          ? `https://${typedWebsite}`
          : typedWebsite;


      const contactPerson = String(
        formData.get("contactPerson") || "",
      ).trim();


      const contactPhone = String(
        formData.get("contactPhone") || "",
      ).trim();


      const countryBased = String(
        formData.get("countryBased") ||
          "Singapore",
      ).trim();


      const businessType = String(
        formData.get("businessType") || "",
      ).trim();


      const relationToBusiness = String(
        formData.get("relationToBusiness") ||
          "",
      ).trim();


      const preferredCurrency = String(
        formData.get("preferredCurrency") ||
          "",
      ).trim();


      const marketsArray =
        formData.getAll("markets");


      const marketsSold =
        marketsArray.length
          ? marketsArray
              .map(String)
              .join(", ")
          : "Singapore";


      const requestCredit =
        formData.get("requestCredit") ===
        "true";


      const registrationNumber = String(
        formData.get("registrationNumber") ||
          "",
      ).trim();


      const taxRegistrationNumber = String(
        formData.get(
          "taxRegistrationNumber",
        ) || "",
      ).trim();


      const expectedVolume = String(
        formData.get("expectedVolume") || "",
      ).trim();


      /* -------------------------------------------------------------------- */
      /*                      Structured Registered Address                    */
      /* -------------------------------------------------------------------- */

      // Only the fields Shopify has for the address's country, with the
      // region's Shopify code (HYV-143).
      const registeredAddress = cleanAddress({
        barangay: String(
          formData.get(
            "registeredAddress.barangay",
          ) || "",
        ).trim(),

        address1: String(
          formData.get(
            "registeredAddress.address1",
          ) || "",
        ).trim(),

        address2: String(
          formData.get(
            "registeredAddress.address2",
          ) || "",
        ).trim(),

        city: String(
          formData.get(
            "registeredAddress.city",
          ) || "",
        ).trim(),

        country: String(
          formData.get(
            "registeredAddress.country",
          ) || "",
        ).trim(),

        province: String(
          formData.get(
            "registeredAddress.province",
          ) || "",
        ).trim(),

        provinceCode: String(
          formData.get(
            "registeredAddress.provinceCode",
          ) || "",
        ).trim(),

        zip: String(
          formData.get(
            "registeredAddress.zip",
          ) || "",
        ).trim(),

        phone: String(
          formData.get(
            "registeredAddress.phone",
          ) || "",
        ).trim(),
      });


      /* -------------------------------------------------------------------- */
      /*                    Server-side Address Validation                     */
      /* -------------------------------------------------------------------- */

      // The address is asked for with credit terms, so it's checked then.
      const addressValidation =
        validateRegisteredAddress(
          registeredAddress,
          requestCredit,
        );

      // One registration number per distributor: a second application with
      // the same number used to fail only at approval (HYV-143).
      const registrationProblem =
        await registrationNumberProblem(
          admin,
          registrationNumber,
          { customerId },
        );

      if (registrationProblem) {
        addressValidation.valid = false;
        addressValidation.errors = {
          ...addressValidation.errors,
          registrationNumber: registrationProblem,
        };
      }

      // Approval puts this number on the company address, which Shopify
      // won't save without one, so the application asks for it (HYV-143).
      const phoneProblem = !contactPhone
        ? "Contact phone number is required."
        : validPhone(contactPhone, addressFormatFor(countryBased)?.code)
          ? null
          : `Enter a valid ${countryBased} phone number.`;

      if (phoneProblem) {
        addressValidation.valid = false;
        addressValidation.errors = {
          ...addressValidation.errors,
          contactPhone: phoneProblem,
        };
      }

      const formError = registrationProblem
        ? "Please check your business registration number."
        : phoneProblem && Object.keys(addressValidation.errors).length === 1
          ? "Please enter your contact phone number."
          : "Please complete all required fields.";


      if (!addressValidation.valid) {
        if (isAjax) {
          return Response.json(
            {
              success: false,

              error:
                formError,

              fieldErrors:
                addressValidation.errors,
            },
            {
              status: 400,
            },
          );
        }


        const { customer } =
          await fetchCustomerDetails(
            admin,
            customerId,
          );


        return liquid(
          accountShell({
            active: "distributor",

            main: distributorPage({
              customer,

              error:
                formError,

              values: {
                companyName,

                companyWebsite,

                contactPerson,

                contactPhone,

                countryBased,

                businessType,

                relationToBusiness,

                preferredCurrency,

                markets:
                  marketsArray.map(String),

                requestCredit,

                registrationNumber,

                taxRegistrationNumber,

                expectedVolume,

                registeredAddress,
              },

              fieldErrors:
                addressValidation.errors,

              currencies:
                await supportedCurrencies(
                  admin,
                ),
            }),

            customer,

            ...(
              await portalChrome(
                admin,
                customerId,
              )
            ),
          }),
        );
      }


      /*
       * Shopify JSON metaobject fields expect the value
       * to be sent as a JSON encoded string.
       */
      const registeredAddressJson =
        JSON.stringify(
          registeredAddress,
        );


      /* -------------------------------------------------------------------- */
      /*                     Registration document upload                      */
      /* -------------------------------------------------------------------- */

      const docFile =
        formData.get("registrationDoc");

      let registrationDocName = "";

      let registrationDocUrl = "";


      if (
        docFile &&
        typeof docFile === "object" &&
        typeof docFile.arrayBuffer ===
          "function" &&
        docFile.size > 0
      ) {
        registrationDocName =
          docFile.name ||
          "Business_Registration_Profile.pdf";


        try {
          const uploadResult =
            await uploadToShopifyFiles(
              admin,
              docFile,
            );


          registrationDocUrl =
            uploadResult.url || "";
        } catch (uploadErr) {
          console.error(
            "[account] Failed to upload document to Shopify Files:",
            uploadErr,
          );
        }
      }


      /* -------------------------------------------------------------------- */
      /*                         Customer details                              */
      /* -------------------------------------------------------------------- */

      const { customer } =
        await fetchCustomerDetails(
          admin,
          customerId,
        );


      const customerEmail =
        customer?.email || "";


      /* -------------------------------------------------------------------- */
      /*                        Create Metaobject                              */
      /* -------------------------------------------------------------------- */

      const result =
        await createDistributorApplication(
          admin,
          {
            companyName,

            companyWebsite,

            contactPerson,

            contactPhone,

            customerId:
              gidCustomerId,

            customerEmail,

            countryBased,

            businessType,

            relationToBusiness,

            preferredCurrency,

            marketsSold,

            requestCredit,

            registrationNumber,

            taxRegistrationNumber,

            expectedVolume,

            // NEW
            // Saved to:
            // metaobjects.app.distributor_application
            // .fields.registered_address_json
            registeredAddressJson,

            registrationDocName,

            registrationDocUrl,
          },
        );


      /* -------------------------------------------------------------------- */
      /*                       Metaobject failure                              */
      /* -------------------------------------------------------------------- */

      if (result.error) {
        console.error(
          "[account] distributor application failed:",
          result.error,
        );


        if (isAjax) {
          return Response.json(
            {
              success: false,

              error:
                "We could not submit your application just now. Please try again.",
            },
            {
              status: 500,
            },
          );
        }


        return liquid(
          accountShell({
            active: "distributor",

            main: distributorPage({
              customer,

              error:
                "We could not submit your application just now. Please try again in a moment, or contact us and we will take the details over email.",

              values: {
                companyName,

                companyWebsite,

                contactPerson,

                contactPhone,

                countryBased,

                businessType,

                relationToBusiness,

                preferredCurrency,

                markets:
                  marketsArray.map(String),

                requestCredit,

                registrationNumber,

                taxRegistrationNumber,

                expectedVolume,

                registeredAddress,
              },

              currencies:
                await supportedCurrencies(
                  admin,
                ),
            }),

            customer,

            ...(
              await portalChrome(
                admin,
                customerId,
              )
            ),
          }),
        );
      }


      /* -------------------------------------------------------------------- */
      /*                              Emails                                  */
      /* -------------------------------------------------------------------- */

      /*
       * Application has already been saved here.
       *
       * Email failure must not undo the application.
       */
      try {
        await sendApplicationEmails(
          admin,
          {
            companyName,

            contactPerson,

            contactPhone,

            customerEmail,

            countryBased,

            businessType,

            relationToBusiness,

            preferredCurrency,

            marketsSold,

            requestCredit,
          },
        );
      } catch (emailError) {
        console.error(
          "[account] distributor application email failed:",
          emailError,
        );
      }


      /* -------------------------------------------------------------------- */
      /*                   Immediate application object                        */
      /* -------------------------------------------------------------------- */

      const submittedApplication = {
        id:
          result.metaobject?.id ||
          `app-${Date.now()}`,

        handle:
          result.metaobject?.handle ||
          `app-${Date.now()}`,

        company_name:
          companyName,

        company_website:
          companyWebsite,

        contact_person:
          contactPerson,

        contact_phone:
          contactPhone,

        customer_id:
          gidCustomerId,

        customer_email:
          customerEmail,

        country_based:
          countryBased,

        business_type:
          businessType,

        relation_to_business:
          relationToBusiness,

        preferred_currency:
          preferredCurrency,

        markets_sold:
          marketsSold,

        request_credit:
          requestCredit
            ? "true"
            : "false",

        registration_number:
          registrationNumber,

        tax_registration_number:
          taxRegistrationNumber,

        expected_annual_volume:
          expectedVolume,

        /*
         * Keep object here so distributorPage can use:
         *
         * application.registered_address_json.address1
         *
         * etc.
         */
        registered_address_json:
          registeredAddress,

        registration_document_name:
          registrationDocName,

        registration_document_url:
          registrationDocUrl,

        status:
          "Pending Review",

        submitted_at:
          new Date().toLocaleDateString(
            "en-SG",
            {
              year: "numeric",

              month: "short",

              day: "numeric",

              timeZone:
                BUSINESS_TIME_ZONE,
            },
          ),
      };


      /* -------------------------------------------------------------------- */
      /*                            AJAX success                               */
      /* -------------------------------------------------------------------- */

      if (isAjax) {
        return Response.json({
          success: true,

          application:
            submittedApplication,

          notice:
            "Your distributor application has been submitted successfully!",
        });
      }


      /* -------------------------------------------------------------------- */
      /*                       HTML success response                           */
      /* -------------------------------------------------------------------- */

      return liquid(
        accountShell({
          active: "distributor",

          main: distributorPage({
            customer,

            application:
              submittedApplication,

            notice:
              "Your distributor application has been submitted successfully!",
          }),

          customer,

          ...(
            await portalChrome(
              admin,
              new URL(
                request.url,
              ).searchParams.get(
                "logged_in_customer_id",
              ),
            )
          ),
        }),
      );
    }


    return respond(
      isAjax,
      {
        error:
          "Invalid intent",
      },
    );
  } catch (err) {
    console.error(
      "[account] distributor action error",
      err,
    );


    return respond(
      isAjax,
      {
        error:
          "Unable to submit application. Please try again.",
      },
    );
  }
};


/* -------------------------------------------------------------------------- */
/*                    REGISTERED ADDRESS VALIDATION                           */
/* -------------------------------------------------------------------------- */

/**
 * The fields Shopify has for the address's country, all required except
 * Apartment, suite, etc., and a region from Shopify's list (HYV-143).
 */
function validateRegisteredAddress(registeredAddress, required) {
  const errors = required ? addressErrors(registeredAddress) : {};
  return { valid: Object.keys(errors).length === 0, errors };
}


/* -------------------------------------------------------------------------- */
/*                      JSON OR REDIRECT RESPONSE                             */
/* -------------------------------------------------------------------------- */

function respond(
  isAjax,
  {
    success = false,
    notice = null,
    error = null,
  },
) {
  if (isAjax) {
    return Response.json({
      success,
      notice,
      error,
    });
  }


  const param = error
    ? `error=${encodeURIComponent(
        error,
      )}`
    : `notice=${encodeURIComponent(
        notice ||
          "Application received",
      )}`;


  return new Response(null, {
    status: 302,

    headers: {
      Location:
        `/apps/account/distributor?${param}`,
    },
  });
}


/* -------------------------------------------------------------------------- */
/*                          CUSTOMER QUERY                                    */
/* -------------------------------------------------------------------------- */

async function fetchCustomerDetails(
  admin,
  customerId,
) {
  if (!admin || !customerId) {
    return {
      customer: null,
    };
  }


  const gid =
    customerId.startsWith("gid://")
      ? customerId
      : `gid://shopify/Customer/${customerId}`;


  try {
    const response =
      await withTimeout(
        admin.graphql(
          `#graphql
          query GetCustomerForDistributor($id: ID!) {
            customer(id: $id) {
              id
              firstName
              lastName
              displayName

              defaultEmailAddress {
                emailAddress
              }

              phone

              defaultAddress {
                company
                phone
              }
            }
          }
          `,

          {
            variables: {
              id: gid,
            },
          },
        ),

        ADMIN_TIMEOUT_MS,
      );


    const body =
      await response.json();


    const c =
      body?.data?.customer;


    if (!c) {
      return {
        customer: null,
      };
    }


    const first =
      c.firstName || "";

    const last =
      c.lastName || "";

    const name =
      c.displayName ||
      `${first} ${last}`.trim();


    return {
      customer: {
        id:
          c.id,

        name,

        email:
          c.defaultEmailAddress
            ?.emailAddress ||
          "",

        phone:
          c.phone ||
          c.defaultAddress?.phone ||
          "",

        company:
          c.defaultAddress?.company ||
          "",
      },
    };
  } catch (err) {
    console.warn(
      "[account] fetchCustomerDetails threw",
      err?.message || err,
    );


    return {
      customer: null,
    };
  }
}


/* -------------------------------------------------------------------------- */
/*                               TIMEOUT                                      */
/* -------------------------------------------------------------------------- */

function withTimeout(
  promise,
  ms,
) {
  let timer;


  const timeout =
    new Promise(
      (_, reject) => {
        timer =
          setTimeout(
            () =>
              reject(
                new Error(
                  `Admin API timed out after ${ms}ms`,
                ),
              ),

            ms,
          );
      },
    );


  return Promise.race([
    promise,
    timeout,
  ]).finally(
    () =>
      clearTimeout(timer),
  );
}