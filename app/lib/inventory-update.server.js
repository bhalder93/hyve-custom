import crypto from "node:crypto";

/**
 * Inventory update service for Shopify Admin.
 *
 * Allows staff to upload a CSV with "SKU" and "On Hand" columns, select a store
 * location from a dropdown, and update on-hand quantities via Shopify GraphQL API.
 */

const SKU_HEADER_PATTERNS = [
  /^sku$/i,
  /^product[\s_-]?code$/i,
  /^item[\s_-]?code$/i,
  /^item$/i,
  /^variant[\s_-]?sku$/i,
  /^code$/i,
];

const ON_HAND_HEADER_PATTERNS = [
  /^on[\s_-]?hand$/i,
  /^onhand$/i,
  /^quantity$/i,
  /^qty$/i,
  /^stock$/i,
  /^inventory$/i,
  /^count$/i,
];

/**
 * Normalizes an on-hand quantity string by handling thousands separators (commas, spaces),
 * currency/accounting formats, and trailing decimal zeros (.0, .00).
 * @param {string|number} raw
 * @returns {{valid: boolean, value?: number}}
 */
export function normalizeOnHandQuantity(raw) {
  if (raw === null || raw === undefined) return { valid: false };
  let str = String(raw).trim();
  if (!str) return { valid: false };

  // Handle accounting format negative numbers: "(100)" -> "-100"
  if (str.startsWith("(") && str.endsWith(")")) {
    str = `-${str.slice(1, -1).trim()}`;
  }

  // Remove common currency symbols: $100 -> 100
  str = str.replace(/^[$€£¥]/, "").trim();

  // Remove commas (thousands separators) and spaces: "3,982" -> "3982", "3 982" -> "3982"
  str = str.replace(/,/g, "").replace(/\s+/g, "");

  // If formatted as float with .0 or .00 (e.g. "3982.00" -> "3982")
  str = str.replace(/\.0+$/, "");

  // Check if string is a valid signed integer
  if (!/^[+-]?\d+$/.test(str)) {
    return { valid: false };
  }

  const num = parseInt(str, 10);
  if (!Number.isSafeInteger(num)) {
    return { valid: false };
  }

  return { valid: true, value: num };
}

/**
 * Standard RFC 4180 CSV parser supporting quotes, commas, CRLF/LF, and UTF-8 BOM.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/**
 * Parse and validate inventory CSV content.
 * @param {string} text
 * @returns {{ok: boolean, error?: string, rows?: Array<{line: number, sku: string, onHand: number, rawOnHand: string, valid: boolean, error?: string}>}}
 */
export function parseInventoryCsv(text) {
  const parsed = parseCsv(text);
  if (!parsed.length) return { ok: false, error: "The uploaded file is empty." };

  const header = parsed[0].map((h) => h.trim());
  const skuIndex = header.findIndex((h) => SKU_HEADER_PATTERNS.some((pattern) => pattern.test(h)));
  const onHandIndex = header.findIndex((h) => ON_HAND_HEADER_PATTERNS.some((pattern) => pattern.test(h)));

  const missing = [];
  if (skuIndex < 0) missing.push('"SKU"');
  if (onHandIndex < 0) missing.push('"On Hand"');

  if (missing.length) {
    return {
      ok: false,
      error: `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(" and ")}. Please ensure the CSV contains "SKU" and "On Hand" headers.`,
    };
  }

  const rawRows = parsed.slice(1);
  if (!rawRows.length) {
    return { ok: false, error: "The CSV has a header row but contains no data rows." };
  }

  const rows = [];
  for (let idx = 0; idx < rawRows.length; idx += 1) {
    const cells = rawRows[idx];
    const line = idx + 2; // 1-indexed, skipping header
    const sku = String(cells[skuIndex] ?? "").trim();
    let rawOnHand = String(cells[onHandIndex] ?? "").trim();

    // If a malformed CSV row has unquoted commas in the quantity column (e.g. SKU,3,982)
    if (onHandIndex === header.length - 1 && cells.length > header.length) {
      const combined = cells.slice(onHandIndex).join(",");
      const testCombined = normalizeOnHandQuantity(combined);
      if (testCombined.valid) {
        rawOnHand = combined;
      }
    }

    if (!sku && !rawOnHand) continue; // Skip blank line

    if (!sku) {
      rows.push({ line, sku: "", onHand: 0, rawOnHand, valid: false, error: "SKU is missing on this row." });
      continue;
    }

    const parsedQty = normalizeOnHandQuantity(rawOnHand);
    if (!parsedQty.valid) {
      rows.push({
        line,
        sku,
        onHand: 0,
        rawOnHand,
        valid: false,
        error: `Invalid on-hand quantity "${rawOnHand}". Must be a whole integer.`,
      });
      continue;
    }

    const onHand = parsedQty.value;
    rows.push({ line, sku, onHand, rawOnHand, valid: true });
  }

  if (!rows.length) {
    return { ok: false, error: "No valid rows found in the CSV." };
  }

  return { ok: true, rows };
}

