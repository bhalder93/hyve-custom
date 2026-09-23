/**
 * Tells Hyve a quote has been raised.
 *
 * Every quote is a sales lead, so one of these goes out whenever a quote is
 * created — from the cart, from a share link, or from the portal's own request
 * form. It never throws: the quote exists by the time this runs, and a mail
 * failure must not undo it.
 */
import { internalNotifyTarget } from "./internal-notify.server";

function row(label, value) {
  return value
    ? `<tr><td style="padding:4px 14px 4px 0;color:#64748B;">${label}</td><td style="padding:4px 0;"><strong>${value}</strong></td></tr>`
    : "";
}

/**
 * @param {object} quote
 * @param {string} quote.ref        the quote number, as the customer sees it
 * @param {string} [quote.customer] who it is for
 * @param {string} [quote.email]    where it was sent
 * @param {string} [quote.company]
 * @param {string} [quote.total]
 * @param {string} [quote.items]
 * @param {string} [quote.source]   how it was raised
 * @param {string} [quote.adminUrl] the draft order in the Shopify admin
 */
export async function notifyQuoteRaised(admin, quote) {
  try {
    const { shopName, to } = await internalNotifyTarget(admin);
    if (!to) {
      console.warn("[quote] no internal address on the shop — notification skipped");
      return;
    }

    const { sendEmail } = await import("./mailer.server");
    const who = quote.company || quote.customer || quote.email || "a customer";

    await sendEmail({
      to,
      subject: `New quote ${quote.ref} — ${who}`,
      text: [
        `Quote ${quote.ref} has been raised for ${who}.`,
        "",
        `Customer: ${quote.customer || "—"}`,
        `Email:    ${quote.email || "—"}`,
        `Company:  ${quote.company || "—"}`,
        `Items:    ${quote.items || "—"}`,
        `Total:    ${quote.total || "—"}`,
        `Raised:   ${quote.source || "—"}`,
        "",
        quote.adminUrl ? `Open it: ${quote.adminUrl}` : "",
      ]
        .filter((line) => line !== null)
        .join("\n"),
      html: `
        <div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:#0F172A;line-height:1.6;">
          <p>Quote <strong>${quote.ref}</strong> has been raised for <strong>${who}</strong>.</p>
          <table style="font-size:13.5px;border-collapse:collapse;">
            ${row("Customer", quote.customer)}
            ${row("Email", quote.email)}
            ${row("Company", quote.company)}
            ${row("Items", quote.items)}
            ${row("Total", quote.total)}
            ${row("Raised from", quote.source)}
          </table>
          ${quote.adminUrl ? `<p style="margin-top:16px;"><a href="${quote.adminUrl}">Open the quote</a></p>` : ""}
          <p style="color:#64748B;font-size:13px;">${shopName}</p>
        </div>`,
    });
  } catch (error) {
    console.error("[quote] notification failed", error?.message || error);
  }
}
