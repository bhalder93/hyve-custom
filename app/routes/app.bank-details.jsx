import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { loadBankDetailsConfig, saveBankDetailsConfig } from "../lib/bank-settings.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const data = await loadBankDetailsConfig(admin);
  return { accounts: data.accounts, error: null };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    const rawJson = String(form.get("accountsJson") || "").trim();
    if (!rawJson) throw new Error("No bank details received");
    const accounts = JSON.parse(rawJson);
    await saveBankDetailsConfig(admin, accounts);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
};

const ACCOUNT_META = {
  DBS_SGD: {
    title: "DBS Bank (SGD)",
    market: "Singapore (SG)",
    description: "Printed on Singapore quotation and invoice PDFs, and shown in the customer portal payment banner.",
    fields: [
      { key: "Bank Name", label: "Bank Name", placeholder: "DBS Bank Ltd" },
      { key: "Bank Address", label: "Bank Address", placeholder: "12 Marina Boulevard, MBFC Tower 3, Singapore" },
      { key: "SWIFT/BIC", label: "SWIFT / BIC", placeholder: "DBSSSGSG" },
      { key: "Account Name", label: "Account Name", placeholder: "Hyve Promo Pte Ltd" },
      { key: "Account Number", label: "Account Number", placeholder: "e.g. 8853796394" },
      { key: "Bank Code", label: "Bank Code", placeholder: "7171" },
      { key: "Branch Code", label: "Branch Code", placeholder: "072" },
    ],
  },
  CFSB_USD: {
    title: "Community Federal Savings Bank (USD)",
    market: "United States (US)",
    description: "Printed on United States quotes and invoices, and in the customer portal.",
    fields: [
      { key: "Bank Name", label: "Bank Name", placeholder: "Community Federal Savings Bank" },
      { key: "Bank Address", label: "Bank Address", placeholder: "89-16 Jamaica Ave, Woodhaven, NY, 11421" },
      { key: "SWIFT/BIC", label: "SWIFT / BIC", placeholder: "CMFGUS33" },
      { key: "Account Name", label: "Account Name", placeholder: "Hyve Promo Pte Ltd" },
      { key: "Account Number", label: "Account Number", placeholder: "e.g. 8489434183" },
      { key: "ACH Routing Number", label: "ACH Routing Number", placeholder: "026073150" },
      { key: "Fedwire Routing Number", label: "Fedwire Routing Number", placeholder: "026073008" },
    ],
  },
  DBS_USD: {
    title: "DBS Bank (USD)",
    market: "Other Launch Markets (AU, NZ, MY, PH, etc.)",
    description: "Printed on quotations, invoices, and portal for customers in other global launch markets.",
    fields: [
      { key: "Bank Name", label: "Bank Name", placeholder: "DBS Bank Ltd" },
      { key: "Bank Address", label: "Bank Address", placeholder: "Bank Address" },
      { key: "SWIFT/BIC", label: "SWIFT / BIC", placeholder: "SWIFT code" },
      { key: "Account Name", label: "Account Name", placeholder: "Hyve Promo Pte Ltd" },
      { key: "Account Number", label: "Account Number", placeholder: "Account Number" },
    ],
  },
  BANKING_CIRCLE: {
    title: "Banking Circle (EUR / SEPA)",
    market: "Europe (27 EU Member States)",
    description: "Printed on quotations, invoices, and portal for European customers.",
    fields: [
      { key: "Bank Name", label: "Bank Name", placeholder: "Banking Circle S.A." },
      { key: "Bank Address", label: "Bank Address", placeholder: "Bank Address" },
      { key: "SWIFT/BIC", label: "BIC / SWIFT", placeholder: "BIC code" },
      { key: "Account Name", label: "Account Name", placeholder: "Hyve Promo Pte Ltd" },
      { key: "IBAN", label: "IBAN / Account Number", placeholder: "IBAN" },
    ],
  },
};

