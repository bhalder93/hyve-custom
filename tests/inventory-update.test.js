import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  parseInventoryCsv,
  normalizeOnHandQuantity,
  getStoreLocations,
  findVariantsBySkus,
  planInventoryUpdate,
  applyInventoryUpdate,
} from "../app/lib/inventory-update.server.js";

test("parseCsv correctly handles RFC 4180 quotes, commas, and BOM", () => {
  const csv = '\uFEFF"SKU","On Hand"\n"PEN-01",50\n"MUG-02","120"\n"BAG-03, WITH COMMA",15\n"NOTE-04","10"" Special"';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], ["SKU", "On Hand"]);
  assert.deepEqual(rows[1], ["PEN-01", "50"]);
  assert.deepEqual(rows[2], ["MUG-02", "120"]);
  assert.deepEqual(rows[3], ["BAG-03, WITH COMMA", "15"]);
  assert.deepEqual(rows[4], ["NOTE-04", '10" Special']);
});

test("parseInventoryCsv validates header presence and reports missing columns", () => {
  const emptyCsv = "";
  const resEmpty = parseInventoryCsv(emptyCsv);
  assert.equal(resEmpty.ok, false);
  assert.ok(resEmpty.error.includes("empty"));

  const invalidHeader = "Product Name,Color,Price\nPen,Blue,2.50";
  const resMissing = parseInventoryCsv(invalidHeader);
  assert.equal(resMissing.ok, false);
  assert.ok(resMissing.error.includes("SKU"));
  assert.ok(resMissing.error.includes("On Hand"));
});

test("normalizeOnHandQuantity correctly handles numbers with commas, spaces, currency, and floats", () => {
  assert.deepEqual(normalizeOnHandQuantity("3,982"), { valid: true, value: 3982 });
  assert.deepEqual(normalizeOnHandQuantity('"3,982"'), { valid: false }); // quotes are handled by parseCsv
  assert.deepEqual(normalizeOnHandQuantity("1,234,567"), { valid: true, value: 1234567 });
  assert.deepEqual(normalizeOnHandQuantity("3 982"), { valid: true, value: 3982 });
  assert.deepEqual(normalizeOnHandQuantity("3,982.00"), { valid: true, value: 3982 });
  assert.deepEqual(normalizeOnHandQuantity("$500"), { valid: true, value: 500 });
  assert.deepEqual(normalizeOnHandQuantity("(50)"), { valid: true, value: -50 });
  assert.deepEqual(normalizeOnHandQuantity("-25"), { valid: true, value: -25 });
  assert.deepEqual(normalizeOnHandQuantity("0"), { valid: true, value: 0 });

  assert.equal(normalizeOnHandQuantity("3,982.5").valid, false);
  assert.equal(normalizeOnHandQuantity("abc").valid, false);
  assert.equal(normalizeOnHandQuantity("").valid, false);
});

test("parseInventoryCsv parses valid rows and flags invalid numbers", () => {
  const csv = `SKU,On Hand
29223BLK,"3,982"
11989MAT,50
COMMA_FORMAT,"1,234"
UNQUOTED_COMMA,2,500
INVALID_QTY,abc
,75
EMPTY_LINE,`;

  const res = parseInventoryCsv(csv);
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 7);

  assert.equal(res.rows[0].sku, "29223BLK");
  assert.equal(res.rows[0].onHand, 3982);
  assert.equal(res.rows[0].valid, true);

  assert.equal(res.rows[1].sku, "11989MAT");
  assert.equal(res.rows[1].onHand, 50);
  assert.equal(res.rows[1].valid, true);

  assert.equal(res.rows[2].sku, "COMMA_FORMAT");
  assert.equal(res.rows[2].onHand, 1234);
  assert.equal(res.rows[2].valid, true);

  assert.equal(res.rows[3].sku, "UNQUOTED_COMMA");
  assert.equal(res.rows[3].onHand, 2500);
  assert.equal(res.rows[3].valid, true);

  assert.equal(res.rows[4].sku, "INVALID_QTY");
  assert.equal(res.rows[4].valid, false);
  assert.ok(res.rows[4].error.includes("Invalid on-hand quantity"));

  assert.equal(res.rows[5].valid, false);
  assert.ok(res.rows[5].error.includes("SKU is missing"));
});

test("parseInventoryCsv supports flexible header casing and aliases", () => {
  const csv1 = `sku,on_hand\nSKU-A,10`;
  const res1 = parseInventoryCsv(csv1);
  assert.equal(res1.ok, true);
  assert.equal(res1.rows[0].sku, "SKU-A");
  assert.equal(res1.rows[0].onHand, 10);

  const csv2 = `Product Code,Quantity\nSKU-B,25`;
  const res2 = parseInventoryCsv(csv2);
  assert.equal(res2.ok, true);
  assert.equal(res2.rows[0].sku, "SKU-B");
  assert.equal(res2.rows[0].onHand, 25);
});

test("getStoreLocations returns active locations from GraphQL query", async () => {
  const mockAdmin = {
    graphql: async () => ({
      json: async () => ({
        data: {
          locations: {
            nodes: [
              { id: "gid://shopify/Location/1", name: "Main Warehouse", isActive: true },
              { id: "gid://shopify/Location/2", name: "Closed Depot", isActive: false },
              { id: "gid://shopify/Location/3", name: "Singapore Store", isActive: true },
            ],
          },
        },
      }),
    }),
  };

  const locations = await getStoreLocations(mockAdmin);
  assert.equal(locations.length, 2);
  assert.equal(locations[0].name, "Main Warehouse");
  assert.equal(locations[1].name, "Singapore Store");
});

