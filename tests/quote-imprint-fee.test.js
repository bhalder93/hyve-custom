import test from "node:test";
import assert from "node:assert/strict";
import {
  getProductFromLine,
  parseImprintFeeData,
  calculateImprintFee,
  parseFullColourWrapCost,
  getLineItemDetails,
  syncRushVariantLineItem,
  buildDraftOrderLineItemInput,
} from "../app/lib/imprint-pricing.js";

const sampleImprintFeeData = [
  {
    method_name: "Digital",
    location: 1,
    pricing: [
      { min_qty: 25, price: 0.72, currency: "USD" },
      { min_qty: 50, price: 0.65, currency: "USD" },
      { min_qty: 100, price: 0.62, currency: "USD" },
      { min_qty: 200, price: 0.54, currency: "USD" },
      { min_qty: 300, price: 0.51, currency: "USD" },
      { min_qty: 500, price: 0.47, currency: "USD" },
    ],
  },
  {
    method_name: "Digital",
    location: 2,
    pricing: [
      { min_qty: 25, price: 1.25, currency: "USD" },
      { min_qty: 50, price: 1.15, currency: "USD" },
      { min_qty: 100, price: 1.05, currency: "USD" },
    ],
  },
  {
    method_name: "Laser Engraved",
    location: 1,
    pricing: [
      { min_qty: 25, price: 1.00, currency: "USD" },
      { min_qty: 50, price: 0.90, currency: "USD" },
    ],
  },
];

test("parseImprintFeeData parses string JSON, objects, and arrays", () => {
  assert.equal(parseImprintFeeData(null).length, 0);
  assert.equal(parseImprintFeeData("").length, 0);
  assert.equal(parseImprintFeeData("invalid json").length, 0);

  const parsedFromStr = parseImprintFeeData(JSON.stringify(sampleImprintFeeData));
  assert.equal(parsedFromStr.length, 3);
  assert.equal(parsedFromStr[0].method_name, "Digital");

  const parsedFromMetafieldObj = parseImprintFeeData({ value: JSON.stringify(sampleImprintFeeData) });
  assert.equal(parsedFromMetafieldObj.length, 3);

  const parsedFromArr = parseImprintFeeData(sampleImprintFeeData);
  assert.equal(parsedFromArr.length, 3);
});

test("calculateImprintFee calculates tiered pricing accurately", () => {
  const raw = JSON.stringify(sampleImprintFeeData);

  // Exact match Digital, 1 location
  assert.equal(calculateImprintFee(raw, "Digital", 1, 10), 0.72); // Below min_qty 25 -> lowest tier price
  assert.equal(calculateImprintFee(raw, "Digital", 1, 25), 0.72);
  assert.equal(calculateImprintFee(raw, "Digital", 1, 40), 0.72);
  assert.equal(calculateImprintFee(raw, "Digital", 1, 50), 0.65);
  assert.equal(calculateImprintFee(raw, "Digital", 1, 150), 0.62);
  assert.equal(calculateImprintFee(raw, "Digital", 1, 250), 0.54);
  assert.equal(calculateImprintFee(raw, "Digital", 1, 350), 0.51);
  assert.equal(calculateImprintFee(raw, "Digital", 1, 600), 0.47);

  // Location 2
  assert.equal(calculateImprintFee(raw, "Digital", 2, 25), 1.25);
  assert.equal(calculateImprintFee(raw, "Digital", 2, 75), 1.15);
  assert.equal(calculateImprintFee(raw, "Digital", 2, 120), 1.05);

  // Fuzzy method name match: "Digital Print" matches "Digital"
  assert.equal(calculateImprintFee(raw, "Digital Print", 1, 50), 0.65);
  assert.equal(calculateImprintFee(raw, "Full Colour Digital", 1, 50), 0.65);
});

test("calculateImprintFee handles defaults when location or method is omitted", () => {
  const raw = JSON.stringify(sampleImprintFeeData);

  // Location count 0 defaults to 1
  assert.equal(calculateImprintFee(raw, "Digital", 0, 50), 0.65);

  // Empty method defaults to available data
  assert.equal(calculateImprintFee(raw, "", 1, 50), 0.65);
});

test("getProductFromLine resolves product from line or variant fallback", () => {
  const productA = { id: "gid://shopify/Product/1", title: "Item A" };
  const productB = { id: "gid://shopify/Product/2", title: "Item B" };

  // Direct line.product
  assert.deepEqual(getProductFromLine({ product: productA, variant: { id: "v1" } }), productA);

  // Fallback to line.variant.product when line.product is null
  assert.deepEqual(getProductFromLine({ product: null, variant: { id: "v1", product: productB } }), productB);
  assert.deepEqual(getProductFromLine({ variant: { id: "v1", product: productB } }), productB);

  // Null when both missing
  assert.equal(getProductFromLine({ variant: { id: "v1" } }), null);
});

