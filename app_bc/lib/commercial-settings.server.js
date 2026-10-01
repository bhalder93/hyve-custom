/**
 * The commercial settings Hyve staff set for themselves.
 *
 *   setup_waiver_threshold    order value at or above which the setup charge
 *                             is waived, for every buyer (HYV-81)
 *   minimum_order_value       the smallest order a distributor can check out
 *                             (HYV-81)
 *   production_days_standard  business days from Artwork Proof approval to
 *   production_days_rush      production complete, without and with rush
 *                             (HYV-133)
 *   artwork_due_days          business days after an order is placed that
 *                             artwork sent later is due, shown to the buyer as
 *                             the "by" date on an order waiting for it
 *                             (HYV-102); blank for no deadline
 *
 * Each is stored once, on the store, and read from there by everything that
 * acts on it. The two amounts are in shop currency (USD), read by the cart
 * page, the checkout charges block and the checkout rule that blocks a
 * distributor order under the minimum. The production times are read by the
 * product page, the cart and the quote, which promise them, and by every
 * production due date, which is counted from them. Keeping one copy is what
 * stops two screens quoting different numbers.
 *
 * The namespace is Hyve's own rather than this app's, because the checkout
 * block and the checkout rule belong to a different app and can only read a
 * store field outside any one app's reserved space. Storefront access is on so
 * the checkout block, which reads through the storefront, can see them.
 *
 * The amounts await question 5; until Hyve confirms them both start at USD 500.
 */

const NAMESPACE = "hyve";

/**
 * `kind` sets how a setting is stored and entered: an amount in shop currency,
 * or a whole number of business days. `section` is where the settings page
 * lists it. `placeholder` is the value a store that has never saved the
 * setting starts with; an `optional` one starts blank and may be left blank.
 */
export const COMMERCIAL_SETTINGS = [
  {
    key: "setup_waiver_threshold",
    section: "thresholds",
    kind: "money",
    name: "Setup charge waiver threshold",
    description: "Order value in USD at or above which the setup charge is waived. Converted to the buyer's currency at the market rate.",
    placeholder: "500",
  },
  {
    key: "minimum_order_value",
    section: "thresholds",
    kind: "money",
    name: "Distributor minimum order value",
    description: "The smallest order value in USD a distributor can check out. Converted to the buyer's currency at the market rate.",
    placeholder: "500",
  },
  {
    key: "production_days_standard",
    section: "production",
    kind: "days",
    name: "Standard production",
    description: "Business days from Artwork Proof approval, weekends and Singapore holidays excluded. The product page, cart and quote show it, and each order's production due date is counted from it.",
    placeholder: "5",
  },
  {
    key: "production_days_rush",
    section: "production",
    kind: "days",
    name: "Rush production",
    description: "The same for an order with Rush Production.",
    placeholder: "3",
  },
  {
    key: "artwork_due_days",
    section: "artwork",
    kind: "days",
    optional: true,
    name: "Artwork deadline",
    description: "Business days after an order is placed that artwork sent later is due, weekends and Singapore holidays excluded. The buyer sees the date on an order waiting for artwork. Leave blank for no deadline.",
    placeholder: "",
  },
];

const METAFIELD_TYPES = { money: "number_decimal", days: "number_integer" };

const READ_QUERY = `#graphql
  query CommercialSettings {
    shop {
      id
      currencyCode
      ${COMMERCIAL_SETTINGS.map(({ key }) => `${key}: metafield(namespace: "${NAMESPACE}", key: "${key}") { value }`).join("\n      ")}
    }
    metafieldDefinitions(first: 20, ownerType: SHOP, namespace: "hyve") {
      nodes { key }
    }
  }`;

const CREATE_DEFINITION = `#graphql
  mutation CreateCommercialDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message code }
    }
  }`;

const SHOP_ID = `#graphql
  query ShopId {
    shop { id }
  }`;

const CLEAR = `#graphql
  mutation ClearCommercialSettings($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

const SAVE = `#graphql
  mutation SaveCommercialSettings($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key value }
      userErrors { field message code }
    }
  }`;

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = await response.json();
  if (body?.errors?.length) throw new Error(body.errors[0]?.message || "Shopify rejected the request.");
  return body.data;
}

/**
 * Reads the values, first creating whatever is missing: the definitions, and
 * the placeholder values on a store that has never had them. Called when staff
 * open the settings page, and by the production due date, so the settings
 * exist from the first visit or the first proof approved, whichever is first.
 *
 * @returns {Promise<{currency:string, values:Record<string,string>}>}
 */
export async function loadCommercialSettings(admin) {
  let data = await gql(admin, READ_QUERY);
  const defined = new Set((data.metafieldDefinitions?.nodes || []).map((node) => node.key));

  for (const setting of COMMERCIAL_SETTINGS) {
    if (defined.has(setting.key)) continue;
    const result = await gql(admin, CREATE_DEFINITION, {
      definition: {
        ownerType: "SHOP",
        namespace: NAMESPACE,
        key: setting.key,
        name: setting.name,
        description: setting.description,
        type: METAFIELD_TYPES[setting.kind],
        access: { storefront: "PUBLIC_READ" },
      },
    });
    const error = result.metafieldDefinitionCreate?.userErrors?.[0];
    if (error && error.code !== "TAKEN") throw new Error(`${setting.name}: ${error.message}`);
  }

  const valuesOf = (shop) =>
    Object.fromEntries(COMMERCIAL_SETTINGS.map(({ key }) => [key, shop[key]?.value ?? ""]));
  const unset = COMMERCIAL_SETTINGS.filter((setting) => !setting.optional && valuesOf(data.shop)[setting.key] === "");
  if (unset.length) {
    await saveCommercialSettings(
      admin,
      Object.fromEntries(unset.map((setting) => [setting.key, setting.placeholder])),
      data.shop.id,
    );
    data = await gql(admin, READ_QUERY);
  }

  return { currency: data.shop.currencyCode, values: valuesOf(data.shop) };
}

/**
 * @param {Record<string,string>} values by key: amounts in shop currency, and
 *   whole business days
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
export async function saveCommercialSettings(admin, values, shopId) {
  const id = shopId || (await gql(admin, SHOP_ID)).shop.id;

  const metafields = [];
  const cleared = [];
  for (const setting of COMMERCIAL_SETTINGS) {
    if (!(setting.key in values)) continue;
    const raw = String(values[setting.key]).trim();
    if (setting.optional && raw === "") {
      cleared.push({ ownerId: id, namespace: NAMESPACE, key: setting.key });
      continue;
    }
    const amount = Number(raw);
    if (setting.kind === "days") {
      if (!Number.isInteger(amount) || amount < 1) {
        return { ok: false, error: `${setting.name} must be a whole number of business days, 1 or more.` };
      }
    } else if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, error: `${setting.name} must be a number of zero or more.` };
    }
    metafields.push({
      ownerId: id,
      namespace: NAMESPACE,
      key: setting.key,
      type: METAFIELD_TYPES[setting.kind],
      value: setting.kind === "days" ? String(amount) : amount.toFixed(2),
    });
  }
  if (cleared.length) {
    const result = await gql(admin, CLEAR, { metafields: cleared });
    const error = result.metafieldsDelete?.userErrors?.[0];
    if (error) return { ok: false, error: error.message };
  }
  if (!metafields.length) return { ok: true };

  const result = await gql(admin, SAVE, { metafields });
  const error = result.metafieldsSet?.userErrors?.[0];
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
