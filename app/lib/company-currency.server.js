/**
 * A distributor pays in its own currency, wherever it ships (HYV-183).
 *
 * Each company address is a company location, and Shopify takes a location's
 * currency from the market its address falls in: a Hong Kong company that
 * added a Singapore address checked out in SGD there. Hyve's rule (Michael,
 * Oct 8) is the company's currency, the one it chose when it applied
 * (`hyve.preferred_currency`), for every address.
 *
 * So every location of the company goes into a company location market in
 * that currency, "Distributors - HKD" and so on, made the first time it's
 * needed. Every one, not only those in another currency: tier prices are kept
 * in USD and each market converts them with its own rate and rounding, so a
 * Hong Kong address left in the Hong Kong market priced a tumbler at HKD 60.90
 * while the company's Singapore address priced it at HKD 59.48 (HYV-183).
 *
 * The distributor market converts as Hyve's own market in that currency does
 * (Hong Kong SAR for HKD: its manual rate and its rounding), copied each time
 * this runs, so a rate changed there reaches distributors too.
 *
 * When the company changes its currency in Settings, its locations leave the
 * old currency's market for the new one: a location can only follow one.
 * Retail markets aren't touched, and duty and freight still follow the
 * ship-to country, which they read from the delivery address.
 */

const COMPANY_QUERY = `#graphql
  query CompanyCurrency($id: ID!) {
    company(id: $id) {
      id
      preferredCurrency: metafield(namespace: "hyve", key: "preferred_currency") { value }
      locations(first: 50) { nodes { id } }
    }
  }`;

const MARKETS_QUERY = `#graphql
  query DistributorCurrencyMarkets {
    markets(first: 100) {
      nodes {
        id
        handle
        name
        status
        currencySettings {
          baseCurrency { currencyCode manualRate }
          localCurrencies
          roundingEnabled
        }
      }
    }
  }`;

// Members are read one distributor market at a time: asking for 250 members
// of each of 100 markets in one query goes over Shopify's 1,000-point limit.
const MARKET_MEMBERS_QUERY = `#graphql
  query DistributorMarketMembers($id: ID!) {
    market(id: $id) {
      conditions { companyLocationsCondition { companyLocations(first: 250) { nodes { id } } } }
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
const isDistributorMarket = (market) => String(market?.handle || "").startsWith(HANDLE_PREFIX);

/**
 * How Hyve's own active market in this currency converts it: its manual rate
 * (null for automatic) and rounding. Null when there's no such market, or
 * when two of them disagree, as there's then no single answer to copy.
 */
function conversionFor(markets, currency) {
  const sources = markets.filter(
    (m) => !isDistributorMarket(m) && m.status === "ACTIVE" && m.currencySettings?.baseCurrency?.currencyCode === currency,
  );
  const settings = sources.map((m) => ({
    manualRate: m.currencySettings.baseCurrency.manualRate ?? null,
    roundingEnabled: Boolean(m.currencySettings.roundingEnabled),
  }));
  const distinct = new Set(settings.map((x) => JSON.stringify(x)));
  if (distinct.size > 1) {
    console.warn("[company-currency] markets in", currency, "convert differently; left automatic:", sources.map((m) => m.name).join(", "));
    return null;
  }
  return settings[0] || null;
}

function currencySettingsFor(currency, conversion) {
  return {
    baseCurrency: currency,
    localCurrencies: false,
    ...(conversion ? { baseCurrencyManualRate: conversion.manualRate, roundingEnabled: conversion.roundingEnabled } : {}),
  };
}

function convertsAs(market, conversion) {
  if (!conversion) return true;
  const settings = market.currencySettings || {};
  const rate = settings.baseCurrency?.manualRate ?? null;
  const sameRate = rate === null || conversion.manualRate === null ? rate === conversion.manualRate : Number(rate) === Number(conversion.manualRate);
  return sameRate && Boolean(settings.roundingEnabled) === conversion.roundingEnabled;
}
const marketHandle = (currency) => `${HANDLE_PREFIX}${currency.toLowerCase()}`;
const membersOf = (market) =>
  new Set((market.conditions?.companyLocationsCondition?.companyLocations?.nodes || []).map((l) => l.id));

async function run(admin, query, variables) {
  const body = await (await admin.graphql(query, variables ? { variables } : undefined)).json();
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
  return body?.data;
}

/**
 * Puts every location of the company into its currency's market.
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
    for (const m of markets.filter(isDistributorMarket)) {
      m.conditions = (await run(admin, MARKET_MEMBERS_QUERY, { id: m.id }))?.market?.conditions || null;
    }
    const market = markets.find((m) => m.handle === handle);
    const inTarget = market ? membersOf(market) : new Set();
    // Our other currency markets, which a location leaves when the company's
    // currency changes.
    const others = markets.filter((m) => m.handle !== handle && isDistributorMarket(m));
    const conversion = conversionFor(markets, currency);

    const locations = company.locations?.nodes || [];
    const leaving = new Map();
    for (const other of others) {
      const members = membersOf(other);
      const ids = locations.map((l) => l.id).filter((id) => members.has(id));
      if (ids.length) leaving.set(other.id, ids);
    }
    const moving = locations.filter((l) => !inTarget.has(l.id)).map((l) => l.id);

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
    // Keep the existing market converting as Hyve's own market does.
    if (market && !convertsAs(market, conversion)) {
      const synced = (
        await run(admin, MARKET_ADD, { id: market.id, input: { currencySettings: currencySettingsFor(currency, conversion) } })
      )?.marketUpdate;
      if (synced?.userErrors?.length) {
        console.error("[company-currency] rate sync failed", currency, JSON.stringify(synced.userErrors));
        return { ok: false, detail: synced.userErrors[0].message };
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
              currencySettings: currencySettingsFor(currency, conversion),
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
