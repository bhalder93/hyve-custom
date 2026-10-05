/**
 * Tier prices (HYV-80).
 *
 * Distributor pricing lives in the four tier catalogs (Copper, Silver, Gold,
 * Diamond), so every surface that prices from Shopify gets it, staff-made draft
 * orders included. Each tier has a percentage off in its catalog. Shopify only
 * applies that percentage to a product with no fixed price, and volume pricing
 * breaks are always fixed amounts, so the breaks can't follow the percentage on
 * their own. This module writes them: each tier's fixed price and breaks are the
 * product's B2B break ladder less that catalog's percentage.
 *
 * The ladder is one per product, in the `hyve.blank_pricing` metafield (JSON):
 *
 *   {
 *     "currency": "USD",
 *     "breaks": [{ "min_qty": 1, "price": 5.31 }, { "min_qty": 50, "price": 5.19 }],
 *     "variants": { "51304520220888": [{ "min_qty": 1, "price": 5.40 }] }
 *   }
 *
 * The first row is the price below the first break. `breaks` applies to every
 * variant; `variants` (optional, keyed by variant ID) holds a variant whose
 * ladder differs. Prices are in the catalogs' currency, the store currency.
 *
 * Setup, rush and gift (the Additional Charges product) and the import duties
 * line are written at their normal price in every tier: the tier discount is on
 * products only (Michael and Bruce, Oct 4). A product with no ladder has its
 * fixed prices removed, so the catalog percentage applies to it.
 */

export const LADDER_NAMESPACE = "hyve";
export const LADDER_KEY = "blank_pricing";

/** Products every tier sells at their normal price: the theme's utility lines. */
const FULL_PRICE_HANDLES = new Set(["additional-charges", "import-duties-taxes-included"]);

/** Variants per quantityPricingByVariantUpdate call, and breaks per call. */
const MAX_VARIANTS_PER_CALL = 50;
const MAX_BREAKS_PER_CALL = 250;

/* -------------------------------------------------------------------------- */
/* Admin API                                                                   */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Admin API call. Rewriting four catalogs is a few hundred calls, so a
 * THROTTLED response waits for the bucket to refill instead of failing the run.
 */
async function gql(admin, query, variables) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await admin.graphql(query, variables ? { variables } : undefined);
    const body = await response.json();
    const throttled = (body?.errors || []).some((error) => error?.extensions?.code === "THROTTLED");
    if (throttled && attempt < 6) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (body?.errors?.length) {
      throw new Error(body.errors.map((error) => error?.message).filter(Boolean).join(", "));
    }
    return body.data;
  }
}

