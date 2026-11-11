import test from "node:test";
import assert from "node:assert/strict";
import { mapCustomerSettings, settingsPage } from "../app/lib/account-settings.server.js";
import {
  getCustomerForwarderSettings,
  copyFobForwarderMetafieldsToOrder,
} from "../app/lib/order-fob-shipping.server.js";

test("mapCustomerSettings extracts forwarder fields with fallbacks", () => {
  // Case 1: from customer metafield objects
  const settings1 = mapCustomerSettings({
    firstName: "Alice",
    lastName: "Wong",
    forwarderNameMetafield: { value: "Kuehne+Nagel" },
    forwarderAccountMetafield: { value: "KN-12345" },
  });
  assert.equal(settings1.forwarderName, "Kuehne+Nagel");
  assert.equal(settings1.forwarderAccount, "KN-12345");

  // Case 2: from company fallback
  const settings2 = mapCustomerSettings({
    firstName: "Bob",
    companyContactProfiles: [
      {
        company: {
          forwarderName: { value: "DB Schenker" },
          forwarderAccount: { value: "DBS-999" },
        },
      },
    ],
  });
  assert.equal(settings2.forwarderName, "DB Schenker");
  assert.equal(settings2.forwarderAccount, "DBS-999");

  // Case 3: missing -> empty strings
  const settings3 = mapCustomerSettings({});
  assert.equal(settings3.forwarderName, "");
  assert.equal(settings3.forwarderAccount, "");
});

test("settingsPage renders Freight Forwarder and Forwarder Account Number fields", () => {
  const html = settingsPage({
    settings: {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "+6591234567",
      forwarderName: "DHL Global Forwarding",
      forwarderAccount: "DHL-8888",
    },
  });

  assert.match(html, /Freight Forwarder \(FOB Ningbo\)/);
  assert.match(html, /name="forwarderName"/);
  assert.match(html, /value="DHL Global Forwarding"/);

  assert.match(html, /Forwarder Account Number \(FOB Ningbo\)/);
  assert.match(html, /name="forwarderAccount"/);
  assert.match(html, /value="DHL-8888"/);
});

test("getCustomerForwarderSettings queries customer and company metafields", async () => {
  let capturedQuery = "";
  let capturedVars = null;

  const admin = {
    graphql: async (query, { variables }) => {
      capturedQuery = query;
      capturedVars = variables;
      return {
        json: async () => ({
          data: {
            customer: {
              customForwarderName: { value: "Expeditors" },
              customForwarderAccount: { value: "EXP-555" },
              companyContactProfiles: [],
            },
          },
        }),
      };
    },
  };

  const result = await getCustomerForwarderSettings(admin, "12345678");
  assert.equal(result.forwarderName, "Expeditors");
  assert.equal(result.forwarderAccount, "EXP-555");
  assert.equal(capturedVars.id, "gid://shopify/Customer/12345678");
  assert.match(capturedQuery, /CustomerForwarderMetafields/);
});

test("copyFobForwarderMetafieldsToOrder writes metafields when customer has settings", async () => {
  let writtenMetafields = [];

  const admin = {
    graphql: async (query, { variables }) => {
      if (query.includes("CustomerForwarderMetafields")) {
        return {
          json: async () => ({
            data: {
              customer: {
                customForwarderName: { value: "Apex Logistics" },
                customForwarderAccount: { value: "APEX-007" },
                companyContactProfiles: [],
              },
            },
          }),
        };
      }

      if (query.includes("SetOrderForwarderMetafields")) {
        writtenMetafields = variables.metafields;
        return {
          json: async () => ({
            data: {
              metafieldsSet: {
                metafields: writtenMetafields.map((m, idx) => ({ id: `gid://shopify/Metafield/${idx}`, ...m })),
                userErrors: [],
              },
            },
          }),
        };
      }

      return { json: async () => ({ data: {} }) };
    },
  };

  const order = {
    id: "gid://shopify/Order/9999",
    name: "#1105",
    customer: { id: "gid://shopify/Customer/4321" },
  };

  const res = await copyFobForwarderMetafieldsToOrder(admin, { order });
  assert.equal(res.ok, true);
  assert.equal(res.copied, true);
  assert.equal(res.forwarderName, "Apex Logistics");
  assert.equal(res.forwarderAccount, "APEX-007");

  // Verify custom and hyve namespace metafields were set on the order
  const customName = writtenMetafields.find((m) => m.namespace === "custom" && m.key === "forwarder_name");
  const customAcc = writtenMetafields.find((m) => m.namespace === "custom" && m.key === "forwarder_account");
  const hyveName = writtenMetafields.find((m) => m.namespace === "hyve" && m.key === "forwarder_name");
  const hyveAcc = writtenMetafields.find((m) => m.namespace === "hyve" && m.key === "forwarder_account");

  assert.ok(customName, "custom:forwarder_name should be set");
  assert.equal(customName.value, "Apex Logistics");
  assert.ok(customAcc, "custom:forwarder_account should be set");
  assert.equal(customAcc.value, "APEX-007");

  assert.ok(hyveName, "hyve:forwarder_name should be set");
  assert.equal(hyveName.value, "Apex Logistics");
  assert.ok(hyveAcc, "hyve:forwarder_account should be set");
  assert.equal(hyveAcc.value, "APEX-007");
});

