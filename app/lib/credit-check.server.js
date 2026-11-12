/**
 * Credit review by limit and overdue balance (HYV-198, James, Oct 16).
 *
 * A distributor's order is held for credit review only when it:
 *   1. takes the company location over its credit limit (unpaid balance plus
 *      this order above the limit), or
 *   2. is placed while the location has any overdue balance, however small.
 * Everything else goes straight through. Customers without terms pay at
 * checkout and never reach a hold.
 *
 * Staff can set a limit on the company location in Shopify admin ("Credit
 * limit (USD)"). A location without one uses the standard credit limit in
 * Hyve Custom > Commercial Settings (HYV-219, USD 20,000).
 *
 * The app keeps two figures on each location, refreshed when an order is placed,
 * paid or cancelled, and every morning (so a balance that falls overdue is
 * caught): the credit still available and whether anything is overdue. The
 * Additional Charges checkout extension reads them and marks the cart
 * `_hyve_credit_review` when the order needs review. The mark is on the order
 * from the moment it's created, so the order confirmation reads "pending credit
 * review" (Shopify's template checks it) and orders/create puts the order On
 * Hold in Credit Review. Amounts are in the shop currency (USD).
 */

const NAMESPACE = "hyve";
export const CREDIT_REVIEW_ATTRIBUTE = "_hyve_credit_review";

const DEFINITIONS = [
  {
    key: "credit_limit",
    name: "Credit limit (USD)",
    type: "number_decimal",
    pin: true,
    description: "Orders that take the unpaid balance above this are held for credit review. Blank: the standard credit limit in Hyve Custom > Commercial Settings applies.",
  },
  {
    key: "credit_available",
    name: "Credit available (USD)",
    type: "number_decimal",
    pin: false,
    description: "Set by Hyve Custom: the credit limit less the unpaid balance. Read by checkout.",
  },
  {
    key: "credit_overdue",
    name: "Has an overdue balance",
    type: "boolean",
    pin: false,
    description: "Set by Hyve Custom: an unpaid invoice is past its due date. Read by checkout.",
  },
];

const DEFINITIONS_QUERY = `#graphql
  query CreditDefinitions {
    metafieldDefinitions(first: 50, ownerType: COMPANY_LOCATION, namespace: "${NAMESPACE}") {
      nodes { key description }
    }
  }`;

const DEFINITION_CREATE = `#graphql
  mutation CreditDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }`;

const LOCATION_QUERY = `#graphql
  query CreditLocation($id: ID!, $after: String) {
    shop { standardLimit: metafield(namespace: "${NAMESPACE}", key: "standard_credit_limit") { value } }
    companyLocation(id: $id) {
      id
      limit: metafield(namespace: "${NAMESPACE}", key: "credit_limit") { value }
      buyerExperienceConfiguration { checkoutToDraft paymentTermsTemplate { id } }
      orders(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          cancelledAt
          displayFinancialStatus
          totalOutstandingSet { shopMoney { amount } }
          paymentTerms { paymentSchedules(first: 5) { nodes { dueAt completedAt } } }
        }
      }
    }
  }`;

