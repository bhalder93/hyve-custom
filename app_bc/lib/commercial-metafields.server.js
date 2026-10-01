/**
 * The commercial-terms metafields on a B2B company location.
 *
 * These are created by the app rather than by hand, for one reason: a metafield
 * written with a type that doesn't match its definition is rejected. A limit
 * defined as text and written as money silently doesn't save.
 *
 * Credit is not here: that turned out to be Shopify's own store credit, which
 * the portal reads straight off the company location.
 */

const OWNER_TYPE = "COMPANY_LOCATION";
const NAMESPACE = "hyve";

export const COMMERCIAL_DEFINITIONS = [
  { key: "sales_rep", name: "Sales Rep", type: "single_line_text_field", description: "The buyer's named contact, shown in their portal." },
  { key: "sales_rep_email", name: "Sales Rep Email", type: "single_line_text_field", description: "Powers the Email Representative button." },
  { key: "sales_rep_phone", name: "Sales Rep Phone", type: "single_line_text_field", description: "Powers the Chat on WhatsApp button." },
];

/**
 * Creates any definition that's missing, and reports any that exists with the
 * wrong type — that one can't be fixed from here, because Shopify won't change
 * a definition's type once data may exist under it.
 *
 * @returns {Promise<{ok:boolean, steps:object[]}>} one step per problem; an
 *   all-clear returns no steps, so a healthy approval stays quiet.
 */
export async function ensureCommercialDefinitions(admin) {
  if (!admin) return { ok: false, steps: [{ name: "metafields", ok: false, detail: "No admin client." }] };

  const existing = await readDefinitions(admin);
  if (existing == null) {
    return { ok: false, steps: [{ name: "metafields", ok: false, detail: "Could not read the existing metafield definitions." }] };
  }

  const steps = [];

  for (const wanted of COMMERCIAL_DEFINITIONS) {
    const found = existing.find((d) => d.key === wanted.key);

    if (found) {
      // Shopify reports the type by name, e.g. "money" or "single_line_text_field".
      if (found.type?.name !== wanted.type) {
        steps.push({
          name: `metafield ${wanted.key}`,
          ok: false,
          detail: `Defined as ${found.type?.name} but must be ${wanted.type}. Delete the "${found.name}" definition in Settings → Custom data → Company locations and approve again.`,
        });
      }
      continue;
    }

    const error = await createDefinition(admin, wanted);
    if (error) {
      steps.push({ name: `metafield ${wanted.key}`, ok: false, detail: error });
    }
  }

  return { ok: steps.every((s) => s.ok), steps };
}

async function readDefinitions(admin) {
  try {
    const response = await admin.graphql(
      `#graphql
      query CommercialDefinitions($ownerType: MetafieldOwnerType!, $namespace: String!) {
        metafieldDefinitions(first: 25, ownerType: $ownerType, namespace: $namespace) {
          nodes { id key name type { name } }
        }
      }`,
      { variables: { ownerType: OWNER_TYPE, namespace: NAMESPACE } },
    );
    const body = await response.json();
    if (body?.errors) {
      console.warn("[commercial-metafields] read failed", JSON.stringify(body.errors));
      return null;
    }
    return body?.data?.metafieldDefinitions?.nodes || [];
  } catch (error) {
    console.error("[commercial-metafields] read threw", error);
    return null;
  }
}

/** @returns {Promise<?string>} the error message, or null when it worked */
async function createDefinition(admin, wanted) {
  try {
    const response = await admin.graphql(
      `#graphql
      mutation CreateCommercialDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id key }
          userErrors { field message code }
        }
      }`,
      {
        variables: {
          definition: {
            ownerType: OWNER_TYPE,
            namespace: NAMESPACE,
            key: wanted.key,
            name: wanted.name,
            description: wanted.description,
            type: wanted.type,
          },
        },
      },
    );
    const body = await response.json();
    if (body?.errors) return JSON.stringify(body.errors);

    const userError = body?.data?.metafieldDefinitionCreate?.userErrors?.[0];
    // A definition created between our read and this write is not a problem.
    if (userError && userError.code === "TAKEN") return null;
    return userError?.message || null;
  } catch (error) {
    console.error("[commercial-metafields] create threw", error);
    return error?.message || "Could not create the definition.";
  }
}
