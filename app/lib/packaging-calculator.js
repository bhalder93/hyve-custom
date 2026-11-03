/**
 * Utilities for calculating carton packaging, gross weight, and volume (CBM).
 *
 * Formulas based on product packaging specs:
 *   - Cartons = Math.ceil(quantity / pieces_per_carton) (partial cartons counted as full cartons, rounded up)
 *   - Gross Weight (kg) = Cartons * carton_gross_weight
 *   - Volume CBM (m³) = (Cartons * Length * Width * Height) / 1,000,000
 *     (dimensions Length, Width, Height are in centimeters)
 */

/**
 * Parses carton dimensions from carton_size metafield (JSON object or string).
 * Supports keys: length/l, width/w, height/h (case-insensitive).
 *
 * @param {string|object} raw
 * @returns {{ length: number, width: number, height: number } | null}
 */
export function parseCartonSize(raw) {
  if (!raw) return null;

  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!obj || typeof obj !== "object") return null;

  const entries = Object.entries(obj);
  const findDim = (patterns) => {
    for (const [k, v] of entries) {
      const key = String(k).trim().toLowerCase();
      if (patterns.includes(key)) {
        const num = parseFloat(v);
        return Number.isFinite(num) && num > 0 ? num : null;
      }
    }
    return null;
  };

  const length = findDim(["length", "l", "len"]);
  const width = findDim(["width", "w"]);
  const height = findDim(["height", "h", "ht"]);

  if (length && width && height) {
    return { length, width, height };
  }

  return null;
}

const CHARGE_FLAGS = ["_hyve_setup", "_hyve_rush", "_hyve_gift", "_hyve_sample"];

/**
 * Checks if a line item requires physical shipping.
 * An item does NOT require shipping if:
 *  - requiresShipping is explicitly false on the line item or its variant
 *  - it is identified as a service charge or duty line
 *
 * @param {object} item
 * @returns {boolean}
 */
export function itemRequiresShipping(item) {
  if (!item) return false;

  // Direct requiresShipping boolean on line item or variant
  if (item.requiresShipping === false || item.requires_shipping === false) {
    return false;
  }
  if (item.variant?.requiresShipping === false || item.variant?.requires_shipping === false) {
    return false;
  }
  if (
    item.variant?.inventoryItem?.requiresShipping === false ||
    item.variant?.inventoryItem?.requires_shipping === false
  ) {
    return false;
  }

  // Charge / fee lines via custom attributes
  const customAttributes = Array.isArray(item.customAttributes) ? item.customAttributes : [];
  const flaggedAsCharge = customAttributes.some(
    (attr) => CHARGE_FLAGS.includes(attr?.key) && String(attr?.value) === "true",
  );
  if (flaggedAsCharge) {
    return false;
  }

  // Charge / fee lines via title pattern
  const title = String(item.title || item.name || "").trim();
  if (/^additional charges/i.test(title) || /^import duties/i.test(title)) {
    return false;
  }

  return true;
}

/**
 * Computes packaging metrics and missing data checks for a single line item.
 *
 * @param {object} item Shopify line item node
 * @returns {{
 *   cartons: number,
 *   grossWeight: number,
 *   cbm: number,
 *   productTitle: string,
 *   missingFields: string[],
 *   hasMissing: boolean,
 *   warning: string | null,
 *   detailedWarning: string | null,
 * }}
 */
