import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCartonSize,
  calculateItemPackaging,
  calculateOrderPackaging,
} from "../app/lib/packaging-calculator.js";

test("parseCartonSize parses JSON string and object with length, width, height", () => {
  const jsonStr = JSON.stringify({
    length: 47,
    width: 40,
    height: 27,
  });
  const parsed1 = parseCartonSize(jsonStr);
  assert.deepEqual(parsed1, { length: 47, width: 40, height: 27 });

  const parsedObj = parseCartonSize({ length: 50, width: 30, height: 20 });
  assert.deepEqual(parsedObj, { length: 50, width: 30, height: 20 });

  // Tolerant to string numbers and alternate casing
  const parsedCase = parseCartonSize({ Length: "45.5", W: "35", H: "25" });
  assert.deepEqual(parsedCase, { length: 45.5, width: 35, height: 25 });

  // Missing dimension returns null
  assert.equal(parseCartonSize({ length: 40, width: 30 }), null);
  assert.equal(parseCartonSize(null), null);
  assert.equal(parseCartonSize("invalid json"), null);
});

test("calculateItemPackaging calculates cartons, gross weight, and CBM accurately", () => {
  // 50 qty with 25 pieces per carton -> 2 cartons
  const item1 = {
    quantity: 50,
    product: {
      piecesPerCarton: { value: "25" },
      grossWeight: { value: "7.5" },
      cartonSize: {
        value: JSON.stringify({
          length: 47,
          width: 40,
          height: 27,
        }),
      },
    },
  };

  const pack1 = calculateItemPackaging(item1);
  assert.equal(pack1.cartons, 2);
  assert.equal(pack1.grossWeight, 15); // 2 * 7.5
  // CBM = 2 * 47 * 40 * 27 / 1,000,000 = 0.10152
  assert.equal(pack1.cbm, 0.10152);

  // Rounding up: 26 qty with 25 pieces per carton -> 2 cartons
  const item2 = {
    quantity: 26,
    product: {
      piecesPerCarton: { value: "25" },
      grossWeight: { value: "10" },
      cartonSize: {
        value: JSON.stringify({
          length: 40,
          width: 40,
          height: 40,
        }),
      },
    },
  };
  const pack2 = calculateItemPackaging(item2);
  assert.equal(pack2.cartons, 2);
  assert.equal(pack2.grossWeight, 20); // 2 * 10
  // CBM = 2 * 40 * 40 * 40 / 1,000,000 = 0.128
  assert.equal(pack2.cbm, 0.128);
});

test("calculateItemPackaging handles missing pieces per carton gracefully", () => {
  const item = {
    quantity: 50,
    product: {},
  };
  const pack = calculateItemPackaging(item);
  assert.equal(pack.cartons, 0);
  assert.equal(pack.grossWeight, 0);
  assert.equal(pack.cbm, 0);
});

test("calculateOrderPackaging aggregates multi-item order correctly", () => {
  const lineItems = [
    {
      quantity: 50,
      product: {
        piecesPerCarton: { value: "25" },
        grossWeight: { value: "7.5" },
        cartonSize: {
          value: JSON.stringify({ length: 47, width: 40, height: 27 }),
        },
      },
    },
    {
      quantity: 100,
      product: {
        piecesPerCarton: { value: "50" },
        grossWeight: { value: "12" },
        cartonSize: {
          value: JSON.stringify({ length: 50, width: 40, height: 30 }),
        },
      },
    },
  ];

  const orderPack = calculateOrderPackaging(lineItems);
  // Item 1: 50 / 25 = 2 cartons, weight = 15, CBM = 0.10152
  // Item 2: 100 / 50 = 2 cartons, weight = 24, CBM = 2 * 50 * 40 * 30 / 1,000,000 = 0.12
  // Total: cartons = 4, grossWeight = 39, CBM = 0.22152 -> 0.222
  assert.equal(orderPack.cartons, 4);
  assert.equal(orderPack.grossWeight, 39);
  assert.equal(orderPack.cbm, 0.222);
  assert.equal(orderPack.cartonsLabel, "4");
  assert.equal(orderPack.grossWeightLabel, "39");
  assert.equal(orderPack.cbmLabel, "0.222");
});

test("collection resolution prefers staff override when present, otherwise falls back to calculated packaging", () => {
  const calculatedPackaging = {
    cartonsLabel: "4",
    grossWeightLabel: "39",
    cbmLabel: "0.222",
  };

  // Case 1: Unentered/Unsaved order (no collection metafields)
  const orderNodeWithoutOverrides = {
    collectionCartons: null,
    collectionGrossWeight: null,
    collectionCbm: null,
  };
  const collection1 = {
    numberOfCartons: orderNodeWithoutOverrides.collectionCartons?.value || calculatedPackaging.cartonsLabel || "",
    grossWeight: orderNodeWithoutOverrides.collectionGrossWeight?.value || calculatedPackaging.grossWeightLabel || "",
    cbm: orderNodeWithoutOverrides.collectionCbm?.value || calculatedPackaging.cbmLabel || "",
  };
  assert.equal(collection1.numberOfCartons, "4");
  assert.equal(collection1.grossWeight, "39");
  assert.equal(collection1.cbm, "0.222");

  // Case 2: Staff manual override exists
  const orderNodeWithOverrides = {
    collectionCartons: { value: "5" },
    collectionGrossWeight: { value: "45.0" },
    collectionCbm: { value: "0.28" },
  };
  const collection2 = {
    numberOfCartons: orderNodeWithOverrides.collectionCartons?.value || calculatedPackaging.cartonsLabel || "",
    grossWeight: orderNodeWithOverrides.collectionGrossWeight?.value || calculatedPackaging.grossWeightLabel || "",
    cbm: orderNodeWithOverrides.collectionCbm?.value || calculatedPackaging.cbmLabel || "",
  };
  assert.equal(collection2.numberOfCartons, "5");
  assert.equal(collection2.grossWeight, "45.0");
  assert.equal(collection2.cbm, "0.28");
});

