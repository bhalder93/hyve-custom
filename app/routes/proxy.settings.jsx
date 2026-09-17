import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { portalChrome } from "../lib/account-data.server";
import { mapCustomerSettings, settingsPage } from "../lib/account-settings.server";
import { errorState } from "../lib/account-error.server";

/**
 * Customer Account Portal — Account Settings Route.
 * Storefront: /apps/account/settings -> <app>/proxy/settings
 *
 * Implements:
 *   - Profile Information editing (Full Name, Company, Phone)
 *   - Notifications preferences:
 *       * WhatsApp Updates persisted to customer metafield (custom.whatsapp_updates)
 *       * Email Notifications (custom.email_notifications)
 *       * Marketing Emails (custom.marketing_emails)
 *   - Instant async toggle persistence + full form save
 */

const ADMIN_TIMEOUT_MS = 4500;

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

    // Signed out -> prompt sign-in
    if (!customerId) {
      return liquid(`
        <div style="max-width:60rem;margin:6rem auto;padding:0 2rem;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <h1 style="font-size:2.2rem;font-weight:800;color:#0f172a;">Account Settings</h1>
          <p style="color:#64748b;">Please sign in to manage your account settings and preferences.</p>
          <a href="${loginHref}" style="display:inline-block;margin-top:1rem;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;padding:0.9rem 1.8rem;border-radius:0.7rem;">Sign in</a>
        </div>
      `);
    }

    const { customer, failed } = await fetchCustomerSettings(admin, customerId);

    if (customer && (url.searchParams.get("b2b") === "1" || url.searchParams.get("b2b") === "true")) {
      customer.isB2B = true;
    }

    if (failed) {
      return liquid(
        accountShell({
          active: "settings",
          main: errorState({
            heading: "We couldn't load your settings",
            message: "This is usually temporary. Please try refreshing in a moment.",
            retryHref: "/apps/account/settings",
          }),
          customer,
        
        ...(await portalChrome(admin, new URL(request.url).searchParams.get("logged_in_customer_id"))),
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
      
        ...(await portalChrome(admin, new URL(request.url).searchParams.get("logged_in_customer_id"))),
      }),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[account] settings loader failed", error);
    return liquid(
      accountShell({
        active: "settings",
        main: errorState({
          heading: "We couldn't load your settings",
          retryHref: "/apps/account/settings",
        }),
      
        ...(await portalChrome(admin, new URL(request.url).searchParams.get("logged_in_customer_id"))),
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
      return Response.json({ error: "Customer not authenticated" }, { status: 401 });
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

    // 1. Instant toggle update (async from client script)
    if (intent === "toggleNotification") {
      const settingKey = formData.get("settingKey");
      const isTrue = formData.get("value") === "true";
      const valueStr = isTrue ? "true" : "false";

      let metafieldKey = "whatsapp_updates";
      if (settingKey === "emailNotifications") metafieldKey = "email_notifications";
      if (settingKey === "marketingEmails") metafieldKey = "marketing_emails";

      await setCustomerMetafield(admin, gidCustomerId, metafieldKey, "boolean", valueStr);

      return Response.json({ success: true, settingKey, value: isTrue });
    }

    // 2. Full Save Changes form submission
    if (intent === "saveSettings") {
      const fullName = String(formData.get("fullName") || "").trim();
      const company = String(formData.get("company") || "").trim();
      const phone = String(formData.get("phone") || "").trim();
      const whatsappUpdates = formData.get("whatsappUpdates") === "true" ? "true" : "false";
      const emailNotifications = formData.get("emailNotifications") === "true" ? "true" : "false";
      const marketingEmails = formData.get("marketingEmails") === "true" ? "true" : "false";

      // Split full name into first and last
      const nameParts = fullName.split(/\s+/).filter(Boolean);
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      // Update customer basic profile (firstName, lastName, phone)
      await updateCustomerProfile(admin, gidCustomerId, { firstName, lastName, phone });

      // Update customer metafields (including WhatsApp Updates metafield)
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
          key: "marketing_emails",
          type: "boolean",
          value: marketingEmails,
        },
      ];

      if (company) {
        metafields.push({
          ownerId: gidCustomerId,
          namespace: "custom",
          key: "company",
          type: "single_line_text_field",
          value: company,
        });
      }

      await setCustomerMetafieldsBatch(admin, metafields);

      return respond(isAjax, { success: true, notice: "Settings saved successfully" });
    }

    return respond(isAjax, { error: "Invalid intent" });
  } catch (err) {
    console.error("[account] settings action error", err);
    return respond(isAjax, { error: "Failed to update settings. Please try again." });
  }
};

/* ---------- Helper: Respond JSON or Redirect ---------- */
function respond(isAjax, { success = false, notice = null, error = null }) {
  if (isAjax) {
    return Response.json({ success, notice, error });
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

/* ---------- GraphQL: Queries & Mutations ---------- */

async function fetchCustomerSettings(admin, customerId) {
  if (!admin || !customerId) {
    return { customer: null, failed: true };
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
            defaultEmailAddress { emailAddress }
            phone
            companyMetafield: metafield(namespace: "custom", key: "company") { value }
            whatsappMetafield: metafield(namespace: "custom", key: "whatsapp_updates") { value }
            emailNotificationsMetafield: metafield(namespace: "custom", key: "email_notifications") { value }
            marketingEmailsMetafield: metafield(namespace: "custom", key: "marketing_emails") { value }
            emailMarketingConsent { marketingState }
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
    if (!c) {
      console.warn("[account] customer settings query failed", JSON.stringify(body?.errors || body));
      return { customer: null, failed: true };
    }

    const first = c.firstName || "";
    const last = c.lastName || "";
    const name = c.displayName || `${first} ${last}`.trim();
    const initials =
      ((first[0] || "") + (last[0] || "")).toUpperCase() ||
      (name ? name[0].toUpperCase() : "");
    const tags = c.tags || [];
    const isB2B = tags.some((t) =>
      /^(b2b|distributor|wholesale|commercial|gold)$/i.test(t.trim())
    );

    return {
      customer: {
        ...c,
        name: name || "Sarah Mitchell",
        initials,
        email: c.defaultEmailAddress?.emailAddress || "",
        tags,
        isB2B,
      },
      failed: false,
    };
  } catch (error) {
    console.warn("[account] customer settings threw", error?.message || error);
    return { customer: null, failed: true };
  }
}

/**
 * Update basic customer details (name, phone).
 */
async function updateCustomerProfile(admin, customerId, { firstName, lastName, phone }) {
  try {
    const input = { id: customerId };
    if (firstName) input.firstName = firstName;
    if (lastName) input.lastName = lastName;
    // Clean phone number (Shopify requires E.164 e.g. +6591234567)
    if (phone) {
      const cleaned = phone.replace(/[\s\-()]/g, "");
      if (cleaned.startsWith("+")) {
        input.phone = cleaned;
      }
    }

    const response = await withTimeout(
      admin.graphql(
        `#graphql
        mutation CustomerProfileUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer {
              id
              firstName
              lastName
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { input } },
      ),
      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();
    const userErrors = body?.data?.customerUpdate?.userErrors;
    if (userErrors && userErrors.length > 0) {
      console.warn("[account] customerUpdate userErrors", userErrors);
    }
    return { success: true };
  } catch (err) {
    console.warn("[account] customerUpdate threw (non-fatal)", err?.message || err);
    return { success: false };
  }
}

/**
 * Persist a single customer metafield (e.g. custom.whatsapp_updates).
 */
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

/**
 * Persist batch of customer metafields using metafieldsSet.
 */
async function setCustomerMetafieldsBatch(admin, metafields = []) {
  if (!metafields.length) return { success: true };

  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
        mutation CustomerMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { metafields } },
      ),
      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();
    const errors = body?.data?.metafieldsSet?.userErrors;
    if (errors && errors.length > 0) {
      console.warn("[account] metafieldsSet userErrors", errors);
      return { error: errors.map((e) => e.message).join(", ") };
    }

    return { success: true };
  } catch (err) {
    console.error("[account] metafieldsSet threw", err);
    return { error: err?.message || "Failed to set metafields" };
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Admin API timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
