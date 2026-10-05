import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import {
  describeAdjustment,
  isRunning,
  isTierCatalog,
  ladderSummary,
  listCompanyCatalogs,
  loadLastRun,
  startInBackground,
} from "../lib/tier-prices.server";

/**
 * Tier Prices (HYV-80). Writes each tier catalog's fixed prices and volume
 * breaks from the products' break ladders, less the catalog's percentage, so
 * the tiers keep the B2B breaks and still follow their discount. Runs daily
 * from Shopify Flow (/api/tier-prices) and on demand here. Either way the
 * update runs in the background and the page shows the last run.
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  try {
    const [catalogs, ladders, lastRun] = await Promise.all([
      listCompanyCatalogs(admin),
      ladderSummary(admin),
      loadLastRun(admin),
    ]);
    return {
      catalogs: catalogs.map((catalog) => ({
        ...catalog,
        discount: describeAdjustment(catalog.adjustment),
        isTier: isTierCatalog(catalog),
      })),
      ladders,
      lastRun,
      running: isRunning(),
      loadError: null,
    };
  } catch (error) {
    return { catalogs: [], ladders: null, lastRun: null, running: isRunning(), loadError: error?.message || String(error) };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const catalogIds = form.getAll("catalogId").map(String);
  if (!catalogIds.length) return { ok: false, error: "Choose at least one catalog." };
  return startInBackground(admin, { catalogIds, trigger: "manual" })
    ? { ok: true }
    : { ok: false, error: "A tier price update is already running. Wait for it to finish." };
};

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");

export default function TierPrices() {
  const { catalogs, ladders, lastRun, running: serverRunning, loadError } = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [selected, setSelected] = useState(() => new Set(catalogs.filter((c) => c.isTier).map((c) => c.id)));
  const outcome = fetcher.data;
  const running = serverRunning || fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && outcome?.ok) {
      shopify.toast.show("Tier price update started");
      revalidator.revalidate();
    }
    // The revalidator object changes every render; only a finished submit matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, outcome]);

  // While a run is going, check back every 10 seconds until it has finished.
  useEffect(() => {
    if (!serverRunning) return undefined;
    const timer = setInterval(() => revalidator.revalidate(), 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRunning]);

  const toggle = (id) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = () => {
    const form = new FormData();
    for (const id of selected) form.append("catalogId", id);
    fetcher.submit(form, { method: "post" });
  };

  return (
    <s-page heading="Tier Prices">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={run}
        loading={running || undefined}
        disabled={!selected.size || running || undefined}
      >
        Update tier prices
      </s-button>

      {loadError ? (
        <s-banner tone="critical" heading="The catalogs could not be loaded">
          <s-paragraph>{loadError}</s-paragraph>
        </s-banner>
      ) : null}
      {outcome && !outcome.ok ? (
        <s-banner tone="critical" heading="Tier prices were not updated">
          <s-paragraph>{outcome.error}</s-paragraph>
        </s-banner>
      ) : null}
      {serverRunning ? (
        <s-banner tone="info" heading="Updating tier prices">
          <s-paragraph>This takes a minute or two. The page updates when it&apos;s done.</s-paragraph>
        </s-banner>
      ) : null}

      {lastRun ? (
        <s-section heading="Last update">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {lastRun.trigger === "daily" ? "Daily run" : "Run from this page"}, finished {when(lastRun.finishedAt)}.
            </s-paragraph>
            {!lastRun.ok ? <s-text tone="critical">{lastRun.error}</s-text> : null}
            {(lastRun.results || []).map((result) => (
              <s-stack key={result.catalogId} direction="block" gap="small-200">
                <s-heading>
                  {result.title} ({result.adjustment})
                </s-heading>
                <s-paragraph>
                  {result.laddered} products priced from their ladder, {result.fullPrice} kept at their normal price,{" "}
                  {result.cleared} given the catalog percentage.
                </s-paragraph>
                {result.errors.map((error, index) => (
                  <s-text key={index} tone="critical">
                    {error.product ? `${error.product}: ` : ""}
                    {error.message}
                  </s-text>
                ))}
              </s-stack>
            ))}
            {lastRun.ladderErrors?.length ? (
              <s-banner tone="warning" heading="Ladders that couldn't be used">
                {lastRun.ladderErrors.map((error, index) => (
                  <s-paragraph key={index}>
                    {error.product}: {error.message}
                  </s-paragraph>
                ))}
              </s-banner>
            ) : null}
          </s-stack>
        </s-section>
      ) : null}

      <s-section heading="How it works">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            Each ticked catalog gets its fixed prices and volume breaks from the product&apos;s break ladder (the
            Blank pricing metafield), less the catalog&apos;s percentage. Setup, rush, gift packaging and import
            duties stay at their normal price. A product without a ladder has its fixed prices removed, so the
            catalog percentage applies to it.
          </s-paragraph>
          <s-paragraph>
            It runs every day on its own, for every catalog that takes a percentage off. Run it here straight
            after changing a tier&apos;s percentage or a product&apos;s ladder. Distributors see the new prices as
            soon as it finishes.
          </s-paragraph>
          {ladders ? (
            <s-paragraph>
              {ladders.withLadder} of {ladders.products} products have a break ladder.
            </s-paragraph>
          ) : null}
          {ladders?.invalid?.length ? (
            <s-banner tone="warning" heading={`${ladders.invalid.length} ladders can't be used`}>
              {ladders.invalid.slice(0, 20).map((error, index) => (
                <s-paragraph key={index}>
                  {error.product}: {error.message}
                </s-paragraph>
              ))}
            </s-banner>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Catalogs" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Catalog</s-table-header>
            <s-table-header>Discount</s-table-header>
            <s-table-header>Currency</s-table-header>
            <s-table-header format="numeric">Company locations</s-table-header>
            <s-table-header listSlot="labeled">Status</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {catalogs.map((catalog) => (
              <s-table-row key={catalog.id}>
                <s-table-cell>
                  <s-checkbox
                    label={catalog.title}
                    checked={selected.has(catalog.id) || undefined}
                    disabled={!catalog.priceListId || running || undefined}
                    onChange={() => toggle(catalog.id)}
                  />
                </s-table-cell>
                <s-table-cell>{catalog.discount}</s-table-cell>
                <s-table-cell>{catalog.currency || "No price list"}</s-table-cell>
                <s-table-cell>{catalog.companyLocations}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={catalog.status === "ACTIVE" ? "success" : "neutral"}>
                    {catalog.status === "ACTIVE" ? "Active" : catalog.status}
                  </s-badge>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}