test("partial cartons are rounded up to next whole number (e.g. 25 towels in 432-capacity carton)", () => {
  const item = {
    title: "Eco Beach Towel",
    quantity: 25,
    product: {
      piecesPerCarton: { value: "432" },
      grossWeight: { value: "18.5" },
      volumetricWeight: { value: "15.0" },
      cartonSize: {
        value: JSON.stringify({ length: 60, width: 40, height: 35 }),
      },
    },
  };

  const pack = calculateItemPackaging(item);
  assert.equal(pack.cartons, 1);
  assert.equal(pack.hasMissing, false);
  assert.equal(pack.warning, null);
});

test("warning message is generated when packing fields are missing or empty", () => {
  // Missing volumetric_weight
  const itemMissingVolumetric = {
    title: "Recycled Pen",
    quantity: 100,
    product: {
      piecesPerCarton: { value: "50" },
      grossWeight: { value: "5.0" },
      cartonSize: {
        value: JSON.stringify({ length: 30, width: 20, height: 15 }),
      },
    },
  };

  const pack1 = calculateItemPackaging(itemMissingVolumetric);
  assert.equal(pack1.hasMissing, true);
  assert.equal(pack1.warning, "Packing data missing for Recycled Pen");
  assert.deepEqual(pack1.missingFields, ["volumetric_weight"]);

  // Multiple missing fields
  const itemMissingMultiple = {
    title: "Coffee Mug",
    quantity: 24,
    product: {
      piecesPerCarton: { value: "24" },
    },
  };
  const pack2 = calculateItemPackaging(itemMissingMultiple);
  assert.equal(pack2.hasMissing, true);
  assert.equal(pack2.warning, "Packing data missing for Coffee Mug");
  assert.deepEqual(pack2.missingFields, ["gross_weight", "volumetric_weight", "carton_size"]);

  // Order level warnings
  const orderPack = calculateOrderPackaging([itemMissingVolumetric, itemMissingMultiple]);
  assert.equal(orderPack.hasWarnings, true);
  assert.deepEqual(orderPack.warnings, [
    "Packing data missing for Recycled Pen",
    "Packing data missing for Coffee Mug",
  ]);
});

test("products that do not require shipping are excluded from calculations and warnings", () => {
  // Non-physical/digital product with requiresShipping: false
  const digitalItem = {
    title: "Digital Artwork Design Fee",
    quantity: 1,
    requiresShipping: false,
    product: {}, // Has no packing fields
  };

  const packDigital = calculateItemPackaging(digitalItem);
  assert.equal(packDigital.cartons, 0);
  assert.equal(packDigital.grossWeight, 0);
  assert.equal(packDigital.cbm, 0);
  assert.equal(packDigital.hasMissing, false);
  assert.equal(packDigital.warning, null);

  // Variant with requiresShipping: false or inventoryItem.requiresShipping: false
  const nonShippableVariantItem = {
    title: "Warranty Service",
    quantity: 5,
    variant: { inventoryItem: { requiresShipping: false } },
    product: {},
  };
  const packVariant = calculateItemPackaging(nonShippableVariantItem);
  assert.equal(packVariant.cartons, 0);
  assert.equal(packVariant.warning, null);

  // Setup fee charge line
  const chargeLine = {
    title: "Additional Charges - Setup",
    quantity: 1,
    customAttributes: [{ key: "_hyve_setup", value: "true" }],
    product: {},
  };
  const packCharge = calculateItemPackaging(chargeLine);
  assert.equal(packCharge.cartons, 0);
  assert.equal(packCharge.warning, null);

  // Mixed order: physical product + non-shippable items
  const physicalItem = {
    title: "Branded Bottles",
    quantity: 50,
    requiresShipping: true,
    product: {
      piecesPerCarton: { value: "25" },
      grossWeight: { value: "10" },
      volumetricWeight: { value: "8" },
      cartonSize: {
        value: JSON.stringify({ length: 40, width: 40, height: 40 }),
      },
    },
  };

  const orderPack = calculateOrderPackaging([physicalItem, digitalItem, nonShippableVariantItem, chargeLine]);
  // Only physicalItem should be included
  assert.equal(orderPack.cartons, 2);
  assert.equal(orderPack.grossWeight, 20);
  assert.equal(orderPack.cbm, 0.128);
  assert.equal(orderPack.hasWarnings, false);
  assert.deepEqual(orderPack.warnings, []);
});
