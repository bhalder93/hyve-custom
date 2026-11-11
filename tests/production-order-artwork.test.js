import test from "node:test";
import assert from "node:assert/strict";

test("line items preserve original Artwork and Design Brief attributes without overriding to Received", () => {
  const lineItems = [
    {
      id: "gid://shopify/LineItem/17088039649496",
      name: "Recycled Aluminum Pen with Bamboo Plunger - Black",
      quantity: 50,
      sku: "11989BLK",
      variantTitle: "Black",
      customAttributes: [
        { key: "Imprint Locations", value: "Laser: BARREL" },
        { key: "_imprint", value: '{"method":"Laser","locations":1}' },
        { key: "Artwork", value: "Design it for me" },
        { key: "Design Brief", value: "HYV-115 QA: Acme logo on the barrel, one colour." },
      ],
    },
    {
      id: "gid://shopify/LineItem/17088039682264",
      name: "MagSnap Key Cable - Black",
      quantity: 25,
      sku: "29223BLK",
      variantTitle: "Black",
      customAttributes: [
        { key: "Imprint Locations", value: "Digital: Front" },
        { key: "_imprint", value: '{"method":"Digital","locations":1}' },
        { key: "Artwork", value: "Artwork Pending" },
      ],
    },
  ];

  // Helper extraction logic as used in production-orders.$orderId.jsx
  const item1 = lineItems[0];
  const artwork1 = item1.customAttributes.find(
    (a) => String(a.key || "").trim().toLowerCase() === "artwork",
  );
  const brief1 = item1.customAttributes.find(
    (a) => String(a.key || "").trim().toLowerCase() === "design brief",
  );

  assert.equal(artwork1?.value, "Design it for me");
  assert.notEqual(artwork1?.value, "Received");
  assert.equal(brief1?.value, "HYV-115 QA: Acme logo on the barrel, one colour.");

  const item2 = lineItems[1];
  const artwork2 = item2.customAttributes.find(
    (a) => String(a.key || "").trim().toLowerCase() === "artwork",
  );
  assert.equal(artwork2?.value, "Artwork Pending");
  assert.notEqual(artwork2?.value, "Received");
});

test("recordStatusHistory logs audit trail entry for partial artwork uploads", async () => {
  const { recordStatusHistory, SOURCES } = await import("../app/lib/order-status.server.js");

  let createdMetaobject = null;
  const mockAdmin = {
    graphql: async (query, { variables }) => {
      createdMetaobject = variables.metaobject;
      return {
        json: async () => ({
          data: {
            metaobjectCreate: {
              metaobject: { id: "gid://shopify/Metaobject/999" },
              userErrors: [],
            },
          },
        }),
      };
    },
  };

  const order = { id: "gid://shopify/Order/12345", name: "#12345" };
  const note = "Sent artwork from the portal (awaiting remaining files):\n• Satin Pen, Front: hyv212-pen-logo.png\n  https://cdn.shopify.com/pen.png";

  await recordStatusHistory(mockAdmin, {
    order,
    from: "order-placed",
    to: "order-placed",
    changedAt: "2026-11-09T18:00:00.000Z",
    changedBy: "Customer",
    source: SOURCES.portal,
    note,
    ipAddress: "127.0.0.1",
    userAgent: "Mozilla/5.0",
  });

  assert.equal(createdMetaobject.type, "$app:order_status_history");
  const fieldMap = Object.fromEntries(createdMetaobject.fields.map((f) => [f.key, f.value]));
  assert.equal(fieldMap.order_id, "gid://shopify/Order/12345");
  assert.equal(fieldMap.order_name, "#12345");
  assert.equal(fieldMap.from_status, "order-placed");
  assert.equal(fieldMap.to_status, "order-placed");
  assert.equal(fieldMap.changed_by, "Customer");
  assert.equal(fieldMap.source, "CUSTOMER_PORTAL");
  assert.ok(fieldMap.note.includes("Satin Pen"));
  assert.ok(fieldMap.note.includes("hyv212-pen-logo.png"));
});

