export function cartDeliveryOptionsTransformRun(input) {
  const buyerIdentity = input.cart?.buyerIdentity;
  const isB2B = Boolean(buyerIdentity?.purchasingCompany);
  // A distributor checking out from a cart quote link (HYV-140). That checkout
  // is a draft order's, where Shopify doesn't let the duty line be added, so a
  // UPS (DDP) rate there would ship duties-paid with no duty charged. Those
  // rates are hidden; FOB stays. Ordering from the cart offers DDP as usual.
  const quoteLink = isB2B && input.cart?.source?.value === "Cart quote";

  const operations = [];

  for (const group of input.cart.deliveryGroups) {
    const options = group.deliveryOptions;

    // A distributor's UPS rates are delivered duty paid: the checkout adds the
    // import duty line for them. The rate name says so, as the DDP requirement
    // asks (HYV-140), since the carrier's own name doesn't. FOB, any pickup
    // option and retail checkouts are left as they are.
    const hasFob = options.some((o) => String(o.title || "").startsWith("FOB"));
    for (const option of isB2B ? options : []) {
      const title = String(option.title || "");
      if (quoteLink && hasFob && /^UPS\b/i.test(title)) {
        operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
        continue;
      }
      if (/^UPS\b/i.test(title) && !/DDP/i.test(title)) {
        operations.push({
          deliveryOptionRename: {
            deliveryOptionHandle: option.handle,
            title: `${title} · DDP, duties included`,
          },
        });
      }
    }

    // Find FOB by prefix: "FOB (freight arranged separately)"
    const fobIndex = options.findIndex((o) =>
      o.title.startsWith("FOB")
    );
    const fobOption = fobIndex >= 0 ? options[fobIndex] : null;

    // If no FOB in this group, nothing to do
    if (!fobOption) continue;

    if (!isB2B) {
      // -------------------
      // B2C: hide FOB
      // -------------------
      operations.push({
        deliveryOptionHide: {
          deliveryOptionHandle: fobOption.handle,
        },
      });
    } else {
      // -------------------
      // B2B: show all methods, but move FOB to first
      // -------------------
      if (fobIndex > 0) {
        operations.push({
          deliveryOptionMove: {
            deliveryOptionHandle: fobOption.handle,
            index: 0, // make FOB the first option
          },
        });
      }
      // Other options stay visible; no hides here
    }
  }

  return { operations };
}