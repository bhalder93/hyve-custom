import { formatDay, singaporeDateKey } from "./date.js";
import { formatDateTime as formatDate } from "./date.js";
// app/utils/email.server.js

// One SMTP connection for the whole app, shared with the quote and team emails
// so there is a single pooled transport and a single set of settings.
import { getMailer, getDefaultFrom, defaultReplyTo, CUSTOMER_SERVICE_EMAIL } from "../lib/email/mailer.server.js";
import { customerStatusLabel } from "../lib/portal.server.js";


const BRAND = {
  name: "HYVE",
  supportEmail: CUSTOMER_SERVICE_EMAIL,
  logoUrl: "https://hyve.promo/cdn/shop/files/Image_Hyve.Promo.png",
  primaryText: "#111827",
  secondaryText: "#6B7280",
  border: "#E5E7EB",
  background: "#F7F7F8",
  card: "#FFFFFF",
  gradient:
    "linear-gradient(90deg, #A3EA6E, #5EEAD4)",
};


export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}



function getAttributeValue(lineItem, keyName) {
  const match = (lineItem.customAttributes || []).find(
    (attribute) => String(attribute.key || "").trim().toLowerCase() === keyName.trim().toLowerCase(),
  );

  return match?.value?.trim() || "";
}

function getDecoration(item) {
  const imprintLocations = getAttributeValue(
    item,
    "Imprint Locations",
  );

  if (imprintLocations) {
    return imprintLocations;
  }

  const imprint = getAttributeValue(
    item,
    "_imprint",
  );

  if (imprint) {
    try {
      const parsed = JSON.parse(imprint);

      if (parsed?.method) {
        return parsed.method;
      }
    } catch {
      //
    }
  }

  return "";
}

function getArtworkState(item) {
  return getAttributeValue(item, "Artwork");
}

function getProductImage(item) {
  return (
    item?.image?.url ||
    item?.variant?.image?.url ||
    item?.product?.featuredImage?.url ||
    item?.imageUrl ||
    ""
  );
}

function getVariantDetails(item) {
  const values = [];

  if (item.variantTitle && item.variantTitle !== "Default Title") {
    values.push(item.variantTitle);
  }

  const color =
    getAttributeValue(item, "Color") ||
    getAttributeValue(item, "Colour");

  if (color && !values.includes(color)) {
    values.push(color);
  }

  return values.join(" • ");
}

function getQty(item) {
  return Number(item.quantity || 1);
}