const CREDIT_SET = `#graphql
  mutation CreditSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

const REVIEW_OFF = `#graphql
  mutation CreditReviewOff($id: ID!, $input: CompanyLocationUpdateInput!) {
    companyLocationUpdate(companyLocationId: $id, input: $input) {
      companyLocation { id }
      userErrors { field message }
    }
  }`;

const DEFINITION_UPDATE = `#graphql
  mutation CreditDefinitionUpdate($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id }
      userErrors { field message }
    }
  }`;

async function run(admin, query, variables) {
  const body = await (await admin.graphql(query, variables ? { variables } : undefined)).json();
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
  return body?.data;
}

/**
 * Creates the three location fields if they're missing, and brings an existing
 * field's description up to date, as staff read it under the field in Shopify
 * admin. Storefront read lets checkout see them.
 */
export async function ensureCreditDefinitions(admin) {
  const existing = new Map(
    ((await run(admin, DEFINITIONS_QUERY))?.metafieldDefinitions?.nodes || []).map((d) => [d.key, d.description || ""]),
  );
  for (const d of DEFINITIONS) {
    if (existing.has(d.key)) {
      if (existing.get(d.key) === d.description) continue;
      const updated = (
        await run(admin, DEFINITION_UPDATE, {
          definition: { namespace: NAMESPACE, key: d.key, ownerType: "COMPANY_LOCATION", description: d.description },
        })
      )?.metafieldDefinitionUpdate;
      const updateError = updated?.userErrors?.[0];
      if (updateError) throw new Error(`${d.name}: ${updateError.message}`);
      continue;
    }
    const result = (
      await run(admin, DEFINITION_CREATE, {
        definition: {
          name: d.name,
          namespace: NAMESPACE,
          key: d.key,
          type: d.type,
          ownerType: "COMPANY_LOCATION",
          description: d.description,
          pin: d.pin,
          access: { storefront: "PUBLIC_READ" },
        },
      })
    )?.metafieldDefinitionCreate;
    const error = result?.userErrors?.[0];
    if (error && error.code !== "TAKEN") throw new Error(`${d.name}: ${error.message}`);
  }
}

const UNPAID = new Set(["PENDING", "PARTIALLY_PAID", "AUTHORIZED", "PARTIALLY_REFUNDED"]);

/**
 * The location's unpaid balance and whether any of it is overdue, from its own
 * orders. A cancelled order owes nothing. The limit is the location's own, or
 * the standard credit limit when it has none (`standard` says which).
 * @returns {{limit: number|null, standard: boolean, outstanding: number, overdue: boolean, terms: boolean, review: boolean}}
 */
export async function creditPosition(admin, locationGid, now = new Date()) {
  let after = null;
  let location = null;
  let standardRaw = null;
  let outstanding = 0;
  let overdue = false;
  do {
    const data = await run(admin, LOCATION_QUERY, { id: locationGid, after });
    location = data?.companyLocation;
    if (!location) return null;
    standardRaw = data?.shop?.standardLimit?.value;
    for (const order of location.orders?.nodes || []) {
      if (order.cancelledAt || !UNPAID.has(order.displayFinancialStatus)) continue;
      const owed = Number(order.totalOutstandingSet?.shopMoney?.amount) || 0;
      if (owed <= 0) continue;
      outstanding += owed;
      const late = (order.paymentTerms?.paymentSchedules?.nodes || []).some(
        (s) => s.dueAt && !s.completedAt && new Date(s.dueAt).getTime() < now.getTime(),
      );
      if (late) overdue = true;
    }
    after = location.orders?.pageInfo?.hasNextPage ? location.orders.pageInfo.endCursor : null;
  } while (after);

  const amount = (raw) => (raw != null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null);
  const own = amount(location.limit?.value);
  const limit = own ?? amount(standardRaw);
  return {
    limit,
    standard: own == null && limit != null,
    outstanding: Math.round(outstanding * 100) / 100,
    overdue,
    terms: Boolean(location.buyerExperienceConfiguration?.paymentTermsTemplate?.id),
    review: Boolean(location.buyerExperienceConfiguration?.checkoutToDraft),
  };
}

/**
 * Writes what checkout reads: the credit still available (blank when there's
 * no limit) and whether anything is overdue.
 * @returns {Promise<{ok: boolean, detail: string, position?: object}>}
 */
export async function refreshLocationCredit(admin, locationGid) {
  const position = await creditPosition(admin, locationGid);
  if (!position) return { ok: false, detail: "Location not found." };
  const metafields = [
    { ownerId: locationGid, namespace: NAMESPACE, key: "credit_overdue", type: "boolean", value: String(position.overdue) },
  ];
  if (position.limit != null) {
    metafields.push({
      ownerId: locationGid,
      namespace: NAMESPACE,
      key: "credit_available",
      type: "number_decimal",
      value: (Math.round((position.limit - position.outstanding) * 100) / 100).toFixed(2),
    });
  }
  const saved = (await run(admin, CREDIT_SET, { metafields }))?.metafieldsSet;
  const error = saved?.userErrors?.[0]?.message;
  if (error) return { ok: false, detail: error };
  return {
    ok: true,
    position,
    detail:
      position.limit == null
        ? `No credit limit; ${position.overdue ? "overdue balance" : "nothing overdue"}.`
        : `USD ${(position.limit - position.outstanding).toFixed(2)} of ${position.limit.toFixed(2)}${position.standard ? " (standard limit)" : ""} available${position.overdue ? ", overdue balance" : ""}.`,
  };
}

/**
 * Moves a location with payment terms off Shopify's "submit all orders as
 * drafts for review": its orders now arrive as orders, and only those that
 * need it are held. Then refreshes its credit figures.
 */
export async function useCreditRules(admin, locationGid) {
  const position = await creditPosition(admin, locationGid);
  if (!position) return { ok: false, detail: "Location not found." };
  if (position.review) {
    const updated = (
      await run(admin, REVIEW_OFF, {
        id: locationGid,
        input: { buyerExperienceConfiguration: { checkoutToDraft: false } },
      })
    )?.companyLocationUpdate;
    const error = updated?.userErrors?.[0]?.message;
    if (error) return { ok: false, detail: error };
  }
  return refreshLocationCredit(admin, locationGid);
}

/** The order's company location, when it was bought for a company. */
export function orderLocationGid(payload) {
  const id = payload?.company?.location_id;
  return id ? `gid://shopify/CompanyLocation/${id}` : null;
}

const COMPANY_LOCATIONS = `#graphql
  query CreditCompanyLocations($id: ID!) {
    company(id: $id) { locations(first: 50) { nodes { id } } }
  }`;

/**
 * Every location of these companies, through `step` (refreshLocationCredit or
 * useCreditRules). One location failing doesn't stop the rest.
 * @returns {Promise<{ok: boolean, done: number, failed: string[]}>}
 */
export async function forEachDistributorLocation(admin, companyIds, step) {
  let done = 0;
  const failed = [];
  for (const companyId of [...new Set(companyIds.filter(Boolean))]) {
    const locations = (await run(admin, COMPANY_LOCATIONS, { id: companyId }))?.company?.locations?.nodes || [];
    for (const { id } of locations) {
      try {
        const result = await step(admin, id);
        if (result.ok) done += 1;
        else failed.push(`${id.split("/").pop()}: ${result.detail}`);
      } catch (error) {
        failed.push(`${id.split("/").pop()}: ${error?.message || error}`);
      }
    }
  }
  return { ok: failed.length === 0, done, failed };
}
