/**
 * Bridge between the eligibility API and checkout.
 *
 * Shopify Functions are pure — they can't call your API from inside checkout
 * unless you have the (Enterprise-only) network-access `fetch` target. So the
 * app does the calling: read the customer, ask the API, and write the verdict
 * to an app-owned customer metafield. The validation function then reads that
 * metafield at checkout, which is what Shopify recommends over network access:
 * https://shopify.dev/docs/apps/build/functions/network-access
 */
import { ELIGIBILITY_METAFIELD } from "./eligibility.server";

const API_TIMEOUT_MS = 4000;

/**
 * Resolve a customer, ask the eligibility API, store the verdict on the customer.
 *
 * @param {object} admin  authenticated Admin API client
 * @param {{customerId?:string, email?:string}} target  customer gid or email
 * @returns {Promise<{customer:object, verdict:object, metafield:object|null, userErrors:Array}>}
 */
export async function syncCustomerEligibility(admin, { customerId, email } = {}) {
  const customer = await resolveCustomer(admin, { customerId, email });
  if (!customer) throw new Error("Customer not found");

  const verdict = await askEligibilityApi({
    email: customer.email,
    tags: customer.tags,
  });

  const { metafield, userErrors } = await writeVerdict(admin, customer.id, verdict);
  return { customer, verdict, metafield, userErrors };
}

/** Look the customer up by gid when we have one, otherwise by email. */
async function resolveCustomer(admin, { customerId, email }) {
  const fields = `
    id
    displayName
    defaultEmailAddress { emailAddress }
    tags`;

  if (customerId) {
    const gid = String(customerId).startsWith("gid://")
      ? customerId
      : `gid://shopify/Customer/${customerId}`;
    const response = await admin.graphql(
      `#graphql
      query EligibilityCustomer($id: ID!) {
        customer(id: $id) { ${fields} }
      }`,
      { variables: { id: gid } },
    );
    const body = await response.json();
    return normalize(body?.data?.customer);
  }

  if (!email) return null;
  const response = await admin.graphql(
    `#graphql
    query EligibilityCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        nodes { ${fields} }
      }
    }`,
    { variables: { query: `email:${email}` } },
  );
  const body = await response.json();
  return normalize(body?.data?.customers?.nodes?.[0]);
}

function normalize(node) {
  if (!node) return null;
  return {
    id: node.id,
    displayName: node.displayName || "",
    email: node.defaultEmailAddress?.emailAddress || "",
    tags: node.tags || [],
  };
}

/** Real HTTP call to our own API, so the round trip is actually exercised. */
async function askEligibilityApi({ email, tags }) {
  // eslint-disable-next-line no-undef
  const { SHOPIFY_APP_URL, ELIGIBILITY_API_TOKEN } = process.env;
  if (!SHOPIFY_APP_URL) throw new Error("SHOPIFY_APP_URL is not set");

  const response = await fetch(new URL("/api/eligibility", SHOPIFY_APP_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ELIGIBILITY_API_TOKEN ? { Authorization: `Bearer ${ELIGIBILITY_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({ email, tags }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Eligibility API returned ${response.status}`);
  }
  return response.json();
}

/** Store the verdict where the checkout validation function can read it. */
async function writeVerdict(admin, ownerId, verdict) {
  const response = await admin.graphql(
    `#graphql
    mutation SetEligibilityMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value updatedAt }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: ELIGIBILITY_METAFIELD.namespace,
            key: ELIGIBILITY_METAFIELD.key,
            type: ELIGIBILITY_METAFIELD.type,
            value: JSON.stringify(verdict),
          },
        ],
      },
    },
  );

  const body = await response.json();
  const result = body?.data?.metafieldsSet;
  return {
    metafield: result?.metafields?.[0] || null,
    userErrors: result?.userErrors || body?.errors || [],
  };
}
