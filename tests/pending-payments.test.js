import test from "node:test";
import assert from "node:assert/strict";
import {
  filterOrdersDueInXDays,
  classifyPaymentStatus,
  formatMoney,
  buildOrdersCsv,
  calculateTotalsByCurrency,
  parseOrderNode,
  parseRequestParams,
  handlePendingPaymentsCsv,
  sendCustomerOrderPaymentReminder,
  handlePaymentRemindersApi,
} from "../app/lib/pending-payments.server.js";

const mockOrders = [
  {
    id: "gid://shopify/Order/1001",
    numericId: "1001",
    name: "#1001",
    daysDiff: 3,
    customerName: "Alice Smith",
    companyName: "Acme Corp",
    customerEmail: "alice@acme.com",
    totalAmount: 1500,
    outstandingAmount: 1500,
    paidAmount: 0,
    currency: "USD",
    statusLabel: "Due in 3d",
    statusTone: "warning",
    poNumber: "PO-1001",
    termsName: "Net 30",
    dueAt: "2026-10-18T00:00:00Z",
    dueAtLabel: "18-Oct-2026",
    createdAt: "2026-09-18T00:00:00Z",
    createdAtLabel: "18-Sep-2026",
  },
  {
    id: "gid://shopify/Order/1002",
    numericId: "1002",
    name: "#1002",
    daysDiff: 0,
    customerName: "Bob Jones",
    companyName: "Beta LLC",
    customerEmail: "bob@beta.com",
    totalAmount: 2000,
    outstandingAmount: 2000,
    paidAmount: 0,
    currency: "USD",
    statusLabel: "Due Today",
    statusTone: "attention",
    poNumber: "PO-1002",
    termsName: "Net 15",
    dueAt: "2026-10-15T00:00:00Z",
    dueAtLabel: "15-Oct-2026",
    createdAt: "2026-09-30T00:00:00Z",
    createdAtLabel: "30-Sep-2026",
  },
  {
    id: "gid://shopify/Order/1003",
    numericId: "1003",
    name: "#1003",
    daysDiff: 10,
    customerName: "Charlie Brown",
    companyName: "Charlie Inc",
    customerEmail: "charlie@inc.com",
    totalAmount: 3200,
    outstandingAmount: 3200,
    paidAmount: 0,
    currency: "USD",
    statusLabel: "Due in 10d",
    statusTone: "neutral",
    poNumber: "PO-1003",
    termsName: "Net 30",
    dueAt: "2026-10-25T00:00:00Z",
    dueAtLabel: "25-Oct-2026",
    createdAt: "2026-09-25T00:00:00Z",
    createdAtLabel: "25-Sep-2026",
  },
  {
    id: "gid://shopify/Order/1004",
    numericId: "1004",
    name: "#1004",
    daysDiff: -5,
    customerName: "David Miller",
    companyName: "Delta Ltd",
    customerEmail: "david@delta.com",
    totalAmount: 500,
    outstandingAmount: 500,
    paidAmount: 0,
    currency: "SGD",
    statusLabel: "Overdue (5d)",
    statusTone: "critical",
    poNumber: "PO-1004",
    termsName: "Net 7",
    dueAt: "2026-10-10T00:00:00Z",
    dueAtLabel: "10-Oct-2026",
    createdAt: "2026-10-03T00:00:00Z",
    createdAtLabel: "03-Oct-2026",
  },
  {
    id: "gid://shopify/Order/1005",
    numericId: "1005",
    name: "#1005",
    daysDiff: null,
    customerName: "Eve Taylor",
    companyName: "Echo Co",
    customerEmail: "eve@echo.com",
    totalAmount: 750,
    outstandingAmount: 750,
    paidAmount: 0,
    currency: "USD",
    statusLabel: "Pending",
    statusTone: "warning",
    poNumber: "—",
    termsName: "Prepaid / Custom",
    dueAt: null,
    dueAtLabel: null,
    createdAt: "2026-10-14T00:00:00Z",
    createdAtLabel: "14-Oct-2026",
  },
  {
    id: "gid://shopify/Order/1006",
    numericId: "1006",
    name: "#1006",
    daysDiff: 2,
    customerName: "Frank Zero",
    companyName: "Zero Balance LLC",
    customerEmail: "frank@zero.com",
    totalAmount: 1000,
    outstandingAmount: 0, // Discarded!
    paidAmount: 1000,
    currency: "USD",
    statusLabel: "Paid",
    statusTone: "success",
    poNumber: "PO-1006",
    termsName: "Net 15",
    dueAt: "2026-10-17T00:00:00Z",
    dueAtLabel: "17-Oct-2026",
    createdAt: "2026-10-02T00:00:00Z",
    createdAtLabel: "02-Oct-2026",
  },
];

