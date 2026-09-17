/**
 * Service to handle B2B Customer & Company creation upon distributor approval.
 */

export const COMPANY_CREATE_MUTATION = `#graphql
mutation CompanyCreate($input: CompanyCreateInput!) {
  companyCreate(input: $input) {
    company {
      id
      name
      externalId
      mainContact {
        id
        customer {
          id
          email
          firstName
          lastName
        }
      }
      contacts(first: 5) {
        edges {
          node {
            id
            customer {
              email
              firstName
              lastName
            }
          }
        }
      }
      contactRoles(first: 5) {
        edges {
          node {
            id
            name
          }
        }
      }
      locations(first: 5) {
        edges {
          node {
            id
            name
            shippingAddress {
              firstName
              lastName
              address1
              city
              province
              zip
              country
            }
          }
        }
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

const COMPANY_FIELDS_FRAGMENT = `#graphql
  id
  name
  externalId
  mainContact {
    id
    customer {
      id
      email
      firstName
      lastName
    }
  }
  contacts(first: 5) {
    edges {
      node {
        id
        customer {
          email
          firstName
          lastName
        }
      }
    }
  }
  contactRoles(first: 5) {
    edges {
      node {
        id
        name
      }
    }
  }
  locations(first: 5) {
    edges {
      node {
        id
        name
        shippingAddress {
          firstName
          lastName
          address1
          city
          province
          zip
          country
        }
      }
    }
  }
`;

/**
 * Fetch complete B2B company details by Company ID or fallback search by name.
 */
export async function getCompanyDetails(admin, companyId, fallbackName = null) {
  if (!admin) return null;

  const gid = companyId && companyId.startsWith("gid://shopify/Company/")
    ? companyId
    : companyId && /^\d+$/.test(companyId)
      ? `gid://shopify/Company/${companyId}`
      : null;

  if (gid) {
    try {
      const res = await admin.graphql(
        `#graphql
        query GetCompanyDetails($id: ID!) {
          company(id: $id) {
            ${COMPANY_FIELDS_FRAGMENT}
          }
        }`,
        { variables: { id: gid } },
      );
      const data = await res.json();
      if (data?.data?.company?.id) {
        return data.data.company;
      }
    } catch (e) {
      console.warn("[b2b] getCompanyDetails query error:", e?.message || e);
    }
  }

  // Fallback search by company name if provided
  if (fallbackName && String(fallbackName).trim()) {
    try {
      const searchRes = await admin.graphql(
        `#graphql
        query FindCompanyByName($query: String!) {
          companies(first: 1, query: $query) {
            nodes {
              ${COMPANY_FIELDS_FRAGMENT}
            }
          }
        }`,
        { variables: { query: `name:${fallbackName.trim()}` } },
      );
      const searchData = await searchRes.json();
      const node = searchData?.data?.companies?.nodes?.[0];
      if (node?.id) {
        return node;
      }
    } catch (e) {
      console.warn("[b2b] findCompanyByName warning:", e?.message || e);
    }
  }

  return null;
}

export const SET_MAIN_CONTACT_MUTATION = `#graphql
mutation SetMainContact($companyId: ID!, $companyContactId: ID!) {
  companyAssignMainContact(companyId: $companyId, companyContactId: $companyContactId) {
    company { id mainContact { id } }
    userErrors { field message code }
  }
}`;

/**
 * Country name to ISO code.
 *
 * The application form collects a country as free text, and Shopify's address
 * input only accepts a two-letter code. This used to be hardcoded to SG, so
 * every distributor's address landed in Singapore whatever they typed.
 */
export function toCountryCode(country) {
  const raw = String(country || "").trim();
  if (!raw) return "SG";
  if (/^[a-zA-Z]{2}$/.test(raw)) return raw.toUpperCase();

  const c = raw.toLowerCase();
  const map = [
    ["singapore", "SG"], ["malaysia", "MY"], ["hong kong", "HK"],
    ["philippines", "PH"], ["thailand", "TH"], ["indonesia", "ID"],
    ["vietnam", "VN"], ["australia", "AU"], ["new zealand", "NZ"],
    ["united states", "US"], ["united kingdom", "GB"], ["china", "CN"],
    ["taiwan", "TW"], ["japan", "JP"], ["korea", "KR"], ["india", "IN"],
  ];
  const hit = map.find(([name]) => c.includes(name));
  return hit ? hit[1] : "SG";
}

