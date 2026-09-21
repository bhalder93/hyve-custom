/**
 * Saved artwork library (F4, F13).
 *
 * The library is one `hyve.artwork` JSON metafield on the customer. Each entry
 * is keyed by the file's URL and records which orders have used it.
 *
 * Why a URL-keyed JSON document rather than metaobjects with file references:
 * artwork reaches us from two places that store files differently.
 *
 *   1. The product page uploads through Shopify's native line-item-property
 *      file upload. The order only ever carries a URL and a filename — there is
 *      no Shopify File object to reference.
 *   2. The portal uploads through staged uploads into Shopify Files, which does
 *      give us a file id.
 *
 * A URL key covers both, and holding the order list (not just a count) is what
 * makes "used in N orders" (F4) and "deletable only when no order uses it"
 * (F13) answerable from a single read.
 *
 * Scoping: F4 asks for a library per company, shared across the users on it, so
 * the document hangs off the company when the buyer belongs to one. A retail
 * customer has no company, so theirs stays on the customer record — that is a
 * different owner, not a fallback for the same one.
 *
 * Libraries written before the move are merged into the company's on first read
 * and then cleared, so nobody loses files and there is only ever one source.
 */

const METAFIELD = { namespace: "hyve", key: "artwork", type: "json" };
const DOC_VERSION = 1;

/** F3: a limit is enforced and stated on screen. Exact figure pending OD16. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_LABEL = "20 MB";

/** F2: vector for laser decoration, high-resolution raster for digital and transfer. */
export const ACCEPTED_EXTENSIONS = [".ai", ".eps", ".pdf", ".svg", ".png", ".jpg", ".jpeg"];

/** Formats a browser can render. Everything else gets a generic icon (F13). */
const PREVIEWABLE = [".png", ".jpg", ".jpeg", ".svg"];

export function isPreviewable(filename) {
  return PREVIEWABLE.some((ext) => String(filename).toLowerCase().endsWith(ext));
}

export function extensionOf(filename) {
  const match = String(filename).toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

/* ---------------- document helpers ---------------- */

/** Stable key for an entry: the file URL without its query string. */
export function keyForUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

function emptyDoc() {
  return { version: DOC_VERSION, files: [] };
}

function parseDoc(value) {
  if (!value) return emptyDoc();
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed && Array.isArray(parsed.files)) return { version: DOC_VERSION, files: parsed.files };
  } catch {
    /* fall through to an empty library rather than losing the page */
  }
  return emptyDoc();
}

/** Shape one stored entry into what the page renders. */
function toView(entry) {
  const filename = entry.filename || "Untitled";
  const orders = Array.isArray(entry.orders) ? entry.orders : [];
  return {
    id: entry.id,
    filename,
    url: entry.url || "",
    uploadedAt: entry.uploadedAt || "",
    orders,
    orderCount: orders.length,
    previewUrl: isPreviewable(filename) ? entry.url || "" : "",
    downloadUrl: entry.url || "",
    extension: extensionOf(filename),
    source: entry.source || "portal",
  };
}

/* ---------------- ownership ---------------- */

/**
 * Who the library belongs to. A distributor's is the company's, shared with
 * everyone on it; a retail customer's is their own.
 *
 * @param {{companyId?:?string, customerId?:?string}} who
 */
export function artworkOwnerGid({ companyId, customerId } = {}) {
  if (companyId) return companyId;
  return customerId ? `gid://shopify/Customer/${String(customerId).replace(/\D/g, "")}` : "";
}

/**
 * The company a customer buys for, if any. Used where there is no portal
 * session to read it from, such as a webhook.
 */
export async function companyGidForCustomer(admin, customerGid) {
  const data = await gql(admin, `#graphql
    query ArtworkOwnerCompany($id: ID!) {
      customer(id: $id) {
        companyContactProfiles { company { id } }
      }
    }`, { id: customerGid });

  return data?.customer?.companyContactProfiles?.[0]?.company?.id || null;
}

/* ---------------- read ---------------- */

/**
 * @param {string} ownerGid company or customer, from artworkOwnerGid()
 * @param {?string} [legacyGid] a customer library to fold in and clear, once
 */
