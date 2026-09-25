import { authenticate } from "../shopify.server";

import { accountShell } from "../lib/account-shell.server";

import { portalChrome } from "../lib/account-data.server";

import {
  mapCustomerSettings,
  settingsPage,
} from "../lib/account-settings.server";

import { errorState } from "../lib/account-error.server";


const ADMIN_TIMEOUT_MS = 4500;


const E164_PHONE_REGEX = /^\+[1-9]\d{7,14}$/;

export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);

    const customerId = url.searchParams.get("logged_in_customer_id");

    const notice = url.searchParams.get("notice");

    const errorParam = url.searchParams.get("error");

    const loginHref =
      "/customer_authentication/login?return_to=" +
      encodeURIComponent("/apps/account/settings");

    /**
     * Signed out
     */
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
            Account Settings
          </h1>

          <p style="color:#64748b;">
            Please sign in to manage your account settings and preferences.
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

    const {
      customer,
      failed,
      error: customerLoadError,
    } = await fetchCustomerSettings(admin, customerId);


    if (
      customer &&
      (url.searchParams.get("b2b") === "1" ||
        url.searchParams.get("b2b") === "true")
    ) {
      customer.isB2B = true;
    }

    /**
     * Failed to fetch customer settings.
     */
    if (failed) {
      return liquid(
        accountShell({
          active: "settings",

          main: errorState({
            heading: "We couldn't load your settings",

            message:
              customerLoadError ||
              "This is usually temporary. Please try refreshing in a moment.",

            retryHref: "/apps/account/settings",
          }),

          customer,

          ...(await portalChrome(admin, customerId)),
        }),
      );
    }

    const settings = mapCustomerSettings(customer);

    return liquid(
      accountShell({
        active: "settings",

        main: settingsPage({
          settings,

          customer,

          notice,

          error: errorParam,
        }),

        customer,

        ...(await portalChrome(admin, customerId)),
      }),
    );
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error("[account] settings loader failed", error);

    let customerId = null;

    try {
      const url = new URL(request.url);

      customerId = url.searchParams.get("logged_in_customer_id");
    } catch {
      // Ignore URL parsing error here.
    }

    return liquid(
      accountShell({
        active: "settings",

        main: errorState({
          heading: "We couldn't load your settings",

          message:
            error?.message ||
            "An unexpected error occurred while loading your settings.",

          retryHref: "/apps/account/settings",
        }),

        ...(await portalChrome(admin, customerId)),
      }),
    );
  }
};