/**
 * Turn whatever the form captured into a Shopify company address.
 *
 * Accepts a structured object or the single free-text block the current form
 * collects. Note `zoneCode`, not `province` — CompanyAddressInput uses the
 * former, and sending a field it doesn't have makes Shopify reject the whole
 * request rather than just that field.
 */
export function parseAddressDetails(addressInput, fallbackCountry = "Singapore") {
  if (!addressInput) return null;

  if (typeof addressInput === "object") {
    const address1 = String(addressInput.address1 || "").trim();
    if (!address1) return null;

    const rawZone = String(addressInput.zoneCode || addressInput.province || "").trim();
    const zoneCode = rawZone && rawZone.length <= 4 ? rawZone.toUpperCase() : undefined;

    return {
      address1: address1.substring(0, 250),
      ...(addressInput.address2 ? { address2: String(addressInput.address2).trim().substring(0, 250) } : {}),
      city: String(addressInput.city || "").trim() || "Singapore",
      ...(zoneCode ? { zoneCode } : {}),
      ...(addressInput.zip ? { zip: String(addressInput.zip).trim() } : {}),
      countryCode: toCountryCode(addressInput.countryCode || addressInput.country || fallbackCountry),
    };
  }

  const raw = String(addressInput).trim();
  if (!raw) return null;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parseAddressDetails(parsed, fallbackCountry);
    } catch {
      // Not JSON, fall through to the text parser.
    }
  }

  const countryCode = toCountryCode(fallbackCountry);
  const zip = raw.match(/\b\d{5,6}\b/);
  const parts = raw.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;

  return {
    address1: (parts[0] || raw).substring(0, 250),
    city: parts.length > 1
      ? parts[parts.length - 1].replace(/\b\d{5,6}\b/, "").trim() || "Singapore"
      : "Singapore",
    countryCode,
    ...(zip ? { zip: zip[0] } : {}),
  };
}

/**
 * Shopify only accepts a limited character set in `externalId`, and a rejected
 * value fails the whole company creation rather than being ignored.
 */