export async function listArtwork(admin, ownerGid, legacyGid = null) {
  if (!admin || !ownerGid) return { files: [], failed: true };

  try {
    let doc = await readDoc(admin, ownerGid);
    if (doc === null) return { files: [], failed: true };

    if (legacyGid && legacyGid !== ownerGid) {
      doc = await absorbLegacyLibrary(admin, ownerGid, legacyGid, doc);
    }

    // Shopify processes uploads asynchronously, so a file saved moments ago is
    // still pointing at its temporary staged URL. Swap in the permanent one as
    // soon as it exists — the staged URL expires.
    const settled = await settleStagedUrls(admin, ownerGid, doc);

    const files = settled.files
      .map(toView)
      .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));

    return { files, failed: false };
  } catch (error) {
    console.warn("[artwork] library read failed", error?.message || error);
    return { files: [], failed: true };
  }
}

/* ---------------- upload from the portal ---------------- */

/**
 * Stage the bytes into Shopify Files, then add the entry to the library with an
 * empty order list. It gains orders as they use it.
 */
export async function uploadArtwork(admin, ownerGid, file) {
  if (!admin || !ownerGid) return { ok: false, error: "You need to be signed in to upload artwork." };
  if (!file || typeof file.arrayBuffer !== "function") return { ok: false, error: "No file received." };

  const filename = String(file.name || "artwork");
  if (!ACCEPTED_EXTENSIONS.includes(extensionOf(filename))) {
    return { ok: false, error: `That file type isn't accepted. Use ${ACCEPTED_EXTENSIONS.join(", ")}.` };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: `That file is larger than the ${MAX_FILE_LABEL} limit.` };
  }

  const isImage = String(file.type || "").startsWith("image/") && !filename.toLowerCase().endsWith(".svg");

  try {
    const staged = await gql(admin, `#graphql
      mutation ArtworkStagedUpload($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`, {
      input: [{
        filename,
        mimeType: file.type || "application/octet-stream",
        resource: isImage ? "IMAGE" : "FILE",
        httpMethod: "POST",
        fileSize: String(file.size),
      }],
    });

    const target = staged?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      return { ok: false, error: staged?.stagedUploadsCreate?.userErrors?.[0]?.message || "Could not start the upload." };
    }

    const form = new FormData();
    for (const { name, value } of target.parameters || []) form.append(name, value);
    form.append(
      "file",
      new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" }),
      filename,
    );

    const upload = await fetch(target.url, { method: "POST", body: form });
    if (!upload.ok) {
      console.warn("[artwork] staged upload failed", upload.status);
      return { ok: false, error: "The file could not be uploaded. Please try again." };
    }

    const created = await gql(admin, `#graphql
      mutation ArtworkFileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            __typename
            ... on MediaImage { image { url } }
            ... on GenericFile { url }
          }
          userErrors { field message }
        }
      }`, {
      files: [{ originalSource: target.resourceUrl, contentType: isImage ? "IMAGE" : "FILE", alt: filename }],
    });

    const node = created?.fileCreate?.files?.[0];
    if (!node?.id) {
      return { ok: false, error: created?.fileCreate?.userErrors?.[0]?.message || "The file could not be saved." };
    }

    // Files are processed asynchronously, so the URL can be empty on the first
    // read. Fall back to the staged resource URL, which is already public.
    const url = node.url || node.image?.url || target.resourceUrl;

    const saved = await mutateDoc(admin, ownerGid, (doc) => {
      const key = keyForUrl(url);
      if (doc.files.some((f) => f.id === key)) return doc;
      doc.files.push({
        id: key,
        url,
        filename,
        fileId: node.id,
        uploadedAt: new Date().toISOString(),
        source: "portal",
        orders: [],
      });
      return doc;
    });
    if (!saved.ok) return saved;

    // The URL goes back to the caller as well as into the library: uploading
    // from an order needs it to record the file against that order.
    return { ok: true, filename, url };
  } catch (error) {
    console.error("[artwork] upload failed", error);
    return { ok: false, error: "Something went wrong uploading that file." };
  }
}

/* ---------------- record order usage (the PDP -> library link) ---------------- */

/**
 * Called from the orders/create webhook. Adds any artwork found on the order's
 * line-item properties to the library, and records the order against it.
 *
 * Idempotent: an order already recorded against an entry is not added twice, so
 * a replayed webhook cannot inflate the count.
 *
 * @param {Array<{url:string, filename:string}>} artworks
 * @param {{id:string, name:string, createdAt:string}} order
 */
