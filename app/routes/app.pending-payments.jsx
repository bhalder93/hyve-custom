/* eslint-disable react/prop-types */
import { useState, useCallback, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { bankAccountFor, DEFAULT_ACCOUNTS } from "../lib/bank-details.server";
import { loadBankDetailsConfig } from "../lib/bank-settings.server";
import { sendEmail } from "../lib/mailer.server";
import { brandedEmail, escapeHtml } from "../utils/email.server";

const DEFAULT_PAGE_SIZE = 50;

const TABS = [
  { id: "all", label: "All Pending" },
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Due Today" },
  { id: "7days", label: "Due Next 7 Days" },
  { id: "future", label: "Due Later" },
];

const QUERY = `#graphql
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
        totalPriceSet {
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
    companyCount: companies(first: 1) {
      nodes {
        id
      }
    }
  }
`;

function getDayDiff(dueAtDate) {
  if (!dueAtDate) return null;
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDueDate = new Date(
    dueAtDate.getFullYear(),
    dueAtDate.getMonth(),
    dueAtDate.getDate(),
  ).getTime();
  const diffTime = startOfDueDate - startOfToday;
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

function classifyPaymentStatus(schedule, daysDiff) {
  if (schedule?.completedAt)
    return { key: "paid", label: "Paid", tone: "success" };
  if (daysDiff === null)
    return { key: "no_due_date", label: "Pending", tone: "warning" };
  if (daysDiff < 0)
    return {
      key: "overdue",
      label: `Overdue (${Math.abs(daysDiff)}d)`,
      tone: "critical",
    };
  if (daysDiff === 0)
    return { key: "today", label: "Due Today", tone: "attention" };
  if (daysDiff <= 7)
    return { key: "7days", label: `Due in ${daysDiff}d`, tone: "warning" };
  return { key: "future", label: `Due in ${daysDiff}d`, tone: "neutral" };
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("en-SG", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return iso;
  }
}

function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("en-SG", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return iso;
  }
}

function formatMoney(amount, currency = "USD") {
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

function parseOrderNode(order) {
  const numericId = order.id.split("/").pop();
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
  const status = classifyPaymentStatus(schedule, daysDiff);

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
  };
}

export const DUE_TYPE_OPTIONS = [
  { id: "all", label: "All Pending Orders", description: "All unpaid and pending orders (no days filter)", daysBadge: "All" },
  { id: "overdue", label: "All Overdue Orders", description: "All orders past payment due date (< 0 days)", daysBadge: "< 0 days" },
  { id: "overdue_1_15", label: "Overdue (1 to 15 days)", description: "Orders overdue by 1 to 15 days", daysBadge: "-1 to -15d" },
  { id: "overdue_16_30", label: "Overdue (16 to 30 days)", description: "Orders overdue by 16 to 30 days", daysBadge: "-16 to -30d" },
  { id: "overdue_30_plus", label: "Overdue (30+ days)", description: "Orders severely overdue by more than 30 days", daysBadge: "< -30d" },
  { id: "today", label: "Due Today", description: "Orders scheduled for payment today (0 days)", daysBadge: "0 days" },
  { id: "7days", label: "Due in Next 7 Days", description: "Upcoming payments due within 1 to 7 days (including today)", daysBadge: "0 to 7d" },
  { id: "14days", label: "Due in Next 14 Days", description: "Upcoming payments due within next 2 weeks (0 to 14 days)", daysBadge: "0 to 14d" },
  { id: "30days", label: "Due in Next 30 Days", description: "Upcoming payments due within next 30 days", daysBadge: "0 to 30d" },
  { id: "future", label: "Due Later (> 7 days)", description: "Orders with payment scheduled beyond the next 7 days", daysBadge: "> 7d" },
  { id: "future_30_plus", label: "Due Later (> 30 days)", description: "Orders with payment scheduled beyond the next 30 days", daysBadge: "> 30d" },
  { id: "custom_overdue", label: "Custom Overdue (> X days)", description: "Orders overdue by more than specified days", daysBadge: "Custom" },
  { id: "custom_due", label: "Custom Due (Within X days)", description: "Orders due within specified days", daysBadge: "Custom" },
];

function matchesDueType(order, dueType, customDays = 0) {
  if (!dueType || dueType === "all") return true;

  const d = order.daysDiff;
  if (d === null) {
    return dueType === "no_due_date";
  }

  switch (dueType) {
    case "overdue":
      return d < 0;
    case "overdue_1_15":
      return d < 0 && d >= -15;
    case "overdue_16_30":
      return d < -15 && d >= -30;
    case "overdue_30_plus":
      return d < -30;
    case "today":
      return d === 0;
    case "7days":
      return d >= 0 && d <= 7;
    case "14days":
      return d >= 0 && d <= 14;
    case "30days":
      return d >= 0 && d <= 30;
    case "future":
      return d > 7;
    case "future_30_plus":
      return d > 30;
    case "custom_overdue":
      return d < 0 && Math.abs(d) >= Math.max(1, Number(customDays) || 1);
    case "custom_due":
      return d >= 0 && d <= Math.max(1, Number(customDays) || 1);
    default:
      if (dueType === "today") return d === 0;
      if (dueType === "7days") return d >= 0 && d <= 7;
      return true;
  }
}

function filterOrdersByDueType(orders, dueType, searchQuery, customDays = 0) {
  const q = String(searchQuery || "").trim().toLowerCase();
  return orders.filter((o) => {
    if (!matchesDueType(o, dueType, customDays)) return false;

    if (q) {
      const matchesName = o.name.toLowerCase().includes(q);
      const matchesCustomer = o.customerName.toLowerCase().includes(q);
      const matchesCompany = o.companyName.toLowerCase().includes(q);
      const matchesPo = o.poNumber.toLowerCase().includes(q);
      const matchesEmail = o.customerEmail.toLowerCase().includes(q);
      const matchesNotified = (o.lastNotifiedLabel || "")
        .toLowerCase()
        .includes(q);
      const matchesCreated = (o.createdAtLabel || "")
        .toLowerCase()
        .includes(q);
      if (
        !matchesName &&
        !matchesCustomer &&
        !matchesCompany &&
        !matchesPo &&
        !matchesEmail &&
        !matchesNotified &&
        !matchesCreated
      ) {
        return false;
      }
    }
    return true;
  });
}

function filterOrders(orders, activeTab, searchQuery) {
  return filterOrdersByDueType(orders, activeTab, searchQuery, 0);
}

function buildOrdersCsv(orders) {
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
    csvLines.push(
      [
        r.name,
        r.createdAtLabel,
        r.lastNotifiedLabel || "—",
        r.customerName,
        r.companyName,
        r.customerEmail,
        r.customerPhone || "—",
        r.poNumber,
        r.termsName,
        r.dueAtLabel,
        formatDaysLabel(r.daysDiff),
        r.daysDiff !== null && r.daysDiff !== undefined ? String(r.daysDiff) : "—",
        r.statusLabel,
        r.currency,
        Number(r.totalAmount || 0).toFixed(2),
        Number(r.outstandingAmount || 0).toFixed(2),
        Number(r.paidAmount || 0).toFixed(2),
        r.numericId
          ? `https://admin.shopify.com/store/hyve-promo/orders/${r.numericId}`
          : "—",
      ]
        .map(escapeCsv)
        .join(","),
    );
  }

  return "\uFEFF" + csvLines.join("\r\n");
}