export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);

  const customerId = url.searchParams.get("logged_in_customer_id");

  const isAjax =
    request.headers.get("accept")?.includes("application/json") ||
    request.headers.get("x-requested-with") === "XMLHttpRequest";
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
          encodeURIComponent("/apps/account/settings"),
      },
    });
  }

  const gidCustomerId = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  try {
    const formData = await request.formData();

    const intent = String(formData.get("intent") || "").trim();

    if (intent === "toggleNotification") {
      const settingKey = String(formData.get("settingKey") || "").trim();

      const allowedSettings = [
        "marketingEmails",
        "emailNotifications",
        "whatsappUpdates",
      ];

 
      if (!allowedSettings.includes(settingKey)) {
        return Response.json(
          {
            success: false,
            settingKey,
            error: "Invalid notification setting.",
          },
          {
            status: 400,
          },
        );
      }

      const isTrue = formData.get("value") === "true";

      const valueStr = isTrue ? "true" : "false";
      if (settingKey === "marketingEmails") {
        const saved = await setMarketingConsent(admin, gidCustomerId, isTrue);

        if (!saved.success) {
          return Response.json(
            {
              success: false,
              settingKey,
              value: isTrue,
              error:
                saved.error || "Failed to update marketing email preference.",
            },
            {
              status: 400,
            },
          );
        }

        return Response.json({
          success: true,
          settingKey,
          value: isTrue,
          error: null,
        });
      }


      const metafieldKey =
        settingKey === "emailNotifications"
          ? "email_notifications"
          : "whatsapp_updates";

      const saved = await setCustomerMetafield(
        admin,
        gidCustomerId,
        metafieldKey,
        "boolean",
        valueStr,
      );

      if (!saved.success) {
        return Response.json(
          {
            success: false,
            settingKey,
            value: isTrue,
            error: saved.error || "Failed to update notification preference.",
          },
          {
            status: 400,
          },
        );
      }

      return Response.json({
        success: true,
        settingKey,
        value: isTrue,
        error: null,
      });
    }


    if (intent === "saveSettings") {
      const fullName = String(formData.get("fullName") || "").trim();

      const company = String(formData.get("company") || "").trim();

      const rawPhone = String(formData.get("phone") || "").trim();

      const whatsappUpdates =
        formData.get("whatsappUpdates") === "true" ? "true" : "false";

      const emailNotifications =
        formData.get("emailNotifications") === "true" ? "true" : "false";

      const marketingEmails = formData.get("marketingEmails") === "true";

      if (!rawPhone) {
        return respond(
          isAjax,
          {
            error: "Phone number is required.",
          },
          400,
        );
      }

      const phone = normalizePhoneNumber(rawPhone);

      /**
       * Check E.164 format.
       */
      if (!isValidE164Phone(phone)) {
        return respond(
          isAjax,
          {
            error:
              "Please enter a valid phone number with country code, for example +919876543210.",
          },
          400,
        );
      }

      const nameParts = fullName.split(/\s+/).filter(Boolean);

      const firstName = nameParts[0] || "";

      const lastName = nameParts.slice(1).join(" ") || "";

      const profileResult = await updateCustomerProfile(admin, gidCustomerId, {
        firstName,
        lastName,
        phone,
      });

      if (!profileResult.success) {
        return respond(
          isAjax,
          {
            error: profileResult.error || "Failed to update customer profile.",
          },
          400,
        );
      }

      const marketingResult = await setMarketingConsent(
        admin,
        gidCustomerId,
        marketingEmails,
      );

      if (!marketingResult.success) {
        return respond(
          isAjax,
          {
            error:
              marketingResult.error ||
              "Profile was updated, but marketing email preference could not be saved.",
          },
          400,
        );
      }
      const metafields = [
        {
          ownerId: gidCustomerId,

          namespace: "custom",

          key: "whatsapp_updates",

          type: "boolean",

          value: whatsappUpdates,
        },

        {
          ownerId: gidCustomerId,

          namespace: "custom",

          key: "email_notifications",

          type: "boolean",

          value: emailNotifications,
        },

        {
          ownerId: gidCustomerId,

          namespace: "custom",

          key: "company",

          type: "single_line_text_field",

          value: company,
        },
      ];

      const metafieldResult = await setCustomerMetafieldsBatch(
        admin,
        metafields,
      );

      if (!metafieldResult.success) {
        return respond(
          isAjax,
          {
            error:
              metafieldResult.error ||
              "Profile was updated, but some settings could not be saved.",
          },
          400,
        );
      }

      return respond(
        isAjax,
        {
          success: true,

          notice: "Settings saved successfully",
        },
        200,
      );
    }
    return respond(
      isAjax,
      {
        error: "Invalid request.",
      },
      400,
    );
  } catch (err) {
    console.error("[account] settings action error", err);

    return respond(
      isAjax,
      {
        error: err?.message || "Failed to update settings. Please try again.",
      },
      500,
    );
  }
};

function respond(
  isAjax,
  { success = false, notice = null, error = null },
  status = 200,
) {
  if (isAjax) {
    return Response.json(
      {
        success,
        notice,
        error,
      },
      {
        status: success ? 200 : status >= 400 ? status : 400,
      },
    );
  }

  const param = error
    ? `error=${encodeURIComponent(error)}`
    : `notice=${encodeURIComponent(notice || "Saved")}`;

  return new Response(null, {
    status: 302,

    headers: {
      Location: `/apps/account/settings?${param}`,
    },
  });
}


function normalizePhoneNumber(phone) {
  let normalized = String(phone || "")
    .trim()
    .replace(/[\s\-().]/g, "");

  if (normalized.startsWith("00")) {
    normalized = `+${normalized.slice(2)}`;
  }

  return normalized;
}

function isValidE164Phone(phone) {
  if (!phone) {
    return false;
  }

  return E164_PHONE_REGEX.test(phone);
}

