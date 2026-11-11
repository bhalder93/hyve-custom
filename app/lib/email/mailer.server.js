import nodemailer from "nodemailer";

let transporter;
let msTokenCache = { token: null, expiresAt: 0 };

/** Hyve customer service: where every email's replies go (HYV-110). */
export const CUSTOMER_SERVICE_EMAIL = "sales@hyve.promo";

/**
 * Checks whether Microsoft 365 Graph credentials are provided.
 * In production, setting MS_TENANT_ID, MS_CLIENT_ID, and MS_CLIENT_SECRET
 * routes emails through Microsoft 365 Business Mailbox via Microsoft Graph.
 * In development, if these are omitted, it falls back to SMTP (Gmail).
 */
export function isMicrosoftGraphConfigured() {
  return Boolean(
    process.env.MS_CLIENT_ID &&
    process.env.MS_CLIENT_SECRET &&
    process.env.MS_TENANT_ID
  );
}

export function getEmailProvider() {
  return isMicrosoftGraphConfigured() ? "microsoft-graph" : "smtp";
}

export function defaultReplyTo() {
  return process.env.EMAIL_REPLY_TO || CUSTOMER_SERVICE_EMAIL;
}

export function getDefaultFrom() {
  const name = process.env.EMAIL_FROM_NAME || "Hyve Promo";
  const address = isMicrosoftGraphConfigured()
    ? (process.env.MS_FROM_EMAIL || process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER)
    : (process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER);

  return `"${name}" <${address}>`;
}

/**
 * Acquire an OAuth 2.0 access token from Microsoft Entra using Client Credentials.
 */
async function getMicrosoftGraphToken() {
  if (msTokenCache.token && msTokenCache.expiresAt > Date.now()) {
    return msTokenCache.token;
  }

  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Microsoft 365 configuration is incomplete. Missing MS_TENANT_ID, MS_CLIENT_ID, or MS_CLIENT_SECRET.",
    );
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("grant_type", "client_credentials");
  params.append("scope", "https://graph.microsoft.com/.default");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to acquire Microsoft Graph token (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const expiresIn = Number(data.expires_in) || 3600;
  // Cache and refresh 5 minutes before expiration
  msTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
  };

  return msTokenCache.token;
}

/** Normalizes email recipients into Microsoft Graph recipient objects */
function formatRecipients(recipients) {
  if (!recipients) return [];
  const list = Array.isArray(recipients) ? recipients : String(recipients).split(",");
  return list
    .map((r) => String(r).trim())
    .filter(Boolean)
    .map((raw) => {
      const match = raw.match(/<([^>]+)>/);
      const address = match ? match[1].trim() : raw;
      const name = match ? raw.slice(0, raw.indexOf("<")).trim().replace(/^["']|["']$/g, "") : "";
      return {
        emailAddress: {
          address,
          ...(name ? { name } : {}),
        },
      };
    });
}

/** Normalizes attachments for Microsoft Graph fileAttachment objects */
function formatAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  return attachments
    .filter((a) => a && (a.content || a.path))
    .map((a) => {
      let contentBytes = "";
      if (Buffer.isBuffer(a.content)) {
        contentBytes = a.content.toString("base64");
      } else if (typeof a.content === "string") {
        contentBytes = Buffer.from(a.content).toString("base64");
      }
      return {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.filename || "attachment",
        contentType: a.contentType || "application/octet-stream",
        contentBytes,
      };
    });
}

/**
 * Sends email via Microsoft Graph API sendMail endpoint.
 */
async function sendViaMicrosoftGraph({
  to,
  cc,
  bcc,
  replyTo,
  subject,
  html,
  text,
  attachments = [],
}) {
  const token = await getMicrosoftGraphToken();
  const fromEmail =
    process.env.MS_FROM_EMAIL ||
    process.env.EMAIL_FROM_ADDRESS ||
    process.env.SMTP_USER;

  if (!fromEmail) {
    throw new Error(
      "Microsoft 365 sender mailbox is not configured (missing MS_FROM_EMAIL or EMAIL_FROM_ADDRESS).",
    );
  }

  const toRecipients = formatRecipients(to);
  if (!toRecipients.length) {
    throw new Error("Email recipient is required.");
  }

  const ccRecipients = formatRecipients(cc);
  const bccRecipients = formatRecipients(bcc);
  const replyToRecipients = formatRecipients(replyTo || defaultReplyTo());
  const graphAttachments = formatAttachments(attachments);

  const message = {
    subject: subject || "",
    body: {
      contentType: html ? "HTML" : "Text",
      content: html || text || "",
    },
    toRecipients,
    ...(ccRecipients.length ? { ccRecipients } : {}),
    ...(bccRecipients.length ? { bccRecipients } : {}),
    ...(replyToRecipients.length ? { replyTo: replyToRecipients } : {}),
    ...(graphAttachments.length ? { attachments: graphAttachments } : {}),
  };

  const sendMailUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`;

  const response = await fetch(sendMailUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, saveToSentItems: "true" }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Microsoft Graph sendMail failed (${response.status}): ${errorText}`);
  }

  const domain = fromEmail.split("@")[1] || "hyve.promo";
  const messageId = `<ms-graph-${Date.now()}@${domain}>`;
  const accepted = toRecipients.map((r) => r.emailAddress.address);

  // console.log("[EMAIL:SENT:MS_GRAPH]", {
  //   to: accepted.join(", "),
  //   subject,
  //   messageId,
  // });

  return {
    messageId,
    accepted,
    rejected: [],
    response: "202 Accepted via Microsoft Graph",
  };
}

/**
 * Returns the active mailer:
 * - If Microsoft 365 is configured (production), returns an adapter with sendMail via Microsoft Graph.
 * - Otherwise (development), returns the Nodemailer SMTP transporter (Gmail).
 */
export function resetMailer() {
  transporter = null;
}

export function getMailer() {
  if (isMicrosoftGraphConfigured()) {
    return {
      sendMail: async (options) => sendViaMicrosoftGraph(options),
      verify: async () => verifyMailer(),
    };
  }

  if (transporter) {
    return transporter;
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP configuration is incomplete.");
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });

  return transporter;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function verifyMailer() {
  if (isMicrosoftGraphConfigured()) {
    const token = await getMicrosoftGraphToken();
    const payload = decodeJwtPayload(token);
    const roles = Array.isArray(payload?.roles) ? payload.roles : [];

    if (roles.length > 0 && !roles.includes("Mail.Send")) {
      throw new Error(
        `Microsoft 365 token is missing the 'Mail.Send' permission. Granted roles: ${roles.join(", ")}. Please grant 'Mail.Send' (Application permission) in Azure Portal and click 'Grant admin consent'.`,
      );
    }
    return true;
  }

  const mailer = getMailer();
  return mailer.verify();
}

export async function sendMail({
  to,
  subject,
  html,
  text,
  replyTo,
  cc,
  bcc,
  attachments = [],
}) {
  if (!to) {
    throw new Error("Email recipient is required.");
  }

  const mailer = getMailer();

  const result = await mailer.sendMail({
    from: getDefaultFrom(),
    to,
    cc,
    bcc,
    replyTo,
    subject,
    html,
    text,
    attachments,
  });

  // console.log("[EMAIL:SENT]", {
  //   to,
  //   subject,
  //   messageId: result.messageId,
  // });

  return {
    ok: true,
    messageId: result.messageId,
  };
}