async function fetchAllPendingOrders(admin) {
  const baseOrderQuery =
    "financial_status:pending OR financial_status:partially_paid OR financial_status:unpaid";
  let allOrders = [];
  let hasNext = true;
  let cursor = null;
  let batches = 0;

  while (hasNext && batches < 10) {
    batches++;
    const response = await admin.graphql(QUERY, {
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

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  // URL query params
  const exportCsv = url.searchParams.get("export") === "csv";
  const activeTab =
    url.searchParams.get("tab") || url.searchParams.get("filter") || "all";
  const searchQuery = (
    url.searchParams.get("q") ||
    url.searchParams.get("search") ||
    ""
  ).trim();
  const pageParam = Math.max(
    1,
    parseInt(url.searchParams.get("page") || "1", 10) || 1,
  );
  const pageSize = DEFAULT_PAGE_SIZE;

  let allOrders = [];
  try {
    allOrders = await fetchAllPendingOrders(admin);
  } catch (err) {
    console.error("[pending-payments] loader failed", err);
    return {
      orders: [],
      pagination: {
        page: 1,
        pageSize,
        totalPages: 1,
        totalCount: 0,
        hasPreviousPage: false,
        hasNextPage: false,
      },
      counts: { all: 0, overdue: 0, today: 0, "7days": 0, future: 0 },
      amounts: { all: 0, overdue: 0, today: 0, "7days": 0, future: 0 },
      totals: { count: 0, totalOutstanding: 0 },
      activeTab,
      searchQuery,
      error: err?.message || String(err),
    };
  }

  const parsedOrders = allOrders.map(parseOrderNode);

  // Calculate tab counts and monetary totals across ALL pending orders
  let overdueCount = 0;
  let overdueSum = 0;
  let todayCount = 0;
  let todaySum = 0;
  let next7DaysCount = 0;
  let next7DaysSum = 0;
  let futureCount = 0;
  let futureSum = 0;
  let totalPendingSum = 0;

  for (const o of parsedOrders) {
    totalPendingSum += o.outstandingAmount;
    if (o.statusKey === "overdue") {
      overdueCount++;
      overdueSum += o.outstandingAmount;
    } else if (o.statusKey === "today") {
      todayCount++;
      todaySum += o.outstandingAmount;
    } else if (o.statusKey === "7days") {
      next7DaysCount++;
      next7DaysSum += o.outstandingAmount;
    } else if (o.statusKey === "future") {
      futureCount++;
      futureSum += o.outstandingAmount;
    }
  }

  const counts = {
    all: parsedOrders.length,
    overdue: overdueCount,
    today: todayCount,
    "7days": next7DaysCount + todayCount,
    future: futureCount,
  };

  const amounts = {
    all: totalPendingSum,
    overdue: overdueSum,
    today: todaySum,
    "7days": next7DaysSum + todaySum,
    future: futureSum,
  };

  // Compute metrics for all due types (days) across all pending orders
  const dueTypeMetrics = {};
  for (const opt of DUE_TYPE_OPTIONS) {
    let optCount = 0;
    let optSum = 0;
    for (const o of parsedOrders) {
      if (matchesDueType(o, opt.id)) {
        optCount++;
        optSum += o.outstandingAmount;
      }
    }
    dueTypeMetrics[opt.id] = { count: optCount, amount: optSum };
  }

  // Filter orders by active tab and search query on the server
  const filteredOrders = filterOrders(parsedOrders, activeTab, searchQuery);

  // Calculate total outstanding for currently filtered orders
  let sumOutstanding = 0;
  for (const o of filteredOrders) {
    sumOutstanding += o.outstandingAmount;
  }
  const totals = {
    count: filteredOrders.length,
    totalOutstanding: sumOutstanding,
  };

  // Handle direct server-side CSV export if requested via GET
  if (exportCsv) {
    const dueType = url.searchParams.get("dueType") || activeTab;
    const customDays = parseInt(url.searchParams.get("customDays") || "0", 10);
    const exportOrders = filterOrdersByDueType(parsedOrders, dueType, searchQuery, customDays);
    const csvContent = buildOrdersCsv(exportOrders);
    const cleanType = String(dueType || "all").replace(/_/g, "-");
    return new Response(csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="pending-payments-${cleanType}-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      },
    });
  }

  // Server-side pagination
  const totalCount = filteredOrders.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(pageParam, totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const pagedOrders = filteredOrders.slice(
    startIdx,
    startIdx + pageSize,
  );

  return {
    orders: pagedOrders,
    pagination: {
      page: currentPage,
      pageSize,
      totalPages,
      totalCount,
      hasPreviousPage: currentPage > 1,
      hasNextPage: currentPage < totalPages,
    },
    counts,
    amounts,
    dueTypeMetrics,
    totals,
    activeTab,
    searchQuery,
    error: null,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "export_csv") {
    try {
      const dueType = String(formData.get("dueType") || formData.get("tab") || "all").trim();
      const customDays = parseInt(formData.get("customDays") || "0", 10);
      const q = String(formData.get("q") || "").trim();

      const rawOrders = await fetchAllPendingOrders(admin);
      const parsedOrders = rawOrders.map(parseOrderNode);
      const filteredOrders = filterOrdersByDueType(parsedOrders, dueType, q, customDays);
      const csvContent = buildOrdersCsv(filteredOrders);
      const cleanType = dueType.replace(/_/g, "-");
      const filename = `pending-payments-${cleanType}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;

      return new Response(
        JSON.stringify({
          ok: true,
          csv: csvContent,
          filename,
          count: filteredOrders.length,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (csvErr) {
      console.error("[pending-payments] CSV export error:", csvErr);
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Failed to generate CSV: " + (csvErr?.message || String(csvErr)),
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  if (intent === "get_notify_targets") {
    try {
      const tab = String(formData.get("tab") || "all").trim();
      const q = String(formData.get("q") || "").trim();

      const rawOrders = await fetchAllPendingOrders(admin);
      const parsedOrders = rawOrders.map(parseOrderNode);
      const filteredOrders = filterOrders(parsedOrders, tab, q);

      const targets = filteredOrders
        .filter((o) => Boolean(o.customerEmail && o.customerEmail.includes("@")))
        .map((o) => ({
          id: o.id,
          numericId: o.numericId,
          name: o.name,
          email: o.customerEmail,
          customerName: o.customerName,
          outstanding: o.outstandingAmountLabel,
          dueDate: o.dueAtLabel,
          terms: o.termsName,
          countryCode: o.countryCode,
          currency: o.currency,
        }));

      return new Response(
        JSON.stringify({
          ok: true,
          targets,
          totalMatched: filteredOrders.length,
          withEmailCount: targets.length,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (err) {
      console.error("[pending-payments] get_notify_targets error:", err);
      return new Response(
        JSON.stringify({
          ok: false,
          error: err?.message || String(err),
          targets: [],
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  if (intent === "notify") {
    const orderId = String(formData.get("orderId") || "").trim();
    const orderName = String(formData.get("orderName") || "").trim();
    const recipientEmail = String(formData.get("email") || "").trim();
    const customerName = String(formData.get("customerName") || "").trim();
    const outstanding = String(formData.get("outstanding") || "").trim();
    const dueDate = String(formData.get("dueDate") || "").trim();
    const terms = String(formData.get("terms") || "").trim();
    const countryCode = String(formData.get("countryCode") || "").trim();
    const currency = String(formData.get("currency") || "USD").trim();

    if (!recipientEmail) {
      return {
        ok: false,
        error: "Customer does not have an email address on file.",
      };
    }

    try {
      const bankConfig = await loadBankDetailsConfig(admin);
      let bank = bankAccountFor(countryCode || currency, bankConfig?.accounts);

      // Ensure bank details are ALWAYS present on the email with appropriate currency fallback
      if (!bank || !Array.isArray(bank.rows) || bank.rows.length === 0) {
        const isSgd =
          (currency || "").toUpperCase() === "SGD" ||
          (countryCode || "").toUpperCase() === "SG";
        if (isSgd) {
          bank = bankConfig?.accounts?.DBS_SGD?.rows?.length
            ? bankConfig.accounts.DBS_SGD
            : DEFAULT_ACCOUNTS.DBS_SGD;
        } else {
          bank = bankConfig?.accounts?.CFSB_USD?.rows?.length
            ? bankConfig.accounts.CFSB_USD
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

      // Record last notification timestamp as order metafield
      const sentAtIso = new Date().toISOString();
      try {
        let targetOwnerId = orderId;
        if (!targetOwnerId && orderName) {
          const lookup = await admin.graphql(
            `#graphql
              query FindOrderId($query: String!) {
                orders(first: 1, query: $query) {
                  nodes { id }
                }
              }
            `,
            { variables: { query: `name:${orderName}` } },
          );
          const lookupBody = await lookup.json();
          targetOwnerId =
            lookupBody?.data?.orders?.nodes?.[0]?.id || null;
        }

        if (targetOwnerId) {
          const fullGid = targetOwnerId.startsWith("gid://")
            ? targetOwnerId
            : `gid://shopify/Order/${targetOwnerId}`;

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
        }
      } catch (metaErr) {
        console.warn(
          "[pending-payments] Could not record notification metafield:",
          metaErr,
        );
      }

      return new Response(
        JSON.stringify({
          ok: true,
          orderName,
          recipientEmail,
          sentAt: sentAtIso,
          orderId,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (sendErr) {
      console.error("[pending-payments] sendEmail failed:", sendErr);
      return new Response(
        JSON.stringify({
          ok: false,
          error: sendErr?.message || "Failed to send email.",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  return new Response(
    JSON.stringify({ ok: false, error: "Invalid intent." }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    },
  );
};

function StatusCard({
  label,
  badgeText,
  badgeTone,
  count,
  amount,
  accentColor,
  onClick,
}) {
  return (
    <s-clickable
      onClick={onClick}
      style={{
        display: "block",
        cursor: "pointer",
        borderRadius: "8px",
        backgroundColor: "#FFFFFF",
        border: "1px solid #C4CDD5",
        padding: "12px 16px",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
        transition: "all 0.15s ease-in-out",
      }}
    >
      <s-stack direction="block" gap="small-200">
        <s-grid gridTemplateColumns="1fr auto" alignItems="center">
          <s-text
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "#5C5F62",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            {label}
          </s-text>
          <s-badge tone={badgeTone}>{badgeText}</s-badge>
        </s-grid>

        <s-stack direction="inline" gap="small-200" alignItems="baseline">
          <s-text
            style={{
              fontSize: "18px",
              fontWeight: 700,
              color: accentColor || "#202223",
              lineHeight: 1.2,
            }}
          >
            {formatMoney(amount, "USD")}
          </s-text>
          <s-text
            appearance="subdued"
            style={{ fontSize: "12px", fontWeight: 500 }}
          >
            ({count} {count === 1 ? "order" : "orders"})
          </s-text>
        </s-stack>
      </s-stack>
    </s-clickable>
  );
}

export default function PendingPaymentOrders() {
  const loaderData = useLoaderData();
  const {
    orders = [],
    pagination = {
      page: 1,
      pageSize: 50,
      totalPages: 1,
      totalCount: 0,
      hasPreviousPage: false,
      hasNextPage: false,
    },
    counts = { all: 0, overdue: 0, today: 0, "7days": 0, future: 0 },
    amounts = { all: 0, overdue: 0, today: 0, "7days": 0, future: 0 },
    dueTypeMetrics = {},
    activeTab = "all",
    searchQuery: initialSearch = "",
    error,
  } = loaderData || {};

  const navigate = useNavigate();
  const shopify = useAppBridge();
  const notifyFetcher = useFetcher();
  const targetsFetcher = useFetcher();
  const exportFetcher = useFetcher();
  const tableRef = useRef(null);

  const [searchInput, setSearchInput] = useState(initialSearch);

  const [isNotifyingAll, setIsNotifyingAll] = useState(false);
  const [notifyProgress, setNotifyProgress] = useState(null);
  const [confirmNotifyBatch, setConfirmNotifyBatch] = useState(null);
  const [notifyCompletedBanner, setNotifyCompletedBanner] = useState(null);
  const [showProgressBanner, setShowProgressBanner] = useState(true);

  useEffect(() => {
    setSearchInput(initialSearch);
  }, [initialSearch]);

  const navigateWithParams = useCallback(
    (updates = {}) => {
      const params = new URLSearchParams();

      const newTab = updates.tab !== undefined ? updates.tab : activeTab;
      if (newTab && newTab !== "all") params.set("tab", newTab);

      const newSearch =
        updates.search !== undefined ? updates.search : searchInput.trim();
      if (newSearch) params.set("q", newSearch);

      const newPage = updates.page !== undefined ? updates.page : 1;
      if (newPage > 1) params.set("page", String(newPage));

      const qs = params.toString();
      navigate(`/app/pending-payments${qs ? `?${qs}` : ""}`);
    },
    [activeTab, searchInput, navigate],
  );

  // Attach event listeners for <s-table paginate="true"> built-in pagination buttons
  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    const handleNext = () => {
      if (pagination.hasNextPage) {
        navigateWithParams({ page: pagination.page + 1 });
      }
    };
    const handlePrev = () => {
      if (pagination.hasPreviousPage) {
        navigateWithParams({ page: pagination.page - 1 });
      }
    };
    el.addEventListener("nextpage", handleNext);
    el.addEventListener("previouspage", handlePrev);
    return () => {
      el.removeEventListener("nextpage", handleNext);
      el.removeEventListener("previouspage", handlePrev);
    };
  }, [
    pagination.hasNextPage,
    pagination.hasPreviousPage,
    pagination.page,
    navigateWithParams,
  ]);

  // Debounced search
  useEffect(() => {
    if (searchInput === initialSearch) return;
    const timer = setTimeout(() => {
      navigateWithParams({ search: searchInput, page: 1 });
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput, initialSearch, navigateWithParams]);

  const handleTabChange = useCallback(
    (tabId) => {
      navigateWithParams({ tab: tabId, page: 1 });
    },
    [navigateWithParams],
  );

  const [exportDueType, setExportDueType] = useState("all");
  const [exportIncludeSearch, setExportIncludeSearch] = useState(false);
  const [customDaysVal, setCustomDaysVal] = useState("30");

  const openExportModal = useCallback((initialDueType = null) => {
    const selected = initialDueType || (activeTab !== "all" ? activeTab : "all");
    setExportDueType(selected);
    try {
      shopify.modal.show("export-csv-modal");
    } catch {
      document.getElementById("export-csv-modal")?.show?.();
    }
  }, [activeTab, shopify]);

  const closeExportModal = useCallback(() => {
    try {
      shopify.modal.hide("export-csv-modal");
    } catch {
      document.getElementById("export-csv-modal")?.hide?.();
    }
  }, [shopify]);

  const isExporting = exportFetcher.state !== "idle";

  const downloadCsv = (dueTypeParam, includeSearchParam, customDaysParam) => {
    const targetDueType = dueTypeParam || exportDueType || activeTab || "all";
    const includeSearch = includeSearchParam !== undefined ? includeSearchParam : exportIncludeSearch;
    const customDays = customDaysParam !== undefined ? customDaysParam : customDaysVal;

    const form = new FormData();
    form.set("intent", "export_csv");
    form.set("dueType", targetDueType);
    if (customDays) form.set("customDays", String(customDays));
    if (includeSearch && searchInput.trim()) {
      form.set("q", searchInput.trim());
    }

    exportFetcher.submit(form, { method: "post" });
  };

  useEffect(() => {
    if (exportFetcher.state === "idle" && exportFetcher.data) {
      if (exportFetcher.data.ok && exportFetcher.data.csv) {
        try {
          const blob = new Blob([exportFetcher.data.csv], {
            type: "text/csv;charset=utf-8;",
          });
          const url = window.URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download =
            exportFetcher.data.filename || "pending-payments.csv";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => window.URL.revokeObjectURL(url), 10000);
          closeExportModal();
          shopify.toast.show(
            `CSV exported successfully (${exportFetcher.data.count ?? 0} orders)`,
          );
        } catch (downloadErr) {
          console.error(
            "[pending-payments] CSV download error:",
            downloadErr,
          );
          shopify.toast.show("Could not generate CSV file download.", {
            isError: true,
          });
        }
      } else if (exportFetcher.data.error) {
        shopify.toast.show(exportFetcher.data.error, { isError: true });
      }
    }
  }, [exportFetcher.state, exportFetcher.data, shopify, closeExportModal]);

  useEffect(() => {
    if (notifyFetcher.state === "idle" && notifyFetcher.data) {
      if (notifyFetcher.data.ok) {
        shopify.toast.show(
          `Payment reminder with bank details sent to ${notifyFetcher.data.recipientEmail}`,
        );
      } else if (notifyFetcher.data.error) {
        shopify.toast.show(notifyFetcher.data.error, { isError: true });
      }
    }
  }, [notifyFetcher.state, notifyFetcher.data, shopify]);

  const activeTabObj = TABS.find((t) => t.id === activeTab);
  const activeTabLabel = activeTabObj ? activeTabObj.label : "All Pending";
  const stopRequestedRef = useRef(false);

  const isLoadingTargets = targetsFetcher.state !== "idle";

  const handleNotifyAllClick = () => {
    const form = new FormData();
    form.set("intent", "get_notify_targets");
    form.set("tab", activeTab);
    if (searchInput.trim()) form.set("q", searchInput.trim());
    targetsFetcher.submit(form, { method: "post" });
  };

  // Watch targetsFetcher result
  useEffect(() => {
    if (targetsFetcher.state === "idle" && targetsFetcher.data) {
      const data = targetsFetcher.data;
      if (data.ok) {
        if (data.targets && data.targets.length > 0) {
          setConfirmNotifyBatch({
            targets: data.targets,
            tabLabel: activeTabLabel,
          });
        } else {
          shopify.toast.show(
            `No orders with email addresses found in ${activeTabLabel}.`,
            { isError: true },
          );
        }
      } else if (data.error) {
        shopify.toast.show(data.error, { isError: true });
      }
    }
  }, [targetsFetcher.state, targetsFetcher.data, activeTabLabel, shopify]);

  const startSendingBatch = async () => {
    if (!confirmNotifyBatch || !confirmNotifyBatch.targets.length) return;
    const targets = confirmNotifyBatch.targets;
    const tabLabel = confirmNotifyBatch.tabLabel;
    setConfirmNotifyBatch(null);
    setIsNotifyingAll(true);
    stopRequestedRef.current = false;
    setNotifyCompletedBanner(null);
    setShowProgressBanner(true);

    let sent = 0;
    let failed = 0;

    let headers = {};
    try {
      const token = await shopify.idToken?.();
      if (token) headers = { Authorization: `Bearer ${token}` };
    } catch (tokenErr) {
      console.warn("[pending-payments] Could not get idToken:", tokenErr);
    }

    for (let i = 0; i < targets.length; i++) {
      if (stopRequestedRef.current) {
        break;
      }
      const t = targets[i];
      setNotifyProgress({
        current: i,
        total: targets.length,
        currentOrder: t,
        sent,
        failed,
      });

      try {
        const form = new FormData();
        form.set("intent", "notify");
        form.set("orderId", t.id);
        form.set("orderName", t.name);
        form.set("email", t.email);
        form.set("customerName", t.customerName);
        form.set("outstanding", t.outstanding);
        form.set("dueDate", t.dueDate);
        form.set("terms", t.terms);
        form.set("countryCode", t.countryCode);
        form.set("currency", t.currency);

        const res = await fetch("/app/pending-payments", {
          method: "POST",
          headers,
          body: form,
        });

        let isSuccess = false;
        if (res.ok) {
          try {
            const resData = await res.json();
            if (
              resData?.ok === false ||
              resData?.error ||
              resData?.actionData?.ok === false
            ) {
              isSuccess = false;
            } else {
              isSuccess = true;
            }
          } catch {
            // Server returned HTTP 200/OK, email sent
            isSuccess = true;
          }
        }

        if (isSuccess) {
          sent++;
        } else {
          failed++;
        }
      } catch (err) {
        console.error(
          `[pending-payments] Error notifying ${t.name}:`,
          err,
        );
        failed++;
      }

      setNotifyProgress({
        current: i + 1,
        total: targets.length,
        currentOrder: t,
        sent,
        failed,
      });
    }

    const wasStopped = stopRequestedRef.current;
    setIsNotifyingAll(false);
    setNotifyProgress(null);

    setNotifyCompletedBanner({
      sent,
      failed,
      total: targets.length,
      wasStopped,
      tabLabel,
    });

    shopify.toast.show(
      wasStopped
        ? `Stopped. Sent ${sent} reminder${sent === 1 ? "" : "s"}.`
        : `Successfully sent ${sent} reminder${sent === 1 ? "" : "s"}.`,
    );

    // Refresh route data to display updated lastNotified timestamps
    navigateWithParams();
  };

  const handleStopNotifyAll = () => {
    stopRequestedRef.current = true;
  };

  const STATUS_CARDS = [
    {
      id: "all",
      label: "All Pending",
      count: counts.all,
      amount: amounts.all,
      badgeText: "Total Balance",
      badgeTone: "neutral",
      accentColor: "#111827",
    },
    {
      id: "overdue",
      label: "Overdue",
      count: counts.overdue,
      amount: amounts.overdue,
      badgeText: "Past Due",
      badgeTone: "critical",
      accentColor: "#DC2626",
    },
    {
      id: "today",
      label: "Due Today",
      count: counts.today,
      amount: amounts.today,
      badgeText: "Due Now",
      badgeTone: "attention",
      accentColor: "#D97706",
    },
    {
      id: "7days",
      label: "Due in 7 Days",
      count: counts["7days"],
      amount: amounts["7days"],
      badgeText: "Upcoming",
      badgeTone: "info",
      accentColor: "#2563EB",
    },
  ];

  const activeDueOption =
    DUE_TYPE_OPTIONS.find((opt) => opt.id === exportDueType) ||
    DUE_TYPE_OPTIONS[0];

  const isCustomOption =
    exportDueType === "custom_overdue" || exportDueType === "custom_due";

  const selectedExportCount = isCustomOption
    ? null
    : (dueTypeMetrics[exportDueType]?.count ??
      (exportDueType === "all"
        ? counts.all
        : exportDueType === "overdue"
          ? counts.overdue
          : exportDueType === "today"
            ? counts.today
            : exportDueType === "7days"
              ? counts["7days"]
              : exportDueType === "future"
                ? counts.future
                : 0));

  const selectedExportAmount = isCustomOption
    ? null
    : (dueTypeMetrics[exportDueType]?.amount ??
      (exportDueType === "all"
        ? amounts.all
        : exportDueType === "overdue"
          ? amounts.overdue
          : exportDueType === "today"
            ? amounts.today
            : exportDueType === "7days"
              ? amounts["7days"]
              : exportDueType === "future"
                ? amounts.future
                : 0));

  return (
    <s-page heading="Pending Payment Orders" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        icon="export"
        commandFor="export-csv-modal"
        command="--show"
        onClick={() => openExportModal()}
        loading={isExporting || undefined}
      >
        Export CSV report
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="notification"
        onClick={handleNotifyAllClick}
        disabled={isNotifyingAll || counts[activeTab] === 0 || undefined}
        loading={isLoadingTargets || undefined}
      >
        Notify All ({activeTabLabel})
      </s-button>

      {error ? (
        <s-banner tone="critical" heading="Could not load pending payments">
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      ) : null}

      {/* Executive KPI Summary Cards */}
      <s-section>
        <s-grid
          gridTemplateColumns="@container (inline-size <= 768px) 1fr 1fr, 1fr 1fr 1fr 1fr"
          gap="base"
        >
          {STATUS_CARDS.map((card) => (
            <StatusCard
              key={card.id}
              label={card.label}
              badgeText={card.badgeText}
              badgeTone={card.badgeTone}
              count={card.count}
              amount={card.amount}
              accentColor={card.accentColor}
              onClick={() => handleTabChange(card.id)}
            />
          ))}
        </s-grid>
      </s-section>

      {/* Progress banner outside of filter + table section, dismissible */}
      {isNotifyingAll && notifyProgress && showProgressBanner ? (
        <s-banner
          tone="info"
          heading={`Sending payment reminders (${activeTabLabel})`}
          onDismiss={() => setShowProgressBanner(false)}
        >
          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-badge tone="info">
                {notifyProgress.sent + notifyProgress.failed} of{" "}
                {notifyProgress.total} (
                {Math.round(
                  ((notifyProgress.sent + notifyProgress.failed) /
                    (notifyProgress.total || 1)) *
                  100,
                )}
                %)
              </s-badge>
              <s-text>
                This may take a moment while we send each email.
              </s-text>
            </s-stack>

            {notifyProgress.currentOrder ? (
              <s-text>
                Sending to{" "}
                <s-text type="strong">
                  {notifyProgress.currentOrder.name}
                </s-text>{" "}
                ({notifyProgress.currentOrder.email})
              </s-text>
            ) : null}

            <s-stack direction="inline" gap="small-200">
              <s-button
                variant="tertiary"
                tone="critical"
                onClick={handleStopNotifyAll}
              >
                Stop sending
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      ) : null}

      {confirmNotifyBatch && !isNotifyingAll ? (
        <s-box borderRadius="base" background="subdued" padding="base">
          <s-stack direction="block" gap="small-200">
            <s-grid gridTemplateColumns="1fr auto" alignItems="center">
              <s-stack direction="inline" gap="small-100" alignItems="center">
                <s-text
                  bold
                  style={{ color: "#92400E", fontSize: "15px" }}
                >
                  Send Bulk Payment Reminders (
                  {confirmNotifyBatch.tabLabel})
                </s-text>
                <s-badge tone="attention">
                  {confirmNotifyBatch.targets.length} Recipients
                </s-badge>
              </s-stack>
              <s-button
                variant="tertiary"
                onClick={() => setConfirmNotifyBatch(null)}
              >
                Dismiss
              </s-button>
            </s-grid>
            <s-text
              style={{
                color: "#78350F",
                fontSize: "14px",
                lineHeight: 1.5,
              }}
            >
              You are about to send official payment reminder emails
              (including bank wire remittance details) to{" "}
              <strong>{confirmNotifyBatch.targets.length}</strong>{" "}
              customer
              {confirmNotifyBatch.targets.length > 1 ? "s" : ""} with
              pending balances in{" "}
              <strong>{confirmNotifyBatch.tabLabel}</strong>.
            </s-text>
            <s-stack direction="inline" gap="small-100">
              <s-button
                variant="primary"
                icon="notification"
                onClick={startSendingBatch}
              >
                Start Sending ({confirmNotifyBatch.targets.length})
              </s-button>
              <s-button onClick={() => setConfirmNotifyBatch(null)}>
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      ) : null}

      {/* Filter Tabs & Search */}
      <s-section>
        <s-stack direction="block" gap="base">
          <s-search-field
            label="Search orders"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by order #, customer, company, PO number, or email"
            value={searchInput}
            onInput={(e) => {
              setSearchInput(e.target.value ?? "");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                navigateWithParams({ search: searchInput, page: 1 });
              }
            }}
          />

          {/* Filter Pills & Actions */}
          <s-grid
            gridTemplateColumns="1fr auto"
            gap="base"
            alignItems="center"
          >
            <s-stack direction="inline" gap="small-200">
              {TABS.map((t) => (
                <s-button
                  key={t.id}
                  variant={activeTab === t.id ? "primary" : "tertiary"}
                  onClick={() => handleTabChange(t.id)}
                >
                  {t.label} ({counts[t.id] ?? 0})
                </s-button>
              ))}
            </s-stack>

            <s-stack direction="inline" gap="small-200">
              <s-button
                variant="secondary"
                icon="export"
                onClick={() => openExportModal(activeTab)}
                disabled={isExporting || undefined}
              >
                Export CSV ({activeTabLabel})
              </s-button>
              <s-button
                variant="secondary"
                icon="notification"
                onClick={handleNotifyAllClick}
                disabled={isNotifyingAll || counts[activeTab] === 0 || undefined}
                loading={isLoadingTargets || undefined}
              >
                Notify All {activeTabLabel} ({counts[activeTab] ?? 0})
              </s-button>
            </s-stack>
          </s-grid>

          {/* Completion Banner */}
          {notifyCompletedBanner ? (
            <s-banner
              tone={
                notifyCompletedBanner.failed > 0 ? "warning" : "success"
              }
              heading={
                notifyCompletedBanner.wasStopped
                  ? `Reminder sending stopped (${notifyCompletedBanner.sent} of ${notifyCompletedBanner.total} sent)`
                  : `Payment reminders sent (${notifyCompletedBanner.sent} of ${notifyCompletedBanner.total})`
              }
              onDismiss={() => setNotifyCompletedBanner(null)}
            >
              <s-paragraph>
                Successfully sent{" "}
                <strong>{notifyCompletedBanner.sent}</strong> email
                reminder
                {notifyCompletedBanner.sent === 1 ? "" : "s"} with bank
                remittance details to customers in{" "}
                <strong>{notifyCompletedBanner.tabLabel}</strong>.
                {notifyCompletedBanner.failed > 0
                  ? ` (${notifyCompletedBanner.failed} failed)`
                  : ""}
              </s-paragraph>
            </s-banner>
          ) : null}

          {/* Table with Native Built-in Pagination */}
          {orders.length === 0 ? (
            <s-box
              padding="large-100"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small-200" alignItems="center">
                <s-heading>No orders found</s-heading>
                <s-paragraph color="subdued">
                  {counts.all === 0
                    ? "There are currently no orders with pending payment."
                    : "No orders match this filter or search."}
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table
              ref={tableRef}
              variant="auto"
              paginate="true"
              hasNextPage={pagination.hasNextPage ? "true" : "false"}
              hasPreviousPage={
                pagination.hasPreviousPage ? "true" : "false"
              }
              onNextPage={() =>
                navigateWithParams({ page: pagination.page + 1 })
              }
              onPreviousPage={() =>
                navigateWithParams({ page: pagination.page - 1 })
              }
              onnextpage={() =>
                navigateWithParams({ page: pagination.page + 1 })
              }
              onpreviouspage={() =>
                navigateWithParams({ page: pagination.page - 1 })
              }
            >
              <s-table-header-row>
                <s-table-header listSlot="primary">Order</s-table-header>
                <s-table-header>Customer / Company</s-table-header>
                <s-table-header>PO Number</s-table-header>
                <s-table-header>Payment Terms</s-table-header>
                <s-table-header>Due Date</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header format="currency">
                  Outstanding
                </s-table-header>
                <s-table-header format="currency">
                  Total
                </s-table-header>
                <s-table-header>Last Reminder Sent</s-table-header>
                <s-table-header>Action</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {orders.map((o) => (
                  <s-table-row key={o.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-link
                          href={`shopify:admin/orders/${o.numericId}`}
                          target="_blank"
                          bold
                        >
                          {o.name}
                        </s-link>
                        <s-text appearance="subdued">
                          {o.createdAtLabel}
                        </s-text>
                      </s-stack>
                    </s-table-cell>

                    <s-table-cell>
                      <s-text bold>
                        {o.companyName || o.customerName || "—"}
                      </s-text>
                      <s-stack direction="block" gap="none">
                        {o.companyName && o.customerName ? (
                          <s-text appearance="subdued">
                            {o.customerName}
                          </s-text>
                        ) : null}
                        {o.customerEmail ? (
                          <s-text appearance="subdued">
                            {o.customerEmail}
                          </s-text>
                        ) : null}
                      </s-stack>
                    </s-table-cell>

                    <s-table-cell>
                      <s-text>{o.poNumber}</s-text>
                    </s-table-cell>

                    <s-table-cell>
                      <s-text>{o.termsName}</s-text>
                    </s-table-cell>

                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{o.dueAtLabel}</s-text>
                        {o.daysDiff !== null ? (
                          <s-text
                            tone={
                              o.daysDiff < 0
                                ? "critical"
                                : o.daysDiff === 0
                                  ? "attention"
                                  : "subdued"
                            }
                          >
                            {o.daysDiff < 0
                              ? `${Math.abs(o.daysDiff)}d overdue`
                              : o.daysDiff === 0
                                ? "Due today"
                                : ``}
                          </s-text>
                        ) : null}
                      </s-stack>
                    </s-table-cell>

                    <s-table-cell>
                      <s-badge tone={o.statusTone}>
                        {o.statusLabel}
                      </s-badge>
                    </s-table-cell>

                    <s-table-cell>
                      <s-text bold tone={o.statusTone}>
                        {o.outstandingAmountLabel}
                      </s-text>
                    </s-table-cell>

                    <s-table-cell>
                      <s-text>{o.totalAmountLabel}</s-text>
                      {o.paidAmount > 0 ? (
                        <s-text appearance="subdued">
                          Paid: {formatMoney(o.paidAmount, o.currency)}
                        </s-text>
                      ) : null}
                    </s-table-cell>

                    <s-table-cell>
                      {o.lastNotifiedLabel ? (
                        <s-stack direction="block" gap="none">
                          <s-text bold tone="success">
                            {o.lastNotifiedLabel}
                          </s-text>
                          <s-text
                            appearance="subdued"
                            style={{ fontSize: "11px" }}
                          >
                            Reminder sent
                          </s-text>
                        </s-stack>
                      ) : (
                        <s-stack direction="block" gap="none">
                          <s-text appearance="subdued">
                            {o.createdAtLabel}
                          </s-text>
                          <s-text
                            appearance="subdued"
                            style={{ fontSize: "11px" }}
                          >
                            Order created (not reminded)
                          </s-text>
                        </s-stack>
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <s-stack direction="inline" gap="small-100">
                        {o.customerEmail ? (
                          <s-button
                            icon="notification"
                            variant="secondary"
                            loading={
                              notifyFetcher.state !== "idle" &&
                                (notifyFetcher.formData?.get("orderId") ===
                                  o.id ||
                                  notifyFetcher.formData?.get("orderName") ===
                                  o.name)
                                ? true
                                : undefined
                            }
                            onClick={() => {
                              const form = new FormData();
                              form.set("intent", "notify");
                              form.set("orderId", o.id);
                              form.set("orderName", o.name);
                              form.set("email", o.customerEmail);
                              form.set("customerName", o.customerName);
                              form.set(
                                "outstanding",
                                o.outstandingAmountLabel,
                              );
                              form.set("dueDate", o.dueAtLabel);
                              form.set("terms", o.termsName);
                              form.set("countryCode", o.countryCode);
                              form.set("currency", o.currency);
                              notifyFetcher.submit(form, { method: "post" });
                            }}
                          >
                            Send Reminder
                          </s-button>
                        ) : null}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          {/* Subdued order count indicator */}
          {pagination && pagination.totalCount > 0 ? (
            <s-box padding="small-200">
              <s-text appearance="subdued" alignment="center">
                Showing{" "}
                {(pagination.page - 1) * pagination.pageSize + 1}–
                {Math.min(
                  pagination.page * pagination.pageSize,
                  pagination.totalCount,
                )}{" "}
                of {pagination.totalCount} orders (50 per page)
              </s-text>
            </s-box>
          ) : null}
        </s-stack>
      </s-section>

      {/* Export CSV by Due Date Modal */}
      <s-modal
        id="export-csv-modal"
        heading="Export Pending Orders CSV by Due Date"
        size="large"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Export pending and unpaid orders filtered by payment terms, due schedule, or days overdue.
            The generated CSV contains customer details, order numbers, PO references, contact info,
            due dates, outstanding balances, and exact days offset for spreadsheet analysis.
          </s-paragraph>

          <s-select
            label="Payment Due Window (Days)"
            value={exportDueType}
            onChange={(e) => setExportDueType(e.currentTarget.value)}
          >
            {DUE_TYPE_OPTIONS.map((opt) => {
              const metric = dueTypeMetrics[opt.id];
              const countText =
                opt.id === "custom_overdue" || opt.id === "custom_due"
                  ? ""
                  : ` (${metric !== undefined ? metric.count : 0} orders)`;
              return (
                <s-option key={opt.id} value={opt.id}>
                  {opt.label} — {opt.daysBadge}{countText}
                </s-option>
              );
            })}
          </s-select>

          {isCustomOption ? (
            <s-box
              padding="base"
              border="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small-200">
                <s-text bold>
                  {exportDueType === "custom_overdue"
                    ? "Custom Overdue Days Threshold"
                    : "Custom Upcoming Due Days Window"}
                </s-text>
                <s-paragraph>
                  {exportDueType === "custom_overdue"
                    ? "Specify the minimum number of days overdue. Any order overdue by more than this amount will be exported."
                    : "Specify the upcoming day range. Any order scheduled for payment between today and this day offset will be exported."}
                </s-paragraph>
                <s-text-field
                  type="number"
                  label="Number of Days"
                  value={customDaysVal}
                  onInput={(e) => setCustomDaysVal(e.target.value ?? "0")}
                  min="1"
                  max="365"
                />
              </s-stack>
            </s-box>
          ) : null}

          {searchInput.trim() ? (
            <s-checkbox
              label={`Filter export using current search: "${searchInput.trim()}"`}
              checked={exportIncludeSearch}
              onChange={(e) =>
                setExportIncludeSearch(Boolean(e.currentTarget.checked))
              }
            />
          ) : null}

          {/* Live Export Summary Box */}
          <s-box
            padding="base"
            border="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small-100">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text bold>{activeDueOption.label}</s-text>
                <s-badge
                  tone={
                    activeDueOption.id.includes("overdue")
                      ? "critical"
                      : activeDueOption.id === "today"
                        ? "attention"
                        : activeDueOption.id.includes("days")
                          ? "info"
                          : "neutral"
                  }
                >
                  {activeDueOption.daysBadge}
                </s-badge>
              </s-stack>
              <s-paragraph>{activeDueOption.description}</s-paragraph>
              {!isCustomOption ? (
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  style={{ marginTop: "4px" }}
                >
                  <s-text>
                    Total orders to export:{" "}
                    <strong>{selectedExportCount}</strong>
                  </s-text>
                  <s-text>
                    Total outstanding balance:{" "}
                    <strong>
                      {formatMoney(selectedExportAmount, "USD")}
                    </strong>
                  </s-text>
                </s-stack>
              ) : (
                <s-text appearance="subdued">
                  The server will calculate all matching orders with custom day offset ({customDaysVal || 0} days) on export.
                </s-text>
              )}
            </s-stack>
          </s-box>
        </s-stack>

        <s-button
          slot="secondary-actions"
          commandFor="export-csv-modal"
          command="--hide"
          onClick={closeExportModal}
          disabled={isExporting || undefined}
        >
          Cancel
        </s-button>

        <s-button
          slot="primary-action"
          variant="primary"
          icon="export"
          loading={isExporting || undefined}
          disabled={
            isExporting ||
            (!isCustomOption && selectedExportCount === 0) ||
            undefined
          }
          onClick={() =>
            downloadCsv(exportDueType, exportIncludeSearch, customDaysVal)
          }
        >
          {isExporting
            ? "Exporting..."
            : isCustomOption
              ? "Download CSV (Custom Days)"
              : `Download CSV (${selectedExportCount} orders)`}
        </s-button>
      </s-modal>
    </s-page>
  );
}