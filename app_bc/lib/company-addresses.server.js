/**
 * A distributor's addresses are its company's locations (HYV-109, PRF-02).
 *
 * Orders, invoices and quotes are the company's, and B2B checkout ships to a
 * company location, so the address book is the company's too: every location
 * gives a Shipping card, and a Billing card when its billing address differs.
 * The billing card shows the company's tax registration number — the one on
 * its invoices, kept on the company and edited in Settings, not per address.
 *
 * Only a company admin changes them. Adding an address adds a location, and a
 * location is more than an address: it holds the catalog (tier prices), the
 * payment terms, the tax exemption and who may order for it. A new one copies
 * all of that from the company's main location, and is removed again if any
 * step fails, so a half-set-up location never reaches checkout.
 *
 * Retail customers have no company and keep their personal address book
 * (proxy.addresses.jsx).
 */
import { canManageTeam } from "./account-team.server";

const DEFAULT_KEYS = { shipping: "default_shipping_location", billing: "default_billing_location" };

const ADDRESS_FIELDS = "address1 address2 city zip province zoneCode country countryCode recipient firstName lastName phone";

const BOOK_QUERY = `#graphql
  query CompanyAddressBook($id: ID!) {
    customer(id: $id) {
      companyContactProfiles {
        id
        company {
          id
          name
          defaultShipping: metafield(namespace: "hyve", key: "default_shipping_location") { value }
          defaultBilling: metafield(namespace: "hyve", key: "default_billing_location") { value }
          taxNumber: metafield(namespace: "hyve", key: "tax_registration_number") { value }
          locations(first: 50) {
            nodes {
              id
              name
              createdAt
              ordersCount { count }
              shippingAddress { ${ADDRESS_FIELDS} }
              billingAddress { ${ADDRESS_FIELDS} }
              taxSettings { taxRegistrationId taxExempt taxExemptions }
              buyerExperienceConfiguration { checkoutToDraft editableShippingAddress paymentTermsTemplate { id } }
              catalogs(first: 10) { nodes { id } }
              roleAssignments(first: 50) { nodes { companyContact { id } role { id } } }
            }
          }
        }
      }
    }
  }`;

const LOCATION_CREATE = `#graphql
  mutation CompanyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
    companyLocationCreate(companyId: $companyId, input: $input) {
      companyLocation { id }
      userErrors { field message }
    }
  }`;

const CATALOG_ADD = `#graphql
  mutation CompanyLocationCatalogAdd($catalogId: ID!, $contexts: CatalogContextInput!) {
    catalogContextUpdate(catalogId: $catalogId, contextsToAdd: $contexts) {
      userErrors { field message }
    }
  }`;

const ROLES_ASSIGN = `#graphql
  mutation CompanyLocationRolesAssign($locationId: ID!, $roles: [CompanyLocationRoleAssign!]!) {
    companyLocationAssignRoles(companyLocationId: $locationId, rolesToAssign: $roles) {
      userErrors { field message }
    }
  }`;

const ADDRESS_ASSIGN = `#graphql
  mutation CompanyLocationAddressAssign($locationId: ID!, $address: CompanyAddressInput!, $types: [CompanyAddressType!]!) {
    companyLocationAssignAddress(locationId: $locationId, address: $address, addressTypes: $types) {
      userErrors { field message }
    }
  }`;

const LOCATION_RENAME = `#graphql
  mutation CompanyLocationRename($id: ID!, $input: CompanyLocationUpdateInput!) {
    companyLocationUpdate(companyLocationId: $id, input: $input) {
      userErrors { field message }
    }
  }`;

const LOCATION_DELETE = `#graphql
  mutation CompanyLocationDelete($id: ID!) {
    companyLocationDelete(companyLocationId: $id) {
      userErrors { field message }
    }
  }`;

const METAFIELDS_SET = `#graphql
  mutation CompanyDefaultLocationSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors?.length) throw new Error(body.errors[0]?.message || "Shopify rejected the request.");
  return body.data || {};
}

/** The first user error in a mutation result, as a message the buyer can act on, or null. */
function userError(data, field) {
  const message = data?.[field]?.userErrors?.[0]?.message || null;
  // Shopify wants the short state code, not the name.
  if (message && /zone code/i.test(message)) {
    return "Use the short state code, such as SGR for Selangor or KUL for Kuala Lumpur, or leave the state blank.";
  }
  return message;
}

/**
 * The company's locations, oldest first, and whether the signed-in customer
 * may change them. Null for a customer with no company.
 *
 * @param {string} numericCustomerId the id from `logged_in_customer_id`
 */
export async function loadCompanyAddressBook(admin, numericCustomerId) {
  const data = await gql(admin, BOOK_QUERY, { id: `gid://shopify/Customer/${numericCustomerId}` });
  const profile = data.customer?.companyContactProfiles?.[0];
  const company = profile?.company;
  if (!company) return null;

  const locations = [...(company.locations?.nodes || [])].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt)),
  );
  const firstId = locations[0]?.id || null;
  const has = (id) => locations.some((location) => location.id === id);
  const pick = (value) => (value && has(value) ? value : firstId);

  return {
    companyId: company.id,
    companyName: company.name,
    taxNumber: company.taxNumber?.value || "",
    locations,
    defaults: {
      shipping: pick(company.defaultShipping?.value),
      billing: pick(company.defaultBilling?.value),
    },
    canManage: await canManageTeam(admin, numericCustomerId),
  };
}

