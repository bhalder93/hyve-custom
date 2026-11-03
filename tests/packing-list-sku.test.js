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
