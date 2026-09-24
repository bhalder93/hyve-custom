/**
 * The two commercial thresholds Hyve staff set for themselves (HYV-81).
 *
 *   setup_waiver_threshold  order value at or above which the setup charge is
 *                           waived, for every buyer
 *   minimum_order_value     the smallest order a distributor can check out
 *
 * Both are stored once, on the store, in shop currency (USD), and read from
 * there by everything that acts on them — the cart page, the checkout charges
 * block and the checkout rule that blocks a distributor order under the
 * minimum. Keeping one copy is what stops the cart and checkout disagreeing.
 *
 * The namespace is Hyve's own rather than this app's, because the checkout
 * block and the checkout rule belong to a different app and can only read a
 * store field outside any one app's reserved space. Storefront access is on so
 * the checkout block, which reads through the storefront, can see them.
 *
 * The amounts await question 5; until Hyve confirms them both start at USD 500.
 */

const NAMESPACE = "hyve";

export const COMMERCIAL_SETTINGS = [
  {
    key: "setup_waiver_threshold",
    name: "Setup charge waiver threshold",
    description: "Order value in USD at or above which the setup charge is waived. Converted to the buyer's currency at the market rate.",
    placeholder: "500",
  },
  {
    key: "minimum_order_value",
    name: "Distributor minimum order value",
    description: "The smallest order value in USD a distributor can check out. Converted to the buyer's currency at the market rate.",
    placeholder: "500",
  },
];

const READ_QUERY = `#graphql
  query CommercialSettings {
    shop {
      id
      currencyCode
      setupWaiver: metafield(namespace: "hyve", key: "setup_waiver_threshold") { value }
      minimumOrder: metafield(namespace: "hyve", key: "minimum_order_value") { value }
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
 * Reads the two values, first creating whatever is missing: the definitions,
 * and the placeholder amounts on a store that has never had them. Called when
 * staff open the settings page, so the thresholds exist from the first visit.
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
        type: "number_decimal",
        access: { storefront: "PUBLIC_READ" },
      },
    });
    const error = result.metafieldDefinitionCreate?.userErrors?.[0];
    if (error && error.code !== "TAKEN") throw new Error(`${setting.name}: ${error.message}`);
  }

  const current = {
    setup_waiver_threshold: data.shop.setupWaiver?.value ?? "",
    minimum_order_value: data.shop.minimumOrder?.value ?? "",
  };
  const unset = COMMERCIAL_SETTINGS.filter((setting) => current[setting.key] === "");
  if (unset.length) {
    await saveCommercialSettings(
      admin,
      Object.fromEntries(unset.map((setting) => [setting.key, setting.placeholder])),
      data.shop.id,
    );
    data = await gql(admin, READ_QUERY);
  }

  return {
    currency: data.shop.currencyCode,
    values: {
      setup_waiver_threshold: data.shop.setupWaiver?.value ?? "",
      minimum_order_value: data.shop.minimumOrder?.value ?? "",
    },
  };
}

/**
 * @param {Record<string,string>} values amounts in shop currency, by key
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
export async function saveCommercialSettings(admin, values, shopId) {
  const id = shopId || (await gql(admin, SHOP_ID)).shop.id;

  const metafields = [];
  for (const setting of COMMERCIAL_SETTINGS) {
    if (!(setting.key in values)) continue;
    const amount = Number(String(values[setting.key]).trim());
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, error: `${setting.name} must be a number of zero or more.` };
    }
    metafields.push({
      ownerId: id,
      namespace: NAMESPACE,
      key: setting.key,
      type: "number_decimal",
      value: amount.toFixed(2),
    });
  }
  if (!metafields.length) return { ok: true };

  const result = await gql(admin, SAVE, { metafields });
  const error = result.metafieldsSet?.userErrors?.[0];
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