test("getLineItemDetails accurately parses imprint fee and options with variant product fallback", () => {
  const line = {
    quantity: 50,
    originalUnitPriceSet: { presentmentMoney: { amount: "15.00", currencyCode: "USD" } },
    customAttributes: [
      { key: "Imprint Locations", value: "Digital: Front" },
      { key: "Full Colour Wrap", value: "Yes" },
      { key: "Rush Production", value: "Yes" },
    ],
    variant: {
      id: "gid://shopify/ProductVariant/100",
      price: "15.00",
      product: {
        id: "gid://shopify/Product/100",
        fullColourWrap: { value: "1.50" },
        imprintFee: { value: JSON.stringify(sampleImprintFeeData) },
      },
    },
  };

  const details = getLineItemDetails(line, "gid://shopify/ProductVariant/999", "gid://shopify/ProductVariant/100");
  assert.equal(details.isSample, false);
  assert.equal(details.isRush, true);
  assert.equal(details.basePrice, 15);
  assert.equal(details.isWrapChecked, true);
  assert.equal(details.wrapCost, 1.50);
  assert.equal(details.isRushChecked, true);
  assert.equal(details.rushFeeTotal, 200);
  assert.equal(details.rushFeePerUnit, 4); // 200 / 50 = 4.00
  assert.equal(details.method, "Digital");
  assert.deepEqual(details.locations, ["Front"]);
  assert.equal(details.effectiveLocCount, 1);
  assert.equal(details.imprintFee, 0.65); // 50 qty -> 0.65
});

test("syncRushVariantLineItem sets rush variant quantity equal to count of checked product items", () => {
  const rushVariantId = "gid://shopify/ProductVariant/68373883257083";

  // Case 1: 2 items checked -> rush variant added with quantity = 2
  const lines1 = [
    {
      variantId: "gid://shopify/ProductVariant/1",
      quantity: 50,
      customAttributes: [{ key: "Rush Production", value: "Yes" }],
    },
    {
      variantId: "gid://shopify/ProductVariant/2",
      quantity: 100,
      customAttributes: [{ key: "_rush_production", value: "true" }],
    },
    {
      variantId: "gid://shopify/ProductVariant/3",
      quantity: 25,
      customAttributes: [],
    },
  ];
  const synced1 = syncRushVariantLineItem(lines1, rushVariantId);
  assert.equal(synced1.length, 4);
  const rushItem1 = synced1.find((l) => l.variantId === rushVariantId);
  assert.ok(rushItem1);
  assert.equal(rushItem1.quantity, 2);

  // Case 2: 1 item checked and old rush item present -> rush variant quantity updated to 1
  const lines2 = [
    {
      variantId: "gid://shopify/ProductVariant/1",
      quantity: 50,
      customAttributes: [{ key: "Rush Production", value: "Yes" }],
    },
    {
      variantId: "gid://shopify/ProductVariant/2",
      quantity: 100,
      customAttributes: [],
    },
    {
      variantId: rushVariantId,
      quantity: 5,
    },
  ];
  const synced2 = syncRushVariantLineItem(lines2, rushVariantId);
  assert.equal(synced2.length, 3);
  const rushItem2 = synced2.find((l) => l.variantId === rushVariantId);
  assert.ok(rushItem2);
  assert.equal(rushItem2.quantity, 1);

  // Case 3: 0 items checked -> rush variant removed
  const lines3 = [
    {
      variantId: "gid://shopify/ProductVariant/1",
      quantity: 50,
      customAttributes: [],
    },
    {
      variantId: rushVariantId,
      quantity: 1,
    },
  ];
  const synced3 = syncRushVariantLineItem(lines3, rushVariantId);
  assert.equal(synced3.length, 1);
  assert.equal(synced3.some((l) => l.variantId === rushVariantId), false);
});

test("buildDraftOrderLineItemInput correctly builds DraftOrderLineItemInput with priceOverride", () => {
  const lineWithVariant = {
    quantity: 10,
    variant: { id: "gid://shopify/ProductVariant/987654321" },
    originalUnitPriceSet: { presentmentMoney: { amount: "20.00", currencyCode: "USD" } },
    customAttributes: [{ key: "Color", value: "Blue" }],
  };

  // With price override
  const result1 = buildDraftOrderLineItemInput(lineWithVariant, {
    quantity: 25,
    unitPrice: 25.5,
    customAttributes: [{ key: "Color", value: "Red" }],
  });
  assert.equal(result1.variantId, "gid://shopify/ProductVariant/987654321");
  assert.equal(result1.quantity, 25);
  assert.deepEqual(result1.priceOverride, { amount: "25.50", currencyCode: "USD" });
  assert.deepEqual(result1.customAttributes, [{ key: "Color", value: "Red" }]);

  // Custom line item without variantId
  const customLine = {
    title: "Special Custom Engraving",
    quantity: 2,
    originalUnitPriceSet: { presentmentMoney: { amount: "15.00", currencyCode: "USD" } },
  };
  const result2 = buildDraftOrderLineItemInput(customLine, { unitPrice: 18.0 });
  assert.equal(result2.title, "Special Custom Engraving");
  assert.equal(result2.quantity, 2);
  assert.deepEqual(result2.originalUnitPriceWithCurrency, { amount: "18.00", currencyCode: "USD" });
});
