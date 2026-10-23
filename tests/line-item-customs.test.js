import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCountryOfOrigin,
  itemRow,
  quoteLineChips,
} from "../app/lib/quote-document.server.js";

const cents = (set) => Math.round(Number(set?.presentmentMoney?.amount || 0) * 100);

test("formatCountryOfOrigin converts ISO-2 country codes to friendly names", () => {
  assert.equal(formatCountryOfOrigin("CN"), "China");
  assert.equal(formatCountryOfOrigin("cn"), "China");
  assert.equal(formatCountryOfOrigin("SG"), "Singapore");
  assert.equal(formatCountryOfOrigin("US"), "United States");
  assert.equal(formatCountryOfOrigin("VN"), "Vietnam");
  assert.equal(formatCountryOfOrigin("MY"), "Malaysia");
});

test("formatCountryOfOrigin preserves full names and handles falsy values", () => {
  assert.equal(formatCountryOfOrigin("China"), "China");
  assert.equal(formatCountryOfOrigin("Taiwan"), "Taiwan");
  assert.equal(formatCountryOfOrigin(""), "");
  assert.equal(formatCountryOfOrigin(null), "");
  assert.equal(formatCountryOfOrigin(undefined), "");
});

test("itemRow displays HS code and Country of Origin from variant.inventoryItem", () => {
  const lineItem = {
    title: "Eco Canvas Tote Bag",
    sku: "BAG-100",
    quantity: 50,
    variant: {
      selectedOptions: [{ name: "Color", value: "Natural" }],
      inventoryItem: {
        harmonizedSystemCode: "4202.92",
        countryCodeOfOrigin: "CN",
      },
    },
    originalUnitPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "SGD" } },
    discountedTotalSet: { presentmentMoney: { amount: "500.00", currencyCode: "SGD" } },
  };

  const row = itemRow(lineItem, cents);

  assert.equal(row.hsCode, "4202.92");
  assert.equal(row.countryOfOrigin, "China");
  assert.ok(row.details.includes("HS Code: 4202.92"));
  assert.ok(row.details.includes("Country of Origin: China"));
  assert.ok(row.details.includes("Color: Natural"));
});

test("itemRow falls back to customAttributes for HS code and Country of Origin without duplication", () => {
  const lineItem = {
    title: "Custom Ceramic Mug",
    sku: "MUG-200",
    quantity: 100,
    customAttributes: [
      { key: "HS Code", value: "6912.00" },
      { key: "Country of Origin", value: "SG" },
      { key: "Material", value: "Ceramic" },
    ],
    originalUnitPriceSet: { presentmentMoney: { amount: "5.00", currencyCode: "SGD" } },
    discountedTotalSet: { presentmentMoney: { amount: "500.00", currencyCode: "SGD" } },
  };

  const row = itemRow(lineItem, cents);

  assert.equal(row.hsCode, "6912.00");
  assert.equal(row.countryOfOrigin, "Singapore");
  assert.ok(row.details.includes("HS Code: 6912.00"));
  assert.ok(row.details.includes("Country of Origin: Singapore"));
  assert.ok(row.details.includes("Material: Ceramic"));

  // Ensure HS Code and Country of Origin are not duplicated as generic attributes
  const hsOccurrences = row.details.filter((d) => d.includes("6912.00")).length;
  const cooOccurrences = row.details.filter((d) => d.includes("Singapore")).length;
  assert.equal(hsOccurrences, 1);
  assert.equal(cooOccurrences, 1);
});

test("itemRow leaves out HS code and Country of Origin when not present", () => {
  const lineItem = {
    title: "Blank Notebook",
    sku: "NB-01",
    quantity: 20,
    originalUnitPriceSet: { presentmentMoney: { amount: "3.00", currencyCode: "SGD" } },
    discountedTotalSet: { presentmentMoney: { amount: "60.00", currencyCode: "SGD" } },
  };

  const row = itemRow(lineItem, cents);

  assert.equal(row.hsCode, "");
  assert.equal(row.countryOfOrigin, "");
  assert.equal(row.details.some((d) => d.startsWith("HS Code:")), false);
  assert.equal(row.details.some((d) => d.startsWith("Country of Origin:")), false);
});

test("quoteLineChips includes HS and Origin chips when available", () => {
  const lineItem = {
    title: "Wireless Mouse",
    variantTitle: "Black",
    variant: {
      inventoryItem: {
        harmonizedSystemCode: "8471.60",
        countryCodeOfOrigin: "CN",
      },
    },
  };

  const chips = quoteLineChips(lineItem);
  assert.ok(chips.includes("Black"));
  assert.ok(chips.includes("HS: 8471.60"));
  assert.ok(chips.includes("Origin: China"));
});
