/**
 * Tells Hyve a quote has been raised.
 *
 * Every quote is a sales lead, so one of these goes out whenever a quote is
 * created — from the cart, from a share link, or from the portal's own request
 * form. It never throws: the quote exists by the time this runs, and a mail
 * failure must not undo it.
 */
import { internalNotifyTarget } from "./internal-notify.server";

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
    const { brandedEmail, escapeHtml } = await import("../utils/email.server");
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
      html: brandedEmail({
        title: "New Quote",
        body: `
          <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
            Quote <strong>${escapeHtml(quote.ref)}</strong> has been raised for <strong>${escapeHtml(who)}</strong>.
          </p>
          ${
            quote.adminUrl
              ? `<div style="margin:22px 0;"><a href="${escapeHtml(quote.adminUrl)}" style="display:inline-block; padding:14px 22px; background:#0f172a; color:#ffffff; text-decoration:none; border-radius:10px; font-size:14px; font-weight:700;">Open the quote</a></div>`
              : ""
          }`,
        details: [
          ["Customer", escapeHtml(quote.customer || "—")],
          ["Email", escapeHtml(quote.email || "—")],
          ["Company", escapeHtml(quote.company || "—")],
          ["Items", escapeHtml(quote.items || "—")],
          ["Total", escapeHtml(quote.total || "—")],
          ["Raised from", escapeHtml(quote.source || "—")],
          ["Store", escapeHtml(shopName)],
        ],
      }),
    });
  } catch (error) {
    console.error("[quote] notification failed", error?.message || error);
  }
}
