/**
 * Service to handle B2B Customer & Company creation upon distributor approval.
 */

export const CREATE_DISTRIBUTOR_COMPANY_MUTATION = `#graphql
mutation CreateDistributorCompany($input: CompanyCreateInput!) {
  companyCreate(input: $input) {
    company {
      id
      name
      mainContact {
        id
        customer {
          id
          email
        }
      }
      locations(first: 10) {
        edges {
          node {
            id
            name
            shippingAddress {
              address1
              city
              countryCode
              zip
            }
            buyerExperienceConfiguration {
              paymentTermsTemplate {
                id
                name
              }
            }
          }
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}`;

export const COMPANY_CREATE_MUTATION = CREATE_DISTRIBUTOR_COMPANY_MUTATION;

export const SET_MAIN_CONTACT_MUTATION = `#graphql
mutation SetMainContact($companyId: ID!, $contactId: ID!) {
  companyUpdate(
    id: $companyId
    input: { mainContactId: $contactId }
  ) {
    company {
      id
      mainContact {
        id
      }
    }
    userErrors {
      field
      message
    }
  }
}`;

export const UPDATE_COMPANY_PAYMENT_TERMS_MUTATION = `#graphql
mutation UpdateCompanyPaymentTerms(
  $companyLocationId: ID!
  $paymentTermsTemplateId: ID!
) {
  companyLocationUpdate(
    companyLocationId: $companyLocationId
    input: {
      buyerExperienceConfiguration: {
        paymentTermsTemplateId: $paymentTermsTemplateId
      }
    }
  ) {
    companyLocation {
      id
      buyerExperienceConfiguration {
        paymentTermsTemplate {
          id
          name
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}`;

export const ASSIGN_NET_30_TO_LOCATION_MUTATION = UPDATE_COMPANY_PAYMENT_TERMS_MUTATION;

