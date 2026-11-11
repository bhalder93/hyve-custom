import { useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { applyWeights, planWeights, readExport } from "../lib/shipping-weights.server";

/**
 * Shipping Weights (Michael, Nov 7). Staff upload the price tool's packing
 * export, check what would change, then apply it. See shipping-weights.server.js.
 */

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const parsed = readExport(String(form.get("csv") || ""));
  if (parsed.error) return { ok: false, error: parsed.error };
  if (!parsed.rows.length) return { ok: false, error: "The file has a header but no products." };
  try {
    if (intent === "apply") return { ok: true, applied: await applyWeights(admin, parsed.rows) };
    return { ok: true, plan: await planWeights(admin, parsed.rows) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
};

const STATUS = {
  change: { tone: "warning", label: "Will change" },
  same: { tone: "success", label: "Already matches" },
  skip: { tone: "critical", label: "Skipped" },
};

export default function ShippingWeights() {
  const fetcher = useFetcher();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const busy = fetcher.state !== "idle";
  const intent = busy ? fetcher.formData?.get("intent") : null;
  const result = fetcher.data;
  const plan = result?.ok ? result.plan : null;
  const applied = result?.ok ? result.applied : null;

  const pick = (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setFileName(file.name);
    file.text().then((text) => {
      setCsv(text);
      fetcher.submit({ intent: "preview", csv: text }, { method: "post" });
    });
  };

  return (
    <s-page heading="Shipping Weights">
      <s-section heading="Upload the price tool's packing export">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            On price.hyve.promo, go to Export cartons, then Export packing details, and upload that CSV here as it is.
            Each product in it gets the tool&apos;s &quot;Shopify weight (g)&quot; on all its variants. UPS rates at
            checkout are worked out from this weight times the quantity.
          </s-paragraph>
          <s-paragraph>
            Products are found by the tool&apos;s Shopify handle. If a variant&apos;s SKU doesn&apos;t start with the
            item number, or two rows point at the same product, that product is skipped. Nothing changes until you
            click Apply weights.
          </s-paragraph>
          <input type="file" accept=".csv,text/csv" onChange={pick} disabled={busy || undefined} />
          {fileName ? <s-text color="subdued">{fileName}</s-text> : null}
        </s-stack>
      </s-section>

      {busy ? (
        <s-banner tone="info" heading={intent === "apply" ? "Applying weights" : "Checking the file"}>
          <s-paragraph>This takes a few seconds.</s-paragraph>
        </s-banner>
      ) : null}

      {result && !result.ok ? (
        <s-banner tone="critical" heading="The file couldn't be used">
          <s-paragraph>{result.error}</s-paragraph>
        </s-banner>
      ) : null}

      {applied ? (
        <s-banner
          tone={applied.errors.length ? "warning" : "success"}
          heading={`${applied.updated.length} products updated`}
        >
          {applied.errors.map((error, index) => (
            <s-paragraph key={index}>{error}</s-paragraph>
          ))}
          <s-paragraph>
            {applied.counts.same} already matched and {applied.counts.skip} were skipped. Upload the file again to
            check.
          </s-paragraph>
        </s-banner>
      ) : null}

      {plan ? (
        <s-section heading="What would change" padding="none">
          <s-box padding="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-text>
                {plan.counts.change} to change, {plan.counts.same} already match, {plan.counts.skip} skipped.
              </s-text>
              <s-button
                variant="primary"
                disabled={!plan.counts.change || busy || undefined}
                loading={intent === "apply" || undefined}
                onClick={() => fetcher.submit({ intent: "apply", csv }, { method: "post" })}
              >
                Apply weights
              </s-button>
            </s-stack>
          </s-box>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Item</s-table-header>
              <s-table-header format="numeric">Now (g)</s-table-header>
              <s-table-header format="numeric">From the tool (g)</s-table-header>
              <s-table-header listSlot="labeled">Result</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {plan.rows.map((row) => (
                <s-table-row key={row.line}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-100">
                      <s-text>{row.name || row.handle}</s-text>
                      {row.reason ? <s-text color="subdued">{row.reason}</s-text> : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{row.item}</s-table-cell>
                  <s-table-cell>{row.current.length ? row.current.join(" / ") : "—"}</s-table-cell>
                  <s-table-cell>{row.next ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}
    </s-page>
  );
}
