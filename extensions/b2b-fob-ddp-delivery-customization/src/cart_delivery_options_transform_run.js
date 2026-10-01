export function cartDeliveryOptionsTransformRun(input) {
  const buyerIdentity = input.cart?.buyerIdentity;
  const isB2B = Boolean(buyerIdentity?.purchasingCompany);

  const operations = [];

  for (const group of input.cart.deliveryGroups) {
    const options = group.deliveryOptions;

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