function lineItemsSection(lineItems = []) {
  if (!lineItems.length) {
    return "";
  }

  const itemsHtml = lineItems
    .map((item) => {
      const imageUrl = getProductImage(item);
      const variantDetails = getVariantDetails(item);
      const decoration = getDecoration(item);
      const artworkState = getArtworkState(item);
      const qty = getQty(item);

      return `
        <tr>
          <td style="padding:0 0 12px 0;">
            <table
              width="100%"
              cellspacing="0"
              cellpadding="0"
              style="
                border-collapse:separate;
                border-spacing:0;
                background:${BRAND.card};
                border:1px solid ${BRAND.border};
                border-radius:12px;
              "
            >
              <tr>
                <td style="padding:14px;">
                  <table width="100%" cellspacing="0" cellpadding="0">
                    <tr>
                      <td style="width:72px; vertical-align:top;">
                        ${imageUrl
          ? `
                              <img
                                src="${escapeHtml(imageUrl)}"
                                alt="${escapeHtml(item.title || "Product")}"
                                width="56"
                                height="56"
                                style="
                                  width:56px;
                                  height:56px;
                                  border-radius:10px;
                                  object-fit:cover;
                                  display:block;
                                  border:1px solid ${BRAND.border};
                                  background:#ffffff;
                                "
                              />
                            `
          : `
                              <div
                                style="
                                  width:56px;
                                  height:56px;
                                  border-radius:10px;
                                  border:1px solid ${BRAND.border};
                                  background:#f3f4f6;
                                "
                              ></div>
                            `
        }
                      </td>

                      <td style="vertical-align:top;">
                        <div
                          style="
                            font-size:16px;
                            line-height:1.45;
                            font-weight:600;
                            color:${BRAND.primaryText};
                          "
                        >
                          ${escapeHtml(item.title || "Product")}
                          <span style="font-weight:500;">
                            × ${escapeHtml(qty)}
                          </span>
                        </div>

                        ${variantDetails
          ? `
                              <div
                                style="
                                  margin-top:4px;
                                  font-size:14px;
                                  line-height:1.5;
                                  color:${BRAND.secondaryText};
                                "
                              >
                                ${escapeHtml(variantDetails)}
                              </div>
                            `
          : ""
        }

                        ${item.sku
          ? `
                              <div
                                style="
                                  margin-top:4px;
                                  font-size:13px;
                                  line-height:1.5;
                                  color:${BRAND.secondaryText};
                                "
                              >
                                SKU: ${escapeHtml(item.sku)}
                              </div>
                            `
          : ""
        }

                        ${decoration
          ? `
                              <div
                                style="
                                  margin-top:8px;
                                  font-size:13px;
                                  line-height:1.5;
                                  color:${BRAND.primaryText};
                                "
                              >
                                <strong>Decoration:</strong>
                                ${escapeHtml(decoration)}
                              </div>
                            `
          : ""
        }

                        ${artworkState
          ? `
                              <div
                                style="
                                  margin-top:4px;
                                  font-size:13px;
                                  line-height:1.5;
                                  color:${BRAND.primaryText};
                                "
                              >
                                <strong>Artwork:</strong>
                                ${escapeHtml(artworkState)}
                              </div>
                            `
          : ""
        }
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div style="margin-top:28px;">
      <div
        style="
          font-size:18px;
          line-height:1.4;
          font-weight:700;
          color:${BRAND.primaryText};
          margin:0 0 14px 0;
        "
      >
        Order items
      </div>

      <table width="100%" cellspacing="0" cellpadding="0">
        ${itemsHtml}
      </table>
    </div>
  `;
}

export const CUSTOMER_ORDERS_URL = "https://hyve.promo/apps/account/orders";

function orderActionButton(url = CUSTOMER_ORDERS_URL) {
  return `
    <div style="margin-top:20px;">
      <a
        href="${escapeHtml(url)}"
        style="
          display:inline-block;
          padding:12px 22px;
          background:#0f172a;
          color:#ffffff !important;
          text-decoration:none;
          border-radius:10px;
          font-size:14px;
          font-weight:700;
          font-family:Arial,Helvetica,sans-serif;
        "
      >
        View your order
      </a>
    </div>
  `;
}

/**
 * An order email: the branded frame with the order's lines and its number and
 * date underneath, along with a "View your order" button.
 */
function customerLayout({
  title,
  customerName,
  orderName,
  orderDate,
  body,
  lineItems = [],
  orderUrl = CUSTOMER_ORDERS_URL,
}) {
  return brandedEmail({
    title,
    greeting: `Hi ${escapeHtml(customerName || "Customer")},`,
    body: `${body}

                    ${lineItemsSection(lineItems)}`,
    details: [
      ["Order", escapeHtml(orderName)],
      ["Order date", escapeHtml(formatDate(orderDate))],
    ],
    detailsAction: orderActionButton(orderUrl),
  });
}

/**
 * The one Hyve email frame: header, title, greeting, body, an optional block of
 * details under a rule, and the support footer. Every email the app sends to a
 * customer or to Hyve staff uses it, so they all look the same.
 *
 * @param {object} opts
 * @param {string} opts.title plain text, escaped here
 * @param {?string} [opts.greeting] HTML, already escaped; omitted when null
 * @param {string} opts.body HTML
 * @param {Array<[string, string]>} [opts.details] label and HTML value rows
 * @param {?string} [opts.detailsAction] HTML action button under the details
 */
// internal: a staff email (alerts, digests, notices), without the customer
// help footer (HYV-127).
export function brandedEmail({ title, greeting = null, body, details = [], detailsAction = null, internal = false }) {
  const detailRows = details
    .map(
      ([label, value]) => `
                          <strong style="color:${BRAND.primaryText};">${escapeHtml(label)}:</strong>
                          ${value}`,
    )
    .join(`
                          <br />`);

  return `
    <!doctype html>
    <html>
      <body
        style="
          margin:0;
          padding:0;
          background:${BRAND.background};
          font-family:Arial,Helvetica,sans-serif;
          color:${BRAND.primaryText};
        "
      >
        <table
          width="100%"
          cellspacing="0"
          cellpadding="0"
          style="padding:24px 12px;"
        >
          <tr>
            <td align="center">
              <table
                width="100%"
                cellspacing="0"
                cellpadding="0"
                style="
                  max-width:680px;
                  background:#ffffff;
                  border-radius:16px;
                  overflow:hidden;
                "
              >
                <!-- Header -->
                <tr>
                  <td
                    style="
                      background:#A3EA6E;
                      background-image:${BRAND.gradient};
                      padding:22px 28px;
                    "
                  >
                    <table width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="vertical-align:middle;">
                          <img
                            src="${escapeHtml(BRAND.logoUrl)}"
                            alt="Hyve"
                            style="
                              max-height:44px;
                              width:auto;
                              display:block;
                            "
                          />
                        </td>

                        <td
                          align="right"
                          style="
                            vertical-align:middle;
                            color:#0f172a;
                            font-size:12px;
                            font-weight:600;
                          "
                        >
                          Promotional Products
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Content -->
                <tr>
                  <td style="padding:32px 28px 24px;">
                    <div
                      style="
                        font-size:28px;
                        line-height:1.25;
                        font-weight:700;
                        color:${BRAND.primaryText};
                        margin:0 0 18px;
                      "
                    >
                      ${escapeHtml(title)}
                    </div>

                    ${greeting ? `<p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
                      ${greeting}
                    </p>` : ""}

                    ${body}

                    ${detailRows || detailsAction ? `<table
                      width="100%"
                      cellspacing="0"
                      cellpadding="0"
                      style="
                        margin-top:28px;
                        border-top:1px solid ${BRAND.border};
                        padding-top:18px;
                      "
                    >
                      <tr>
                        <td
                          style="
                            font-size:13px;
                            line-height:1.7;
                            color:${BRAND.secondaryText};
                            padding-top:18px;
                          "
                        >${detailRows}
                        ${detailsAction ? detailsAction : ""}
                        </td>
                      </tr>
                    </table>` : ""}
                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td
                    style="
                      padding:20px 28px 28px;
                      background:#fafafa;
                      border-top:1px solid ${BRAND.border};
                    "
                  >
                    ${internal ? "" : `
                    <div
                      style="
                        font-size:13px;
                        line-height:1.7;
                        color:${BRAND.secondaryText};
                      "
                    >
                      Need help? Contact us at
                      <a
                        href="mailto:${BRAND.supportEmail}"
                        style="
                          color:#0f766e;
                          text-decoration:none;
                          font-weight:600;
                        "
                      >
                        ${BRAND.supportEmail}
                      </a>
                    </div>
                    `}

                    <div
                      style="
                        margin-top:8px;
                        font-size:12px;
                        line-height:1.6;
                        color:${BRAND.secondaryText};
                      "
                    >
                      © ${singaporeDateKey().slice(0, 4)} Hyve Promo. All rights reserved.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  replyTo,
  attachments,
}) {
  if (!to) {
    throw new Error("Email recipient is required.");
  }

  // Falls back to the authenticated mailbox when no from address is set,
  // rather than refusing to send.
  const result = await getMailer().sendMail({
    from: getDefaultFrom(),
    to,
    subject,
    html,
    text,
    attachments,
    replyTo: replyTo || defaultReplyTo(),
  });

  if (!result.accepted?.length) {
    throw new Error(`SMTP did not accept email for ${to}.`);
  }

  return {
    messageId: result.messageId,
    accepted: result.accepted || [],
    rejected: result.rejected || [],
  };
}

/* -------------------------------------------------------------------------- */
/* MSG-02 Artwork Received                                                    */
/* -------------------------------------------------------------------------- */

export async function sendArtworkReceivedEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  lineItems = [],
  orderUrl,
}) {
  const html = customerLayout({
    title: customerStatusLabel("artwork-received"),
    customerName,
    orderName,
    orderDate,
    lineItems,
    orderUrl,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        We have received the artwork information for your order.
      </p>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Our artwork team will now prepare your Artwork Proof for review.
      </p>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Your Artwork Proof will be prepared and sent to you within 48 hours for review and approval.
      </p>

      <p style="margin:0; line-height:1.7; font-size:15px;">
        We will contact you again as soon as your Artwork Proof is ready.
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `${customerStatusLabel("artwork-received")} - ${orderName}`,
    html,
    text: `Artwork received for ${orderName}. Our team will prepare and send your Artwork Proof within 48 hours for review and approval.\n\nView your order: ${orderUrl || CUSTOMER_ORDERS_URL}`,
  });
}

/* -------------------------------------------------------------------------- */
/* MSG-03 Proof Sent                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Approve Proof and Request Changes, as links that work without signing in
 * (proof.server.js). Shared by the proof email and its reminders.
 */
function decisionButtons(approveUrl, changesUrl) {
  return `
      <div style="margin:0 0 22px;">
        <a
          href="${escapeHtml(approveUrl)}"
          style="
            display:inline-block;
            margin:0 8px 8px 0;
            padding:14px 22px;
            background:${BRAND.gradient};
            background-color:#A3EA6E;
            color:#0A1414;
            text-decoration:none;
            border-radius:10px;
            font-size:14px;
            font-weight:700;
          "
        >
          Approve 
        </a>
        <a
          href="${escapeHtml(changesUrl)}"
          style="
            display:inline-block;
            margin:0 0 8px;
            padding:13px 21px;
            background:#ffffff;
            color:#0f172a;
            text-decoration:none;
            border:1px solid #0f172a;
            border-radius:10px;
            font-size:14px;
            font-weight:700;
          "
        >
          Request Changes
        </a>
      </div>
`;
}

export async function sendProofSentEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  proofUrl,
  proofVersion,
  approveUrl,
  changesUrl,
  lineItems = [],
  orderUrl,
}) {
  if (!proofUrl) {
    throw new Error("Proof URL is required.");
  }
  if (!approveUrl || !changesUrl) {
    throw new Error("Approve and Request changes links are required.");
  }

  const html = customerLayout({
    title: customerStatusLabel("proof-sent"),
    customerName,
    orderName,
    orderDate,
    lineItems,
    orderUrl,
    body: `
      <div
        style="
          padding:16px;
          background:#ecfeff;
          border:1px solid #c7f9f1;
          border-radius:12px;
          margin-bottom:20px;
        "
      >
        <div style="font-size:15px; line-height:1.6; color:${BRAND.primaryText};">
          <strong>Action required:</strong>
          Please review your Artwork Proof, then approve it or request changes with the buttons below.
          No sign-in needed.
        </div>
      </div>

      ${/[.](jpg|jpeg|png|webp|gif|bmp)$/i.test((proofUrl || "").split("?")[0].split("#")[0].trim()) ? `
        <div style="margin:22px 0;">
          <a href="${escapeHtml(proofUrl)}" target="_blank" style="display: block;">
            <img src="${escapeHtml(proofUrl)}" alt="Artwork Proof" style="max-width: 100%; max-height: 500px; border-radius: 8px; border: 1px solid #e2e8f0; display: block;" />
          </a>
        </div>
      ` : ''}

      <div style="margin:22px 0;">
        <a
          href="${escapeHtml(proofUrl)}"
          style="
            display:inline-block;
            padding:14px 22px;
            background:#0f172a;
            color:#ffffff;
            text-decoration:none;
            border-radius:10px;
            font-size:14px;
            font-weight:700;
          "
        >
          View Artwork Proof
        </a>
      </div>

      ${decisionButtons(approveUrl, changesUrl)}

      <p style="margin:0; line-height:1.7; font-size:15px;">
        <strong>Artwork Proof version:</strong>
        ${escapeHtml(proofVersion)}
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `${customerStatusLabel("proof-sent")} - ${orderName}`,
    html,
    text: ` Hi ${customerName || "there"},

${customerStatusLabel("proof-sent")} - ${orderName}

Action required: Please review your Artwork Proof, then approve it or request changes using the links below. No sign-in needed.

Artwork Proof: ${proofUrl}

Approve Artwork Proof: ${approveUrl}

Request Changes: ${changesUrl}

Artwork Proof version: ${proofVersion || "1"}

View your order: ${orderUrl || CUSTOMER_ORDERS_URL} `.trim(),
    replyTo: process.env.EMAIL_REPLY_TO,
  });
}

