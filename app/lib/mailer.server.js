/**
 * SMTP mailer (server-only) for sending the quote email with the PDF attached.
 * Configured via env vars:
 *   EMAIL_SERVICE       — nodemailer service preset, e.g. "gmail"
 *   EMAIL_USER          — the account that authenticates (also the From address)
 *   EMAIL_PASSWORD      — an app password (for Gmail, 2FA must be on)
 *   EMAIL_FROM_NAME     — optional display name (default "Hyve Promo")
 *
 * Note: Gmail forces the From address to the authenticated account (or a
 * verified "Send mail as" alias), so the sender will be EMAIL_USER.
 */
import nodemailer from "nodemailer";

let transporter = null;

function getTransport() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASSWORD;
  const service = process.env.EMAIL_SERVICE || "gmail";
  if (!user || !pass) {
    throw new Error("Email is not configured (missing EMAIL_USER / EMAIL_PASSWORD).");
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service,
      auth: { user, pass },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

/**
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.html]
 * @param {string} [opts.text]
 * @param {Buffer} [opts.pdfBuffer]
 * @param {string} [opts.filename]
 */
export async function sendQuoteEmail({ to, subject, html, text, pdfBuffer, filename }) {
  const transport = getTransport();
  const fromName = process.env.EMAIL_FROM_NAME || "Hyve Promo";
  const from = `${fromName} <${process.env.EMAIL_USER}>`;

  const attachments = pdfBuffer
    ? [{ filename: filename || "quote.pdf", content: pdfBuffer, contentType: "application/pdf" }]
    : [];

  return transport.sendMail({ from, to, subject, text, html, attachments });
}