export function calculateItemPackaging(item) {
  if (!item) {
    return {
      cartons: 0,
      grossWeight: 0,
      cbm: 0,
      productTitle: "",
      missingFields: [],
      hasMissing: false,
      warning: null,
      detailedWarning: null,
    };
  }

  const product = item.product || {};
  const productTitle = String(item.title || product.title || "Product").trim();

  // Exclude products that do not require physical shipping from calculation and warnings
  if (!itemRequiresShipping(item)) {
    return {
      cartons: 0,
      grossWeight: 0,
      cbm: 0,
      productTitle,
      missingFields: [],
      hasMissing: false,
      warning: null,
      detailedWarning: null,
      requiresShipping: false,
    };
  }

  const quantity = Math.max(0, parseInt(item.quantity, 10) || 0);

  if (!quantity) {
    return {
      cartons: 0,
      grossWeight: 0,
      cbm: 0,
      productTitle,
      missingFields: [],
      hasMissing: false,
      warning: null,
      detailedWarning: null,
    };
  }

  const missingFields = [];

  // 1. Pieces per carton
  const rawPieces =
    product.piecesPerCarton?.value ??
    product.pieces_per_carton ??
    product.customPiecesPerCarton?.value ??
    item.piecesPerCarton;
  const piecesPerCarton = parseFloat(rawPieces);
  if (!Number.isFinite(piecesPerCarton) || piecesPerCarton <= 0) {
    missingFields.push("pieces_per_carton");
  }

  // 2. Gross weight per carton
  const rawGrossWeight =
    product.grossWeight?.value ??
    product.gross_weight ??
    product.customGrossWeight?.value ??
    item.grossWeight;
  const cartonGrossWeight = parseFloat(rawGrossWeight);
  if (!Number.isFinite(cartonGrossWeight) || cartonGrossWeight <= 0) {
    missingFields.push("gross_weight");
  }

  // 3. Volumetric weight
  const rawVolumetricWeight =
    product.volumetricWeight?.value ??
    product.productVolumetricWeight?.value ??
    product.volumetric_weight ??
    product.customVolumetricWeight?.value ??
    item.volumetricWeight;
  const volumetricWeight = parseFloat(rawVolumetricWeight);
  if (!Number.isFinite(volumetricWeight) || volumetricWeight <= 0) {
    missingFields.push("volumetric_weight");
  }

  // 4. Carton dimensions (carton_size)
  const rawCartonSize =
    product.cartonSize?.value ??
    product.carton_size ??
    product.customCartonSize?.value ??
    item.cartonSize;
  const cartonSize = parseCartonSize(rawCartonSize);
  if (!cartonSize) {
    missingFields.push("carton_size");
  }

  // Cartons = quantity ÷ pieces per carton, rounded up (partial cartons must be counted as full cartons)
  let cartons = 0;
  if (piecesPerCarton > 0 && quantity > 0) {
    cartons = Math.max(1, Math.ceil(quantity / piecesPerCarton));
  }

  // Gross weight = cartons * carton_gross_weight
  let grossWeight = 0;
  if (Number.isFinite(cartonGrossWeight) && cartonGrossWeight > 0) {
    grossWeight = cartons * cartonGrossWeight;
  }

  // CBM = cartons × L × W × H ÷ 1,000,000
  let cbm = 0;
  if (cartonSize) {
    cbm = (cartons * cartonSize.length * cartonSize.width * cartonSize.height) / 1000000;
  } else if (Number.isFinite(volumetricWeight) && volumetricWeight > 0) {
    // If carton dimensions are missing but volumetric weight is given (1 CBM = 167 kg standard)
    cbm = (cartons * volumetricWeight) / 167;
  }

  const hasMissing = missingFields.length > 0;
  const warning = hasMissing ? `Packing data missing for ${productTitle}` : null;
  const detailedWarning = hasMissing
    ? `Packing data missing for ${productTitle} (${missingFields.join(", ")})`
    : null;

  return {
    cartons,
    grossWeight,
    cbm,
    productTitle,
    missingFields,
    hasMissing,
    warning,
    detailedWarning,
  };
}

/**
 * Calculates total packaging metrics across all line items of an order,
 * and collects missing data warnings per product.
 *
 * @param {Array<object>} lineItems Array of line items
 * @returns {{
 *   cartons: number | null,
 *   grossWeight: number | null,
 *   cbm: number | null,
 *   cartonsLabel: string,
 *   grossWeightLabel: string,
 *   cbmLabel: string,
 *   warnings: string[],
 *   detailedWarnings: string[],
 *   hasWarnings: boolean,
 * }}
 */
export function calculateOrderPackaging(lineItems = []) {
  const items = Array.isArray(lineItems) ? lineItems : [];

  let totalCartons = 0;
  let totalGrossWeight = 0;
  let totalCbm = 0;
  const warnings = [];
  const detailedWarnings = [];

  for (const item of items) {
    if (!itemRequiresShipping(item)) {
      continue;
    }
    const res = calculateItemPackaging(item);
    totalCartons += res.cartons;
    totalGrossWeight += res.grossWeight;
    totalCbm += res.cbm;
    if (res.warning) {
      warnings.push(res.warning);
    }
    if (res.detailedWarning) {
      detailedWarnings.push(res.detailedWarning);
    }
  }

  // Clean rounding
  const roundedWeight = totalGrossWeight > 0 ? parseFloat(totalGrossWeight.toFixed(2)) : null;
  const roundedCbm = totalCbm > 0 ? parseFloat(totalCbm.toFixed(3)) : null;

  const uniqueWarnings = [...new Set(warnings)];
  const uniqueDetailedWarnings = [...new Set(detailedWarnings)];

  return {
    cartons: totalCartons > 0 ? totalCartons : null,
    grossWeight: roundedWeight,
    cbm: roundedCbm,
    cartonsLabel: totalCartons > 0 ? String(totalCartons) : "",
    grossWeightLabel: roundedWeight !== null ? String(roundedWeight) : "",
    cbmLabel: roundedCbm !== null ? String(roundedCbm) : "",
    warnings: uniqueWarnings,
    detailedWarnings: uniqueDetailedWarnings,
    hasWarnings: uniqueWarnings.length > 0,
  };
}
