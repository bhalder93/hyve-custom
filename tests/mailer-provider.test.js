import test from "node:test";
import assert from "node:assert/strict";
import {
  isMicrosoftGraphConfigured,
  getEmailProvider,
  getDefaultFrom,
  getMailer,
} from "../app/lib/email/mailer.server.js";

test("defaults to SMTP (Gmail) when Microsoft 365 credentials are not provided", () => {
  const originalTenant = process.env.MS_TENANT_ID;
  const originalClient = process.env.MS_CLIENT_ID;
  const originalSecret = process.env.MS_CLIENT_SECRET;

  delete process.env.MS_TENANT_ID;
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;

  try {
    assert.equal(isMicrosoftGraphConfigured(), false);
    assert.equal(getEmailProvider(), "smtp");
  } finally {
    if (originalTenant) process.env.MS_TENANT_ID = originalTenant;
    if (originalClient) process.env.MS_CLIENT_ID = originalClient;
    if (originalSecret) process.env.MS_CLIENT_SECRET = originalSecret;
  }
});

test("switches to Microsoft Graph when MS credentials are provided", () => {
  const originalTenant = process.env.MS_TENANT_ID;
  const originalClient = process.env.MS_CLIENT_ID;
  const originalSecret = process.env.MS_CLIENT_SECRET;
  const originalFrom = process.env.MS_FROM_EMAIL;

  process.env.MS_TENANT_ID = "mock-tenant-id";
  process.env.MS_CLIENT_ID = "mock-client-id";
  process.env.MS_CLIENT_SECRET = "mock-client-secret";
  process.env.MS_FROM_EMAIL = "orders@hyve.promo";

  try {
    assert.equal(isMicrosoftGraphConfigured(), true);
    assert.equal(getEmailProvider(), "microsoft-graph");
    assert.ok(getDefaultFrom().includes("orders@hyve.promo"));

    const mailer = getMailer();
    assert.equal(typeof mailer.sendMail, "function");
    assert.equal(typeof mailer.verify, "function");
  } finally {
    if (originalTenant) process.env.MS_TENANT_ID = originalTenant;
    else delete process.env.MS_TENANT_ID;

    if (originalClient) process.env.MS_CLIENT_ID = originalClient;
    else delete process.env.MS_CLIENT_ID;

    if (originalSecret) process.env.MS_CLIENT_SECRET = originalSecret;
    else delete process.env.MS_CLIENT_SECRET;

    if (originalFrom) process.env.MS_FROM_EMAIL = originalFrom;
    else delete process.env.MS_FROM_EMAIL;
  }
});
