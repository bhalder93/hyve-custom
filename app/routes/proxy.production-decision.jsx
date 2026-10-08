import { authenticate } from "../shopify.server";
import { esc, PORTAL_TOKENS } from "../lib/account-shell.server";
import { SUPPORT_EMAIL, WHATSAPP_URL } from "../lib/customer-service.server";
import { loadProductionPhotoFromLink, readProductionLink, recordEmailProductionDecision } from "../lib/production-approval.server";

/**
 * Approve production photo / Request changes from the email.
 * Storefront: /apps/account/production-decision?order=<id>&v=<version>&sig=<signature>&decision=approve|changes
 */
export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);
  const params = new URL(request.url).searchParams;

  try {
    const link = readProductionLink(params);
    if (!link) return liquid(page(problem("This link isn't valid. Please use the buttons in your Production Photo email.")));

    const found = await loadProductionPhotoFromLink(admin, link);
    if (!found.ok) return liquid(page(problem(found.error)));

    return liquid(page(decisionForm(found.order, params)));
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[production-link] could not show the production decision", error);
    return liquid(page(problem("We couldn't load this Production Photo. Please try again in a moment.")));
  }
};

export const action = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);
  const params = new URL(request.url).searchParams;

  try {
    const link = readProductionLink(params);
    if (!link) return liquid(page(problem("This link isn't valid. Please use the buttons in your Production Photo email.")));

    const form = await request.formData();
    const decision = String(form.get("decision") || "");

    const ipAddress = (request.headers.get("true-client-ip") || request.headers.get("x-shopify-client-ip") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "").split(",")[0].trim();
    const userAgent = String(form.get("client_user_agent") || "").trim() || request.headers.get("user-agent") || "";

    const result = await recordEmailProductionDecision(admin, link, decision, form.get("message"), ipAddress, userAgent);
    if (!result.ok) return liquid(page(problem(result.error)));

    return liquid(
      page(
        done(
          decision === "approve"
            ? `Thank you — the Production Photo for ${result.orderName} is approved. We will release your order for shipping.`
            : `Thanks — we've passed your changes for ${result.orderName} to the team. We'll email you the next Production Photo.`,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[production-link] could not record the production decision", error);
    return liquid(page(problem("We couldn't record that decision. Please try again in a moment.")));
  }
};

/** The link's own query, for the form to post back to and to switch decision. */
function linkQuery(params, decision) {
  const query = new URLSearchParams({ order: params.get("order"), v: params.get("v"), sig: params.get("sig") });
  if (decision) query.set("decision", decision);
  return `/apps/account/production-decision?${query.toString()}`;
}

function decisionForm(order, params) {
  const version = order.productionPhotoVersion?.value || "1";
  const photoUrl = order.productionPhotoUrl?.value;

  return `
    <h1 class="hyve-proof__title">Production Photo Decision</h1>
    <p class="hyve-proof__meta">Order ${esc(order.name)}${version ? ` · Photo version ${esc(version)}` : ""}</p>
    ${photoUrl ? `<a class="hyve-proof__view" href="${esc(photoUrl)}" target="_blank" rel="noopener">View production photo</a>` : ""}

    <p class="hyve-proof__text" style="margin-top: 12px; margin-bottom: 24px;">Please review the production photo carefully before deciding.</p>

    <form method="post" action="${esc(linkQuery(params))}" class="hyve-proof__form" style="padding: 20px; background: #f9fafb; border: 1px solid var(--hyve-border-strong); border-radius: 12px; margin-bottom: 24px;">
      <input type="hidden" name="decision" value="approve">
      <input type="hidden" name="client_user_agent" value="" class="js-user-agent">
      <h2 style="font-size: 18px; margin: 0 0 8px 0; font-weight: 700;">Happy with the production photo?</h2>
      <p class="hyve-proof__text" style="margin-bottom: 16px;">Approving releases the order for shipping.</p>
      <button type="submit" class="hyve-proof__btn">Approve</button>
    </form>

    <form method="post" action="${esc(linkQuery(params))}" class="hyve-proof__form" style="padding: 20px; background: #fff; border: 1px solid var(--hyve-border-strong); border-radius: 12px;">
      <input type="hidden" name="decision" value="changes">
      <input type="hidden" name="client_user_agent" value="" class="js-user-agent">
      <h2 style="font-size: 18px; margin: 0 0 8px 0; font-weight: 700;">Need changes?</h2>
      <p class="hyve-proof__text" style="margin-bottom: 16px;">Let us know what to adjust for the next version.</p>
      <label class="hyve-proof__label" for="hyve-proof-message">What needs changing?</label>
      <textarea id="hyve-proof-message" name="message" rows="5" maxlength="900" required class="hyve-proof__input"
        placeholder="For example: the finish on the sides needs adjusting."></textarea>
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
