import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  LADDER_KEY,
  LADDER_NAMESPACE,
  fillLadders,
  ladderSummary,
  listCompanyCatalogs,
  loadLadderDefinition,
} from "../lib/tier-prices.server";

/**
 * One-off, not in the menu (HYV-80): copies each product's B2B break ladder
 * from a catalog's fixed prices and volume breaks (Test B2B Catalog) into the
 * product's `hyve.blank_pricing` metafield, which Tier Prices then works from.
 * Preview first; Fill writes.
 */
const SOURCE_TITLE = "Test B2B Catalog";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  // The page can't import the server module, so the metafield's name travels with the data.
  const field = `${LADDER_NAMESPACE}.${LADDER_KEY}`;
  try {
    const [definition, catalogs, ladders] = await Promise.all([
      loadLadderDefinition(admin),
      listCompanyCatalogs(admin),
      ladderSummary(admin),
    ]);
    const priced = catalogs.filter((catalog) => catalog.priceListId);
    const source = priced.find((catalog) => catalog.title === SOURCE_TITLE) || priced[0] || null;
    return { field, definition, catalogs: priced, defaultSource: source?.id || "", ladders, loadError: null };
  } catch (error) {
    return { field, definition: null, catalogs: [], defaultSource: "", ladders: null, loadError: error?.message || String(error) };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    return {
      ok: true,
      ...(await fillLadders(admin, {
        sourceCatalogId: String(form.get("sourceCatalogId") || ""),
        overwrite: form.get("overwrite") === "true",
        dryRun: form.get("intent") !== "fill",
      })),
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
};

export default function BlankPricing() {
  const { field, definition, catalogs, defaultSource, ladders, loadError } = useLoaderData();
  const fetcher = useFetcher();
  const [sourceId, setSourceId] = useState(defaultSource);
  const [overwrite, setOverwrite] = useState(false);
  // Fill stays off until a preview has run with the same choices.
  const [sent, setSent] = useState("");
  const [previewed, setPreviewed] = useState("");
  const running = fetcher.state !== "idle";
  const outcome = fetcher.data;
  const choices = `${sourceId}|${overwrite}`;
  const definitionReady = definition?.type === "json";

  useEffect(() => {
    if (fetcher.state !== "idle" || !outcome?.ok) return;
    if (outcome.dryRun) setPreviewed(sent);
    else shopify.toast.show(`Filled ${outcome.filled} products`);
  }, [fetcher.state, outcome, sent]);

  const submit = (intent) => {
    setSent(choices);
    const form = new FormData();
    form.set("intent", intent);
    form.set("sourceCatalogId", sourceId);
    form.set("overwrite", String(overwrite));
    fetcher.submit(form, { method: "post" });
  };

  return (
    <s-page heading="Fill blank pricing">
      {loadError ? (
        <s-banner tone="critical" heading="This page could not be loaded">
          <s-paragraph>{loadError}</s-paragraph>
        </s-banner>
      ) : null}
      {!loadError && !definitionReady ? (
        <s-banner tone="critical" heading="The metafield isn't ready">
          <s-paragraph>
            {definition
              ? `${field} is a ${definition.type} metafield. Change it to JSON first.`
              : `There is no ${field} product metafield. Create it as JSON first.`}
          </s-paragraph>
        </s-banner>
      ) : null}
      {outcome && !outcome.ok ? (
        <s-banner tone="critical" heading="Nothing was written">
          <s-paragraph>{outcome.error}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Source">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Copies each product&apos;s fixed price and volume breaks from the catalog below into its Blank pricing
            metafield, as the product&apos;s break ladder. Tier Prices works from that ladder. Setup, rush and import
            duties are left out.
          </s-paragraph>
          {ladders ? (
            <s-paragraph>
              {ladders.withLadder} of {ladders.products} products have a ladder now.
            </s-paragraph>
          ) : null}
          <s-select
            label="Catalog to copy from"
            value={sourceId}
            onChange={(event) => setSourceId(event?.currentTarget?.value ?? event?.target?.value ?? "")}
          >
            {catalogs.map((catalog) => (
              <s-option key={catalog.id} value={catalog.id}>
                {catalog.title}
              </s-option>
            ))}
          </s-select>
          <s-checkbox
            label="Replace ladders that are already filled"
            checked={overwrite || undefined}
            onChange={() => setOverwrite((value) => !value)}
          />
          <s-stack direction="inline" gap="base">
            <s-button
              onClick={() => submit("preview")}
              loading={running || undefined}
              disabled={!sourceId || !definitionReady || running || undefined}
            >
              Preview
            </s-button>
            <s-button
              variant="primary"
              onClick={() => submit("fill")}
              disabled={previewed !== choices || !definitionReady || running || undefined}
            >
              Fill blank pricing
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      {outcome?.ok ? (
        <s-section heading={outcome.dryRun ? "Preview" : "Filled"}>
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {outcome.source} ({outcome.currency}) has fixed prices on {outcome.found} products.{" "}
              {outcome.dryRun ? "Would fill" : "Filled"} {outcome.filled}. Already filled and left alone:{" "}
              {outcome.skipped}. Setup, rush and duties left out: {outcome.skippedUtility}.
            </s-paragraph>
            {outcome.errors.map((error, index) => (
              <s-text key={index} tone="critical">
                {error.product ? `${error.product}: ` : ""}
                {error.message}
              </s-text>
            ))}
            {outcome.samples.map((sample) => (
              <s-box key={sample.title} padding="base" background="subdued" borderRadius="base">
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{sample.title}</s-text>
                  <s-text>{JSON.stringify(sample.ladder)}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      ) : null}
    </s-page>
  );
}
