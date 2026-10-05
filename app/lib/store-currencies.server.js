/**
 * The currencies the store sells in: the distributor application's currency
 * choice (B6) and the company profile's preferred currency (M1) both offer
 * these.
 *
 * Read from the store's own market settings rather than hard-coded, so the list
 * follows whatever markets are switched on. The launch market set is still
 * being settled, and this way settling it needs no code change. It is read
 * from the Admin API rather than the storefront's localization, which for a
 * signed-in distributor holds only their company's own country.
 */
/**
 * Vietnam distributors buy in USD through their own B2B market, while Vietnam
 * retail stays in VND (HYV-77). The shop's enabled currencies leave a B2B
 * market's currency out, and reading the markets themselves would need the
 * read_markets scope, so it is added here.
 */
const B2B_CURRENCIES = ["USD"];

export async function supportedCurrencies(admin) {
  try {
    const response = await admin.graphql(
      `#graphql
      query SupportedCurrencies {
        shop {
          currencyCode
          enabledPresentmentCurrencies
        }
      }`,
    );
    const body = await response.json();
    const shop = body?.data?.shop;
    const enabled = shop?.enabledPresentmentCurrencies?.length
      ? shop.enabledPresentmentCurrencies
      : shop?.currencyCode
        ? [shop.currencyCode]
        : [];
    return enabled.length ? [...new Set([...enabled, ...B2B_CURRENCIES])].sort() : [];
  } catch (error) {
    console.warn("[account] could not read supported currencies", error?.message || error);
    return [];
  }
}