export async function recordOrderArtwork(admin, ownerGid, artworks, order) {
  if (!admin || !ownerGid || !artworks?.length) return { ok: true, added: 0 };

  const result = await mutateDoc(admin, ownerGid, (doc) => {
    for (const art of artworks) {
      const key = keyForUrl(art.url);
      if (!key) continue;

      let entry = doc.files.find((f) => f.id === key);
      if (!entry) {
        entry = {
          id: key,
          url: art.url,
          filename: art.filename || key.split("/").pop() || "Artwork",
          uploadedAt: order.createdAt || new Date().toISOString(),
          source: "order",
          orders: [],
        };
        doc.files.push(entry);
      }

      if (!Array.isArray(entry.orders)) entry.orders = [];
      if (!entry.orders.some((o) => o.id === order.id)) {
        entry.orders.push({ id: order.id, name: order.name, at: order.createdAt });
      }
    }
    return doc;
  });

  return { ok: result.ok, added: artworks.length };
}

/**
 * Pull artwork out of an order webhook payload.
 *
 * The product page uploads one file per decoration zone as a line-item
 * property, so the property value is a URL on Shopify's CDN. Underscore-
 * prefixed properties are the theme's own bookkeeping and are skipped.
 *
 * @param {object} payload orders/create webhook body
 */
export function artworkFromOrderPayload(payload) {
  return artworkFromAttributes(
    (payload?.line_items || []).flatMap((line) =>
      (line?.properties || []).map((prop) => ({ key: prop?.name, value: prop?.value })),
    ),
  );
}

/**
 * The same rule applied to line-item properties read through the Admin API,
 * where they arrive as `customAttributes` with `key` instead of `name`. Used
 * by the order detail to list the artwork already on an order.
 *
 * @param {Array<{key?:string, value?:string}>} attributes
 */
export function artworkFromAttributes(attributes) {
  const found = [];
  const seen = new Set();

  for (const attr of attributes || []) {
    const value = String(attr?.value || "");
    const name = String(attr?.key || "");
    if (name.startsWith("_")) continue;
    if (!/^https?:\/\//i.test(value)) continue;

    const filename = decodeURIComponent(keyForUrl(value).split("/").pop() || "");
    if (!ACCEPTED_EXTENSIONS.includes(extensionOf(filename))) continue;

    const key = keyForUrl(value);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ url: value, filename, zone: name });
  }

  return found;
}

/* ---------------- delete ---------------- */

/** F13: deletable only where no order is using it. */
export async function deleteArtwork(admin, ownerGid, artworkId) {
  if (!admin || !ownerGid || !artworkId) return { ok: false, error: "Nothing to delete." };

  const doc = await readDoc(admin, ownerGid);
  if (doc === null) return { ok: false, error: "Your library could not be read." };

  const entry = doc.files.find((f) => f.id === artworkId);
  if (!entry) return { ok: false, error: "That file is not in your library." };

  // F13 blocks deletion only while an order still needs the file. An order that
  // has shipped and closed, or been cancelled, no longer does — so a file used
  // once a year ago does not become permanently undeletable.
  const open = await openOrdersAmong(admin, (entry.orders || []).map((o) => o.id));
  if (open.length) {
    const names = open.map((o) => o.name).filter(Boolean).join(", ");
    return {
      ok: false,
      error: names
        ? `That file is being used on ${names}, so it can't be deleted yet.`
        : "That file is being used on an open order, so it can't be deleted yet.",
    };
  }

  const saved = await mutateDoc(admin, ownerGid, (d) => {
    d.files = d.files.filter((f) => f.id !== artworkId);
    return d;
  });
  if (!saved.ok) return saved;

  // Only portal uploads have a Shopify File to remove. Files attached to an
  // order by the product page are owned by the order, not by us.
  if (entry.fileId) {
    await gql(admin, `#graphql
      mutation ArtworkFileDelete($fileIds: [ID!]!) {
        fileDelete(fileIds: $fileIds) { deletedFileIds userErrors { field message } }
      }`, { fileIds: [entry.fileId] });
  }

  return { ok: true, deleted: entry.filename };
}

