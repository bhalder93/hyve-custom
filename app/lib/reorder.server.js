/**
 * Reorder: place the same items again as a real, unpaid order.
 *
 * The buyer ends up with an order, not a draft sitting in their account. It is
 * built through a draft order and completed immediately, because `orderCreate`
 * has no `purchasingEntity` field — an order created that way would not belong
 * to the buyer's company, so it would miss their B2B catalog pricing and their
 * payment terms. A draft carries the company through, and completing it turns
 * it into the order.
 *
 * Only line items that still resolve to a variant carry over; a custom or
 * deleted line can't be bought again, so the caller is told what was dropped.
 */

const SOURCE_QUERY = `#graphql
  query ReorderSource($id: ID!) {
    order(id: $id) {
      id
      name
      email
      customer { id }
      purchasingEntity {
        ... on PurchasingCompany {
          company { id }
          contact { id }
          location {
            id
            buyerExperienceConfiguration { paymentTermsTemplate { id name } }
          }
        }
      }
      lineItems(first: 100) {
        nodes {
          title
          quantity
          variant { id }
          customAttributes { key value }
        }
      }
    }
  }`;

const DRAFT_CREATE = `#graphql
  mutation ReorderDraftCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }`;

const DRAFT_COMPLETE = `#graphql
  mutation ReorderDraftComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        id
        order { id name displayFinancialStatus statusPageUrl(audience: CUSTOMERVIEW) }
      }
      userErrors { field message }
    }
  }`;

const NOTIFY = `#graphql
  mutation ReorderNotify($id: ID!) {
    orderInvoiceSend(id: $id) {
      order { id }
      userErrors { field message }
    }
  }`;

/**
 * @param {string} orderGid the order being repeated
 * @param {string} customerGid the signed-in buyer, who must own that order
 * @returns {Promise<{ok:boolean, error?:string, name?:string, href?:string,
 *   skipped?:number, emailed?:boolean}>}
 */
export async function reorder(admin, orderGid, customerGid) {
  if (!admin || !orderGid || !customerGid) {
    return { ok: false, error: "We couldn't work out which order to repeat." };
  }

  const source = await gql(admin, SOURCE_QUERY, { id: orderGid });
  const order = source?.order;
  if (!order) return { ok: false, error: "We couldn't find that order." };

  // A buyer may only repeat their own order.
  if (order.customer?.id !== customerGid) {
    return { ok: false, error: "We couldn't find that order." };
  }

  const all = order.lineItems?.nodes || [];
  const lineItems = all
    .filter((li) => li.variant?.id)
    .map((li) => ({
      variantId: li.variant.id,
      quantity: li.quantity,
      // Artwork and personalisation live on the line, so they come across too.
      ...(li.customAttributes?.length
        ? { customAttributes: li.customAttributes.map(({ key, value }) => ({ key, value })) }
        : {}),
    }));

  if (!lineItems.length) {
    return { ok: false, error: "None of the items on that order can be bought again." };
  }

  const company = order.purchasingEntity?.company?.id ? order.purchasingEntity : null;
  const template = company?.location?.buyerExperienceConfiguration?.paymentTermsTemplate?.id;

  const input = {
    lineItems,
    useCustomerDefaultAddress: true,
    tags: ["reorder"],
    note: `Reorder of ${order.name}`,
    ...(company
      ? {
          purchasingEntity: {
            purchasingCompany: {
              companyId: company.company.id,
              companyLocationId: company.location.id,
              companyContactId: company.contact?.id,
            },
          },
        }
      : { purchasingEntity: { customerId: customerGid } }),
    // The company's own terms, so the new order is due when their others are.
    ...(template
      ? {
          paymentTerms: {
            paymentTermsTemplateId: template,
            paymentSchedules: [{ issuedAt: new Date().toISOString() }],
          },
        }
      : {}),
  };

  const created = await gql(admin, DRAFT_CREATE, { input });
  const createError = created?.draftOrderCreate?.userErrors?.[0];
  if (createError) return { ok: false, error: createError.message };

  const draftId = created?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) return { ok: false, error: "We couldn't build that order." };

  const completed = await gql(admin, DRAFT_COMPLETE, { id: draftId });
  const completeError = completed?.draftOrderComplete?.userErrors?.[0];
  if (completeError) return { ok: false, error: completeError.message };

  const placed = completed?.draftOrderComplete?.draftOrder?.order;
  if (!placed) return { ok: false, error: "The order was not placed." };

  // The buyer gets the order by email with its payment link. A failure here
  // doesn't undo a real order, so it's reported rather than thrown.
  const notified = await gql(admin, NOTIFY, { id: placed.id });
  const notifyError = notified?.orderInvoiceSend?.userErrors?.[0];
  if (notifyError) console.warn("[reorder] email not sent:", notifyError.message);

  return {
    ok: true,
    name: placed.name,
    href: placed.statusPageUrl || "",
    skipped: all.length - lineItems.length,
    emailed: !notifyError,
  };
}

async function gql(admin, query, variables) {
  try {
    const response = await admin.graphql(query, { variables });
    const body = await response.json();
    if (body?.errors) {
      console.error("[reorder] graphql errors", JSON.stringify(body.errors));
      return null;
    }
    return body?.data || null;
  } catch (error) {
    console.error("[reorder] request threw", error);
    return null;
  }
}
