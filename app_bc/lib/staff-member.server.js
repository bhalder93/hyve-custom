/**
 * Who is signed in to the Hyve Custom app, for "Changed by" on an order's
 * Production timeline (HYV-100).
 *
 * The app talks to Shopify as the store rather than as a person, so the
 * session doesn't say who is at the keyboard. The ID token Shopify sends with
 * every admin request does, and exchanging it for an online access token
 * returns the staff member it belongs to. Their email is always in that
 * reply; a name is used if Shopify includes one. No extra scope is needed:
 * reading staff members directly would need read_users, which this app can't
 * have.
 *
 * @param {Request} request the admin request, carrying the ID token
 * @param {object} sessionToken its decoded payload, from authenticate.admin
 * @returns {Promise<string>} "" when it can't be read
 */
export async function staffMemberLabel(request, sessionToken) {
  const idToken =
    String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    new URL(request.url).searchParams.get("id_token") ||
    "";
  const shop = String(sessionToken?.dest || "").replace(/^https?:\/\//, "");
  if (!idToken || !shop) return "";

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: idToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        requested_token_type: "urn:shopify:params:oauth:token-type:online-access-token",
      }),
    });
    if (!response.ok) {
      console.warn("[staff-member] token exchange failed", response.status);
      return "";
    }
    const user = (await response.json())?.associated_user || {};
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return name || String(user.email || "").trim();
  } catch (error) {
    console.warn("[staff-member] token exchange threw", error?.message || error);
    return "";
  }
}
