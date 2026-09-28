/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

/** The file types Shopify Files takes here: see admin-file-upload.server.js. */
const ACCEPT = ".pdf,.svg,.png,.jpg,.jpeg";

/**
 * A drop box that uploads the chosen file into Shopify Files and hands its
 * link to `onUploaded` (HYV-135). The link field it sits beside stays, for a
 * file that is already in Shopify Files.
 *
 * @param {{label:string, prefix:string, onUploaded:(url:string)=>void}} props
 */
export function ShopifyFileUpload({ label, prefix, onUploaded }) {
  const fetcher = useFetcher();
  const handled = useRef(null);
  const [rejected, setRejected] = useState(false);
  const uploading = fetcher.state !== "idle";
  const result = fetcher.data;

  useEffect(() => {
    if (fetcher.state === "idle" && result?.ok && handled.current !== result.url) {
      handled.current = result.url;
      onUploaded(result.url);
    }
  }, [fetcher.state, result, onUploaded]);

  const upload = (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setRejected(false);
    const form = new FormData();
    form.append("file", file);
    form.append("prefix", prefix);
    fetcher.submit(form, { method: "post", action: "/app/upload-file", encType: "multipart/form-data" });
  };

  return (
    <s-stack direction="block" gap="small">
      <s-drop-zone
        label={label}
        accept={ACCEPT}
        disabled={uploading}
        error={
          rejected
            ? "Upload a PDF, SVG, PNG or JPEG file."
            : !uploading && result && !result.ok
              ? result.error
              : undefined
        }
        onChange={upload}
        onDropRejected={() => setRejected(true)}
      />
      {uploading ? (
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-spinner size="base" accessibilityLabel="Uploading" />
          <s-text color="subdued">Uploading to Shopify Files…</s-text>
        </s-stack>
      ) : (
        <s-text color="subdued">
          {result?.ok ? `Uploaded ${result.filename}. The link is filled in below.` : "PDF, SVG, PNG or JPEG, up to 20 MB."}
        </s-text>
      )}
    </s-stack>
  );
}