export function cleanExternalId(value) {
  const raw = String(value || "").trim();
  if (!raw || ["—", "-", "n/a", "undefined", "null"].includes(raw.toLowerCase())) return null;
  const safe = raw.replace(/[^\w!@#$%^&*(){}[\]\\/?<>~,.;:'"`-]/g, "").trim();
  return safe ? safe.substring(0, 255) : null;
}

/**
 * The store's payment terms templates, for the approval screen's dropdown.
 *
 * Returns an empty list when the store has none. It deliberately doesn't invent
 * template IDs — a guessed ID is accepted by the form and then rejected by
 * Shopify, which is worse than an empty dropdown that says so.
 */
export async function getPaymentTermsTemplates(admin) {
  if (!admin) return [];
  try {
    const response = await admin.graphql(`#graphql
      query PaymentTermsTemplates {
        paymentTermsTemplates { id name description paymentTermsType dueInDays }
      }`);
    const body = await response.json();
    const list = body?.data?.paymentTermsTemplates;
    if (Array.isArray(list)) return list.filter(Boolean);
    if (Array.isArray(list?.edges)) return list.edges.map((e) => e.node).filter(Boolean);
  } catch (err) {
    console.warn("[b2b] payment terms templates query failed:", err?.message || err);
  }
  return [];
}

/** True when the approval screen actually supplied a street address. */
function hasAddress(value) {
  return Boolean(value && typeof value === "object" && String(value.address1 || "").trim());
}

/** A one-line version of an address, for the notes written on the records. */
function addressAsText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return [value.address1, value.address2, value.city, value.province, value.zip, value.countryCode || value.country]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

/** Finds the company contact row for a customer, when assignment didn't return it. */
async function findCompanyContact(admin, companyGid, customerGid) {
  try {
    const response = await admin.graphql(
      `#graphql
      query CompanyContactForCustomer($companyId: ID!) {
        company(id: $companyId) {
          contacts(first: 20) { nodes { id customer { id } } }
        }
      }`,
      { variables: { companyId: companyGid } },
    );
    const body = await response.json();
    const nodes = body?.data?.company?.contacts?.nodes || [];
    const match = nodes.find((n) => n.customer?.id === customerGid) || nodes[0];
    return match?.id || null;
  } catch (err) {
    console.warn("[b2b] company contact lookup failed:", err?.message || err);
    return null;
  }
}

/**
 * Main service to create B2B Company & Customer upon distributor approval.
 */
export async function approveAndCreateB2BCustomer(admin, application, options = {}) {
  if (!admin || !application) {
    return { error: "Missing admin client or application data" };
  }

  const email = (application.customer_email || "").trim();
  const contactName = (application.contact_person || "").trim();
  const companyName = (application.company_name || "").trim() || "Distributor Partner";
  const phone = (application.contact_phone || "").trim();
  const registrationNumber = (application.registration_number || "").trim();
  const country = (application.country_based || "Singapore").trim();
  // Staff can correct the address on the approval screen; the applicant's own
  // free-text entry is the fallback.
  const addressSource = hasAddress(options.shippingAddress)
    ? options.shippingAddress
    : (application.registered_address || "").trim();
  const address = addressAsText(addressSource);
  const expectedVolume = (application.expected_annual_volume || "").trim();
  const requestCredit =
    application.request_credit === "true" || application.request_credit === true;

  // Split contact name
  let firstName = "";
  let lastName = "";
  if (contactName) {
    const parts = contactName.split(/\s+/);
    firstName = parts[0] || "";
    lastName = parts.slice(1).join(" ") || companyName;
  } else {
    firstName = companyName;
    lastName = "Partner";
  }

  const cleanPhone = phone.replace(/[^0-9+]/g, "");
  const distributorTags = ["b2b", "distributor", "wholesale"];

  let customerGid = null;
  let existingTags = [];

  // =========================================================================
  // 1. Locate or Create Customer in Shopify
  // =========================================================================

  const rawCustId = (application.customer_id || "").trim();
  if (
    rawCustId &&
    rawCustId !== "undefined" &&
    rawCustId !== "null" &&
    rawCustId !== "—"
  ) {
    customerGid = rawCustId.startsWith("gid://")
      ? rawCustId
      : `gid://shopify/Customer/${rawCustId}`;
  }

  if (!customerGid && email) {
    try {
      const searchRes = await admin.graphql(
        `#graphql
        query FindCustomerByEmail($query: String!) {
          customers(first: 1, query: $query) {
            nodes {
              id
              email
              tags
            }
          }
        }`,
        { variables: { query: `email:${email}` } },
      );
      const searchData = await searchRes.json();
      const node = searchData?.data?.customers?.nodes?.[0];
      if (node?.id) {
        customerGid = node.id;
        existingTags = node.tags || [];
      }
    } catch (e) {
      console.warn("[b2b] Search customer by email warning:", e?.message || e);
    }
  }

  if (customerGid) {
    // Update existing customer tags to include b2b, distributor, wholesale
    try {
      if (existingTags.length === 0) {
        const custRes = await admin.graphql(
          `#graphql
          query GetCustomerTags($id: ID!) {
            customer(id: $id) {
              id
              tags
            }
          }`,
          { variables: { id: customerGid } },
        );
        const custData = await custRes.json();
        existingTags = custData?.data?.customer?.tags || [];
      }

      const mergedTags = Array.from(new Set([...existingTags, ...distributorTags]));

      const updateInput = {
        id: customerGid,
        tags: mergedTags,
        note: `Approved B2B Distributor. Company: ${companyName}. UEN: ${registrationNumber || "—"}. Credit: ${requestCredit ? "Net 30/60" : "Prepayment"}. Volume: ${expectedVolume || "—"}`,
      };

      if (address || companyName) {
        updateInput.addresses = [
          {
            address1: (address || "Business Address").substring(0, 250),
            company: companyName,
            country: country || "Singapore",
            firstName,
            lastName,
          },
        ];
      }

      const updateRes = await admin.graphql(
        `#graphql
        mutation UpdateDistributorCustomer($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer {
              id
              tags
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { input: updateInput } },
      );

      const updateData = await updateRes.json();
      const uErrors = updateData?.data?.customerUpdate?.userErrors;
      if (uErrors && uErrors.length > 0) {
        await admin.graphql(
          `#graphql
          mutation FallbackCustomerTags($input: CustomerInput!) {
            customerUpdate(input: $input) {
              customer { id }
            }
          }`,
          { variables: { input: { id: customerGid, tags: mergedTags } } },
        );
      }
    } catch (e) {
      console.warn("[b2b] customerUpdate warning:", e?.message || e);
    }
  } else if (email) {
    // Create new Customer in Shopify
    try {
      const createInput = {
        email,
        firstName,
        lastName,
        tags: distributorTags,
        note: `Approved B2B Distributor Partner.\nCompany: ${companyName}\nUEN: ${registrationNumber || "—"}\nCredit: ${requestCredit ? "Net 30/60 Requested" : "Prepayment"}\nExpected Volume: ${expectedVolume || "—"}`,
      };

      if (cleanPhone.length >= 7 && cleanPhone.startsWith("+")) {
        createInput.phone = cleanPhone;
      }

      if (address || companyName) {
        createInput.addresses = [
          {
            address1: (address || "Business Address").substring(0, 250),
            company: companyName,
            country: country || "Singapore",
            firstName,
            lastName,
          },
        ];
      }

      let createRes = await admin.graphql(
        `#graphql
        mutation CreateB2BCustomer($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer {
              id
              email
              tags
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { input: createInput } },
      );

      let createData = await createRes.json();
      let uErrors = createData?.data?.customerCreate?.userErrors;

      if (uErrors && uErrors.some((e) => e.field?.includes("phone"))) {
        delete createInput.phone;
        createRes = await admin.graphql(
          `#graphql
          mutation RetryCustomerNoPhone($input: CustomerInput!) {
            customerCreate(input: $input) {
              customer { id }
              userErrors { field message }
            }
          }`,
          { variables: { input: createInput } },
        );
        createData = await createRes.json();
        uErrors = createData?.data?.customerCreate?.userErrors;
      }

      if (uErrors && uErrors.some((e) => e.message?.toLowerCase().includes("taken"))) {
        const searchRes = await admin.graphql(
          `#graphql
          query FindExistingCustomer($query: String!) {
            customers(first: 1, query: $query) {
              nodes {
                id
                tags
              }
            }
          }`,
          { variables: { query: `email:${email}` } },
        );
        const searchData = await searchRes.json();
        const existingNode = searchData?.data?.customers?.nodes?.[0];
        if (existingNode?.id) {
          customerGid = existingNode.id;
          const merged = Array.from(new Set([...(existingNode.tags || []), ...distributorTags]));
          await admin.graphql(
            `#graphql
            mutation TagExistingCustomer($input: CustomerInput!) {
              customerUpdate(input: $input) {
                customer { id }
              }
            }`,
            { variables: { input: { id: customerGid, tags: merged } } },
          );
        }
      } else {
        customerGid = createData?.data?.customerCreate?.customer?.id || null;
      }
    } catch (e) {
      console.warn("[b2b] customerCreate warning:", e?.message || e);
    }
  }

  // =========================================================================
  // 2. Create B2B Company with the exact CompanyCreate GraphQL mutation
  // =========================================================================

  let companyGid = null;
  let fullCompany = null;
  let companyContactId = null;
  let companyCreateError = null;
  // The form captures the address as one block, so it's parsed into the fields
  // Shopify's address input actually wants.
  const shippingAddressInput = parseAddressDetails(addressSource, country);

  try {
    // Reuse a company of the same name if one exists, so re-approving doesn't
    // split one business across two companies.
    const existing = await getCompanyDetails(admin, null, companyName);
    if (existing?.id) {
      console.log("[b2b] Reusing existing company:", existing.id);
      fullCompany = existing;
      companyGid = existing.id;
    }

    const companyNote = `Distributor Partner Company.
UEN / Registration: ${registrationNumber || "—"}
Annual Volume: ${expectedVolume || "—"}
Credit Terms: ${requestCredit ? "Net 30/60 Terms Requested" : "Prepayment"}
Website: ${application.company_website || "—"}
Contact: ${contactName || "—"} (${email})
Address: ${address || "—"}`;

    const safeExternalId = cleanExternalId(registrationNumber);

    const companyCreateInput = {
      company: {
        name: companyName,
        ...(safeExternalId ? { externalId: safeExternalId } : {}),
        note: companyNote,
      },
    };

    // Include primary location and address
    if (shippingAddressInput) {
      companyCreateInput.companyLocation = {
        name: "Headquarters",
        billingSameAsShipping: true,
        shippingAddress: {
          ...shippingAddressInput,
          // CompanyAddressInput has no companyName field — the business name
          // goes in `recipient`. Sending companyName made Shopify reject the
          // whole request, which threw before the retry could run.
          recipient: companyName,
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
          ...(cleanPhone.length >= 7 ? { phone: cleanPhone } : {}),
        },
      };
    }

    // Include company contact if email is provided
    if (email) {
      companyCreateInput.companyContact = {
        email,
        firstName: firstName || companyName,
        lastName: lastName || "Distributor",
        title: "Primary Distributor Contact",
      };
    }

    if (!companyGid) {
    console.log("[b2b] Executing CompanyCreate mutation for:", companyName);

    let compRes = await admin.graphql(COMPANY_CREATE_MUTATION, {
      variables: { input: companyCreateInput },
    });

    let compData = await compRes.json();
    let compErrors = compData?.data?.companyCreate?.userErrors || compData?.errors;

    // If initial creation failed (e.g. location address format or companyContact issue), retry with base company input
    if (compErrors && compErrors.length > 0) {
      console.warn("[b2b] CompanyCreate initial userErrors:", JSON.stringify(compErrors));
      companyCreateError = compErrors[0]?.message || null;

      const fallbackInput = {
        company: {
          name: companyName,
          ...(registrationNumber ? { externalId: registrationNumber } : {}),
          note: companyNote,
        },
      };

      compRes = await admin.graphql(COMPANY_CREATE_MUTATION, {
        variables: { input: fallbackInput },
      });
      compData = await compRes.json();

      const retryErrors = compData?.data?.companyCreate?.userErrors || compData?.errors;
      if (retryErrors && retryErrors.length > 0) {
        console.error("[b2b] CompanyCreate retry also failed:", JSON.stringify(retryErrors));
        companyCreateError = retryErrors[0]?.message || "The B2B company could not be created.";
      }
    }

    fullCompany = compData?.data?.companyCreate?.company || fullCompany;
    companyGid = fullCompany?.id || null;
    if (companyGid) companyCreateError = null;
    }

    if (companyGid) {
      console.log("[b2b] CompanyCreate succeeded. Company ID:", companyGid);

      // =====================================================================
      // 3. Ensure Customer is Assigned as Company Contact
      // =====================================================================
      if (customerGid) {
        try {
          const assignRes = await admin.graphql(
            `#graphql
            mutation AssignDistributorContact($companyId: ID!, $customerId: ID!) {
              companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
                companyContact {
                  id
                }
                userErrors {
                  field
                  message
                  code
                }
              }
            }`,
            {
              variables: {
                companyId: companyGid,
                customerId: customerGid,
              },
            },
          );
          const assignData = await assignRes.json();
          const assignErrors =
            assignData?.data?.companyAssignCustomerAsContact?.userErrors;
          if (assignErrors && assignErrors.length > 0) {
            console.warn("[b2b] companyAssignCustomerAsContact note:", assignErrors);
          } else {
            console.log("[b2b] Successfully assigned customer as company contact!");
          }
          companyContactId =
            assignData?.data?.companyAssignCustomerAsContact?.companyContact?.id || null;
        } catch (assignErr) {
          console.warn("[b2b] companyAssignCustomerAsContact error:", assignErr?.message || assignErr);
        }
      }

      // Shopify doesn't always hand the contact back on assignment, and a
      // company with no main contact has nobody to address anything to.
      if (!companyContactId && customerGid) {
        companyContactId = await findCompanyContact(admin, companyGid, customerGid);
      }

      if (companyContactId) {
        try {
          const mainRes = await admin.graphql(SET_MAIN_CONTACT_MUTATION, {
            variables: { companyId: companyGid, companyContactId },
          });
          const mainData = await mainRes.json();
          const mainErrors = mainData?.data?.companyAssignMainContact?.userErrors;
          if (mainErrors && mainErrors.length > 0) {
            console.warn("[b2b] SetMainContact note:", mainErrors);
          } else {
            console.log("[b2b] Main contact set for company:", companyGid);
          }
        } catch (mainErr) {
          console.warn("[b2b] SetMainContact error:", mainErr?.message || mainErr);
        }
      }
    }
  } catch (e) {
    console.error("[b2b] Company creation threw:", e?.message || e);
    companyCreateError = companyCreateError || e?.message || "Company creation failed.";
  }

  // If fullCompany not populated from mutation, fetch fresh details
  if (companyGid && !fullCompany?.locations) {
    fullCompany = await getCompanyDetails(admin, companyGid, companyName);
  }

  return {
    success: true,
    customerId: customerGid,
    companyId: companyGid,
    company: fullCompany,
    // A customer with tags but no company is not a distributor: the portal and
    // the pricing both key off company membership.
    companyError: companyGid ? null : companyCreateError || "No B2B company was created.",
  };
}