export const STORE_LOCATIONS_QUERY = `#graphql
  query StoreLocations {
    locations(first: 50, includeInactive: false) {
      nodes {
        id
        name
        isActive
        fulfillsOnlineOrders
      }
    }
  }`;

/**
 * Fetch all active locations for the store.
 * @param {object} admin
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getStoreLocations(admin) {
  const response = await admin.graphql(STORE_LOCATIONS_QUERY);
  const json = await response.json();
  const nodes = json?.data?.locations?.nodes || [];
  return nodes.filter((loc) => loc.isActive).map((loc) => ({ id: loc.id, name: loc.name }));
}

export const VARIANTS_BY_SKU_QUERY = `#graphql
  query InventoryVariantsBySku($query: String!) {
    productVariants(first: 100, query: $query) {
      nodes {
        id
        sku
        title
        displayName
        product {
          id
          title
        }
        inventoryItem {
          id
          tracked
        }
      }
    }
  }`;

/**
 * Find Shopify product variants by list of SKUs.
 * @param {object} admin
 * @param {string[]} skus
 * @returns {Promise<Map<string, object>>} Map of lowercase trimmed SKU -> variant node
 */
export async function findVariantsBySkus(admin, skus) {
  const skuMap = new Map();
  const uniqueSkus = [...new Set(skus.map((s) => String(s || "").trim()).filter(Boolean))];

  for (let i = 0; i < uniqueSkus.length; i += 50) {
    const chunk = uniqueSkus.slice(i, i + 50);
    const queryString = chunk.map((s) => `sku:'${s.replace(/'/g, "\\'")}'`).join(" OR ");
    try {
      const res = await admin.graphql(VARIANTS_BY_SKU_QUERY, { variables: { query: queryString } });
      const json = await res.json();
      const variants = json?.data?.productVariants?.nodes || [];
      for (const variant of variants) {
        if (variant?.sku) {
          skuMap.set(variant.sku.trim().toLowerCase(), variant);
        }
      }
    } catch (err) {
      console.warn("[inventory-update] variant batch query error:", err?.message || err);
    }
  }

  return skuMap;
}

export const INVENTORY_SET_ON_HAND = `#graphql
  mutation InventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetOnHandQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors {
        field
        message
        code
      }
      inventoryAdjustmentGroup {
        id
        changes {
          name
          delta
          quantityAfterChange
        }
      }
    }
  }`;

