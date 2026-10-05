/* global process */
import { verifyMailer, sendMail, getDefaultFrom, defaultReplyTo } from "../lib/email/mailer.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const to = (url.searchParams.get("to") || "").trim();
  const format = url.searchParams.get("format") || "";
  const acceptsHtml = request.headers.get("accept")?.includes("text/html");

  const result = await runEmailTest(to);

  if (acceptsHtml && format !== "json") {
    return new Response(renderHtmlDashboard(result, to), {
      status: result.ok ? 200 : 500,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  }

  return json(result, result.ok ? 200 : 500);
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let to = "";
  let subject = "";

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      const body = await request.json();
      to = String(body.to || "").trim();
      subject = String(body.subject || "").trim();
    } catch {
      return json({ ok: false, error: "Invalid JSON body" }, 400);
    }
  } else {
    try {
      const formData = await request.formData();
      to = String(formData.get("to") || "").trim();
      subject = String(formData.get("subject") || "").trim();
    } catch {
      return json({ ok: false, error: "Invalid form data" }, 400);
    }
  }

  const result = await runEmailTest(to, subject);

  const url = new URL(request.url);
  const format = url.searchParams.get("format") || "";
  const acceptsHtml = request.headers.get("accept")?.includes("text/html");

  if (acceptsHtml && format !== "json") {
    return new Response(renderHtmlDashboard(result, to), {
      status: result.ok ? 200 : 500,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  }

  return json(result, result.ok ? 200 : 500);
};

async function runEmailTest(to = "", customSubject = "") {
  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER || "";
  const from = getDefaultFrom();
  const replyTo = defaultReplyTo();

  const configSummary = {
    host: host || "(missing)",
    port,
    user: user || "(missing)",
    from,
    replyTo,
    isConfigured: Boolean(host && user && process.env.SMTP_PASS),
  };

  if (!configSummary.isConfigured) {
    return {
      ok: false,
      status: "unconfigured",
      error: "SMTP configuration is incomplete. Missing SMTP_HOST, SMTP_USER, or SMTP_PASS.",
      smtp: configSummary,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    // 1. Verify SMTP connection and authentication
    await verifyMailer();

    // 2. If recipient provided, send a real test email
    if (to) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return {
          ok: false,
          status: "invalid_email",
          error: `The email address "${to}" is not valid.`,
          smtp: configSummary,
          timestamp: new Date().toISOString(),
        };
      }

      const subject =
        customSubject || `[Hyve Test] SMTP Email Test - ${new Date().toLocaleTimeString()}`;
      const timestamp = new Date().toISOString();

      const sendResult = await sendMail({
        to,
        subject,
        text: `Hello,\n\nThis is a test email sent from the Hyve Custom App API.\n\nSMTP Host: ${host}\nTimestamp: ${timestamp}\nStatus: Working\n\nBest regards,\nHyve Team`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
            <div style="background-color: #f0fdf4; border-left: 4px solid #16a34a; padding: 12px 16px; margin-bottom: 20px;">
              <h2 style="color: #166534; margin: 0; font-size: 18px;">&#10004; Hyve Email Service is Active</h2>
            </div>
            <p style="color: #334155; font-size: 14px; line-height: 1.6;">
              This test email confirms that SMTP outbound delivery from the <strong>Hyve Custom App</strong> is operating correctly.
            </p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 13px; font-family: monospace; background: #f8fafc; border-radius: 6px;">
              <tr>
                <td style="padding: 8px 12px; color: #64748b; border-bottom: 1px solid #e2e8f0;">SMTP Host:</td>
                <td style="padding: 8px 12px; color: #0f172a; font-weight: 600; border-bottom: 1px solid #e2e8f0;">${host}:${port}</td>
              </tr>
              <tr>
                <td style="padding: 8px 12px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Sender:</td>
                <td style="padding: 8px 12px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${from}</td>
              </tr>
              <tr>
                <td style="padding: 8px 12px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Recipient:</td>
                <td style="padding: 8px 12px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${to}</td>
              </tr>
              <tr>
                <td style="padding: 8px 12px; color: #64748b;">Timestamp:</td>
                <td style="padding: 8px 12px; color: #0f172a;">${timestamp}</td>
              </tr>
            </table>
            <p style="color: #94a3b8; font-size: 12px; margin: 0;">
              Generated by <code>/api/test-email</code>.
            </p>
          </div>
        `,
      });

      return {
        ok: true,
        status: "email_sent",
        message: `Test email successfully sent to ${to}`,
        messageId: sendResult.messageId,
        recipient: to,
        subject,
        smtp: configSummary,
        timestamp,
      };
    }

    return {
      ok: true,
      status: "connected",
      message: "SMTP server connected and verified successfully. Email service is working.",
      smtp: configSummary,
      hint: "Add ?to=recipient@example.com to send an actual test email.",
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      status: "connection_error",
      error: err?.message || String(err),
      code: err?.code || null,
      command: err?.command || null,
      smtp: configSummary,
      timestamp: new Date().toISOString(),
    };
  }
}

function renderHtmlDashboard(result, to) {
  const statusColor = result.ok ? "#16a34a" : "#dc2626";
  const statusBg = result.ok ? "#f0fdf4" : "#fef2f2";
  const statusBorder = result.ok ? "#bbf7d0" : "#fecaca";
  const statusTitle = result.ok
    ? result.status === "email_sent"
      ? "Test Email Sent Successfully!"
      : "SMTP Connected & Working"
    : "Email Service Error";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hyve Email Service Diagnostic</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      margin: 0;
      padding: 40px 20px;
      display: flex;
      justify-content: center;
    }
    .card {
      background: #ffffff;
      max-width: 620px;
      width: 100%;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.06);
      border: 1px solid #e2e8f0;
      overflow: hidden;
    }
    .header {
      padding: 24px;
      background: #0f172a;
      color: #ffffff;
    }
    .header h1 {
      margin: 0 0 6px 0;
      font-size: 20px;
      font-weight: 700;
    }
    .header p {
      margin: 0;
      font-size: 13px;
      color: #94a3b8;
    }
    .content {
      padding: 24px;
    }
    .status-banner {
      background: ${statusBg};
      border: 1px solid ${statusBorder};
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: ${statusColor};
      margin-top: 4px;
      flex-shrink: 0;
    }
    .status-text h2 {
      margin: 0 0 4px 0;
      font-size: 16px;
      color: ${statusColor};
    }
    .status-text p {
      margin: 0;
      font-size: 14px;
      color: #334155;
    }
    .table-section {
      margin-bottom: 24px;
    }
    .table-section h3 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748b;
      margin: 0 0 8px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid #f1f5f9;
    }
    td.label {
      color: #64748b;
      width: 130px;
    }
    td.val {
      color: #0f172a;
      font-family: monospace;
      word-break: break-all;
    }
    .form-section {
      background: #f8fafc;
      border-radius: 8px;
      padding: 16px;
      border: 1px solid #e2e8f0;
    }
    .form-section h3 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
    }
    .form-group {
      display: flex;
      gap: 8px;
    }
    .input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
    }
    .input:focus {
      border-color: #16a34a;
    }
    .button {
      background: #16a34a;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 10px 18px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
    }
    .button:hover {
      background: #15803d;
    }
    .api-hint {
      margin-top: 16px;
      font-size: 12px;
      color: #64748b;
    }
    .api-hint code {
      background: #e2e8f0;
      padding: 2px 6px;
      border-radius: 4px;
      color: #0f172a;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Hyve Email Service Diagnostic</h1>
      <p>Endpoint: <code>/api/test-email</code></p>
    </div>
    <div class="content">
      <div class="status-banner">
        <div class="status-indicator"></div>
        <div class="status-text">
          <h2>${statusTitle}</h2>
          <p>${result.message || result.error || ""}</p>
        </div>
      </div>

      <div class="table-section">
        <h3>Configuration Details</h3>
        <table>
          <tr><td class="label">SMTP Host</td><td class="val">${result.smtp?.host || ""}</td></tr>
          <tr><td class="label">SMTP Port</td><td class="val">${result.smtp?.port || ""}</td></tr>
          <tr><td class="label">SMTP User</td><td class="val">${result.smtp?.user || ""}</td></tr>
          <tr><td class="label">Default From</td><td class="val">${result.smtp?.from || ""}</td></tr>
          <tr><td class="label">Reply-To</td><td class="val">${result.smtp?.replyTo || ""}</td></tr>
          ${result.messageId ? `<tr><td class="label">Message ID</td><td class="val">${result.messageId}</td></tr>` : ""}
          ${result.recipient ? `<tr><td class="label">Recipient</td><td class="val">${result.recipient}</td></tr>` : ""}
        </table>
      </div>

      <div class="form-section">
        <h3>Send Live Test Email</h3>
        <form method="POST">
          <div class="form-group">
            <input type="email" name="to" class="input" placeholder="Enter recipient email address..." value="${to || ""}" required>
            <button type="submit" class="button">Send Test</button>
          </div>
        </form>
        <div class="api-hint">
          JSON API: <code>GET /api/test-email?format=json</code> or <code>GET /api/test-email?to=your_email@example.com&amp;format=json</code>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
