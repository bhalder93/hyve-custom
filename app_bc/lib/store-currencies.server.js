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
    const list = shop?.enabledPresentmentCurrencies || [];
    if (list.length) return list;
    return shop?.currencyCode ? [shop.currencyCode] : [];
  } catch (error) {
    console.warn("[account] could not read supported currencies", error?.message || error);
    return [];
  }
}
