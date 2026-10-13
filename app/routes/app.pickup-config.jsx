import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  METAOBJECT_FIELDS_SCHEMA,
  loadPickupConfig,
  savePickupConfig,
  ensurePickupConfigDefinition
} from "../lib/pickup-config.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  // Debug: see if definition creation failed
  const ensureResult = await ensurePickupConfigDefinition(admin);
  
  const data = await loadPickupConfig(admin);

  return {
    metaobjectId: data.id,
    values: data.values,
    error: data.error || (ensureResult?.ok === false ? ensureResult.error : null),
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const values = {};
  for (const field of METAOBJECT_FIELDS_SCHEMA) {
    values[field.key] = form.get(field.key) || "";
  }

  const metaobjectId = form.get("metaobjectId");

  try {
    await savePickupConfig(admin, values, metaobjectId || undefined);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

export default function PickupConfig() {
  const { metaobjectId, values, error } = useLoaderData();

  const fetcher = useFetcher();
  const [draft, setDraft] = useState(values || {});
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Pickup configuration saved");
    }
  }, [fetcher.state, fetcher.data]);

  const handleChange = (key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleInput = (key) => (event) => {
    const target = event.target;
    handleChange(key, target.value ?? "");
  };

  const save = () => {
    const form = new FormData();
    if (metaobjectId) {
      form.set("metaobjectId", metaobjectId);
    }

    const keys = [
      "pickup_address",
      "contact_name",
      "contact_phone",
      "contact_email",
      "monday_hours",
      "tuesday_hours",
      "wednesday_hours",
      "thursday_hours",
      "friday_hours",
      "saturday_hours",
      "sunday_hours",
    ];

    for (const key of keys) {
      form.set(key, draft[key] || "");
    }
    fetcher.submit(form, { method: "post" });
  };

  return (
    <s-page heading="Pickup configuration" inlineSize="base">
      {error ? (
        <s-section>
          <s-banner tone="critical" heading="The settings could not be loaded">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {fetcher.data && !fetcher.data.ok ? (
        <s-section>
          <s-banner tone="critical" heading="Pickup configuration not saved">
            <s-paragraph>{fetcher.data.error}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {/* Overview / hero card */}
      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-paragraph tone="neutral" color="subdued">
            Configure how customers see and use this pickup location at checkout.
          </s-paragraph>
          <s-box
            padding="base"
            background="subdued"
            border="base"
            borderRadius="base"
          >
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-icon type="location" />
              <s-stack direction="block" gap="none">
                <s-text type="strong">Pickup location profile</s-text>
                <s-paragraph tone="neutral" color="subdued">
                  Keep contact details and opening hours accurate so staff can
                  prepare orders on time.
                </s-paragraph>
              </s-stack>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {/* Contact details */}
      <s-section heading="Contact details">
        <s-stack direction="block" gap="base">
          <s-paragraph tone="neutral" color="subdued">
            Information about the person managing this pickup location.
          </s-paragraph>

          <s-text-field
            label="Contact name"
            name="contact_name"
            value={draft["contact_name"] || ""}
            onInput={handleInput("contact_name")}
            required
          ></s-text-field>

          <s-text-field
            label="Contact phone"
            name="contact_phone"
            value={draft["contact_phone"] || ""}
            onInput={handleInput("contact_phone")}
          ></s-text-field>

          <s-text-field
            label="Contact email"
            type="email"
            name="contact_email"
            value={draft["contact_email"] || ""}
            onInput={handleInput("contact_email")}
          ></s-text-field>
        </s-stack>
      </s-section>

      {/* Address */}
      <s-section heading="Pickup address">
        <s-stack direction="block" gap="base">
          <s-paragraph tone="neutral" color="subdued">
            The full address where customers can pick up their orders.
          </s-paragraph>

          <s-text-area
            label="Pickup address"
            name="pickup_address"
            rows={4}
            placeholder="e.g. 123 Logistics Way, Suite 100, City, Country"
            value={draft["pickup_address"] || ""}
            onInput={handleInput("pickup_address")}
          ></s-text-area>
        </s-stack>
      </s-section>

      {/* Opening hours */}
      <s-section heading="Opening hours">
        <s-stack direction="block" gap="base">
          <s-paragraph tone="neutral" color="subdued">
            Daily operating hours for pickup. Example: &quot;9:00 am – 5:00 pm&quot; or
            &quot;Closed&quot;.
          </s-paragraph>

          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field
              label="Monday"
              name="monday_hours"
              value={draft["monday_hours"] || ""}
              onInput={handleInput("monday_hours")}
            ></s-text-field>
            <s-text-field
              label="Tuesday"
              name="tuesday_hours"
              value={draft["tuesday_hours"] || ""}
              onInput={handleInput("tuesday_hours")}
            ></s-text-field>
            <s-text-field
              label="Wednesday"
              name="wednesday_hours"
              value={draft["wednesday_hours"] || ""}
              onInput={handleInput("wednesday_hours")}
            ></s-text-field>
            <s-text-field
              label="Thursday"
              name="thursday_hours"
              value={draft["thursday_hours"] || ""}
              onInput={handleInput("thursday_hours")}
            ></s-text-field>
            <s-text-field
              label="Friday"
              name="friday_hours"
              value={draft["friday_hours"] || ""}
              onInput={handleInput("friday_hours")}
            ></s-text-field>
            <s-text-field
              label="Saturday"
              name="saturday_hours"
              value={draft["saturday_hours"] || ""}
              onInput={handleInput("saturday_hours")}
            ></s-text-field>
            <s-text-field
              label="Sunday"
              name="sunday_hours"
              value={draft["sunday_hours"] || ""}
              onInput={handleInput("sunday_hours")}
            ></s-text-field>
          </s-grid>
        </s-stack>
      </s-section>

      {/* Bottom action bar */}
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button
            variant="primary"
            onClick={save}
            loading={saving || undefined}
          >
            Save
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}