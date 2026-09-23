/**
 * The order fields customer service fills in by hand.
 *
 * Only the commercial ones. The production fields — proof, production photo,
 * on-hold reason — belong to the SLA engine, which declares them in the app
 * configuration under its own namespace; defining them here as well would put
 * a second, always-empty copy on every order page.
 *
 * A metafield with no definition still holds a value, but it does not appear on
 * the order page in the Shopify admin — so there is nowhere for staff to type
 * it. Defining them is what makes the estimated ship date something customer
 * service can actually set, rather than something only the app can write.
 *
 * The types match what the order webhooks already write. Shopify rejects a
 * value whose type disagrees with its definition, and will not change a type
 * once data exists, so these must not drift.
 */

const OWNER_TYPE = "ORDER";
const NAMESPACE = "hyve";

export const ORDER_DEFINITIONS = [
  {
    key: "estimated_ship_date",
    name: "Estimated Ship Date",
    type: "date",
    description: "Set by customer service against the published lead time. Shown to the buyer on the order.",
  },
  {
    key: "proof_due_at",
    name: "Proof Due",
    type: "date_time",
    description: "When the proof needs approving by. Drives the action-required line and the reminders.",
  },
  {
    key: "po_number",
    name: "PO Number",
    type: "single_line_text_field",
    description: "The buyer's purchase order number, printed on the invoice.",
  },
  {
    key: "incoterm",
    name: "Incoterm",
    type: "single_line_text_field",
    description: "EXW, FOB or DDP. Printed on the invoice.",
  },
  {
    key: "forwarder",
    name: "Forwarder",
    type: "single_line_text_field",
    description: "The buyer's nominated freight forwarder, for FOB orders.",
  },
];

const EXISTING_QUERY = `#graphql
  query OrderDefinitions($ownerType: MetafieldOwnerType!, $namespace: String!) {
    metafieldDefinitions(first: 50, ownerType: $ownerType, namespace: $namespace) {
      nodes { key type { name } }
    }
  }`;

const CREATE_MUTATION = `#graphql
  mutation CreateOrderDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message code }
    }
  }`;

/**
 * Creates any definition that is missing, and reports any that exists with the
 * wrong type — that one cannot be fixed from here, because Shopify will not
 * change a definition's type once data may exist under it.
 *
 * @returns {Promise<{ok: boolean, steps: object[]}>} one step per problem, so a
 *   healthy store stays quiet.
 */
export async function ensureOrderDefinitions(admin) {
  if (!admin) return { ok: false, steps: [{ name: "order metafields", ok: false, detail: "No admin client." }] };

  const steps = [];

  let existing = new Map();
  try {
    const response = await admin.graphql(EXISTING_QUERY, {
      variables: { ownerType: OWNER_TYPE, namespace: NAMESPACE },
    });
    const body = await response.json();
    if (body?.errors) throw new Error(body.errors[0]?.message || "Could not read the definitions.");
    existing = new Map(
      (body?.data?.metafieldDefinitions?.nodes || []).map((node) => [node.key, node.type?.name]),
    );
  } catch (error) {
    return {
      ok: false,
      steps: [{ name: "order metafields", ok: false, detail: error?.message || String(error) }],
    };
  }

  for (const wanted of ORDER_DEFINITIONS) {
    const have = existing.get(wanted.key);

    if (have && have !== wanted.type) {
      steps.push({
        name: wanted.name,
        ok: false,
        detail: `Defined as ${have}, needs ${wanted.type}. Shopify cannot change a type in place — delete the definition in the admin and reopen this page.`,
      });
      continue;
    }
    if (have) continue;

    try {
      const response = await admin.graphql(CREATE_MUTATION, {
        variables: {
          definition: {
            ownerType: OWNER_TYPE,
            namespace: NAMESPACE,
            key: wanted.key,
            name: wanted.name,
            type: wanted.type,
            description: wanted.description,
            access: { admin: "MERCHANT_READ_WRITE" },
          },
        },
      });
      const body = await response.json();
      const error = body?.data?.metafieldDefinitionCreate?.userErrors?.[0];

      if (error && error.code !== "TAKEN") {
        steps.push({ name: wanted.name, ok: false, detail: error.message });
      }
    } catch (error) {
      steps.push({ name: wanted.name, ok: false, detail: error?.message || String(error) });
    }
  }

  return { ok: steps.length === 0, steps };
}