/* -------------------------------------------------------------------------- */
/* MSG-04 Proof Reminder                                                      */
/* -------------------------------------------------------------------------- */

export async function sendProofReminderEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  proofUrl,
  proofVersion,
  approveUrl,
  changesUrl,
  reminderDay,
  lineItems = [],
  orderUrl,
}) {
  if (!approveUrl || !changesUrl) {
    throw new Error("Approve and Request changes links are required.");
  }

  const html = customerLayout({
    title: "Reminder: your Artwork Proof is awaiting approval",
    customerName,
    orderName,
    orderDate,
    lineItems,
    orderUrl,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        This is a reminder that Artwork Proof version
        <strong>${escapeHtml(proofVersion)}</strong>
        is still awaiting your approval.
      </p>

      <div style="margin:22px 0;">
        <a
          href="${escapeHtml(proofUrl)}"
          style="
            display:inline-block;
            padding:14px 22px;
            background:#0f172a;
            color:#ffffff;
            text-decoration:none;
            border-radius:10px;
            font-size:14px;
            font-weight:700;
          "
        >
          Review Artwork Proof
        </a>
      </div>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Approve it or request changes with the buttons below. No sign-in needed.
      </p>

      ${decisionButtons(approveUrl, changesUrl)}

      <p style="margin:0; font-size:13px; color:${BRAND.secondaryText};">
        Reminder day: ${escapeHtml(reminderDay)}
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `Artwork Proof reminder - ${orderName}`,
    html,
    text: `Reminder: proof version ${proofVersion} for ${orderName} is awaiting approval. View: ${proofUrl}\nApprove: ${approveUrl}\nRequest changes: ${changesUrl}\n\nView your order: ${orderUrl || CUSTOMER_ORDERS_URL}`,
    replyTo: process.env.EMAIL_REPLY_TO,
  });
}