/** Of the orders given, the ones still in flight. */
async function openOrdersAmong(admin, orderIds) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  if (!ids.length) return [];

  const data = await gql(admin, `#graphql
    query ArtworkOrderState($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order { id name closed cancelledAt }
      }
    }`, { ids });

  return (data?.nodes || []).filter((node) => node?.id && !node.closed && !node.cancelledAt);
}

/**
 * Fold a library written against the customer into the company's, once.
 *
 * Two people on the same company can each have one, so this merges rather than
 * skipping when the company already has files. The customer's copy is emptied
 * afterwards so there is exactly one library from then on.
 */
async function absorbLegacyLibrary(admin, ownerGid, legacyGid, current) {
  const legacy = await readDoc(admin, legacyGid);
  if (!legacy?.files?.length) return current;

  const byId = new Map(current.files.map((file) => [file.id, file]));
  for (const file of legacy.files) {
    const existing = byId.get(file.id);
    if (!existing) {
      byId.set(file.id, file);
      continue;
    }
    // Same file on both sides: keep the union of the orders that used it.
    const orders = [...(existing.orders || [])];
    for (const order of file.orders || []) {
      if (!orders.some((o) => o.id === order.id)) orders.push(order);
    }
    existing.orders = orders;
  }

  const merged = { version: DOC_VERSION, files: [...byId.values()] };
  const saved = await mutateDoc(admin, ownerGid, () => merged);
  if (!saved.ok) return current;

  await mutateDoc(admin, legacyGid, (doc) => {
    doc.files = [];
    return doc;
  });

  return merged;
}

/* ---------------- metafield plumbing ---------------- */

async function readDoc(admin, ownerGid) {
  // The owner is a Company for a distributor and a Customer for a retail
  // account, so the read goes through `node` rather than naming one of them.
  const data = await gql(admin, `#graphql
    query ArtworkDoc($id: ID!) {
      node(id: $id) {
        ... on Company {
          artwork: metafield(namespace: "hyve", key: "artwork") { value }
        }
        ... on Customer {
          artwork: metafield(namespace: "hyve", key: "artwork") { value }
        }
      }
    }`, { id: ownerGid });

  if (!data?.node) return null;
  return parseDoc(data.node.artwork?.value);
}

/** Read, transform, write. Last write wins — see the note in the route. */
async function mutateDoc(admin, ownerGid, transform) {
  const doc = await readDoc(admin, ownerGid);
  if (doc === null) return { ok: false, error: "Your library could not be read." };

  const next = transform(doc) || doc;

  const saved = await gql(admin, `#graphql
    mutation ArtworkDocSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message code }
      }
    }`, {
    metafields: [{
      ownerId: ownerGid,
      namespace: METAFIELD.namespace,
      key: METAFIELD.key,
      type: METAFIELD.type,
      value: JSON.stringify(next),
    }],
  });

  const error = saved?.metafieldsSet?.userErrors?.[0]?.message;
  if (error) {
    console.warn("[artwork] library write failed", error);
    return { ok: false, error: "Your library could not be updated." };
  }
  return { ok: true };
}

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors) console.warn("[artwork] graphql errors", JSON.stringify(body.errors));
  return body?.data || null;
}

const STAGED_HOST = "shopify-staged-uploads.storage.googleapis.com";

/**
 * Replace temporary staged URLs with the permanent Shopify Files URL.
 * Only runs while at least one entry is still temporary.
 */
async function settleStagedUrls(admin, ownerGid, doc) {
  const pending = doc.files.filter((f) => f.fileId && String(f.url).includes(STAGED_HOST));
  if (!pending.length) return doc;

  const data = await gql(admin, `#graphql
    query ArtworkFileUrls($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on MediaImage { id image { url } }
        ... on GenericFile { id url }
      }
    }`, { ids: pending.map((f) => f.fileId) });

  const urlById = new Map();
  for (const node of data?.nodes || []) {
    const url = node?.url || node?.image?.url;
    if (node?.id && url) urlById.set(node.id, url);
  }
  if (!urlById.size) return doc;

  let changed = false;
  for (const entry of doc.files) {
    const fresh = entry.fileId && urlById.get(entry.fileId);
    if (fresh && fresh !== entry.url) {
      entry.url = fresh;
      entry.id = keyForUrl(fresh);
      changed = true;
    }
  }

  if (changed) await mutateDoc(admin, ownerGid, () => doc);
  return doc;
}