export const INVENTORY_ITEM_TRACK = `#graphql
  mutation InventoryItemTrack($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
        tracked
      }
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * Preview what an inventory CSV upload would update.
 * @param {object} admin
 * @param {{csvText: string, locationId: string}} options
 */
export async function planInventoryUpdate(admin, { csvText, locationId }) {
  const parsed = parseInventoryCsv(csvText);
  if (!parsed.ok) return parsed;

  const locations = await getStoreLocations(admin);
  const location = locations.find((l) => l.id === locationId);
  if (!location) {
    return { ok: false, error: "Please select a valid store location from the dropdown." };
  }

  const validRows = parsed.rows.filter((r) => r.valid);
  const skuMap = await findVariantsBySkus(
    admin,
    validRows.map((r) => r.sku),
  );

  const matched = [];
  const notFound = [];
  const invalid = parsed.rows.filter((r) => !r.valid);

  for (const row of validRows) {
    const key = row.sku.trim().toLowerCase();
    const variant = skuMap.get(key);
    if (!variant || !variant.inventoryItem?.id) {
      notFound.push({
        line: row.line,
        sku: row.sku,
        onHand: row.onHand,
        status: "not_found",
        reason: "SKU not found in store",
      });
    } else {
      matched.push({
        line: row.line,
        sku: row.sku,
        onHand: row.onHand,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItem.id,
        tracked: variant.inventoryItem.tracked,
        productTitle: variant.product?.title || "",
        variantTitle: variant.title !== "Default Title" ? variant.title : "",
        displayName: variant.displayName || variant.product?.title || row.sku,
        status: "ready",
      });
    }
  }

  return {
    ok: true,
    location,
    locations,
    summary: {
      totalRows: parsed.rows.length,
      skusFound: matched.length,
      skusNotFound: notFound.length,
      invalidRows: invalid.length,
    },
    matched,
    notFound,
    invalid,
  };
}

/**
 * Execute the inventory update across Shopify for the selected location.
 * @param {object} admin
 * @param {{csvText: string, locationId: string}} options
 */
export async function applyInventoryUpdate(admin, { csvText, locationId }) {
  const plan = await planInventoryUpdate(admin, { csvText, locationId });
  if (!plan.ok) return plan;

  const { location, matched, notFound, invalid } = plan;
  const updated = [];
  const errors = [];

  // Group matched rows in chunks of 50 for the bulk mutation
  const CHUNK_SIZE = 50;
  for (let i = 0; i < matched.length; i += CHUNK_SIZE) {
    const chunk = matched.slice(i, i + CHUNK_SIZE);

    // Ensure inventory tracking is turned on for items that have tracked: false
    for (const item of chunk) {
      if (!item.tracked) {
        try {
          await admin.graphql(INVENTORY_ITEM_TRACK, {
            variables: { id: item.inventoryItemId, input: { tracked: true } },
          });
        } catch (e) {
          console.warn("[inventory-update] could not enable tracking for", item.sku, e?.message);
        }
      }
    }

    const setQuantities = chunk.map((item) => ({
      inventoryItemId: item.inventoryItemId,
      locationId: location.id,
      quantity: item.onHand,
      changeFromQuantity: null,
    }));

    try {
      const res = await admin.graphql(INVENTORY_SET_ON_HAND, {
        variables: {
          input: {
            reason: "correction",
            setQuantities,
          },
          idempotencyKey: crypto.randomUUID(),
        },
      });
      const json = await res.json();
      const userErrors = json?.data?.inventorySetOnHandQuantities?.userErrors || [];

      if (!userErrors.length) {
        for (const item of chunk) {
          updated.push({
            line: item.line,
            sku: item.sku,
            productTitle: item.productTitle,
            variantTitle: item.variantTitle,
            onHand: item.onHand,
            status: "updated",
          });
        }
      } else {
        // If a batch userError occurred, retry items individually to isolate failures and save successful ones
        for (const item of chunk) {
          try {
            const singleRes = await admin.graphql(INVENTORY_SET_ON_HAND, {
              variables: {
                input: {
                  reason: "correction",
                  setQuantities: [
                    {
                      inventoryItemId: item.inventoryItemId,
                      locationId: location.id,
                      quantity: item.onHand,
                      changeFromQuantity: null,
                    },
                  ],
                },
                idempotencyKey: crypto.randomUUID(),
              },
            });
            const singleJson = await singleRes.json();
            const singleErrors = singleJson?.data?.inventorySetOnHandQuantities?.userErrors || [];
            if (!singleErrors.length) {
              updated.push({
                line: item.line,
                sku: item.sku,
                productTitle: item.productTitle,
                variantTitle: item.variantTitle,
                onHand: item.onHand,
                status: "updated",
              });
            } else {
              errors.push({
                line: item.line,
                sku: item.sku,
                productTitle: item.productTitle,
                variantTitle: item.variantTitle,
                onHand: item.onHand,
                status: "error",
                error: singleErrors.map((e) => e.message).join(", "),
              });
            }
          } catch (itemErr) {
            errors.push({
              line: item.line,
              sku: item.sku,
              productTitle: item.productTitle,
              variantTitle: item.variantTitle,
              onHand: item.onHand,
              status: "error",
              error: itemErr?.message || String(itemErr),
            });
          }
        }
      }
    } catch (batchErr) {
      for (const item of chunk) {
        errors.push({
          line: item.line,
          sku: item.sku,
          productTitle: item.productTitle,
          variantTitle: item.variantTitle,
          onHand: item.onHand,
          status: "error",
          error: batchErr?.message || String(batchErr),
        });
      }
    }
  }

  // Add invalid rows to errors
  for (const inv of invalid) {
    errors.push({
      line: inv.line,
      sku: inv.sku,
      onHand: inv.rawOnHand,
      status: "error",
      error: inv.error || "Invalid row format",
    });
  }

  return {
    ok: true,
    location,
    summary: {
      totalRows: plan.summary.totalRows,
      skusFound: plan.summary.skusFound,
      skusNotFound: notFound.length,
      updatedCount: updated.length,
      errorCount: errors.length,
    },
    updated,
    notFound,
    errors,
  };
}
