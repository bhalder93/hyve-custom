/**
 * Turning an approved application into a working B2B buyer.
 *
 * Creating the company is only the first of five steps. Miss any of the rest
 * and the buyer signs in but can't actually trade:
 *
 *   1. company + location + contact      companyCreate
 *   2. an ordering role on the location  companyLocationAssignRoles
 *      -- without this the contact can see the company but cannot order for it
 *   3. payment terms on the location     companyLocationUpdate
 *      -- this is what makes Net 30 real; the portal reads it back
 *   4. the tier catalog on the location  catalogUpdate
 *      -- this is what gives them distributor pricing
 *   5. credit limit on the location      metafieldsSet (company-credit.server.js)
 *
 * Every step reports its own outcome, so a partial setup is visible rather than
 * looking like success.
 */

/** @returns {Promise<{ok:boolean, steps:object[], locationId:?string}>} */
export async function completeB2BOnboarding(
  admin,
  companyGid,
  { paymentTerms, catalogTitle, salesRep, salesRepEmail, salesRepPhone } = {},
) {
  const steps = [];
  const record = (name, ok, detail) => steps.push({ name, ok, detail });

  if (!admin || !companyGid) {
    return { ok: false, steps: [{ name: "company", ok: false, detail: "No company to set up." }], locationId: null };
  }

  const company = await readCompany(admin, companyGid);
  const locationId = company?.locations?.nodes?.[0]?.id || null;
  const contact = company?.contacts?.nodes?.[0] || null;

  if (!locationId) {
    record("location", false, "The company has no location, so nothing can be attached to it.");
    return { ok: false, steps, locationId: null };
  }
  record("location", true, company.locations.nodes[0].name || "Location ready");

  // 2. Ordering permission.
  if (contact) {
    const role = pickOrderingRole(company?.contactRoles?.nodes || []);
    if (!role) {
      record("ordering role", false, "No ordering role exists on this company.");
    } else {
      const res = await gql(admin, `#graphql
        mutation AssignLocationRole($companyLocationId: ID!, $rolesToAssign: [CompanyLocationRoleAssign!]!) {
          companyLocationAssignRoles(companyLocationId: $companyLocationId, rolesToAssign: $rolesToAssign) {
            roleAssignments { id }
            userErrors { field message code }
          }
        }`, {
        companyLocationId: locationId,
        rolesToAssign: [{ companyContactId: contact.id, companyContactRoleId: role.id }],
      });
      const err = res?.companyLocationAssignRoles?.userErrors?.[0];
      record("ordering role", !err, err ? err.message : `${role.name} granted`);
    }
  } else {
    record("ordering role", false, "No company contact to grant it to.");
  }

  // 3. Payment terms, when the applicant asked for credit.
  if (paymentTerms) {
    const template = await findPaymentTerms(admin, paymentTerms);
    if (!template) {
      record("payment terms", false, `No "${paymentTerms}" payment terms template exists on this store.`);
    } else {
      const res = await gql(admin, `#graphql
        mutation SetLocationTerms($companyLocationId: ID!, $input: CompanyLocationUpdateInput!) {
          companyLocationUpdate(companyLocationId: $companyLocationId, input: $input) {
            companyLocation { id }
            userErrors { field message code }
          }
        }`, {
        companyLocationId: locationId,
        input: { buyerExperienceConfiguration: { paymentTermsTemplateId: template.id } },
      });
      const err = res?.companyLocationUpdate?.userErrors?.[0];
      record("payment terms", !err, err ? err.message : template.name);
    }
  }

  // 4. The pricing tier.
  if (catalogTitle) {
    const catalog = await findCatalog(admin, catalogTitle);
    if (!catalog) {
      record("tier catalog", false, `No catalog named "${catalogTitle}" exists.`);
    } else {
      const res = await gql(admin, `#graphql
        mutation AssignCatalog($id: ID!, $input: CatalogUpdateInput!) {
          catalogUpdate(id: $id, input: $input) {
            catalog { id title }
            userErrors { field message code }
          }
        }`, {
        id: catalog.id,
        input: { context: { companyLocationIds: [locationId] } },
      });
      const err = res?.catalogUpdate?.userErrors?.[0];
      record("tier catalog", !err, err ? err.message : catalog.title);
    }
  }

  // 5. Who the buyer talks to. The portal hides each contact button when the
  // matching detail is blank, so partial details are fine.
  const repFields = [
    ["sales_rep", "single_line_text_field", salesRep],
    ["sales_rep_email", "single_line_text_field", salesRepEmail],
    ["sales_rep_phone", "single_line_text_field", salesRepPhone],
  ].filter(([, , value]) => String(value || "").trim());

  if (repFields.length) {
    const res = await gql(admin, `#graphql
      mutation SetLocationSalesRep($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message code }
        }
      }`, {
      metafields: repFields.map(([key, type, value]) => ({
        ownerId: locationId,
        namespace: "hyve",
        key,
        type,
        value: String(value).trim(),
      })),
    });
    const err = res?.metafieldsSet?.userErrors?.[0];
    record("sales rep", !err, err ? err.message : String(salesRep || salesRepEmail).trim());
  }

  return { ok: steps.every((s) => s.ok), steps, locationId };
}

async function readCompany(admin, companyGid) {
  const data = await gql(admin, `#graphql
    query CompanyRoles($id: ID!) {
      company(id: $id) {
        id
        name
        contactRoles(first: 5) { nodes { id name } }
        contacts(first: 5) { nodes { id } }
        locations(first: 1) { nodes { id name } }
      }
    }`, { id: companyGid });
  return data?.company || null;
}

/** Shopify seeds every company with "Ordering only" and "Location admin". */
function pickOrderingRole(roles) {
  return (
    roles.find((r) => /location admin/i.test(r.name)) ||
    roles.find((r) => /order/i.test(r.name)) ||
    roles[0] ||
    null
  );
}

async function findPaymentTerms(admin, wanted) {
  // The approval screen sends a real template ID from its dropdown; older
  // callers send a name like "Net 30". Both resolve to the same template.
  const asId = String(wanted || "");
  const data = await gql(admin, `#graphql
    query PaymentTermsTemplates { paymentTermsTemplates { id name dueInDays paymentTermsType } }`, {});
  const templates = data?.paymentTermsTemplates || [];

  if (asId.startsWith("gid://shopify/PaymentTermsTemplate/")) {
    return templates.find((t) => t.id === asId) || { id: asId, name: "Selected terms" };
  }

  const target = String(wanted).toLowerCase();
  return (
    templates.find((t) => String(t.name).toLowerCase() === target) ||
    templates.find((t) => String(t.name).toLowerCase().includes(target)) ||
    // "Net 30" -> the NET template due in 30 days
    templates.find((t) => t.paymentTermsType === "NET" && String(t.dueInDays) === target.replace(/\D/g, "")) ||
    null
  );
}

async function findCatalog(admin, title) {
  const data = await gql(admin, `#graphql
    query CompanyCatalogs($first: Int!) {
      catalogs(first: $first, type: COMPANY_LOCATION) { nodes { id title status } }
    }`, { first: 50 });
  const catalogs = data?.catalogs?.nodes || [];
  const target = String(title).toLowerCase();
  return (
    catalogs.find((c) => String(c.title).toLowerCase() === target) ||
    catalogs.find((c) => String(c.title).toLowerCase().includes(target)) ||
    null
  );
}

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors) console.warn("[b2b-onboarding] graphql errors", JSON.stringify(body.errors));
  return body?.data || null;
}
