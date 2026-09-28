import { authenticate } from "../shopify.server";
import { uploadAdminFile } from "../lib/admin-file-upload.server";

/**
 * Admin upload into Shopify Files (HYV-135). The order page's upload boxes
 * post the chosen file here and get its Shopify Files link back, which fills
 * the Artwork Proof or Production Photo field.
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    return await uploadAdminFile(admin, form.get("file"), String(form.get("prefix") || ""));
  } catch (error) {
    console.error("[upload-file] upload failed", error);
    return { ok: false, error: error?.message || "The upload failed. Try again." };
  }
};
