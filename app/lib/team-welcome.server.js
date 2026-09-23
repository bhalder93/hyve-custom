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

  const html = `
    <div style="font-family: -apple-system, 'Segoe UI', sans-serif; font-size: 15px; color: #0F172A; line-height: 1.6;">
      <p>${greeting}</p>
      <p>${opener}</p>
      <p>You can now see the company's orders, quotes, invoices and saved artwork, and place orders on the account.</p>
      <p style="margin: 24px 0;">
        <a href="${portalUrl}" style="background: #0F766E; color: #fff; text-decoration: none;
          padding: 12px 22px; border-radius: 8px; font-weight: 600; display: inline-block;">Sign in to your account</a>
      </p>
      <p style="color: #64748B; font-size: 13.5px;">
        Use this email address to sign in — we'll send you a code, so there is no password to set up.
      </p>
      <p style="color: #64748B; font-size: 13.5px;">Hyve Promo</p>
    </div>`;

  return sendEmail({
    to,
    subject: `You now have access to the ${companyName} account on Hyve Promo`,
    text,
    html,
  });
}
