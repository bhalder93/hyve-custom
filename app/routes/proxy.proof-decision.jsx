import { authenticate } from "../shopify.server";
import { esc, PORTAL_TOKENS } from "../lib/account-shell.server";
import { SUPPORT_EMAIL, WHATSAPP_URL } from "../lib/customer-service.server";
import { loadProofFromLink, readProofLink, recordEmailProofDecision } from "../lib/proof.server";

/**
 * Approve proof / Request changes from the proof email (ART-03).
 * Storefront: /apps/account/proof-decision?order=<id>&v=<version>&sig=<signature>&decision=approve|changes
 *
 * No sign-in: the signed link is the permission. Opening the link only shows
 * the decision; it is recorded when the buyer presses the button. Mail
 * scanners open every link in an email, so a link that acted on its own would
 * approve proofs nobody had looked at.
 */
export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);
  const params = new URL(request.url).searchParams;

  try {
    const link = readProofLink(params);
    if (!link) return liquid(page(problem("This link isn't valid. Please use the buttons in your proof email.")));

    const found = await loadProofFromLink(admin, link);
    if (!found.ok) return liquid(page(problem(found.error)));

    const decision = params.get("decision") === "changes" ? "changes" : "approve";
    return liquid(page(decisionForm(found.order, decision, params)));
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[proof-link] could not show the proof decision", error);
    return liquid(page(problem("We couldn't load this proof. Please try again in a moment.")));
  }
};

export const action = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);
  const params = new URL(request.url).searchParams;

  try {
    const link = readProofLink(params);
    if (!link) return liquid(page(problem("This link isn't valid. Please use the buttons in your proof email.")));

    const form = await request.formData();
    const decision = String(form.get("decision") || "");
    const result = await recordEmailProofDecision(admin, link, decision, form.get("message"));
    if (!result.ok) return liquid(page(problem(result.error)));

    return liquid(
      page(
        done(
          decision === "approve"
            ? `Thank you — the proof for ${result.orderName} is approved. We'll start production and email you when it's complete.`
            : `Thanks — we've passed your changes for ${result.orderName} to the team. We'll email you the next proof.`,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[proof-link] could not record the proof decision", error);
    return liquid(page(problem("We couldn't record that decision. Please try again in a moment.")));
  }
};

/** The link's own query, for the form to post back to and to switch decision. */
function linkQuery(params, decision) {
  const query = new URLSearchParams({ order: params.get("order"), v: params.get("v"), sig: params.get("sig") });
  if (decision) query.set("decision", decision);
  return `/apps/account/proof-decision?${query.toString()}`;
}

function decisionForm(order, decision, params) {
  const version = order.proofVersion?.value;
  const proofUrl = order.proofUrl?.value;
  const approve = decision === "approve";

  return `
    <h1 class="hyve-proof__title">${approve ? "Approve your proof" : "Request changes"}</h1>
    <p class="hyve-proof__meta">Order ${esc(order.name)}${version ? ` · Proof version ${esc(version)}` : ""}</p>
    ${proofUrl ? `<a class="hyve-proof__view" href="${esc(proofUrl)}" target="_blank" rel="noopener">View proof</a>` : ""}

    <form method="post" action="${esc(linkQuery(params))}" class="hyve-proof__form">
      <input type="hidden" name="decision" value="${approve ? "approve" : "changes"}">
      ${
        approve
          ? `<p class="hyve-proof__text">Approving starts production, and your order is made exactly as the proof shows. Please check spelling, colours, size and placement first.</p>
             <button type="submit" class="hyve-proof__btn">Approve proof</button>`
          : `<label class="hyve-proof__label" for="hyve-proof-message">What needs changing?</label>
             <textarea id="hyve-proof-message" name="message" rows="5" maxlength="900" required class="hyve-proof__input"
               placeholder="For example: make the logo 20% larger and use white instead of black."></textarea>
             <button type="submit" class="hyve-proof__btn">Send change request</button>`
      }
    </form>

    <a class="hyve-proof__switch" href="${esc(linkQuery(params, approve ? "changes" : "approve"))}">
      ${approve ? "Need changes instead?" : "Happy with the proof? Approve it instead"}
    </a>`;
}

function done(message) {
  return `
    <h1 class="hyve-proof__title">Thank you</h1>
    <p class="hyve-proof__text">${esc(message)}</p>
    <a class="hyve-proof__switch" href="/apps/account/orders">View your orders</a>`;
}

function problem(message) {
  return `
    <h1 class="hyve-proof__title">We can't take that decision here</h1>
    <p class="hyve-proof__text">${esc(message)}</p>
    <p class="hyve-proof__text">Questions? <a href="${WHATSAPP_URL}" target="_blank" rel="noopener">WhatsApp us</a> or email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
    <a class="hyve-proof__switch" href="/apps/account/orders">View your orders</a>`;
}

function page(content) {
  return `
    <div class="hyve-proof">
      <div class="hyve-proof__card">${content}</div>
    </div>
    <style>
      .hyve-proof {
        ${PORTAL_TOKENS}
        padding: 56px 16px; font-family: var(--hyve-body); color: var(--hyve-900); font-size: 14px;
      }
      .hyve-proof__card {
        max-width: 520px; margin: 0 auto; background: var(--hyve-white); border: 1px solid var(--hyve-border-strong);
        border-radius: var(--hyve-radius-lg); box-shadow: var(--hyve-shadow-sm); padding: 28px;
        display: flex; flex-direction: column; gap: 14px;
      }
      .hyve-proof__title { font-family: var(--hyve-display); font-size: 22px; font-weight: 800; margin: 0; }
      .hyve-proof__meta { margin: -8px 0 0; color: var(--hyve-500); }
      .hyve-proof__text { margin: 0; line-height: 1.6; color: var(--hyve-700); }
      .hyve-proof__text a { color: var(--hyve-900); font-weight: 600; }
      .hyve-proof__view { align-self: flex-start; color: var(--hyve-900); font-weight: 600; }
      .hyve-proof__form { display: flex; flex-direction: column; gap: 12px; margin: 0; }
      .hyve-proof__label { font-weight: 600; }
      .hyve-proof__input {
        width: 100%; box-sizing: border-box; font: inherit; color: inherit; padding: 10px 12px;
        border: 1px solid var(--hyve-border-strong); border-radius: 10px; resize: vertical;
      }
      .hyve-proof__btn {
        align-self: flex-start; border: 0; cursor: pointer; background: var(--hyve-gradient); color: #0A1414;
        font: inherit; font-weight: 700; padding: 11px 22px; border-radius: 10px;
      }
      .hyve-proof__btn:hover { filter: brightness(0.96); }
      .hyve-proof__switch { align-self: flex-start; color: var(--hyve-500); font-size: 13px; }
    </style>`;
}
