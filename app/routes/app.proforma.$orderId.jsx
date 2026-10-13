/* eslint-disable react/prop-types */
import { useCallback, useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { TERMS_OF_SALE, loadProformaDocument, saveProformaFields } from "../lib/proforma-document.server";

/**
 * Proforma invoice for an order (HYV-118): the fields Shopify doesn't hold,
 * what's still missing, and the download. See proforma-document.server.js.
 */

const orderGidFrom = (params) => {
  const id = String(params?.orderId || "").replace(/\D/g, "");
  return id ? `gid://shopify/Order/${id}` : "";
};

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const orderGid = orderGidFrom(params);
  if (!orderGid) throw new Response("Order ID is required.", { status: 400 });
  const doc = await loadProformaDocument(admin, orderGid, { staff: true });
  if (!doc) throw new Response("Order not found.", { status: 404 });
  return {
    numericId: orderGid.replace("gid://shopify/Order/", ""),
    orderName: doc.orderName,
    companyName: doc.companyName,
    legalName: doc.legalName,
    taxId: doc.taxId,
    taxIdLabel: doc.taxIdLabel,
    hasCompany: Boolean(doc.companyId),
    fields: doc.fields,
    missing: doc.missing,
    poNumber: doc.poNumber,
    incoterm: doc.incoterm,
    quoteReference: doc.quoteReference,
    paidInFull: doc.paidInFull,
    termsOfSaleOptions: TERMS_OF_SALE,
  };
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const orderGid = orderGidFrom(params);
  if (!orderGid) return { ok: false, error: "Order ID is required." };
  const form = await request.formData();
  const error = await saveProformaFields(admin, orderGid, {
    termsOfSale: form.get("termsOfSale"),
    shippingMark: form.get("shippingMark"),
    cartons: form.get("cartons"),
    grossWeight: form.get("grossWeight"),
    dimensions: form.get("dimensions"),
    legalName: form.get("legalName"),
    taxId: form.get("taxId"),
  });
  return error ? { ok: false, error } : { ok: true };
};

function Field({ label, name, value, onChange, details }) {
  return (
    <s-text-field
      label={label}
      name={name}
      value={value}
      details={details}
      onInput={(event) => onChange(name, event.currentTarget.value)}
    />
  );
}

