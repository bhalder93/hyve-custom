// @ts-check

/**
 * Cart validation for B2B checkouts.
 *
 * This blocks nothing today. It used to stop orders that went past a company's
 * credit limit, but that turned out to be Shopify's own store credit, which
 * Shopify applies at checkout by itself — there is no ceiling left to enforce.
 *
 * The extension is kept, wired and deployed so a future rule only needs the
 * check below and the fields to read it from in the input query.
 */

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

const NO_ERRORS = { operations: [{ validationAdd: { errors: [] } }] };

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const location = input.cart.buyerIdentity?.purchasingCompany?.location;

  // Retail carts are never a B2B concern, and no B2B rule is configured yet.
  if (!location) return NO_ERRORS;

  return NO_ERRORS;
}
