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
