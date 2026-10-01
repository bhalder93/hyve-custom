/**
 * Dummy customer-eligibility rules.
 *
 * Stands in for whatever really decides whether a customer may place an order
 * (credit check, ERP lookup, distributor approval). Pure and synchronous so the
 * API route, the metafield sync and the tests all share one source of truth —
 * swap the body of `checkEligibility` for a real call when you have one.
 */

/** App-owned metafield the checkout validation function reads. */
export const ELIGIBILITY_METAFIELD = {
  namespace: "$app:eligibility",
  key: "status",
  type: "json",
};

/** Dummy rule data — the knobs you'd change to demo a blocked checkout. */
const BLOCKED_DOMAINS = ["blocked.test", "example-denied.com"];
const CREDIT_HOLD_TAG = "credit-hold";
const UNVERIFIED_TAG = "unverified";

/**
 * Decide whether a customer may check out. First matching rule wins.
 *
 * @param {object} customer
 * @param {string} [customer.email]
 * @param {string[]} [customer.tags]
 * @returns {{eligible:boolean, code:string, reason:string, checkedAt:string}}
 */
export function checkEligibility({ email = "", tags = [] } = {}) {
  const normalizedTags = tags.map((t) => String(t).trim().toLowerCase());
  const domain = String(email).split("@")[1]?.toLowerCase() || "";

  if (normalizedTags.includes(CREDIT_HOLD_TAG)) {
    return verdict(false, "CREDIT_HOLD", "Your account is on credit hold. Please contact your account manager to place new orders.");
  }

  if (domain && BLOCKED_DOMAINS.includes(domain)) {
    return verdict(false, "DOMAIN_BLOCKED", "Orders from this email domain are not accepted. Please use your company email address.");
  }

  if (normalizedTags.includes(UNVERIFIED_TAG)) {
    return verdict(false, "PENDING_VERIFICATION", "Your account is still being verified. You'll be able to order once verification completes.");
  }

  if (!email) {
    return verdict(true, "GUEST_ALLOWED", "Guest checkout is permitted.");
  }

  return verdict(true, "ELIGIBLE", "Customer is approved to place orders.");
}

function verdict(eligible, code, reason) {
  return { eligible, code, reason, checkedAt: new Date().toISOString() };
}
