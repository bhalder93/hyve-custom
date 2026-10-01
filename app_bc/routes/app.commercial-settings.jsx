import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  COMMERCIAL_SETTINGS,
  loadCommercialSettings,
  saveCommercialSettings,
} from "../lib/commercial-settings.server";

/**
 * Commercial settings, set by Hyve staff without a release: the setup charge
 * waiver threshold and the distributor minimum order value (HYV-81), which
 * the cart page, the checkout charges block and the checkout rule read; and
 * the standard and rush production times (HYV-133), which the product page,
 * cart and quote promise and every production due date is counted from; and
 * the artwork deadline (HYV-102), the "by" date on an order waiting for artwork.
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  // The field list travels with the data: the settings module is server-only,
  // so the page can't import it directly.
  const settings = COMMERCIAL_SETTINGS.map(({ key, section, kind, optional, name, description }) => ({
    key,
    section,
    kind,
    optional: Boolean(optional),
    name,
    description,
  }));
  try {
    return { settings, ...(await loadCommercialSettings(admin)), loadError: null };
  } catch (error) {
    return { settings, currency: "USD", values: {}, loadError: error?.message || String(error) };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const values = Object.fromEntries(
    COMMERCIAL_SETTINGS.map((setting) => [setting.key, String(form.get(setting.key) ?? "")]),
  );
  try {
    return await saveCommercialSettings(admin, values);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
};

export default function CommercialSettings() {
  const { settings, currency, values, loadError } = useLoaderData();
  const fetcher = useFetcher();
  const [draft, setDraft] = useState(values);
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) shopify.toast.show("Commercial settings saved");
  }, [fetcher.state, fetcher.data]);

  const inSection = (section) => settings.filter((setting) => setting.section === section);
  const daysProps = (setting) => ({
    label: `${setting.name} (business days)`,
    min: 1,
    step: 1,
    inputMode: "numeric",
    ...(setting.optional ? { placeholder: "No deadline" } : {}),
  });

  const field = (setting, props) => (
    <s-number-field
      key={setting.key}
      details={setting.description}
      value={draft[setting.key] ?? ""}
      onInput={(event) =>
        setDraft((current) => ({
          ...current,
          [setting.key]: event?.currentTarget?.value ?? event?.target?.value ?? "",
        }))
      }
      {...props}
    />
  );

  const save = () => {
    const form = new FormData();
    for (const setting of settings) form.set(setting.key, draft[setting.key] ?? "");
    fetcher.submit(form, { method: "post" });
  };

  return (
    <s-page heading="Commercial Settings">
      <s-button slot="primary-action" variant="primary" onClick={save} loading={saving || undefined}>
        Save
      </s-button>

      {loadError ? (
        <s-banner tone="critical" heading="The settings could not be loaded">
          <s-paragraph>{loadError}</s-paragraph>
        </s-banner>
      ) : null}
      {fetcher.data && !fetcher.data.ok ? (
        <s-banner tone="critical" heading="Not saved">
          <s-paragraph>{fetcher.data.error}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Order thresholds">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Amounts are in {currency}. Buyers shopping in another currency see them converted at the
            rate set for their market. Changes apply to the cart and checkout straight away.
          </s-paragraph>
          {inSection("thresholds").map((setting) =>
            field(setting, { label: `${setting.name} (${currency})`, min: 0, step: 0.01, inputMode: "decimal" }),
          )}
        </s-stack>
      </s-section>

      <s-section heading="Production times">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Business days from Artwork Proof approval. The product page, cart and quote show these, and each
            order&apos;s production due date is counted from them. A change applies to proofs approved after it; to
            recount orders already in production, save any holiday on the Holidays page.
          </s-paragraph>
          {inSection("production").map((setting) => field(setting, daysProps(setting)))}
        </s-stack>
      </s-section>

      <s-section heading="Artwork deadline">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            For an order placed with artwork to follow. The buyer sees the date on the order while it waits for
            artwork. Blank shows no date.
          </s-paragraph>
          {inSection("artwork").map((setting) => field(setting, daysProps(setting)))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