export default function ProformaPage() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const [values, setValues] = useState({
    termsOfSale: data.fields.termsOfSale,
    shippingMark: data.fields.shippingMark,
    cartons: data.fields.cartons,
    grossWeight: data.fields.grossWeight,
    dimensions: data.fields.dimensions,
    legalName: data.legalName,
    taxId: data.taxId,
  });
  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  // After a save the page reloads its data; the form follows it, so Download
  // turns on without reloading the page.
  useEffect(() => {
    setValues({
      termsOfSale: data.fields.termsOfSale,
      shippingMark: data.fields.shippingMark,
      cartons: data.fields.cartons,
      grossWeight: data.fields.grossWeight,
      dimensions: data.fields.dimensions,
      legalName: data.legalName,
      taxId: data.taxId,
    });
  }, [data]);
  // The PDF prints what's saved, so download waits for unsaved edits.
  const saved = {
    termsOfSale: data.fields.termsOfSale,
    shippingMark: data.fields.shippingMark,
    cartons: data.fields.cartons,
    grossWeight: data.fields.grossWeight,
    dimensions: data.fields.dimensions,
    legalName: data.legalName,
    taxId: data.taxId,
  };
  const dirty = Object.keys(saved).some((key) => String(values[key] ?? "") !== String(saved[key] ?? ""));
  const saving = fetcher.state !== "idle";

  const revalidator = useRevalidator();
  useEffect(() => {
    if (!fetcher.data?.ok) return;
    shopify.toast.show("Proforma details saved.");
    // Read the saved values back, which also switches Download on.
    revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const download = useCallback(async () => {
    setDownloading(true);
    setDownloadError("");
    try {
      const response = await fetch(`/app/proforma-pdf/${data.numericId}`);
      if (response.status === 409) {
        const body = await response.json();
        setDownloadError(`Still missing: ${(body.missing || []).join(", ")}.`);
        return;
      }
      if (!response.ok) throw new Error(`${response.status}`);
      const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "")?.[1] || "Proforma.pdf";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      // The first download issues the number; show it.
      revalidator.revalidate();
    } catch (error) {
      console.error("[proforma] download failed", error);
      setDownloadError("The proforma couldn't be generated. Please try again.");
    } finally {
      setDownloading(false);
    }
  }, [data.numericId, revalidator]);

  return (
    <s-page heading={`Proforma invoice · ${data.orderName}`} inlineSize="base">
      <s-link slot="breadcrumb-actions" href={`/app/production-orders/${data.numericId}`}>
        Order
      </s-link>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {data.fields.number
              ? `Issued as ${data.fields.number}. Downloading again reprints it with the same number, with any changes to the order.`
              : "Not issued yet. The first download gives it its number."}
            {data.quoteReference ? ` From quote ${data.quoteReference}.` : ""}
          </s-paragraph>
          {data.paidInFull ? (
            <s-banner tone="info">
              <s-paragraph>This order is paid in full. The invoice is usually the document to send.</s-paragraph>
            </s-banner>
          ) : null}
          {data.missing.length ? (
            <s-banner tone="warning" heading="Needed before it can be issued">
              <s-unordered-list>
                {data.missing.map((item) => (
                  <s-list-item key={item}>{item}</s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          ) : null}
          {downloadError ? (
            <s-banner tone="critical">
              <s-paragraph>{downloadError}</s-paragraph>
            </s-banner>
          ) : null}
          <s-stack direction="inline" gap="small">
            <s-button variant="primary" loading={downloading} disabled={data.missing.length > 0 || dirty} onClick={download}>
              Download proforma invoice
            </s-button>
            {dirty ? <s-text color="subdued">Save your changes first.</s-text> : null}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="On the order">
        <s-stack direction="block" gap="small">
          <s-text>Customer PO number: {data.poNumber || "— (add it on the order in Shopify)"}</s-text>
          <s-text>Incoterm: {data.incoterm || "— (the order has no shipping method)"}</s-text>
        </s-stack>
      </s-section>

      <>
        <s-section heading="Consignee">
          <s-stack direction="block" gap="base">
            {data.hasCompany ? (
              <>
                <Field
                  label="Legal entity name"
                  name="legalName"
                  value={values.legalName}
                  onChange={set}
                  details={`Only if it differs from the company name in Shopify (${data.companyName}), which is the Company Legal Name from the application. Printed as the consignee. Saved on the company.`}
                />
                <Field
                  label={`Consignee tax ID (${data.taxIdLabel})`}
                  name="taxId"
                  value={values.taxId}
                  onChange={set}
                  details="The company's tax registration number, printed under the legal name. Saved on the company."
                />
              </>
            ) : (
              <s-paragraph>This order has no company, so there is no consignee to print.</s-paragraph>
            )}
          </s-stack>
        </s-section>

        <s-section heading="Shipment">
          <s-stack direction="block" gap="base">
            <s-select
              label="Terms of Sale"
              name="termsOfSale"
              value={values.termsOfSale}
              onChange={(event) => set("termsOfSale", event.currentTarget.value)}
            >
              <s-option value="">Choose</s-option>
              {data.termsOfSaleOptions.map((term) => (
                <s-option key={term} value={term}>
                  {term}
                </s-option>
              ))}
            </s-select>
            <Field label="Shipping mark" name="shippingMark" value={values.shippingMark} onChange={set} />
            <Field label="Number of cartons" name="cartons" value={values.cartons} onChange={set} />
            <Field label="Gross weight" name="grossWeight" value={values.grossWeight} onChange={set} details="With the unit, e.g. 82.5 kg" />
            <Field label="Dimensions" name="dimensions" value={values.dimensions} onChange={set} details="e.g. 3 × (60 × 40 × 40 cm)" />
            <s-paragraph color="subdued">Left blank, these are left off the document.</s-paragraph>
            {fetcher.data && !fetcher.data.ok ? (
              <s-banner tone="critical">
                <s-paragraph>{fetcher.data.error}</s-paragraph>
              </s-banner>
            ) : null}
            <s-stack direction="inline">
              <s-button loading={saving} onClick={() => fetcher.submit(values, { method: "post" })}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("[proforma] render failed:", error);
  return (
    <s-page heading="Proforma invoice">
      <s-section>
        <s-banner tone="critical" heading="We couldn't load this order">
          <s-paragraph>{error?.data || error?.message || "Please reload the page."}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}
