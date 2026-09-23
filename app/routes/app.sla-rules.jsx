import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const METAOBJECT_TYPE = "$app:sla_rule";


const DEFAULT_SLA_RULES = [
  {
    handle: "order-placed",
    status: "order-placed",
    nextStatus: "artwork-received",
    duration: 24,
    durationUnit: "HOURS",
    businessDays: false,
    alertRole: "CUSTOMER_SERVICE",
    templateCode: "MSG-10",
    enabled: true,
  },
  {
    handle: "artwork-received",
    status: "artwork-received",
    nextStatus: "proof-sent",
    duration: 48,
    durationUnit: "HOURS",
    businessDays: false,
    alertRole: "ARTWORK_COORDINATOR",
    templateCode: "MSG-11",
    enabled: true,
  },
  {
    handle: "proof-approved",
    status: "proof-approved",
    nextStatus: "in-production",
    duration: 24,
    durationUnit: "HOURS",
    businessDays: false,
    alertRole: "PRODUCTION",
    templateCode: "MSG-13",
    enabled: true,
  },
  {
    handle: "in-production",
    status: "in-production",
    nextStatus: "production-complete",
    duration: 7,
    durationUnit: "DAYS",
    businessDays: true,
    alertRole: "PRODUCTION",
    templateCode: "MSG-14",
    enabled: true,
  },
  {
    handle: "production-complete",
    status: "production-complete",
    nextStatus: "shipped",
    duration: 48,
    durationUnit: "HOURS",
    businessDays: false,
    alertRole: "PRODUCTION",
    templateCode: "MSG-15",
    enabled: true,
  },
];


function getGraphqlErrorMessage(result) {
  if (!Array.isArray(result?.errors)) {
    return null;
  }

  return result.errors
    .map((error) => error?.message)
    .filter(Boolean)
    .join(", ");
}

function getUserErrorMessage(userErrors) {
  if (!Array.isArray(userErrors) || userErrors.length === 0) {
    return null;
  }

  return userErrors
    .map((error) => {
      const field = Array.isArray(error.field) ? error.field.join(".") : "";

      return field ? `${field}: ${error.message}` : error.message;
    })
    .join(", ");
}


async function getSlaRules(admin) {
  const response = await admin.graphql(
    `#graphql
      query GetSlaRules {
        metaobjects(
          type: "$app:sla_rule"
          first: 100
        ) {
          nodes {
            id
            handle

            status: field(key: "status") {
              value
            }

            nextStatus: field(key: "next_status") {
              value
            }

            duration: field(key: "duration") {
              value
            }

            durationUnit: field(key: "duration_unit") {
              value
            }

            businessDays: field(key: "business_days") {
              value
            }

            alertRole: field(key: "alert_role") {
              value
            }

            templateCode: field(key: "template_code") {
              value
            }

            enabled: field(key: "enabled") {
              value
            }
          }
        }
      }
    `,
  );

  const result = await response.json();

  const graphqlError = getGraphqlErrorMessage(result);

  if (graphqlError) {
    throw new Error(graphqlError);
  }

  const nodes = result?.data?.metaobjects?.nodes ?? [];

  return nodes.map((node) => ({
    id: node.id,
    handle: node.handle,

    status: node.status?.value ?? "",

    nextStatus: node.nextStatus?.value ?? "",

    duration: Number(node.duration?.value ?? 0),

    durationUnit: node.durationUnit?.value ?? "HOURS",

    businessDays: node.businessDays?.value === "true",

    alertRole: node.alertRole?.value ?? "",

    templateCode: node.templateCode?.value ?? "",

    enabled: node.enabled?.value !== "false",
  }));
}


