import {
  CORS_HEADERS,
  handlePaymentRemindersApi,
} from "../lib/pending-payments.server.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return handlePaymentRemindersApi(request);
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let body = {};
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON body provided." }, 400);
    }
  } else if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const formData = await request.formData();
      body = Object.fromEntries(formData.entries());
    } catch {
      // fallback
    }
  }

  return handlePaymentRemindersApi(request, body);
};
