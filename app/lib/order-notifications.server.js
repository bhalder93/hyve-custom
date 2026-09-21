import {
  sendMail,
} from "./email/mailer.server";

import {
  parseEmailList,
} from "./email/email-utils.server";

import {
  msg02ArtworkReceived,
  msg03ProofReady,
  msg04ProofReminder,
  msg05ProofApproved,
  msg07ProductionComplete,
} from "./email/templates/customer.server";

import {
  msg10ArtworkMissing,
  msg11ProofNotSent,
  msg12ProofNotApproved,
  msg13NotInProduction,
  msg14ProductionOverdue,
  msg15NotShipped,
  msg16NoDeliveryScan,
  msg17OrderOnHold,
} from "./email/templates/internal.server";

function customerEmail(
  order,
) {
  return (
    order?.customer
      ?.defaultEmailAddress
      ?.emailAddress ||
    null
  );
}

function customerTemplate(
  template,
  order,
  data,
) {
  switch (template) {
    case "MSG-02":
      return msg02ArtworkReceived({
        order,
      });

    case "MSG-03":
      return msg03ProofReady({
        order,
      });

    case "MSG-04":
      return msg04ProofReminder({
        order,
        reminderDay:
          data?.reminderDay,
      });

    case "MSG-05":
      return msg05ProofApproved({
        order,
      });

    case "MSG-07":
      return msg07ProductionComplete({
        order,
      });

    default:
      throw new Error(
        `Unknown customer email template: ${template}`,
      );
  }
}

export async function sendCustomerStatusEmail({
  shop,
  order,
  template,
  data = {},
}) {
  const to =
    customerEmail(order);

  if (!to) {
    console.warn(
      "[EMAIL] Customer email missing",
      {
        shop,
        order:
          order?.name,
        template,
      },
    );

    return {
      ok: false,
      skipped: true,
      reason:
        "customer_email_missing",
    };
  }

  const email =
    customerTemplate(
      template,
      order,
      data,
    );

  return sendMail({
    to,

    subject:
      email.subject,

    html:
      email.html,

    text:
      email.text,

    replyTo:
      email.replyTo,
  });
}

function getInternalRecipients(
  template,
) {
  switch (template) {
    case "MSG-10":
    case "MSG-12":
    case "MSG-17":
      return parseEmailList(
        process.env
          .HYVE_CS_EMAILS,
      );

    case "MSG-11":
      return [
        ...parseEmailList(
          process.env
            .HYVE_ARTWORK_EMAILS,
        ),

        ...parseEmailList(
          process.env
            .HYVE_CS_EMAILS,
        ),
      ];

    case "MSG-13":
    case "MSG-14":
    case "MSG-15":
      return parseEmailList(
        process.env
          .HYVE_PRODUCTION_EMAILS,
      );

    case "MSG-16":
      return [
        ...parseEmailList(
          process.env
            .HYVE_CS_EMAILS,
        ),

        ...parseEmailList(
          process.env
            .HYVE_PRODUCTION_EMAILS,
        ),
      ];

    default:
      return [];
  }
}

function internalTemplate(
  template,
  args,
) {
  switch (template) {
    case "MSG-10":
      return msg10ArtworkMissing(
        args,
      );

    case "MSG-11":
      return msg11ProofNotSent(
        args,
      );

    case "MSG-12":
      return msg12ProofNotApproved(
        args,
      );

    case "MSG-13":
      return msg13NotInProduction(
        args,
      );

    case "MSG-14":
      return msg14ProductionOverdue(
        args,
      );

    case "MSG-15":
      return msg15NotShipped(
        args,
      );

    case "MSG-16":
      return msg16NoDeliveryScan(
        args,
      );

    case "MSG-17":
      return msg17OrderOnHold(
        args,
      );

    default:
      throw new Error(
        `Unknown internal email template: ${template}`,
      );
  }
}

export async function sendInternalAlertEmail({
  shop,
  order,
  template,
  recipients,
  data = {},
}) {
  const to =
    recipients?.length
      ? recipients
      : getInternalRecipients(
          template,
        );

  if (!to.length) {
    console.warn(
      "[EMAIL] Internal recipient missing",
      {
        template,
        order:
          order?.name,
      },
    );

    return {
      ok: false,
      skipped: true,
      reason:
        "recipient_missing",
    };
  }

  const email =
    internalTemplate(
      template,
      {
        order,

        target:
          data.target,

        reason:
          data.reason,

        orderAdminUrl:
          data.orderAdminUrl,
      },
    );

  return sendMail({
    to,

    subject:
      email.subject,

    html:
      email.html,

    text:
      email.text,
  });
}