function sameAddress(a, b) {
  if (!a || !b) return false;
  const keys = ["address1", "address2", "city", "zip", "zoneCode", "countryCode", "recipient", "firstName", "lastName", "phone"];
  return keys.every((key) => String(a[key] || "") === String(b[key] || ""));
}

function addressLines(address) {
  const name = address.recipient || [address.firstName, address.lastName].filter(Boolean).join(" ");
  return [
    name,
    address.address1,
    address.address2,
    // The state is left out where it only repeats the city, as in Kuala Lumpur.
    [address.city, address.province !== address.city ? address.province : "", address.zip].filter(Boolean).join(" "),
    address.country || address.countryCode,
    address.phone,
  ].filter(Boolean);
}

/**
 * One card per address, in the shape the Addresses page renders: a Shipping
 * card for every location, and a Billing card where its billing address is
 * not the same as its shipping one — otherwise the one card is both.
 */
export function companyAddressCards(book) {
  const cards = [];
  const onlyOne = book.locations.length <= 1;

  for (const location of book.locations) {
    const shipping = location.shippingAddress || {};
    const billing = location.billingAddress || shipping;
    const combined = sameAddress(shipping, billing);
    const deletable = book.canManage && !onlyOne && !(location.ordersCount?.count > 0);

    const card = (type, address) => ({
      id: `${location.id}#${type}`,
      locationId: location.id,
      locationName: location.name,
      type,
      isDefault: type === "billing" ? book.defaults.billing === location.id : book.defaults.shipping === location.id,
      isDefaultBilling: combined && book.defaults.billing === location.id,
      primaryName: location.name,
      lines: addressLines(address),
      taxRegistrationId: type === "shipping" ? "" : book.taxNumber,
      canManage: book.canManage,
      deletable,
      firstName: address.firstName || "",
      lastName: address.lastName || "",
      address1: address.address1 || "",
      address2: address.address2 || "",
      city: address.city || "",
      province: address.zoneCode || "",
      zip: address.zip || "",
      countryCodeV2: address.countryCode || "SG",
      phone: address.phone || "",
    });

    cards.push(card(combined ? "both" : "shipping", shipping));
    if (!combined) cards.push(card("billing", billing));
  }
  return cards;
}

/** The address fields posted by the Addresses form, as Shopify's input. */
export function addressInputFrom(form) {
  const value = (key) => String(form.get(key) || "").trim();
  const input = {
    firstName: value("firstName"),
    lastName: value("lastName"),
    address1: value("address1"),
    address2: value("address2"),
    city: value("city"),
    zip: value("zip"),
    countryCode: value("countryCode") || "SG",
    phone: value("phone"),
  };
  const zone = value("province").toUpperCase();
  if (zone) input.zoneCode = zone;
  return input;
}

function requireAdmin(book) {
  if (!book) return "Company addresses are for distributor accounts.";
  if (!book.canManage) return "Only your account admin can change company addresses.";
  return null;
}

function ownLocation(book, locationId) {
  return book.locations.find((location) => location.id === locationId) || null;
}

