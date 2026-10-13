/**
 * The company's tier name (its Price Tier Catalog's title, "Gold") kept on the
 * company as `hyve.tier`, for the product page's tier badge (HYV-178).
 *
 * The catalog decides the price; this field only names it, because the theme
 * can read a company field but not the company's catalogs. It's written
 * whenever a catalog is assigned, changed or removed in Hyve Custom, and every
 * company is put right by the Tier Prices run (daily, and on Update tier
 * prices), which covers companies set up before it existed and catalogs
 * changed in Shopify directly (HYV-192).
 */

const SET = `#graphql
  mutation SetCompanyTier($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

const CLEAR = `#graphql
  mutation ClearCompanyTier($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }`;

/**
 * @param {string} companyGid
 * @param {string|null} tier the catalog's title, or empty to clear it
 */
export async function setCompanyTier(admin, companyGid, tier) {
  if (!admin || !companyGid) return;
  const value = String(tier || "").trim();
  try {
    const response = value
      ? await admin.graphql(SET, {
          variables: {
            metafields: [{ ownerId: companyGid, namespace: "hyve", key: "tier", type: "single_line_text_field", value }],
          },
        })
      : await admin.graphql(CLEAR, { variables: { metafields: [{ ownerId: companyGid, namespace: "hyve", key: "tier" }] } });
    const body = await response.json();
    const errors = body?.data?.metafieldsSet?.userErrors || body?.data?.metafieldsDelete?.userErrors || [];
    if (errors.length) console.warn("[company-tier] update failed", companyGid, JSON.stringify(errors));
  } catch (error) {
    console.warn("[company-tier] update failed", companyGid, error?.message || error);
  }
}

const COMPANIES = `#graphql
  query CompanyTiers($after: String) {
    companies(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        tier: metafield(namespace: "hyve", key: "tier") { value }
        locations(first: 20) { nodes { catalogs(first: 10) { nodes { title status } } } }
      }
    }
  }`;

/**
 * Sets every company's `hyve.tier` to its tier catalog (HYV-192). Only the
 * tier catalogs count (the company catalogs that take a percentage off), so a
 * test catalog never becomes a tier name.
 * @param {string[]} tierTitles titles of the tier catalogs
 * @returns {Promise<{updated: string[], noTier: string[]}>} company names
 */
export async function syncAllCompanyTiers(admin, tierTitles) {
  const tiers = new Set(tierTitles);
  const result = { updated: [], noTier: [] };
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const body = await (await admin.graphql(COMPANIES, { variables: { after } })).json();
    if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
    const block = body?.data?.companies;
    for (const company of block?.nodes || []) {
      const catalogs = (company.locations?.nodes || []).flatMap((l) => l.catalogs?.nodes || []);
      const tier = catalogs.find((c) => c.status === "ACTIVE" && tiers.has(c.title))?.title || "";
      if (!tier) result.noTier.push(company.name);
      if ((company.tier?.value || "") === tier) continue;
      await setCompanyTier(admin, company.id, tier);
      result.updated.push(`${company.name}: ${tier || "cleared"}`);
    }
    if (!block?.pageInfo?.hasNextPage) break;
    after = block.pageInfo.endCursor;
  }
  return result;
}
