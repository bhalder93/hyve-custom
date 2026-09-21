import nodemailer from "nodemailer";

let transporter;

/**
 * Reuse a single Nodemailer transporter.
 */
export function getMailer() {
  if (transporter) {
    return transporter;
  }

  const port = Number(
    process.env.SMTP_PORT || 587,
  );

  const secure =
    String(
      process.env.SMTP_SECURE || "false",
    ).toLowerCase() === "true";

  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASS
  ) {
    throw new Error(
      "SMTP configuration is incomplete.",
    );
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

export async function verifyMailer() {
  const mailer = getMailer();

  return mailer.verify();
}

export function getDefaultFrom() {
  const name =
    process.env.EMAIL_FROM_NAME ||
    "Hyve Promo";

  const address =
    process.env.EMAIL_FROM_ADDRESS ||
    process.env.SMTP_USER;

  return `"${name}" <${address}>`;
}

export async function sendMail({
  to,
  subject,
  html,
  text,
  replyTo,
  cc,
  bcc,
}) {
  if (!to) {
    throw new Error(
      "Email recipient is required.",
    );
  }

  const mailer = getMailer();

  const result =
    await mailer.sendMail({
      from: getDefaultFrom(),

      to,
      cc,
      bcc,

      replyTo,

      subject,

      html,

      text,
    });

  console.log("[EMAIL:SENT]", {
    to,
    subject,
    messageId: result.messageId,
  });

  return {
    ok: true,
    messageId: result.messageId,
  };
}