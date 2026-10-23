/**
 * Bank transfer is for distributors on a 30% deposit (HYV-150): they pay the
 * deposit by card or by bank transfer, and upload the confirmation from their
 * account. Everyone else, retail and distributors on credit terms, doesn't see
 * it.
 *
 * @param {object} input
 * @returns {{operations: object[]}}
 */
export function cartPaymentMethodsTransformRun(input) {
  const deposit = Number(input.cart?.buyerIdentity?.purchasingCompany?.location?.deposit?.value) || 0;
  if (deposit > 0) return { operations: [] };

  const operations = (input.paymentMethods || [])
    .filter((method) => /bank transfer/i.test(String(method.name || "")))
    .map((method) => ({ paymentMethodHide: { paymentMethodId: method.id } }));
  return { operations };
}
