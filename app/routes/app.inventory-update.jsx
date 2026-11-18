import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getStoreLocations,
  planInventoryUpdate,
  applyInventoryUpdate,
} from "../lib/inventory-update.server.js";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  try {
    const locations = await getStoreLocations(admin);
    return { locations, error: null };
  } catch (err) {
    return { locations: [], error: err?.message || "Failed to load store locations." };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "apply");
  const csvText = String(form.get("csv") || "");
  const locationId = String(form.get("locationId") || "");

  if (!locationId) {
    return { ok: false, error: "Please select a store location from the dropdown." };
  }

  if (!csvText.trim()) {
    return { ok: false, error: "Please upload or provide a CSV file." };
  }

  try {
    if (intent === "preview") {
      return await planInventoryUpdate(admin, { csvText, locationId });
    }
    return await applyInventoryUpdate(admin, { csvText, locationId });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
};

export default function InventoryUpdatePage() {
  const { locations = [], error: loadError } = useLoaderData();
  const fetcher = useFetcher();

  const [selectedLocationId, setSelectedLocationId] = useState(locations[0]?.id || "");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [activeTab, setActiveTab] = useState("all");

  const busy = fetcher.state !== "idle";
  const intent = busy ? fetcher.formData?.get("intent") : null;
  const result = fetcher.data;

  const isApplied = result?.ok && result.summary?.updatedCount !== undefined;
  const isPlanned = result?.ok && result.summary?.skusFound !== undefined && !isApplied;

  const handleFilePick = (event) => {
    const file = event?.currentTarget?.files?.[0] || event?.target?.files?.[0];
    if (!file) return;
    setFileName(file.name);
    file.text().then((text) => {
      setCsvText(text);
      if (selectedLocationId) {
        fetcher.submit(
          { intent: "preview", csv: text, locationId: selectedLocationId },
          { method: "post" },
        );
      }
    });
  };

  const handleLocationChange = (event) => {
    const newLocId = event?.currentTarget?.value ?? event?.target?.value ?? "";
    setSelectedLocationId(newLocId);
    if (csvText && newLocId) {
      fetcher.submit(
        { intent: "preview", csv: csvText, locationId: newLocId },
        { method: "post" },
      );
    }
  };

  const handleApply = () => {
    if (!selectedLocationId || !csvText) return;
    fetcher.submit(
      { intent: "apply", csv: csvText, locationId: selectedLocationId },
      { method: "post" },
    );
  };

  const handleReset = () => {
    setCsvText("");
    setFileName("");
    setActiveTab("all");
  };

  // Table rows to display based on active tab
  let displayRows = [];
  if (isApplied) {
    const updatedRows = (result.updated || []).map((r) => ({ ...r, displayStatus: "updated" }));
    const notFoundRows = (result.notFound || []).map((r) => ({ ...r, displayStatus: "not_found" }));
    const errorRows = (result.errors || []).map((r) => ({ ...r, displayStatus: "error" }));

    if (activeTab === "updated") displayRows = updatedRows;
    else if (activeTab === "not_found") displayRows = notFoundRows;
    else if (activeTab === "errors") displayRows = errorRows;
    else displayRows = [...errorRows, ...notFoundRows, ...updatedRows];
  } else if (isPlanned) {
    const matchedRows = (result.matched || []).map((r) => ({ ...r, displayStatus: "matched" }));
    const notFoundRows = (result.notFound || []).map((r) => ({ ...r, displayStatus: "not_found" }));
    const invalidRows = (result.invalid || []).map((r) => ({ ...r, displayStatus: "error" }));

    if (activeTab === "matched") displayRows = matchedRows;
    else if (activeTab === "not_found") displayRows = notFoundRows;
    else if (activeTab === "errors") displayRows = invalidRows;
    else displayRows = [...invalidRows, ...notFoundRows, ...matchedRows];
  }

  return (
    <s-page heading="Inventory Update">
      {loadError && (
        <s-banner tone="critical" heading="Could not load locations">
          <s-paragraph>{loadError}</s-paragraph>
        </s-banner>
      )}

      {/* Upload and Configuration Section */}
      <s-section heading="Upload Inventory On Hand CSV">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload a CSV file with <s-text type="strong">SKU</s-text> and{" "}
            <s-text type="strong">On Hand</s-text> columns to update on-hand inventory quantities
            for the selected store location in Shopify.
          </s-paragraph>

          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-box>
              <s-stack direction="block" gap="small-200">
                <s-select
                  label="Store Location"
                  value={selectedLocationId}
                  disabled={busy ? true : undefined}
                  onChange={handleLocationChange}
                >
                  <s-option value="">-- Select Store Location --</s-option>
                  {locations.map((loc) => (
                    <s-option key={loc.id} value={loc.id}>
                      {loc.name}
                    </s-option>
                  ))}
                </s-select>
                <s-text color="subdued">
                  Inventory counts will be set at this specific location.
                </s-text>
              </s-stack>
            </s-box>

            <s-box>
              <s-stack direction="block" gap="small-200">
                <s-drop-zone
                  label="Inventory CSV File"
                  accept=".csv,text/csv"
                  disabled={busy ? true : undefined}
                  onChange={handleFilePick}
                />
                {fileName ? (
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-badge tone="success">Selected</s-badge>
                    <s-text type="strong">{fileName}</s-text>
                  </s-stack>
                ) : (
                  <s-text color="subdued">
                    Click or drag a CSV file with &quot;SKU&quot; and &quot;On Hand&quot; columns.
                  </s-text>
                )}
              </s-stack>
            </s-box>
          </s-grid>

          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-text type="strong">Expected CSV format:</s-text>
                <s-badge tone="neutral">SKU</s-badge>
                <s-badge tone="neutral">On Hand</s-badge>
                <s-text color="subdued">(e.g. 29223BLK, &quot;3,982&quot;)</s-text>
              </s-stack>
              <s-text color="subdued">
                Supports whole numbers formatted with commas (e.g. 3,982), negative counts, and
                flexible headers (sku, on_hand, quantity).
              </s-text>
            </s-stack>
          </s-box>

          <s-stack direction="inline" gap="small">
            <s-button
              variant="primary"
              disabled={busy || !csvText || !selectedLocationId ? true : undefined}
              loading={busy && intent === "apply" ? true : undefined}
              onClick={handleApply}
            >
              Update Inventory
            </s-button>
            {csvText && (
              <s-button disabled={busy ? true : undefined} onClick={handleReset}>
                Reset
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {/* Loading & Processing Section with ProgressBar */}
      {busy && (
        <s-section>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-spinner size="base" accessibilityLabel="Processing" />
              <s-text type="strong">
                {intent === "apply"
                  ? "Updating Shopify inventory..."
                  : "Checking CSV and verifying SKUs..."}
              </s-text>
            </s-stack>
            <s-progress tone="info" accessibilityLabel="Operation in progress" />
            <s-paragraph>
              {intent === "apply"
                ? "Setting on-hand quantities for each variant in Shopify. Please keep this tab open..."
                : "Reading file rows, verifying numbers, and querying store inventory levels..."}
            </s-paragraph>
          </s-stack>
        </s-section>
      )}

      {/* Error banner */}
      {result && !result.ok && (
        <s-banner tone="critical" heading="Inventory update could not proceed">
          <s-paragraph>{result.error}</s-paragraph>
        </s-banner>
      )}

      {/* Applied / Execution Result Banner, ProgressBar, & Metrics */}
      {isApplied && (
        <s-section heading="Execution Results">
          <s-stack direction="block" gap="base">
            <s-banner
              tone={result.summary.errorCount > 0 ? "warning" : "success"}
              heading={
                result.summary.errorCount > 0
                  ? `Completed with warnings: ${result.summary.updatedCount} of ${result.summary.totalRows} SKUs updated`
                  : `Success: ${result.summary.updatedCount} SKUs updated at ${result.location?.name}`
              }
            >
              <s-paragraph>
                Inventory updated at <s-text type="strong">{result.location?.name}</s-text>.{" "}
                {result.summary.skusFound} SKUs matched in Shopify, {result.summary.updatedCount}{" "}
                updated successfully, {result.summary.skusNotFound} not found, and{" "}
                {result.summary.errorCount} errors.
              </s-paragraph>
            </s-banner>

            {/* Execution Progress Bar */}
            <s-box padding="base" border="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text type="strong">Update Progress:</s-text>
                  <s-text color="subdued">
                    {result.summary.updatedCount} of {result.summary.totalRows} items updated (
                    {Math.round(
                      ((result.summary.updatedCount || 0) / (result.summary.totalRows || 1)) * 100,
                    )}
                    %)
                  </s-text>
                </s-stack>
                <s-progress
                  max={result.summary.totalRows || 1}
                  value={result.summary.updatedCount || 0}
                  tone={result.summary.errorCount > 0 ? "warning" : "success"}
                  accessibilityLabel="Inventory update completion progress"
                />
              </s-stack>
            </s-box>

            {/* Metric Summary Cards */}
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
              <s-box padding="base" border="base" borderRadius="base" background="subdued">
                <s-stack direction="block" gap="small-200">
                  <s-text color="subdued">TOTAL ROWS</s-text>
                  <s-heading>{result.summary.totalRows}</s-heading>
                </s-stack>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base" background="subdued">
                <s-stack direction="block" gap="small-200">
                  <s-text tone="success" fontWeight="bold">
                    SKUS FOUND
                  </s-text>
                  <s-heading>{result.summary.skusFound}</s-heading>
                </s-stack>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base" background="subdued">
                <s-stack direction="block" gap="small-200">
                  <s-text tone="success" fontWeight="bold">
                    UPDATED
                  </s-text>
                  <s-heading>{result.summary.updatedCount}</s-heading>
                </s-stack>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base" background="subdued">
                <s-stack direction="block" gap="small-200">
                  <s-text tone="warning" fontWeight="bold">
                    NOT FOUND
                  </s-text>
                  <s-heading>{result.summary.skusNotFound}</s-heading>
                </s-stack>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base" background="subdued">
                <s-stack direction="block" gap="small-200">
                  <s-text
                    tone={result.summary.errorCount > 0 ? "critical" : "subdued"}
                    fontWeight="bold"
                  >
                    ERRORS
                  </s-text>
                  <s-heading>{result.summary.errorCount}</s-heading>
                </s-stack>
              </s-box>
            </s-grid>

            {/* Filter Buttons */}
            <s-button-group gap="small">
              <s-button
                variant={activeTab === "all" ? "primary" : "secondary"}
                onClick={() => setActiveTab("all")}
              >
                All ({result.summary.totalRows})
              </s-button>
              <s-button
                variant={activeTab === "updated" ? "primary" : "secondary"}
                onClick={() => setActiveTab("updated")}
              >
                Updated ({result.summary.updatedCount})
              </s-button>
              <s-button
                variant={activeTab === "not_found" ? "primary" : "secondary"}
                onClick={() => setActiveTab("not_found")}
              >
                Not Found ({result.summary.skusNotFound})
              </s-button>
              {result.summary.errorCount > 0 && (
                <s-button
                  tone="critical"
                  variant={activeTab === "errors" ? "primary" : "secondary"}
                  onClick={() => setActiveTab("errors")}
                >
                  Errors ({result.summary.errorCount})
                </s-button>
              )}
            </s-button-group>

            {/* Results Table */}
            <s-table>
              <s-table-header-row>
                <s-table-header>Line</s-table-header>
                <s-table-header listSlot="primary">SKU</s-table-header>
                <s-table-header>Product / Variant</s-table-header>
                <s-table-header format="numeric">On Hand</s-table-header>
                <s-table-header listSlot="labeled">Result</s-table-header>
                <s-table-header>Details</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {displayRows.map((row, i) => (
                  <s-table-row key={i}>
                    <s-table-cell>{row.line || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-text type="strong">{row.sku}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {row.productTitle
                        ? `${row.productTitle}${row.variantTitle ? ` (${row.variantTitle})` : ""}`
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>{row.onHand !== undefined ? row.onHand : "—"}</s-table-cell>
                    <s-table-cell>
                      {row.displayStatus === "updated" ? (
                        <s-badge tone="success">Updated</s-badge>
                      ) : row.displayStatus === "not_found" ? (
                        <s-badge tone="warning">Not Found</s-badge>
                      ) : (
                        <s-badge tone="critical">Error</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-text tone={row.displayStatus === "updated" ? "success" : "neutral"}>
                        {row.displayStatus === "updated"
                          ? `On hand set to ${row.onHand}`
                          : row.reason || row.error || "—"}
                      </s-text>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        </s-section>
      )}

      {/* Planned / Preview State before Execution */}
      {isPlanned && !isApplied && (
        <s-section heading="Preview: Pending Inventory Changes">
          <s-stack direction="block" gap="base">
            <s-banner
              tone="info"
              heading={`Found ${result.summary.skusFound} of ${result.summary.totalRows} SKUs`}
            >
              <s-paragraph>
                Target Location: <s-text type="strong">{result.location?.name}</s-text>. Ready to set
                on-hand inventory. Click <s-text type="strong">&quot;Update Inventory&quot;</s-text>{" "}
                above to execute.
              </s-paragraph>
            </s-banner>

            {/* Preview Match Progress Bar */}
            <s-box padding="base" border="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text type="strong">Match Progress:</s-text>
                  <s-text color="subdued">
                    {result.summary.skusFound} of {result.summary.totalRows} SKUs matched in store (
                    {Math.round(
                      ((result.summary.skusFound || 0) / (result.summary.totalRows || 1)) * 100,
                    )}
                    %)
                  </s-text>
                </s-stack>
                <s-progress
                  max={result.summary.totalRows || 1}
                  value={result.summary.skusFound || 0}
                  tone={result.summary.skusNotFound > 0 ? "info" : "success"}
                  accessibilityLabel="SKU matching progress"
                />
              </s-stack>
            </s-box>

            <s-table>
              <s-table-header-row>
                <s-table-header>Line</s-table-header>
                <s-table-header listSlot="primary">SKU</s-table-header>
                <s-table-header>Product</s-table-header>
                <s-table-header format="numeric">New On Hand</s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {displayRows.map((row, i) => (
                  <s-table-row key={i}>
                    <s-table-cell>{row.line}</s-table-cell>
                    <s-table-cell>
                      <s-text type="strong">{row.sku}</s-text>
                    </s-table-cell>
                    <s-table-cell>{row.productTitle || "—"}</s-table-cell>
                    <s-table-cell>{row.onHand !== undefined ? row.onHand : "—"}</s-table-cell>
                    <s-table-cell>
                      {row.displayStatus === "matched" ? (
                        <s-badge tone="info">Ready to update</s-badge>
                      ) : row.displayStatus === "not_found" ? (
                        <s-badge tone="warning">SKU not in store</s-badge>
                      ) : (
                        <s-badge tone="critical">Invalid</s-badge>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
