import { authenticate } from "../shopify.server";
import { esc, PORTAL_TOKENS } from "../lib/account-shell.server";
import { SUPPORT_EMAIL, WHATSAPP_URL } from "../lib/customer-service.server";
import { loadProofFromLink, readProofLink, recordEmailProofDecision } from "../lib/proof.server";
import { orderRequiresPhysicalSample } from "../lib/portal.server";

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
    if (!link) return liquid(page(problem("This link isn't valid. Please use the buttons in your Artwork Proof email.")));

    const found = await loadProofFromLink(admin, link);
    if (!found.ok) return liquid(page(problem(found.error)));

    return liquid(page(decisionForm(found.order, params)));
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[proof-link] could not show the proof decision", error);
    return liquid(page(problem("We couldn't load this Artwork Proof. Please try again in a moment.")));
  }
};

export const action = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);
  const params = new URL(request.url).searchParams;

  try {
    const link = readProofLink(params);
    if (!link) return liquid(page(problem("This link isn't valid. Please use the buttons in your Artwork Proof email.")));

    const form = await request.formData();
    const decision = String(form.get("decision") || "");

    const ipAddress = (request.headers.get("true-client-ip") || request.headers.get("x-shopify-client-ip") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "").split(",")[0].trim();
    const userAgent = String(form.get("client_user_agent") || "").trim() || request.headers.get("user-agent") || "";

    const result = await recordEmailProofDecision(admin, link, decision, form.get("message"), ipAddress, userAgent);
    if (!result.ok) return liquid(page(problem(result.error)));

    return liquid(
      page(
        done(
          decision === "approve"
            ? (result.isSampleOrder
                ? `Thank you — the Artwork Proof for ${result.orderName} is approved. Approved — Sample Preparation. The physical sample is being prepared before production begins.`
                : `Thank you — the Artwork Proof for ${result.orderName} is approved. We'll start production and email you when it's complete.`)
            : `Thanks — we've passed your changes for ${result.orderName} to the team. We'll email you the next Artwork Proof.`,
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

function decisionForm(order, params) {
  const version = order.proofVersion?.value;
  const proofUrl = order.proofUrl?.value;
  const isImage = proofUrl ? /[.](jpg|jpeg|png|webp|gif|bmp)$/i.test(proofUrl.split("?")[0].split("#")[0].trim()) : false;
  const isSampleOrder = orderRequiresPhysicalSample(order);

  return `
    <h1 class="hyve-proof__title">Artwork Proof Decision</h1>
    <p class="hyve-proof__meta">Order ${esc(order.name)}${version ? ` · Artwork Proof version ${esc(version)}` : ""}</p>
    
    ${isImage ? `
      <div style="margin-top: 16px; margin-bottom: 8px;">
        <a href="${esc(proofUrl)}" target="_blank" style="display: block;">
          <img src="${esc(proofUrl)}" alt="Artwork Proof" style="max-width: 100%; max-height: 500px; border-radius: 8px; border: 1px solid var(--hyve-border-strong); display: block; margin: 0 auto;" />
        </a>
      </div>
    ` : ""}
    
    ${proofUrl ? `<a class="hyve-proof__view" style="display: inline-block; margin-top: 8px;" href="${esc(proofUrl)}" target="_blank" rel="noopener">View full Artwork Proof</a>` : ""}

    <p class="hyve-proof__text" style="margin-top: 16px; margin-bottom: 24px;">Please check spelling, colours, size and placement carefully before deciding.</p>

    <form method="post" action="${esc(linkQuery(params))}" class="hyve-proof__form" style="padding: 20px; background: #f9fafb; border: 1px solid var(--hyve-border-strong); border-radius: 12px; margin-bottom: 24px;">
      <input type="hidden" name="decision" value="approve">
      <input type="hidden" name="client_user_agent" value="" class="js-user-agent">
      <h2 style="font-size: 18px; margin: 0 0 8px 0; font-weight: 700;">Happy with the proof?</h2>
      <p class="hyve-proof__text" style="margin-bottom: 16px;">
        ${isSampleOrder
          ? "We’ll prepare your sample before production begins. Your physical sample is made exactly as the Artwork Proof shows."
          : "Approving starts production, and your order is made exactly as the Artwork Proof shows."}
      </p>
      <button type="submit" class="hyve-proof__btn">Approve Artwork Proof</button>
    </form>

    <form method="post" action="${esc(linkQuery(params))}" class="hyve-proof__form" style="padding: 20px; background: #fff; border: 1px solid var(--hyve-border-strong); border-radius: 12px;">
      <input type="hidden" name="decision" value="changes">
      <input type="hidden" name="client_user_agent" value="" class="js-user-agent">
      <h2 style="font-size: 18px; margin: 0 0 8px 0; font-weight: 700;">Need changes?</h2>
      <p class="hyve-proof__text" style="margin-bottom: 16px;">Let us know what to adjust for the next version.</p>
      <label class="hyve-proof__label" for="hyve-proof-message">What needs changing?</label>
      <textarea id="hyve-proof-message" name="message" rows="5" maxlength="900" required class="hyve-proof__input"
        placeholder="For example: make the logo 20% larger and use white instead of black."></textarea>
      <button type="submit" class="hyve-proof__btn" style="background: #fff; color: var(--hyve-900); border: 1px solid var(--hyve-900); align-self: flex-start; margin-top: 8px;">Send change request</button>
    </form>
    
    <script>
      document.addEventListener("DOMContentLoaded", function() {
        document.querySelectorAll('.js-user-agent').forEach(function(el) {
          el.value = navigator.userAgent;
        });
      });
    </script>`;
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