test("copyFobForwarderMetafieldsToOrder skips when customer has no forwarder values", async () => {
  let setMutationCalled = false;

  const admin = {
    graphql: async (query) => {
      if (query.includes("CustomerForwarderMetafields")) {
        return {
          json: async () => ({
            data: {
              customer: {
                customForwarderName: null,
                customForwarderAccount: null,
                companyContactProfiles: [],
              },
            },
          }),
        };
      }
      if (query.includes("SetOrderForwarderMetafields")) {
        setMutationCalled = true;
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const order = {
    id: "gid://shopify/Order/9999",
    customer: { id: "gid://shopify/Customer/4321" },
  };

  const res = await copyFobForwarderMetafieldsToOrder(admin, { order });
  assert.equal(res.ok, true);
  assert.equal(res.copied, false);
  assert.equal(setMutationCalled, false);
});

test("resolves forwarderName and forwarderAccount with order and customer fallbacks", () => {
  const resolveForwarder = (order) => ({
    forwarderName:
      order.customForwarderName?.value ||
      order.forwarderName?.value ||
      order.customer?.customForwarderName?.value ||
      order.customer?.hyveForwarderName?.value ||
      order.customer?.companyContactProfiles?.[0]?.company?.forwarderName?.value ||
      order.purchasingEntity?.company?.forwarderName?.value ||
      "",
    forwarderAccount:
      order.customForwarderAccount?.value ||
      order.forwarderAccount?.value ||
      order.customer?.customForwarderAccount?.value ||
      order.customer?.hyveForwarderAccount?.value ||
      order.customer?.companyContactProfiles?.[0]?.company?.forwarderAccount?.value ||
      order.purchasingEntity?.company?.forwarderAccount?.value ||
      "",
  });

  // Case 1: Order metafields present
  const res1 = resolveForwarder({
    customForwarderName: { value: "Sinotrans" },
    customForwarderAccount: { value: "SINO-441" },
    customer: { customForwarderName: { value: "Old Forwarder" } },
  });
  assert.equal(res1.forwarderName, "Sinotrans");
  assert.equal(res1.forwarderAccount, "SINO-441");

  // Case 2: Order metafields missing, falls back to customer saved settings
  const res2 = resolveForwarder({
    customer: {
      customForwarderName: { value: "Kuehne+Nagel" },
      customForwarderAccount: { value: "KN-999" },
    },
  });
  assert.equal(res2.forwarderName, "Kuehne+Nagel");
  assert.equal(res2.forwarderAccount, "KN-999");

  // Case 3: Falls back to B2B company saved settings
  const res3 = resolveForwarder({
    purchasingEntity: {
      company: {
        forwarderName: { value: "DB Schenker" },
        forwarderAccount: { value: "DBS-555" },
      },
    },
  });
  assert.equal(res3.forwarderName, "DB Schenker");
  assert.equal(res3.forwarderAccount, "DBS-555");
});

test("customerArrangesFreight identifies FOB shipping correctly", async () => {
  const { customerArrangesFreight, CUSTOMER_ARRANGED_FREIGHT_TAG } = await import("../app/lib/production-statuses.js");

  assert.equal(customerArrangesFreight({ tags: [CUSTOMER_ARRANGED_FREIGHT_TAG] }), true);
  assert.equal(customerArrangesFreight({ tags: "hyve-freight:customer-arranged, other-tag" }), true);
  assert.equal(customerArrangesFreight({ shippingLine: { title: "FOB (Freight Arranged Separately)" } }), true);
  assert.equal(customerArrangesFreight({ shippingLine: { title: "Standard Express Courier" } }), false);
});


