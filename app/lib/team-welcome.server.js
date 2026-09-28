/**
 * The email that tells a colleague they have been added to the company account.
 *
 * There is no invitation to accept. Adding someone to a company in Shopify puts
 * them on the account straight away, and under new customer accounts they sign
 * in with a code sent to their address — no password to set, nothing to
 * confirm. So this email is a notification, not an invitation, and the account
 * works whether or not it arrives.
 *
 * Shopify will not send it for us: its B2B welcome email is denied to this app,
 * and its account-invite email only works on stores still using legacy customer
 * accounts. So the app sends it, over the same SMTP connection the quote email
 * and the order notifications use (SMTP_HOST / SMTP_USER / SMTP_PASS).
 */

/**
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} [opts.firstName]
 * @param {string} opts.companyName
 * @param {string} [opts.addedBy] the admin who added them, if known
 * @param {string} opts.portalUrl
 */
export async function sendTeamWelcomeEmail({ to, firstName, companyName, addedBy, portalUrl }) {
  // Loaded here rather than at the top so the portal's pages do not pull in the
  // SMTP client on every request.
  const { sendEmail } = await import("./mailer.server");

  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const opener = addedBy
    ? `${addedBy} has added you to the ${companyName} account on Hyve Promo.`
    : `You have been added to the ${companyName} account on Hyve Promo.`;

  const text = [
    greeting,
    "",
    opener,
    "",
    "You can now see the company's orders, quotes, invoices and saved artwork,",
    "and place orders on the account.",
    "",
    `Sign in here: ${portalUrl}`,
    "",
    "Use this email address to sign in — we'll send you a code, so there is no",
    "password to set up.",
    "",
    "Hyve Promo",
  ].join("\n");

  const { brandedEmail, escapeHtml } = await import("../utils/email.server");
  const paragraph = 'style="margin:0 0 14px; line-height:1.7; font-size:15px;"';
  const html = brandedEmail({
    title: "You've been added to the team",
    greeting: escapeHtml(greeting),
    body: `
      <p ${paragraph}>${escapeHtml(opener)}</p>
      <p ${paragraph}>You can now see the company's orders, quotes, invoices and saved artwork, and place orders on the account.</p>
      <div style="margin:22px 0;">
        <a href="${escapeHtml(portalUrl)}" style="display:inline-block; padding:14px 22px; background:#0f172a; color:#ffffff; text-decoration:none; border-radius:10px; font-size:14px; font-weight:700;">
          Sign in to your account
        </a>
      </div>
      <p style="margin:0; font-size:13px; line-height:1.6; color:#6B7280;">
        Use this email address to sign in. We'll send you a code, so there's no password to set up.
      </p>`,
    details: [["Company", escapeHtml(companyName)]],
  });

  return sendEmail({
    to,
    subject: `You now have access to the ${companyName} account on Hyve Promo`,
    text,
    html,
  });
}