/** Every page of a connection. `pick` returns the connection from the data. */
async function allPages(admin, query, pick, variables = {}) {
  const nodes = [];
  let after = null;
  do {
    const connection = pick(await gql(admin, query, { ...variables, after }));
    nodes.push(...(connection?.nodes || []));
    after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

const numericId = (gid) => String(gid || "").split("/").pop();

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

const CATALOGS_QUERY = `#graphql
  query TierCatalogs($after: String) {
    catalogs(first: 50, after: $after, type: COMPANY_LOCATION) {
      nodes {
        id
        title
        status
        ... on CompanyLocationCatalog {
          companyLocationsCount { count }
        }
        priceList {
          id
          currency
          parent {
            adjustment {
              type
              value
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/** Company location catalogs, with the percentage each one takes off. */
export async function listCompanyCatalogs(admin) {
  const nodes = await allPages(admin, CATALOGS_QUERY, (data) => data?.catalogs);
  return nodes
    .map((node) => {
      const adjustment = node.priceList?.parent?.adjustment || null;
      return {
        id: node.id,
        title: node.title || "Untitled catalog",
        status: node.status,
        companyLocations: node.companyLocationsCount?.count ?? 0,
        priceListId: node.priceList?.id || null,
        currency: node.priceList?.currency || null,
        adjustment: adjustment ? { type: adjustment.type, value: Number(adjustment.value) || 0 } : null,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** "15% off", "5% more" or "No adjustment", for the page. */
export function describeAdjustment(adjustment) {
  if (!adjustment || !adjustment.value) return "No adjustment";
  return adjustment.type === "PERCENTAGE_INCREASE" ? `${adjustment.value}% more` : `${adjustment.value}% off`;
}

const FIXED_PRICES_QUERY = `#graphql
  query PriceListFixedPrices($id: ID!, $after: String) {
    priceList(id: $id) {
      id
      currency
      prices(first: 50, after: $after, originType: FIXED) {
        nodes {
          variant {
            id
            product { id }
          }
          price { amount currencyCode }
          quantityPriceBreaks(first: 12) {
            nodes {
              minimumQuantity
              price { amount }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

/** A price list's fixed prices, each with its volume pricing breaks. */
async function loadFixedPrices(admin, priceListId) {
  const nodes = await allPages(admin, FIXED_PRICES_QUERY, (data) => data?.priceList?.prices, { id: priceListId });
  return nodes
    .filter((node) => node?.variant?.id)
    .map((node) => ({
      variantId: node.variant.id,
      productId: node.variant.product?.id || null,
      price: Number(node.price?.amount),
      currency: node.price?.currencyCode || null,
      breaks: (node.quantityPriceBreaks?.nodes || []).map((pb) => ({
        min_qty: Number(pb.minimumQuantity),
        price: Number(pb.price?.amount),
      })),
    }));
}

const PRODUCTS_QUERY = `#graphql
  query LadderProducts($after: String) {
    products(first: 250, after: $after) {
      nodes {
        id
        title
        handle
        ladder: metafield(namespace: "${LADDER_NAMESPACE}", key: "${LADDER_KEY}") {
          jsonValue
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

async function loadProducts(admin) {
  const nodes = await allPages(admin, PRODUCTS_QUERY, (data) => data?.products);
  return nodes.map((node) => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
    ladderJson: node.ladder ? node.ladder.jsonValue : null,
  }));
}

const VARIANTS_QUERY = `#graphql
  query AllVariants($after: String) {
    productVariants(first: 250, after: $after) {
      nodes {
        id
        price
        product { id }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/** Product ID -> its variants, with their normal (store currency) price. */
async function loadVariantsByProduct(admin) {
  const nodes = await allPages(admin, VARIANTS_QUERY, (data) => data?.productVariants);
  const byProduct = new Map();
  for (const node of nodes) {
    const productId = node.product?.id;
    if (!productId) continue;
    if (!byProduct.has(productId)) byProduct.set(productId, []);
    byProduct.get(productId).push({ id: node.id, price: Number(node.price) });
  }
  return byProduct;
}

const SHOP_CURRENCY_QUERY = `#graphql
  query StoreCurrency {
    shop { currencyCode }
  }`;

async function loadStoreCurrency(admin) {
  return (await gql(admin, SHOP_CURRENCY_QUERY))?.shop?.currencyCode || null;
}

const DEFINITION_QUERY = `#graphql
  query BlankPricingDefinition {
    metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "${LADDER_NAMESPACE}", key: "${LADDER_KEY}") {
      nodes {
        id
        type { name }
      }
    }
  }`;

/** The metafield definition, or null. The ladder needs it to be JSON. */
export async function loadLadderDefinition(admin) {
  const node = (await gql(admin, DEFINITION_QUERY))?.metafieldDefinitions?.nodes?.[0];
  return node ? { id: node.id, type: node.type?.name || "" } : null;
}

/* -------------------------------------------------------------------------- */
/* The ladder                                                                  */
/* -------------------------------------------------------------------------- */

const toCents = (amount) => Math.round(Number(amount) * 100);
const fromCents = (cents) => (cents / 100).toFixed(2);

/** Rows sorted and checked: whole quantities, positive prices, no repeats. */
function cleanRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const clean = rows
    .map((row) => ({ min_qty: Number(row?.min_qty), price: Number(row?.price) }))
    .sort((a, b) => a.min_qty - b.min_qty);
  const valid = clean.every(
    (row, index) =>
      Number.isInteger(row.min_qty) &&
      row.min_qty >= 1 &&
      Number.isFinite(row.price) &&
      row.price > 0 &&
      (index === 0 || row.min_qty > clean[index - 1].min_qty),
  );
  return valid ? clean : null;
}

/**
 * The ladder from the metafield, or { error } when it can't be used. A product
 * with a broken ladder is reported and left alone rather than guessed at.
 */
export function parseLadder(json) {
  if (json == null) return null;
  const value = typeof json === "string" ? safeJson(json) : json;
  if (!value || typeof value !== "object") return { error: "The value isn't JSON." };

  const breaks = value.breaks == null ? null : cleanRows(value.breaks);
  if (value.breaks != null && !breaks) return { error: "`breaks` needs rows of whole min_qty and a price above 0." };

  const variants = {};
  for (const [key, rows] of Object.entries(value.variants || {})) {
    const clean = cleanRows(rows);
    if (!clean) return { error: `The rows for variant ${key} need whole min_qty and a price above 0.` };
    variants[numericId(key)] = clean;
  }
  if (!breaks && !Object.keys(variants).length) return { error: "No `breaks` or `variants` rows." };

  return { currency: value.currency ? String(value.currency).toUpperCase() : null, breaks, variants };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The rows that price one variant: its own, else the product's. */
function rowsForVariant(ladder, variantId) {
  return ladder.variants[numericId(variantId)] || ladder.breaks || null;
}

/** A price after the catalog's adjustment, rounded to the cent. */
function adjustedCents(cents, adjustment) {
  const value = Number(adjustment?.value) || 0;
  const factor = adjustment?.type === "PERCENTAGE_INCREASE" ? 100 + value : 100 - value;
  return Math.round((cents * factor) / 100);
}

/** How many products have a usable ladder, and which ladders can't be used. */
export async function ladderSummary(admin) {
  const products = await loadProducts(admin);
  let withLadder = 0;
  const invalid = [];
  for (const product of products) {
    if (FULL_PRICE_HANDLES.has(product.handle)) continue;
    const ladder = parseLadder(product.ladderJson);
    if (!ladder) continue;
    if (ladder.error) invalid.push({ product: product.title, message: ladder.error });
    else withLadder += 1;
  }
  return { products: products.length, withLadder, invalid };
}

/* -------------------------------------------------------------------------- */
/* Update tier prices                                                          */
/* -------------------------------------------------------------------------- */

const UPDATE_MUTATION = `#graphql
  mutation SetTierPrices($priceListId: ID!, $input: QuantityPricingByVariantUpdateInput!) {
    quantityPricingByVariantUpdate(priceListId: $priceListId, input: $input) {
      productVariants { id }
      userErrors { field message code }
    }
  }`;

/**
 * One product's change on one price list: the fixed prices to write, the
 * breaks to write, and what to clear first. Shopify runs the deletes before the
 * adds, so a variant's old breaks go before its new ones arrive.
 */
function emptyChange() {
  return { prices: [], breaks: [], deletePrices: [], deleteBreaksOf: [] };
}

function mergeInput(changes) {
  const input = {
    pricesToAdd: [],
    pricesToDeleteByVariantId: [],
    quantityPriceBreaksToAdd: [],
    quantityPriceBreaksToDelete: [],
    quantityPriceBreaksToDeleteByVariantId: [],
    quantityRulesToAdd: [],
    quantityRulesToDeleteByVariantId: [],
  };
  for (const change of changes) {
    input.pricesToAdd.push(...change.prices);
    input.pricesToDeleteByVariantId.push(...change.deletePrices);
    input.quantityPriceBreaksToAdd.push(...change.breaks);
    input.quantityPriceBreaksToDeleteByVariantId.push(...change.deleteBreaksOf);
  }
  return input;
}

const variantCount = (change) => change.prices.length + change.deletePrices.length;

/** Products grouped into calls that stay inside the per-call limits. */
function batches(changes) {
  const out = [];
  let current = [];
  let variants = 0;
  let breaks = 0;
  for (const change of changes) {
    const v = variantCount(change);
    const b = change.breaks.length;
    if (current.length && (variants + v > MAX_VARIANTS_PER_CALL || breaks + b > MAX_BREAKS_PER_CALL)) {
      out.push(current);
      current = [];
      variants = 0;
      breaks = 0;
    }
    current.push(change);
    variants += v;
    breaks += b;
  }
  if (current.length) out.push(current);
  return out;
}

async function sendChanges(admin, priceListId, changes) {
  const data = await gql(admin, UPDATE_MUTATION, { priceListId, input: mergeInput(changes) });
  return data?.quantityPricingByVariantUpdate?.userErrors || [];
}

/**
 * Sends a catalog's changes. A call is all-or-nothing, so when one fails its
 * products are retried one by one: the rest still go through, and the error
 * names the product that caused it.
 */
async function applyChanges(admin, priceListId, changes, report) {
  for (const batch of batches(changes)) {
    let errors;
    try {
      errors = await sendChanges(admin, priceListId, batch);
    } catch (error) {
      errors = [{ message: error?.message || String(error) }];
    }
    if (!errors.length) {
      for (const change of batch) report.count(change);
      continue;
    }
    for (const change of batch) {
      let productErrors;
      try {
        productErrors = batch.length === 1 ? errors : await sendChanges(admin, priceListId, [change]);
      } catch (error) {
        productErrors = [{ message: error?.message || String(error) }];
      }
      if (productErrors.length) {
        report.error(change.title, productErrors.map((error) => error.message).join("; "));
      } else {
        report.count(change);
      }
    }
  }
}

/**
 * Rewrites the chosen catalogs' fixed prices and breaks from the ladders.
 * Returns one summary per catalog.
 */
export async function updateTierPrices(admin, catalogIds) {
  const wanted = new Set(catalogIds || []);
  const catalogs = (await listCompanyCatalogs(admin)).filter((catalog) => wanted.has(catalog.id));
  if (!catalogs.length) throw new Error("Choose at least one catalog.");

  const [products, variantsByProduct, storeCurrency] = await Promise.all([
    loadProducts(admin),
    loadVariantsByProduct(admin),
    loadStoreCurrency(admin),
  ]);

  const ladders = new Map();
  const ladderErrors = [];
  const fullPrice = new Set();
  for (const product of products) {
    if (FULL_PRICE_HANDLES.has(product.handle)) {
      fullPrice.add(product.id);
      continue;
    }
    const ladder = parseLadder(product.ladderJson);
    if (!ladder) continue;
    if (ladder.error) ladderErrors.push({ product: product.title, message: ladder.error });
    else ladders.set(product.id, { ...ladder, title: product.title });
  }
  const titleOf = new Map(products.map((product) => [product.id, product.title]));

  const results = [];
  for (const catalog of catalogs) {
    const result = {
      catalogId: catalog.id,
      title: catalog.title,
      adjustment: describeAdjustment(catalog.adjustment),
      laddered: 0,
      fullPrice: 0,
      cleared: 0,
      errors: [],
    };
    results.push(result);

    if (!catalog.priceListId) {
      result.errors.push({ product: "", message: "This catalog has no price list, so there is nothing to price." });
      continue;
    }

    const currency = catalog.currency;
    if (currency !== storeCurrency) {
      // Normal prices are in the store currency, so a catalog priced in another
      // one would be handed the wrong amounts. Left alone and reported.
      result.errors.push({ product: "", message: `This catalog prices in ${currency}, not ${storeCurrency}, so it was left as it is.` });
      continue;
    }

    const existing = await loadFixedPrices(admin, catalog.priceListId);
    const hasBreaks = new Set(existing.filter((price) => price.breaks.length).map((price) => price.variantId));

    const changes = [];
    const changeFor = (productId) => ({ ...emptyChange(), productId, title: titleOf.get(productId) || productId });

    // Ladder products: fixed price and breaks, less the catalog's percentage.
    for (const [productId, ladder] of ladders) {
      if (ladder.currency && ladder.currency !== currency) {
        result.errors.push({
          product: ladder.title,
          message: `Its ladder is in ${ladder.currency} and this catalog prices in ${currency}.`,
        });
        continue;
      }
      const change = { ...changeFor(productId), kind: "laddered" };
      for (const variant of variantsByProduct.get(productId) || []) {
        const rows = rowsForVariant(ladder, variant.id);
        if (!rows) continue;
        const [base, ...rest] = rows;
        change.prices.push({
          variantId: variant.id,
          price: { amount: fromCents(adjustedCents(toCents(base.price), catalog.adjustment)), currencyCode: currency },
        });
        if (hasBreaks.has(variant.id)) change.deleteBreaksOf.push(variant.id);
        for (const row of rest) {
          change.breaks.push({
            variantId: variant.id,
            minimumQuantity: row.min_qty,
            price: { amount: fromCents(adjustedCents(toCents(row.price), catalog.adjustment)), currencyCode: currency },
          });
        }
      }
      if (change.prices.length) changes.push(change);
    }

    // Setup, rush, gift and duties: their normal price, no breaks.
    for (const productId of fullPrice) {
      const change = { ...changeFor(productId), kind: "fullPrice" };
      for (const variant of variantsByProduct.get(productId) || []) {
        change.prices.push({ variantId: variant.id, price: { amount: fromCents(toCents(variant.price)), currencyCode: currency } });
        if (hasBreaks.has(variant.id)) change.deleteBreaksOf.push(variant.id);
      }
      if (change.prices.length) changes.push(change);
    }

    // Everything else: no fixed price, so the catalog percentage applies.
    const handled = new Set([...ladders.keys(), ...fullPrice]);
    const clearing = new Map();
    for (const price of existing) {
      if (!price.productId || handled.has(price.productId)) continue;
      if (!clearing.has(price.productId)) clearing.set(price.productId, { ...changeFor(price.productId), kind: "cleared" });
      const change = clearing.get(price.productId);
      change.deletePrices.push(price.variantId);
      if (hasBreaks.has(price.variantId)) change.deleteBreaksOf.push(price.variantId);
    }
    changes.push(...clearing.values());

    const report = {
      count: (change) => {
        result[change.kind] += 1;
      },
      error: (product, message) => result.errors.push({ product, message }),
    };
    await applyChanges(admin, catalog.priceListId, changes, report);
  }

  return { results, ladderErrors, ladders: ladders.size };
}

/* -------------------------------------------------------------------------- */
/* Fill the ladders from a catalog (one-off)                                   */
/* -------------------------------------------------------------------------- */

const FILL_MUTATION = `#graphql
  mutation FillBlankPricing($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }`;

/**
 * Builds each product's ladder from a catalog's fixed prices and breaks (Test
 * B2B Catalog), and writes it to `hyve.blank_pricing`. The ladder most of a
 * product's variants share becomes `breaks`; a variant that differs gets its
 * own rows. With `dryRun` nothing is written, and the first few are returned to
 * look at.
 */
export async function fillLadders(admin, { sourceCatalogId, overwrite = false, dryRun = true }) {
  const definition = await loadLadderDefinition(admin);
  if (!definition) throw new Error(`There is no ${LADDER_NAMESPACE}.${LADDER_KEY} product metafield definition.`);
  if (definition.type !== "json") {
    throw new Error(`${LADDER_NAMESPACE}.${LADDER_KEY} is a ${definition.type} metafield. It needs to be JSON.`);
  }

  const source = (await listCompanyCatalogs(admin)).find((catalog) => catalog.id === sourceCatalogId);
  if (!source?.priceListId) throw new Error("Choose a catalog that has a price list.");

  const [prices, products] = await Promise.all([loadFixedPrices(admin, source.priceListId), loadProducts(admin)]);
  const productById = new Map(products.map((product) => [product.id, product]));

  const byProduct = new Map();
  for (const price of prices) {
    if (!price.productId || !Number.isFinite(price.price)) continue;
    const rows = [{ min_qty: 1, price: price.price }, ...price.breaks]
      .map((row) => ({ min_qty: row.min_qty, price: Math.round(row.price * 100) / 100 }))
      .sort((a, b) => a.min_qty - b.min_qty);
    if (!byProduct.has(price.productId)) byProduct.set(price.productId, []);
    byProduct.get(price.productId).push({ variantId: price.variantId, rows });
  }

  const summary = { source: source.title, currency: source.currency, found: byProduct.size, filled: 0, skipped: 0, skippedUtility: 0, errors: [], samples: [] };
  const writes = [];
  for (const [productId, variants] of byProduct) {
    const product = productById.get(productId);
    if (!product) continue;
    if (FULL_PRICE_HANDLES.has(product.handle)) {
      summary.skippedUtility += 1;
      continue;
    }
    if (product.ladderJson != null && !overwrite) {
      summary.skipped += 1;
      continue;
    }

    // The ladder most variants share is the product's; the rest are listed.
    const tally = new Map();
    for (const variant of variants) {
      const key = JSON.stringify(variant.rows);
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    const common = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const ladder = { currency: source.currency, breaks: JSON.parse(common) };
    const own = variants.filter((variant) => JSON.stringify(variant.rows) !== common);
    if (own.length) ladder.variants = Object.fromEntries(own.map((variant) => [numericId(variant.variantId), variant.rows]));

    writes.push({ product, ladder });
  }

  if (dryRun) {
    summary.filled = writes.length;
    summary.samples = writes.slice(0, 5).map(({ product, ladder }) => ({ title: product.title, ladder }));
    return { dryRun: true, ...summary };
  }

  for (let i = 0; i < writes.length; i += 25) {
    const chunk = writes.slice(i, i + 25);
    try {
      const data = await gql(admin, FILL_MUTATION, {
        metafields: chunk.map(({ product, ladder }) => ({
          ownerId: product.id,
          namespace: LADDER_NAMESPACE,
          key: LADDER_KEY,
          type: "json",
          value: JSON.stringify(ladder),
        })),
      });
      const errors = data?.metafieldsSet?.userErrors || [];
      if (errors.length) {
        summary.errors.push(...errors.map((error) => ({ product: "", message: error.message })));
      } else {
        summary.filled += chunk.length;
      }
    } catch (error) {
      summary.errors.push({ product: chunk.map(({ product }) => product.title).join(", "), message: error?.message || String(error) });
    }
  }
  summary.samples = writes.slice(0, 5).map(({ product, ladder }) => ({ title: product.title, ladder }));
  return { dryRun: false, ...summary };
}

/* -------------------------------------------------------------------------- */
/* Daily run and the last-run record                                           */
/* -------------------------------------------------------------------------- */

/** The tier catalogs: the company catalogs that take a percentage off. */
export function isTierCatalog(catalog) {
  return catalog?.adjustment?.type === "PERCENTAGE_DECREASE" && catalog.adjustment.value > 0 && Boolean(catalog.priceListId);
}

const LAST_RUN_QUERY = `#graphql
  query TierPricesLastRun {
    shop {
      id
      lastRun: metafield(namespace: "$app", key: "tier_prices_last_run") { jsonValue }
    }
  }`;

const SAVE_LAST_RUN_MUTATION = `#graphql
  mutation SaveTierPricesLastRun($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

/** What the last run did, manual or daily, for the Tier Prices page. */
export async function loadLastRun(admin) {
  return (await gql(admin, LAST_RUN_QUERY))?.shop?.lastRun?.jsonValue || null;
}

async function saveLastRun(admin, record) {
  const shopId = (await gql(admin, LAST_RUN_QUERY))?.shop?.id;
  if (!shopId) return;
  const data = await gql(admin, SAVE_LAST_RUN_MUTATION, {
    metafields: [{ ownerId: shopId, namespace: "$app", key: "tier_prices_last_run", type: "json", value: JSON.stringify(record) }],
  });
  const errors = data?.metafieldsSet?.userErrors || [];
  if (errors.length) console.warn("[tier-prices] last run not saved", errors);
}

/**
 * Runs an update and records it. `catalogIds` omitted means every tier
 * catalog, which is what the daily run uses. Errors are capped so the record
 * stays a small metafield.
 */
export async function runAndRecord(admin, { catalogIds, trigger }) {
  const startedAt = new Date().toISOString();
  try {
    const ids = catalogIds?.length ? catalogIds : (await listCompanyCatalogs(admin)).filter(isTierCatalog).map((c) => c.id);
    const outcome = await updateTierPrices(admin, ids);
    await saveLastRun(admin, {
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: true,
      results: outcome.results.map((result) => ({ ...result, errors: result.errors.slice(0, 20) })),
      ladderErrors: outcome.ladderErrors.slice(0, 20),
    }).catch((error) => console.warn("[tier-prices] last run not saved", error?.message || error));
    return { ok: true, ...outcome };
  } catch (error) {
    const message = error?.message || String(error);
    await saveLastRun(admin, { trigger, startedAt, finishedAt: new Date().toISOString(), ok: false, error: message }).catch(() => {});
    return { ok: false, error: message };
  }
}

/**
 * One run at a time per server: the daily call and a staff click landing
 * together would write the same prices twice over each other.
 */
let current = null;

export function isRunning() {
  return Boolean(current);
}

/** Starts a run without waiting for it. False when one is already going. */
export function startInBackground(admin, options) {
  if (current) return false;
  current = runAndRecord(admin, options)
    .then((outcome) => {
      if (!outcome.ok) console.error("[tier-prices] run failed", outcome.error);
    })
    .finally(() => {
      current = null;
    });
  return true;
}
