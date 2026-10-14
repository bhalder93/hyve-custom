import { defaultBankAccounts, normalizeBankAccounts } from "./bank-details.server";

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
 * Loads the active bank accounts from Shopify shop metafields.
 * Falls back to default hardcoded accounts when not customized yet.
 */
export async function loadBankDetailsConfig(admin) {
  if (!admin) return { accounts: defaultBankAccounts() };

  try {
    const response = await admin.graphql(READ_QUERY);
    const body = await response.json();
    const rawJson = body?.data?.shop?.bankMetafield?.value;
    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      return { accounts: normalizeBankAccounts(parsed) };
    }
  } catch (err) {
    console.warn("[bank-details] failed to load metafield:", err?.message || err);
  }

  return { accounts: defaultBankAccounts() };
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

  const normalized = normalizeBankAccounts(accounts);

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
