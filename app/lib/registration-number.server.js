import { cleanExternalId } from "./distributor-b2b.server";
import { getAllDistributorApplications } from "./distributor-metaobject.server";

/**
 * One business registration number (UEN) per distributor (HYV-143).
 *
 * Approval saves the number as the Shopify company's external id, and Shopify
 * refuses a second company with the same one ("External id has already been
 * taken"). That refusal used to come only at approval, after the applicant was
 * already tagged as a distributor. These checks catch it at submission and
 * before approval writes anything.
 */

const comparable = (value) => String(cleanExternalId(value) || "").toLowerCase();

/** The Shopify company already holding this number as its external id, if any. */
export async function companyWithRegistrationNumber(admin, registrationNumber) {
  const wanted = comparable(registrationNumber);
  if (!wanted) return null;
  const response = await admin.graphql(
    `#graphql
    query CompanyByExternalId($query: String!) {
      companies(first: 5, query: $query) {
        nodes { id name externalId }
      }
    }`,
    { variables: { query: `external_id:"${cleanExternalId(registrationNumber).replace(/"/g, '\\"')}"` } },
  );
  const body = await response.json();
  // The search is loose, so the match is confirmed here.
  return (body?.data?.companies?.nodes || []).find((company) => comparable(company.externalId) === wanted) || null;
}

/**
 * Why this number can't be used on an application, or null when it can. It's
 * taken when a Shopify company already has it, or another applicant's
 * application that hasn't been declined uses it.
 *
 * @param {{customerId?: string, applicationId?: string}} self the applicant
 *   and application being checked, which don't count against themselves.
 */
export async function registrationNumberProblem(admin, registrationNumber, self = {}) {
  const wanted = comparable(registrationNumber);
  if (!wanted) return null;

  const ownCustomer = String(self.customerId || "").replace(/\D/g, "");
  const applications = await getAllDistributorApplications(admin);

  // The applicant's own earlier company doesn't count: someone whose access
  // ended applies again with the same number (HYV-76).
  const ownCompanies = new Set(
    applications
      .filter((application) => String(application.customer_id || "").replace(/\D/g, "") === ownCustomer)
      .map((application) => application.company_id)
      .filter(Boolean),
  );
  const company = await companyWithRegistrationNumber(admin, registrationNumber);
  if (company && !ownCompanies.has(company.id)) {
    return `This registration number is already used by ${company.name}. Check the number, or contact us if your company already has an account.`;
  }
  const other = applications.find(
    (application) =>
      application.id !== self.applicationId &&
      String(application.customer_id || "").replace(/\D/g, "") !== ownCustomer &&
      String(application.status || "").trim() !== "Rejected" &&
      comparable(application.registration_number) === wanted,
  );
  if (other) {
    return "This registration number is already used on another application. Check the number, or contact us if your company has already applied.";
  }
  return null;
}

const DISTRIBUTOR_TAGS = ["b2b", "distributor", "wholesale"];

/**
 * Takes back the distributor tags a failed approval put on the applicant:
 * approval tags the customer before creating the company, so a refused
 * company left a retail customer tagged as a distributor. Only the tags that
 * approval added come off, and someone who is a contact on any company keeps
 * them.
 *
 * @param {string[]} added the tags the approval added
 */
export async function removeDistributorTagsWithoutCompany(admin, customerId, added = []) {
  const numeric = String(customerId || "").replace(/\D/g, "");
  if (!numeric) return;
  const id = `gid://shopify/Customer/${numeric}`;
  try {
    const response = await admin.graphql(
      `#graphql
      query DistributorTagState($id: ID!) {
        customer(id: $id) {
          id
          tags
          companyContactProfiles { id }
        }
      }`,
      { variables: { id } },
    );
    const customer = (await response.json())?.data?.customer;
    if (!customer || customer.companyContactProfiles?.length) return;
    const tags = DISTRIBUTOR_TAGS.filter((tag) => added.includes(tag) && (customer.tags || []).includes(tag));
    if (!tags.length) return;
    await admin.graphql(
      `#graphql
      mutation RemoveDistributorTags($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }`,
      { variables: { id, tags } },
    );
  } catch (error) {
    console.warn("[distributor] removing distributor tags failed:", error?.message || error);
  }
}

/** A tax number compared without spaces, dots or dashes, ignoring case. */
const taxComparable = (value) => String(value || "").replace(/[\s.\-/]/g, "").toUpperCase();

/**
 * Other applications with the same tax registration number, for a warning
 * on the approval page. Unlike the business registration number, Shopify
 * doesn't need it to be unique, and related companies can share one, so it
 * never blocks: a repeat often just means the same business applying twice.
 *
 * @returns {Promise<Array<{id: string, companyName: string, status: string}>>}
 */
export async function applicationsWithTaxNumber(admin, taxNumber, applicationId) {
  const wanted = taxComparable(taxNumber);
  if (!wanted || ["N/A", "NA", "NIL", "NONE", "—"].includes(wanted)) return [];
  const applications = await getAllDistributorApplications(admin);
  return applications
    .filter((application) => application.id !== applicationId && taxComparable(application.tax_registration_number) === wanted)
    .map((application) => ({
      id: application.id,
      companyName: application.company_name || "Unnamed company",
      status: String(application.status || "Pending Review").trim(),
    }));
}