/* -------------------------------------------------------------------------- */
/* Artwork reminder: sent once, 24 hours after an order placed with artwork   */
/* to follow, while it still has none (HYV-120)                               */
/* -------------------------------------------------------------------------- */

export async function sendArtworkReminderEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  lineItems = [],
  orderUrl,
}) {
  const html = customerLayout({
    title: "Reminder: we're waiting for your artwork",
    customerName,
    orderName,
    orderDate,
    lineItems,
    orderUrl,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        You chose to send the artwork for order <strong>${escapeHtml(orderName)}</strong> later.
        We can only prepare your Artwork Proof once it arrives, so production can't start yet.
      </p>

      <div style="margin:22px 0;">
        <a
          href="${escapeHtml(orderUrl || CUSTOMER_ORDERS_URL)}"
          style="
            display:inline-block;
            padding:14px 22px;
            background:#0f172a;
            color:#ffffff;
            text-decoration:none;
            border-radius:10px;
            font-size:14px;
            font-weight:700;
          "
        >
          Upload Artwork
        </a>
      </div>

      <p style="margin:0; line-height:1.7; font-size:15px;">
        Sign in to your account, open the order and upload a file for each item marked Artwork Pending.
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `Artwork reminder - ${orderName}`,
    html,
    // The same content as the HTML version: greeting, message, the order's
    // items and details, and the link (HYV-120).
    text: [
      `Hi ${customerName || "there"},`,
      "",
      `Reminder: we're waiting for your artwork - ${orderName}`,
      "",
      `You chose to send the artwork for order ${orderName} later. We can only prepare your Artwork Proof once it arrives, so production can't start yet.`,
      "",
      `Upload Artwork: ${orderUrl || CUSTOMER_ORDERS_URL}`,
      "Sign in to your account, open the order and upload a file for each item marked Artwork Pending.",
      "",
      ...(lineItems.length
        ? ["Order items", ...lineItems.map((item) => `- ${item.title}${item.variantTitle ? ` (${item.variantTitle})` : ""} x ${item.quantity}`), ""]
        : []),
      `Order: ${orderName}`,
      `Order date: ${formatDate(orderDate)}`,
    ].join("\n"),
    replyTo: process.env.EMAIL_REPLY_TO,
  });
}


