import process from "node:process";
import { TIMEZONE, singaporeDateKey, singaporeDayDiff, formatDate, formatDateTime } from "../utils/date.js";
import { getNotificationRecipients } from "../utils/metaobjects/notification-recipients.server.js";
import { sendEmail } from "./mailer.server.js";
import { brandedEmail, escapeHtml } from "../utils/email.server.js";
import { CUSTOMER_SERVICE_EMAIL } from "./email/mailer.server.js";
import { bankAccountFor, DEFAULT_ACCOUNTS } from "./bank-details.server.js";
import { loadBankDetailsConfig } from "./bank-settings.server.js";
import { unauthenticated } from "../shopify.server.js";
import prisma from "../db.server.js";

export const PENDING_PAYMENTS_QUERY = `#graphql
  query PendingPaymentOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        createdAt
        poNumber
        displayFinancialStatus
        lastNotification: metafield(namespace: "$app", key: "last_payment_reminder_sent_at") {
          value
        }
        lastNotificationCustom: metafield(namespace: "custom", key: "last_payment_reminder_sent_at") {
          value
        }
        totalPriceSet: currentTotalPriceSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        totalOutstandingSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        totalReceivedSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        customer {
          displayName
          email
          phone
        }
        billingAddress {
          company
          countryCodeV2
        }
        shippingAddress {
          company
          countryCodeV2
        }
        paymentTerms {
          id
          paymentTermsName
          paymentSchedules(first: 5) {
            nodes {
              id
              dueAt
              completedAt
              amount {
                amount
                currencyCode
              }
            }
          }
        }
        purchasingEntity {
          ... on PurchasingCompany {
            company {
              name
            }
          }
        }
        metafield(namespace: "custom", key: "credit_limit") {
          value
        }
      }
    }
  }
`;

export function getDayDiff(dueAtDate) {
  return singaporeDayDiff(dueAtDate);
}

export function classifyPaymentStatus(schedule, daysDiff, outstandingAmount) {
  if (schedule?.completedAt || (outstandingAmount !== undefined && Number(outstandingAmount) <= 0)) {
    return { key: "paid", label: "Paid", tone: "success" };
  }
  if (daysDiff === null || daysDiff === undefined) {
    return { key: "no_due_date", label: "Pending", tone: "warning" };
  }
  if (daysDiff < 0) {
    return {
      key: "overdue",
      label: `Overdue (${Math.abs(daysDiff)}d)`,
      tone: "critical",
    };
  }
  if (daysDiff === 0) {
    return { key: "today", label: "Due Today", tone: "attention" };
  }
  if (daysDiff <= 7) {
    return { key: "7days", label: `Due in ${daysDiff}d`, tone: "warning" };
  }
  return { key: "future", label: `Due in ${daysDiff}d`, tone: "neutral" };
}

export function formatMoney(amount, currency = "USD") {
  const num = Number(amount);
  if (!Number.isFinite(num)) return `${currency} 0.00`;
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency: currency || "USD",
    }).format(num);
  } catch {
    return `${currency} ${num.toFixed(2)}`;
  }
}

export function parseOrderNode(order, shopHandle = "hyve-promo") {
  const numericId = order.id ? order.id.split("/").pop() : "";
  const currency =
    order.totalPriceSet?.presentmentMoney?.currencyCode || "USD";
  const totalAmount = Number(
    order.totalPriceSet?.presentmentMoney?.amount || 0,
  );
  const outstandingAmount = Number(
    order.totalOutstandingSet?.presentmentMoney?.amount || totalAmount,
  );
  const paidAmount = Number(
    order.totalReceivedSet?.presentmentMoney?.amount || 0,
  );

  const schedule = order.paymentTerms?.paymentSchedules?.nodes?.[0] || null;
  const dueAtDate = schedule?.dueAt ? new Date(schedule.dueAt) : null;
  const daysDiff = getDayDiff(dueAtDate);
  const status = classifyPaymentStatus(schedule, daysDiff, outstandingAmount);

  const companyName =
    order.purchasingEntity?.company?.name ||
    order.billingAddress?.company ||
    order.shippingAddress?.company ||
    "";

  const customerName = order.customer?.displayName || "";
  const customerEmail = order.customer?.email || "";
  const customerPhone = order.customer?.phone || "";
  const countryCode =
    order.billingAddress?.countryCodeV2 ||
    order.shippingAddress?.countryCodeV2 ||
    (currency === "SGD" ? "SG" : currency === "USD" ? "US" : "");

  const lastNotifiedAt =
    order.lastNotification?.value ||
    order.lastNotificationCustom?.value ||
    null;
  const lastNotifiedLabel = lastNotifiedAt
    ? formatDateTime(lastNotifiedAt)
    : null;

  const adminUrl = numericId
    ? `https://admin.shopify.com/store/${shopHandle}/orders/${numericId}`
    : "";

  return {
    id: order.id,
    numericId,
    name: order.name,
    createdAt: order.createdAt,
    createdAtLabel: formatDate(order.createdAt),
    lastNotifiedAt,
    lastNotifiedLabel,
    poNumber: order.poNumber || "—",
    termsName: order.paymentTerms?.paymentTermsName || "Prepaid / Custom",
    dueAt: schedule?.dueAt || null,
    dueAtLabel: formatDate(schedule?.dueAt),
    daysDiff,
    statusKey: status.key,
    statusLabel: status.label,
    statusTone: status.tone,
    currency,
    countryCode,
    totalAmount,
    totalAmountLabel: formatMoney(totalAmount, currency),
    outstandingAmount,
    outstandingAmountLabel: formatMoney(outstandingAmount, currency),
    paidAmount,
    customerName,
    companyName,
    customerEmail,
    customerPhone,
    financialStatus: order.displayFinancialStatus || "PENDING",
    adminUrl,
  };
}

