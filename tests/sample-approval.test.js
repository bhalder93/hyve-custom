import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { syncSampleStatusTags } from "../app/lib/sample-status-tags.server.js";

test("sample approval removes the review tag and adds production approval tags", async () => {
  const mutations = [];
  const admin = {
    async graphql(query, { variables }) {
      mutations.push({ query, variables });
      const operation = query.includes("tagsRemove") ? "tagsRemove" : "tagsAdd";
      return { json: async () => ({ data: { [operation]: { userErrors: [] } } }) };
    },
  };

  await syncSampleStatusTags(
    admin,
    "gid://shopify/Order/123",
    ["hyve-status:sample-review", "hyve-status:on-hold", "hyve-sample-approved"],
    "in-production",
    ["hyve-sample-approved"],
  );

  assert.deepEqual(mutations[0].variables.tags, [
    "hyve-status:sample-review",
    "hyve-status:on-hold",
  ]);
  assert.deepEqual(mutations[1].variables.tags, [
    "hyve-status:in-production",
    "hyve-sample-approved",
  ]);
});

test("sample tag sync normalizes numeric orderId and handles string tags gracefully", async () => {
  const mutations = [];
  const admin = {
    async graphql(query, { variables }) {
      mutations.push({ query, variables });
      const operation = query.includes("tagsRemove") ? "tagsRemove" : "tagsAdd";
      return { json: async () => ({ data: { [operation]: { userErrors: [] } } }) };
    },
  };

  await syncSampleStatusTags(
    admin,
    "123456",
    "hyve-status:sample-review, hyve-rush",
    "in-production",
    ["hyve-sample-approved", "in-production"],
  );

  assert.equal(mutations[0].variables.id, "gid://shopify/Order/123456");
  assert.deepEqual(mutations[0].variables.tags, ["hyve-status:sample-review"]);
  assert.equal(mutations[1].variables.id, "gid://shopify/Order/123456");
  assert.deepEqual(mutations[1].variables.tags, [
    "hyve-status:in-production",
    "hyve-sample-approved",
    "in-production",
  ]);
});

test("sample tag sync retries and reports Shopify user errors", async () => {
  let attempts = 0;
  const admin = {
    async graphql() {
      attempts += 1;
      return {
        json: async () => ({
          data: { tagsRemove: { userErrors: [{ message: "Tag update rejected" }] } },
        }),
      };
    },
  };

  await assert.rejects(
    syncSampleStatusTags(
      admin,
      "gid://shopify/Order/123",
      ["hyve-status:sample-review"],
      "in-production",
      ["hyve-sample-approved"],
    ),
    /Tag update rejected/,
  );
  assert.equal(attempts, 2);
});

