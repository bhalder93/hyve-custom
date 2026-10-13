import { EUROPE_COUNTRIES, bankAccountFor, defaultBankAccounts } from "./bank-details.server";

const NAMESPACE = "hyve";
const KEY = "bank_details";

const READ_QUERY = `#graphql
  query ShopBankDetails {
    shop {
      id
      bankMetafield: metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
        id
        value
      }
    }
  }
`;

const SAVE_MUTATION = `#graphql
  mutation SaveBankDetails($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Normalizes accounts data ensuring each account has its heading and rows array.
 */
function normalizeAccounts(stored, defaults) {
  const result = {};
  for (const [accKey, defAcc] of Object.entries(defaults)) {
    const rawAcc = stored?.[accKey] || {};
    result[accKey] = {
      heading: rawAcc.heading || defAcc.heading,
      rows: Array.isArray(rawAcc.rows)
        ? rawAcc.rows.map(([l, v]) => [String(l || "").trim(), String(v || "").trim()]).filter(([l, v]) => l && v)
        : defAcc.rows || [],
    };
  }
  return result;
}

/**
 * Loads the active bank accounts from Shopify shop metafields.
 * Falls back to default hardcoded accounts when not customized yet.
 */
export async function loadBankDetailsConfig(admin) {
  const defaults = defaultBankAccounts();
  if (!admin) return { accounts: defaults };

  try {
    const response = await admin.graphql(READ_QUERY);
    const body = await response.json();
    const rawJson = body?.data?.shop?.bankMetafield?.value;
    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      return { accounts: normalizeAccounts(parsed, defaults) };
    }
  } catch (err) {
    console.warn("[bank-details] failed to load metafield:", err?.message || err);
  }

  return { accounts: defaults };
}

/**
 * Saves customized bank accounts into Shopify shop metafield.
 */
export async function saveBankDetailsConfig(admin, accounts) {
  if (!admin) throw new Error("Admin authentication required");

  const shopRes = await admin.graphql(`{ shop { id } }`);
  const shopBody = await shopRes.json();
  const shopId = shopBody?.data?.shop?.id;
  if (!shopId) throw new Error("Could not fetch shop ID");

  const defaults = defaultBankAccounts();
  const normalized = normalizeAccounts(accounts, defaults);

  const response = await admin.graphql(SAVE_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: shopId,
          namespace: NAMESPACE,
          key: KEY,
          type: "json",
          value: JSON.stringify(normalized),
        },
      ],
    },
  });

  const body = await response.json();
  const errors = body?.data?.metafieldsSet?.userErrors;
  if (errors && errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join(", "));
  }

  return { ok: true, accounts: normalized };
}
