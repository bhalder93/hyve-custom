/**
 * Helpers for line item pricing, imprint fees, and product resolution.
 */

export function isSameVariant(a, b) {
  if (!a || !b) return false;
  const numA = String(a).replace(/['"]/g, "").replace("gid://shopify/ProductVariant/", "").trim();
  const numB = String(b).replace(/['"]/g, "").replace("gid://shopify/ProductVariant/", "").trim();
  return numA === numB;
}

export function getProductFromLine(line) {
  return line?.product || line?.variant?.product || null;
}

export function parseFullColourWrapCost(raw) {
  if (!raw) return 0;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Number(parsed.amount || parsed.price || parsed.cost || 0) || 0;
      } catch (_) {}
    }
    const val = parseFloat(trimmed);
    return isNaN(val) ? 0 : val;
  }
  return 0;
}

export function parseImprintFeeData(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof parsed === "object" && parsed !== null && "value" in parsed) {
    parsed = parsed.value;
  }
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (_) {
      return [];
    }
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.pricing) || parsed.method_name) {
      parsed = [parsed];
    } else if (Array.isArray(parsed.data)) {
      parsed = parsed.data;
    } else {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

export function calculateImprintFee(imprintFeeRaw, method, locationCount, quantity) {
  const data = parseImprintFeeData(imprintFeeRaw);
  if (!data.length) return 0;
  const qty = Number(quantity) || 1;
  if (qty <= 0) return 0;

  let locCount = Number(locationCount) || 0;
  if (locCount <= 0) locCount = 1;

  const normalizedMethod = String(method || "").trim().toLowerCase();

  let methodEntries = [];
  if (normalizedMethod) {
    methodEntries = data.filter(
      (entry) => String(entry.method_name || "").trim().toLowerCase() === normalizedMethod,
    );
    if (!methodEntries.length) {
      methodEntries = data.filter((entry) => {
        const entryMethod = String(entry.method_name || "").trim().toLowerCase();
        return (
          entryMethod &&
          (normalizedMethod.includes(entryMethod) || entryMethod.includes(normalizedMethod))
        );
      });
    }
  }

  if (!methodEntries.length) {
    methodEntries = data;
  }
  if (!methodEntries.length) return 0;

  let matchedEntry = methodEntries.find((entry) => Number(entry.location) === locCount);
  if (!matchedEntry) {
    const sortedByLoc = [...methodEntries].sort((a, b) => Number(b.location) - Number(a.location));
    matchedEntry = sortedByLoc.find((e) => Number(e.location) <= locCount) || sortedByLoc[sortedByLoc.length - 1];
  }

  if (!matchedEntry || !Array.isArray(matchedEntry.pricing) || !matchedEntry.pricing.length) {
    return 0;
  }

  const sortedPricing = [...matchedEntry.pricing]
    .map((p) => ({
      ...p,
      min_qty: Number(p.min_qty ?? p.min_quantity ?? p.minQty ?? p.quantity ?? p.qty ?? 0) || 0,
      price: Number(p.price ?? p.cost ?? p.rate ?? p.amount ?? 0) || 0,
    }))
    .sort((a, b) => b.min_qty - a.min_qty);

  const tier = sortedPricing.find((p) => qty >= p.min_qty);
  if (tier) return tier.price;
  return sortedPricing[sortedPricing.length - 1].price;
}

export function getLineItemDetails(line, sampleVariantId, rushVariantId) {
  const attrs = line?.customAttributes || [];
  const isSample = isSameVariant(line?.variant?.id, sampleVariantId);
  const isRush = isSameVariant(line?.variant?.id, rushVariantId);
  const product = getProductFromLine(line);

  const baseAttr = attrs.find((a) => a.key === "_base_unit_price")?.value;
  const currentUnit = Number(line?.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
  const variantPrice = Number(line?.variant?.price ?? 0);
  const basePrice = baseAttr ? Number(baseAttr) : (variantPrice || currentUnit || 0);

  const rawWrapMeta = product?.fullColourWrap?.value || product?.fullColorWrap?.value;
  const wrapCost = parseFullColourWrapCost(rawWrapMeta);
  const hasWrapOption = wrapCost > 0;

  const wrapAttr = attrs.find((a) => a.key === "Full Colour Wrap" || a.key === "_full_colour_wrap");
  const isWrapChecked = wrapAttr ? /yes|true/i.test(String(wrapAttr.value)) : false;

  const rushAttr = attrs.find((a) => /rush/i.test(String(a.key)) && !a.key.startsWith("_"));
  const rushHiddenAttr = attrs.find((a) => a.key === "_rush_production");
  const isRushChecked =
    (rushAttr && /yes|true/i.test(String(rushAttr.value))) ||
    (rushHiddenAttr && /true/i.test(String(rushHiddenAttr.value)));

  let method = "";
  let locations = [];
  let parsedImprintLocCount = 0;

  const imprintAttr = attrs.find((a) => a.key === "_imprint")?.value;
  if (imprintAttr) {
    try {
      const parsed = JSON.parse(imprintAttr);
      if (parsed.method) method = parsed.method;
      if (parsed.locations) {
        parsedImprintLocCount = Number(parsed.locations) || 0;
      }
    } catch (_) {}
  }

  const imprintLocAttr = attrs.find((a) => a.key === "Imprint Locations" || a.key === "Imprint Location")?.value || "";
  if (imprintLocAttr) {
    const colonIdx = imprintLocAttr.indexOf(":");
    if (colonIdx !== -1) {
      if (!method) method = imprintLocAttr.slice(0, colonIdx).trim();
      locations = imprintLocAttr.slice(colonIdx + 1).split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      const parts = imprintLocAttr.split(",").map((s) => s.trim()).filter(Boolean);
      locations = parts;
    }
  }

  if (!method) {
    const methodAttr = attrs.find((a) => /^(decoration(\s*method)?|method|print\s*method)$/i.test(String(a.key || "")))?.value;
    if (methodAttr) method = String(methodAttr).trim();
  }

  if (!method && product?.decorationMethod?.value) {
    const rawMethods = String(product.decorationMethod.value).split(",").map((s) => s.trim()).filter(Boolean);
    if (rawMethods.length > 0) {
      method = rawMethods[0];
    }
  }

  const effectiveLocCount = locations.length > 0 ? locations.length : (parsedImprintLocCount || (method ? 1 : 0));

  const imprintFee = calculateImprintFee(
    product?.imprintFee?.value,
    method,
    effectiveLocCount,
    line?.quantity || 1,
  );

  const rushFeeTotal = isRushChecked ? 200 : 0;
  const rushFeePerUnit = (line?.quantity || 1) > 0 ? rushFeeTotal / (line?.quantity || 1) : 0;
  const wrapFeePerUnit = isWrapChecked ? wrapCost : 0;

  return {
    isSample,
    isRush,
    basePrice,
    wrapCost,
    hasWrapOption,
    isWrapChecked,
    isRushChecked,
    method,
    locations,
    effectiveLocCount,
    imprintFee,
    rushFeeTotal,
    rushFeePerUnit,
    wrapFeePerUnit,
  };
}

export function syncRushVariantLineItem(lineItems, rushVariantId) {
  if (!rushVariantId || !Array.isArray(lineItems)) return lineItems || [];
  const rushNumericId = String(rushVariantId)
    .replace(/['"]/g, "")
    .replace("gid://shopify/ProductVariant/", "")
    .trim();

  // Count how many non-rush product lines have Rush Production checked
  let rushCount = 0;
  for (const line of lineItems) {
    const variantId = line.variantId || line.variant?.id;
    if (isSameVariant(variantId, rushNumericId)) continue;
    const attrs = line.customAttributes || [];
    const isRush = attrs.some(
      (a) =>
        (a.key === "Rush Production" && /yes|true/i.test(String(a.value))) ||
        (a.key === "_rush_production" && /true/i.test(String(a.value))),
    );
    if (isRush) {
      rushCount += 1;
    }
  }

  // Filter out any existing rush line items
  const result = lineItems.filter((l) => {
    const variantId = l.variantId || l.variant?.id;
    return !isSameVariant(variantId, rushNumericId);
  });

  // If rushCount > 0, append the rush variant with quantity = rushCount
  if (rushCount > 0) {
    result.push({
      variantId: `gid://shopify/ProductVariant/${rushNumericId}`,
      quantity: rushCount,
    });
  }

  return result;
}

export function buildDraftOrderLineItemInput(line, options = {}) {
  const { quantity, unitPrice, customAttributes } = options;
  const finalQty =
    quantity != null
      ? Math.max(1, parseInt(quantity, 10) || 1)
      : Math.max(1, parseInt(line?.quantity, 10) || 1);

  const currencyCode =
    line?.originalUnitPriceSet?.presentmentMoney?.currencyCode || "USD";

  const item = {
    quantity: finalQty,
    customAttributes:
      customAttributes ||
      (line?.customAttributes || []).map(({ key, value }) => ({ key, value })),
  };

  const finalPrice =
    unitPrice != null
      ? Number(unitPrice).toFixed(2)
      : line?.originalUnitPriceSet?.presentmentMoney?.amount != null
        ? Number(line.originalUnitPriceSet.presentmentMoney.amount).toFixed(2)
        : null;

  if (line?.variant?.id) {
    item.variantId = line.variant.id;
    if (finalPrice != null) {
      item.priceOverride = {
        amount: finalPrice,
        currencyCode,
      };
    }
  } else {
    item.title = line?.title || line?.name || "Custom Item";
    if (finalPrice != null) {
      item.originalUnitPriceWithCurrency = {
        amount: finalPrice,
        currencyCode,
      };
    }
  }

  return item;
}
