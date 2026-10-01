/**
 * The company a signed-in buyer purchases on behalf of.
 *
 * A quote is a draft order, and a draft order only belongs to a company if it
 * is created with `purchasingEntity.purchasingCompany`. Without it the quote is
 * the individual's, invisible to the rest of their team and priced outside the
 * company's catalog — so every quote raised from the portal is stamped with
 * this.
 *
 * Shopify needs all three ids: the company, the contact raising it, and the
 * location they hold a role at. They come from one read of the customer's
 * company contact profile.
 */

const QUERY = `#graphql
  query PurchasingCompany($id: ID!) {
    customer(id: $id) {
      companyContactProfiles {
        id
        company {
          id
          defaultShipping: metafield(namespace: "hyve", key: "default_shipping_location") { value }
        }
        roleAssignments(first: 10) {
          edges { node { companyLocation { id } } }
        }
      }
    }
  }`;

/**
 * @returns {Promise<{companyId: string, companyContactId: string, companyLocationId: string}|null>}
 *   null when this shopper has no company, or holds no role at a location — in
 *   either case the quote belongs to them alone.
 */
export async function purchasingCompanyFor(admin, customerId) {
  if (!admin || !customerId) return null;

  try {
    const response = await admin.graphql(QUERY, {
      variables: { id: `gid://shopify/Customer/${String(customerId).replace(/\D/g, "")}` },
    });
    const body = await response.json();

    if (body?.errors) {
      console.warn("[portal] purchasing company lookup failed", JSON.stringify(body.errors));
      return null;
    }

    const profile = body?.data?.customer?.companyContactProfiles?.[0];
    const companyId = profile?.company?.id;
    // The company's default shipping address (set on the Addresses page) when
    // this buyer may order for it, otherwise their first location.
    const locationIds = (profile?.roleAssignments?.edges || [])
      .map((edge) => edge?.node?.companyLocation?.id)
      .filter(Boolean);
    const preferred = profile?.company?.defaultShipping?.value;
    const companyLocationId = locationIds.includes(preferred) ? preferred : locationIds[0];

    if (!companyId || !companyLocationId || !profile.id) return null;

    return { companyId, companyContactId: profile.id, companyLocationId };
  } catch (error) {
    console.warn("[portal] purchasing company lookup failed", error?.message || error);
    return null;
  }
}

/**
 * The `purchasingEntity` for a new draft order: the company when there is one,
 * otherwise the person themselves.
 */
export function purchasingEntity(company, customerGid) {
  return company ? { purchasingCompany: company } : { customerId: customerGid };
}
