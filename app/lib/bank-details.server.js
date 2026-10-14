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

/**
 * Resolves the appropriate bank account for a country, optionally using
 * custom accounts loaded dynamically from the app settings.
 *
 * @param {string} countryCode the customer's two-letter country or currency code
 * @param {Record<string, {heading: string, rows: string[][]}>} [customAccounts] optional dynamically loaded accounts
 * @returns {?{heading: string, rows: string[][]}} null until that account's details are filled in
 */
export function bankAccountFor(countryCode, customAccounts) {
  const country = String(countryCode || "").toUpperCase();
  const accounts = normalizeBankAccounts(customAccounts);

  const account =
    country === "US"
      ? accounts.CFSB_USD
      : country === "SG"
        ? accounts.DBS_SGD
        : EUROPE_COUNTRIES.includes(country)
          ? accounts.BANKING_CIRCLE
          : accounts.DBS_USD;

  return account && Array.isArray(account.rows) && account.rows.length ? account : null;
}