export async function sendProofApprovedEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  productionDueAt,
  estimatedShipDate,
  lineItems = [],
  orderUrl,
  isSampleOrder = false,
}) {
  // A sample order has no production date until the sample is approved.
  if (!productionDueAt && !isSampleOrder) {
    throw new Error("Production due date is required.");
  }

  const productionDueDateOnly = productionDueAt
    ? formatDay(productionDueAt)
    : null;

  const estimatedShipDateOnly = estimatedShipDate
    ? formatDay(estimatedShipDate)
    : null;

  const html = customerLayout({
    title: isSampleOrder
      ? "Approved — Sample Preparation"
      : customerStatusLabel("proof-approved"),
    customerName,
    orderName,
    orderDate,
    lineItems,
    orderUrl,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Thank you. Your Artwork Proof has been approved.
      </p>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        ${
          isSampleOrder
            ? "<strong>Approved — Sample Preparation:</strong> We'll prepare your physical pre-production sample before bulk production begins."
            : "Your order is now moving into production."
        }
      </p>

      ${
        productionDueDateOnly
          ? `
      <div
        style="
          padding:16px;
          background:#f8fafc;
          border:1px solid ${BRAND.border};
          border-radius:12px;
          margin:18px 0;
        "
      >
        <div
          style="
            font-size:13px;
            line-height:1.5;
            color:${BRAND.secondaryText};
            margin-bottom:6px;
          "
        >
          ${
            isSampleOrder
              ? "Target completion date"
              : "Production target"
          }
        </div>

        <div
          style="
            font-size:16px;
            line-height:1.5;
            font-weight:700;
            color:${BRAND.primaryText};
          "
        >
          ${escapeHtml(productionDueDateOnly)}
        </div>
      </div>
      `
          : ""
      }

      ${
        estimatedShipDateOnly
          ? `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        <strong>Estimated ship date:</strong>
        ${escapeHtml(estimatedShipDateOnly)}
      </p>
      `
          : ""
      }

      <p style="margin:0; line-height:1.7; font-size:15px;">
        ${
          isSampleOrder
            ? "We will contact you with photos and details once your physical sample is dispatched."
            : "We will contact you again when production is complete."
        }
      </p>
    `,
  });

  const text = `
Hi ${customerName || "there"},

${
  isSampleOrder
    ? "Approved — Sample Preparation"
    : customerStatusLabel("proof-approved")
} - ${orderName}

Thank you. Your Artwork Proof has been approved.

${
  isSampleOrder
    ? "Approved — Sample Preparation: We'll prepare your physical pre-production sample before bulk production begins."
    : "Your order is now moving into production."
}

${
  productionDueDateOnly
    ? `${
        isSampleOrder
          ? "Target completion date"
          : "Production target"
      }: ${productionDueDateOnly}`
    : ""
}

${
  estimatedShipDateOnly
    ? `Estimated ship date: ${estimatedShipDateOnly}`
    : ""
}

${
  isSampleOrder
    ? "We will contact you with photos and details once your physical sample is dispatched."
    : "We will contact you again when production is complete."
}

View your order: ${orderUrl || CUSTOMER_ORDERS_URL}
  `
    .trim()
    .replace(/\n{3,}/g, "\n\n");

  return sendEmail({
    to: customerEmail,
    subject: `${
      isSampleOrder
        ? "Approved — Sample Preparation"
        : customerStatusLabel("proof-approved")
    } - ${orderName}`,
    html,
    text,
    replyTo: process.env.EMAIL_REPLY_TO,
  });
}

const PHOTO_CID = "production-photo@hyve";
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;


async function productionPhotoAttachment(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!response.ok || !type.startsWith("image/")) return null;
    if (Number(response.headers.get("content-length") || 0) > PHOTO_MAX_BYTES) return null;

    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > PHOTO_MAX_BYTES) return null;

    const extension = type.split("/")[1].split("+")[0].replace("jpeg", "jpg");
    return { filename: `production-photo.${extension}`, content, contentType: type, cid: PHOTO_CID };
  } catch (error) {
    console.error("[email] production photo could not be fetched:", error?.message || error);
    return null;
  }
}

export async function sendProductionCompleteEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  productionPhotoUrl,
  productionPhotoVersion,
  approveUrl,
  changesUrl,
  lineItems = [],
  orderUrl,
}) {
  if (!productionPhotoUrl) {
    throw new Error("Production photo URL is required.");
  }
  if (!approveUrl || !changesUrl) {
    throw new Error("Approve and Request changes links are required.");
  }

  const photo = await productionPhotoAttachment(productionPhotoUrl);

  const html = customerLayout({
    title: customerStatusLabel("production-complete"),
    customerName,
    orderName,
    orderDate,
    lineItems,
    orderUrl,
    body: `
      <div
        style="
          padding:16px;
          background:#ecfeff;
          border:1px solid #c7f9f1;
          border-radius:12px;
          margin-bottom:20px;
        "
      >
        <div style="font-size:15px; line-height:1.6; color:${BRAND.primaryText};">
          <strong>Action required:</strong>
          Please review your Production Photo, then approve it or request changes with the buttons below.
          No sign-in needed.
        </div>
      </div>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Production for your order is complete.
      </p>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Your order is now being prepared for shipment.
      </p>
${photo ? `
      <img
        src="cid:${PHOTO_CID}"
        alt="Production Photo for ${escapeHtml(orderName)}"
        width="520"
        style="display:block; width:100%; max-width:520px; height:auto; margin:22px 0 0; border-radius:12px; border:1px solid ${BRAND.border};"
      />
` : ""}
      <div style="margin:22px 0;">
        <a
          href="${escapeHtml(productionPhotoUrl)}"
          style="
            display:inline-block;
            padding:14px 22px;
            background:#0f172a;
            color:#ffffff;
            text-decoration:none;
            border-radius:10px;
            font-size:14px;
            font-weight:700;
          "
        >
          View Production Photo
        </a>
      </div>

      ${decisionButtons(approveUrl, changesUrl)}

      <p style="margin:0; line-height:1.7; font-size:15px;">
        <strong>Production Photo version:</strong>
        ${escapeHtml(productionPhotoVersion || "1")}
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `${customerStatusLabel("production-complete")} - ${orderName}`,
    html,
    text:` Hi ${customerName || "there"},

${customerStatusLabel("production-complete")} - ${orderName}

Action required: Please review your Production Photo, then approve it or request changes using the links below. No sign-in needed.

Production for your order is complete.

Your order is now being prepared for shipment.

Production Photo: ${productionPhotoUrl}

Approve Production Photo: ${approveUrl}

Request Changes: ${changesUrl}

Production Photo version: ${productionPhotoVersion || "1"}

View your order: ${orderUrl || CUSTOMER_ORDERS_URL} `.trim(),
    attachments: photo ? [photo] : undefined,
    replyTo: process.env.EMAIL_REPLY_TO,
  });
}


