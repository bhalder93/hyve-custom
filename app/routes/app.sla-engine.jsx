// app/routes/app.sla-engine.jsx

import { useEffect } from "react";

import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";

import { authenticate } from "../shopify.server";

// The same engine the 15-minute job runs, so a manual run sends the same
// alerts, with the same names and owners (HYV-127). This page used to carry
// its own copy, which had drifted (it didn't skip blank orders).
import { runSlaEngine } from "../utils/sla-engine.server";

export async function loader({ request }) {
  await authenticate.admin(request);
  return {
    rules: [
      {
        status: "Order Received",

        target: "24 hours",

        action: "Customer reminder if sending artwork later; in the Customer Service digest",
      },
      {
        status: "Artwork Received",

        target: "48 hours",

        action: "Alert Artwork Coordinator; in the Customer Service digest",
      },
      {
        status: "Proof Sent",

        target: "Day 2 / 5 / 10",

        action: "Customer reminders, then On Hold",
      },
      {
        status: "Proof Approved",

        target: "24 hours",

        action: "Alert Production",
      },
      {
        status: "In Production",

        target: "production_due_at",

        action: "Alert Production",
      },
      {
        status: "Production Complete",

        target: "48 hours",

        action: "Alert Production",
      },
      {
        status: "Shipped",

        target: "48 hours",

        action: "Not active yet: waits for the courier delivery-scan integration",
      },
    ],
  };
}


export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  try {
    const formData = await request.formData();

    const intent = String(formData.get("intent") || "");

    if (intent !== "run") {
      return {
        success: false,

        error: "Unsupported action.",
      };
    }

    const summary = await runSlaEngine(admin);

    return {
      success: true,

      summary,

      message: `SLA engine completed. ${summary.checked} orders checked.`,
    };
  } catch (error) {
    console.error("SLA engine error:", error);

    return {
      success: false,

      error:
        error instanceof Error ? error.message : "Unable to run SLA engine.",
    };
  }
}


export default function SlaEnginePage() {
  const loaderData = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const submit = useSubmit();

  const busy = navigation.state !== "idle";

  useEffect(() => {
    if (actionData?.success && actionData?.message) {
      shopify.toast.show(actionData.message);
    }
  }, [actionData]);

  function runEngine() {
    const formData = new FormData();

    formData.set("intent", "run");

    submit(formData, {
      method: "post",
    });
  }

  return (
    <s-page heading="SLA Engine" inlineSize="large">
      <s-button
        variant="primary"
        slot="primary-action"
        disabled={busy}
        onClick={runEngine}
      >
        {busy ? "Running SLA engine..." : "Run SLA engine"}
      </s-button>

      <s-stack direction="block" gap="base">
        <s-banner tone="info" heading="Release 1 SLA processor">
          <s-paragraph>
            This engine checks production orders against the Hyve SLA rules,
            sends proof reminders, sends internal alerts, writes breach tags and
            can place overdue proof orders On Hold.
          </s-paragraph>
        </s-banner>

        {actionData?.success === false && (
          <s-banner tone="critical" heading="SLA engine failed">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        )}

        {actionData?.summary && (
          <s-section heading="Last run">
            <s-grid gridTemplateColumns="repeat(5, 1fr)" gap="base">
              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">Checked</s-text>

                <s-heading>{actionData.summary.checked}</s-heading>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">Alerts</s-text>

                <s-heading>{actionData.summary.alertsSent}</s-heading>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">Reminders</s-text>

                <s-heading>{actionData.summary.remindersSent}</s-heading>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">On Hold</s-text>

                <s-heading>{actionData.summary.ordersOnHold}</s-heading>
              </s-box>

              <s-box padding="base" border="base" borderRadius="base">
                <s-text tone="subdued">Errors</s-text>

                <s-heading>{actionData.summary.errors.length}</s-heading>
              </s-box>
            </s-grid>
          </s-section>
        )}

        <s-section heading="SLA rules">
          <s-stack direction="block" gap="base">
            {loaderData.rules.map((rule, index) => (
              <s-box
                key={index}
                padding="base"
                border="base"
                borderRadius="base"
              >
                <s-grid gridTemplateColumns="1fr 1fr 2fr" gap="base">
                  <s-text>{rule.status}</s-text>

                  <s-text>{rule.target}</s-text>

                  <s-text tone="subdued">{rule.action}</s-text>
                </s-grid>
              </s-box>
            ))}
          </s-stack>
        </s-section>

        {/* <s-banner tone="warning" heading="Automatic execution still required">
          <s-paragraph>
            This page runs the engine manually. The document requires the
            scheduled workflow to run every 15 minutes. The next step is to
            expose the same engine through a protected scheduler endpoint or
            your hosting cron service.
          </s-paragraph>
        </s-banner> */}
      </s-stack>
    </s-page>
  );
}