export default function BankDetailsSettings() {
  const { accounts, error } = useLoaderData();
  const fetcher = useFetcher();
  const [draft, setDraft] = useState(accounts || {});
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Bank details saved successfully");
    }
  }, [fetcher.state, fetcher.data]);

  const getFieldValue = (accKey, fieldKey) => {
    const acc = draft[accKey];
    if (!acc || !Array.isArray(acc.rows)) return "";
    const pair = acc.rows.find(([k]) => k === fieldKey);
    return pair ? pair[1] : "";
  };

  const handleFieldChange = (accKey, fieldKey, val) => {
    setDraft((prev) => {
      const acc = prev[accKey] || { heading: ACCOUNT_META[accKey]?.title || "", rows: [] };
      const currentRows = Array.isArray(acc.rows) ? [...acc.rows] : [];
      const idx = currentRows.findIndex(([k]) => k === fieldKey);

      if (val.trim()) {
        if (idx >= 0) {
          currentRows[idx] = [fieldKey, val];
        } else {
          currentRows.push([fieldKey, val]);
        }
      } else {
        if (idx >= 0) {
          currentRows.splice(idx, 1);
        }
      }

      return {
        ...prev,
        [accKey]: {
          ...acc,
          rows: currentRows,
        },
      };
    });
  };

  const handleHeadingChange = (accKey, headingVal) => {
    setDraft((prev) => ({
      ...prev,
      [accKey]: {
        ...(prev[accKey] || { rows: [] }),
        heading: headingVal,
      },
    }));
  };

  const save = () => {
    const form = new FormData();
    form.set("accountsJson", JSON.stringify(draft));
    fetcher.submit(form, { method: "post" });
  };

  return (
    <s-page heading="Bank details">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        loading={saving || undefined}
      >
        Save
      </s-button>

      {/* Global errors */}
      {error ? (
        <s-section>
          <s-banner tone="critical" heading="We couldn’t load your bank details">
            <s-text>
              {error}
            </s-text>
          </s-banner>
        </s-section>
      ) : null}

      {fetcher.data && !fetcher.data.ok ? (
        <s-section>
          <s-banner tone="critical" heading="We couldn’t save your changes">
            <s-text>
              {fetcher.data.error}
            </s-text>
          </s-banner>
        </s-section>
      ) : null}

      {/* Overview */}
      <s-section heading="How bank details are used">
        <s-stack gap="base">
          <s-text appearance="subdued">
            Bank transfer details appear on quote and invoice PDFs, and in the
            customer portal. Updates here apply immediately to all future
            documents that match each market.
          </s-text>
          <s-text appearance="subdued">
            Keep the information clear and concise so customers can pay without
            needing to contact your team.
          </s-text>
        </s-stack>
      </s-section>

      {/* Accounts */}
      {Object.entries(ACCOUNT_META).map(([accKey, meta]) => {
        const acc = draft[accKey] || { heading: "", rows: [] };

        return (
          <s-section key={accKey} heading={meta.title}>
            <s-stack gap="base">
              <s-text appearance="subdued">
                {meta.market}
              </s-text>

              <s-text appearance="subdued">
                {meta.description}
              </s-text>

              <s-text-field
                label="Section heading on documents"
                value={acc.heading || ""}
                placeholder="For payment in Singapore dollars (SGD)"
                onInput={(e) =>
                  handleHeadingChange(accKey, e.target.value ?? "")
                }
              />

              <s-stack gap="small">
                {meta.fields.map((field) => (
                  <s-text-field
                    key={field.key}
                    label={field.label}
                    value={getFieldValue(accKey, field.key)}
                    placeholder={field.placeholder}
                    onInput={(e) =>
                      handleFieldChange(
                        accKey,
                        field.key,
                        e.target.value ?? "",
                      )
                    }
                  />
                ))}
              </s-stack>
            </s-stack>
          </s-section>
        );
      })}
    </s-page>
  );
}
