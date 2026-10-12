/**
 * A distributor pays in its own currency, wherever it ships (HYV-183).
 *
 * Each company address is a company location, and Shopify takes a location's
 * currency from the market its address falls in: a Hong Kong company that
 * added a Singapore address checked out in SGD there. Hyve's rule (Michael,
 * Oct 8) is the company's currency, the one it chose when it applied
 * (`hyve.preferred_currency`), for every address.
 *
 * So any location whose currency isn't the company's goes into a company
 * location market in that currency, "Distributors - HKD" and so on, made the
 * first time it's needed. A location already in the right currency is left
 * where it is. When the company changes its currency in Settings, its
 * locations leave the old currency's market for the new one: a location can
 * only follow one. Retail markets aren't touched, and duty and freight still
 * follow the ship-to country, which they read from the delivery address.
 */

const COMPANY_QUERY = `#graphql
  query CompanyCurrency($id: ID!) {
    company(id: $id) {
      id
      preferredCurrency: metafield(namespace: "hyve", key: "preferred_currency") { value }
      locations(first: 50) { nodes { id currency } }
    }
  }`;

const MARKETS_QUERY = `#graphql
  query DistributorCurrencyMarkets {
    markets(first: 100) {
      nodes {
        id
        handle
        conditions { companyLocationsCondition { companyLocations(first: 250) { nodes { id } } } }
      }
    }
  }`;

const MARKET_CREATE = `#graphql
  mutation CreateCurrencyMarket($input: MarketCreateInput!) {
    marketCreate(input: $input) {
      market { id }
      userErrors { field message code }
    }
  }`;

const MARKET_ADD = `#graphql
  mutation AddLocationsToMarket($id: ID!, $input: MarketUpdateInput!) {
    marketUpdate(id: $id, input: $input) {
      market { id }
      userErrors { field message code }
    }
  }`;

const HANDLE_PREFIX = "distributors-";
const marketHandle = (currency) => `${HANDLE_PREFIX}${currency.toLowerCase()}`;
const membersOf = (market) =>
  new Set((market.conditions?.companyLocationsCondition?.companyLocations?.nodes || []).map((l) => l.id));

async function run(admin, query, variables) {
  const body = await (await admin.graphql(query, variables ? { variables } : undefined)).json();
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
  return body?.data;
}

/**
 * Puts the company's locations that aren't in its currency into its
 * currency's market.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function keepCompanyCurrency(admin, companyGid) {
  try {
    const company = (await run(admin, COMPANY_QUERY, { id: companyGid }))?.company;
    if (!company) return { ok: false, detail: "Company not found." };

    const currency = String(company.preferredCurrency?.value || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: true, detail: "No preferred currency on the company." };

    const handle = marketHandle(currency);
    const markets = (await run(admin, MARKETS_QUERY))?.markets?.nodes || [];
    const market = markets.find((m) => m.handle === handle);
    const inTarget = market ? membersOf(market) : new Set();
    // Our other currency markets, which a location leaves when the company's
    // currency changes.
    const others = markets.filter((m) => m.handle !== handle && String(m.handle || "").startsWith(HANDLE_PREFIX));

    const locations = company.locations?.nodes || [];
    const leaving = new Map();
    for (const other of others) {
      const members = membersOf(other);
      const ids = locations.map((l) => l.id).filter((id) => members.has(id));
      if (ids.length) leaving.set(other.id, ids);
    }
    const wasElsewhere = new Set([...leaving.values()].flat());
    // A location moving out of another currency market goes into this one; any
    // other goes in only if its own market's currency isn't the company's.
    const moving = locations
      .filter((l) => !inTarget.has(l.id) && (wasElsewhere.has(l.id) || l.currency !== currency))
      .map((l) => l.id);

    for (const [marketId, ids] of leaving) {
      const left = (
        await run(admin, MARKET_ADD, {
          id: marketId,
          input: { conditions: { conditionsToDelete: { companyLocationsCondition: { companyLocationIds: ids } } } },
        })
      )?.marketUpdate;
      if (left?.userErrors?.length) {
        console.error("[company-currency] leaving market failed", companyGid, JSON.stringify(left.userErrors));
        return { ok: false, detail: left.userErrors[0].message };
      }
    }
    if (!moving.length) return { ok: true, detail: `Every address already checks out in ${currency}.` };

    const result = market
      ? (
          await run(admin, MARKET_ADD, {
            id: market.id,
            input: { conditions: { conditionsToAdd: { companyLocationsCondition: { companyLocationIds: moving } } } },
          })
        )?.marketUpdate
      : (
          await run(admin, MARKET_CREATE, {
            input: {
              name: `Distributors - ${currency}`,
              handle,
              status: "ACTIVE",
              conditions: { companyLocationsCondition: { companyLocationIds: moving } },
              currencySettings: { baseCurrency: currency, localCurrencies: false },
            },
          })
        )?.marketCreate;

    const error = result?.userErrors?.[0]?.message;
    if (error) {
      console.error("[company-currency] market update failed", companyGid, currency, JSON.stringify(result.userErrors));
      return { ok: false, detail: error };
    }
    return { ok: true, detail: `${moving.length} address${moving.length === 1 ? "" : "es"} set to ${currency}.` };
  } catch (error) {
    console.error("[company-currency] failed", companyGid, error?.message || error);
    return { ok: false, detail: error?.message || "Couldn't set the currency." };
  }
}
