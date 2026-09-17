/**
 * Service to upload files directly into Shopify Files (CDN) via GraphQL Admin API.
 */
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Upload a document/image file into Shopify Files.
 *
 * @param {object} admin - Authenticated Shopify admin context
 * @param {File|Blob|object} file - The file object from formData
 * @returns {Promise<{ url: string, id?: string, error?: string }>}
 */
export async function uploadToShopifyFiles(admin, file) {
  if (!file || !file.name || !file.size) {
    return { url: "", error: "No file provided" };
  }

  const filename = file.name;
  const mimeType = file.type || "application/octet-stream";
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    // Step 1: Create staged upload target in Shopify
    const stagedResponse = await admin.graphql(
      `#graphql
      mutation GenerateStagedUploadTarget($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: [
            {
              filename,
              mimeType,
              httpMethod: "POST",
              resource: "FILE",
            },
          ],
        },
      },
    );

    const stagedData = await stagedResponse.json();
    const stagedTarget = stagedData?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    const userErrors = stagedData?.data?.stagedUploadsCreate?.userErrors;

    if (userErrors && userErrors.length > 0) {
      console.warn("[shopify-files] stagedUploadsCreate userErrors:", userErrors);
      throw new Error(userErrors.map((e) => e.message).join(", "));
    }

    if (!stagedTarget || !stagedTarget.url) {
      throw new Error("Failed to get staged upload target from Shopify");
    }

    // Step 2: Upload file buffer to the staged target URL
    const formData = new FormData();
    for (const param of stagedTarget.parameters) {
      formData.append(param.name, param.value);
    }
    const blob = new Blob([buffer], { type: mimeType });
    formData.append("file", blob, filename);

    const uploadResponse = await fetch(stagedTarget.url, {
      method: "POST",
      body: formData,
    });

    if (!uploadResponse.ok) {
      const respText = await uploadResponse.text();
      console.warn("[shopify-files] Staged target POST failed:", uploadResponse.status, respText);
      throw new Error(`Staged upload failed with HTTP ${uploadResponse.status}`);
    }

    // Step 3: Create the File in Shopify with fileCreate mutation
    const fileCreateResponse = await admin.graphql(
      `#graphql
      mutation CreateShopifyFile($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            alt
            createdAt
            ... on GenericFile {
              url
            }
            ... on MediaImage {
              image {
                url
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          files: [
            {
              originalSource: stagedTarget.resourceUrl,
              filename,
              contentType: "FILE",
            },
          ],
        },
      },
    );

    const createData = await fileCreateResponse.json();
    const createdFile = createData?.data?.fileCreate?.files?.[0];
    const fileErrors = createData?.data?.fileCreate?.userErrors;

    if (fileErrors && fileErrors.length > 0) {
      console.warn("[shopify-files] fileCreate userErrors:", fileErrors);
    }

    let fileUrl = createdFile?.url || createdFile?.image?.url;

    // Step 4: If URL is pending processing, poll briefly or use resourceUrl
    if (!fileUrl && createdFile?.id) {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 600));
        try {
          const checkRes = await admin.graphql(
            `#graphql
            query CheckFileStatus($id: ID!) {
              node(id: $id) {
                ... on GenericFile {
                  url
                  fileStatus
                }
                ... on MediaImage {
                  image {
                    url
                  }
                  fileStatus
                }
              }
            }`,
            { variables: { id: createdFile.id } },
          );
          const checkData = await checkRes.json();
          const node = checkData?.data?.node;
          fileUrl = node?.url || node?.image?.url;
          if (fileUrl) break;
        } catch (pollErr) {
          // Continue
        }
      }
    }

    const finalUrl = fileUrl || stagedTarget.resourceUrl;

    return {
      url: finalUrl,
      id: createdFile?.id,
    };
  } catch (err) {
    console.warn("[shopify-files] Shopify files upload error, falling back to local storage:", err?.message || err);

    // Fallback: Save to local public/uploads so file is NEVER lost
    try {
      const uploadsDir = path.join(process.cwd(), "public", "uploads");
      await fs.mkdir(uploadsDir, { recursive: true });
      const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const filePath = path.join(uploadsDir, safeName);
      await fs.writeFile(filePath, buffer);
      return {
        url: `/uploads/${safeName}`,
        error: err?.message,
      };
    } catch (localErr) {
      return {
        url: "",
        error: err?.message || "Failed to upload file",
      };
    }
  }
}