test("filterOrdersDueInXDays filters orders due within x days (x = 7) and discards 0 pending amount", () => {
  const result = filterOrdersDueInXDays(mockOrders, 7);
  // Should include order 1001 (diff 3) and order 1002 (diff 0), but NOT order 1006 (diff 2, outstanding 0)
  assert.equal(result.length, 2);
  const ids = result.map((o) => o.numericId);
  assert.ok(ids.includes("1001"));
  assert.ok(ids.includes("1002"));
  assert.ok(!ids.includes("1006")); // Discarded because outstandingAmount === 0
  assert.ok(!ids.includes("1003")); // 10 days > 7
  assert.ok(!ids.includes("1004")); // Overdue (-5) excluded when includeOverdue is false
  assert.ok(!ids.includes("1005")); // Null due date excluded
});

test("filterOrdersDueInXDays with includeOverdue includes overdue orders", () => {
  const result = filterOrdersDueInXDays(mockOrders, 7, { includeOverdue: true });
  // Should include order 1001 (3), 1002 (0), and 1004 (-5)
  assert.equal(result.length, 3);
  const ids = result.map((o) => o.numericId);
  assert.ok(ids.includes("1001"));
  assert.ok(ids.includes("1002"));
  assert.ok(ids.includes("1004"));
  assert.ok(!ids.includes("1003"));
});

test("filterOrdersDueInXDays mode='exact' matches exact day diff", () => {
  const result = filterOrdersDueInXDays(mockOrders, 3, { mode: "exact" });
  assert.equal(result.length, 1);
  assert.equal(result[0].numericId, "1001");
});

test("filterOrdersDueInXDays with negative x filters overdue by >= |x| days", () => {
  const result = filterOrdersDueInXDays(mockOrders, -5);
  assert.equal(result.length, 1);
  assert.equal(result[0].numericId, "1004");

  const noneOverdue10 = filterOrdersDueInXDays(mockOrders, -10);
  assert.equal(noneOverdue10.length, 0);
});

test("filterOrdersDueInXDays due today (x = 0)", () => {
  const result = filterOrdersDueInXDays(mockOrders, 0);
  assert.equal(result.length, 1);
  assert.equal(result[0].numericId, "1002");
});

test("classifyPaymentStatus categorizes correctly", () => {
  assert.equal(classifyPaymentStatus({ completedAt: "2026-10-01" }, 0).key, "paid");
  assert.equal(classifyPaymentStatus(null, null).key, "no_due_date");
  assert.equal(classifyPaymentStatus(null, -3).key, "overdue");
  assert.equal(classifyPaymentStatus(null, 0).key, "today");
  assert.equal(classifyPaymentStatus(null, 5).key, "7days");
  assert.equal(classifyPaymentStatus(null, 15).key, "future");
});

test("calculateTotalsByCurrency calculates outstanding balances grouped by currency", () => {
  const totals = calculateTotalsByCurrency(mockOrders);
  // USD orders: 1500 + 2000 + 3200 + 750 = 7450
  // SGD orders: 500
  assert.equal(totals.USD, 7450);
  assert.equal(totals.SGD, 500);
});

test("buildOrdersCsv creates valid CSV with UTF-8 BOM and correct headers", () => {
  const csv = buildOrdersCsv(mockOrders, "hyve-promo");
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("Order Number,Created Date"));
  assert.ok(csv.includes("#1001"));
  assert.ok(csv.includes("Acme Corp"));
  assert.ok(csv.includes("https://admin.shopify.com/store/hyve-promo/orders/1001"));
});

test("parseOrderNode converts GraphQL node into clean pending payment order", () => {
  const rawNode = {
    id: "gid://shopify/Order/9999",
    name: "#9999",
    createdAt: "2026-10-01T12:00:00Z",
    poNumber: "PO-TEST",
    displayFinancialStatus: "PARTIALLY_PAID",
    totalPriceSet: { presentmentMoney: { amount: "1000.00", currencyCode: "USD" } },
    totalOutstandingSet: { presentmentMoney: { amount: "400.00", currencyCode: "USD" } },
    totalReceivedSet: { presentmentMoney: { amount: "600.00", currencyCode: "USD" } },
    customer: { displayName: "Jane Doe", email: "jane@test.com", phone: "+123456789" },
    billingAddress: { company: "Test Co", countryCodeV2: "US" },
    shippingAddress: { company: "Test Co", countryCodeV2: "US" },
    paymentTerms: {
      paymentTermsName: "Net 30",
      paymentSchedules: {
        nodes: [{ dueAt: "2026-10-20T00:00:00Z", completedAt: null }],
      },
    },
  };

  const parsed = parseOrderNode(rawNode, "hyve-promo");
  assert.equal(parsed.numericId, "9999");
  assert.equal(parsed.name, "#9999");
  assert.equal(parsed.totalAmount, 1000);
  assert.equal(parsed.outstandingAmount, 400);
  assert.equal(parsed.paidAmount, 600);
  assert.equal(parsed.customerName, "Jane Doe");
  assert.equal(parsed.customerEmail, "jane@test.com");
  assert.equal(parsed.companyName, "Test Co");
  assert.equal(parsed.termsName, "Net 30");
  assert.equal(parsed.adminUrl, "https://admin.shopify.com/store/hyve-promo/orders/9999");
});