export async function sendPhysicalSampleEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  sampleVersion,
  fileUrl,
  note,
  approveUrl,
  changesUrl,
  reviewUrl,
}) {
  const html = customerLayout({
    title: "Physical Sample Ready For Review",
    customerName,
    orderName,
    orderDate,
    body: `
      <div
        style="
          padding:16px;
          background:#ecfeff;
          border:1px solid #c7f9f1;
          border-radius:12px;
          margin-bottom:20px;
        "
      >
        <div style="font-size:15px; line-height:1.6; color:${BRAND.primaryText};">
          <strong>Action required:</strong>
          ${approveUrl && changesUrl
            ? "Please review your Physical Sample, then approve it or request changes with the buttons below. No sign-in needed."
            : "Please review your Physical Sample, then approve it or request changes in your account."}
        </div>
      </div>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Your physical pre-production sample has been prepared and dispatched.
      </p>

      ${note ? `
        <div style="padding:14px; background:#f8fafc; border:1px solid ${BRAND.border}; border-radius:10px; margin:16px 0;">
          <div style="font-size:12px; font-weight:700; color:${BRAND.secondaryText}; text-transform:uppercase; margin-bottom:4px;">Sample Note:</div>
          <div style="font-size:14px; color:${BRAND.primaryText}; line-height:1.5;">${escapeHtml(note)}</div>
        </div>
      ` : ""}

      ${fileUrl && /[.](jpg|jpeg|png|webp|gif|bmp)$/i.test((fileUrl || "").split("?")[0].split("#")[0].trim()) ? `
        <div style="margin:22px 0;">
          <a href="${escapeHtml(fileUrl)}" target="_blank" style="display: block;">
            <img src="${escapeHtml(fileUrl)}" alt="Physical Sample" style="max-width: 100%; max-height: 500px; border-radius: 8px; border: 1px solid #e2e8f0; display: block;" />
          </a>
        </div>
      ` : ''}

      ${fileUrl ? `
        <div style="margin:16px 0 22px;">
          <a
            href="${escapeHtml(fileUrl)}"
            style="
              display:inline-block;
              padding:10px 18px;
              background:#f1f5f9;
              color:#0f172a;
              text-decoration:none;
              border-radius:8px;
              font-size:13px;
              font-weight:600;
            "
            target="_blank"
            rel="noopener"
          >
            View Physical Sample Photos / Docs ↗
          </a>
        </div>
      ` : ""}

      ${approveUrl && changesUrl ? decisionButtons(approveUrl, changesUrl) : ""}

      <p style="margin:0 0 16px; line-height:1.7; font-size:15px;">
        <strong>Physical Sample version:</strong>
        v${escapeHtml(sampleVersion || "1")}
      </p>

      ${reviewUrl ? `
        <div style="margin:18px 0;">
          <a
            href="${escapeHtml(reviewUrl)}"
            style="
              display:inline-block;
              padding:14px 22px;
              background:#0f172a;
              color:#ffffff;
              text-decoration:none;
              border-radius:10px;
              font-size:14px;
              font-weight:700;
            "
          >
            Open Sample Review
          </a>
        </div>
      ` : ""}
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `Physical Sample Ready For Review - ${orderName}`,
    html,
    text: `Your physical sample for ${orderName} (v${sampleVersion || "1"}) is ready for review.\n\nReview & Approve (no sign-in required): ${reviewUrl || approveUrl}\nApprove: ${approveUrl || ""}\nRequest changes: ${changesUrl || ""}`,
    replyTo: process.env.EMAIL_REPLY_TO,
  });
}

export async function sendReadyForCollectionEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  lineItems = [],
  orderUrl,
  collectionDetails = {},
  pickupConfig = {},
  attachments = [],
}) {
  // What's attached, said only when it really is (HYV-160): the commercial
  // invoice and the packing list, for the forwarder.
  const attachedNames = [
    attachments.some((a) => a.kind === "invoice") ? "commercial invoice" : "",
    attachments.some((a) => a.kind === "packing-list") ? "packing list" : "",
  ].filter(Boolean);
  const attachedLine = attachedNames.length
    ? `The ${attachedNames.join(" and ")} ${attachedNames.length > 1 ? "are" : "is"} attached.`
    : "";
  const readyDate = formatDay(collectionDetails.readyDate);
  const pickupHours = [
    ["Monday", pickupConfig.monday_hours],
    ["Tuesday", pickupConfig.tuesday_hours],
    ["Wednesday", pickupConfig.wednesday_hours],
    ["Thursday", pickupConfig.thursday_hours],
    ["Friday", pickupConfig.friday_hours],
    ["Saturday", pickupConfig.saturday_hours],
    ["Sunday", pickupConfig.sunday_hours],
  ].filter(([, hours]) => hours);
  const pickupHoursHtml = pickupHours
    .map(([day, hours]) => `
      <tr>
        <td style="padding:4px 12px 4px 0; color:${BRAND.secondaryText};">${day}</td>
        <td style="padding:4px 0; color:${BRAND.primaryText};">${escapeHtml(hours)}</td>
      </tr>
    `)
    .join("");

  const textLines = [
    `Your order ${orderName} is ready for collection.`,
    "",
    "Collection Details",
    `Ready Date: ${readyDate}`,
    `Number of Cartons: ${collectionDetails.numberOfCartons || "—"}`,
    `Gross Weight: ${collectionDetails.grossWeight ? `${collectionDetails.grossWeight} kg` : "—"}`,
    `CBM: ${collectionDetails.cbm || "—"}`,
    "",
    "Pickup Location & Contact Details",
    pickupConfig.pickup_address || "Pickup address is not available.",
    ...(pickupConfig.contact_name ? [`Contact Name: ${pickupConfig.contact_name}`] : []),
    ...(pickupConfig.contact_phone ? [`Contact Phone: ${pickupConfig.contact_phone}`] : []),
    ...(pickupConfig.contact_email ? [`Contact Email: ${pickupConfig.contact_email}`] : []),
    ...(pickupHours.length
      ? ["", "Opening Hours", ...pickupHours.map(([day, hours]) => `${day}: ${hours}`)]
      : []),
    "",
    "As freight for this order is customer-arranged, please coordinate collection with your nominated carrier.",
    ...(attachedLine ? [attachedLine] : []),
    "If your carrier needs collection details or assistance, please contact our customer service team.",
    "",
    `View your order: ${orderUrl || CUSTOMER_ORDERS_URL}`,
  ];

  const html = customerLayout({
    title: customerStatusLabel("ready-for-collection"),
    customerName,
    orderName,
    orderDate,
    lineItems,
    orderUrl,
    body: `
      <div style="padding:16px; background:#ecfeff; border:1px solid #c7f9f1; border-radius:12px; margin-bottom:20px;">
        <div style="font-size:15px; line-height:1.6; color:${BRAND.primaryText};">
          <strong>Your order is ready for collection.</strong>
        </div>
      </div>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Production for your order has been completed and your order is now ready for collection.
      </p>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        As freight for this order is customer-arranged, please coordinate collection with your nominated carrier.
      </p>

      <div style="margin:20px 0; padding:16px; background:#f6f6f7; border-radius:8px;">
        <h3 style="margin:0 0 12px; font-size:16px; color:${BRAND.primaryText};">Collection Package Details</h3>
        <table style="width:100%; font-size:14px; color:${BRAND.primaryText}; border-collapse:collapse;">
          <tr><td style="padding:4px 0; width:40%; font-weight:600;">Ready Date</td><td style="padding:4px 0;">${escapeHtml(readyDate)}</td></tr>
          <tr><td style="padding:4px 0; font-weight:600;">Number of Cartons</td><td style="padding:4px 0;">${escapeHtml(collectionDetails.numberOfCartons || "—")}</td></tr>
          <tr><td style="padding:4px 0; font-weight:600;">Gross Weight</td><td style="padding:4px 0;">${escapeHtml(collectionDetails.grossWeight || "—")} Kg</td></tr>
          <tr><td style="padding:4px 0; font-weight:600;">CBM</td><td style="padding:4px 0;">${escapeHtml(collectionDetails.cbm || "—")}</td></tr>
        </table>
      </div>

      <div style="margin:20px 0; padding:16px; background:#f6f6f7; border-radius:8px;">
        <h3 style="margin:0 0 12px; font-size:16px; color:${BRAND.primaryText};">Pickup Location &amp; Contact Details</h3>
        <div style="font-size:14px; color:${BRAND.primaryText}; line-height:1.5;">
          ${pickupConfig.pickup_address
            ? `<p style="margin:0 0 8px;"><strong>Address:</strong><br/>${escapeHtml(pickupConfig.pickup_address).replace(/\r?\n/g, "<br/>")}</p>`
            : `<p style="margin:0 0 8px; color:${BRAND.secondaryText};">Pickup address is not configured.</p>`}
          ${pickupConfig.contact_name ? `<p style="margin:0 0 8px;"><strong>Contact:</strong> ${escapeHtml(pickupConfig.contact_name)}${pickupConfig.contact_phone ? ` (${escapeHtml(pickupConfig.contact_phone)})` : ""}</p>` : ""}
          ${pickupConfig.contact_email ? `<p style="margin:0 0 8px;"><strong>Email:</strong> ${escapeHtml(pickupConfig.contact_email)}</p>` : ""}
          ${pickupHoursHtml
            ? `<p style="margin:8px 0 4px;"><strong>Opening Hours:</strong></p><table style="font-size:14px; border-collapse:collapse;">${pickupHoursHtml}</table>`
            : ""}
        </div>
      </div>

      ${attachedLine ? `<p style="margin:0 0 14px; line-height:1.7; font-size:15px;">${escapeHtml(attachedLine)}</p>` : ""}

      <p style="margin:0; line-height:1.7; font-size:15px;">
        If your carrier needs collection details or assistance, please contact our customer service team.
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `${customerStatusLabel("ready-for-collection")} - ${orderName}`,
    html,
    text: textLines.join("\n"),
    attachments: attachments.length
      ? attachments.map(({ filename, content }) => ({ filename, content, contentType: "application/pdf" }))
      : undefined,
  });
}