export async function fetchAllPendingOrders(admin, { maxBatches = 10 } = {}) {
  const baseOrderQuery =
    "financial_status:pending OR financial_status:partially_paid OR financial_status:unpaid";
  const allOrders = [];
  let hasNext = true;
  let cursor = null;
  let batches = 0;

  while (hasNext && batches < maxBatches) {
    batches++;
    const response = await admin.graphql(PENDING_PAYMENTS_QUERY, {
      variables: {
        first: 50,
        after: cursor,
        query: baseOrderQuery,
      },
    });
    const body = await response.json();
    if (body?.errors && body.errors.length > 0) {
      const errorMsg = body.errors.map((e) => e.message).join(", ");
      throw new Error(`Shopify GraphQL error: ${errorMsg}`);
    }
    const connection = body?.data?.orders;
    const nodes = connection?.nodes || [];

    allOrders.push(...nodes);
    hasNext = Boolean(connection?.pageInfo?.hasNextPage);
    cursor = connection?.pageInfo?.endCursor || null;
  }

  return allOrders;
}

/**
 * Filter orders where payment is due in specified days (Singapore timezone).
 *
 * @param {Array} orders - Parsed order objects
 * @param {number|string} days - Number of days parameter
 * @param {object} [options]
 * @param {"within"|"exact"|"overdue"|"upcoming"} [options.mode="within"]
 * @param {boolean} [options.includeOverdue=false] - If mode="within" and days >= 0, include overdue orders (< 0) as well
 * @param {string} [options.searchQuery]
 */
export function filterOrdersDueInDays(orders, days, options = {}) {
  const dVal = Number(days);
  if (!Number.isFinite(dVal)) {
    throw new Error(`Invalid parameter days: "${days}". Expected a valid number of days.`);
  }

  const mode = String(options.mode || "within").toLowerCase();
  const includeOverdue = Boolean(options.includeOverdue);
  const q = String(options.searchQuery || "").trim().toLowerCase();

  return orders.filter((o) => {
    // Only include orders that have a pending/outstanding amount strictly greater than 0
    const pendingAmount = Number(o.outstandingAmount ?? 0);
    if (!Number.isFinite(pendingAmount) || pendingAmount <= 0) {
      return false; // Discard orders with pending amount 0 or less
    }

    const d = o.daysDiff;
    if (d === null || d === undefined) {
      return false; // Orders with no due date schedule cannot be matched against a days-due window
    }

    let matches = false;
    if (mode === "exact") {
      matches = d === dVal;
    } else if (mode === "overdue") {
      // Overdue orders (d < 0). If dVal is specified and > 0, overdue by at least dVal days; otherwise all overdue orders
      matches = d < 0 && (dVal <= 0 ? true : Math.abs(d) >= Math.abs(dVal));
    } else if (mode === "upcoming") {
      // Strictly upcoming: 0 <= d <= days
      matches = d >= 0 && d <= Math.max(0, dVal);
    } else {
      // mode === "within" (default)
      if (dVal < 0) {
        // Negative days means overdue by at least |days|
        matches = d < 0 && Math.abs(d) >= Math.abs(dVal);
      } else if (includeOverdue) {
        // Due within days OR already overdue
        matches = d <= dVal;
      } else {
        // Due today or within next days
        matches = d >= 0 && d <= dVal;
      }
    }

    if (!matches) return false;

    if (q) {
      const matchesName = (o.name || "").toLowerCase().includes(q);
      const matchesCustomer = (o.customerName || "").toLowerCase().includes(q);
      const matchesCompany = (o.companyName || "").toLowerCase().includes(q);
      const matchesPo = (o.poNumber || "").toLowerCase().includes(q);
      const matchesEmail = (o.customerEmail || "").toLowerCase().includes(q);
      if (
        !matchesName &&
        !matchesCustomer &&
        !matchesCompany &&
        !matchesPo &&
        !matchesEmail
      ) {
        return false;
      }
    }

    return true;
  });
}

export const filterOrdersDueInXDays = filterOrdersDueInDays;

