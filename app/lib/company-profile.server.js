/**
 * The company profile (M1, HYV-109): what the portal needs to place a
 * distributor's order correctly, kept on the Shopify company.
 *
 *   name                       the company's own name in Shopify
 *   tax_registration_number    printed on its invoices (invoice-document)
 *   preferred_currency         the currency it buys in
 *   preferred_shipping_method  EXW, FOB Ningbo or DDP
 *   courier_account            its own courier account, for EXW collection
 *   forwarder_name / _account  its sea freight forwarder, for FOB Ningbo
 *
 * Shown in Settings. Only a company admin changes it; buyers see it read-only.
 */
import { canManageTeam } from "./account-team.server";
import { supportedCurrencies } from "./store-currencies.server";

export const SHIPPING_METHODS = ["FOB Ningbo", "DDP"];
// export const SHIPPING_METHODS = ["EXW", "FOB Ningbo", "DDP"];

const FIELDS = [
  { key: "tax_registration_number", form: "taxNumber" },
  { key: "preferred_currency", form: "preferredCurrency" },
  { key: "preferred_shipping_method", form: "preferredShipping" },
  { key: "courier_account", form: "courierAccount" },
  { key: "forwarder_name", form: "forwarderName" },
  { key: "forwarder_account", form: "forwarderAccount" },
];

const PROFILE_QUERY = `#graphql
  query CompanyProfile($id: ID!) {
    customer(id: $id) {
      companyContactProfiles {
        company {
          id
          name
          ${FIELDS.map(({ key, form }) => `${form}: metafield(namespace: "hyve", key: "${key}") { value }`).join("\n          ")}
        }
      }
    }
  }`;

const COMPANY_RENAME = `#graphql
  mutation CompanyRename($companyId: ID!, $input: CompanyInput!) {
    companyUpdate(companyId: $companyId, input: $input) {
      userErrors { field message }
    }
  }`;

const PROFILE_SET = `#graphql
  mutation CompanyProfileSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

const PROFILE_CLEAR = `#graphql
  mutation CompanyProfileClear($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }`;

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors?.length) throw new Error(body.errors[0]?.message || "Shopify rejected the request.");
  return body.data || {};
}

/**
 * The signed-in customer's company profile, and whether they may change it.
 * Null for a customer with no company.
 *
 * @param {string} numericCustomerId the id from `logged_in_customer_id`
 */
export async function loadCompanyProfile(admin, numericCustomerId) {
  const data = await gql(admin, PROFILE_QUERY, { id: `gid://shopify/Customer/${numericCustomerId}` });
  const company = data.customer?.companyContactProfiles?.[0]?.company;
  if (!company) return null;

  const profile = { companyId: company.id, name: company.name || "" };
  for (const { form } of FIELDS) profile[form] = company[form]?.value || "";
  const [canManage, currencies] = await Promise.all([
    canManageTeam(admin, numericCustomerId),
    supportedCurrencies(admin),
  ]);
  profile.canManage = canManage;
  profile.currencies = currencies;
  return profile;
}

/**
 * Saves the profile from the Settings form. The company is the caller's own,
 * read from Shopify, never taken from the form.
 *
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
export async function saveCompanyProfile(admin, numericCustomerId, form) {
  const current = await loadCompanyProfile(admin, numericCustomerId);
  if (!current) return { ok: false, error: "Company details are for distributor accounts." };
  if (!current.canManage) return { ok: false, error: "Only your account admin can change company details." };

  const value = (key) => String(form.get(key) || "").trim();
  const name = value("companyName");
  if (!name) return { ok: false, error: "Enter your company name." };
  const shipping = value("preferredShipping");
  if (shipping && !SHIPPING_METHODS.includes(shipping)) {
    return { ok: false, error: "Choose a shipping method from the list." };
  }

  if (name !== current.name) {
    const renamed = await gql(admin, COMPANY_RENAME, { companyId: current.companyId, input: { name } });
    const error = renamed.companyUpdate?.userErrors?.[0]?.message;
    if (error) return { ok: false, error };
  }

  const toSet = [];
  const toClear = [];
  for (const { key, form: field } of FIELDS) {
    const next = value(field);
    if (next === current[field]) continue;
    if (next) {
      toSet.push({ ownerId: current.companyId, namespace: "hyve", key, type: "single_line_text_field", value: next });
    } else {
      toClear.push({ ownerId: current.companyId, namespace: "hyve", key });
    }
  }

  if (toSet.length) {
    const saved = await gql(admin, PROFILE_SET, { metafields: toSet });
    const error = saved.metafieldsSet?.userErrors?.[0]?.message;
    if (error) return { ok: false, error };
  }
  if (toClear.length) {
    const cleared = await gql(admin, PROFILE_CLEAR, { metafields: toClear });
    const error = cleared.metafieldsDelete?.userErrors?.[0]?.message;
    if (error) return { ok: false, error };
  }
  return { ok: true };
}
