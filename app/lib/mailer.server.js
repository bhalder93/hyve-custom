/**
 * Outbound email for the portal — the quote PDF and the team welcome note.
 *
 * The SMTP connection itself lives in ./email/mailer.server.js, which the order
 * notifications also use, so there is one pooled transport and one set of
 * settings (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, plus
 * EMAIL_FROM_NAME and EMAIL_FROM_ADDRESS for the sender).
 *
 * This file adds what that one does not do: attachments.
 */
import { getMailer, getDefaultFrom } from "./email/mailer.server";

/**
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.html]
 * @param {string} [opts.text]
 * @param {Array} [opts.attachments]
 */
export async function sendEmail({ to, subject, html, text, attachments = [] }) {
  if (!to) throw new Error("Email recipient is required.");

  const result = await getMailer().sendMail({
    from: getDefaultFrom(),
    to,
    subject,
    text,
    html,
    attachments,
  });

  console.log("[EMAIL:SENT]", { to, subject, messageId: result.messageId });
  return result;
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
  return sendEmail({
    to,
    subject,
    html,
    text,
    attachments: pdfBuffer
      ? [{ filename: filename || "quote.pdf", content: pdfBuffer, contentType: "application/pdf" }]
      : [],
  });
}
