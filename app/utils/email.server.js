// app/utils/email.server.js

// One SMTP connection for the whole app, shared with the quote and team emails
// so there is a single pooled transport and a single set of settings.
import { getMailer, getDefaultFrom } from "../lib/email/mailer.server";
import { customerStatusLabel } from "../lib/portal.server";


const BRAND = {
  name: "HYVE",
  supportEmail: "support@hyve.promo",
  logoUrl:"https://hyve.promo/cdn/shop/files/Image_Hyve.Promo.png",
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

function formatDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Singapore",
  }).format(date);
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
                        ${
                          imageUrl
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

                        ${
                          variantDetails
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

                        ${
                          item.sku
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

                        ${
                          decoration
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

                        ${
                          artworkState
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

/**
 * An order email: the branded frame with the order's lines and its number and
 * date underneath.
 */
function customerLayout({
  title,
  customerName,
  orderName,
  orderDate,
  body,
  lineItems = [],
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
 */
export function brandedEmail({ title, greeting = null, body, details = [] }) {
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

                    ${detailRows ? `<table
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

                    <div
                      style="
                        margin-top:8px;
                        font-size:12px;
                        line-height:1.6;
                        color:${BRAND.secondaryText};
                      "
                    >
                      © ${new Date().getFullYear()} Hyve Promo. All rights reserved.
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
    replyTo:
      replyTo ||
      process.env.EMAIL_REPLY_TO ||
      undefined,
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
}) {
  const html = customerLayout({
    title: customerStatusLabel("artwork-received"),
    customerName,
    orderName,
    orderDate,
    lineItems,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        We have received the artwork information for your order.
      </p>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Our artwork team will now prepare your digital proof for review.
      </p>

      <p style="margin:0; line-height:1.7; font-size:15px;">
        We will contact you again when the proof is ready for approval.
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `${customerStatusLabel("artwork-received")} - ${orderName}`,
    html,
    text: `Artwork received for ${orderName}. Our team will now prepare your proof.`,
  });
}

/* -------------------------------------------------------------------------- */
/* MSG-03 Proof Sent                                                          */
/* -------------------------------------------------------------------------- */

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
          Please review your proof, then approve it or request changes with the buttons below.
          No sign-in needed.
        </div>
      </div>

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
          View Proof
        </a>
      </div>

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
          Approve Proof
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

      <p style="margin:0; line-height:1.7; font-size:15px;">
        <strong>Proof version:</strong>
        ${escapeHtml(proofVersion)}
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `${customerStatusLabel("proof-sent")} - ${orderName}`,
    html,
    text: `Your proof for ${orderName} is ready. View: ${proofUrl}\nApprove: ${approveUrl}\nRequest changes: ${changesUrl}`,
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
  reminderDay,
  lineItems = [],
}) {
  const html = customerLayout({
    title: "Reminder: your proof is awaiting approval",
    customerName,
    orderName,
    orderDate,
    lineItems,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        This is a reminder that proof version
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
          Review Proof
        </a>
      </div>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Please reply to this email to approve the proof or request changes.
      </p>

      <p style="margin:0; font-size:13px; color:${BRAND.secondaryText};">
        Reminder day: ${escapeHtml(reminderDay)}
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `Proof approval reminder - ${orderName}`,
    html,
    text: `Reminder: proof version ${proofVersion} for ${orderName} is awaiting approval. ${proofUrl}`,
    replyTo: process.env.EMAIL_REPLY_TO,
  });
}

/* -------------------------------------------------------------------------- */
/* MSG-05 Proof Approved                                                      */
/* -------------------------------------------------------------------------- */

export async function sendProofApprovedEmail({
  customerEmail,
  customerName,
  orderName,
  orderDate,
  productionDueAt,
  lineItems = [],
}) {
  if (!productionDueAt) {
    throw new Error("Production due date is required.");
  }

  const html = customerLayout({
    title: customerStatusLabel("proof-approved"),
    customerName,
    orderName,
    orderDate,
    lineItems,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Thank you. Your proof has been approved.
      </p>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Your order is now moving into production.
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
          Production target
        </div>

        <div
          style="
            font-size:16px;
            line-height:1.5;
            font-weight:700;
            color:${BRAND.primaryText};
          "
        >
          ${escapeHtml(formatDate(productionDueAt))}
        </div>
      </div>

      <p style="margin:0; line-height:1.7; font-size:15px;">
        We will contact you again when production is complete.
      </p>
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `${customerStatusLabel("proof-approved")} - ${orderName}`,
    html,
    text: `Your proof for ${orderName} has been approved. Production target: ${formatDate(productionDueAt)}.`,
  });
}

/* -------------------------------------------------------------------------- */
/* MSG-07 Production Complete                                                 */
/* -------------------------------------------------------------------------- */

const PHOTO_CID = "production-photo@hyve";
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The production photo as an inline attachment, when the link staff saved is
 * the image itself (a Shopify Files link, for one). A link to a page that
 * shows the image, such as a Drive share, can't be embedded, so that email
 * carries the link alone.
 */
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
  lineItems = [],
}) {
  if (!productionPhotoUrl) {
    throw new Error("Production photo URL is required.");
  }

  const photo = await productionPhotoAttachment(productionPhotoUrl);

  const html = customerLayout({
    title: customerStatusLabel("production-complete"),
    customerName,
    orderName,
    orderDate,
    lineItems,
    body: `
      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Production for your order is complete.
      </p>

      <p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        Your order is now being prepared for shipment.
      </p>
${photo ? `
      <img
        src="cid:${PHOTO_CID}"
        alt="Production photo for ${escapeHtml(orderName)}"
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
    `,
  });

  return sendEmail({
    to: customerEmail,
    subject: `${customerStatusLabel("production-complete")} - ${orderName}`,
    html,
    text: `Production for ${orderName} is complete. Production photo: ${productionPhotoUrl}`,
    attachments: photo ? [photo] : undefined,
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

  const html = `
    <!doctype html>
    <html>
      <body style="font-family:Arial,Helvetica,sans-serif;color:#202223;">
        <h2>${escapeHtml(subject)}</h2>

        <table cellspacing="0" cellpadding="6">
          <tr>
            <td><strong>Order</strong></td>
            <td>${escapeHtml(orderName)}</td>
          </tr>
          <tr>
            <td><strong>Customer</strong></td>
            <td>${escapeHtml(customerName || "—")}</td>
          </tr>
          <tr>
            <td><strong>Status</strong></td>
            <td>${escapeHtml(status)}</td>
          </tr>
          <tr>
            <td><strong>Elapsed</strong></td>
            <td>${escapeHtml(elapsed || "—")}</td>
          </tr>
          <tr>
            <td><strong>Owner</strong></td>
            <td>${escapeHtml(assignedRole || "—")}</td>
          </tr>
        </table>

        ${
          message
            ? `<p style="margin-top:20px;">${escapeHtml(message)}</p>`
            : ""
        }

        ${
          adminUrl
            ? `<p style="margin-top:24px;"><a href="${escapeHtml(adminUrl)}">Open order in Hyve admin</a></p>`
            : ""
        }

        <p style="margin-top:24px; font-size:13px; color:#6b7280;">
          Support: <a href="mailto:${BRAND.supportEmail}">${BRAND.supportEmail}</a>
        </p>
      </body>
    </html>
  `;

  return sendEmail({
    to: recipients,
    subject,
    html,
    text:
      `${subject}\n` +
      `Order: ${orderName}\n` +
      `Customer: ${customerName || "—"}\n` +
      `Status: ${status}\n` +
      `Elapsed: ${elapsed || "—"}\n`,
  });
}