test("sendPhysicalSampleEmail includes greeting, order details, links and view order", async () => {
  const nodemailer = await import("nodemailer");
  const { resetMailer } = await import("../app/lib/email/mailer.server.js");
  const { sendPhysicalSampleEmail } = await import("../app/utils/email.server.js");

  let sentMail = null;
  const originalCreateTransport = nodemailer.default.createTransport;
  nodemailer.default.createTransport = () => ({
    sendMail: async (opts) => {
      sentMail = opts;
      return { accepted: [opts.to], messageId: "test-sample-msg-1" };
    },
  });
  resetMailer();

  const prevHost = process.env.SMTP_HOST;
  const prevUser = process.env.SMTP_USER;
  const prevPass = process.env.SMTP_PASS;

  process.env.SMTP_HOST = "smtp.test.com";
  process.env.SMTP_USER = "user";
  process.env.SMTP_PASS = "pass";

  try {
    await sendPhysicalSampleEmail({
      customerEmail: "alice@example.com",
      customerName: "Alice Smith",
      orderName: "#1099",
      orderDate: "2026-10-15T10:00:00Z",
      sampleVersion: 2,
      fileUrl: "https://example.com/sample.jpg",
      note: "Color adjusted per your request",
      approveUrl: "https://example.com/approve",
      changesUrl: "https://example.com/changes",
      reviewUrl: "https://example.com/review",
      lineItems: [
        { title: "Custom Embroidered Cap", variantTitle: "Black", quantity: 50 },
      ],
    });

    assert.ok(sentMail, "sendMail should have been called");
    assert.equal(sentMail.to, "alice@example.com");
    assert.equal(sentMail.subject, "Physical Sample Ready For Review - #1099");
    assert.ok(sentMail.text.includes("Hi Alice Smith,"));
    assert.ok(sentMail.text.includes("Physical Sample Ready For Review - #1099"));
    assert.ok(sentMail.text.includes("Action required: Please review your Physical Sample"));
    assert.ok(sentMail.text.includes("Your physical pre-production sample has been prepared and dispatched."));
    assert.ok(sentMail.text.includes("Sample Note: Color adjusted per your request"));
    assert.ok(sentMail.text.includes("Physical Sample Photos / Docs: https://example.com/sample.jpg"));
    assert.ok(sentMail.text.includes("Review & Approve (no sign-in required): https://example.com/review"));
    assert.ok(sentMail.text.includes("Approve Physical Sample: https://example.com/approve"));
    assert.ok(sentMail.text.includes("Request Changes: https://example.com/changes"));
    assert.ok(sentMail.text.includes("Physical Sample version: v2"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("- Custom Embroidered Cap (Black) x 50"));
    assert.ok(sentMail.text.includes("Order: #1099"));
    assert.ok(sentMail.text.includes("Order date:"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders"));
  } finally {
    nodemailer.default.createTransport = originalCreateTransport;
    if (prevHost) process.env.SMTP_HOST = prevHost; else delete process.env.SMTP_HOST;
    if (prevUser) process.env.SMTP_USER = prevUser; else delete process.env.SMTP_USER;
    if (prevPass) process.env.SMTP_PASS = prevPass; else delete process.env.SMTP_PASS;
  }
});

test("syncSampleStatusTags queries have newlines after #graphql so mutations are not commented out", async () => {
  const mutations = [];
  const admin = {
    async graphql(query, { variables }) {
      mutations.push({ query, variables });
      const operation = query.includes("tagsRemove") ? "tagsRemove" : "tagsAdd";
      return { json: async () => ({ data: { [operation]: { userErrors: [] } } }) };
    },
  };

  await syncSampleStatusTags(
    admin,
    "gid://shopify/Order/789",
    ["hyve-status:sample-review"],
    "in-production",
    ["hyve-sample-approved", "in-production"],
  );

  for (const m of mutations) {
    const lines = m.query.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    // Line 1 should be '#graphql' and line 2 should start with 'mutation'
    assert.equal(lines[0], "#graphql");
    assert.ok(lines[1].startsWith("mutation "), `Expected mutation on line 2, got: ${lines[1]}`);
  }
});

test("notifyCustomer sends In Production email with sampleApproved text and tags order", async () => {
  const nodemailer = await import("nodemailer");
  const { resetMailer } = await import("../app/lib/email/mailer.server.js");
  const { notifyCustomer } = await import("../app/lib/order-status.server.js");

  let sentMail = null;
  const originalCreateTransport = nodemailer.default.createTransport;
  nodemailer.default.createTransport = () => ({
    sendMail: async (opts) => {
      sentMail = opts;
      return { accepted: [opts.to], messageId: "msg-in-prod-1" };
    },
  });
  resetMailer();

  const prevHost = process.env.SMTP_HOST;
  const prevUser = process.env.SMTP_USER;
  const prevPass = process.env.SMTP_PASS;

  process.env.SMTP_HOST = "smtp.test.com";
  process.env.SMTP_USER = "user";
  process.env.SMTP_PASS = "pass";

  const tagged = [];
  const admin = {
    async graphql(query, { variables }) {
      if (query.includes("CustomerEmailPreference")) {
        return { json: async () => ({ data: { customer: { emailNotifications: { value: "true" } } } }) };
      }
      if (query.includes("ProductionTagsAdd")) {
        tagged.push(...variables.tags);
        return { json: async () => ({ data: { tagsAdd: { userErrors: [] } } }) };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  try {
    const result = await notifyCustomer(
      admin,
      {
        id: "gid://shopify/Order/555",
        name: "#5555",
        createdAt: "2026-10-20T10:00:00Z",
        tags: ["hyve-status:in-production"],
        customer: {
          id: "gid://shopify/Customer/111",
          displayName: "Bob Miller",
          defaultEmailAddress: { emailAddress: "bob@example.com" },
        },
        shippingAddress: { name: "Bob Miller" },
        lineItems: { nodes: [{ title: "Custom Hoodie", quantity: 100 }] },
      },
      "in-production",
      "2026-11-15T00:00:00Z",
      { sampleApproved: true },
    );

    assert.equal(result.ok, true);
    assert.equal(result.sent, true);
    assert.ok(sentMail, "Email should have been sent");
    assert.equal(sentMail.to, "bob@example.com");
    assert.equal(sentMail.subject, "Approved and In Production - #5555");
    assert.ok(sentMail.text.includes("Thank you. Your Physical Sample has been approved."));
    assert.ok(sentMail.text.includes("Your order is now moving into production."));
    assert.ok(tagged.includes("hyve-notified:in-production"), "Should tag hyve-notified:in-production");
  } finally {
    nodemailer.default.createTransport = originalCreateTransport;
    if (prevHost) process.env.SMTP_HOST = prevHost; else delete process.env.SMTP_HOST;
    if (prevUser) process.env.SMTP_USER = prevUser; else delete process.env.SMTP_USER;
    if (prevPass) process.env.SMTP_PASS = prevPass; else delete process.env.SMTP_PASS;
  }
});

test("recordEmailSampleDecision approves sample, syncs tags to in-production and sends customer email", async () => {
  const nodemailer = await import("nodemailer");
  const { resetMailer } = await import("../app/lib/email/mailer.server.js");
  const { recordEmailSampleDecision } = await import("../app/lib/sample-approval.server.js");

  let sentMail = null;
  const originalCreateTransport = nodemailer.default.createTransport;
  nodemailer.default.createTransport = () => ({
    sendMail: async (opts) => {
      sentMail = opts;
      return { accepted: [opts.to], messageId: "msg-email-sample-1" };
    },
  });
  resetMailer();

  const prevHost = process.env.SMTP_HOST;
  const prevUser = process.env.SMTP_USER;
  const prevPass = process.env.SMTP_PASS;

  process.env.SMTP_HOST = "smtp.test.com";
  process.env.SMTP_USER = "user";
  process.env.SMTP_PASS = "pass";

  const mutations = [];
  const tagsAdded = [];
  const tagsRemoved = [];

  const admin = {
    async graphql(query, options = {}) {
      const variables = options?.variables || {};
      mutations.push({ query, variables });

      if (query.includes("OrderForAction")) {
        return {
          json: async () => ({
            data: {
              order: {
                id: "gid://shopify/Order/999",
                name: "#9999",
                createdAt: "2026-10-21T09:00:00Z",
                tags: ["hyve-status:sample-review"],
                email: "buyer@example.com",
                customer: {
                  id: "gid://shopify/Customer/222",
                  displayName: "Jane Buyer",
                  defaultEmailAddress: { emailAddress: "buyer@example.com" },
                },
                shippingAddress: { name: "Jane Buyer" },
                productionStatus: { value: "sample-review" },
                rush: { value: "false" },
                physicalSampleHistory: {
                  value: JSON.stringify([
                    { sampleVersion: 1, status: "sent", fileUrl: "https://example.com/sample1.jpg" },
                  ]),
                },
                physicalSampleRequired: { value: "true" },
                lineItems: { nodes: [{ title: "Custom Pen", quantity: 500 }] },
              },
            },
          }),
        };
      }

      if (query.includes("ProductionHolidays")) {
        return { json: async () => ({ data: { holidays: { nodes: [] } } }) };
      }

      if (query.includes("CommercialSettings")) {
        return {
          json: async () => ({
            data: {
              shop: {
                id: "gid://shopify/Shop/1",
                currencyCode: "USD",
                production_days_standard: { value: "10" },
                production_days_rush: { value: "5" },
                artwork_due_days: { value: "3" },
                setup_waiver_threshold: { value: "100" },
                free_freight_threshold: { value: "500" },
                fob_origin_countries: { value: "CN, VN" },
              },
              metafieldDefinitions: {
                nodes: [
                  { key: "production_days_standard" },
                  { key: "production_days_rush" },
                  { key: "artwork_due_days" },
                  { key: "setup_waiver_threshold" },
                  { key: "free_freight_threshold" },
                  { key: "fob_origin_countries" },
                ],
              },
            },
          }),
        };
      }

      if (query.includes("CustomerEmailPreference")) {
        return { json: async () => ({ data: { customer: { emailNotifications: { value: "true" } } } }) };
      }

      if (query.includes("RemoveSampleStatusTags")) {
        tagsRemoved.push(...variables.tags);
        return { json: async () => ({ data: { tagsRemove: { userErrors: [] } } }) };
      }

      if (query.includes("AddSampleStatusTags")) {
        tagsAdded.push(...variables.tags);
        return { json: async () => ({ data: { tagsAdd: { userErrors: [] } } }) };
      }

      if (query.includes("ProductionTagsAdd")) {
        tagsAdded.push(...variables.tags);
        return { json: async () => ({ data: { tagsAdd: { userErrors: [] } } }) };
      }

      if (query.includes("UpdateSampleDecision")) {
        return { json: async () => ({ data: { metafieldsSet: { userErrors: [] } } }) };
      }

      if (query.includes("ClearOnHoldReason")) {
        return { json: async () => ({ data: { metafieldsDelete: { userErrors: [] } } }) };
      }

      if (query.includes("ProductionHistoryCreate") || query.includes("order_status_history")) {
        return { json: async () => ({ data: { metaobjectCreate: { userErrors: [] } } }) };
      }

      return { json: async () => ({ data: {} }) };
    },
  };

  try {
    const result = await recordEmailSampleDecision(
      admin,
      { orderGid: "gid://shopify/Order/999", version: "1" },
      "approve",
      "",
      "127.0.0.1",
      "Mozilla/5.0",
    );

    assert.equal(result.ok, true);
    assert.equal(result.decision, "approve");

    // 1. Verify tags sync: removed hyve-status:sample-review, added in-production tags
    assert.ok(tagsRemoved.includes("hyve-status:sample-review"), "Should remove hyve-status:sample-review");
    assert.ok(tagsAdded.includes("hyve-status:in-production"), "Should add hyve-status:in-production");
    assert.ok(tagsAdded.includes("hyve-sample-approved"), "Should add hyve-sample-approved");
    assert.ok(tagsAdded.includes("in-production"), "Should add in-production tag");

    // 2. Verify customer email was sent
    assert.ok(sentMail, "In Production email should have been sent");
    assert.equal(sentMail.to, "buyer@example.com");
    assert.equal(sentMail.subject, "Approved and In Production - #9999");
    assert.ok(sentMail.text.includes("Thank you. Your Physical Sample has been approved."));
    assert.ok(sentMail.text.includes("Your order is now moving into production."));
    assert.ok(tagsAdded.includes("hyve-notified:in-production"), "Should tag order with hyve-notified:in-production");
  } finally {
    nodemailer.default.createTransport = originalCreateTransport;
    if (prevHost) process.env.SMTP_HOST = prevHost; else delete process.env.SMTP_HOST;
    if (prevUser) process.env.SMTP_USER = prevUser; else delete process.env.SMTP_USER;
    if (prevPass) process.env.SMTP_PASS = prevPass; else delete process.env.SMTP_PASS;
  }
});



