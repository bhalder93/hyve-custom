import test from "node:test";
import assert from "node:assert/strict";
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
  const { sendPhysicalSampleEmail } = await import("../app/utils/email.server.js");

  let sentMail = null;
  const originalCreateTransport = nodemailer.default.createTransport;
  nodemailer.default.createTransport = () => ({
    sendMail: async (opts) => {
      sentMail = opts;
      return { accepted: [opts.to], messageId: "test-sample-msg-1" };
    },
  });

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
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders"));
  } finally {
    nodemailer.default.createTransport = originalCreateTransport;
    if (prevHost) process.env.SMTP_HOST = prevHost; else delete process.env.SMTP_HOST;
    if (prevUser) process.env.SMTP_USER = prevUser; else delete process.env.SMTP_USER;
    if (prevPass) process.env.SMTP_PASS = prevPass; else delete process.env.SMTP_PASS;
  }
});