export const STORE_CREDIT_ACCOUNT_CREDIT_MUTATION = `#graphql
mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
  storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
    storeCreditAccountTransaction {
      amount {
        amount
        currencyCode
      }
      account {
        id
        balance {
          amount
          currencyCode
        }
      }
    }
    userErrors {
      message
      field
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
        buyerExperienceConfiguration {
          paymentTermsTemplate {
            id
            name
            paymentTermsType
            dueInDays
          }
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

/**
 * Helper to convert country names to valid ISO Alpha-2 Country Codes for Shopify.
 */
export function toCountryCode(country) {
  if (!country) return "SG";
  const c = String(country).trim().toLowerCase();
  if (c.includes("singapore") || c === "sg") return "SG";
  if (c.includes("malaysia") || c === "my") return "MY";
  if (c.includes("hong kong") || c === "hk") return "HK";
  if (c.includes("philippines") || c === "ph") return "PH";
  if (c.includes("thailand") || c === "th") return "TH";
  if (c.includes("indonesia") || c === "id") return "ID";
  if (c.includes("vietnam") || c === "vn") return "VN";
  if (c.includes("australia") || c === "au") return "AU";
  if (c.includes("united states") || c === "usa" || c === "us") return "US";
  if (c.includes("united kingdom") || c === "uk" || c === "gb") return "GB";
  if (c.includes("china") || c === "cn") return "CN";
  if (c.includes("taiwan") || c === "tw") return "TW";
  if (c.includes("japan") || c === "jp") return "JP";
  if (c.includes("korea") || c === "kr") return "KR";
  if (/^[a-zA-Z]{2}$/.test(String(country).trim())) return String(country).trim().toUpperCase();
  return "SG";
}

/**
 * Add store credit to a customer account.
 */
export async function addCustomerStoreCredit(admin, customerId, amount, currencyCode = "USD") {
  if (!admin || !customerId || !amount || Number(amount) <= 0) {
    return null;
  }

  const gid = customerId.startsWith("gid://shopify/Customer/")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  const formattedAmount = Number(amount).toFixed(2);

  try {
    const res = await admin.graphql(STORE_CREDIT_ACCOUNT_CREDIT_MUTATION, {
      variables: {
        id: gid,
        creditInput: {
          creditAmount: {
            amount: formattedAmount,
            currencyCode: String(currencyCode || "USD").toUpperCase(),
          },
        },
      },
    });

    const data = await res.json();

    if (data?.errors && data.errors.length > 0) {
      const errorMsg = data.errors.map((e) => e.message).join("; ");
      console.warn("[b2b] storeCreditAccountCredit GraphQL errors:", errorMsg);
      const isScopeError = errorMsg.includes("write_store_credit_account_transactions");
      return {
        success: false,
        isScopeError,
        error: isScopeError
          ? "App requires the `write_store_credit_account_transactions` access scope in Shopify. Please deploy or re-authorize the app with the new scopes."
          : errorMsg,
      };
    }

    const userErrors = data?.data?.storeCreditAccountCredit?.userErrors || [];
    if (userErrors.length > 0) {
      console.warn("[b2b] storeCreditAccountCredit userErrors:", userErrors);
      return {
        success: false,
        error: userErrors.map((e) => e.message).join(", "),
      };
    }

    const tx = data?.data?.storeCreditAccountCredit?.storeCreditAccountTransaction;
    return {
      success: true,
      transaction: tx,
      balance: tx?.account?.balance,
    };
  } catch (err) {
    console.warn("[b2b] storeCreditAccountCredit error:", err?.message || err);
    return {
      success: false,
      error: err?.message || "Failed to add store credit.",
    };
  }
}

/**
 * Helper to parse structured address into Shopify CompanyLocation address format.
 * NOTE: CompanyAddressInput uses zoneCode (NOT province) for states/provinces.
 */
export function parseAddressDetails(addressInput, fallbackCountry = "Singapore") {
  if (!addressInput) return null;

  if (typeof addressInput === "object") {
    const addr1 = String(addressInput.address1 || "").trim();
    if (!addr1) return null;

    const rawZone = String(addressInput.zoneCode || addressInput.province || "").trim();
    const zoneCode = rawZone.length > 0 && rawZone.length <= 4 ? rawZone.toUpperCase() : undefined;

    return {
      address1: addr1.substring(0, 250),
      ...(addressInput.address2 ? { address2: String(addressInput.address2).trim().substring(0, 250) } : {}),
      city: String(addressInput.city || "Singapore").trim(),
      ...(zoneCode ? { zoneCode } : {}),
      ...(addressInput.zip ? { zip: String(addressInput.zip).trim() } : {}),
      countryCode: toCountryCode(addressInput.countryCode || addressInput.country || fallbackCountry),
    };
  }

  const raw = String(addressInput || "").trim();
  if (!raw) return null;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parseAddressDetails(parsed, fallbackCountry);
      }
    } catch (_) {
      // not json
    }
  }

  const countryCode = toCountryCode(fallbackCountry);
  const zipMatch = raw.match(/\b\d{5,6}\b/);
  const parts = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

  if (parts.length === 0) return null;

  return {
    address1: (parts[0] || raw).substring(0, 250),
    ...(parts.length > 2 && parts[1] !== (countryCode === "SG" ? "Singapore" : "") ? { address2: parts[1] } : {}),
    city: parts.length > 1 ? parts[parts.length - 1].replace(/\b\d{5,6}\b/, "").trim() || "Singapore" : (countryCode === "SG" ? "Singapore" : "Head Office"),
    countryCode,
    ...(zipMatch ? { zip: zipMatch[0] } : {}),
  };
}

/**
 * Fetch available payment terms templates from Shopify Admin GraphQL API.
 */
export async function getPaymentTermsTemplates(admin) {
  if (!admin) return [];
  try {
    const res = await admin.graphql(
      `#graphql
      query PaymentTermsTemplates {
        paymentTermsTemplates {
          id
          name
          description
        }
      }`
    );
    const data = await res.json();
    const list = data?.data?.paymentTermsTemplates;
    if (Array.isArray(list) && list.length > 0) {
      return list.filter(Boolean);
    }
    if (Array.isArray(list?.edges) && list.edges.length > 0) {
      return list.edges.map((e) => e.node).filter(Boolean);
    }
  } catch (err) {
    console.warn("[b2b] getPaymentTermsTemplates query error:", err?.message || err);
  }

  // Sensible fallback templates if store query returns empty
  return [
    { id: "gid://shopify/PaymentTermsTemplate/1", name: "Due on receipt", description: "Payment due upon receipt" },
    { id: "gid://shopify/PaymentTermsTemplate/2", name: "Net 7", description: "Payment due within 7 days" },
    { id: "gid://shopify/PaymentTermsTemplate/3", name: "Net 15", description: "Payment due within 15 days" },
    { id: "gid://shopify/PaymentTermsTemplate/4", name: "Net 30", description: "Payment due within 30 days" },
    { id: "gid://shopify/PaymentTermsTemplate/5", name: "Net 60", description: "Payment due within 60 days" },
    { id: "gid://shopify/PaymentTermsTemplate/6", name: "Net 90", description: "Payment due within 90 days" },
  ];
}

/**
 * Main service to create B2B Company & Customer upon distributor approval.
 * Assigns customer as contact, designates as Main Contact, adds shipping address,
 * and sets selected Payment Terms on the Company Location.
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
  const formatAddressString = (addrInput) => {
    if (!addrInput) return "";
    if (typeof addrInput === "string") return addrInput.trim();
    if (typeof addrInput === "object") {
      const parts = [
        addrInput.address1,
        addrInput.address2,
        addrInput.city,
        addrInput.province,
        addrInput.zip,
        addrInput.countryCode || addrInput.country,
      ].filter(Boolean);
      return parts.join(", ");
    }
    return String(addrInput).trim();
  };

  const address = formatAddressString(options.shippingAddress || application.registered_address);
  const expectedVolume = (application.expected_annual_volume || "").trim();
  const paymentTermsTemplateId = (options.paymentTermsTemplateId || "").trim();
  const requestCredit =
    Boolean(paymentTermsTemplateId) ||
    application.request_credit === "true" ||
    application.request_credit === true;

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
        note: `Approved B2B Distributor. Company: ${companyName}. UEN: ${registrationNumber || "—"}. Payment Terms: ${paymentTermsTemplateId || (requestCredit ? "Net Terms" : "Prepayment")}. Volume: ${expectedVolume || "—"}`,
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
        note: `Approved B2B Distributor Partner.\nCompany: ${companyName}\nUEN: ${registrationNumber || "—"}\nPayment Terms: ${paymentTermsTemplateId || (requestCredit ? "Net Terms Requested" : "Prepayment")}\nExpected Volume: ${expectedVolume || "—"}`,
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
  // 2. Create B2B Company with CompanyCreate GraphQL mutation
  // =========================================================================

  let companyGid = null;
  let fullCompany = null;
  const countryCode = toCountryCode(country);

  try {
    const companyNote = `Distributor Partner Company.