export function buildOrdersCsv(orders, shopHandle = "hyve-promo") {
  const headers = [
    "Order Number",
    "Created Date",
    "Last Notification Sent",
    "Customer Name",
    "Company",
    "Email",
    "Phone",
    "PO Number",
    "Payment Terms",
    "Due Date",
    "Days Due / Overdue",
    "Days Offset",
    "Payment Status",
    "Currency",
    "Total Amount",
    "Outstanding Balance",
    "Paid Amount",
    "Shopify Admin URL",
  ];

  const escapeCsv = (val) => {
    const str = String(val ?? "");
    if (
      str.includes(",") ||
      str.includes('"') ||
      str.includes("\n") ||
      str.includes("\r")
    ) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const formatDaysLabel = (diff) => {
    if (diff === null || diff === undefined) return "No due date";
    if (diff < 0) return `${Math.abs(diff)} days overdue`;
    if (diff === 0) return "Due today";
    return `Due in ${diff} days`;
  };

  const csvLines = [headers.map(escapeCsv).join(",")];
  for (const r of orders) {
    const adminUrl =
      r.adminUrl ||
      (r.numericId
        ? `https://admin.shopify.com/store/${shopHandle}/orders/${r.numericId}`
        : "—");

    csvLines.push(
      [
        r.name,
        r.createdAtLabel || formatDate(r.createdAt),
        r.lastNotifiedLabel || "—",
        r.customerName,
        r.companyName,
        r.customerEmail,
        r.customerPhone || "—",
        r.poNumber,
        r.termsName,
        r.dueAtLabel || formatDate(r.dueAt),
        formatDaysLabel(r.daysDiff),
        r.daysDiff !== null && r.daysDiff !== undefined ? String(r.daysDiff) : "—",
        r.statusLabel,
        r.currency,
        Number(r.totalAmount || 0).toFixed(2),
        Number(r.outstandingAmount || 0).toFixed(2),
        Number(r.paidAmount || 0).toFixed(2),
        adminUrl,
      ]
        .map(escapeCsv)
        .join(","),
    );
  }

  return "\uFEFF" + csvLines.join("\r\n");
}

export async function resolveRecipients(admin, requestedTo) {
  if (requestedTo) {
    const list = (Array.isArray(requestedTo) ? requestedTo : String(requestedTo).split(","))
      .map((e) => e.trim())
      .filter((e) => e && e.includes("@"));
    if (list.length > 0) return [...new Set(list)];
  }

  // Look up metaobject notification recipients
  try {
    if (admin) {
      const metaRecipients = await getNotificationRecipients(admin);
      const targetRoles = new Set(["MANAGEMENT", "CUSTOMER_SERVICE", "CREDIT_REVIEW"]);
      const filtered = metaRecipients
        .filter((r) => r.enabled && targetRoles.has(r.role) && r.email?.includes("@"))
        .map((r) => r.email.trim());
      if (filtered.length > 0) {
        return [...new Set(filtered)];
      }
    }
  } catch (err) {
    console.warn("[pending-payments] Could not load notification recipient metaobjects:", err);
  }

  // Fallback to environment variables or Customer Service email
  const fallback =
    process.env.PENDING_PAYMENTS_RECIPIENT ||
    process.env.NOTIFICATION_EMAIL ||
    process.env.CUSTOMER_SERVICE_EMAIL ||
    CUSTOMER_SERVICE_EMAIL;

  return [fallback.trim()];
}

export function calculateTotalsByCurrency(orders) {
  const totals = {};
  for (const o of orders) {
    const curr = o.currency || "USD";
    totals[curr] = (totals[curr] || 0) + Number(o.outstandingAmount || 0);
  }
  return totals;
}

export async function getShopifyAdmin(shopQuery) {
  let shop = (shopQuery || process.env.SHOPIFY_SHOP || "").trim().toLowerCase();
  if (!shop || !shop.endsWith(".myshopify.com")) {
    const session = await prisma.session.findFirst({
      where: { shop: { contains: "myshopify.com" } },
      orderBy: { id: "desc" },
    });
    if (session?.shop) {
      shop = session.shop;
    }
  }

  if (!shop || !shop.endsWith(".myshopify.com")) {
    throw new Error(
      "Shopify shop domain is missing or invalid. Set SHOPIFY_SHOP in environment or supply 'shop' parameter.",
    );
  }

  const { admin } = await unauthenticated.admin(shop);
  const shopHandle = shop.replace(".myshopify.com", "");
  return { admin, shop, shopHandle };
}

export async function sendPendingPaymentsCsvEmail({
  admin,
  orders,
  days,
  xDays, // backwards-compatible alias
  mode = "within",
  includeOverdue = false,
  to,
  subject,
  notes = "",
  shopHandle = "hyve-promo",
}) {
  const daysNum = Number(days ?? xDays);
  const recipients = await resolveRecipients(admin, to);
  if (!recipients.length) {
    throw new Error("No valid recipient email address could be resolved.");
  }

  // If there is no order found, do not send email or CSV
  if (!orders || orders.length === 0) {
    return {
      success: true,
      recipients,
      count: 0,
      totalsByCurrency: {},
      formattedTotals: "0.00",
      filename: null,
      emailSent: false,
      csvSent: false,
      reason: "No matching orders found. Email and CSV skipped.",
    };
  }

  const csvContent = buildOrdersCsv(orders, shopHandle);
  const cleanDateStr = singaporeDateKey(new Date());
  const daysStr =
    daysNum < 0
      ? `overdue-${Math.abs(daysNum)}d`
      : mode === "overdue" && daysNum === 0
        ? "overdue-all"
        : `${daysNum}d`;
  const filename = `pending-payments-${daysStr}-${cleanDateStr}.csv`;

  const count = orders.length;
  const totalsByCurrency = calculateTotalsByCurrency(orders);
  const formattedTotals = Object.entries(totalsByCurrency)
    .map(([curr, amt]) => formatMoney(amt, curr))
    .join(" + ") || "0.00";

  let windowDescription = "";
  if (mode === "exact") {
    windowDescription = `due in exactly ${daysNum} days`;
  } else if (mode === "overdue" || daysNum < 0) {
    windowDescription =
      daysNum === 0
        ? "all overdue orders (past payment due date)"
        : `overdue by ${Math.abs(daysNum)} or more days`;
  } else if (includeOverdue) {
    windowDescription = `due in ≤ ${daysNum} days (including overdue orders)`;
  } else {
    windowDescription = `due in next ${daysNum} days (0 to ${daysNum} days)`;
  }

  const defaultSubject =
    mode === "overdue" && daysNum === 0
      ? `Pending Payments Report: All Overdue Orders (${count} Orders • ${formattedTotals})`
      : `Pending Payments Report: Due in ${daysNum} Days (${count} Orders • ${formattedTotals})`;
  const finalSubject = subject || defaultSubject;

  // Generate HTML preview table for up to top 15 orders
  const previewOrders = orders.slice(0, 15);
  const previewRowsHtml = previewOrders
    .map((o) => `
      <tr style="border-bottom: 1px solid #E5E7EB;">
        <td style="padding: 10px 12px; font-weight: 600; color: #111827;">
          ${o.adminUrl ? `<a href="${escapeHtml(o.adminUrl)}" style="color: #059669; text-decoration: none;">${escapeHtml(o.name)}</a>` : escapeHtml(o.name)}
        </td>
        <td style="padding: 10px 12px; color: #374151;">
          <div style="font-weight: 500;">${escapeHtml(o.companyName || o.customerName || "—")}</div>
          ${o.customerEmail ? `<div style="font-size: 12px; color: #6B7280;">${escapeHtml(o.customerEmail)}</div>` : ""}
        </td>
        <td style="padding: 10px 12px; color: #374151;">
          <div>${escapeHtml(o.dueAtLabel || "—")}</div>
          <div style="font-size: 12px; color: ${o.daysDiff < 0 ? "#DC2626" : o.daysDiff === 0 ? "#D97706" : "#2563EB"}; font-weight: 600;">
            ${o.daysDiff < 0 ? `${Math.abs(o.daysDiff)}d overdue` : o.daysDiff === 0 ? "Due today" : `In ${o.daysDiff}d`}
          </div>
        </td>
        <td style="padding: 10px 12px; text-align: right; font-weight: 700; color: #111827;">
          ${escapeHtml(o.outstandingAmountLabel)}
        </td>
      </tr>
    `)
    .join("");

  const emailBody = `
    <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #111827;">
      This automated report lists pending orders with payment <strong>${escapeHtml(windowDescription)}</strong>.
    </p>

    <div style="background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; margin: 0 0 20px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr>
          <td style="padding: 6px 0; color: #6B7280; font-weight: 500;">Due Parameter:</td>
          <td style="padding: 6px 0; color: #111827; font-weight: 600;">${escapeHtml(String(daysNum))} days (${escapeHtml(mode)})</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #6B7280; font-weight: 500;">Matching Orders:</td>
          <td style="padding: 6px 0; color: #111827; font-weight: 600;">${count} ${count === 1 ? "order" : "orders"}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #6B7280; font-weight: 500;">Total Outstanding:</td>
          <td style="padding: 6px 0; color: #059669; font-weight: 700; font-size: 16px;">${escapeHtml(formattedTotals)}</td>
        </tr>

        <tr>
          <td style="padding: 6px 0; color: #6B7280; font-weight: 500;">Report Attachment:</td>
          <td style="padding: 6px 0; color: #2563EB; font-weight: 600;">${escapeHtml(filename)}</td>
        </tr>
      </table>
    </div>

    ${notes ? `<p style="margin: 0 0 16px; font-size: 14px; color: #4B5563; font-style: italic;">${escapeHtml(notes)}</p>` : ""}

    <div style="margin: 20px 0;">
      <div style="font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 10px;">
        Order Preview (${Math.min(count, 15)} of ${count})
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px; background-color: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
        <thead>
          <tr style="background-color: #F3F4F6; text-align: left; color: #4B5563; font-weight: 600;">
            <th style="padding: 8px 12px;">Order</th>
            <th style="padding: 8px 12px;">Customer / Company</th>
            <th style="padding: 8px 12px;">Due Date (SGT)</th>
            <th style="padding: 8px 12px; text-align: right;">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          ${previewRowsHtml}
        </tbody>
      </table>
      ${count > 15 ? `<p style="margin: 8px 0 0; font-size: 13px; color: #6B7280;">...and ${count - 15} more orders in the attached CSV file.</p>` : ""}
    </div>

    <p style="margin: 20px 0 0; font-size: 14px; color: #4B5563;">
      The complete report has been generated and attached as <strong>${escapeHtml(filename)}</strong>.
    </p>
  `;

  const html = brandedEmail({
    title: `Pending Payments Report (${daysNum} Days Due)`,
    greeting: "Hi Team,",
    body: emailBody,
  });

  const textLines = [
    `Pending Payments Report — Orders Due in ${daysNum} Days`,
    `----------------------------------------------------`,
    `Window: ${windowDescription} (Singapore Time / SGT)`,
    `Timezone: Singapore Time (${TIMEZONE} / UTC+8)`,
    `Matching Orders: ${count}`,
    `Total Outstanding: ${formattedTotals}`,
    `Generated At: ${formatDateTime(new Date())} SGT`,
    "",
    count > 0 ? "Preview of matching orders:" : "No orders found.",
    ...previewOrders.map(
      (o) =>
        `- ${o.name} | ${o.companyName || o.customerName} | Due: ${o.dueAtLabel} (${o.daysDiff}d) | Outstanding: ${o.outstandingAmountLabel}`,
    ),
    "",
    `Complete details are attached in ${filename}.`,
  ];

  const emailResult = await sendEmail({
    to: recipients.join(", "),
    subject: finalSubject,
    html,
    text: textLines.join("\n"),
    attachments: [
      {
        filename,
        content: csvContent,
        contentType: "text/csv; charset=utf-8",
      },
    ],
  });

  return {
    success: true,
    recipients,
    count,
    totalsByCurrency,
    formattedTotals,
    filename,
    emailResult,
    emailSent: true,
    csvSent: true,
  };
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function parseRequestParams(url, body = {}) {
  const q = url.searchParams;

  let rawDays = body?.days ?? body?.x ?? q.get("days") ?? q.get("x");
  let mode = String(body?.mode ?? q.get("mode") ?? "within").toLowerCase();

  if (String(rawDays).toLowerCase() === "overdue") {
    mode = "overdue";
    rawDays = 0;
  } else if (
    mode === "overdue" &&
    (rawDays === undefined || rawDays === null || String(rawDays).trim() === "")
  ) {
    rawDays = 0;
  }
  const to = body?.to ?? body?.email ?? q.get("to") ?? q.get("email") ?? "";
  const includeOverdueStr = String(
    body?.include_overdue ??
    body?.includeOverdue ??
    q.get("include_overdue") ??
    q.get("includeOverdue") ??
    "false",
  ).toLowerCase();
  const includeOverdue = includeOverdueStr === "true" || includeOverdueStr === "1";

  const downloadStr = String(
    body?.download ?? q.get("download") ?? "false",
  ).toLowerCase();
  const download = downloadStr === "true" || downloadStr === "1";

  const sendEmailStr = String(
    body?.send_email ??
    body?.sendEmail ??
    q.get("send_email") ??
    q.get("sendEmail") ??
    "true",
  ).toLowerCase();
  const sendEmail = sendEmailStr !== "false" && sendEmailStr !== "0";

  const subject = body?.subject ?? q.get("subject") ?? "";
  const notes = body?.notes ?? q.get("notes") ?? "";
  const shop = body?.shop ?? q.get("shop") ?? "";
  const search = body?.search ?? body?.q ?? q.get("search") ?? q.get("q") ?? "";

  return {
    rawDays,
    rawX: rawDays, // backwards-compatible alias
    to,
    mode,
    includeOverdue,
    download,
    sendEmail,
    subject,
    notes,
    shop,
    search,
  };
}

export async function handlePendingPaymentsCsv(request, body = {}) {
  const url = new URL(request.url);
  const params = parseRequestParams(url, body);

  const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });

  if (params.rawDays === undefined || params.rawDays === null || String(params.rawDays).trim() === "") {
    return jsonResponse(
      {
        success: false,
        error: "Missing required parameter 'days' (number of days). Example: /api/pending-payments-csv?days=7",
        usage: {
          endpoint: "/api/pending-payments-csv",
          methods: ["GET", "POST"],
          parameters: {
            days: "Required. Number of days (e.g. 7 for due within 7 days, 0 for due today, negative for overdue). Alias: 'x'.",
            to: "Optional. Recipient email address(es), comma-separated. Defaults to configured notification recipients.",
            mode: "Optional. 'within' (default), 'exact' (only orders due on exact day), 'upcoming', or 'overdue'.",
            include_overdue: "Optional boolean. When mode='within', true includes overdue orders.",
            download: "Optional boolean. If true and matching orders exist, directly downloads the CSV file in response.",
            send_email: "Optional boolean. Defaults to true. Set false to skip email delivery.",
            shop: "Optional. Shopify shop domain (e.g. hyve-promo.myshopify.com).",
          },
        },
      },
      400,
    );
  }

  const daysNum = Number(params.rawDays);
  if (!Number.isFinite(daysNum)) {
    return jsonResponse(
      {
        success: false,
        error: `Invalid value for parameter 'days': "${params.rawDays}". Must be a valid number of days.`,
      },
      400,
    );
  }

  try {
    const { admin, shop, shopHandle } = await getShopifyAdmin(params.shop);

    const rawOrders = await fetchAllPendingOrders(admin);
    const parsedOrders = rawOrders.map((o) => parseOrderNode(o, shopHandle));

    const matchedOrders = filterOrdersDueInDays(parsedOrders, daysNum, {
      mode: params.mode,
      includeOverdue: params.includeOverdue,
      searchQuery: params.search,
    });

    // If there is no order found, do NOT send CSV or email
    if (matchedOrders.length === 0) {
      const recipients = await resolveRecipients(admin, params.to);
      return jsonResponse({
        success: true,
        shop,
        days: daysNum,
        parameterDays: daysNum,
        parameterX: daysNum,
        mode: params.mode,
        includeOverdue: params.includeOverdue,
        matchingOrdersCount: 0,
        totalsByCurrency: {},
        formattedTotals: "0.00",
        recipients,
        emailSent: false,
        csvSent: false,
        csvFilename: null,
        timezone: `Singapore Time (${TIMEZONE})`,
        generatedAt: `${formatDateTime(new Date())} SGT`,
        preview: [],
        message: `No orders found with payment due in ${daysNum} days. No CSV or email was sent.`,
      });
    }

    const totalsByCurrency = calculateTotalsByCurrency(matchedOrders);
    const formattedTotals = Object.entries(totalsByCurrency)
      .map(([curr, amt]) => formatMoney(amt, curr))
      .join(" + ") || "0.00";

    const cleanDateStr = singaporeDateKey(new Date());
    const daysStr = daysNum < 0 ? `overdue-${Math.abs(daysNum)}d` : `${daysNum}d`;
    const filename = `pending-payments-due-${daysStr}-${cleanDateStr}.csv`;

    let emailSent = false;
    let recipients = [];
    let emailError = null;

    if (params.sendEmail) {
      try {
        const emailResult = await sendPendingPaymentsCsvEmail({
          admin,
          orders: matchedOrders,
          days: daysNum,
          mode: params.mode,
          includeOverdue: params.includeOverdue,
          to: params.to,
          subject: params.subject,
          notes: params.notes,
          shopHandle,
        });
        emailSent = Boolean(emailResult.emailSent);
        recipients = emailResult.recipients || [];
      } catch (err) {
        console.error("[api/pending-payments-csv] Email dispatch failed:", err);
        emailError = err?.message || String(err);
      }
    } else {
      recipients = await resolveRecipients(admin, params.to);
    }

    if (params.download) {
      const csvContent = buildOrdersCsv(matchedOrders, shopHandle);
      return new Response(csvContent, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          ...CORS_HEADERS,
        },
      });
    }

    return jsonResponse({
      success: true,
      shop,
      days: daysNum,
      parameterDays: daysNum,
      parameterX: daysNum,
      mode: params.mode,
      includeOverdue: params.includeOverdue,
      matchingOrdersCount: matchedOrders.length,
      totalsByCurrency,
      formattedTotals,
      recipients,
      emailSent,
      csvSent: emailSent,
      emailError,
      csvFilename: filename,
      timezone: `Singapore Time (${TIMEZONE})`,
      generatedAt: `${formatDateTime(new Date())} SGT`,
      preview: matchedOrders.slice(0, 10).map((o) => ({
        orderName: o.name,
        customerName: o.customerName,
        companyName: o.companyName,
        customerEmail: o.customerEmail,
        dueAt: o.dueAtLabel,
        daysDiff: o.daysDiff,
        status: o.statusLabel,
        outstanding: o.outstandingAmountLabel,
        adminUrl: o.adminUrl,
      })),
      message: emailSent
        ? `CSV report with ${matchedOrders.length} orders successfully sent to ${recipients.join(", ")}.`
        : `Generated CSV report with ${matchedOrders.length} orders (email sending was disabled or skipped).`,
    });
  } catch (err) {
    console.error("[api/pending-payments-csv] Error processing request:", err);
    return jsonResponse(
      {
        success: false,
        error: err?.message || String(err),
      },
      500,
    );
  }
}

