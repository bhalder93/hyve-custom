/**
 * Uploading a file from the admin app into Shopify Files (Content > Files),
 * for Artwork Proofs and Production Photos (HYV-135). Staff used to upload the
 * file there by hand and paste its link; this does the same three steps
 * Shopify documents for it, then hands back the link.
 *
 *   1. stagedUploadsCreate: somewhere to put the file
 *   2. upload the file there
 *   3. fileCreate, then wait until Shopify has processed it and it has a URL
 *
 * PNG and JPEG become images. PDF and SVG become generic files: Shopify only
 * treats PNG, GIF, JPEG, WEBP and HEIC as images.
 *
 * Separate from shopify-files.server.js, which the distributor application
 * form uses for its registration document and handles differently.
 */

/** Shopify's limit for a generic file. */
const MAX_BYTES = 20 * 1024 * 1024;

const TYPES = {
  pdf: { mimeType: "application/pdf", resource: "FILE" },
  svg: { mimeType: "image/svg+xml", resource: "FILE" },
  png: { mimeType: "image/png", resource: "IMAGE" },
  jpg: { mimeType: "image/jpeg", resource: "IMAGE" },
  jpeg: { mimeType: "image/jpeg", resource: "IMAGE" },
};

/** How long to wait for Shopify to finish processing, in one-second checks. */
const READY_CHECKS = 20;

const STAGED_UPLOAD = `#graphql
  mutation FileStagedUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;

const FILE_CREATE = `#graphql
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus }
      userErrors { field message }
    }
  }`;

const FILE_STATUS = `#graphql
  query FileStatus($id: ID!) {
    node(id: $id) {
      ... on MediaImage { fileStatus image { url } }
      ... on GenericFile { fileStatus url }
    }
  }`;

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors?.length) throw new Error(body.errors[0]?.message || "Shopify rejected the request.");
  return body.data || {};
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {File} file from the admin form
 * @param {string} [prefix] put before the file name in Shopify Files, e.g. "1011-proof"
 * @returns {Promise<{ok:true, url:string, filename:string}|{ok:false, error:string}>}
 */
export async function uploadAdminFile(admin, file, prefix = "") {
  if (!file || typeof file.arrayBuffer !== "function" || !file.size) {
    return { ok: false, error: "Choose a file to upload." };
  }
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  const type = TYPES[extension];
  if (!type) return { ok: false, error: "Upload a PDF, SVG, PNG or JPEG file." };
  if (file.size > MAX_BYTES) return { ok: false, error: "That file is over 20 MB. Upload a smaller one." };

  const safeName = String(file.name).replace(/[^A-Za-z0-9._-]+/g, "-");
  const filename = prefix ? `${prefix.replace(/[^A-Za-z0-9_-]+/g, "")}-${safeName}` : safeName;

  const staged = await gql(admin, STAGED_UPLOAD, {
    input: [{ filename, mimeType: type.mimeType, resource: type.resource, httpMethod: "POST", fileSize: String(file.size) }],
  });
  const stagedError = staged.stagedUploadsCreate?.userErrors?.[0]?.message;
  const target = staged.stagedUploadsCreate?.stagedTargets?.[0];
  if (stagedError || !target) return { ok: false, error: stagedError || "Shopify didn't accept the upload." };

  // The target's own parameters go first and the file last, as the storage
  // service expects.
  const body = new FormData();
  for (const { name, value } of target.parameters) body.append(name, value);
  body.append("file", new Blob([await file.arrayBuffer()], { type: type.mimeType }), filename);
  const uploaded = await fetch(target.url, { method: "POST", body });
  if (!uploaded.ok) return { ok: false, error: `The upload failed (${uploaded.status}). Try again.` };

  const created = await gql(admin, FILE_CREATE, {
    files: [{ originalSource: target.resourceUrl, contentType: type.resource, filename }],
  });
  const createError = created.fileCreate?.userErrors?.[0]?.message;
  const fileId = created.fileCreate?.files?.[0]?.id;
  if (createError || !fileId) return { ok: false, error: createError || "Shopify couldn't save the file." };

  for (let check = 0; check < READY_CHECKS; check += 1) {
    const { node } = await gql(admin, FILE_STATUS, { id: fileId });
    const url = node?.image?.url || node?.url;
    if (node?.fileStatus === "READY" && url) return { ok: true, url, filename };
    if (node?.fileStatus === "FAILED") return { ok: false, error: "Shopify couldn't process that file. Try another one." };
    await wait(1000);
  }
  return {
    ok: false,
    error: "The file is still processing in Shopify. Copy its link from Content › Files in a minute instead.",
  };
}
