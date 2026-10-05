/**
 * The legal entity that issues Hyve's documents, confirmed by Hyve on
 * 22 September. The invoice and the quotation both print it (HYV-116), as will
 * the estimate and the proforma invoice.
 *
 * Stated here rather than read from the store. Shopify's `shop.name` is the
 * trading name ("Hyve.Promo"), and `shop.shopAddress` is the trading address,
 * the Orchard Road one Hyve has said must not appear on customer-facing
 * documents. A commercial document carries the registered company, so the
 * registered details are the source.
 */
export const LEGAL_NAME = "HYVE PROMO PTE. LTD.";

/** Hyve's business registration number (UEN). */
export const BUSINESS_REGISTRATION_NUMBER = "202509530E";

/**
 * The registered business address. It doubles as the remit-to address: Hyve
 * confirmed there is no separate one.
 */
export const LEGAL_ADDRESS = ["2 Venture Drive, #11-05", "Vision Exchange", "Singapore 608526"];

/** Linked from the quotation's footer. */
export const TERMS_URL = "https://hyve.promo/policies/terms-of-service";