test("lateArtworkKey formats readable attribute key with product and imprint position", async () => {
  const { lateArtworkKey, zonesFromAttributes } = await import("../app/lib/artwork-zones.server.js");

  const line = {
    title: "MagSnap Key Cable",
    variantTitle: "Black",
  };
  const key = lateArtworkKey("Artwork: Digital - BARREL", "gid://shopify/LineItem/17129080029400", line, "Digital — BARREL");
  assert.equal(key, "MagSnap Key Cable — Black, Digital — BARREL");

  // Single variant product (no variant or "Default Title")
  const singleVariantLine = {
    title: "Satin Pen",
    variantTitle: "Default Title",
  };
  const penKey = lateArtworkKey("Artwork: Laser - Front", "gid://shopify/LineItem/17129080029401", singleVariantLine, "Laser — Front");
  assert.equal(penKey, "Satin Pen, Laser — Front");

  // zonesFromAttributes matches new format in order.customAttributes
  const lineCustomAttrs = [
    { key: "Imprint Locations", value: "Digital: BARREL" },
    { key: "Artwork", value: "Artwork Pending" },
  ];
  const orderCustomAttrs = [
    {
      key: "MagSnap Key Cable — Black, Digital — BARREL",
      value: "https://cdn.shopify.com/s/files/1/0772/9237/2184/files/hyv212-pen-logo.png?v=1793972842",
    },
  ];
  const zones = zonesFromAttributes(lineCustomAttrs, orderCustomAttrs, "gid://shopify/LineItem/17129080029400", line);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].lateKey, "MagSnap Key Cable — Black, Digital — BARREL");
  assert.equal(zones[0].url, "https://cdn.shopify.com/s/files/1/0772/9237/2184/files/hyv212-pen-logo.png?v=1793972842");
  assert.equal(zones[0].suppliedLater, true);
});

test("attachArtworkToOrder replaces legacy artwork attribute key with formatted key", async () => {
  const { attachArtworkToOrder } = await import("../app/lib/order-artwork.server.js");

  let updatedInput = null;
  const mockAdmin = {
    graphql: async (query, { variables }) => {
      if (query.includes("OrderArtworkAttributes")) {
        return {
          json: async () => ({
            data: {
              order: {
                id: "gid://shopify/Order/12345",
                customAttributes: [
                  { key: "ExistingNote", value: "KeepThis" },
                  { key: "Artwork: Digital - BARREL (line 17129080029400)", value: "https://cdn.shopify.com/old.png" },
                ],
              },
            },
          }),
        };
      }
      if (query.includes("OrderArtworkUpdate")) {
        updatedInput = variables.input;
        return {
          json: async () => ({
            data: {
              orderUpdate: {
                userErrors: [],
                order: { id: "gid://shopify/Order/12345" },
              },
            },
          }),
        };
      }
      return { json: async () => ({}) };
    },
  };

  const supplied = [
    {
      zone: "MagSnap Key Cable — Black, Digital — BARREL",
      legacyZone: "Artwork: Digital - BARREL (line 17129080029400)",
      url: "https://cdn.shopify.com/s/files/1/0772/9237/2184/files/hyv212-pen-logo.png?v=1793972842",
    },
  ];

  const result = await attachArtworkToOrder(mockAdmin, "gid://shopify/Order/12345", supplied);
  assert.equal(result.ok, true);

  const keys = updatedInput.customAttributes.map((a) => a.key);
  assert.ok(keys.includes("ExistingNote"));
  assert.ok(keys.includes("MagSnap Key Cable — Black, Digital — BARREL"));
  assert.ok(!keys.includes("Artwork: Digital - BARREL (line 17129080029400)"));

  const newAttr = updatedInput.customAttributes.find(
    (a) => a.key === "MagSnap Key Cable — Black, Digital — BARREL",
  );
  assert.equal(
    newAttr.value,
    "https://cdn.shopify.com/s/files/1/0772/9237/2184/files/hyv212-pen-logo.png?v=1793972842",
  );
});
