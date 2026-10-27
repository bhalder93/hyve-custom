/**
 * Editing a quote after it's saved: the staff quote page (Quotes > quote) and
 * the buyer's physical sample switch in the portal.
 *
 * Every change goes through rebuildQuote, which reprices the whole quote the
 * way the cart and checkout price an order, so an edited quote charges what
 * the same cart would have:
 *
 *   Product line   base price at its quantity, in the quote's currency, from
 *                  Shopify (the company location's catalog and its quantity
 *                  breaks for a distributor; the market price and the
 *                  `hyve.blank_pricing` ladder for retail), plus the
 *                  decoration fee converted from USD (quote-pricing.js).
 *   Setup          once, on printed goods under the setup waiver threshold,
 *                  unless the company has it waived.
 *   Rush           for the whole order: one per product line (HYV-207).
 *   Gift           one line per product, its units, at that product's
 *                  `custom.gift_packaging_price`.
 *   Physical       one per order.
 *   sample
 *   Import duties  worked out again from the new totals, as the cart
 *                  transform does.
 *
 * A product line is repriced when its quantity or decoration changes; until
 * then it keeps its price, which may be one sales set by hand. Blank samples
 * and custom lines keep their price.
 *
 * A quote's lines carry no `_imprint` or `_fcw` (proxy.quote.jsx): their price
 * is final, and those keys would make checkout add the decoration fee again.
 * `_hyve_quote` tells checkout the retail break is already in the price.
 *
 * Fees are converted with the rate in Market Conversion Rates, the one the
 * cart's setup threshold and the checkout duty use.
 */
import { loadCommercialSettings } from "./commercial-settings.server";
import { LEAD_TIME_ATTRIBUTE } from "./quote-document.server";
import { formatQuoteMoney, retailBreaks, roundCents, unitPriceFor } from "./quote-pricing";

const CHARGE_HANDLE = "additional-charges";
const DUTY_HANDLE = "import-duties-taxes-included";

/** Charge variant titles, as the checkout charges extension matches them. */
const CHARGE_TITLES = {
  setup: ["setup charge", "setup"],
  rush: ["rush production", "72-hour rush production", "rush"],
  gift: ["gift packaging", "gift"],
  sample: ["physical sample", "sample", "physical_sample", "physical-sample"],
};

