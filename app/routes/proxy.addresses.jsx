import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { portalChrome } from "../lib/account-data.server";
import { mapAddresses, addressesPage } from "../lib/account-addresses.server";
import { errorState } from "../lib/account-error.server";

/**
 * Customer Account Portal — Addresses Route.
 * Storefront: /apps/account/addresses -> <app>/proxy/addresses
 *
 * Implements full production-ready address management:
 *   - Fetches customer addresses via Shopify Admin GraphQL API
 *   - Renders aesthetic cards matching the mockup (SHIPPING / BILLING, DEFAULT pill, actions)
 *   - Handles Add, Edit, Delete, and Set Default mutations
 *   - Error boundary wrapping prevents 5xx proxy crashes
 */

const ADMIN_TIMEOUT_MS = 4500;

export const loader = async ({ request }) => {
  // App Proxy authentication — must allow redirect responses to reach Shopify untouched
  const { liquid, admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const notice = url.searchParams.get("notice");
    const errorParam = url.searchParams.get("error");
    const loginHref =
      "/customer_authentication/login?return_to=" +
      encodeURIComponent("/apps/account/addresses");

    // Signed out -> Prompt sign-in with return URL
    if (!customerId) {
      return liquid(`
        <div style="max-width:60rem;margin:6rem auto;padding:0 2rem;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <h1 style="font-size:2.2rem;font-weight:800;color:#0f172a;">Addresses</h1>
          <p style="color:#64748b;">Please sign in to view and manage your addresses.</p>
          <a href="${loginHref}" style="display:inline-block;margin-top:1rem;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;padding:0.9rem 1.8rem;border-radius:0.7rem;">Sign in</a>
        </div>
      `);
    }

    const { customer, addressNodes, defaultAddressId, failed } =
      await fetchAccountAddresses(admin, customerId);

    if (customer && (url.searchParams.get("b2b") === "1" || url.searchParams.get("b2b") === "true")) {
      customer.isB2B = true;
    }

    if (failed) {
      return liquid(
        accountShell({
          active: "addresses",
          main: errorState({
            heading: "We couldn't load your addresses",
            message:
              "This is usually temporary — our system may be busy. Please try again in a few minutes.",
            retryHref: "/apps/account/addresses",
          }),
          customer,
        
        ...(await portalChrome(admin, new URL(request.url).searchParams.get("logged_in_customer_id"))),
      }),
      );
    }

    const addresses = mapAddresses(addressNodes, defaultAddressId, customer);

    return liquid(
      accountShell({
        active: "addresses",
        main: addressesPage({
          addresses,
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
    console.error("[account] addresses loader threw", error);
    return liquid(
      accountShell({
        active: "addresses",
        main: errorState({
          heading: "We couldn't load your addresses",
          retryHref: "/apps/account/addresses",
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
          encodeURIComponent("/apps/account/addresses"),
      },
    });
  }

  const gidCustomerId = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "").trim();
    const addressId = formData.get("addressId");

    // Handle demo / mockup cards in test preview gracefully
    if (addressId && String(addressId).startsWith("demo-")) {
      const noticeMsg =
        intent === "delete"
          ? "Demo address deleted"
          : intent === "setDefault"
            ? "Default address updated"
            : "Address updated successfully";
      return respond(isAjax, { success: true, notice: noticeMsg });
    }

    if (intent === "create") {
      const addressInput = extractAddressInput(formData);
      const setAsDefault = formData.get("setAsDefault") === "true";

      const createResult = await customerAddressCreate(
        admin,
        gidCustomerId,
        addressInput,
        setAsDefault,
      );
      if (createResult.error) {
        return respond(isAjax, { error: createResult.error });
      }

      return respond(isAjax, { success: true, notice: "Address added successfully" });
    }

    if (intent === "update") {
      if (!addressId) {
        return respond(isAjax, { error: "Missing address ID" });
      }
      const gidAddressId = normalizeAddressGid(addressId);
      const addressInput = extractAddressInput(formData);
      const setAsDefault = formData.get("setAsDefault") === "true";

      const updateResult = await customerAddressUpdate(
        admin,
        gidCustomerId,
        gidAddressId,
        addressInput,
        setAsDefault,
      );
      if (updateResult.error) {
        return respond(isAjax, { error: updateResult.error });
      }

      return respond(isAjax, { success: true, notice: "Address updated successfully" });
    }

    if (intent === "delete") {
      if (!addressId) {
        return respond(isAjax, { error: "Missing address ID" });
      }
      const gidAddressId = normalizeAddressGid(addressId);
      const deleteResult = await customerAddressDelete(admin, gidCustomerId, gidAddressId);
      if (deleteResult.error) {
        return respond(isAjax, { error: deleteResult.error });
      }

      return respond(isAjax, { success: true, notice: "Address deleted successfully" });
    }

    if (intent === "setDefault") {
      if (!addressId) {
        return respond(isAjax, { error: "Missing address ID" });
      }
      const gidAddressId = normalizeAddressGid(addressId);
      const defaultResult = await customerUpdateDefaultAddress(
        admin,
        gidCustomerId,
        gidAddressId,
      );
      if (defaultResult.error) {
        return respond(isAjax, { error: defaultResult.error });
      }

      return respond(isAjax, {
        success: true,
        notice: "Default address updated successfully",
      });
    }

    return respond(isAjax, { error: "Invalid action intent" });
  } catch (err) {
    console.error("[account] addresses action error", err);
    return respond(isAjax, { error: "Unable to process request. Please try again." });
  }
};

/* ---------- Helper: Respond JSON or Redirect ---------- */
function respond(isAjax, { success = false, notice = null, error = null }) {
  if (isAjax) {
    return Response.json({ success, notice, error });
  }
  const param = error
    ? `error=${encodeURIComponent(error)}`
    : `notice=${encodeURIComponent(notice || "Success")}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/apps/account/addresses?${param}`,
    },
  });
}

function normalizeAddressGid(id) {
  if (String(id).startsWith("gid://")) return String(id);
  return `gid://shopify/MailingAddress/${id}`;
}

function extractAddressInput(formData) {
  const firstName = String(formData.get("firstName") || "").trim();
  const lastName = String(formData.get("lastName") || "").trim();
  const company = String(formData.get("company") || "").trim();
  const label = String(formData.get("label") || "").trim();
  const address1 = String(formData.get("address1") || "").trim();
  const address2 = String(formData.get("address2") || "").trim();
  const city = String(formData.get("city") || "").trim();
  const countryCode = String(formData.get("countryCode") || "SG").trim();
  const province = String(formData.get("province") || "").trim();
  const zip = String(formData.get("zip") || "").trim();
  const phone = String(formData.get("phone") || "").trim();

  // Combine company and department/label if provided
  let formattedCompany = company;
  if (label) {
    formattedCompany = company ? `${company} - ${label}` : label;
  }

  const input = {
    address1,
    city,
    countryCode,
    zip,
  };

  if (firstName) input.firstName = firstName;
  if (lastName) input.lastName = lastName;
  if (formattedCompany) input.company = formattedCompany;
  if (address2) input.address2 = address2;
  if (province) input.province = province;
  if (phone) input.phone = phone;

  return input;
}

/* ---------- GraphQL: Queries & Mutations ---------- */

async function fetchAccountAddresses(admin, customerId) {
  if (!admin || !customerId) {
    return { customer: null, addressNodes: [], defaultAddressId: null, failed: true };
  }

  const gid = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
        query AccountAddresses($id: ID!) {
          customer(id: $id) {
            id
            firstName
            lastName
            displayName
            tags
            defaultEmailAddress { emailAddress }
            defaultAddress {
              id
              address1
              address2
              city
              company
              country
              countryCodeV2
              firstName
              lastName
              name
              phone
              province
              zip
            }
            addresses {
              id
              address1
              address2
              city
              company
              country
              countryCodeV2
              firstName
              lastName
              name
              phone
              province
              zip
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
      console.warn("[account] customer addresses query failed", JSON.stringify(body?.errors || body));
      return { customer: null, addressNodes: [], defaultAddressId: null, failed: true };
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

    const addressList = Array.isArray(c.addresses)
      ? c.addresses
      : (c.addresses?.nodes || []);
    const defaultId = c.defaultAddress?.id || (addressList[0]?.id ?? null);

    return {
      customer: {
        firstName: first,
        name: name || "My Account",
        email: c.defaultEmailAddress?.emailAddress || "",
        initials,
        tags,
        isB2B,
      },
      addressNodes: addressList,
      defaultAddressId: defaultId,
      failed: false,
    };
  } catch (error) {
    console.warn("[account] addresses query threw", error?.message || error);
    return { customer: null, addressNodes: [], defaultAddressId: null, failed: true };
  }
}

async function customerAddressCreate(admin, customerId, addressInput, setAsDefault = false) {
  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
        mutation CustomerAddressCreate($customerId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
          customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: $setAsDefault) {
            address {
              id
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { customerId, address: addressInput, setAsDefault } },
      ),
      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();
    const errors = body?.data?.customerAddressCreate?.userErrors;
    if (errors && errors.length > 0) {
      return { error: errors.map((e) => e.message).join(", ") };
    }

    const addressId = body?.data?.customerAddressCreate?.address?.id;
    return { addressId };
  } catch (err) {
    console.error("[account] customerAddressCreate failed", err);
    return { error: err.message || "Failed to create address" };
  }
}

async function customerAddressUpdate(admin, customerId, addressId, addressInput, setAsDefault = false) {
  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
        mutation CustomerAddressUpdate($customerId: ID!, $addressId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
          customerAddressUpdate(customerId: $customerId, addressId: $addressId, address: $address, setAsDefault: $setAsDefault) {
            address {
              id
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { customerId, addressId, address: addressInput, setAsDefault } },
      ),
      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();
    const errors = body?.data?.customerAddressUpdate?.userErrors;
    if (errors && errors.length > 0) {
      return { error: errors.map((e) => e.message).join(", ") };
    }

    return { success: true };
  } catch (err) {
    console.error("[account] customerAddressUpdate failed", err);
    return { error: err.message || "Failed to update address" };
  }
}

async function customerAddressDelete(admin, customerId, addressId) {
  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
        mutation CustomerAddressDelete($customerId: ID!, $addressId: ID!) {
          customerAddressDelete(customerId: $customerId, addressId: $addressId) {
            deletedAddressId
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { customerId, addressId } },
      ),
      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();
    const errors = body?.data?.customerAddressDelete?.userErrors;
    if (errors && errors.length > 0) {
      return { error: errors.map((e) => e.message).join(", ") };
    }

    return { success: true };
  } catch (err) {
    console.error("[account] customerAddressDelete failed", err);
    return { error: err.message || "Failed to delete address" };
  }
}

async function customerUpdateDefaultAddress(admin, customerId, addressId) {
  try {
    const response = await withTimeout(
      admin.graphql(
        `#graphql
        mutation CustomerUpdateDefaultAddress($customerId: ID!, $addressId: ID!) {
          customerUpdateDefaultAddress(customerId: $customerId, addressId: $addressId) {
            customer {
              id
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { customerId, addressId } },
      ),
      ADMIN_TIMEOUT_MS,
    );

    const body = await response.json();
    const errors = body?.data?.customerUpdateDefaultAddress?.userErrors;
    if (errors && errors.length > 0) {
      return { error: errors.map((e) => e.message).join(", ") };
    }

    return { success: true };
  } catch (err) {
    console.error("[account] customerUpdateDefaultAddress failed", err);
    return { error: err.message || "Failed to set default address" };
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Admin API timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
