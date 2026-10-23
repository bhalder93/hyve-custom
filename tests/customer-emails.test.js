import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import * as nodemailer from "nodemailer";

test("all customer status emails include greeting, order details, links and view order in plain text", async () => {
  const {
    sendArtworkReceivedEmail,
    sendProofSentEmail,
    sendProofReminderEmail,
    sendArtworkReminderEmail,
    sendProofApprovedEmail,
    sendProductionCompleteEmail,
    sendPhysicalSampleEmail,
    sendReadyForCollectionEmail,
    sendInvoiceEmail,
    sendEstimatedShipDateEmail,
  } = await import("../app/utils/email.server.js");

  let sentMail = null;
  const originalCreateTransport = nodemailer.default.createTransport;
  nodemailer.default.createTransport = () => ({
    sendMail: async (opts) => {
      sentMail = opts;
      return { accepted: [opts.to], messageId: "test-msg" };
    },
  });

  const prevHost = process.env.SMTP_HOST;
  const prevUser = process.env.SMTP_USER;
  const prevPass = process.env.SMTP_PASS;

  process.env.SMTP_HOST = "smtp.test.com";
  process.env.SMTP_USER = "user";
  process.env.SMTP_PASS = "pass";

  const commonParams = {
    customerEmail: "customer@example.com",
    customerName: "John Doe",
    orderName: "#2001",
    orderDate: "2026-10-16T12:00:00Z",
    lineItems: [
      { title: "Custom Hoodie", variantTitle: "Navy / XL", quantity: 25 },
    ],
    orderUrl: "https://hyve.promo/apps/account/orders/2001",
  };

  try {
    // 1. sendArtworkReceivedEmail
    await sendArtworkReceivedEmail(commonParams);
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Artwork Received - #2001"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("- Custom Hoodie (Navy / XL) x 25"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("Order date:"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));

    // 2. sendProofSentEmail
    await sendProofSentEmail({
      ...commonParams,
      proofUrl: "https://example.com/proof.pdf",
      proofVersion: 1,
      approveUrl: "https://example.com/approve-proof",
      changesUrl: "https://example.com/changes-proof",
    });
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Proof Sent - #2001"));
    assert.ok(sentMail.text.includes("Artwork Proof: https://example.com/proof.pdf"));
    assert.ok(sentMail.text.includes("Approve Artwork Proof: https://example.com/approve-proof"));
    assert.ok(sentMail.text.includes("Request Changes: https://example.com/changes-proof"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));

    // 3. sendProofReminderEmail
    await sendProofReminderEmail({
      ...commonParams,
      proofUrl: "https://example.com/proof.pdf",
      proofVersion: 1,
      approveUrl: "https://example.com/approve-proof",
      changesUrl: "https://example.com/changes-proof",
      reminderDay: "Day 3",
    });
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Artwork Proof reminder - #2001"));
    assert.ok(sentMail.text.includes("Review Artwork Proof: https://example.com/proof.pdf"));
    assert.ok(sentMail.text.includes("Approve Artwork Proof: https://example.com/approve-proof"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));

    // 4. sendArtworkReminderEmail
    await sendArtworkReminderEmail(commonParams);
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Reminder: we're waiting for your artwork - #2001"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));

    // 5. sendProofApprovedEmail
    await sendProofApprovedEmail({
      ...commonParams,
      productionDueAt: "2026-10-30T12:00:00Z",
      estimatedShipDate: "2026-11-05T12:00:00Z",
    });
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Approved and In Production - #2001"));
    assert.ok(sentMail.text.includes("Production target:"));
    assert.ok(sentMail.text.includes("Estimated ship date:"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));

    // 6. sendProductionCompleteEmail
    await sendProductionCompleteEmail({
      ...commonParams,
      productionPhotoUrl: "https://example.com/photo.jpg",
      productionPhotoVersion: 1,
      approveUrl: "https://example.com/approve-photo",
      changesUrl: "https://example.com/changes-photo",
    });
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Production Completed - #2001"));
    assert.ok(sentMail.text.includes("Production Photo: https://example.com/photo.jpg"));
    assert.ok(sentMail.text.includes("Approve Production Photo: https://example.com/approve-photo"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));

    // 7. sendPhysicalSampleEmail
    await sendPhysicalSampleEmail({
      ...commonParams,
      sampleVersion: 1,
      fileUrl: "https://example.com/sample.jpg",
      note: "Sample ready",
      approveUrl: "https://example.com/approve-sample",
      changesUrl: "https://example.com/changes-sample",
      reviewUrl: "https://example.com/review-sample",
    });
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Physical Sample Ready For Review - #2001"));
    assert.ok(sentMail.text.includes("Sample Note: Sample ready"));
    assert.ok(sentMail.text.includes("Physical Sample Photos / Docs: https://example.com/sample.jpg"));
    assert.ok(sentMail.text.includes("Review & Approve (no sign-in required): https://example.com/review-sample"));
    assert.ok(sentMail.text.includes("Approve Physical Sample: https://example.com/approve-sample"));
    assert.ok(sentMail.text.includes("Request Changes: https://example.com/changes-sample"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("- Custom Hoodie (Navy / XL) x 25"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));

    // 8. sendReadyForCollectionEmail
    await sendReadyForCollectionEmail({
      ...commonParams,
      collectionDetails: {
        readyDate: "2026-10-25T12:00:00Z",
        numberOfCartons: 3,
        grossWeight: 45,
        cbm: 0.8,
      },
      pickupConfig: {
        pickup_address: "123 Warehouse Rd, Singapore",
      },
    });
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Your order #2001 is ready for collection."));
    assert.ok(sentMail.text.includes("Collection Details"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));

    // 9. sendInvoiceEmail
    await sendInvoiceEmail({
      customerEmail: "customer@example.com",
      customerName: "John Doe",
      orderName: "#2001",
      orderDate: "2026-10-16T12:00:00Z",
      pdf: Buffer.from("dummy-pdf"),
      filename: "invoice-2001.pdf",
      orderUrl: "https://hyve.promo/apps/account/orders/2001",
    });
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Invoice - #2001"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));

    // 10. sendEstimatedShipDateEmail
    await sendEstimatedShipDateEmail({
      ...commonParams,
      estimatedShipDate: "2026-11-10T12:00:00Z",
    });
    assert.ok(sentMail.text.includes("Hi John Doe,"));
    assert.ok(sentMail.text.includes("Estimated Ship Date Update - #2001"));
    assert.ok(sentMail.text.includes("Estimated ship date:"));
    assert.ok(sentMail.text.includes("Order items"));
    assert.ok(sentMail.text.includes("Order: #2001"));
    assert.ok(sentMail.text.includes("View your order: https://hyve.promo/apps/account/orders/2001"));
  } finally {
    nodemailer.default.createTransport = originalCreateTransport;
    if (prevHost) process.env.SMTP_HOST = prevHost; else delete process.env.SMTP_HOST;
    if (prevUser) process.env.SMTP_USER = prevUser; else delete process.env.SMTP_USER;
    if (prevPass) process.env.SMTP_PASS = prevPass; else delete process.env.SMTP_PASS;
  }
});
