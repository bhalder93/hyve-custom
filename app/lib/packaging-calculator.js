/**
 * Utilities for calculating carton packaging, gross weight, and volume (CBM).
 *
 * Per product (colours of one product are packed together), as the DDP price
 * tool packs an order (HYV-233):
 *   - Full cartons = floor(quantity / pieces_per_carton), each at the
 *     carton's gross_weight and carton_size.
 *   - The pieces left over go in the smallest standard box that holds them:
 *     its volume at least the carton's volume x (left over / pieces per
 *     carton) and smaller than the carton; if none is smaller, a carton.
 *     That box weighs the pieces at their Shopify weight (Shipping Weights,
 *     HYV-217); the tool has no empty-box weight.
 *   - Volume CBM (m³) = carton and box volumes (cm³) / 1,000,000.
 * Before, any part carton counted as a full carton at its full gross weight:
 * 25 pens read as 12 kg.
 */

/**
 * The tool's standard boxes (Export cartons page), in cm. The SF Express
 * checkout script uses the same list; change both if Hyve changes them.
 */
export const STANDARD_BOXES = [
  [30, 25, 20],
  [32.5, 27, 19],
  [48, 31, 16],
  [40, 40, 28],
  [48, 40, 35],
  [51, 42, 43],
];

const GRAMS_PER = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 };

/** A line's Shopify weight per piece, in kg; 0 when it has none. */
export function pieceWeightKg(item) {
  const weight = item?.variant?.inventoryItem?.measurement?.weight;
  const grams = weight ? Number(weight.value || 0) * (GRAMS_PER[weight.unit] || 0) : 0;
  return Number.isFinite(grams) && grams > 0 ? grams / 1000 : 0;
}

/** The smallest standard box (cm³) for what's left of a carton, or the carton itself. */
export function partBoxVolume(cartonVolume, leftOver, piecesPerCarton) {
  const needed = cartonVolume * Math.min(1, leftOver / piecesPerCarton);
  let box = cartonVolume;
  for (const [l, w, h] of STANDARD_BOXES) {
    const volume = l * w * h;
    if (volume >= needed && volume < cartonVolume && volume < box) box = volume;
  }
  return box;
}

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
  // Several colours of one product arrive merged (calculateOrderPackaging),
  // with their weight already added up; a single line is weighed here.
  const piecesKg = Number.isFinite(item.piecesKg) ? item.piecesKg : pieceWeightKg(item) * quantity;

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

  // Full cartons, then one box for what's left over (the tool's part box).
  const fullCartons = piecesPerCarton > 0 ? Math.floor(quantity / piecesPerCarton) : 0;
  const leftOver = piecesPerCarton > 0 ? quantity - fullCartons * piecesPerCarton : 0;
  const cartons = piecesPerCarton > 0 ? fullCartons + (leftOver > 0 ? 1 : 0) : 0;

  // The left-over pieces are weighed at their Shopify weight; without one the
  // box's weight is unknown.
  if (leftOver > 0 && !(piecesKg > 0)) {
    missingFields.push("variant weight");
  }

  // Gross weight = full cartons × carton gross weight + the left-over pieces.
  let grossWeight = 0;
  if (Number.isFinite(cartonGrossWeight) && cartonGrossWeight > 0) {
    grossWeight = fullCartons * cartonGrossWeight;
  }
  if (leftOver > 0 && quantity > 0) {
    grossWeight += (piecesKg / quantity) * leftOver;
  }
  // No carton data: the pieces still weigh what Shopify says, so the total
  // isn't short by them while the warning asks for the carton details.
  if (!(piecesPerCarton > 0)) {
    grossWeight = piecesKg;
  }

  // CBM = full cartons × L × W × H, plus the part box, ÷ 1,000,000
  let cbm = 0;
  if (cartonSize) {
    const cartonVolume = cartonSize.length * cartonSize.width * cartonSize.height;
    const partVolume = leftOver > 0 ? partBoxVolume(cartonVolume, leftOver, piecesPerCarton) : 0;
    cbm = (fullCartons * cartonVolume + partVolume) / 1000000;
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

  // Colours of one product share cartons, as in the tool: their quantities
  // and weights are added up and packed once.
  const products = new Map();
  for (const item of items) {
    if (!itemRequiresShipping(item)) {
      continue;
    }
    const key = item.product?.id || item.title || item.name || "";
    const quantity = Math.max(0, parseInt(item.quantity, 10) || 0);
    const kg = pieceWeightKg(item) * quantity;
    const known = products.get(key);
    if (known) {
      known.quantity += quantity;
      known.piecesKg += kg;
    } else {
      products.set(key, { ...item, quantity, piecesKg: kg });
    }
  }

  for (const item of products.values()) {
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
