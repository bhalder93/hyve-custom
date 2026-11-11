/**
 * Shipping weights from the price tool (Michael, Nov 7; HYV-217 option 1).
 *
 * Staff upload the price tool's packing export (price.hyve.promo → Export
 * cartons → Export packing details) as it comes, and each product's variants
 * get the tool's "Shopify weight (g)", the chargeable weight per piece. UPS
 * rates at checkout are worked out from variant weight × quantity, so this is
 * what makes them follow the tool's carton data.
 *
 * A row is matched to a product by the tool's "Shopify handle". The item
 * number is the check: a variant whose SKU doesn't start with the item number
 * followed by a letter (30083 → 30083BLK, not 3082 → 30823BLK) means the row
 * and the product disagree, and the product is left alone. So is a product
 * two rows point at (25777 is on both the lanyard and Trident 2 Plus Eco).
 */

const COLUMNS = { item: "Item", product: "Product", handle: "Shopify handle", grams: "Shopify weight (g)" };

const GRAMS_PER = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 };

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines in quotes. */
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

/** The export's rows, or an error naming the columns it lacks. */
export function readExport(text) {
  const [header, ...body] = parseCsv(text);
  if (!header) return { error: "The file is empty." };
  const index = Object.fromEntries(Object.entries(COLUMNS).map(([key, name]) => [key, header.findIndex((h) => h.trim() === name)]));
  const missing = Object.entries(COLUMNS).filter(([key]) => index[key] < 0).map(([, name]) => `"${name}"`);
  if (missing.length) {
    return { error: `This isn't the price tool's packing export: it has no ${missing.join(", ")} column.` };
  }
  return {
    rows: body.map((cells, n) => ({
      line: n + 2,
      item: String(cells[index.item] ?? "").trim(),
      product: String(cells[index.product] ?? "").trim(),
      handle: String(cells[index.handle] ?? "").trim(),
      grams: String(cells[index.grams] ?? "").trim(),
    })),
  };
}

const PRODUCTS_BY_HANDLE = `#graphql
  query ShippingWeightProducts($query: String!) {
    products(first: 100, query: $query) {
      nodes {
        id
        title
        handle
        variants(first: 100) {
          nodes {
            id
            sku
            inventoryItem { measurement { weight { value unit } } }
          }
        }
      }
    }
  }`;

async function productsByHandle(admin, handles) {
  const found = new Map();
  for (let i = 0; i < handles.length; i += 50) {
    const query = handles.slice(i, i + 50).map((h) => `handle:'${h.replace(/'/g, "\\'")}'`).join(" OR ");
    const body = await (await admin.graphql(PRODUCTS_BY_HANDLE, { variables: { query } })).json();
    if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
    // The search can match loosely, so only an exact handle counts.
    for (const node of body?.data?.products?.nodes || []) found.set(node.handle, node);
  }
  return found;
}

const toGrams = (weight) => (weight ? Math.round(Number(weight.value || 0) * (GRAMS_PER[weight.unit] || 0)) : 0);

/**
 * What the upload would do, product by product. Nothing is written.
 * @returns {Promise<{rows: object[], counts: {change:number, same:number, skip:number}}>}
 */
export async function planWeights(admin, exportRows) {
  const perHandle = new Map();
  for (const row of exportRows) {
    if (row.handle) perHandle.set(row.handle, (perHandle.get(row.handle) || 0) + 1);
  }
  const products = await productsByHandle(admin, [...perHandle.keys()]);

  const rows = exportRows.map((row) => {
    const base = { line: row.line, item: row.item, name: row.product, handle: row.handle, next: null, current: [] };
    const grams = Number(row.grams);
    if (!row.handle) return { ...base, status: "skip", reason: "No Shopify handle in the tool." };
    if (!/^\d+(\.\d+)?$/.test(row.grams) || !(grams > 0)) {
      return { ...base, status: "skip", reason: `Shopify weight "${row.grams}" isn't a weight in grams.` };
    }
    const next = Math.round(grams);
    if (perHandle.get(row.handle) > 1) return { ...base, next, status: "skip", reason: "Two rows in the tool point at this product." };
    const product = products.get(row.handle);
    if (!product) return { ...base, next, status: "skip", reason: "Not in the store." };

    const variants = product.variants.nodes;
    const itemPrefix = new RegExp(`^${row.item.replace(/[^0-9A-Za-z]/g, "")}[A-Za-z]`);
    const mismatched = variants.filter((v) => v.sku && !itemPrefix.test(v.sku));
    const current = [...new Set(variants.map((v) => toGrams(v.inventoryItem?.measurement?.weight)))];
    const withProduct = { ...base, name: product.title, productId: product.id, next, current };
    if (!row.item) return { ...withProduct, status: "skip", reason: "No item number in the tool." };
    if (mismatched.length) {
      return {
        ...withProduct,
        status: "skip",
        reason: `SKU ${mismatched[0].sku} doesn't start with item ${row.item}, so the row and the product disagree.`,
      };
    }
    const toChange = variants.filter((v) => toGrams(v.inventoryItem?.measurement?.weight) !== next || v.inventoryItem?.measurement?.weight?.unit !== "GRAMS");
    return toChange.length
      ? { ...withProduct, status: "change", variantIds: toChange.map((v) => v.id) }
      : { ...withProduct, status: "same" };
  });

  const counts = { change: 0, same: 0, skip: 0 };
  for (const row of rows) counts[row.status] += 1;
  return { rows, counts };
}

const SET_WEIGHTS = `#graphql
  mutation ShippingWeightsSet($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }`;

/**
 * Writes the planned weights, worked out again from the uploaded file so what
 * is written is what the preview showed for the store as it is now.
 * @returns {Promise<{updated: string[], errors: string[], counts: object}>}
 */
export async function applyWeights(admin, exportRows) {
  const plan = await planWeights(admin, exportRows);
  const updated = [];
  const errors = [];
  for (const row of plan.rows.filter((r) => r.status === "change")) {
    try {
      const body = await (
        await admin.graphql(SET_WEIGHTS, {
          variables: {
            productId: row.productId,
            variants: row.variantIds.map((id) => ({
              id,
              inventoryItem: { measurement: { weight: { value: row.next, unit: "GRAMS" } } },
            })),
          },
        })
      ).json();
      const problems = [...(body?.errors || []), ...(body?.data?.productVariantsBulkUpdate?.userErrors || [])];
      if (problems.length) errors.push(`${row.name}: ${problems.map((p) => p.message).join(", ")}`);
      else updated.push(`${row.name} → ${row.next} g`);
    } catch (error) {
      errors.push(`${row.name}: ${error?.message || error}`);
    }
  }
  return { updated, errors, counts: plan.counts };
}
