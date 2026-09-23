/**
 * The two emails a distributor application sends: a confirmation to the
 * applicant, and a notification to Hyve.
 */
import { internalNotifyTarget } from "./internal-notify.server";

function row(label, value) {
  return value
    ? `<tr><td style="padding:4px 14px 4px 0;color:#64748B;">${label}</td><td style="padding:4px 0;"><strong>${value}</strong></td></tr>`
    : "";
}

/**
 * Tells the applicant we have it, and when to expect an answer (B7).
 * Never throws — the application is already saved by this point.
 */
export async function sendApplicationEmails(admin, application) {
  const { shopName, to: internalTo } = await internalNotifyTarget(admin);
  const { sendEmail } = await import("./mailer.server");

  const company = application.companyName || "your company";
  const applicant = application.contactPerson || "";

  const confirmation = sendEmail({
    to: application.customerEmail,
    subject: `We've received your ${shopName} distributor application`,
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
    html: `
      <div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:#0F172A;line-height:1.6;">
        <p>${applicant ? `Hi ${applicant},` : "Hi,"}</p>
        <p>Thank you for applying to the ${shopName} distributor programme for <strong>${company}</strong>.</p>
        <p>Your application is under review. We will come back to you <strong>within seven business days</strong>,
           and if you are approved we will help you get set up.</p>
        <p style="color:#64748B;font-size:13.5px;">${shopName}</p>
      </div>`,
  });

  const internal = internalTo
    ? sendEmail({
        to: internalTo,
        subject: `New distributor application — ${company}`,
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
        html: `
          <div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:#0F172A;line-height:1.6;">
            <p><strong>${company}</strong> has applied to the distributor programme.</p>
            <table style="font-size:13.5px;border-collapse:collapse;">
              ${row("Contact", `${applicant || "—"} &lt;${application.customerEmail || "no email"}&gt;`)}
              ${row("Phone", application.contactPhone)}
              ${row("Based in", application.countryBased)}
              ${row("Business type", application.businessType)}
              ${row("Relation", application.relationToBusiness)}
              ${row("Preferred currency", application.preferredCurrency)}
              ${row("Markets", application.marketsSold)}
              ${row("Credit terms requested", application.requestCredit ? "Yes" : "No")}
            </table>
            <p style="color:#64748B;font-size:13px;">Review it in the Hyve app, under Distributors.</p>
          </div>`,
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