export async function sendInvoiceEmail({ customerEmail, customerName, orderName, orderDate, pdf, filename, orderUrl }) {
  if (!pdf) {
    throw new Error("Invoice PDF is required.");
  }

  const html = customerLayout({
    title: "Your Invoice",
    customerName,
    orderName,
    orderDate,
    orderUrl,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Thank you for your order. Your invoice for ${escapeHtml(orderName)} is attached as a PDF for your records.
      </p>

      <p style="margin:0; line-height:1.7; font-size:15px;">
        You can also download it any time from the order in your account.
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `Invoice - ${orderName}`,
    html,
    text: `Thank you for your order. Your invoice for ${orderName} is attached as a PDF. You can also download it any time from the order in your account: ${orderUrl || CUSTOMER_ORDERS_URL}`,
    attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
  });
}

/* -------------------------------------------------------------------------- */
/* Internal alert                                                             */
/* -------------------------------------------------------------------------- */

export async function sendInternalSlaAlert({
  to,
  subject,
  orderName,
  customerName,
  status,
  elapsed,
  assignedRole,
  adminUrl,
  message,
}) {
  const recipients =
    Array.isArray(to) ? to.join(",") : to;

  // The same branded frame as every customer email (HYV-110).
  const html = brandedEmail({
    internal: true,
    title: subject,
    body: `
      ${message ? `<p style="margin:0 0 14px; line-height:1.7; font-size:15px;">${escapeHtml(message)}</p>` : ""}
      ${adminUrl
        ? `<div style="margin:22px 0;"><a href="${escapeHtml(adminUrl)}" style="display:inline-block; padding:14px 22px; background:#0f172a; color:#ffffff; text-decoration:none; border-radius:10px; font-size:14px; font-weight:700;">Open order in Hyve admin</a></div>`
        : ""
      }`,
    details: [
      ["Order", escapeHtml(orderName)],
      ["Customer", escapeHtml(customerName || "—")],
      ["Status", escapeHtml(status)],
      ["Elapsed", escapeHtml(elapsed || "—")],
      ["Owner", escapeHtml(assignedRole || "—")],
    ],
  });

  return sendEmail({
    to: recipients,
    subject,
    html,
    text:
      `${subject}\n` +
      `Order: ${orderName}\n` +
      `Customer: ${customerName || "—"}\n` +
      `Status: ${status}\n` +
      `Elapsed: ${elapsed || "—"}\n` +
      `Owner: ${assignedRole || "—"}\n` +
      (message ? `\n${message}\n` : "") +
      (adminUrl ? `Open the order: ${adminUrl}\n` : ""),
  });
}

/* -------------------------------------------------------------------------- */
/* Daily breach digest (Customer Service), HYV-132                            */
/* -------------------------------------------------------------------------- */

