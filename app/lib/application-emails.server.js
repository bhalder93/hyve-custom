/**
 * The two emails a distributor application sends: a confirmation to the
 * applicant, and a notification to Hyve. Both use the same branded frame as
 * the order emails.
 */
import { internalNotifyTarget } from "./internal-notify.server";
import { brandedEmail, escapeHtml } from "../utils/email.server";

const PARAGRAPH = 'style="margin:0 0 14px; line-height:1.7; font-size:15px;"';

/**
 * Tells the applicant we have it, and when to expect an answer (B7).
 * Never throws — the application is already saved by this point.
 */
export async function sendApplicationEmails(admin, application) {
  const { shopName, to: internalTo } = await internalNotifyTarget(admin);
  const { sendEmail } = await import("./mailer.server");

  const company = application.companyName || "your company";
  const applicant = application.contactPerson || "";
  const submitted = new Date().toLocaleDateString("en-SG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Singapore",
  });

  const confirmation = sendEmail({
    to: application.customerEmail,
    subject: `Application Received - ${shopName} distributor programme`,
    text: [
      applicant ? `Hi ${applicant},` : "Hi,",
      "",
      `Thank you for applying to the ${shopName} distributor programme for ${company}.`,
      "",
      "Your application is under review. We will come back to you within seven",
      "business days, and if you are approved we will help you get set up.",
      "",
      shopName,
    ].join("\n"),
    html: brandedEmail({
      title: "Application Received",
      greeting: applicant ? `Hi ${escapeHtml(applicant)},` : "Hi,",
      body: `
        <p ${PARAGRAPH}>
          Thank you for applying to the ${escapeHtml(shopName)} distributor programme for
          <strong>${escapeHtml(company)}</strong>.
        </p>
        <p ${PARAGRAPH}>
          Your application is under review. We will come back to you
          <strong>within seven business days</strong>, and if you are approved we will help you get set up.
        </p>`,
      details: [
        ["Company", escapeHtml(company)],
        ["Submitted", escapeHtml(submitted)],
      ],
    }),
  });

  const internal = internalTo
    ? sendEmail({
        to: internalTo,
        subject: `New Distributor Application - ${company}`,
        text: [
          `${company} has applied to the distributor programme.`,
          "",
          `Contact:  ${applicant || "—"} (${application.customerEmail || "no email"})`,
          `Phone:    ${application.contactPhone || "—"}`,
          `Based in: ${application.countryBased || "—"}`,
          `Type:     ${application.businessType || "—"}, ${application.relationToBusiness || "—"}`,
          `Currency: ${application.preferredCurrency || "—"}`,
          `Markets:  ${application.marketsSold || "—"}`,
          `Credit terms requested: ${application.requestCredit ? "yes" : "no"}`,
          "",
          "Review it in the Hyve app, under Distributors.",
        ].join("\n"),
        html: brandedEmail({
          title: "New Distributor Application",
          body: `
            <p ${PARAGRAPH}>
              <strong>${escapeHtml(company)}</strong> has applied to the distributor programme.
              Review it in the Hyve app, under Distributors.
            </p>`,
          details: [
            ["Contact", escapeHtml(`${applicant || "—"} <${application.customerEmail || "no email"}>`)],
            ["Phone", escapeHtml(application.contactPhone || "—")],
            ["Based in", escapeHtml(application.countryBased || "—")],
            ["Business type", escapeHtml(application.businessType || "—")],
            ["Relation", escapeHtml(application.relationToBusiness || "—")],
            ["Preferred currency", escapeHtml(application.preferredCurrency || "—")],
            ["Markets", escapeHtml(application.marketsSold || "—")],
            ["Credit terms requested", application.requestCredit ? "Yes" : "No"],
          ],
        }),
      })
    : Promise.resolve();

  const [applicantResult, internalResult] = await Promise.allSettled([confirmation, internal]);

  if (applicantResult.status === "rejected") {
    console.error("[application] confirmation email failed", applicantResult.reason?.message || applicantResult.reason);
  }
  if (internalResult.status === "rejected") {
    console.error("[application] internal notification failed", internalResult.reason?.message || internalResult.reason);
  }
  if (!internalTo) {
    console.warn("[application] no internal address on the shop — notification skipped");
  }
}