test("parseRequestParams correctly extracts 'days' parameter and fallback 'x'", () => {
  const urlWithDays = new URL("https://example.com/api/pending-payments-csv?days=7&to=finance@hyve.promo&mode=exact&include_overdue=true&download=true");
  const params1 = parseRequestParams(urlWithDays);
  assert.equal(params1.rawDays, "7");
  assert.equal(params1.to, "finance@hyve.promo");
  assert.equal(params1.mode, "exact");
  assert.equal(params1.includeOverdue, true);
  assert.equal(params1.download, true);
  assert.equal(params1.sendEmail, true);

  // Test backwards compatibility with ?x=14
  const urlWithX = new URL("https://example.com/api/pending-payments-csv?x=14");
  const params2 = parseRequestParams(urlWithX);
  assert.equal(params2.rawDays, "14");
  assert.equal(params2.rawX, "14");
});

test("sendPendingPaymentsCsvEmail does not send email or CSV when no orders found", async () => {
  const { sendPendingPaymentsCsvEmail } = await import("../app/lib/pending-payments.server.js");
  const result = await sendPendingPaymentsCsvEmail({
    admin: null,
    orders: [],
    days: 7,
    to: "test@example.com",
  });
  assert.equal(result.success, true);
  assert.equal(result.count, 0);
  assert.equal(result.emailSent, false);
  assert.equal(result.csvSent, false);
  assert.equal(result.filename, null);
  assert.ok(result.reason.includes("No matching orders found"));
});

test("API handler rejects missing days parameter with 400", async () => {
  const request = new Request("https://example.com/api/pending-payments-csv", {
    method: "GET",
  });
  const response = await handlePendingPaymentsCsv(request);
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.success, false);
  assert.ok(data.error.includes("Missing required parameter 'days'"));
  assert.ok(data.usage);
});

test("API handler rejects missing days in JSON body with 400", async () => {
  const request = new Request("https://example.com/api/pending-payments-csv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const response = await handlePendingPaymentsCsv(request, { to: "test@example.com" });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.success, false);
  assert.ok(data.error.includes("Missing required parameter 'days'"));
});

test("API handler rejects invalid non-numeric days with 400", async () => {
  const request = new Request("https://example.com/api/pending-payments-csv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const response = await handlePendingPaymentsCsv(request, { days: "invalid_days" });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.success, false);
  assert.ok(data.error.includes("Invalid value for parameter 'days'"));
});

test("sendCustomerOrderPaymentReminder safely skips order without customer email", async () => {
  const res = await sendCustomerOrderPaymentReminder(null, {
    id: "gid://shopify/Order/123",
    name: "#123",
    outstandingAmount: 250,
    customerEmail: "",
  });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.ok(res.error.includes("email"));
});

test("sendCustomerOrderPaymentReminder safely skips order with 0 pending amount", async () => {
  const res = await sendCustomerOrderPaymentReminder(null, {
    id: "gid://shopify/Order/124",
    name: "#124",
    outstandingAmount: 0,
    customerEmail: "customer@example.com",
  });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.ok(res.error.includes("0 or already settled"));
});

test("Payment reminders API rejects missing days parameter with 400", async () => {
  const request = new Request("https://example.com/api/payment-reminders", {
    method: "GET",
  });
  const response = await handlePaymentRemindersApi(request);
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.success, false);
  assert.ok(data.error.includes("Missing required parameter 'days'"));
  assert.ok(data.usage);
});

test("filterOrdersDueInDays with mode='overdue' returns all overdue orders only", () => {
  const result = filterOrdersDueInXDays(mockOrders, 0, { mode: "overdue" });
  assert.equal(result.length, 1);
  assert.equal(result[0].numericId, "1004");
  assert.equal(result[0].daysDiff, -5);
});

test("parseRequestParams supports days='overdue' or mode='overdue'", () => {
  const url1 = new URL("https://example.com/api/pending-payments-csv?days=overdue");
  const p1 = parseRequestParams(url1);
  assert.equal(p1.mode, "overdue");
  assert.equal(p1.rawDays, 0);

  const url2 = new URL("https://example.com/api/pending-payments-csv?mode=overdue");
  const p2 = parseRequestParams(url2);
  assert.equal(p2.mode, "overdue");
  assert.equal(p2.rawDays, 0);
});