export async function sendBreachDigestEmail({ to, since, now, groups = [] }) {
  const recipients = Array.isArray(to) ? to.join(",") : to;
  const day = (value) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Singapore" }).format(value);
  const count = groups.reduce((n, group) => n + group.orders.length, 0);
  const subject = `[Hyve] Daily breach digest - ${day(now)} - ${count} order${count === 1 ? "" : "s"}`;

  const sections = groups
    .map(
      (group) => `
      <h3 style="margin:22px 0 8px; font-size:15px; color:${BRAND.primaryText};">${escapeHtml(group.status)} (${group.orders.length})</h3>
      <table style="width:100%; border-collapse:collapse; font-size:14px; color:${BRAND.primaryText};">
        ${group.orders
          .map(
            (order) => `
          <tr>
            <td style="padding:6px 0; border-bottom:1px solid ${BRAND.border}; width:30%; vertical-align:top;">
              ${order.adminUrl ? `<a href="${escapeHtml(order.adminUrl)}" style="color:${BRAND.primaryText}; font-weight:700;">${escapeHtml(order.orderName)}</a>` : `<strong>${escapeHtml(order.orderName)}</strong>`}
              <div style="color:${BRAND.secondaryText}; font-size:13px;">${escapeHtml(order.customerName || "—")}</div>
            </td>
            <td style="padding:6px 0; border-bottom:1px solid ${BRAND.border}; vertical-align:top;">${order.breaches.map((b) => escapeHtml(b)).join("<br/>")}</td>
          </tr>`,
          )
          .join("")}
      </table>`,
    )
    .join("");

  const html = brandedEmail({
    internal: true,
    title: "Daily Breach Digest",
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        ${count
          ? `Orders that missed a target between ${escapeHtml(day(since))} and ${escapeHtml(day(now))}, grouped by the status they are in now.`
          : `No order missed a target between ${escapeHtml(day(since))} and ${escapeHtml(day(now))}.`}
      </p>
      ${sections}`,
  });

  const text = [
    subject,
    "",
    ...(count
      ? groups.flatMap((group) => [
          `${group.status} (${group.orders.length})`,
          ...group.orders.map((order) => `- ${order.orderName}${order.customerName ? ` (${order.customerName})` : ""}: ${order.breaches.join("; ")}${order.adminUrl ? ` ${order.adminUrl}` : ""}`),
          "",
        ])
      : ["No order missed a target in the last 24 hours."]),
  ].join("\n");

  return sendEmail({ to: recipients, subject, html, text });
}

/* -------------------------------------------------------------------------- */
/* MSG-17 Order On Hold Alert (Customer Service)                              */
/* -------------------------------------------------------------------------- */

export async function sendOrderOnHoldAlert({
  to,
  orderName,
  customerName,
  onHoldReason,
  changedBy,
  note,
  adminUrl,
  owner = "",
}) {
  const recipients = Array.isArray(to) ? to.filter(Boolean).join(",") : to;
  // The timeline note ends with "Hold Reason: …", which the alert already
  // shows as Reason: left out here so it isn't printed twice (HYV-127).
  const extraNote = String(note || "")
    .split("\n")
    .filter((line) => line.trim() && line.trim() !== `Hold Reason: ${String(onHoldReason || "").trim()}`)
    .join("\n")
    .trim();
  if (!recipients) {
    throw new Error("No recipients specified for On Hold alert.");
  }

  // MSG-17 in the specification; MSG-12 is the proof not approved by day 10
  // alert (HYV-127).
  const subject = `[Hyve MSG-17] ${orderName} - Order placed on hold`;

  const details = [
    ["Order", escapeHtml(orderName)],
    ["Customer", escapeHtml(customerName || "—")],
    ["Status", "On Hold"],
    ["Reason", escapeHtml(onHoldReason || "—")],
  ];

  if (changedBy) {
    details.push(["Changed By", escapeHtml(changedBy)]);
  }

  if (extraNote && extraNote !== String(onHoldReason || "").trim()) {
    details.push(["Note", escapeHtml(extraNote)]);
  }

  details.push(["Owner", escapeHtml(owner || "Customer Service")]);

  const html = brandedEmail({
    internal: true,
    title: "Order Placed On Hold",
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Order <strong>${escapeHtml(orderName)}</strong> has been placed <strong>On Hold</strong>.
      </p>
      ${onHoldReason
        ? `<p style="margin:0 0 14px; line-height:1.7; font-size:14px; color:#475569;"><strong>Reason:</strong> ${escapeHtml(onHoldReason)}</p>`
        : ""
      }
      ${extraNote && extraNote !== String(onHoldReason || "").trim()
        ? `<p style="margin:0 0 14px; line-height:1.7; font-size:14px; color:#475569;"><strong>Note:</strong> ${escapeHtml(extraNote)}</p>`
        : ""
      }
      ${adminUrl
        ? `<div style="margin:22px 0;"><a href="${escapeHtml(adminUrl)}" style="display:inline-block; padding:14px 22px; background:#0f172a; color:#ffffff; text-decoration:none; border-radius:10px; font-size:14px; font-weight:700;">Open order in Hyve admin</a></div>`
        : ""
      }`,
    details,
  });

  return sendEmail({
    to: recipients,
    subject,
    html,
    text:
      `${subject}\n` +
      `Order: ${orderName}\n` +
      `Customer: ${customerName || "—"}\n` +
      `Status: On Hold\n` +
      `Reason: ${onHoldReason || "—"}\n` +
      (changedBy ? `Changed By: ${changedBy}\n` : "") +
      (extraNote && extraNote !== String(onHoldReason || "").trim() ? `Note: ${extraNote}\n` : "") +
      `Owner: ${owner || "Customer Service"}\n` +
      (adminUrl ? `Open the order: ${adminUrl}\n` : ""),
  });
}

/* -------------------------------------------------------------------------- */
/* MSG-13 Estimated Ship Date                                                 */
/* -------------------------------------------------------------------------- */

export async function sendEstimatedShipDateEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  estimatedShipDate,
  lineItems = [],
  orderUrl,
}) {
  if (!estimatedShipDate) {
    throw new Error("Estimated ship date is required.");
  }

  const estimatedShipDateOnly = formatDay(estimatedShipDate);

  const html = customerLayout({
    title: "Estimated Ship Date Update",
    customerName,
    orderName,
    orderDate,
    lineItems,
    orderUrl,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        We have an update regarding the estimated ship date for your order.
      </p>

      <div
        style="
          padding:16px;
          background:#f8fafc;
          border:1px solid ${BRAND.border};
          border-radius:12px;
          margin:18px 0;
        "
      >
        <div
          style="
            font-size:13px;
            line-height:1.5;
            color:${BRAND.secondaryText};
            margin-bottom:6px;
          "
        >
          Estimated ship date
        </div>

        <div
          style="
            font-size:16px;
            line-height:1.5;
            font-weight:700;
            color:${BRAND.primaryText};
          "
        >
          ${escapeHtml(estimatedShipDateOnly)}
        </div>
      </div>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `Estimated Ship Date Update - ${orderName}`,
    html,
    text: `We have an update regarding the estimated ship date for your order. Estimated ship date: ${estimatedShipDateOnly}.\n\nView your order: ${orderUrl || CUSTOMER_ORDERS_URL}`,
  });
}

/* -------------------------------------------------------------------------- */
