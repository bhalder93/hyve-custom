import test from "node:test";
import assert from "node:assert/strict";
import { itemRow, skuOnly } from "../app/lib/quote-document.server.js";

const cents = (set) => Math.round(Number(set?.presentmentMoney?.amount || 0) * 100);

test("itemRow includes sku and code with decoration method", () => {
  const lineItem = {
    title: "Eco Bottle",
    sku: "29223BLK",
    quantity: 100,
    customAttributes: [
      { key: "Imprint Locations", value: "Digital: Front" },
    ],
    originalUnitPriceSet: { presentmentMoney: { amount: "15.00", currencyCode: "SGD" } },
    discountedTotalSet: { presentmentMoney: { amount: "1500.00", currencyCode: "SGD" } },
  };

  const row = itemRow(lineItem, cents);
  assert.equal(row.sku, "29223BLK");
  assert.equal(row.code, "29223BLK-Digital");
});

test("skuOnly returns plain sku when row has sku property", () => {
  const row = {
    code: "29223BLK-Digital",
    sku: "29223BLK",
    details: ["Imprint Method: Digital"],
  };

  assert.equal(skuOnly(row), "29223BLK");
});

test("skuOnly strips decoration method suffix if row.sku is missing", () => {
  const row = {
    code: "29223BLK-Digital",
    details: ["Color: Black", "Imprint Method: Digital", "Imprint Location: Front"],
  };

  assert.equal(skuOnly(row), "29223BLK");
});

test("skuOnly leaves plain sku alone if no decoration method is present", () => {
  const row = {
    code: "29223BLK",
    sku: "29223BLK",
    details: ["Color: Black"],
  };

  assert.equal(skuOnly(row), "29223BLK");
});

test("skuOnly strips decoration suffix via fallback pattern when details are absent", () => {
  const row = {
    code: "29223BLK-Digital",
  };

  assert.equal(skuOnly(row), "29223BLK");

  const laserRow = {
    code: "11989BLK-Laser",
  };
  assert.equal(skuOnly(laserRow), "11989BLK");
});

test("itemRow with { artwork: false, brief: false } removes Artwork and Design Brief from details for invoice and packing list", () => {
  const lineItem = {
    title: "Executive Pen",
    sku: "PEN-01",
    quantity: 100,
    variant: {
      selectedOptions: [{ name: "Color", value: "Matte Black" }],
    },
    customAttributes: [
      { key: "Imprint Locations", value: "Laser: BARREL" },
      { key: "Artwork", value: "Design it for me" },
      { key: "Design Brief", value: "Please engrave Acme Corp logo with tag line" },
      { key: "Artwork Design Brief", value: "Keep it centered" },
      { key: "Packaging Note", value: "Gift box" },
    ],
    originalUnitPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
    discountedTotalSet: { presentmentMoney: { amount: "1000.00", currencyCode: "USD" } },
  };

  const invoiceRow = itemRow(lineItem, cents, { artwork: false, brief: false });

  assert.ok(invoiceRow.details.includes("Color: Matte Black"));
  assert.ok(invoiceRow.details.includes("Imprint Method: Laser"));
  assert.ok(invoiceRow.details.includes("Imprint Location: BARREL"));
  assert.ok(invoiceRow.details.includes("Packaging Note: Gift box"));

  // Artwork and Design Brief must NOT be in details
  assert.equal(invoiceRow.details.some((d) => /design\s*brief/i.test(d)), false);
  assert.equal(invoiceRow.details.some((d) => /^Artwork\b/i.test(d)), false);
});