async function upsertSlaRule(admin, rule) {
  const response = await admin.graphql(
    `#graphql
      mutation UpsertSlaRule(
        $handle: MetaobjectHandleInput!
        $metaobject: MetaobjectUpsertInput!
      ) {
        metaobjectUpsert(
          handle: $handle
          metaobject: $metaobject
        ) {
          metaobject {
            id
            handle
          }

          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    {
      variables: {
        handle: {
          type: METAOBJECT_TYPE,
          handle: rule.handle,
        },

        metaobject: {
          fields: [
            {
              key: "status",
              value: rule.status,
            },
            {
              key: "next_status",
              value: rule.nextStatus,
            },
            {
              key: "duration",
              value: String(rule.duration),
            },
            {
              key: "duration_unit",
              value: rule.durationUnit,
            },
            {
              key: "business_days",
              value: String(rule.businessDays),
            },
            {
              key: "alert_role",
              value: rule.alertRole,
            },
            {
              key: "template_code",
              value: rule.templateCode,
            },
            {
              key: "enabled",
              value: String(rule.enabled),
            },
          ],
        },
      },
    },
  );

  const result = await response.json();

  const graphqlError = getGraphqlErrorMessage(result);

  if (graphqlError) {
    throw new Error(graphqlError);
  }

  const payload = result?.data?.metaobjectUpsert;

  if (!payload) {
    throw new Error("Shopify returned an empty metaobjectUpsert response.");
  }

  const userError = getUserErrorMessage(payload.userErrors);

  if (userError) {
    throw new Error(userError);
  }

  return payload.metaobject;
}

async function createDefaultSlaRules(admin) {
  const created = [];

  for (const rule of DEFAULT_SLA_RULES) {
    const metaobject = await upsertSlaRule(admin, rule);

    created.push(metaobject);
  }

  return created;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    let rules = await getSlaRules(admin);

    if (rules.length === 0) {
      console.log("No SLA rules found. Creating default SLA rules...");

      await createDefaultSlaRules(admin);

      rules = await getSlaRules(admin);

      console.log(`${rules.length} SLA rules initialized.`);
    }

    return {
      rules,
      error: null,
    };
  } catch (error) {
    console.error("SLA rules loader error:", error);

    return {
      rules: [],
      error:
        error instanceof Error ? error.message : "Unable to load SLA rules.",
    };
  }
};


function validateRule(rule) {
  const errors = {};

  if (!rule.status?.trim()) {
    errors.status = "Current status is required.";
  }

  if (!rule.nextStatus?.trim()) {
    errors.nextStatus = "Next status is required.";
  }

  const duration = Number(rule.duration);

  if (!Number.isInteger(duration) || duration <= 0) {
    errors.duration = "Duration must be a whole number greater than zero.";
  }

  if (!["HOURS", "DAYS"].includes(rule.durationUnit)) {
    errors.durationUnit = "Select a valid duration unit.";
  }

  if (!rule.alertRole?.trim()) {
    errors.alertRole = "Alert role is required.";
  }

  if (!rule.templateCode?.trim()) {
    errors.templateCode = "Template code is required.";
  }

  return errors;
}


export const action = async ({ request }) => {
  console.log("Action Reached.....");
  const { admin } = await authenticate.admin(request);

  try {
    // Parse the JSON payload instead of formData
    const data = await request.json();

    const intent = String(data.intent || "");

    if (intent !== "save") {
      return {
        success: false,
        error: "Unsupported action.",
      };
    }
    

    const rule = {
      handle: String(data.handle || "").trim(),
      status: String(data.status || "").trim(),
      nextStatus: String(data.nextStatus || "").trim(),
      duration: Number(data.duration),
      durationUnit: String(data.durationUnit || "").trim(),
      businessDays: Boolean(data.businessDays),
      alertRole: String(data.alertRole || "").trim(),
      templateCode: String(data.templateCode || "").trim(),
      enabled: Boolean(data.enabled),
    };

    if (!rule.handle) {
      return {
        success: false,
        error: "Rule handle is required.",
      };
    }

    const fieldErrors = validateRule(rule);

    if (Object.keys(fieldErrors).length > 0) {
      return {
        success: false,
        handle: rule.handle,
        fieldErrors,
        error: "Please correct the highlighted fields.",
      };
    }

    await upsertSlaRule(admin, rule);

    return {
      success: true,
      handle: rule.handle,
      message: "SLA rule updated successfully.",
    };
  } catch (error) {
    console.error("SLA rule action error:", error);

    return {
      success: false,
      error: error instanceof Error ? error.message : "Unable to update SLA rule.",
    };
  }
};


function formatLabel(value = "") {
  return value
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}


function RuleEditor({ rule, index, errors, saving, onChange, onSave }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" justifyContent="space-between">
          <s-heading>{formatLabel(rule.status)}</s-heading>

          <s-button
            variant="primary"
            disabled={saving}
            {...(saving ? { loading: true } : {})}
            onClick={() => onSave(rule)}
          >
            Save
          </s-button>
        </s-stack>

        <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="base">
          <s-text-field
            label="Current status"
            value={rule.status}
            disabled
            error={errors?.status}
          />

          <s-text-field
            label="Next status"
            value={rule.nextStatus}
            error={errors?.nextStatus}
            onInput={(event) =>
              onChange(index, "nextStatus", event.currentTarget.value)
            }
          />

          <s-number-field
            label="Duration"
            min={1}
            step={1}
            value={String(rule.duration ?? "")}
            error={errors?.duration}
            onInput={(event) => {
              const value = event.currentTarget.value;

              onChange(index, "duration", value === "" ? "" : Number(value));
            }}
          />

          <s-select
            label="Duration unit"
            value={rule.durationUnit}
            error={errors?.durationUnit}
            onChange={(event) =>
              onChange(index, "durationUnit", event.currentTarget.value)
            }
          >
            <s-option value="HOURS">Hours</s-option>

            <s-option value="DAYS">Days</s-option>
          </s-select>

          <s-select
            label="Alert role"
            value={rule.alertRole}
            error={errors?.alertRole}
            onChange={(event) =>
              onChange(index, "alertRole", event.currentTarget.value)
            }
          >
            <s-option value="">Select role</s-option>

            <s-option value="CUSTOMER_SERVICE">Customer Service</s-option>

            <s-option value="ARTWORK_COORDINATOR">Artwork Coordinator</s-option>

            <s-option value="PRODUCTION">Production</s-option>

            <s-option value="MANAGEMENT">Management</s-option>
          </s-select>

          <s-text-field
            label="Template code"
            value={rule.templateCode}
            error={errors?.templateCode}
            onInput={(event) =>
              onChange(index, "templateCode", event.currentTarget.value)
            }
          />
        </s-grid>

        <s-stack direction="inline" gap="base">
          <s-checkbox
            label="Enabled"
            checked={rule.enabled}
            onChange={(event) =>
              onChange(index, "enabled", event.currentTarget.checked)
            }
          />

          <s-checkbox
            label="Use business days"
            checked={rule.businessDays}
            onChange={(event) =>
              onChange(index, "businessDays", event.currentTarget.checked)
            }
          />
        </s-stack>

        <s-text tone="subdued">Handle: {rule.handle}</s-text>
      </s-stack>
    </s-box>
  );
}
export default function SlaRulesPage() {
  const loaderData = useLoaderData();

  const fetcher = useFetcher();

  const shopify = useAppBridge();

  const [rules, setRules] = useState(loaderData?.rules ?? []);

  const [clientErrors, setClientErrors] = useState({});

  const isSaving =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const submittingHandle = fetcher.formData?.get("handle");

  useEffect(() => {
    setRules(loaderData?.rules ?? []);
  }, [loaderData?.rules]);

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
    }
  }, [fetcher.data?.success, fetcher.data?.message, shopify]);

  function updateRule(index, key, value) {
    const handle = rules[index]?.handle;

    setRules((current) =>
      current.map((rule, i) =>
        i === index
          ? {
              ...rule,
              [key]: value,
            }
          : rule,
      ),
    );

    if (!handle) {
      return;
    }

    setClientErrors((current) => {
      const existing = current[handle];

      if (!existing?.[key]) {
        return current;
      }

      const updated = {
        ...existing,
      };

      delete updated[key];

      return {
        ...current,
        [handle]: updated,
      };
    });
  }

 function saveRule(rule) {
    if (isSaving) {
      return;
    }

    const errors = validateRule(rule);

    if (Object.keys(errors).length > 0) {
      setClientErrors((current) => ({
        ...current,
        [rule.handle]: errors,
      }));
      return;
    }

    setClientErrors((current) => ({
      ...current,
      [rule.handle]: {},
    }));

    fetcher.submit(
      {
        intent: "save",
        handle: rule.handle,
        status: rule.status,
        nextStatus: rule.nextStatus,
        duration: rule.duration, // Sent as a Number
        durationUnit: rule.durationUnit,
        businessDays: rule.businessDays, // Sent as a Boolean
        alertRole: rule.alertRole,
        templateCode: rule.templateCode,
        enabled: rule.enabled, // Sent as a Boolean
      },
      {
        method: "POST",
        encType: "application/json", // <--- Add this line
      },
    );
  }

  function getErrors(rule) {
    const client = clientErrors[rule.handle] ?? {};

    const server =
      fetcher.data?.success === false && fetcher.data?.handle === rule.handle
        ? (fetcher.data?.fieldErrors ?? {})
        : {};

    return {
      ...server,
      ...client,
    };
  }

  return (
    <s-page heading="SLA Rules">
      {loaderData?.error && (
        <s-banner tone="critical" heading="Unable to load SLA rules">
          <s-paragraph>{loaderData.error}</s-paragraph>
        </s-banner>
      )}

      {fetcher.data?.success === false && fetcher.data?.error && (
        <s-banner tone="critical" heading="Unable to save">
          <s-paragraph>{fetcher.data.error}</s-paragraph>
        </s-banner>
      )}

      {rules.length > 0 ? (
        <s-section heading="SLA configuration">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Configure production SLA timing, escalation roles and notification
              templates.
            </s-paragraph>

            {rules.map((rule, index) => (
              <RuleEditor
                key={rule.handle}
                rule={rule}
                index={index}
                errors={getErrors(rule)}
                saving={isSaving && submittingHandle === rule.handle}
                onChange={updateRule}
                onSave={saveRule}
              />
            ))}
          </s-stack>
        </s-section>
      ) : !loaderData?.error ? (
        <s-section>
          <s-paragraph>Loading SLA configuration...</s-paragraph>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