const PRIMARY_DOMAIN = `#graphql
  query ApplicationShopDomain {
    shop { primaryDomain { url } }
  }`;

/**
 * Tells the applicant the outcome once Hyve decides (HYV-110). Approved: they
 * can sign in to their distributor account, and who their sales contact is.
 * Declined: a short, neutral note. The reason staff record stays internal,
 * since the wording of a decline is still open (OD18).
 * Never throws — the decision is already saved by this point. Says whether
 * it went, so staff can see it on the record and send it again.
 *
 * @param {{approved:boolean, salesRep?:string, salesRepEmail?:string, hasCatalog?:boolean}} outcome
 * @returns {Promise<boolean>}
 */
export async function sendApplicationDecisionEmail(admin, application, outcome) {
  const to = application.customer_email || application.customerEmail;
  if (!to) return false;

  try {
    const { shopName } = await internalNotifyTarget(admin);
    const { sendEmail } = await import("./mailer.server");
    const company = application.company_name || application.companyName || "your company";
    const applicant = application.contact_person || application.contactPerson || "";
    const greeting = applicant ? `Hi ${escapeHtml(applicant)},` : "Hi,";

    if (outcome.approved) {
      const response = await admin.graphql(PRIMARY_DOMAIN);
      const body = await response.json();
      const accountUrl = new URL("/apps/account", body?.data?.shop?.primaryDomain?.url || "https://hyve.promo").toString();
      const rep = outcome.salesRep
        ? `Your sales representative is <strong>${escapeHtml(outcome.salesRep)}</strong>${
            outcome.salesRepEmail ? ` (${escapeHtml(outcome.salesRepEmail)})` : ""
          }, and they'll be in touch to help you get started.`
        : "";
      // Distributor pricing only exists once a tier catalog is on the company.
      const signIn = outcome.hasCatalog
        ? "Sign in to see your distributor pricing, place orders and manage quotes"
        : "Sign in to place orders and manage quotes";

      await sendEmail({
        to,
        subject: `Application Approved - ${shopName} distributor programme`,
        text: [
          applicant ? `Hi ${applicant},` : "Hi,",
          "",
          `${company} is now set up as a ${shopName} distributor.`,
          `${signIn}:`,
          accountUrl,
          outcome.salesRep ? `\nYour sales representative is ${outcome.salesRep}${outcome.salesRepEmail ? ` (${outcome.salesRepEmail})` : ""}.` : "",
        ].join("\n"),
        html: brandedEmail({
          title: "Application Approved",
          greeting,
          body: `
            <p ${PARAGRAPH}>
              Good news: <strong>${escapeHtml(company)}</strong> is now set up as a ${escapeHtml(shopName)} distributor.
              ${signIn}.
            </p>
            ${rep ? `<p ${PARAGRAPH}>${rep}</p>` : ""}
            <div style="margin:22px 0;">
              <a href="${escapeHtml(accountUrl)}" style="display:inline-block; padding:14px 22px; background:#0f172a; color:#ffffff; text-decoration:none; border-radius:10px; font-size:14px; font-weight:700;">
                Go to your account
              </a>
            </div>`,
          details: [["Company", escapeHtml(company)]],
        }),
      });
      return true;
    }

    await sendEmail({
      to,
      subject: `Your ${shopName} distributor application`,
      text: [
        applicant ? `Hi ${applicant},` : "Hi,",
        "",
        `Thank you for your interest in the ${shopName} distributor programme.`,
        `We've reviewed the application for ${company}, and we're unable to approve it at this time.`,
        "If you have any questions, just reply to this email.",
        "",
        shopName,
      ].join("\n"),
      html: brandedEmail({
        title: "Application Update",
        greeting,
        body: `
          <p ${PARAGRAPH}>
            Thank you for your interest in the ${escapeHtml(shopName)} distributor programme. We've reviewed the
            application for <strong>${escapeHtml(company)}</strong>, and we're unable to approve it at this time.
          </p>
          <p ${PARAGRAPH}>If you have any questions, just reply to this email.</p>`,
        details: [["Company", escapeHtml(company)]],
      }),
    });
    return true;
  } catch (error) {
    console.error("[application] decision email failed", error?.message || error);
    return false;
  }
}