/**
 * Adds an address as a new company location, set up like the main one.
 *
 * @param {{name:string, address:object, billingSameAsShipping:boolean, setAsDefault:boolean}} input
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
export async function addCompanyLocation(admin, numericCustomerId, input) {
  const book = await loadCompanyAddressBook(admin, numericCustomerId);
  const denied = requireAdmin(book);
  if (denied) return { ok: false, error: denied };

  const main = ownLocation(book, book.defaults.shipping) || book.locations[0];
  if (!main) return { ok: false, error: "Your company has no location to copy its settings from. Please contact us." };

  const terms = main.buyerExperienceConfiguration;
  const created = await gql(admin, LOCATION_CREATE, {
    companyId: book.companyId,
    input: {
      name: input.name || `${book.companyName} ${book.locations.length + 1}`,
      shippingAddress: input.address,
      billingSameAsShipping: true,
      taxExempt: Boolean(main.taxSettings?.taxExempt),
      taxExemptions: main.taxSettings?.taxExemptions || [],
      ...(main.taxSettings?.taxRegistrationId ? { taxRegistrationId: main.taxSettings.taxRegistrationId } : {}),
      ...(terms
        ? {
            buyerExperienceConfiguration: {
              checkoutToDraft: Boolean(terms.checkoutToDraft),
              editableShippingAddress: Boolean(terms.editableShippingAddress),
              ...(terms.paymentTermsTemplate?.id ? { paymentTermsTemplateId: terms.paymentTermsTemplate.id } : {}),
            },
          }
        : {}),
    },
  });
  const createError = userError(created, "companyLocationCreate");
  const locationId = created.companyLocationCreate?.companyLocation?.id;
  if (createError || !locationId) return { ok: false, error: createError || "Shopify didn't create the address." };

  // Copy the rest; any failure removes the new location again.
  try {
    for (const catalog of main.catalogs?.nodes || []) {
      const added = await gql(admin, CATALOG_ADD, { catalogId: catalog.id, contexts: { companyLocationIds: [locationId] } });
      const error = userError(added, "catalogContextUpdate");
      if (error) throw new Error(error);
    }

    const roles = (main.roleAssignments?.nodes || [])
      .filter((assignment) => assignment.companyContact?.id && assignment.role?.id)
      .map((assignment) => ({ companyContactId: assignment.companyContact.id, companyContactRoleId: assignment.role.id }));
    if (roles.length) {
      const assigned = await gql(admin, ROLES_ASSIGN, { locationId, roles });
      const error = userError(assigned, "companyLocationAssignRoles");
      if (error) throw new Error(error);
    }
  } catch (error) {
    await gql(admin, LOCATION_DELETE, { id: locationId }).catch(() => {});
    console.error("[addresses] new location rolled back", error?.message || error);
    return { ok: false, error: `The address couldn't be set up, so it wasn't added: ${error?.message || error}` };
  }

  if (input.setAsDefault) await setDefaultLocation(admin, numericCustomerId, { locationId, type: "shipping" });
  return { ok: true };
}

/**
 * Changes a location's shipping or billing address, and its name.
 *
 * @param {{locationId:string, type:"shipping"|"billing"|"both", name:string, address:object,
 *   setAsDefault:boolean}} input
 */
export async function updateCompanyLocation(admin, numericCustomerId, input) {
  const book = await loadCompanyAddressBook(admin, numericCustomerId);
  const denied = requireAdmin(book);
  if (denied) return { ok: false, error: denied };
  const location = ownLocation(book, input.locationId);
  if (!location) return { ok: false, error: "That address isn't one of your company's." };

  const types = input.type === "both" ? ["SHIPPING", "BILLING"] : [input.type === "billing" ? "BILLING" : "SHIPPING"];
  const assigned = await gql(admin, ADDRESS_ASSIGN, { locationId: location.id, address: input.address, types });
  const addressError = userError(assigned, "companyLocationAssignAddress");
  if (addressError) return { ok: false, error: addressError };

  if (input.name && input.name !== location.name) {
    const renamed = await gql(admin, LOCATION_RENAME, { id: location.id, input: { name: input.name } });
    const error = userError(renamed, "companyLocationUpdate");
    if (error) return { ok: false, error };
  }

  if (input.setAsDefault) {
    await setDefaultLocation(admin, numericCustomerId, { locationId: location.id, type: input.type });
  }
  return { ok: true };
}

/** Removes a location — only one with no orders, and never the last. */
export async function deleteCompanyLocation(admin, numericCustomerId, locationId) {
  const book = await loadCompanyAddressBook(admin, numericCustomerId);
  const denied = requireAdmin(book);
  if (denied) return { ok: false, error: denied };
  const location = ownLocation(book, locationId);
  if (!location) return { ok: false, error: "That address isn't one of your company's." };
  if (book.locations.length <= 1) return { ok: false, error: "Your company needs at least one address." };
  if (location.ordersCount?.count > 0) {
    return { ok: false, error: "This address has orders placed against it, so it can't be deleted." };
  }

  const deleted = await gql(admin, LOCATION_DELETE, { id: location.id });
  const error = userError(deleted, "companyLocationDelete");
  return error ? { ok: false, error } : { ok: true };
}

/**
 * Marks a location as the company's default for shipping, billing or both.
 * Quotes raised from the cart are placed against the default shipping one.
 */
export async function setDefaultLocation(admin, numericCustomerId, { locationId, type }) {
  const book = await loadCompanyAddressBook(admin, numericCustomerId);
  const denied = requireAdmin(book);
  if (denied) return { ok: false, error: denied };
  if (!ownLocation(book, locationId)) return { ok: false, error: "That address isn't one of your company's." };

  const keys = type === "both" ? [DEFAULT_KEYS.shipping, DEFAULT_KEYS.billing] : [DEFAULT_KEYS[type === "billing" ? "billing" : "shipping"]];
  const saved = await gql(admin, METAFIELDS_SET, {
    metafields: keys.map((key) => ({ ownerId: book.companyId, namespace: "hyve", key, type: "single_line_text_field", value: locationId })),
  });
  const error = userError(saved, "metafieldsSet");
  return error ? { ok: false, error } : { ok: true };
}
