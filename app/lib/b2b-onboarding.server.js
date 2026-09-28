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
 *   4. the tier catalog on the location  catalogContextUpdate
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
  {
    paymentTerms,
    catalogId,
    salesRep,
    salesRepEmail,
    salesRepPhone,
    taxRegistrationNumber,
    preferredCurrency,
  } = {},
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

  // 4. The pricing tier: the catalog picked on the approval screen, from the
  // store's own list (HYV-79). Added to the catalog's companies, never set as
  // its whole list: catalogContextUpdate only adds, so approving one
  // distributor can't take the tier away from the others on it.
  if (catalogId) {
    const res = await gql(admin, `#graphql
      mutation AssignCatalog($catalogId: ID!, $contextsToAdd: CatalogContextInput) {
        catalogContextUpdate(catalogId: $catalogId, contextsToAdd: $contextsToAdd) {
          catalog { id title }
          userErrors { field message code }
        }
      }`, {
      catalogId,
      contextsToAdd: { companyLocationIds: [locationId] },
    });
    const err = res?.catalogContextUpdate?.userErrors?.[0];
    const title = res?.catalogContextUpdate?.catalog?.title;
    record("tier catalog", !err && Boolean(title), err ? err.message : title || "Shopify didn't attach the catalog.");
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

  // 6. What the application already told us about the company, kept on it
  // as its profile (company-profile.server.js), so Settings starts filled in:
  //  - the tax registration number, which the invoice PDF prints (K3), since a
  //    distributor's own tax number has to appear on what they file
  //  - the currency it buys in (HYV-79)
  const profileFields = [
    ["tax_registration_number", "tax registration number", taxRegistrationNumber],
    ["preferred_currency", "preferred currency", preferredCurrency],
  ].filter(([, , value]) => String(value || "").trim());

  if (profileFields.length) {
    const res = await gql(admin, `#graphql
      mutation SetCompanyProfile($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message code }
        }
      }`, {
      metafields: profileFields.map(([key, , value]) => ({
        ownerId: companyGid,
        namespace: "hyve",
        key,
        type: "single_line_text_field",
        value: String(value).trim(),
      })),
    });
    const err = res?.metafieldsSet?.userErrors?.[0];
    for (const [, name, value] of profileFields) {
      record(name, !err, err ? err.message : String(value).trim());
    }
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

/**
 * The store's B2B catalogs, for the approval screen's pricing tier list. Each
 * tier is a catalog (Platinum, Gold, Silver, Bronze), so picking from this
 * list means a typo can't leave a distributor on retail pricing (HYV-79).
 *
 * @returns {Promise<{id:string, title:string, status:string}[]>}
 */
export async function listTierCatalogs(admin) {
  const data = await gql(admin, `#graphql
    query CompanyCatalogs($first: Int!) {
      catalogs(first: $first, type: COMPANY_LOCATION) { nodes { id title status } }
    }`, { first: 50 });
  return data?.catalogs?.nodes || [];
}

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors) console.warn("[b2b-onboarding] graphql errors", JSON.stringify(body.errors));
  return body?.data || null;
}
