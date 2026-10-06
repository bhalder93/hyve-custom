/**
 * The bank a customer pays Hyve into, chosen by the customer's country
 * (Stephen, Sep 22, confirmed Sep 30 on HYV-116):
 *
 *   United States   Community Federal Savings Bank (USD)
 *   Singapore       DBS (SGD)
 *   Europe          Banking Circle
 *   everyone else   DBS (USD)
 *
 * One account per document. The quotation prints it now; the estimate and the
 * proforma invoice will read the same accounts from here.
 *
 * DBS USD and Banking Circle, and the countries that count as Europe, are still
 * being typed out by James. An account without its details prints no bank
 * block rather than a half-filled one: fill in `rows` and it appears.
 */

const ACCOUNT_NAME = "Hyve Promo Pte Ltd";

const ACCOUNTS = {
  DBS_SGD: {
    heading: "For Payment in SGD",
    // As on both NetSuite's quotation and Hyve's own (Q46153).
    rows: [
      ["Bank Name", "DBS Bank Ltd"],
      ["Bank Address", "12 Marina Boulevard, DBS Asia Central, Marina Bay Financial Centre Tower 3, SG 018982"],
      ["SWIFT/BIC", "DBSSSGSG"],
      ["Account Name", ACCOUNT_NAME],
      ["Account Number", "8853796394"],
      ["Bank Code", "7171"],
      ["Branch Code", "072"],
    ],
  },
  CFSB_USD: {
    heading: "For Payment in USD",
    // As on NetSuite's quotation (EST-SG-000007).
    rows: [
      ["Bank Name", "Community Federal Savings Bank"],
      ["Bank Address", "89-16 Jamaica Ave, Woodhaven, NY, United States, 11421"],
      ["SWIFT/BIC", "CMFGUS33"],
      ["Account Name", ACCOUNT_NAME],
      ["Account Number", "8489434183"],
      ["ACH Routing Number", "026073150"],
      ["Fedwire Routing Number", "026073008"],
    ],
  },
  // Details to come from James.
  DBS_USD: { heading: "For Payment in USD", rows: [] },
  BANKING_CIRCLE: { heading: "For Payment in Europe", rows: [] },
};

/** Europe means the EU's 27 member states (Michael, Oct 4). */
const EUROPE_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];

/**
 * @param {string} countryCode the customer's two-letter country
 * @returns {?{heading: string, rows: string[][]}} null until that account's
 *   details are in
 */
export function bankAccountFor(countryCode) {
  const country = String(countryCode || "").toUpperCase();
  const account =
    country === "US"
      ? ACCOUNTS.CFSB_USD
      : country === "SG"
        ? ACCOUNTS.DBS_SGD
        : EUROPE_COUNTRIES.includes(country)
          ? ACCOUNTS.BANKING_CIRCLE
          : ACCOUNTS.DBS_USD;
  return account.rows.length ? account : null;
}
