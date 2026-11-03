export function cartDeliveryOptionsTransformRun(input) {
  const buyerIdentity = input.cart?.buyerIdentity;
  const isB2B = Boolean(buyerIdentity?.purchasingCompany);

  const operations = [];

  for (const group of input.cart.deliveryGroups) {
    const options = group.deliveryOptions;

    // A distributor's UPS rates are delivered duties unpaid: the distributor
    // is the importer of record and pays the duties on import, so checkout
    // adds no duty line (HYV-75, Oct 16). The rate name says so, since the
    // carrier's own name doesn't. FOB, any pickup option and retail checkouts
    // are left as they are.
    for (const option of isB2B ? options : []) {
      const title = String(option.title || "");
      if (/^UPS\b/i.test(title) && !/DDU/i.test(title)) {
        operations.push({
          deliveryOptionRename: {
            deliveryOptionHandle: option.handle,
            title: `${title} · DDU, duties paid by you on import`,
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