UEN / Registration: ${registrationNumber || "—"}
Annual Volume: ${expectedVolume || "—"}
Payment Terms: ${paymentTermsTemplateId || (requestCredit ? "Net Terms Requested" : "Prepayment")}
Website: ${application.company_website || "—"}
Contact: ${contactName || "—"} (${email})
Shipping Address: ${address || "—"}`;

    // Prepare shipping address components
    const shippingAddressInput = parseAddressDetails(
      options.shippingAddress || application.registered_address,
      country,
    );

    // Sanitize externalId to conform strictly to Shopify's allowed characters
    const cleanExternalId = (val) => {
      if (!val) return null;
      const str = String(val).trim();
      if (
        !str ||
        str === "—" ||
        str === "-" ||
        str.toLowerCase() === "n/a" ||
        str.toLowerCase() === "undefined" ||
        str.toLowerCase() === "null"
      ) {
        return null;
      }
      // Allowed: numbers, letters, and !@#$%^&*(){}[]\/?<>_-~,.;:'`"
      const sanitized = str.replace(/[^\w!@#$%^&*(){}[\]\\/?<>~,.;:'"`-]/g, "").trim();
      return sanitized.length > 0 ? sanitized.substring(0, 255) : null;
    };

    const safeExternalId = cleanExternalId(registrationNumber);

    const companyCreateInput = {
      company: {
        name: companyName,
        ...(safeExternalId ? { externalId: safeExternalId } : {}),
        note: companyNote,
      },
      ...(email ? {
        companyContact: {
          firstName: firstName || companyName,
          lastName: lastName || "Partner",
          email: email,
        },
      } : {}),
      companyLocation: {
        name: "Head Office",
        ...(shippingAddressInput && shippingAddressInput.address1
          ? { shippingAddress: shippingAddressInput }
          : {}),
      },
    };

    console.log("[b2b] Executing CreateDistributorCompany mutation for:", companyName);

    let compRes = await admin.graphql(CREATE_DISTRIBUTOR_COMPANY_MUTATION, {
      variables: { input: companyCreateInput },
    });

    let compData = await compRes.json();
    let compErrors = compData?.data?.companyCreate?.userErrors || compData?.errors;

    // If initial creation failed, retry without externalId
    if (compErrors && compErrors.length > 0) {
      console.warn("[b2b] CompanyCreate initial userErrors:", compErrors);

      const retryWithoutExternalId = {
        company: {
          name: companyName,
          note: companyNote,
        },
        ...(email ? {
          companyContact: {
            firstName: firstName || companyName,
            lastName: lastName || "Partner",
            email: email,
          },
        } : {}),
        companyLocation: {
          name: "Head Office",
          ...(shippingAddressInput && shippingAddressInput.address1
            ? { shippingAddress: shippingAddressInput }
            : {}),
        },
      };

      compRes = await admin.graphql(CREATE_DISTRIBUTOR_COMPANY_MUTATION, {
        variables: { input: retryWithoutExternalId },
      });
      compData = await compRes.json();
      compErrors = compData?.data?.companyCreate?.userErrors || compData?.errors;

      // Final fallback if location or contact had issues
      if (compErrors && compErrors.length > 0) {
        console.warn("[b2b] CompanyCreate secondary retry userErrors:", compErrors);
        const minimalInput = {
          company: {
            name: companyName,
          },
        };
        compRes = await admin.graphql(CREATE_DISTRIBUTOR_COMPANY_MUTATION, {
          variables: { input: minimalInput },
        });
        compData = await compRes.json();
      }
    }

    fullCompany = compData?.data?.companyCreate?.company || null;
    companyGid = fullCompany?.id || null;

    if (companyGid) {
      console.log("[b2b] CompanyCreate succeeded. Company ID:", companyGid);

      // =====================================================================
      // 3. Assign Customer as Company Contact & MAIN CONTACT
      // =====================================================================
      let companyContactId = null;

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
          companyContactId = assignData?.data?.companyAssignCustomerAsContact?.companyContact?.id || null;
          const assignErrors =
            assignData?.data?.companyAssignCustomerAsContact?.userErrors;
          if (assignErrors && assignErrors.length > 0) {
            console.warn("[b2b] companyAssignCustomerAsContact note:", assignErrors);
          } else {
            console.log("[b2b] Successfully assigned customer as company contact! Contact ID:", companyContactId);
          }
        } catch (assignErr) {
          console.warn("[b2b] companyAssignCustomerAsContact error:", assignErr?.message || assignErr);
        }
      }

      // If contact ID wasn't returned, query company contacts
      if (!companyContactId) {
        try {
          const contactsRes = await admin.graphql(
            `#graphql
            query GetCompanyContacts($companyId: ID!) {
              company(id: $companyId) {
                contacts(first: 10) {
                  edges {
                    node {
                      id
                      customer { id }
                    }
                  }
                }
              }
            }`,
            { variables: { companyId: companyGid } }
          );
          const contactsData = await contactsRes.json();
          const edges = contactsData?.data?.company?.contacts?.edges || [];
          const match = edges.find((e) => e.node?.customer?.id === customerGid) || edges[0];
          if (match?.node?.id) {
            companyContactId = match.node.id;
          }
        } catch (e) {
          console.warn("[b2b] query company contacts error:", e?.message || e);
        }
      }

      // Designate contact as MAIN CONTACT using SetMainContact mutation
      if (companyContactId) {
        try {
          const mainRes = await admin.graphql(SET_MAIN_CONTACT_MUTATION, {
            variables: {
              companyId: companyGid,
              contactId: companyContactId,
            },
          });
          const mainData = await mainRes.json();
          const mainErrors = mainData?.data?.companyUpdate?.userErrors;
          if (mainErrors && mainErrors.length > 0) {
            console.warn("[b2b] SetMainContact note:", mainErrors);
          } else {
            console.log("[b2b] Successfully set main contact for company:", companyGid);
          }
        } catch (mainErr) {
          console.warn("[b2b] SetMainContact error:", mainErr?.message || mainErr);
        }
      }

      // =====================================================================
      // 4. Resolve Location, Ensure Shipping Address & Ordering Role
      // =====================================================================
      let locationId = fullCompany?.locations?.edges?.[0]?.node?.id || null;
      if (!locationId) {
        try {
          const locRes = await admin.graphql(
            `#graphql
            query GetCompanyLocations($companyId: ID!) {
              company(id: $companyId) {
                locations(first: 5) {
                  edges {
                    node {
                      id
                      shippingAddress { address1 }
                    }
                  }
                }
              }
            }`,
            { variables: { companyId: companyGid } }
          );
          const locData = await locRes.json();
          locationId = locData?.data?.company?.locations?.edges?.[0]?.node?.id || null;
        } catch (e) {
          console.warn("[b2b] fetch company location error:", e?.message || e);
        }
      }

      // Ensure Shipping Address is assigned to location if address was provided
      if (locationId && shippingAddressInput && shippingAddressInput.address1) {
        try {
          const addressInput = {
            address1: shippingAddressInput.address1,
            companyName: companyName,
            countryCode: shippingAddressInput.countryCode || countryCode,
            recipient: companyName,
            ...(shippingAddressInput.address2 ? { address2: String(shippingAddressInput.address2).substring(0, 250) } : {}),
            ...(shippingAddressInput.city ? { city: String(shippingAddressInput.city) } : {}),
            ...(shippingAddressInput.zoneCode ? { zoneCode: String(shippingAddressInput.zoneCode) } : {}),
            ...(shippingAddressInput.zip ? { zip: String(shippingAddressInput.zip) } : {}),
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
            ...(cleanPhone.length >= 7 ? { phone: cleanPhone } : {}),
          };

          const assignAddrRes = await admin.graphql(
            `#graphql
            mutation AssignLocationAddress($locationId: ID!, $address: CompanyAddressInput!, $addressTypes: [CompanyAddressType!]!) {
              companyLocationAssignAddress(
                locationId: $locationId,
                address: $address,
                addressTypes: $addressTypes
              ) {
                companyLocation { id }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                locationId: locationId,
                address: addressInput,
                addressTypes: ["SHIPPING", "BILLING"],
              },
            }
          );
          const assignAddrData = await assignAddrRes.json();
          const addrErrors = assignAddrData?.data?.companyLocationAssignAddress?.userErrors;
          if (addrErrors && addrErrors.length > 0) {
            console.warn("[b2b] companyLocationAssignAddress note:", addrErrors);
          } else {
            console.log("[b2b] Successfully assigned shipping address to location:", locationId);
          }
        } catch (addrErr) {
          console.warn("[b2b] companyLocationAssignAddress error:", addrErr?.message || addrErr);
        }
      }

      // Assign ordering / buyer role to contact for the location
      if (companyContactId && locationId) {
        try {
          const rolesRes = await admin.graphql(
            `#graphql
            query GetCompanyRoles($companyId: ID!) {
              company(id: $companyId) {
                contactRoles(first: 5) {
                  edges {
                    node { id name }
                  }
                }
              }
            }`,
            { variables: { companyId: companyGid } }
          );
          const rolesData = await rolesRes.json();
          const roles = rolesData?.data?.company?.contactRoles?.edges?.map((e) => e.node) || [];
          const matchedRole = roles.find((r) => /admin|order|buy|manager/i.test(r.name)) || roles[0];

          if (matchedRole?.id) {
            await admin.graphql(
              `#graphql
              mutation AssignRoleToContact($companyContactId: ID!, $companyContactRoleId: ID!, $companyLocationId: ID!) {
                companyContactAssignRole(
                  companyContactId: $companyContactId,
                  companyContactRoleId: $companyContactRoleId,
                  companyLocationId: $companyLocationId
                ) {
                  companyContactRoleAssignment { id }
                  userErrors { field message }
                }
              }`,
              {
                variables: {
                  companyContactId: companyContactId,
                  companyContactRoleId: matchedRole.id,
                  companyLocationId: locationId,
                },
              }
            );
          }
        } catch (roleErr) {
          console.warn("[b2b] assign role error:", roleErr?.message || roleErr);
        }
      }

      // =====================================================================
      // 5. Assign Selected Payment Terms to Company Location
      // =====================================================================
      if (locationId && paymentTermsTemplateId) {
        try {
          let targetTemplateId = paymentTermsTemplateId;
          if (!targetTemplateId.startsWith("gid://shopify/PaymentTermsTemplate/")) {
            const availableTemplates = await getPaymentTermsTemplates(admin);
            const found = availableTemplates.find(
              (t) =>
                t.id === targetTemplateId ||
                t.paymentTermsType === targetTemplateId ||
                t.name?.toLowerCase().includes(targetTemplateId.toLowerCase())
            );
            if (found && found.id?.startsWith("gid://shopify/PaymentTermsTemplate/")) {
              targetTemplateId = found.id;
            }
          }

          if (targetTemplateId) {
            const updateLocRes = await admin.graphql(
              UPDATE_COMPANY_PAYMENT_TERMS_MUTATION,
              {
                variables: {
                  companyLocationId: locationId,
                  paymentTermsTemplateId: targetTemplateId,
                },
              }
            );
            const updateLocData = await updateLocRes.json();
            const locErrors = updateLocData?.data?.companyLocationUpdate?.userErrors;
            if (locErrors && locErrors.length > 0) {
              console.warn("[b2b] UpdateCompanyPaymentTerms userErrors:", locErrors);
            } else {
              console.log("[b2b] Successfully assigned payment terms template to company location:", targetTemplateId, "location:", locationId);
            }
          }
        } catch (termErr) {
          console.warn("[b2b] companyLocationUpdate payment terms error:", termErr?.message || termErr);
        }
      }
    }
  } catch (e) {
    console.info("[b2b] Company creation skipped or not supported on this store plan:", e?.message || e);
  }

  // Fetch complete fresh company details including location, main contact, and payment terms
  if (companyGid) {
    fullCompany = await getCompanyDetails(admin, companyGid, companyName);
  }

  // Optionally add Store Credit to customer if specified
  let storeCreditResult = null;
  if (customerGid && options.storeCreditAmount && Number(options.storeCreditAmount) > 0) {
    try {
      storeCreditResult = await addCustomerStoreCredit(
        admin,
        customerGid,
        options.storeCreditAmount,
        options.storeCreditCurrency || "USD",
      );
      if (storeCreditResult?.success) {
        console.log("[b2b] Successfully credited customer store credit:", options.storeCreditAmount, options.storeCreditCurrency);
      }
    } catch (scErr) {
      console.warn("[b2b] Error granting store credit upon approval:", scErr?.message || scErr);
    }
  }

  return {
    success: true,
    customerId: customerGid,
    companyId: companyGid,
    company: fullCompany,
    storeCredit: storeCreditResult,
  };
}

