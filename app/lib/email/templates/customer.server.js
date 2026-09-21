import {
  customerEmailLayout,
} from "./layout.server";

import {
  orderItemsHtml,
} from "./order-items.server";

import {
  buildOrderStatusUrl,
  escapeHtml,
  formatDate,
} from "../email-utils.server";

/**
 * MSG-02
 * Artwork Received
 */
export function msg02ArtworkReceived({
  order,
}) {
  const statusUrl =
    buildOrderStatusUrl(
      order,
    );

  const body = `
    <p>
      Hi ${escapeHtml(
        order?.customer
          ?.displayName ||
          "there",
      )},
    </p>

    <p>
      We have received the artwork for your order.
    </p>

    <p>
      Our artwork team will prepare your digital proof.
      The target is to send your proof within
      <strong>48 hours</strong>.
    </p>

    ${orderItemsHtml(order)}

    <p>
      <strong>Current status:</strong>
      Artwork Received
    </p>

    <p>
      <strong>Next step:</strong>
      Digital proof preparation
    </p>

    ${
      statusUrl
        ? `
          <p>
            <a href="${escapeHtml(
              statusUrl,
            )}">
              View order status
            </a>
          </p>
        `
        : ""
    }
  `;

  return {
    subject:
      `Artwork received – ${order.name}`,

    html:
      customerEmailLayout({
        title:
          "We’ve received your artwork",
        preheader:
          "Your digital proof is now being prepared.",
        order,
        body,
      }),

    text:
      `We have received your artwork for ${order.name}. Your digital proof is targeted within 48 hours.`,
  };
}

/**
 * MSG-03
 * Proof Ready for Approval
 */
export function msg03ProofReady({
  order,
}) {
  const proofUrl =
    order?.proofUrl?.value;

  const statusUrl =
    buildOrderStatusUrl(
      order,
    );

  const body = `
    <p>
      Hi ${escapeHtml(
        order?.customer
          ?.displayName ||
          "there",
      )},
    </p>

    <div
      style="
        padding:18px;
        border:1px solid #ddd;
        margin:20px 0;
      "
    >
      <p style="margin-top:0">
        <strong>
          Your proof is ready for approval.
        </strong>
      </p>

      ${
        proofUrl
          ? `
            <p>
              <a
                href="${escapeHtml(
                  proofUrl,
                )}"
                style="
                  display:inline-block;
                  padding:12px 18px;
                  background:#111;
                  color:#fff;
                  text-decoration:none;
                "
              >
                View Proof
              </a>
            </p>
          `
          : ""
      }

      <p>
        To approve your proof,
        <strong>reply directly to this email</strong>.
      </p>

      <p style="margin-bottom:0">
        Your order will not move into production
        until your approval has been received and
        processed by the Hyve team.
      </p>
    </div>

    ${orderItemsHtml(order)}

    <p>
      <strong>Current status:</strong>
      Proof Sent
    </p>

    <p>
      <strong>Next step:</strong>
      Your approval
    </p>

    ${
      statusUrl
        ? `
          <p>
            <a href="${escapeHtml(
              statusUrl,
            )}">
              View order status
            </a>
          </p>
        `
        : ""
    }
  `;

  return {
    subject:
      `Proof ready for approval – ${order.name}`,

    replyTo:
      process.env
        .EMAIL_REPLY_TO_PROOF,

    html:
      customerEmailLayout({
        title:
          "Your proof is ready",
        preheader:
          "Review your proof and reply to this email to approve it.",
        order,
        body,
      }),

    text:
      `Your proof for ${order.name} is ready. ${
        proofUrl
          ? `View proof: ${proofUrl}. `
          : ""
      }Reply directly to this email to approve.`,
  };
}

/**
 * MSG-04
 * Proof Approval Reminder
 */
export function msg04ProofReminder({
  order,
  reminderDay,
}) {
  const proofUrl =
    order?.proofUrl?.value;

  const body = `
    <p>
      Hi ${escapeHtml(
        order?.customer
          ?.displayName ||
          "there",
      )},
    </p>

    <p>
      This is a reminder that we are still waiting
      for approval of the proof for
      <strong>${escapeHtml(
        order.name,
      )}</strong>.
    </p>

    ${
      proofUrl
        ? `
          <p>
            <a
              href="${escapeHtml(
                proofUrl,
              )}"
              style="
                display:inline-block;
                padding:12px 18px;
                background:#111;
                color:#fff;
                text-decoration:none;
              "
            >
              Review Proof
            </a>
          </p>
        `
        : ""
    }

    <p>
      To approve, simply reply directly to this email.
    </p>

    <p>
      Reminder:
      day ${Number(
        reminderDay,
      )}.
    </p>
  `;

  return {
    subject:
      `Reminder: proof approval required – ${order.name}`,

    replyTo:
      process.env
        .EMAIL_REPLY_TO_PROOF,

    html:
      customerEmailLayout({
        title:
          "Proof approval reminder",
        order,
        body,
      }),

    text:
      `Proof approval is still required for ${order.name}. Reply directly to this email to approve.`,
  };
}

/**
 * MSG-05
 * Proof Approved + In Production
 */
export function msg05ProofApproved({
  order,
}) {
  const dueAt =
    order
      ?.productionDueAt
      ?.value;

  const body = `
    <p>
      Hi ${escapeHtml(
        order?.customer
          ?.displayName ||
          "there",
      )},
    </p>

    <p>
      Your proof has been approved and your order
      has entered production.
    </p>

    ${
      dueAt
        ? `
          <p>
            <strong>
              Production target:
            </strong>
            ${escapeHtml(
              formatDate(
                dueAt,
              ),
            )}
          </p>
        `
        : ""
    }

    ${orderItemsHtml(order)}

    <p>
      <strong>Current status:</strong>
      Proof Approved / In Production
    </p>

    <p>
      <strong>Next step:</strong>
      Production Complete
    </p>
  `;

  return {
    subject:
      `Your order is in production – ${order.name}`,

    html:
      customerEmailLayout({
        title:
          "Your order is now in production",
        order,
        body,
      }),

    text:
      `Your proof for ${order.name} has been approved and production has started.${
        dueAt
          ? ` Production target: ${formatDate(
              dueAt,
            )}.`
          : ""
      }`,
  };
}

/**
 * MSG-07
 * Production Complete
 */
export function msg07ProductionComplete({
  order,
}) {
  const photoUrl =
    order
      ?.productionPhotoUrl
      ?.value;

  const body = `
    <p>
      Hi ${escapeHtml(
        order?.customer
          ?.displayName ||
          "there",
      )},
    </p>

    <p>
      Production for your order is complete.
    </p>

    ${
      photoUrl
        ? `
          <p>
            <a
              href="${escapeHtml(
                photoUrl,
              )}"
            >
              View your production photo
            </a>
          </p>
        `
        : ""
    }

    ${orderItemsHtml(order)}

    <p>
      <strong>Current status:</strong>
      Production Complete
    </p>

    <p>
      <strong>Next step:</strong>
      Shipping
    </p>
  `;

  return {
    subject:
      `Production complete – ${order.name}`,

    html:
      customerEmailLayout({
        title:
          "Production is complete",
        order,
        body,
      }),

    text:
      `Production for ${order.name} is complete.${
        photoUrl
          ? ` Production photo: ${photoUrl}`
          : ""
      }`,
  };
}