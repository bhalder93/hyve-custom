/**
 * The bank a customer pays Hyve into, chosen by the customer's country
 * (Stephen, Sep 22, confirmed Sep 30 on HYV-116):
 *
 *   United States   Community Federal Savings Bank (USD)
 *   Singapore       DBS (SGD)
 *   Europe          Banking Circle
 *   everyone else   DBS (USD)
 *
 * One account per document. The quotation, invoice and portal remittance panel
 * all read the same accounts from here.
 */

export const ACCOUNT_NAME = "HYVE PROMO PTE. LTD.";

export const DEFAULT_ACCOUNTS = {
  DBS_SGD: {
    heading: "For Payment in SGD",
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
  DBS_USD: {
    heading: "For Payment in USD",
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
  BANKING_CIRCLE: {
    heading: "For Payment in EUR",
    rows: [
      ["Bank Name", "Banking Circle S.A."],
      ["Account Name", ACCOUNT_NAME],
      ["Account Number", "0059357820"],
      ["Bank Code", "8900"],
      ["SWIFT/BIC", "SXPYDKKK"],
    ],
  },
};

/** Europe means the EU's 27 member states (Michael, Oct 4). */
export const EUROPE_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];

export function defaultBankAccounts() {
  return JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
}

/** Fill legacy empty/missing rows from defaults and enforce the legal account name. */
export function normalizeBankAccounts(stored) {
  return Object.fromEntries(
    Object.entries(DEFAULT_ACCOUNTS).map(([accountKey, defaults]) => {
      const configured = stored?.[accountKey] || {};
      const rows = new Map(defaults.rows);

      if (Array.isArray(configured.rows)) {
        for (const [rawLabel, rawValue] of configured.rows) {
          const label = String(rawLabel || "").trim();
          const value = String(rawValue || "").trim();
          if (!label || label === "Account Name") continue;
          if (value) rows.set(label, value);
          else if (!rows.has(label)) rows.delete(label);
        }
      }

      if (rows.has("Account Name")) rows.set("Account Name", ACCOUNT_NAME);

      return [accountKey, {
        heading: String(configured.heading || defaults.heading).trim(),
        rows: [...rows.entries()].filter(([, value]) => value),
      }];
    }),
  );
}

/** Prefer the shipping destination, then the billing/customer country. */
export function bankCountryFor({
  shippingCountry,
  billingCountry,
  locationShippingCountry,
  locationBillingCountry,
  customerCountry,
  fallbackCountry,
} = {}) {
  return [
    shippingCountry,
    billingCountry,
    locationShippingCountry,
    locationBillingCountry,
    customerCountry,
    fallbackCountry,
  ]
    .map((country) => String(country || "").trim().toUpperCase())
    .find(Boolean) || "";
}

/**
 * Resolves the appropriate bank account for a country, optionally using
 * custom accounts loaded dynamically from the app settings.
 *
 * The document's currency comes first, so the account always takes what the
 * document asks for (HYV-195): an SGD document is paid to DBS SGD, a EUR one to
 * Banking Circle, and any other to CFSB for a US buyer or DBS USD for everyone
 * else, wherever the goods ship. With no currency, the country decides. An
 * account with no details saved falls back to the built-in one.
 *
 * @param {string} countryCode the customer's two-letter country or currency code
 * @param {Record<string, {heading: string, rows: string[][]}>} [customAccounts] optional dynamically loaded accounts
 * @param {string} [currencyCode] optional currency code of the order/invoice (e.g. "SGD", "USD", "EUR")
 * @returns {{heading: string, rows: string[][]}}
 */
export function bankAccountFor(countryCode, customAccounts, currencyCode) {
  const country = String(countryCode || "").trim().toUpperCase();
  const currency = String(currencyCode || "").trim().toUpperCase();
  const accounts = normalizeBankAccounts(customAccounts);

  const effectiveCurrency =
    currency || (["SGD", "EUR", "USD"].includes(country) ? country : "");

  // If order is in SGD, or country is SG (and no other currency explicitly given):
  if (effectiveCurrency === "SGD" || (!effectiveCurrency && (country === "SG" || country === "SGD"))) {
    const acc = accounts.DBS_SGD;
    return acc && Array.isArray(acc.rows) && acc.rows.length ? acc : DEFAULT_ACCOUNTS.DBS_SGD;
  }

  // If order is in EUR, or European country (and no other currency explicitly given):
  if (effectiveCurrency === "EUR" || (!effectiveCurrency && (country === "EUR" || EUROPE_COUNTRIES.includes(country)))) {
    const acc = accounts.BANKING_CIRCLE;
    return acc && Array.isArray(acc.rows) && acc.rows.length ? acc : DEFAULT_ACCOUNTS.BANKING_CIRCLE;
  }

  // USD / Default:
  const isUs = country === "US" || country === "USA";
  const preferred = isUs ? accounts.CFSB_USD : accounts.DBS_USD;
  const fallback = isUs ? accounts.DBS_USD : accounts.CFSB_USD;
  const defPreferred = isUs ? DEFAULT_ACCOUNTS.CFSB_USD : DEFAULT_ACCOUNTS.DBS_USD;
  const defFallback = isUs ? DEFAULT_ACCOUNTS.DBS_USD : DEFAULT_ACCOUNTS.CFSB_USD;

  const resolved =
    (preferred?.rows?.length ? preferred : null) ||
    (fallback?.rows?.length ? fallback : null) ||
    defPreferred ||
    defFallback;

  return resolved;
}