/**
 * Send an individual payment reminder notification to a customer for a specific order.
 * Includes official bank transfer remittance details and records the notification timestamp in Shopify.
 */
export async function sendCustomerOrderPaymentReminder(admin, order, { bankConfig } = {}) {
  const pendingAmount = Number(order.outstandingAmount ?? 0);
  if (!Number.isFinite(pendingAmount) || pendingAmount <= 0) {
    return {
      ok: false,
      skipped: true,
      orderId: order.id,
      orderName: order.name,
      error: "Order pending amount is 0 or already settled.",
    };
  }

  const recipientEmail = String(order.customerEmail || "").trim();
  if (!recipientEmail || !recipientEmail.includes("@")) {
    return {
      ok: false,
      skipped: true,
      orderId: order.id,
      orderName: order.name,
      error: "Customer does not have a valid email address on file.",
    };
  }

  const orderName = order.name;
  const outstanding = order.outstandingAmountLabel || formatMoney(order.outstandingAmount, order.currency);
  const dueDate = order.dueAtLabel || "On Receipt";
  const terms = order.termsName || "Standard";
  const countryCode = order.countryCode || "";
  const currency = order.currency || "USD";
  const customerName = order.customerName || "";

  const config = bankConfig || (await loadBankDetailsConfig(admin));
  let bank = bankAccountFor(countryCode || currency, config?.accounts);

  if (!bank || !Array.isArray(bank.rows) || bank.rows.length === 0) {
    const isSgd =
      (currency || "").toUpperCase() === "SGD" ||
      (countryCode || "").toUpperCase() === "SG";
    if (isSgd) {
      bank = config?.accounts?.DBS_SGD?.rows?.length
        ? config.accounts.DBS_SGD
        : DEFAULT_ACCOUNTS.DBS_SGD;
    } else {
      bank = config?.accounts?.CFSB_USD?.rows?.length
        ? config.accounts.CFSB_USD
        : DEFAULT_ACCOUNTS.CFSB_USD;
    }
  }

  const bankRowsHtml = `
    <div style="background-color: #F7F7F8; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; margin: 20px 0;">
      <div style="font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 12px;">
        ${escapeHtml(bank.heading || "Bank Transfer Remittance Details")}
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.6;">
        ${bank.rows
          .map(
            ([label, val]) => `
          <tr>
            <td style="padding: 5px 0; color: #6B7280; width: 160px; font-weight: 500; vertical-align: top;">${escapeHtml(
              label,
            )}:</td>
            <td style="padding: 5px 0; color: #111827; font-weight: 600; vertical-align: top;">${escapeHtml(
              val,
            )}</td>
          </tr>
        `,
          )
          .join("")}
        <tr>
          <td style="padding: 8px 0 2px 0; color: #6B7280; font-weight: 500; border-top: 1px dashed #E5E7EB; vertical-align: top;">Payment Reference:</td>
          <td style="padding: 8px 0 2px 0; color: #059669; font-weight: 700; font-size: 15px; border-top: 1px dashed #E5E7EB; vertical-align: top;">${escapeHtml(
            orderName,
          )}</td>
        </tr>
      </table>
    </div>
  `;

  const subject = `Payment Reminder: Invoice / Order ${orderName} (${outstanding} Outstanding)`;

  const emailBody = `
    <p style="margin: 0 0 14px; line-height: 1.7; font-size: 15px; color: #111827;">
      This is a friendly reminder regarding the outstanding balance for order <strong>${escapeHtml(
        orderName,
      )}</strong>.
    </p>

    <p style="margin: 0 0 14px; line-height: 1.7; font-size: 15px; color: #111827;">
      To settle this balance via bank transfer / wire, please find our official bank remittance details below:
    </p>

    ${bankRowsHtml}

    <p style="margin: 14px 0 0; line-height: 1.6; font-size: 14px; color: #4B5563;">
      <em>Please include the payment reference <strong>${escapeHtml(
        orderName,
      )}</strong> in your wire/transfer notes so we can reconcile your payment without delay.</em>
    </p>

    <p style="margin: 14px 0 0; line-height: 1.6; font-size: 14px; color: #6B7280;">
      If you have already sent this payment, please disregard this notice or reply with your payment advice receipt.
    </p>
  `;

  const html = brandedEmail({
    title: "Payment Reminder",
    greeting: customerName ? `Hi ${escapeHtml(customerName)},` : "Hi,",
    body: emailBody,
    details: [
      ["Order", escapeHtml(orderName)],
      ["Outstanding Balance", escapeHtml(outstanding)],
      ["Payment Terms", escapeHtml(terms || "Standard")],
      ["Due Date", escapeHtml(dueDate || "On Receipt")],
    ],
  });

  const textLines = [
    customerName ? `Hi ${customerName},` : "Hi,",
    "",
    `This is a friendly reminder regarding the outstanding balance for order ${orderName}.`,
    "",
    `Order: ${orderName}`,
    `Outstanding Balance: ${outstanding}`,
    `Payment Terms: ${terms || "Standard"}`,
    `Due Date: ${dueDate || "On Receipt"}`,
    "",
    `--- ${bank.heading || "Bank Transfer Remittance Details"} ---`,
    ...bank.rows.map(([label, val]) => `${label}: ${val}`),
    `Payment Reference: ${orderName}`,
    "",
    `Please include payment reference ${orderName} in your wire notes.`,
    "If you have already sent this payment, please disregard this notice or reply with your payment receipt.",
    "",
    "Thank you,",
    "Hyve Accounts Receivable",
  ];

  await sendEmail({
    to: recipientEmail,
    subject,
    html,
    text: textLines.join("\n"),
  });

  const sentAtIso = new Date().toISOString();
  if (admin && order.id) {
    try {
      const fullGid = order.id.startsWith("gid://")
        ? order.id
        : `gid://shopify/Order/${order.id}`;

      await admin.graphql(
        `#graphql
          mutation RecordPaymentReminderNotification($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            metafields: [
              {
                ownerId: fullGid,
                namespace: "$app",
                key: "last_payment_reminder_sent_at",
                type: "date_time",
                value: sentAtIso,
              },
            ],
          },
        },
      );
    } catch (metaErr) {
      console.warn("[pending-payments] Could not record notification metafield:", metaErr);
    }
  }

  return {
    ok: true,
    orderId: order.id,
    orderName,
    recipientEmail,
    sentAt: sentAtIso,
  };
}

/**
 * Finds all orders due in `days` and sends customer payment reminder notifications.
 */
export async function sendRemindersForOrdersDueInDays(admin, days, options = {}) {
  const daysNum = Number(days);
  if (!Number.isFinite(daysNum)) {
    throw new Error(`Invalid days parameter: "${days}". Expected a valid number of days.`);
  }

  const dryRun = Boolean(options.dryRun);
  const rawOrders = await fetchAllPendingOrders(admin);
  const shopHandle = options.shopHandle || "hyve-promo";
  const parsedOrders = rawOrders.map((o) => parseOrderNode(o, shopHandle));

  const matchedOrders = filterOrdersDueInDays(parsedOrders, daysNum, {
    mode: options.mode,
    includeOverdue: options.includeOverdue,
    searchQuery: options.searchQuery,
  });

  if (matchedOrders.length === 0) {
    return {
      success: true,
      dryRun,
      days: daysNum,
      totalMatched: 0,
      sentCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
      message: `No orders found with payment due in ${daysNum} days. No reminder notifications were sent.`,
    };
  }

  const bankConfig = await loadBankDetailsConfig(admin);
  const results = [];
  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const order of matchedOrders) {
    if (!order.customerEmail || !order.customerEmail.includes("@")) {
      skippedCount++;
      results.push({
        orderId: order.id,
        orderName: order.name,
        customerName: order.customerName,
        customerEmail: order.customerEmail || "",
        outstanding: order.outstandingAmountLabel,
        dueAt: order.dueAtLabel,
        daysDiff: order.daysDiff,
        status: "skipped",
        reason: "Customer does not have a valid email address on file.",
      });
      continue;
    }

    if (dryRun) {
      results.push({
        orderId: order.id,
        orderName: order.name,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        outstanding: order.outstandingAmountLabel,
        dueAt: order.dueAtLabel,
        daysDiff: order.daysDiff,
        status: "dry_run",
        reason: "Simulated reminder notification (dry run).",
      });
      continue;
    }

    try {
      const res = await sendCustomerOrderPaymentReminder(admin, order, { bankConfig });
      if (res.ok) {
        sentCount++;
        results.push({
          orderId: order.id,
          orderName: order.name,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          outstanding: order.outstandingAmountLabel,
          dueAt: order.dueAtLabel,
          daysDiff: order.daysDiff,
          status: "sent",
          sentAt: res.sentAt,
        });
      } else {
        failedCount++;
        results.push({
          orderId: order.id,
          orderName: order.name,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          status: "failed",
          error: res.error,
        });
      }
    } catch (err) {
      failedCount++;
      results.push({
        orderId: order.id,
        orderName: order.name,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        status: "failed",
        error: err?.message || String(err),
      });
    }
  }

  return {
    success: true,
    dryRun,
    days: daysNum,
    totalMatched: matchedOrders.length,
    sentCount: dryRun ? 0 : sentCount,
    skippedCount,
    failedCount,
    results,
    message: dryRun
      ? `Dry run complete. Found ${matchedOrders.length} orders due in ${daysNum} days (${matchedOrders.length - skippedCount} eligible for customer notification).`
      : `Successfully sent ${sentCount} payment reminders for orders due in ${daysNum} days (${skippedCount} skipped, ${failedCount} failed).`,
  };
}

/**
 * Handle incoming requests to the Payment Reminders API.
 */
export async function handlePaymentRemindersApi(request, body = {}) {
  const url = new URL(request.url);
  const q = url.searchParams;

  const rawDays = body?.days ?? body?.x ?? q.get("days") ?? q.get("x");
  const dryRunStr = String(
    body?.dry_run ?? body?.dryRun ?? q.get("dry_run") ?? q.get("dryRun") ?? "false",
  ).toLowerCase();
  const dryRun = dryRunStr === "true" || dryRunStr === "1";

  const mode = String(body?.mode ?? q.get("mode") ?? "within").toLowerCase();
  const includeOverdueStr = String(
    body?.include_overdue ??
    body?.includeOverdue ??
    q.get("include_overdue") ??
    q.get("includeOverdue") ??
    "false",
  ).toLowerCase();
  const includeOverdue = includeOverdueStr === "true" || includeOverdueStr === "1";
  const shopParam = body?.shop ?? q.get("shop") ?? "";
  const search = body?.search ?? body?.q ?? q.get("search") ?? q.get("q") ?? "";

  const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });

  if (rawDays === undefined || rawDays === null || String(rawDays).trim() === "") {
    return jsonResponse(
      {
        success: false,
        error: "Missing required parameter 'days' (number of days). Example: /api/payment-reminders?days=7",
        usage: {
          endpoint: "/api/payment-reminders",
          methods: ["GET", "POST"],
          parameters: {
            days: "Required. Number of days (e.g. 7 for orders due in 7 days, 0 for due today, negative for overdue). Alias: 'x'.",
            dry_run: "Optional boolean. If true, simulates and previews targets without sending emails.",
            mode: "Optional. 'within' (default), 'exact', 'upcoming', or 'overdue'.",
            include_overdue: "Optional boolean. When mode='within', true includes overdue orders.",
            shop: "Optional. Shopify shop domain (e.g. hyve-promo.myshopify.com).",
          },
        },
      },
      400,
    );
  }

  const daysNum = Number(rawDays);
  if (!Number.isFinite(daysNum)) {
    return jsonResponse(
      {
        success: false,
        error: `Invalid value for parameter 'days': "${rawDays}". Must be a valid number of days.`,
      },
      400,
    );
  }

  try {
    const { admin, shop, shopHandle } = await getShopifyAdmin(shopParam);
    const summary = await sendRemindersForOrdersDueInDays(admin, daysNum, {
      dryRun,
      mode,
      includeOverdue,
      searchQuery: search,
      shopHandle,
    });

    return jsonResponse({
      ...summary,
      shop,
      timezone: `Singapore Time (${TIMEZONE})`,
      generatedAt: `${formatDateTime(new Date())} SGT`,
    });
  } catch (err) {
    console.error("[api/payment-reminders] Error dispatching reminders:", err);
    return jsonResponse(
      {
        success: false,
        error: err?.message || String(err),
      },
      500,
    );
  }
}


