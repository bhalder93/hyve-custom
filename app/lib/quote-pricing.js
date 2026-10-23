/**
 * How a quote line is priced, the same way the storefront prices it, for the
 * staff quote editor (Quotes > quote) and its live estimate. Pure functions,
 * so the server and the page use the one copy.
 *
 * Each rule mirrors the cart transform (Extensions, cart_transform_run.js):
 * - The imprint fee is the per-unit price for that method and number of
 *   locations at that quantity, in USD. It is not multiplied by the number of
 *   locations.
 * - Full Colour Wrap is a flat per-unit fee in USD, and it's instead of an
 *   imprint, not on top of one.
 * - The unit price is roundCents(base + fee x rate), the base being the price
 *   at that quantity in the quote's currency.
 */

/** Rounds to the cent, halves up, as the cart transform does. */
export function roundCents(amount) {
  return Math.round(Number(amount) * 100 + 1e-6) / 100;
}

/**
 * The per-unit imprint fee (USD) for a method, number of locations and
 * quantity, from the product's `custom.imprint_fee`:
 *   [{ method_name, location, pricing: [{ min_qty, price }] }]
 * The exact location count first; otherwise the largest one below it, else the
 * smallest. Then the highest tier whose min_qty the quantity reaches. 0 when
 * the product has no fee for that method.
 */
export function imprintFeeFor(table, method, locations, quantity) {
  if (!Array.isArray(table) || !method) return 0;
  const loc = Number(locations) > 0 ? Number(locations) : 1;
  const matches = table.filter(
    (entry) =>
      entry &&
      typeof entry.method_name === "string" &&
      entry.method_name.toLowerCase() === String(method).toLowerCase() &&
      Array.isArray(entry.pricing),
  );
  if (!matches.length) return 0;

  let pricing = matches.find((entry) => Number(entry.location) === loc)?.pricing;
  if (!pricing) {
    const sorted = matches.slice().sort((a, b) => Number(a.location) - Number(b.location));
    let chosen = null;
    for (const entry of sorted) if (Number(entry.location) <= loc) chosen = entry;
    pricing = (chosen || sorted[0]).pricing;
  }

  let tier = null;
  for (const row of pricing) {
    if (
      typeof row.min_qty === "number" &&
      typeof row.price === "number" &&
      quantity >= row.min_qty &&
      (tier === null || row.min_qty > tier.min_qty)
    ) {
      tier = row;
    }
  }
  return tier ? tier.price : 0;
}

/**
 * The retail price ladder as base prices in the quote's currency: the
 * variant's market price at each break of `hyve.blank_pricing`, as a share of
 * the first row (the cart transform's retailBreakRatio). One row when there's
 * no ladder.
 */
export function retailBreaks(marketPrice, ladderJson) {
  const rows = (Array.isArray(ladderJson?.breaks) ? ladderJson.breaks : [])
    .filter((row) => Number(row?.min_qty) > 0 && Number(row?.price) > 0)
    .sort((a, b) => Number(a.min_qty) - Number(b.min_qty));
  if (rows.length < 2) return [{ min_qty: 1, price: marketPrice }];
  const first = Number(rows[0].price);
  return rows.map((row, index) => ({
    min_qty: index === 0 ? 1 : Number(row.min_qty),
    price: index === 0 ? marketPrice : roundCents(marketPrice * (Number(row.price) / first)),
  }));
}

/** The base unit price at a quantity: the highest break it reaches. */
export function basePriceAt(breaks, quantity) {
  let chosen = breaks[0];
  for (const row of breaks) if (quantity >= row.min_qty) chosen = row;
  return chosen ? chosen.price : 0;
}

/**
 * A product line's unit price in the quote's currency.
 * @param {{breaks: {min_qty:number, price:number}[], imprintFee: any, wrapFee: number}} pricing
 * @param {{type: "none"|"imprint"|"fcw", method?: string, locations?: string[]}} decoration
 * @param {number} quantity
 * @param {number} rate USD to the quote's currency
 */
export function unitPriceFor(pricing, decoration, quantity, rate) {
  const base = basePriceAt(pricing.breaks, quantity);
  const feeUsd = decorationFeeUsd(pricing, decoration, quantity);
  const unit = feeUsd > 0 ? roundCents(base + feeUsd * rate) : base;
  return { base, fee: roundCents(unit - base), unit };
}

/** The decoration's per-unit fee in USD. */
export function decorationFeeUsd(pricing, decoration, quantity) {
  if (decoration?.type === "imprint") {
    return imprintFeeFor(pricing.imprintFee, decoration.method, (decoration.locations || []).length, quantity);
  }
  if (decoration?.type === "fcw") return Number(pricing.wrapFee) > 0 ? Number(pricing.wrapFee) : 0;
  return 0;
}

/** "SGD 1,234.50", as the quote page prints money. */
export function formatQuoteMoney(amount, currency = "USD") {
  const num = Number(amount) || 0;
  return `${currency} ${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