test("planInventoryUpdate correctly matches found SKUs and flags not found", async () => {
  const mockAdmin = {
    graphql: async (query) => ({
      json: async () => {
        if (query.includes("StoreLocations")) {
          return {
            data: {
              locations: {
                nodes: [{ id: "gid://shopify/Location/1", name: "Main Warehouse", isActive: true }],
              },
            },
          };
        }
        if (query.includes("productVariants")) {
          return {
            data: {
              productVariants: {
                nodes: [
                  {
                    id: "gid://shopify/ProductVariant/101",
                    sku: "29223BLK",
                    title: "Black",
                    displayName: "MagSnap Key Cable - Black",
                    product: { id: "gid://shopify/Product/1", title: "MagSnap Key Cable" },
                    inventoryItem: { id: "gid://shopify/InventoryItem/501", tracked: true },
                  },
                ],
              },
            },
          };
        }
        return { data: {} };
      },
    }),
  };

  const csv = `SKU,On Hand
29223BLK,150
NOT_IN_STORE,25`;

  const plan = await planInventoryUpdate(mockAdmin, {
    csvText: csv,
    locationId: "gid://shopify/Location/1",
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.summary.totalRows, 2);
  assert.equal(plan.summary.skusFound, 1);
  assert.equal(plan.summary.skusNotFound, 1);
  assert.equal(plan.matched[0].sku, "29223BLK");
  assert.equal(plan.matched[0].onHand, 150);
  assert.equal(plan.notFound[0].sku, "NOT_IN_STORE");
});

test("applyInventoryUpdate updates on-hand quantities and compiles execution results", async () => {
  let executedMutationInput = null;
  let executedIdempotencyKey = null;

  const mockAdmin = {
    graphql: async (query, { variables } = {}) => ({
      json: async () => {
        if (query.includes("StoreLocations")) {
          return {
            data: {
              locations: {
                nodes: [{ id: "gid://shopify/Location/1", name: "Main Warehouse", isActive: true }],
              },
            },
          };
        }
        if (query.includes("productVariants")) {
          return {
            data: {
              productVariants: {
                nodes: [
                  {
                    id: "gid://shopify/ProductVariant/101",
                    sku: "29223BLK",
                    title: "Black",
                    displayName: "MagSnap Key Cable - Black",
                    product: { id: "gid://shopify/Product/1", title: "MagSnap Key Cable" },
                    inventoryItem: { id: "gid://shopify/InventoryItem/501", tracked: false },
                  },
                  {
                    id: "gid://shopify/ProductVariant/102",
                    sku: "11989MAT",
                    title: "Matte",
                    displayName: "Executive Pen - Matte",
                    product: { id: "gid://shopify/Product/2", title: "Executive Pen" },
                    inventoryItem: { id: "gid://shopify/InventoryItem/502", tracked: true },
                  },
                ],
              },
            },
          };
        }
        if (query.includes("InventoryItemTrack")) {
          return {
            data: {
              inventoryItemUpdate: {
                inventoryItem: { id: variables.id, tracked: true },
                userErrors: [],
              },
            },
          };
        }
        if (query.includes("InventorySetOnHandQuantities")) {
          executedMutationInput = variables.input;
          executedIdempotencyKey = variables.idempotencyKey;
          return {
            data: {
              inventorySetOnHandQuantities: {
                userErrors: [],
                inventoryAdjustmentGroup: {
                  id: "gid://shopify/InventoryAdjustmentGroup/999",
                  changes: [],
                },
              },
            },
          };
        }
        return { data: {} };
      },
    }),
  };

  const csv = `SKU,On Hand
29223BLK,80
11989MAT,200
MISSING_SKU,5`;

  const result = await applyInventoryUpdate(mockAdmin, {
    csvText: csv,
    locationId: "gid://shopify/Location/1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalRows, 3);
  assert.equal(result.summary.skusFound, 2);
  assert.equal(result.summary.skusNotFound, 1);
  assert.equal(result.summary.updatedCount, 2);
  assert.equal(result.summary.errorCount, 0);

  // Check that the mutation was correctly formulated
  assert.ok(executedIdempotencyKey);
  assert.equal(typeof executedIdempotencyKey, "string");
  assert.equal(executedMutationInput.reason, "correction");
  assert.equal(executedMutationInput.setQuantities.length, 2);
  assert.equal(executedMutationInput.setQuantities[0].inventoryItemId, "gid://shopify/InventoryItem/501");
  assert.equal(executedMutationInput.setQuantities[0].quantity, 80);
  assert.equal(executedMutationInput.setQuantities[0].changeFromQuantity, null);
  assert.equal(executedMutationInput.setQuantities[1].inventoryItemId, "gid://shopify/InventoryItem/502");
  assert.equal(executedMutationInput.setQuantities[1].quantity, 200);
  assert.equal(executedMutationInput.setQuantities[1].changeFromQuantity, null);

  // Check results lists
  assert.equal(result.updated[0].sku, "29223BLK");
  assert.equal(result.updated[0].onHand, 80);
  assert.equal(result.updated[1].sku, "11989MAT");
  assert.equal(result.updated[1].onHand, 200);

  assert.equal(result.notFound[0].sku, "MISSING_SKU");
  assert.equal(result.notFound[0].status, "not_found");
});
