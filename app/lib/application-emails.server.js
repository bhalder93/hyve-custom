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
