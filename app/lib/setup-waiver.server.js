/**
 * "Setup charge waived" on a B2B company (HYV-197, James and Bruce, Oct 16).
 *
 * The setup charge applies to retail and distributor orders under USD 500.
 * Hyve staff can waive it for a whole company, with sales director approval,
 * by turning this switch on in Shopify admin (Customers > Companies, under
 * Metafields). It then applies to all that company's future orders.
 *
 * The cart (main-cart-items.liquid, hyve-cart-sync.js) and checkout (the
 * Additional Charges extension) both read it, so the quotation, order and
 * invoice made from them carry the same result. Distributors approved before
 * the rule keep paying no setup charge: the Distributors page turns it on for
 * all of them once.
 */

const NAMESPACE = "hyve";
const KEY = "setup_waived";

const DEFINITION_QUERY = `#graphql
  query SetupWaiverDefinition {
    metafieldDefinitions(first: 1, ownerType: COMPANY, namespace: "${NAMESPACE}", key: "${KEY}") {
      nodes { id type { name } }
    }
  }`;

const DEFINITION_CREATE = `#graphql
  mutation SetupWaiverDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }`;

const WAIVER_SET = `#graphql
  mutation SetupWaiverSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

async function run(admin, query, variables) {
  const body = await (await admin.graphql(query, variables ? { variables } : undefined)).json();
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
  return body?.data;
}

/**
 * Creates the switch if it isn't there yet, pinned so staff see it on the
 * company page. Storefront read lets checkout read it as well as the theme.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function ensureSetupWaiverDefinition(admin) {
  const found = (await run(admin, DEFINITION_QUERY))?.metafieldDefinitions?.nodes?.[0];
  if (found) {
    return found.type?.name === "boolean"
      ? { ok: true, detail: "The switch is in place." }
      : { ok: false, detail: `hyve.${KEY} is defined as ${found.type?.name}, not true or false.` };
  }
  const result = (
    await run(admin, DEFINITION_CREATE, {
      definition: {
        name: "Setup charge waived",
        namespace: NAMESPACE,
        key: KEY,
        type: "boolean",
        ownerType: "COMPANY",
        description:
          "On: no setup charge on any of this company's orders. Needs sales director approval (HYV-197).",
        pin: true,
        access: { storefront: "PUBLIC_READ" },
      },
    })
  )?.metafieldDefinitionCreate;
  const error = result?.userErrors?.[0]?.message;
  return error ? { ok: false, detail: error } : { ok: true, detail: "The switch was created." };
}

/**
 * Turns the switch on for these companies, 25 at a time (metafieldsSet's limit).
 * @param {string[]} companyIds
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function waiveSetupFor(admin, companyIds) {
  const ids = [...new Set(companyIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 25) {
    const saved = (
      await run(admin, WAIVER_SET, {
        metafields: ids.slice(i, i + 25).map((ownerId) => ({
          ownerId,
          namespace: NAMESPACE,
          key: KEY,
          type: "boolean",
          value: "true",
        })),
      })
    )?.metafieldsSet;
    const error = saved?.userErrors?.[0]?.message;
    if (error) return { ok: false, detail: `${i} of ${ids.length} set, then: ${error}` };
  }
  return { ok: true, detail: `Setup charge waived for ${ids.length} distributor${ids.length === 1 ? "" : "s"}.` };
}