async function fetchCustomerSettings(admin, customerId) {
  if (!admin || !customerId) {
    return {
      customer: null,

      failed: true,

      error: "Customer information is unavailable.",
    };
  }

  const gid = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
            query CustomerSettings($id: ID!) {
              customer(id: $id) {
                id
                firstName
                lastName
                displayName
                tags

                defaultEmailAddress {
                  emailAddress
                  marketingState
                }

                phone

                companyMetafield: metafield(
                  namespace: "custom"
                  key: "company"
                ) {
                  value
                }

                whatsappMetafield: metafield(
                  namespace: "custom"
                  key: "whatsapp_updates"
                ) {
                  value
                }

                emailNotificationsMetafield: metafield(
                  namespace: "custom"
                  key: "email_notifications"
                ) {
                  value
                }

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

    const body = await response.json();

    const graphqlError = extractGraphQLErrors(body);

    if (graphqlError) {
      console.error("[account] CustomerSettings GraphQL error:", graphqlError);

      return {
        customer: null,

        failed: true,

        error: graphqlError,
      };
    }

    const c = body?.data?.customer;

    if (!c) {
      console.warn(
        "[account] customer settings query returned no customer",
        JSON.stringify(body),
      );

      return {
        customer: null,

        failed: true,

        error: "Customer could not be found.",
      };
    }

    const first = c.firstName || "";

    const last = c.lastName || "";

    const name = c.displayName || `${first} ${last}`.trim();

    const initials =
      ((first[0] || "") + (last[0] || "")).toUpperCase() ||
      (name ? name[0].toUpperCase() : "");

    const tags = c.tags || [];

    const isB2B = tags.some((tag) =>
      /^(b2b|distributor|wholesale|commercial|gold)$/i.test(String(tag).trim()),
    );

    return {
      customer: {
        ...c,

        name: name || c.defaultEmailAddress?.emailAddress || "",

        initials,

        email: c.defaultEmailAddress?.emailAddress || "",

        tags,

        isB2B,
      },

      failed: false,

      error: null,
    };
  } catch (error) {
    console.error("[account] customer settings threw", error);

    return {
      customer: null,

      failed: true,

      error: error?.message || "Failed to load customer settings.",
    };
  }
}


async function updateCustomerProfile(
  admin,
  customerId,
  { firstName, lastName, phone },
) {
  try {

    const normalizedPhone = normalizePhoneNumber(phone);

    if (!normalizedPhone) {
      return {
        success: false,

        error: "Phone number is required.",
      };
    }

    if (!isValidE164Phone(normalizedPhone)) {
      return {
        success: false,

        error:
          "Please enter a valid phone number with country code, for example +919876543210.",
      };
    }

    const input = {
      id: customerId,

      phone: normalizedPhone,
    };

    if (firstName) {
      input.firstName = firstName;
    }

    if (lastName) {
      input.lastName = lastName;
    }

    const response = await withTimeout(
      admin.graphql(
        `#graphql
            mutation CustomerProfileUpdate(
              $input: CustomerInput!
            ) {
              customerUpdate(
                input: $input
              ) {
                customer {
                  id
                  firstName
                  lastName
                  phone
                }

                userErrors {
                  field
                  message
                }
              }
            }
          `,
        {
          variables: {
            input,
          },
        },
      ),

      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();

    const graphqlError = extractGraphQLErrors(body);

    if (graphqlError) {
      console.error("[account] customerUpdate GraphQL error:", graphqlError);

      return {
        success: false,

        error: `Shopify GraphQL error: ${graphqlError}`,
      };
    }

    const userErrors = body?.data?.customerUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      const errorMessage = formatUserErrors(userErrors);

      console.warn("[account] customerUpdate userErrors:", errorMessage);

      return {
        success: false,

        error: errorMessage || "Shopify rejected the customer update.",
      };
    }

    const updatedCustomer = body?.data?.customerUpdate?.customer;

    if (!updatedCustomer) {
      console.error("[account] customerUpdate returned no customer", body);

      return {
        success: false,

        error: "Shopify did not return the updated customer.",
      };
    }

    return {
      success: true,

      customer: updatedCustomer,

      error: null,
    };
  } catch (err) {
    console.error("[account] customerUpdate threw", err);

    return {
      success: false,

      error: err?.message || "Failed to update customer profile.",
    };
  }
}

async function setMarketingConsent(admin, customerId, subscribed) {
  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
            mutation CustomerMarketingConsent(
              $input: CustomerEmailMarketingConsentUpdateInput!
            ) {
              customerEmailMarketingConsentUpdate(
                input: $input
              ) {
                customer {
                  id
                }

                userErrors {
                  field
                  message
                }
              }
            }
          `,
        {
          variables: {
            input: {
              customerId,

              emailMarketingConsent: {
                marketingState: subscribed ? "SUBSCRIBED" : "UNSUBSCRIBED",

                marketingOptInLevel: "SINGLE_OPT_IN",

                consentUpdatedAt: new Date().toISOString(),
              },
            },
          },
        },
      ),

      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();

    const graphqlError = extractGraphQLErrors(body);

    if (graphqlError) {
      console.error("[account] marketing consent GraphQL error:", graphqlError);

      return {
        success: false,

        error: `Shopify GraphQL error: ${graphqlError}`,
      };
    }

    const userErrors =
      body?.data?.customerEmailMarketingConsentUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      const errorMessage = formatUserErrors(userErrors);

      console.warn("[account] marketing consent userErrors:", errorMessage);

      return {
        success: false,

        error: errorMessage || "Unable to update marketing consent.",
      };
    }

    const customer = body?.data?.customerEmailMarketingConsentUpdate?.customer;

    if (!customer) {
      return {
        success: false,

        error: "Shopify did not confirm the marketing consent update.",
      };
    }

    return {
      success: true,

      error: null,
    };
  } catch (err) {
    console.error("[account] marketing consent update threw", err);

    return {
      success: false,

      error: err?.message || "Failed to update marketing consent.",
    };
  }
}

async function setCustomerMetafield(admin, customerId, key, type, value) {
  return setCustomerMetafieldsBatch(admin, [
    {
      ownerId: customerId,

      namespace: "custom",

      key,

      type,

      value,
    },
  ]);
}

async function setCustomerMetafieldsBatch(admin, metafields = []) {
  if (!Array.isArray(metafields) || metafields.length === 0) {
    return {
      success: true,

      error: null,
    };
  }

  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
            mutation CustomerMetafieldsSet(
              $metafields: [MetafieldsSetInput!]!
            ) {
              metafieldsSet(
                metafields: $metafields
              ) {
                metafields {
                  id
                  key
                  namespace
                  value
                }

                userErrors {
                  field
                  message
                }
              }
            }
          `,
        {
          variables: {
            metafields,
          },
        },
      ),

      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();

    const graphqlError = extractGraphQLErrors(body);

    if (graphqlError) {
      console.error("[account] metafieldsSet GraphQL error:", graphqlError);

      return {
        success: false,

        error: `Shopify GraphQL error: ${graphqlError}`,
      };
    }

  
    const userErrors = body?.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length > 0) {
      const errorMessage = formatUserErrors(userErrors);

      console.warn("[account] metafieldsSet userErrors:", errorMessage);

      return {
        success: false,

        error: errorMessage || "Unable to update customer settings.",
      };
    }

    return {
      success: true,

      metafields: body?.data?.metafieldsSet?.metafields || [],

      error: null,
    };
  } catch (err) {
    console.error("[account] metafieldsSet threw", err);

    return {
      success: false,

      error: err?.message || "Failed to save customer settings.",
    };
  }
}

function extractGraphQLErrors(body) {
  if (!Array.isArray(body?.errors) || body.errors.length === 0) {
    return null;
  }

  const messages = body.errors
    .map((error) => {
      if (typeof error === "string") {
        return error;
      }

      return error?.message || JSON.stringify(error);
    })
    .filter(Boolean);

  return messages.join(", ") || "Unknown Shopify GraphQL error.";
}


function formatUserErrors(errors) {
  if (!Array.isArray(errors)) {
    return "";
  }

  return errors
    .map((error) => {
      const message = error?.message || "Unknown error";

      let field = "";

      if (Array.isArray(error?.field)) {
        field = error.field.join(".");
      } else if (error?.field) {
        field = String(error.field);
      }

      if (field) {
        return `${field}: ${message}`;
      }

      return message;
    })
    .filter(Boolean)
    .join(", ");
}

function withTimeout(promise, ms) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Admin API timed out after ${ms}ms`)),
      ms,
    );
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