export function getPhysicalSampleVariantId() {
  const envVal = (process.env.PHYSICAL_SAMPLE_VARIANT_ID || "gid://shopify/ProductVariant/68280437997819")
    .replace(/^["']|["']$/g, "")
    .trim();
  const gid = envVal.startsWith("gid://") ? envVal : `gid://shopify/ProductVariant/${envVal}`;
  const numId = gid.split("/").pop();
  return { gid, numId };
}

export function getRushProductionVariantId() {
  const envVal = (process.env.RUSH_PRODUCTION_VARIANT_ID || "")
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!envVal) return { gid: null, numId: null };
  const gid = envVal.startsWith("gid://") ? envVal : `gid://shopify/ProductVariant/${envVal}`;
  const numId = gid.split("/").pop();
  return { gid, numId };
}

/** The flag each charge line carries, so checkout's minimum quantity rule skips it. */
const CHARGE_FLAGS = { setup: "_hyve_setup", rush: "_hyve_rush", gift: "_hyve_gift", sample: "_hyve_sample" };

/** Hidden keys a quote line keeps (proxy.quote.jsx), plus the quoted marker. */
const KEPT_HIDDEN = new Set(["_sample", "_hyve_setup", "_hyve_rush", "_hyve_gift", "_hyve_sample", "_hyve_quote"]);

/** The labels the product page writes (theme settings hyve_rush_label, hyve_gift_label). */
const RUSH_LABEL = "Rush Production";
const GIFT_LABEL = "Gift Packaging";

/** What the product page writes for each artwork choice (hyve-order.liquid). */
export const ARTWORK_VALUES = { now: "Provided now", later: "Artwork Pending", design: "Design it for me" };

const EDIT_QUERY = `#graphql
  query QuoteEditDraft($id: ID!) {
    draftOrder(id: $id) {
      id
      status
      tags
      order { id }
      presentmentCurrencyCode
      customAttributes { key value }
      shippingAddress { countryCodeV2 }
      billingAddress { countryCodeV2 }
      purchasingEntity {
        ... on PurchasingCompany {
          company { id setupWaived: metafield(namespace: "hyve", key: "setup_waived") { value } }
          location { id }
        }
      }
      lineItems(first: 100) {
        nodes {
          id
          title
          name
          sku
          custom
          quantity
          requiresShipping
          taxable
          customAttributes { key value }
          originalUnitPriceSet { presentmentMoney { amount currencyCode } }
          appliedDiscount { title description value valueType }
          variant {
            id
            title
            dutyRates: metafield(namespace: "custom", key: "duty_rates") { jsonValue }
            product {
              id
              handle
              title
              imprintFee: metafield(namespace: "custom", key: "imprint_fee") { jsonValue }
              fullColourWrap: metafield(namespace: "custom", key: "full_colour_wrap") { value }
              blankPricing: metafield(namespace: "hyve", key: "blank_pricing") { jsonValue }
              giftPrice: metafield(namespace: "custom", key: "gift_packaging_price") { value }
              dutyClass: metafield(namespace: "custom", key: "duty_class") { value }
              decorationMethod: metafield(namespace: "custom", key: "decoration_method") { value }
              imprintLocations: metafield(namespace: "custom", key: "imprint_locations") { value }
              maxLocations: metafield(namespace: "custom", key: "maximum_allowed_imprint_location") { value }
            }
          }
        }
      }
    }
    shop {
      currencyCode
      setupThreshold: metafield(namespace: "hyve", key: "setup_waiver_threshold") { value }
    }
    rates: metaobjects(type: "market_conversion_rates", first: 50) {
      nodes { fields { key value } }
    }
    charges: productByIdentifier(identifier: { handle: "additional-charges" }) {
      variants(first: 20) { nodes { id title } }
    }
    markets(first: 50) {
      nodes {
        handle
        status
        currencySettings { roundingEnabled baseCurrency { currencyCode manualRate } }
        conditions { regionsCondition { regions(first: 1) { nodes { ... on MarketRegionCountry { code } } } } }
      }
    }
  }`;

const PRICES_QUERY = `#graphql
  query QuoteEditPrices($ids: [ID!]!, $context: ContextualPricingContext!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        contextualPricing(context: $context) {
          price { amount currencyCode }
          quantityPriceBreaks(first: 20) { nodes { minimumQuantity price { amount currencyCode } } }
        }
      }
    }
  }`;

const SAVE_MUTATION = `#graphql
  mutation QuoteEditSave($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { id }
      userErrors { field message }
    }
  }`;

/** A reason the quote can't be edited, shown to whoever is editing it. */
class QuoteEditError extends Error {}

async function gql(admin, query, variables) {
  const body = await (await admin.graphql(query, { variables })).json();
  if (body?.errors?.length) throw new Error(body.errors.map((error) => error.message).join(", "));
  return body.data;
}

const norm = (text) => String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
const attrValue = (attrs, key) => attrs.find((a) => a.key === key)?.value;

/** A blank sample: decided as isBlankSample() in the theme's hyve-cart-sync.js. */
function isBlankSample(attrs) {
  return attrs.some(
    (a) => (a.key === "_sample" && String(a.value) === "true") || (a.key === "Sample" && /blank/i.test(String(a.value))),
  );
}

/** "<charge>: Yes" on a product line, matched as the theme and checkout match it. */
function flagged(attrs, keyword) {
  return attrs.some((a) => norm(a.key).includes(keyword) && norm(a.value).includes("yes"));
}

const isArtworkKey = (key) => key === "Artwork" || key === "Design Brief" || /^Artwork:\s*/.test(key);
const isDecorationKey = (key) => key === "Imprint Locations" || key === "Full Colour Wrap" || isArtworkKey(key);

/** The line's decoration, from the visible keys a quote's lines keep. */
export function readDecoration(attrs) {
  const imprint = String(attrValue(attrs, "Imprint Locations") || "").trim();
  if (imprint) {
    const split = imprint.indexOf(":");
    const method = (split > -1 ? imprint.slice(0, split) : imprint).trim();
    const locations = split > -1 ? imprint.slice(split + 1).split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (method && locations.length) return { type: "imprint", method, locations };
  }
  if (String(attrValue(attrs, "Full Colour Wrap") || "").trim()) return { type: "fcw" };
  return { type: "none" };
}

/** The artwork slots a decoration needs, keyed as the product page keys them. */
export function artworkZones(decoration) {
  if (decoration.type === "fcw") return [{ key: "Artwork: Full Colour Wrap", label: "Full Colour Wrap" }];
  if (decoration.type === "imprint") {
    return decoration.locations.map((loc) => ({ key: `Artwork: ${decoration.method} - ${loc}`, label: `${decoration.method} — ${loc}` }));
  }
  return [];
}

const splitList = (value) => String(value || "").split(",").map((s) => s.trim()).filter(Boolean);

/** What the product offers: its methods, locations, the most locations at once, and wrap. */
function decorationOptions(product, rate, currency) {
  const locations = splitList(product?.imprintLocations?.value);
  const max = parseInt(product?.maxLocations?.value || "", 10);
  const wrapUsd = Number(product?.fullColourWrap?.value);
  return {
    methods: splitList(product?.decorationMethod?.value),
    locations,
    maxLocations: max > 0 ? max : Math.max(1, locations.length),
    wrapFee: wrapUsd > 0 ? wrapUsd : 0,
    wrapLabel: wrapUsd > 0 ? formatQuoteMoney(roundCents(wrapUsd * rate), currency) : "",
  };
}

/** Which charge a variant of the Additional Charges product is, by its title. */
function chargeKindOf(title) {
  const t = norm(title);
  if (/physical[-_\s]*sample/i.test(t) || /^sample$/i.test(t)) return "sample";
  if (/rush/i.test(t)) return "rush";
  if (/setup/i.test(t)) return "setup";
  if (/gift/i.test(t)) return "gift";
  return Object.keys(CHARGE_TITLES).find((kind) => CHARGE_TITLES[kind].includes(t)) || "other";
}

/** The draft's lines, each with what it is. */
function readLines(draft) {
  const { gid: sampleGid, numId: sampleNum } = getPhysicalSampleVariantId();
  return (draft.lineItems?.nodes || []).map((node) => {
    const attrs = (node.customAttributes || []).map(({ key, value }) => ({ key, value }));
    const handle = node.variant?.product?.handle;
    const variantId = String(node.variant?.id || "");
    let kind = "product";
    if (!node.variant) {
      if (/physical[-_\s]*sample/i.test(node.title || node.name || "")) kind = "sample";
      else kind = "custom";
    }
    else if (handle === DUTY_HANDLE) kind = "duty";
    else if (
      node.sku === "HYVE-PHYSICAL-SAMPLE" ||
      node.sku === "PHYSICAL_SAMPLE" ||
      node.sku === "PHYSICAL-SAMPLE" ||
      (sampleGid && variantId === sampleGid) ||
      (sampleNum && variantId.includes(sampleNum)) ||
      variantId.includes("68280437997819") ||
      variantId.includes("52315361280216") ||
      attrs.some(
        (a) =>
          (a.key === "_hyve_sample" && (String(a.value) === "true" || String(a.value) === "1")) ||
          (a.key === "Physical Sample" && String(a.value).toLowerCase() === "yes"),
      ) ||
      /physical[-_\s]*sample/i.test(node.title || node.name || "") ||
      /physical[-_\s]*sample/i.test(node.variant?.title || "") ||
      /physical[-_\s]*sample/i.test(node.variant?.selectedOptions?.map((o) => o.value).join(" ") || "")
    ) {
      kind = "sample";
    }
    else if (handle === CHARGE_HANDLE) kind = chargeKindOf(node.variant.title);
    else if (isBlankSample(attrs)) kind = "blank-sample";
    return {
      node,
      attrs,
      kind,
      quantity: node.quantity,
      decoration: kind === "product" ? readDecoration(attrs) : null,
      gift: kind === "product" && flagged(attrs, "gift"),
      rush: kind === "product" && flagged(attrs, "rush"),
    };
  });
}

/** USD to the quote's currency, from Market Conversion Rates. */
function rateFor(data, currency) {
  if (currency === data.shop.currencyCode) return 1;
  for (const node of data.rates?.nodes || []) {
    const field = (key) => node.fields.find((f) => f.key === key)?.value;
    if (String(field("region_currency_code") || "").trim().toUpperCase() !== currency) continue;
    const rate = Number(field("manual_exchange_rate"));
    if (rate > 0) return rate;
  }
  throw new QuoteEditError(
    `There's no ${currency} rate in Market Conversion Rates, so the decoration fees can't be converted. Add one, then edit the quote.`,
  );
}

/**
 * Shopify's price for each variant in the quote's context, in its currency.
 * A distributor's quote: their company location. Retail: the quote's address
 * country, or a country of the market in the quote's currency when the
 * address is elsewhere or missing (a cart quote has none).
 */
async function priceVariants(admin, data, variantIds, currency) {
  const draft = data.draftOrder;
  const locationId = draft.purchasingEntity?.location?.id;
  const contexts = [];
  if (locationId) {
    contexts.push({ companyLocationId: locationId });
  } else {
    const addressCountry = draft.shippingAddress?.countryCodeV2 || draft.billingAddress?.countryCodeV2;
    const marketCountry = (data.markets?.nodes || []).find(
      (m) =>
        m.status === "ACTIVE" &&
        !String(m.handle || "").startsWith("distributors-") &&
        m.currencySettings?.baseCurrency?.currencyCode === currency,
    )?.conditions?.regionsCondition?.regions?.nodes?.[0]?.code;
    for (const country of [addressCountry, marketCountry]) {
      if (country && !contexts.some((c) => c.country === country)) contexts.push({ country });
    }
  }

  let found = "";
  for (const context of contexts) {
    const nodes = (await gql(admin, PRICES_QUERY, { ids: variantIds, context }))?.nodes || [];
    const prices = new Map();
    for (const node of nodes) {
      const pricing = node?.contextualPricing;
      if (!pricing?.price) continue;
      prices.set(node.id, {
        price: Number(pricing.price.amount),
        currency: pricing.price.currencyCode,
        breaks: (pricing.quantityPriceBreaks?.nodes || []).map((b) => ({ min_qty: b.minimumQuantity, price: Number(b.price.amount) })),
      });
    }
    if (prices.size && [...prices.values()].every((p) => p.currency === currency)) return prices;
    found ||= [...prices.values()][0]?.currency || "";

    // A company location's price comes back in its catalog's currency (USD),
    // before its market converts it: Acme's SGD location read USD 3.70. The
    // cart charges it converted, so it's converted the same way here.
    const catalogCurrency = [...prices.values()][0]?.currency;
    if (context.companyLocationId && prices.size && [...prices.values()].every((p) => p.currency === catalogCurrency)) {
      const rate = marketRate(data, currency);
      const convert = (amount) => roundCents(amount * rate);
      for (const p of prices.values()) {
        p.price = convert(p.price);
        p.breaks = p.breaks.map((b) => ({ ...b, price: convert(b.price) }));
        p.currency = currency;
      }
      return prices;
    }
  }
  // A quote saved in a currency the buyer isn't priced in (an SGD company
  // location with an HKD quote) can't be repriced without changing currency.
  if (locationId && found) {
    throw new QuoteEditError(
      `This quote is in ${currency}, but Shopify prices this company location in ${found}, so it can't be repriced. Make a new quote for the company in ${found}.`,
    );
  }
  throw new QuoteEditError(`Shopify didn't give ${currency} prices for this quote's products, so it can't be repriced.`);
}

/**
 * How a distributor market converts the catalog's USD into this currency: its
 * fixed rate, with no rounding (Distributors - SGD: 1.325, so USD 15.00 is
 * SGD 19.88, as order #1122 was charged). A market that rounds prices, or has
 * no fixed rate, can't be matched to the cent, so the quote isn't repriced.
 */
function marketRate(data, currency) {
  const markets = (data.markets?.nodes || []).filter(
    (m) => m.status === "ACTIVE" && m.currencySettings?.baseCurrency?.currencyCode === currency,
  );
  const market = markets.find((m) => m.handle === `distributors-${currency.toLowerCase()}`) || markets[0];
  const rate = Number(market?.currencySettings?.baseCurrency?.manualRate);
  if (!market || !(rate > 0) || market.currencySettings.roundingEnabled) {
    throw new QuoteEditError(
      `Shopify converts ${currency} prices for this company with ${market ? "rounding" : "no fixed rate"}, so this quote can't be repriced to match checkout. Make a new quote from the cart.`,
    );
  }
  return rate;
}

/** The base price ladder for a product line, in the quote's currency. */
function lineBreaks(price, product, retail) {
  if (retail) return retailBreaks(price.price, product?.blankPricing?.jsonValue);
  return [{ min_qty: 1, price: price.price }, ...price.breaks].sort((a, b) => a.min_qty - b.min_qty);
}

/**
 * Everything the edit needs: the draft as it is, what each line is, the rate,
 * Shopify's prices and the charge variants.
 */
async function loadContext(admin, draftId) {
  const data = await gql(admin, EDIT_QUERY, { id: draftId });
  const draft = data?.draftOrder;
  if (!draft) throw new QuoteEditError("We couldn't find this quote.");

  const currency = draft.presentmentCurrencyCode;
  const retail = !draft.purchasingEntity?.location?.id;
  const lines = readLines(draft);
  const rate = rateFor(data, currency);

  const { gid: sampleGid, numId: sampleNum } = getPhysicalSampleVariantId();
  const { gid: rushGid, numId: rushNum } = getRushProductionVariantId();

  const chargeVariants = {};
  for (const variant of data.charges?.variants?.nodes || []) {
    let kind = chargeKindOf(variant.title);
    const vId = String(variant.id || "");
    if ((sampleGid && vId === sampleGid) || (sampleNum && vId.includes(sampleNum))) {
      kind = "sample";
    } else if (rushGid && (vId === rushGid || (rushNum && vId.includes(rushNum)))) {
      kind = "rush";
    }
    if (kind !== "other" && !chargeVariants[kind]) chargeVariants[kind] = variant.id;
  }

  if (!chargeVariants.sample && sampleGid) {
    chargeVariants.sample = sampleGid;
  }
  if (!chargeVariants.rush && rushGid) {
    chargeVariants.rush = rushGid;
  }

  const ids = new Set(Object.values(chargeVariants).filter(Boolean));
  for (const line of lines) if (line.kind === "product") ids.add(line.node.variant.id);
  const prices = await priceVariants(admin, data, [...ids], currency);

  return { data, draft, currency, retail, lines, rate, chargeVariants, prices };
}

/** A product line's price ladder and fees, for the page's live estimate. */
function pricingFor(ctx, line) {
  const price = ctx.prices.get(line.node.variant.id);
  if (!price) throw new QuoteEditError(`Shopify has no price for ${line.node.title}.`);
  const product = line.node.variant.product;
  return {
    breaks: lineBreaks(price, product, ctx.retail),
    imprintFee: product?.imprintFee?.jsonValue ?? null,
    wrapFee: Number(product?.fullColourWrap?.value) > 0 ? Number(product.fullColourWrap.value) : 0,
  };
}

/**
 * What the staff page needs to edit the quote: per line, what it is and what
 * can be changed; for the order, rush and the physical sample. `error` when
 * the quote can't be repriced (and so can't be edited) right now.
 */
export async function loadQuoteEditor(admin, draftId) {
  try {
    return editorModel(await loadContext(admin, draftId));
  } catch (error) {
    if (!(error instanceof QuoteEditError)) console.error("[quote-editor] load failed", error);
    return { error: error instanceof QuoteEditError ? error.message : "The quote's prices couldn't be loaded.", lines: {} };
  }
}

function editorModel(ctx) {
  const lines = {};
  for (const line of ctx.lines) {
    const entry = { kind: line.kind };
    if (line.kind === "product") {
      const product = line.node.variant.product;
      const pricing = pricingFor(ctx, line);
      const { base, fee, unit } = unitPriceFor(pricing, line.decoration, line.quantity, ctx.rate);
      const giftUsd = Number(product?.giftPrice?.value);
      Object.assign(entry, {
        decoration: line.decoration,
        artwork: {
          mode: Object.keys(ARTWORK_VALUES).find((mode) => ARTWORK_VALUES[mode] === attrValue(line.attrs, "Artwork")) || "",
          urls: Object.fromEntries(line.attrs.filter((a) => /^Artwork:\s*/.test(a.key)).map((a) => [a.key, a.value])),
          brief: attrValue(line.attrs, "Design Brief") || "",
        },
        options: decorationOptions(product, ctx.rate, ctx.currency),
        pricing,
        base,
        fee,
        // Off the rules when sales set the price by hand.
        priced: Math.abs(unit - Number(line.node.originalUnitPriceSet?.presentmentMoney?.amount ?? 0)) < 0.005,
        ruleUnit: unit,
        gift: line.gift,
        giftLabel: giftUsd > 0 ? formatQuoteMoney(roundCents(giftUsd * ctx.rate), ctx.currency) : "",
        giftAvailable: Boolean(ctx.chargeVariants.gift),
      });
    }
    lines[line.node.id] = entry;
  }

  return {
    error: null,
    currency: ctx.currency,
    rate: ctx.rate,
    rush: ctx.lines.some((line) => line.rush),
    sample: ctx.lines.some((line) => line.kind === "sample"),
    rushAvailable: Boolean(ctx.chargeVariants.rush),
    sampleAvailable: Boolean(ctx.chargeVariants.sample),
    lines,
  };
}

/** The ported duty rule from the cart transform's buildDutyOperation. */
function dutyTotal(dutyLine, goods) {
  const rateTable = dutyLine.node.variant?.dutyRates?.jsonValue;
  const classRates = (rateTable && typeof rateTable === "object" && rateTable.classes) || {};
  const tableDefault = Number(rateTable?.default);
  const defaultPct = Number.isFinite(tableDefault) && tableDefault > 0 ? tableDefault : NaN;
  const anyRate = (Number.isFinite(defaultPct) && defaultPct > 0) || Object.keys(classRates).length > 0;
  if (!anyRate) return 0;

  const dutiable = [];
  let goodsTotal = 0;
  for (const item of goods) {
    if (item.total <= 0) continue;
    const classPct = Number(classRates[item.dutyClass]);
    const pct = item.dutyClass && Number.isFinite(classPct) && classPct >= 0 ? classPct : Number.isFinite(defaultPct) ? defaultPct : 0;
    dutiable.push({ goods: item.total, pct });
    goodsTotal += item.total;
  }
  if (!dutiable.length) return 0;

  let shipping = Number(String(attrValue(dutyLine.attrs, "_hyve_freight") || "").split("|")[0]) || 0;
  if (shipping > goodsTotal) shipping = 0;

  const cif = goodsTotal + shipping;
  const deMinimis = rateTable?.de_minimis;
  const threshold = Number(deMinimis?.threshold);
  if (Number.isFinite(threshold) && threshold > 0 && cif <= threshold) {
    const taxPct = Number(deMinimis?.tax);
    return String(deMinimis?.mode ?? "exempt_all") === "tax_only" && Number.isFinite(taxPct) && taxPct > 0
      ? cif * (taxPct / 100)
      : 0;
  }

  let duty = 0;
  for (const item of dutiable) {
    const share = shipping > 0 ? (shipping * item.goods) / goodsTotal : 0;
    duty += (item.goods + share) * (item.pct / 100);
  }
  return duty;
}

const money = (amount, currencyCode) => ({ amount: roundCents(amount).toFixed(2), currencyCode });

/** A line as it is, for the update: same variant or title, price and keys. */
function keptInput(line, currency) {
  const unit = Number(line.node.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
  const input = { quantity: line.quantity, customAttributes: line.attrs };
  if (line.node.appliedDiscount) {
    const { title, description, value, valueType } = line.node.appliedDiscount;
    input.appliedDiscount = { title, description, value, valueType };
  }
  if (line.node.variant) {
    input.variantId = line.node.variant.id;
    input.priceOverride = money(unit, currency);
  } else {
    Object.assign(input, {
      title: line.node.title || line.node.name || "Custom item",
      originalUnitPriceWithCurrency: money(unit, currency),
      requiresShipping: line.node.requiresShipping,
      taxable: line.node.taxable,
      ...(line.node.sku ? { sku: line.node.sku } : {}),
    });
  }
  return { input, unit };
}

/** The decoration keys for a new choice, as the product page writes them. */
function decorationAttrs(decoration, artwork, options) {
  if (decoration.type === "none") return [];
  const attrs =
    decoration.type === "imprint"
      ? [{ key: "Imprint Locations", value: `${decoration.method}: ${decoration.locations.join(", ")}` }]
      : [{ key: "Full Colour Wrap", value: options.wrapLabel }];
  attrs.push({ key: "Artwork", value: ARTWORK_VALUES[artwork.mode] });
  if (artwork.mode === "now") {
    for (const zone of artworkZones(decoration)) attrs.push({ key: zone.key, value: artwork.urls[zone.key] });
  }
  if (artwork.mode === "design" && String(artwork.brief || "").trim()) {
    attrs.push({ key: "Design Brief", value: String(artwork.brief).trim().slice(0, 900) });
  }
  return attrs;
}

/** Checks a new decoration against what the product offers. */
function checkDecoration(change, options, title) {
  const { decoration, artwork } = change;
  if (decoration.type === "none") return;
  if (decoration.type === "fcw") {
    if (!options.wrapFee) throw new QuoteEditError(`${title} doesn't offer Full Colour Wrap.`);
  } else if (decoration.type === "imprint") {
    if (!decoration.method) throw new QuoteEditError("Choose a decoration method.");
    if (options.methods.length && !options.methods.includes(decoration.method)) {
      throw new QuoteEditError(`${title} isn't decorated with ${decoration.method}.`);
    }
    if (!decoration.locations.length) throw new QuoteEditError("Choose at least one imprint location.");
    if (decoration.locations.length > options.maxLocations) {
      throw new QuoteEditError(`${title} takes at most ${options.maxLocations} imprint location${options.maxLocations === 1 ? "" : "s"}.`);
    }
    const unknown = options.locations.length ? decoration.locations.filter((loc) => !options.locations.includes(loc)) : [];
    if (unknown.length) throw new QuoteEditError(`${title} has no ${unknown.join(", ")} location.`);
  } else {
    throw new QuoteEditError("Unknown decoration.");
  }
  if (!ARTWORK_VALUES[artwork?.mode]) throw new QuoteEditError("Choose an artwork option.");
  if (artwork.mode === "now") {
    const missing = artworkZones(decoration).filter((zone) => !String(artwork.urls?.[zone.key] || "").trim());
    if (missing.length) throw new QuoteEditError(`Upload the artwork for ${missing.map((zone) => zone.label).join(", ")}.`);
  }
}

/**
 * Applies a change and saves the whole quote, repriced.
 *
 * @param {object} change
 * @param {Object<string, number>} [change.quantities] line id -> quantity
 * @param {boolean} [change.rush] rush for the whole order
 * @param {boolean} [change.sample] a physical sample before production
 * @param {Object<string, boolean>} [change.gifts] line id -> gift packaging
 * @param {{lineId:string, decoration:object, artwork:object}} [change.decoration]
 * @param {string} [change.removeLineId]
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function rebuildQuote(admin, draftId, change = {}) {
  try {
    const ctx = await loadContext(admin, draftId);
    const { draft, currency, rate } = ctx;
    if (draft.order?.id || draft.status === "COMPLETED") {
      throw new QuoteEditError("This quote has become an order, so it can't be changed.");
    }

    let lines = ctx.lines;
    if (change.removeLineId) {
      const target = lines.find((line) => line.node.id === change.removeLineId);
      if (!target) throw new QuoteEditError("That line isn't on this quote.");
      if (!["product", "custom", "blank-sample"].includes(target.kind)) {
        throw new QuoteEditError("Charge lines follow the products, so they can't be removed on their own.");
      }
      lines = lines.filter((line) => line !== target);
      if (!lines.some((line) => ["product", "custom", "blank-sample"].includes(line.kind))) {
        throw new QuoteEditError("A quote needs at least one item.");
      }
    }

    for (const [lineId, raw] of Object.entries(change.quantities || {})) {
      const line = lines.find((l) => l.node.id === lineId);
      if (!line || !["product", "custom"].includes(line.kind)) continue;
      const quantity = Number(raw);
      if (!Number.isInteger(quantity) || quantity < 1) throw new QuoteEditError(`Enter a whole quantity of 1 or more for ${line.node.title}.`);
      line.quantity = quantity;
    }
    for (const [lineId, on] of Object.entries(change.gifts || {})) {
      const line = lines.find((l) => l.node.id === lineId);
      if (line?.kind === "product") line.gift = Boolean(on);
    }

    const products = lines.filter((line) => line.kind === "product");
    const rush = change.rush ?? products.some((line) => line.rush);
    const sample = change.sample ?? lines.some((line) => line.kind === "sample");
    const decorationChange = change.decoration
      ? { ...change.decoration, line: products.find((line) => line.node.id === change.decoration.lineId) }
      : null;
    if (decorationChange && !decorationChange.line) throw new QuoteEditError("That line can't be decorated.");

    const out = [];
    const goods = [];
    const add = (input, unit, dutyClass) => {
      out.push(input);
      goods.push({ total: unit * input.quantity, dutyClass: String(dutyClass || "").trim() });
    };
    // The value that waives setup: the goods, less blank samples (hyve-cart-sync.js).
    let merchTotal = 0;
    let produced = false;

    // Products, custom lines and blank samples, in the order they were.
    for (const line of lines) {
      if (line.kind === "custom" || line.kind === "blank-sample") {
        const { input, unit } = keptInput(line, currency);
        add(input, unit, line.node.variant?.product?.dutyClass?.value);
        if (line.kind === "custom") merchTotal += unit * input.quantity;
        continue;
      }
      if (line.kind !== "product") continue;

      const product = line.node.variant.product;
      const pricing = pricingFor(ctx, line);
      let attrs = line.attrs.filter((a) => !a.key.startsWith("_") || KEPT_HIDDEN.has(a.key));
      let decoration = line.decoration;
      if (decorationChange?.line === line) {
        const options = decorationOptions(product, rate, currency);
        checkDecoration(decorationChange, options, line.node.title);
        decoration = decorationChange.decoration;
        attrs = [...attrs.filter((a) => !isDecorationKey(a.key)), ...decorationAttrs(decoration, decorationChange.artwork, options)];
      }
      attrs = attrs.filter((a) => !(norm(a.key).includes("rush") || norm(a.key).includes("gift")));
      if (rush) attrs.push({ key: RUSH_LABEL, value: "Yes" });
      if (line.gift) attrs.push({ key: GIFT_LABEL, value: "Yes" });
      if (!attrs.some((a) => a.key === "_hyve_quote")) attrs.push({ key: "_hyve_quote", value: "1" });

      // Repriced when its quantity or decoration changes. Otherwise it keeps
      // its price, so a price sales set by hand isn't undone by a rush or
      // sample change elsewhere on the quote.
      const touched = line.quantity !== line.node.quantity || decorationChange?.line === line;
      const unit = touched
        ? unitPriceFor(pricing, decoration, line.quantity, rate).unit
        : Number(line.node.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
      const input = {
        variantId: line.node.variant.id,
        quantity: line.quantity,
        priceOverride: money(unit, currency),
        customAttributes: attrs,
      };
      if (line.node.appliedDiscount) {
        const { title, description, value, valueType } = line.node.appliedDiscount;
        input.appliedDiscount = { title, description, value, valueType };
      }
      line.decoration = decoration;
      add(input, unit, product?.dutyClass?.value);
      merchTotal += unit * line.quantity;
      if (String(attrValue(attrs, "Artwork") || "").trim()) produced = true;
    }

    // Charge lines that aren't setup, rush, gift or sample stay as they were.
    for (const line of lines.filter((l) => l.kind === "other")) {
      const { input, unit } = keptInput(line, currency);
      add(input, unit, null);
    }

    const chargePrice = (kind) => {
      let id = ctx.chargeVariants[kind];
      if (!id && kind === "sample") {
        id = getPhysicalSampleVariantId().gid;
      }
      if (!id && kind === "rush") {
        id = getRushProductionVariantId().gid;
      }
      if (!id) throw new QuoteEditError(`The Additional Charges product has no ${kind} variant.`);
      // No price means Shopify didn't price it for this buyer: stop rather than
      // put the charge on the quote at 0.00.
      const priceObj = ctx.prices.get(id);
      if (!priceObj) throw new QuoteEditError(`Shopify has no price for the ${kind} charge for this buyer.`);
      return { id, unit: priceObj.price };
    };
    const addCharge = (kind, quantity, unit, extraAttrs = []) => {
      const { id } = chargePrice(kind);
      add(
        {
          variantId: id,
          quantity,
          priceOverride: money(unit, currency),
          customAttributes: [...extraAttrs, { key: CHARGE_FLAGS[kind], value: "true" }],
        },
        unit,
        null,
      );
    };

    // Setup: printed goods under the threshold, unless the company has it
    // waived (hyve-cart-sync.js). No threshold set: it's charged, as the cart does.
    const printed = products.some((line) => line.decoration.type !== "none");
    const thresholdUsd = Number(ctx.data.shop.setupThreshold?.value ?? NaN);
    const threshold = ctx.data.shop.setupThreshold?.value && Number.isFinite(thresholdUsd) ? thresholdUsd * rate : Infinity;
    const waived = String(draft.purchasingEntity?.company?.setupWaived?.value) === "true";
    if (printed && merchTotal > 0 && merchTotal < threshold && !waived) addCharge("setup", 1, chargePrice("setup").unit);

    if (rush && products.length) addCharge("rush", products.length, chargePrice("rush").unit);

    // Gift: one line per product, for all that product's opted-in units.
    const gifts = new Map();
    for (const line of products.filter((l) => l.gift)) {
      const product = line.node.variant.product;
      const entry = gifts.get(product.id) || { product, quantity: 0 };
      entry.quantity += line.quantity;
      gifts.set(product.id, entry);
    }
    for (const { product, quantity } of gifts.values()) {
      const giftUsd = Number(product.giftPrice?.value);
      const unit = giftUsd > 0 ? roundCents(giftUsd * rate) : chargePrice("gift").unit;
      addCharge("gift", quantity, unit, [{ key: GIFT_LABEL, value: `For: ${product.title}` }]);
    }

    if (sample) addCharge("sample", 1, chargePrice("sample").unit);

    // Import duties last, on everything above (the cart transform's rule).
    for (const line of lines.filter((l) => l.kind === "duty")) {
      const quantity = Math.max(1, line.quantity);
      const perUnit = roundCents(dutyTotal(line, goods) / quantity);
      out.push({ variantId: line.node.variant.id, quantity, priceOverride: money(perUnit, currency), customAttributes: line.attrs });
    }

    const input = { lineItems: out };

    // An edited quote is no longer the cart it was made from, so the same cart
    // asked for again gets a new quote (proxy.quote.jsx reuses by this tag).
    const tags = draft.tags || [];
    if (tags.some((tag) => tag.startsWith("cart-quote:"))) input.tags = tags.filter((tag) => !tag.startsWith("cart-quote:"));

    // The lead time a cart quote states follows rush (proxy.quote.jsx quoteLeadTime).
    const draftAttrs = (draft.customAttributes || []).map(({ key, value }) => ({ key, value }));
    if (draftAttrs.some((a) => a.key === LEAD_TIME_ATTRIBUTE)) {
      const { values } = await loadCommercialSettings(admin);
      const days = rush && produced ? values.production_days_rush : values.production_days_standard;
      if (days) {
        input.customAttributes = draftAttrs.map((a) => (a.key === LEAD_TIME_ATTRIBUTE ? { key: a.key, value: `${days} business days` } : a));
      }
    }

    const saved = (await gql(admin, SAVE_MUTATION, { id: draftId, input }))?.draftOrderUpdate;
    const userError = saved?.userErrors?.[0]?.message;
    if (userError) throw new QuoteEditError(userError);
    return { ok: true };
  } catch (error) {
    if (error instanceof QuoteEditError) return { ok: false, error: error.message };
    console.error("[quote-editor] save failed", draftId, error);
    return { ok: false, error: "The quote couldn't be saved. Please try again." };
  }
}
