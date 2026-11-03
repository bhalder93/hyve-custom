/**
 * 30% deposit, 70% before shipment (HYV-150, Bruce, Oct 16).
 *
 * Distributors without credit terms get Shopify's "Due on fulfillment" terms
 * with a 30% deposit on their company location, set at approval (or moved by
 * the Distributors page button). At checkout they pay the 30% by card, or pick
 * Bank transfer and upload the payment confirmation from their account.
 *
 * Two holds in Hyve Custom, worked out from what Shopify says the order has
 * received, so nothing has to be cleared by hand:
 *   - Deposit pending: the order can't go to Proof Sent or In Production until
 *     the 30% is in. A card deposit is in at checkout; a bank transfer is in
 *     once Customer Service records it (Record deposit received).
 *   - Payment required before release: the order can't go to Ready For
 *     Collection or Shipped until it's fully paid. At Production Complete the
 *     buyer is emailed the balance with the invoice and a Pay now link.
 *
 * The location also carries `hyve.deposit_percentage`, which checkout reads
 * (the deposit note, and the payment rule that shows Bank transfer only to
 * these distributors). The order keeps the deposit it was placed with in
 * `hyve.deposit_due`, so a later change to the location doesn't move it: a
 * plain amount in the order's own currency (a money field would have to be in
 * the store's currency).
 */

export const DEPOSIT_PERCENTAGE = 30;
/** A deposit order's "Due on fulfillment", as the buyer reads it. */
export const DEPOSIT_TERMS = `${DEPOSIT_PERCENTAGE}% deposit, balance before shipment`;
export const DEPOSIT_TAG = "hyve-deposit";
export const BANK_TRANSFER_METHOD = "Bank transfer";
const NAMESPACE = "hyve";

const TEMPLATES_QUERY = `#graphql
  query DepositTemplates {
    paymentTermsTemplates(paymentTermsType: FULFILLMENT) { id name paymentTermsType }
  }`;

const LOCATION_QUERY = `#graphql
  query DepositLocation($id: ID!) {
    companyLocation(id: $id) {
      id
      buyerExperienceConfiguration {
        paymentTermsTemplate { id name paymentTermsType }
        deposit { ... on DepositPercentage { percentage } }
      }
      depositField: metafield(namespace: "hyve", key: "deposit_percentage") { value }
    }
  }`;

const METAFIELDS_DELETE = `#graphql
  mutation DepositFieldDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }`;

const LOCATION_UPDATE = `#graphql
  mutation DepositTerms($id: ID!, $input: CompanyLocationUpdateInput!) {
    companyLocationUpdate(companyLocationId: $id, input: $input) {
      companyLocation { id }
      userErrors { field message code }
    }
  }`;

const DEFINITIONS_QUERY = `#graphql
  query DepositDefinitions {
    metafieldDefinitions(first: 1, ownerType: COMPANY_LOCATION, namespace: "${NAMESPACE}", key: "deposit_percentage") {
      nodes { id }
    }
  }`;

const DEFINITION_CREATE = `#graphql
  mutation DepositDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }`;

const METAFIELDS_SET = `#graphql
  mutation DepositSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

const TAGS_ADD = `#graphql
  mutation DepositTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;

export const DEPOSIT_ORDER_QUERY = `#graphql
  query DepositOrder($id: ID!) {
    order(id: $id) {
      id
      name
      email
      statusPageUrl
      cancelledAt
      displayFinancialStatus
      totalPriceSet { presentmentMoney { amount currencyCode } }
      totalReceivedSet { presentmentMoney { amount currencyCode } }
      totalOutstandingSet { presentmentMoney { amount currencyCode } }
      purchasingEntity { ... on PurchasingCompany { location { id } company { name } } }
      depositDue: metafield(namespace: "hyve", key: "deposit_due") { value }
    }
  }`;

const MANUAL_PAYMENT = `#graphql
  mutation DepositPayment($id: ID!, $amount: MoneyInput!, $method: String) {
    orderCreateManualPayment(id: $id, amount: $amount, paymentMethodName: $method) {
      order { id displayFinancialStatus }
      userErrors { field message code }
    }
  }`;

