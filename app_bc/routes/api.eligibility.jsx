import { checkEligibility } from "../lib/eligibility.server";

/**
 * Dummy eligibility API — "our own API" that decides whether a customer may
 * place an order. Deliberately standalone so it can be called three ways:
 *
 *   GET  /api/eligibility?email=a@b.com&tags=credit-hold   (browser/curl testing)
 *   POST /api/eligibility  {"email":"a@b.com","tags":["credit-hold"]}
 *
 * The metafield sync (app/lib/eligibility-sync.server.js) calls the POST form
 * over real HTTP, so the round trip is genuinely exercised rather than faked.
 *
 * Auth: set ELIGIBILITY_API_TOKEN and callers must send
 * `Authorization: Bearer <token>`. Unset (local dev) leaves the endpoint open.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const loader = async ({ request }) => {
  // React Router routes OPTIONS to the loader, so the CORS preflight lands here.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const denied = rejectUnauthorized(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const email = url.searchParams.get("email") || "";
  const tags = splitTags(url.searchParams.get("tags"));

  return json(checkEligibility({ email, tags }));
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const denied = rejectUnauthorized(request);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400);
  }

  const tags = Array.isArray(body?.tags) ? body.tags : splitTags(body?.tags);
  return json(checkEligibility({ email: body?.email || "", tags }));
};

/** Bearer check — only enforced when ELIGIBILITY_API_TOKEN is configured. */
function rejectUnauthorized(request) {
  // eslint-disable-next-line no-undef
  const token = process.env.ELIGIBILITY_API_TOKEN;
  if (!token) return null;

  const header = request.headers.get("Authorization") || "";
  if (header === `Bearer ${token}`) return null;

  return json({ error: "Unauthorized" }, 401);
}

function splitTags(value) {
  return String(value || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