async function run(admin, query, variables) {
  const body = await (await admin.graphql(query, variables ? { variables } : undefined)).json();
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
  return body?.data;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** The location field checkout reads. Storefront read lets checkout see it. */
export async function ensureDepositDefinition(admin) {
  if ((await run(admin, DEFINITIONS_QUERY))?.metafieldDefinitions?.nodes?.length) return;
  const result = (
    await run(admin, DEFINITION_CREATE, {
      definition: {
        name: "Deposit at checkout (%)",
        namespace: NAMESPACE,
        key: "deposit_percentage",
        type: "number_integer",
        ownerType: "COMPANY_LOCATION",
        description: "Set by Hyve Custom with the location's deposit terms. Read by checkout (HYV-150).",
        pin: false,
        access: { storefront: "PUBLIC_READ" },
      },
    })
  )?.metafieldDefinitionCreate;
  const error = result?.userErrors?.[0];
  if (error && error.code !== "TAKEN") throw new Error(error.message);
}

/** The location's deposit, or 0 when it has none. */
export async function locationDeposit(admin, locationGid) {
  const config = (await run(admin, LOCATION_QUERY, { id: locationGid }))?.companyLocation?.buyerExperienceConfiguration;
  return {
    percentage: Number(config?.deposit?.percentage) || 0,
    terms: config?.paymentTermsTemplate || null,
  };
}

/**
 * Puts a location on "Due on fulfillment" with the 30% deposit, and mirrors
 * the percentage for checkout.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function setDepositTerms(admin, locationGid) {
  const template = (await run(admin, TEMPLATES_QUERY))?.paymentTermsTemplates?.[0];
  if (!template) return { ok: false, detail: 'No "Due on fulfillment" payment terms on this store.' };
  const updated = (
    await run(admin, LOCATION_UPDATE, {
      id: locationGid,
      input: {
        buyerExperienceConfiguration: {
          paymentTermsTemplateId: template.id,
          checkoutToDraft: false,
          deposit: { percentage: DEPOSIT_PERCENTAGE },
        },
      },
    })
  )?.companyLocationUpdate;
  const error = updated?.userErrors?.[0]?.message;
  if (error) return { ok: false, detail: error };

  await ensureDepositDefinition(admin);
  const saved = (
    await run(admin, METAFIELDS_SET, {
      metafields: [
        {
          ownerId: locationGid,
          namespace: NAMESPACE,
          key: "deposit_percentage",
          type: "number_integer",
          value: String(DEPOSIT_PERCENTAGE),
        },
      ],
    })
  )?.metafieldsSet;
  const savedError = saved?.userErrors?.[0]?.message;
  if (savedError) return { ok: false, detail: savedError };
  return { ok: true, detail: `${DEPOSIT_PERCENTAGE}% deposit with the balance before shipment` };
}

/**
 * company_locations/update: checkout reads the deposit from
 * `hyve.deposit_percentage` (the Bank transfer rule and the deposit note), so
 * it follows Shopify's own deposit setting. A deposit set by hand in Shopify
 * admin then works like one set by Hyve Custom, and one removed stops showing
 * Bank transfer. Writes only on a difference, so its own change is a no-op.
 * @returns {Promise<{changed: boolean, percentage: number}>}
 */
export async function syncDepositField(admin, locationGid) {
  const location = (await run(admin, LOCATION_QUERY, { id: locationGid }))?.companyLocation;
  if (!location) return { changed: false, percentage: 0 };
  const percentage = Number(location.buyerExperienceConfiguration?.deposit?.percentage) || 0;
  const stored = Number(location.depositField?.value) || 0;
  if (percentage === stored) return { changed: false, percentage };

  if (percentage > 0) {
    await ensureDepositDefinition(admin);
    const saved = (
      await run(admin, METAFIELDS_SET, {
        metafields: [
          { ownerId: locationGid, namespace: NAMESPACE, key: "deposit_percentage", type: "number_integer", value: String(Math.round(percentage)) },
        ],
      })
    )?.metafieldsSet;
    const error = saved?.userErrors?.[0]?.message;
    if (error) throw new Error(error);
  } else {
    const removed = (
      await run(admin, METAFIELDS_DELETE, {
        metafields: [{ ownerId: locationGid, namespace: NAMESPACE, key: "deposit_percentage" }],
      })
    )?.metafieldsDelete;
    const error = removed?.userErrors?.[0]?.message;
    if (error) throw new Error(error);
  }
  return { changed: true, percentage };
}

/**
 * The Distributors page button: every location with no payment terms moves to
 * the deposit terms. Locations with credit terms, or already on a deposit, are
 * left alone.
 */
export async function useDepositTermsWhereNoTerms(admin, locationGid) {
  const { percentage, terms } = await locationDeposit(admin, locationGid);
  if (percentage) return { ok: true, skipped: true, detail: "Already on a deposit." };
  if (terms) return { ok: true, skipped: true, detail: `On ${terms.name}.` };
  return setDepositTerms(admin, locationGid);
}

const CHECKOUT_PAYMENTS = `#graphql
  query DepositCheckoutPayments($id: ID!) {
    order(id: $id) {
      transactions(first: 20) { kind status amountSet { presentmentMoney { amount } } }
    }
  }`;

/**
 * The deposit Shopify asked for at checkout: what the buyer paid by card, or
 * the pending Bank transfer payment. Shopify rounds the 30% its own way
 * (USD 798.75 asked 239.62, not 239.63), so its figure is kept rather than
 * worked out again. Null for an order with no checkout payment.
 */
async function checkoutDeposit(admin, orderGid) {
  const transactions = (await run(admin, CHECKOUT_PAYMENTS, { id: orderGid }))?.order?.transactions || [];
  const paid = transactions.filter(
    (t) => ["SALE", "AUTHORIZATION"].includes(t.kind) && ["SUCCESS", "PENDING"].includes(t.status),
  );
  if (!paid.length) return null;
  return round2(paid.reduce((sum, t) => sum + Number(t.amountSet?.presentmentMoney?.amount || 0), 0));
}

/**
 * orders/create: an order from a deposit location keeps the deposit it was
 * placed with, in its own currency. An order with no checkout payment (made
 * by staff from a draft) has the location's percentage of its total, cut down
 * to the cent as checkout asks it.
 */
export async function recordOrderDeposit(admin, orderGid, locationGid) {
  if (!locationGid) return { deposit: false };
  const { percentage } = await locationDeposit(admin, locationGid);
  if (!percentage) return { deposit: false };
  const order = (await run(admin, DEPOSIT_ORDER_QUERY, { id: orderGid }))?.order;
  if (!order || order.depositDue?.value) return { deposit: Boolean(order?.depositDue?.value) };
  const total = order.totalPriceSet?.presentmentMoney;
  const atCheckout = await checkoutDeposit(admin, orderGid);
  // With no checkout payment, the percentage cut down to the cent, as
  // Shopify's checkout asks it (30% of 106.63 is 31.98).
  const amount = (atCheckout ?? Math.floor((Number(total?.amount) || 0) * percentage + 1e-9) / 100).toFixed(2);
  const saved = (
    await run(admin, METAFIELDS_SET, {
      metafields: [
        {
          ownerId: orderGid,
          namespace: NAMESPACE,
          key: "deposit_due",
          type: "number_decimal",
          value: amount,
        },
      ],
    })
  )?.metafieldsSet;
  const error = saved?.userErrors?.[0]?.message;
  if (error) throw new Error(error);
  await run(admin, TAGS_ADD, { id: orderGid, tags: [DEPOSIT_TAG] });
  return { deposit: true, amount, currency: total?.currencyCode };
}

/**
 * Where a deposit order stands, from Shopify's own paid figures. Null for an
 * order with no deposit.
 * @param {object} order loaded with DEPOSIT_ORDER_QUERY's fields
 */
export function depositState(order) {
  const raw = order?.depositDue?.value;
  if (raw == null || raw === "" || !Number.isFinite(Number(raw))) return null;
  const currency = order.totalPriceSet?.presentmentMoney?.currencyCode || "";
  const deposit = round2(raw);
  const received = round2(order.totalReceivedSet?.presentmentMoney?.amount);
  const outstanding = round2(order.totalOutstandingSet?.presentmentMoney?.amount);
  return {
    currency,
    deposit,
    received,
    outstanding,
    total: round2(order.totalPriceSet?.presentmentMoney?.amount),
    depositPending: received + 0.005 < deposit,
    balanceDue: outstanding > 0.005,
  };
}

export async function loadDepositOrder(admin, orderGid) {
  return (await run(admin, DEPOSIT_ORDER_QUERY, { id: orderGid }))?.order || null;
}

const money = (currency, amount) => `${currency} ${Number(amount).toFixed(2)}`;

/** Production can't start: no proof and no In Production before the deposit. */
const NEEDS_DEPOSIT = new Set(["proof-sent", "in-production"]);
/** Release: no Ready For Collection and no Shipped before it's fully paid. */
const NEEDS_FULL_PAYMENT = new Set(["ready-for-collection", "shipped"]);

/**
 * Why a status move has to wait for payment, or "" when it can go ahead.
 * @param {ReturnType<typeof depositState>} state
 */
export function paymentBlocksMove(state, nextStatus) {
  if (!state) return "";
  if (NEEDS_DEPOSIT.has(nextStatus) && state.depositPending) {
    return `Deposit pending: ${money(state.currency, state.received)} of the ${money(state.currency, state.deposit)} deposit received. Record the deposit once the bank transfer arrives.`;
  }
  if (NEEDS_FULL_PAYMENT.has(nextStatus) && state.balanceDue) {
    return `Payment required before release: ${money(state.currency, state.outstanding)} still due.`;
  }
  return "";
}

/**
 * Customer Service records a bank transfer deposit: a manual payment for what's
 * still missing of the deposit, so Shopify shows the balance as due.
 */
export async function recordDepositReceived(admin, orderGid) {
  const order = await loadDepositOrder(admin, orderGid);
  const state = depositState(order);
  if (!state) return { ok: false, error: "This order has no deposit." };
  if (!state.depositPending) return { ok: false, error: "The deposit is already in." };
  const amount = round2(state.deposit - state.received).toFixed(2);
  const result = (
    await run(admin, MANUAL_PAYMENT, {
      id: orderGid,
      amount: { amount, currencyCode: state.currency },
      method: BANK_TRANSFER_METHOD,
    })
  )?.orderCreateManualPayment;
  const error = result?.userErrors?.[0]?.message;
  if (error) return { ok: false, error };

  // The buyer hears the deposit is in. The payment stands if the email fails.
  let emailed = false;
  if (order.email) {
    try {
      const extra = (await run(admin, ORDER_TAGS, { id: orderGid }))?.order;
      const { sendDepositReceivedEmail } = await import("../utils/email.server");
      const { artworkPending } = await import("./portal.server");
      await sendDepositReceivedEmail({
        customerEmail: order.email,
        customerName: extra?.customer?.displayName || extra?.billingAddress?.name || "",
        orderName: order.name,
        orderDate: extra?.createdAt,
        depositPaid: money(state.currency, state.deposit),
        balanceDue: money(state.currency, round2(state.total - state.deposit)),
        next:
          extra?.artworkRequired?.value === "false"
            ? "production"
            : extra && artworkPending(extra)
              ? "artwork"
              : "proof",
      });
      emailed = true;
    } catch (emailError) {
      console.error("[deposit] deposit received email failed", order.name, emailError?.message || emailError);
    }
  }
  return {
    ok: true,
    message: `Deposit of ${money(state.currency, amount)} recorded. Production can start.${
      emailed ? " The buyer was emailed." : " The buyer email couldn't be sent."
    }`,
  };
}

export const BALANCE_REQUEST_TAG = "hyve-notified:balance-request";

const ORDER_TAGS = `#graphql
  query DepositOrderTags($id: ID!) {
    order(id: $id) {
      tags
      createdAt
      customer { displayName }
      billingAddress { name }
      # What comes next for the buyer: nothing printed means no proof, and
      # send-later artwork means the proof waits for it.
      artworkRequired: metafield(namespace: "$app", key: "artwork_required") { value }
      customAttributes { key value }
      lineItems(first: 100) { nodes { customAttributes { key value } } }
    }
  }`;

/**
 * At Production Complete: emails the buyer the balance, once per order, with
 * the invoice PDF (bank details) and the order's own payment page.
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function sendBalanceRequest(admin, orderGid) {
  const order = await loadDepositOrder(admin, orderGid);
  const state = depositState(order);
  if (!state) return { sent: false, reason: "no deposit" };
  if (!state.balanceDue) return { sent: false, reason: "already paid" };
  if (!order.email) return { sent: false, reason: "no buyer email" };
  const extra = (await run(admin, ORDER_TAGS, { id: orderGid }))?.order;
  if ((extra?.tags || []).includes(BALANCE_REQUEST_TAG)) return { sent: false, reason: "already sent" };

  const { loadInvoiceDocument } = await import("./invoice-document.server");
  const { buildInvoicePdf } = await import("./invoice-pdf.server.jsx");
  const { sendBalanceRequestEmail } = await import("../utils/email.server");
  const doc = await loadInvoiceDocument(admin, orderGid, { system: true });
  const pdf = doc ? await buildInvoicePdf(doc) : null;
  await sendBalanceRequestEmail({
    customerEmail: order.email,
    customerName: extra?.customer?.displayName || extra?.billingAddress?.name || "",
    orderName: order.name,
    orderDate: extra?.createdAt,
    amountDue: money(state.currency, state.outstanding),
    payUrl: order.statusPageUrl,
    pdf,
    filename: `invoice-${String(doc?.reference || order.name).replace(/[^A-Za-z0-9._-]/g, "")}.pdf`,
  });
  await run(admin, TAGS_ADD, { id: orderGid, tags: [BALANCE_REQUEST_TAG] });
  return { sent: true };
}

const PAYMENT_RULE_HANDLE = "deposit-bank-transfer-payment";
const PAYMENT_RULE_TITLE = "Bank transfer for deposit distributors";

const PAYMENT_RULE_FUNCTION = `#graphql
  query DepositPaymentFunction {
    shopifyFunctions(first: 25, apiType: "payment_customization") { nodes { id handle } }
  }`;

const PAYMENT_RULES = `#graphql
  query DepositPaymentRule {
    paymentCustomizations(first: 50) { nodes { id title enabled functionId } }
  }`;

const PAYMENT_RULE_CREATE = `#graphql
  mutation DepositPaymentRuleCreate($input: PaymentCustomizationInput!) {
    paymentCustomizationCreate(paymentCustomization: $input) {
      paymentCustomization { id enabled }
      userErrors { field message code }
    }
  }`;

const PAYMENT_RULE_UPDATE = `#graphql
  mutation DepositPaymentRuleOn($id: ID!, $input: PaymentCustomizationInput!) {
    paymentCustomizationUpdate(id: $id, paymentCustomization: $input) {
      paymentCustomization { id enabled }
      userErrors { field message code }
    }
  }`;

/**
 * Switches on the checkout rule that shows the "Bank transfer" payment method
 * only to deposit distributors (the deposit-bank-transfer-payment function).
 * Safe to run again.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function ensureBankTransferRule(admin) {
  const fn = ((await run(admin, PAYMENT_RULE_FUNCTION))?.shopifyFunctions?.nodes || []).find(
    (node) => node.handle === PAYMENT_RULE_HANDLE,
  );
  if (!fn) return { ok: false, detail: "The Bank transfer checkout rule isn't deployed with the app yet." };
  const rule = ((await run(admin, PAYMENT_RULES))?.paymentCustomizations?.nodes || []).find(
    (node) => node.functionId === fn.id,
  );
  if (rule?.enabled) return { ok: true, detail: "Bank transfer shows to deposit distributors only." };
  const result = rule
    ? (await run(admin, PAYMENT_RULE_UPDATE, { id: rule.id, input: { enabled: true } }))?.paymentCustomizationUpdate
    : (
        await run(admin, PAYMENT_RULE_CREATE, {
          input: { title: PAYMENT_RULE_TITLE, enabled: true, functionHandle: PAYMENT_RULE_HANDLE },
        })
      )?.paymentCustomizationCreate;
  const error = result?.userErrors?.[0]?.message;
  if (error) return { ok: false, detail: `Bank transfer rule: ${error}` };
  if (!result?.paymentCustomization?.enabled) return { ok: false, detail: "Bank transfer rule: Shopify didn't switch it on." };
  return { ok: true, detail: "Bank transfer shows to deposit distributors only." };
}

/*
 * Shipping on a courier order is a fulfilment in Shopify admin, which the
 * status rules above can't stop. So a deposit order's fulfilment is also held
 * in Shopify itself ("Awaiting payment"): nobody can fulfil it until it's
 * fully paid, when orders/paid releases it.
 */
const HOLD_HANDLE = "hyve-balance-before-shipment";

const FULFILLMENT_ORDERS = `#graphql
  query DepositFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 20) { nodes { id status fulfillmentHolds { id handle reason } } }
    }
  }`;

const FULFILLMENT_HOLD = `#graphql
  mutation DepositHold($id: ID!, $hold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) {
      fulfillmentHold { id }
      userErrors { field message code }
    }
  }`;

const FULFILLMENT_RELEASE = `#graphql
  mutation DepositRelease($id: ID!, $holdIds: [ID!]) {
    fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) {
      fulfillmentOrder { id status }
      userErrors { field message code }
    }
  }`;

const OPEN_STATUSES = new Set(["OPEN", "ON_HOLD", "SCHEDULED"]);

async function fulfillmentOrders(admin, orderGid) {
  return (await run(admin, FULFILLMENT_ORDERS, { id: orderGid }))?.order?.fulfillmentOrders?.nodes || [];
}

/** orders/create: a deposit order can't be fulfilled until it's fully paid. */
export async function holdUntilPaid(admin, orderGid) {
  let held = 0;
  for (const fo of await fulfillmentOrders(admin, orderGid)) {
    if (!OPEN_STATUSES.has(fo.status)) continue;
    if ((fo.fulfillmentHolds || []).some((hold) => hold.handle === HOLD_HANDLE)) continue;
    const result = (
      await run(admin, FULFILLMENT_HOLD, {
        id: fo.id,
        hold: {
          reason: "AWAITING_PAYMENT",
          reasonNotes: "Balance due before shipment (30% deposit order). Released automatically once fully paid.",
          handle: HOLD_HANDLE,
          notifyMerchant: false,
        },
      })
    )?.fulfillmentOrderHold;
    const error = result?.userErrors?.[0]?.message;
    if (error) throw new Error(error);
    held += 1;
  }
  return { held };
}

/** orders/paid: once nothing is left to pay, the order can be fulfilled. */
export async function releaseWhenPaid(admin, orderGid) {
  const order = await loadDepositOrder(admin, orderGid);
  const state = depositState(order);
  if (!state || state.balanceDue) return { released: 0 };
  let released = 0;
  for (const fo of await fulfillmentOrders(admin, orderGid)) {
    const ours = (fo.fulfillmentHolds || []).filter((hold) => hold.handle === HOLD_HANDLE).map((hold) => hold.id);
    if (!ours.length) continue;
    const result = (await run(admin, FULFILLMENT_RELEASE, { id: fo.id, holdIds: ours }))?.fulfillmentOrderReleaseHold;
    const error = result?.userErrors?.[0]?.message;
    if (error) throw new Error(error);
    released += 1;
  }
  return { released };
}
