/**
 * Quotes page for the B2B portal.
 * Quotes correspond to Shopify Draft Orders (`draftOrders`).
 *
 * Renders the Quotes management screen matching the user mockup:
 *   - Page header: "Quotes" + subtitle + "+ Request Quote" CTA button
 *   - Main card with live client-side search input & filter tabs, one per status
 *   - Quote cards with Quote #, status badge, items summary, validity / converted metadata, price, and actions
 *   - Actions: "Confirm Order" (the draft order's checkout link), "View Order", "Requote", and "PDF"
 *   - Interactive "+ Request Quote" modal to submit custom wholesale quote requests
 */

import { esc } from "./account-shell.server";
import { quoteValidUntil } from "./quote-document.server";
import { formatDate, formatMoney } from "./portal.server";
import { quoteReference, formatCountryOfOrigin } from "./quote-labels";
import { listAllExpiredQuotes } from "./expired-quotes.server";
import { purchasingCompanyFor } from "./purchasing-company.server";

/**
 * Quote statuses.
 *
 * Staff decide a quote by setting the `hyve_status` boolean metafield on its
 * draft order: true is approved, false is rejected, and an unset metafield
 * means it is still with the buyer. Nothing here is inferred from tags or
 * dates — the metafield is the only source.
 */
/**
 * The states the requirements name (I9), plus Declined, each one something
 * that has actually happened.
 *
 *   Created  — the quote exists but hasn't gone to the buyer: sales has made
 *              it and not sent it yet, or the buyer asked for one and Hyve has
 *              still to price it (HYV-99)
 *   Sent     — the quote is with the buyer and they have not acted on it
 *   Accepted — they accepted it and it became an order
 *   Declined — Hyve turned the request down
 *   Expired  — it passed its validity and was withdrawn
 *
 * Expired is real rather than cosmetic: a Shopify draft order has no expiry and
 * its payment link never stops working, so a scheduled job deletes the quote —
 * which does stop it — after copying it to an archive. An expired quote is read
 * from that archive, not from a label on a quote that would still take money.
 */
export const QUOTE_STATUSES = {
  CREATED: "created",
  SENT: "sent",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  EXPIRED: "expired",
};

export const QUOTE_STATUS_LABELS = {
  created: "Quote Created",
  sent: "Quote Sent",
  accepted: "Quote Accepted",
  declined: "Quote Declined",
  expired: "Quote Expired",
};

/** An archived quote, shaped like a live one so the page renders them together. */
export function expiredQuoteToRow(quote) {
  return {
    id: quote.id,
    name: quote.reference,
    status: QUOTE_STATUSES.EXPIRED,
    items: quote.items || "Quote",
    meta: `${quote.date} · Expired`,
    price: quote.total,
    rawAmount: 0,
    invoiceUrl: "",
    pdfHref: "",
    orderName: "",
    orderId: "",
    orderHref: "",
    createdAt: quote.expiredAt,
  };
}

/**
 * The staff decision on a quote.
 *
 * Read from `value`, the stored string, rather than `jsonValue`. The admin
 * screens read `value` and get both states right; the portal read `jsonValue`
 * and only ever saw approvals — a rejection came back as undecided, so a
 * declined quote still showed as awaiting action to the buyer.
 *
 * @returns {?boolean} true approved, false rejected, null still with the buyer
 */
export function quoteDecision(node) {
  // A quote that has become an order was accepted, whatever the metafield says
  // — the buyer acted on it. Without this the nav badge and the dashboard count
  // an ordered quote as still awaiting action, which is what the list shows the
  // opposite of.
  if (node?.status === "COMPLETED" || node?.order?.id || node?.order?.name) return true;

  const raw = node?.hyveStatus?.value;
  if (raw === null || raw === undefined || raw === "") return null;

  const value = String(raw).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

const QUOTE_OWNER_QUERY = `#graphql
  query QuoteOwner($id: ID!) {
    draftOrder(id: $id) {
      id
      email
      hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
      customer { id }
      purchasingEntity {
        ... on PurchasingCompany {
          company { id }
          contact { customer { id } }
        }
      }
    }
  }`;

const digits = (id) => String(id || "").replace(/\D/g, "");

/**
 * Whether this buyer may change the quote: their own, their company's, or,
 * signed out, one raised with the email they give (as Retrieve a Quote proves it).
 */
async function mayChangeQuote(admin, draftGid, { customerId, email }) {
  const body = await (await admin.graphql(QUOTE_OWNER_QUERY, { variables: { id: draftGid } })).json();
  const draft = body?.data?.draftOrder;
  // A quote Hyve declined isn't changed any more, as the Quotes page shows it.
  if (!draft || quoteDecision(draft) === false) return false;
  if (customerId) {
    const owner = digits(draft.customer?.id || draft.purchasingEntity?.contact?.customer?.id);
    if (owner && owner === digits(customerId)) return true;
    const company = await purchasingCompanyFor(admin, customerId);
    const draftCompany = digits(draft.purchasingEntity?.company?.id);
    return Boolean(company?.companyId && draftCompany && digits(company.companyId) === draftCompany);
  }
  return Boolean(email && draft.email && draft.email.toLowerCase() === String(email).trim().toLowerCase());
}

/**
 * The buyer's physical sample switch on a quote. The quote is saved repriced
 * like any other edit (quote-editor.server.js), so the sample goes on as one
 * line per order and the setup charge and duties follow.
 */
export async function setPhysicalSampleOnQuote(admin, { quoteId, customerId = null, email = null, sample }) {
  const draftGid = String(quoteId || "").startsWith("gid://shopify/DraftOrder/")
    ? String(quoteId)
    : `gid://shopify/DraftOrder/${digits(quoteId)}`;
  if (!/^gid:\/\/shopify\/DraftOrder\/\d+$/.test(draftGid)) return { ok: false, error: "Missing quote ID." };

  try {
    if (!(await mayChangeQuote(admin, draftGid, { customerId, email }))) {
      return { ok: false, error: "You do not have permission to modify this quote." };
    }
    const { rebuildQuote } = await import("./quote-editor.server");
    const result = await rebuildQuote(admin, draftGid, { sample: Boolean(sample) });
    if (!result.ok) return result;
    return { ok: true, message: sample ? "Physical sample added to your quote." : "Physical sample removed from your quote." };
  } catch (err) {
    console.error("[account-quotes] physical sample change failed:", err);
    return { ok: false, error: "The quote couldn't be changed. Please try again." };
  }
}


/**
 * Who made a draft order, from its "created" event. Shopify has no created-by
 * field on a draft, but the event says: a staff member's name when sales made
 * it in admin, the app when an app did, and neither when checkout made it (a
 * company that submits orders for review). Include in every draft order query
 * the quotes and orders read.
 */
export const DRAFT_ORIGIN_FIELDS = `
  createdEvent: events(first: 1, query: "action:create") {
    nodes { ... on BasicEvent { author attributeToUser attributeToApp } }
  }
  purchasingEntity { ... on PurchasingCompany { company { id } } }`;

function createdEvent(node) {
  return node?.createdEvent?.nodes?.[0] || null;
}

/**
 * A distributor's own order placed on terms and submitted for review at
 * checkout. Shopify holds it as a draft until sales releases it, but it is an
 * order, not a quote: it shows in Orders as Credit Under Review, and never in
 * Quotes, where Confirm Order would let the buyer skip the review (HYV-99).
 */
export function submittedForReview(node) {
  const event = createdEvent(node);
  return Boolean(event) && !event.attributeToUser && !event.attributeToApp;
}

/** The staff member who made a sales-issued quote, or "" when no one did. */
export function issuedBy(node) {
  const event = createdEvent(node);
  return event?.attributeToUser ? String(event.author || "").trim() : "";
}

/**
 * Where a live quote stands, from its draft order. Needs `status`, `order`,
 * `hyveStatus`, `invoiceSentAt` and `tags` on the node.
 *
 * Accepted means the buyer acted on it and it became an order. A staff
 * approval in Hyve Custom is Hyve agreeing the quote, not the buyer accepting
 * it, so it leaves the quote with the buyer.
 *
 * A quote has gone to the buyer when Shopify sent it (sales pressing Send on
 * the draft), when the buyer made it themselves from their cart, or when staff
 * approved a request. A request from the Quotes page is tagged awaiting_review
 * until Hyve prices it.
 *
 * @returns {"created"|"sent"|"accepted"|"declined"}
 */
export function quoteStatus(node) {
  if (node?.status === "COMPLETED" || node?.order?.id || node?.order?.name) return QUOTE_STATUSES.ACCEPTED;

  const decision = quoteDecision(node);
  if (decision === false) return QUOTE_STATUSES.DECLINED;

  const tags = node?.tags || [];
  const fromCart = tags.includes("storefront-quote") && !tags.includes("awaiting_review");
  // `quote-sent`: staff emailed it from Hyve Custom (HYV-166) instead of
  // Shopify's Send invoice, which is what sets invoiceSentAt.
  const emailedByStaff = tags.includes("quote-sent");
  return node?.invoiceSentAt || emailedByStaff || fromCart || decision === true
    ? QUOTE_STATUSES.SENT
    : QUOTE_STATUSES.CREATED;
}

/**
 * A distributor's quotes (HYV-99): their company's, plus drafts sales made for
 * them personally without picking the company (HYV-135). Quotes follow the
 * company, not the person, so neither another company's drafts nor the cart
 * quotes they raised before they were a distributor show here: both came up
 * under a buyer's name after they moved to a new company.
 *
 * @param {object[]} companyNodes the company's draft orders
 * @param {object[]} ownNodes drafts where the buyer is the customer, read with
 *   DRAFT_ORIGIN_FIELDS and tags
 */
export function buyerQuoteNodes(companyNodes = [], ownNodes = []) {
  const personalFromSales = ownNodes.filter(
    (node) => !node?.purchasingEntity?.company && !(node?.tags || []).includes("storefront-quote"),
  );
  return mergeQuoteNodes(companyNodes, personalFromSales);
}

/** Draft order lists joined: each quote once, most recently updated first. */
export function mergeQuoteNodes(...lists) {
  const byId = new Map();
  for (const node of lists.flat()) {
    if (node?.id && !byId.has(node.id)) byId.set(node.id, node);
  }
  const stamp = (node) => String(node.updatedAt || node.createdAt || "");
  return [...byId.values()].sort((a, b) => stamp(b).localeCompare(stamp(a)));
}

/**
 * Map Shopify Admin API DraftOrder nodes to Quote objects.
 * Uses ONLY real data from Shopify — no dummy/sample data fallback.
 */
export function mapDraftOrdersToQuotes(draftOrderNodes = []) {
  if (!Array.isArray(draftOrderNodes) || draftOrderNodes.length === 0) {
    return [];
  }

  return draftOrderNodes.filter((node) => !submittedForReview(node)).map((node, index) => {
    // Format quote name: e.g. #D1055 -> Q-1055, #1055 -> Q-1055
    let name = node.name || `Q-${index + 1}`;
    if (name.startsWith("#D")) {
      name = "Q-" + name.slice(2);
    } else if (name.startsWith("#")) {
      name = "Q-" + name.slice(1);
    } else if (!name.startsWith("Q-")) {
      name = `Q-${name}`;
    }

    const lineItems = node.lineItems?.nodes || [];
    const itemsText = lineItems.length > 0
      ? lineItems.map((li) => `${li.title}${li.quantity > 1 ? ` x${li.quantity}` : ""}`).join(" + ")
      : "Custom Wholesale Quote";

    // In the currency the quote was raised in, which is what the buyer pays
    // (HYV-98). The shop's own currency made an SGD quote read as USD.
    const money = node.totalPriceSet?.presentmentMoney || {};
    const amount = Number(money.amount) || 0;
    const formattedPrice = formatMoney(amount, money.currencyCode);

    const status = quoteStatus(node);
    let metaText = "";
    const createdDate = formatDate(node.createdAt);

    // Who the quote came from (HYV-99): the rep who made it in admin by name,
    // the buyer's own cart, or a request Hyve is pricing.
    const tags = node.tags || [];
    const requested = tags.includes("awaiting_review");
    const fromCart = tags.includes("storefront-quote") && !requested;
    const rep = issuedBy(node);
    // The same day the quote's PDF prints and its expiry reminder counts down to.
    const validUntil = ` · Valid until ${quoteValidUntil(node.createdAt).label}`;

    if (status === QUOTE_STATUSES.ACCEPTED) {
      metaText = node.order?.name
        ? `${createdDate} · Accepted · Order ${node.order.name}`
        : `${createdDate} · Accepted`;
    } else if (status === QUOTE_STATUSES.DECLINED) {
      metaText = `${createdDate} · Declined`;
    } else if (fromCart) {
      metaText = `${createdDate} · Raised from the cart${validUntil}`;
    } else if (status === QUOTE_STATUSES.CREATED) {
      metaText = requested
        ? `${createdDate} · Requested · Hyve is preparing it`
        : `${createdDate} · Being prepared${rep ? ` by ${rep}` : ""}`;
    } else {
      metaText = `${createdDate} · Sent${rep ? ` by ${rep}` : ""}${validUntil}`;
    }

    const detailedLines = lineItems.map((li) => {
      // The physical sample line carries this flag however it was added.
      const isSample = (li.customAttributes || []).some((a) => a.key === "_hyve_sample" && String(a.value) === "true");
      const unit = Number(
        li.discountedUnitPriceSet?.presentmentMoney?.amount ??
        li.originalUnitPriceSet?.presentmentMoney?.amount ??
        0,
      );
      const originalUnit = Number(li.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
      const qty = Number(li.quantity) || 1;
      const cur =
        li.discountedUnitPriceSet?.presentmentMoney?.currencyCode ||
        li.originalUnitPriceSet?.presentmentMoney?.currencyCode ||
        money.currencyCode ||
        "USD";

      const hsCode =
        li.variant?.inventoryItem?.harmonizedSystemCode ||
        (li.customAttributes || []).find((a) =>
          /^(hs[\s_-]?code|harmonized\s*(system|tariff)?\s*code|tariff\s*code)$/i.test(a.key),
        )?.value || "";
      const rawOrigin =
        li.variant?.inventoryItem?.countryCodeOfOrigin ||
        (li.customAttributes || []).find((a) =>
          /^(country\s*of\s*origin|coo|origin|made\s*in)$/i.test(a.key),
        )?.value || "";
      const countryOfOrigin = formatCountryOfOrigin ? formatCountryOfOrigin(rawOrigin) : rawOrigin;

      const visibleAttributes = (li.customAttributes || []).filter(
        (a) =>
          a.key &&
          !a.key.startsWith("_") &&
          !/^(hs[\s_-]?code|harmonized\s*(system|tariff)?\s*code|tariff\s*code)$/i.test(a.key) &&
          !/^(country\s*of\s*origin|coo|origin|made\s*in)$/i.test(a.key),
      );

      const variantTitle =
        li.variantTitle && li.variantTitle !== "Default Title"
          ? li.variantTitle
          : (li.variant?.selectedOptions || [])
              .filter((opt) => opt.name !== "Title" || opt.value !== "Default Title")
              .map((opt) => `${opt.name}: ${opt.value}`)
              .join(", ");

      const imageUrl = li.image?.url || li.product?.featuredImage?.url || "";
      const imageAlt = li.image?.altText || li.product?.featuredImage?.altText || li.title || li.name || "Product";

      return {
        id: li.id,
        title: li.title || li.name || "Item",
        variantTitle,
        sku: li.sku || "",
        quantity: qty,
        unitPrice: formatMoney(unit, cur),
        originalUnitPrice: originalUnit > unit ? formatMoney(originalUnit, cur) : null,
        totalPrice: formatMoney(unit * qty, cur),
        imageUrl,
        imageAlt,
        hsCode,
        countryOfOrigin,
        attributes: visibleAttributes,
        isSample,
      };
    });

    const hasPhysicalSample = detailedLines.some((l) => l.isSample);
    const isOpen =
      status !== QUOTE_STATUSES.ACCEPTED &&
      status !== QUOTE_STATUSES.DECLINED &&
      status !== QUOTE_STATUSES.EXPIRED &&
      !node.order?.id &&
      node.status !== "COMPLETED";

    const subtotalAmount = Number(node.subtotalPriceSet?.presentmentMoney?.amount ?? 0);
    const formattedSubtotal = formatMoney(subtotalAmount, money.currencyCode);
    const shippingAmount = Number(node.totalShippingPriceSet?.presentmentMoney?.amount ?? 0);
    const formattedShipping = formatMoney(shippingAmount, money.currencyCode);
    const validUntilLabel = quoteValidUntil(node.createdAt).label;

    return {
      id: node.id,
      name,
      status,
      items: itemsText,
      meta: metaText,
      price: formattedPrice,
      rawAmount: amount,
      invoiceUrl: node.invoiceUrl || "",
      // A real PDF built from the draft order, not the browser's print dialog.
      pdfHref: `/apps/account/quotes/pdf?draft=${encodeURIComponent(node.id)}`,
      orderName: node.order?.name || "",
      orderId: node.order?.id || "",
      orderHref: node.order?.name ? `/apps/account/orders?order=${encodeURIComponent(node.order.name)}` : "/apps/account/orders",
      createdAt: node.createdAt,
      lineItems: detailedLines,
      hasPhysicalSample,
      isOpen,
      subtotal: formattedSubtotal,
      shipping: formattedShipping,
      validUntilLabel,
    };
  });
}

/**
 * Render the complete Quotes page HTML.
 */
export function quotesPage({ quotes = [], notice = null, error = null }) {
  const hasQuotes = quotes && quotes.length > 0;
  const quoteRowsHtml = hasQuotes ? quotes.map((q) => renderQuoteRow(q)).join("") : "";

  return `
  ${QUOTES_STYLES}
  <div class="hyve-quotes">
    ${notice ? `<div class="hyve-quotes__alert hyve-quotes__alert--success">${esc(notice)}</div>` : ""}
    ${error ? `<div class="hyve-quotes__alert hyve-quotes__alert--error">${esc(error)}</div>` : ""}

    <!-- Header -->
    <div class="hyve-quotes__header">
      <div class="hyve-quotes__header-text">
        <h1 class="hyve-quotes__title">Quotes</h1>
        <p class="hyve-quotes__subtitle">Manage your price quotes and proposals</p>
      </div>

      <button type="button" class="hyve-quotes__cta-btn" onclick="openRequestQuoteModal()">
        ${icoPlus()}
        <span>Request Quote</span>
      </button>
    </div>

    <!-- Main Card Container -->
    <div class="hyve-quotes__card">
      ${hasQuotes ? `
      <!-- Toolbar: Search + Filter Tabs -->
      <div class="hyve-quotes__toolbar">
        <div class="hyve-quotes__search-box">
          ${icoSearch()}
          <input
            type="text"
            id="quoteSearchInput"
            class="hyve-quotes__search-input"
            placeholder="Search quotes..."
            autocomplete="off"
          />
        </div>

        <div class="hyve-quotes__tabs" role="tablist">
          <button type="button" class="hyve-quotes__tab is-active" data-filter="all">All</button>
          <button type="button" class="hyve-quotes__tab" data-filter="created">Quote Created</button>
          <button type="button" class="hyve-quotes__tab" data-filter="sent">Quote Sent</button>
          <button type="button" class="hyve-quotes__tab" data-filter="accepted">Quote Accepted</button>
          <button type="button" class="hyve-quotes__tab" data-filter="declined">Quote Declined</button>
          <button type="button" class="hyve-quotes__tab" data-filter="expired">Quote Expired</button>
        </div>
      </div>

      <!-- Quotes Rows List -->
      <div class="hyve-quotes__list" id="quotesList">
        ${quoteRowsHtml}
      </div>

      <!-- Empty Filter State (when searching) -->
      <div class="hyve-quotes__empty" id="quotesEmpty" style="display: none;">
        <div class="hyve-quotes__empty-icon">${icoSearchEmpty()}</div>
        <p class="hyve-quotes__empty-title">No quotes match your search</p>
        <p class="hyve-quotes__empty-subtitle">Try adjusting your keywords or clearing the status filter.</p>
      </div>

      <!-- Pagination Container -->
      <div class="hyve-quotes__pagination" id="quotesPagination">
        <div class="hyve-quotes__pagination-info" id="paginationInfo"></div>
        <div class="hyve-quotes__pagination-controls">
          <button type="button" class="hyve-page-btn" id="prevPageBtn" onclick="changeQuotePage(-1)">Previous</button>
          <div class="hyve-page-numbers" id="pageNumbers"></div>
          <button type="button" class="hyve-page-btn" id="nextPageBtn" onclick="changeQuotePage(1)">Next</button>
        </div>
      </div>
      ` : `
      <!-- Real Data Initial Empty State -->
      <div class="hyve-quotes__initial-empty">
        <div class="hyve-quotes__initial-empty-icon">${icoDocumentEmpty()}</div>
        <h3 class="hyve-quotes__initial-empty-title">No quotes found</h3>
        <p class="hyve-quotes__initial-empty-desc">
          You don't have any price quotes or proposals yet. When your sales representative prepares custom pricing, or when you request a wholesale proposal, it will appear here.
        </p>
        <button type="button" class="hyve-quotes__cta-btn" onclick="openRequestQuoteModal()">
          ${icoPlus()}
          <span>Request Quote</span>
        </button>
      </div>
      `}
    </div>

    <!-- Request Quote Modal -->
    <div class="hyve-modal" id="requestQuoteModal" style="display: none;">
      <div class="hyve-modal__backdrop" onclick="closeRequestQuoteModal()"></div>
      <div class="hyve-modal__dialog">
        <div class="hyve-modal__header">
          <h2 class="hyve-modal__title">Request Wholesale Quote</h2>
          <button type="button" class="hyve-modal__close" onclick="closeRequestQuoteModal()">&times;</button>
        </div>
        <form method="post" class="hyve-modal__form">
          <input type="hidden" name="intent" value="request_quote" />

          <div class="hyve-form-group">
            <label class="hyve-form-label">Products or Items *</label>
            <input
              type="text"
              name="items"
              id="modalItemsInput"
              class="hyve-form-input"
              placeholder="e.g. BruMate Tumbler 20oz, Eco Backpack"
              required
            />
          </div>

          <div class="hyve-form-row">
            <div class="hyve-form-group">
              <label class="hyve-form-label">Estimated Quantity *</label>
              <input
                type="number"
                name="quantity"
                class="hyve-form-input"
                placeholder="e.g. 200"
                min="1"
                required
              />
            </div>
            <div class="hyve-form-group">
              <label class="hyve-form-label">Target Delivery Date</label>
              <input
                type="text"
                name="targetDate"
                placeholder="14 Oct 2026"
                pattern="[0-9]{1,2} [A-Za-z]{3} [0-9]{4}"
                title="Use day, short month and year, for example 14 Oct 2026"
                class="hyve-form-input"
              />
            </div>
          </div>

          <div class="hyve-form-group">
            <label class="hyve-form-label">Customization &amp; Notes</label>
            <textarea
              name="notes"
              class="hyve-form-textarea"
              rows="3"
              placeholder="Laser engraving details, logo placement, specific Pantone colors..."
            ></textarea>
          </div>

          <div class="hyve-modal__footer">
            <button type="button" class="hyve-modal__btn hyve-modal__btn--secondary" onclick="closeRequestQuoteModal()">
              Cancel
            </button>
            <button type="submit" class="hyve-modal__btn hyve-modal__btn--primary">
              Submit Request
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Quote Details Modal -->
    <div class="hyve-modal" id="quoteDetailsModal" style="display: none;">
      <div class="hyve-modal__backdrop" onclick="closeQuoteDetailsModal()"></div>
      <div class="hyve-modal__dialog hyve-modal__dialog--wide" role="dialog" aria-modal="true" aria-labelledby="quoteModalTitle">
        <div class="hyve-modal__header">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <h2 class="hyve-modal__title" id="quoteModalTitle">Quote Details</h2>
            <div id="quoteModalBadge"></div>
          </div>
          <button type="button" class="hyve-modal__close" onclick="closeQuoteDetailsModal()" aria-label="Close modal">&times;</button>
        </div>

        <div class="hyve-modal__body" id="quoteModalBody" style="padding: 20px 24px; max-height: calc(85vh - 140px); overflow-y: auto;">
          <!-- Loaded dynamically -->
        </div>

        <div class="hyve-modal__footer" id="quoteModalFooter" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; padding: 14px 24px; border-top: 1px solid #e2e8f0; background: #fafafa;">
          <div id="quoteModalFooterLeft" style="display: flex; gap: 8px;"></div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="hyve-modal__btn hyve-modal__btn--secondary" onclick="closeQuoteDetailsModal()">Close</button>
            <div id="quoteModalFooterRight" style="display: inline-flex; gap: 8px;"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  ${renderClientScript(hasQuotes, quotes)}
  `;
}

function renderQuoteRow(q) {
  const label = QUOTE_STATUS_LABELS[q.status] || q.status;
  const pdfButton = `
      <a class="hyve-btn hyve-btn--pdf" href="${esc(q.pdfHref)}">
        ${icoDownload()}
        <span>PDF</span>
      </a>`;
  const requoteButton = `
      <button type="button" class="hyve-btn hyve-btn--secondary" onclick="requoteItem('${esc(q.name)}', '${esc(q.items)}')">
        ${icoRefresh()}
        <span>Requote</span>
      </button>`;
  const resumeButton = q.invoiceUrl
    ? `
      <a href="${esc(q.invoiceUrl)}" class="hyve-btn hyve-btn--resume">
        ${icoCart()}
        <span>Confirm Order</span>
      </a>`
    : "";

  const badge = (tone, icon) => `
      <span class="hyve-badge hyve-badge--${tone}">
        ${icon}
        <span>${esc(label)}</span>
      </span>`;

  let badgeHtml = "";
  let actionButtonsHtml = "";

  if (q.status === QUOTE_STATUSES.ACCEPTED) {
    badgeHtml = badge("approved", icoCheck());
    // Accepted and already an order: the order is the thing to look at. Accepted
    // without one yet still needs its checkout link.
    actionButtonsHtml =
      (q.orderName
        ? `
      <a href="${esc(q.orderHref)}" class="hyve-btn hyve-btn--secondary">${icoEye()}<span>View Order ${esc(q.orderName)}</span></a>`
        : resumeButton) + pdfButton;
  } else if (q.status === QUOTE_STATUSES.EXPIRED) {
    // The quote itself is gone, so there is nothing to pay or download — only
    // a fresh quote to ask for.
    badgeHtml = badge("rejected", icoClock());
    actionButtonsHtml = requoteButton;
  } else if (q.status === QUOTE_STATUSES.DECLINED) {
    badgeHtml = badge("rejected", icoClock());
    actionButtonsHtml = requoteButton + pdfButton;
  } else if (q.status === QUOTE_STATUSES.CREATED) {
    // Not sent yet: readable, but sales is still preparing it.
    badgeHtml = badge("awaiting", icoClock());
    actionButtonsHtml = pdfButton;
  } else {
    // Sent: with the buyer, so they can pay it or read it.
    badgeHtml = badge("awaiting", icoMail());
    actionButtonsHtml = resumeButton + pdfButton;
  }

  const detailsButton = `
      <button type="button" class="hyve-btn hyve-btn--details" onclick="openQuoteDetailsModal('${esc(q.id)}')">
        ${icoEye()}
        <span>Details</span>
      </button>`;

  const priceClass =
    q.status === QUOTE_STATUSES.EXPIRED
      ? "hyve-quote-item__price hyve-quote-item__price--expired"
      : "hyve-quote-item__price";

  return `
    <div
      class="hyve-quote-item"
      data-status="${esc(q.status)}"
      data-search="${esc(`${q.name} ${q.items} ${q.meta} ${q.price}`).toLowerCase()}"
    >
      <div class="hyve-quote-item__left">
        <div class="hyve-quote-item__header">
          <button type="button" class="hyve-quote-item__name-btn" onclick="openQuoteDetailsModal('${esc(q.id)}')" title="View quote details">
            ${esc(q.name)}
          </button>
          ${badgeHtml}
        </div>
        <button type="button" class="hyve-quote-item__summary-btn" onclick="openQuoteDetailsModal('${esc(q.id)}')" title="Click to view quote details">
          <span class="hyve-quote-item__summary-text">${esc(q.items)}</span>
          <span class="hyve-quote-item__view-hint">View details</span>
        </button>
        <div class="hyve-quote-item__meta">${esc(q.meta)}</div>
      </div>

      <div class="hyve-quote-item__right">
        <div class="${priceClass}">${esc(q.price)}</div>
        <div class="hyve-quote-item__actions">
          ${detailsButton}
          ${actionButtonsHtml}
        </div>
      </div>
    </div>`;
}

/* -------------------------------------------------------------------------- */
/* Client Script                                                              */
/* -------------------------------------------------------------------------- */

function renderClientScript(hasQuotes, quotes = []) {
  const safeQuotesJson = JSON.stringify(quotes || []).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

  return `
  <script>
    (function() {
      var quotesData = ${safeQuotesJson};
      var quotesMap = {};
      quotesData.forEach(function(q) {
        if (q && q.id) {
          quotesMap[q.id] = q;
        }
      });

      var currentFilter = 'all';
      var searchInput = document.getElementById('quoteSearchInput');
      var tabs = document.querySelectorAll('.hyve-quotes__tab');
      var rows = Array.from(document.querySelectorAll('.hyve-quote-item'));
      var emptyEl = document.getElementById('quotesEmpty');
      var paginationEl = document.getElementById('quotesPagination');
      var paginationInfo = document.getElementById('paginationInfo');
      var prevBtn = document.getElementById('prevPageBtn');
      var nextBtn = document.getElementById('nextPageBtn');
      var pageNumbersContainer = document.getElementById('pageNumbers');

      var PAGE_SIZE = 8;
      var currentPage = 1;
      var currentMatchingRows = [];

      function filterAndPaginate() {
        if (!rows.length) return;

        var query = (searchInput ? searchInput.value : '').toLowerCase().trim();
        currentMatchingRows = [];

        rows.forEach(function(row) {
          var rowStatus = row.getAttribute('data-status');
          var rowSearch = row.getAttribute('data-search') || '';

          var matchesTab = (currentFilter === 'all' || rowStatus === currentFilter);
          var matchesSearch = (!query || rowSearch.indexOf(query) !== -1);

          if (matchesTab && matchesSearch) {
            currentMatchingRows.push(row);
          } else {
            row.style.display = 'none';
          }
        });

        var totalItems = currentMatchingRows.length;
        var totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;

        if (currentPage > totalPages) {
          currentPage = 1;
        }

        var startIdx = (currentPage - 1) * PAGE_SIZE;
        var endIdx = startIdx + PAGE_SIZE;

        currentMatchingRows.forEach(function(row, idx) {
          if (idx >= startIdx && idx < endIdx) {
            row.style.display = 'flex';
          } else {
            row.style.display = 'none';
          }
        });

        if (emptyEl) {
          emptyEl.style.display = totalItems === 0 ? 'block' : 'none';
        }

        if (paginationEl) {
          if (totalItems <= PAGE_SIZE) {
            paginationEl.style.display = 'none';
          } else {
            paginationEl.style.display = 'flex';
            if (paginationInfo) {
              paginationInfo.textContent = 'Showing ' + (startIdx + 1) + '–' + Math.min(endIdx, totalItems) + ' of ' + totalItems + ' quotes';
            }

            if (prevBtn) prevBtn.disabled = (currentPage === 1);
            if (nextBtn) nextBtn.disabled = (currentPage === totalPages);

            if (pageNumbersContainer) {
              pageNumbersContainer.innerHTML = '';
              for (var p = 1; p <= totalPages; p++) {
                (function(pageNumber) {
                  var pBtn = document.createElement('button');
                  pBtn.type = 'button';
                  pBtn.className = 'hyve-page-num' + (pageNumber === currentPage ? ' is-active' : '');
                  pBtn.textContent = pageNumber;
                  pBtn.onclick = function() {
                    currentPage = pageNumber;
                    filterAndPaginate();
                  };
                  pageNumbersContainer.appendChild(pBtn);
                })(p);
              }
            }
          }
        }
      }

      window.changeQuotePage = function(delta) {
        var totalPages = Math.ceil(currentMatchingRows.length / PAGE_SIZE) || 1;
        var targetPage = currentPage + delta;
        if (targetPage >= 1 && targetPage <= totalPages) {
          currentPage = targetPage;
          filterAndPaginate();
        }
      };

      if (searchInput) {
        searchInput.addEventListener('input', function() {
          currentPage = 1;
          filterAndPaginate();
        });
      }

      tabs.forEach(function(tab) {
        tab.addEventListener('click', function() {
          tabs.forEach(function(t) { t.classList.remove('is-active'); });
          tab.classList.add('is-active');
          currentFilter = tab.getAttribute('data-filter') || 'all';
          currentPage = 1;
          filterAndPaginate();
        });
      });

      filterAndPaginate();

      window.openRequestQuoteModal = function() {
        var modal = document.getElementById('requestQuoteModal');
        if (modal) modal.style.display = 'flex';
      };

      window.closeRequestQuoteModal = function() {
        var modal = document.getElementById('requestQuoteModal');
        if (modal) modal.style.display = 'none';
      };

      window.requoteItem = function(quoteName, items) {
        var modal = document.getElementById('requestQuoteModal');
        var input = document.getElementById('modalItemsInput');
        if (input) input.value = items || '';
        if (modal) modal.style.display = 'flex';
      };

      function escapeHtml(str) {
        if (!str) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      window.openQuoteDetailsModal = function(quoteId) {
        var q = quotesMap[quoteId];
        if (!q) {
          for (var id in quotesMap) {
            if (id === quoteId || id.indexOf(quoteId) !== -1 || (quotesMap[id].name && quotesMap[id].name === quoteId)) {
              q = quotesMap[id];
              break;
            }
          }
        }
        if (!q) return;

        var modal = document.getElementById('quoteDetailsModal');
        var titleEl = document.getElementById('quoteModalTitle');
        var badgeEl = document.getElementById('quoteModalBadge');
        var bodyEl = document.getElementById('quoteModalBody');
        var footerLeft = document.getElementById('quoteModalFooterLeft');
        var footerRight = document.getElementById('quoteModalFooterRight');

        if (titleEl) titleEl.textContent = q.name || 'Quote Details';

        var badgeTone = 'awaiting';
        var badgeLabel = q.status || 'Quote';
        if (q.status === 'accepted') {
          badgeTone = 'approved';
          badgeLabel = 'Quote Accepted';
        } else if (q.status === 'declined' || q.status === 'expired') {
          badgeTone = 'rejected';
          badgeLabel = q.status === 'declined' ? 'Quote Declined' : 'Quote Expired';
        } else if (q.status === 'created') {
          badgeLabel = 'Quote Created';
        } else if (q.status === 'sent') {
          badgeLabel = 'Quote Sent';
        }

        if (badgeEl) {
          badgeEl.innerHTML = '<span class="hyve-badge hyve-badge--' + badgeTone + '">' + escapeHtml(badgeLabel) + '</span>';
        }

        var lines = Array.isArray(q.lineItems) ? q.lineItems : [];
        var linesHtml = '';

        if (lines.length === 0) {
          linesHtml = '<div style="padding:24px 0; text-align:center; color:#64748b; font-size:13px;">' + escapeHtml(q.items || 'No line item details available.') + '</div>';
        } else {
          linesHtml = '<div class="hyve-modal-table-wrap">' +
            '<table class="hyve-modal-table">' +
            '<thead>' +
            '<tr>' +
            '<th style="text-align:left; min-width:240px;">Product / Item</th>' +
            '<th style="text-align:center; width:60px;">Qty</th>' +
            '<th style="text-align:right; width:100px;">Unit Price</th>' +
            '<th style="text-align:right; width:110px;">Total</th>' +
            '</tr>' +
            '</thead>' +
            '<tbody>';

          lines.forEach(function(line) {
            var imgHtml = '';
            if (line.imageUrl) {
              imgHtml = '<img src="' + escapeHtml(line.imageUrl) + '" alt="' + escapeHtml(line.imageAlt || line.title) + '" class="hyve-modal-product-img" loading="lazy" />';
            } else {
              imgHtml = '<div class="hyve-modal-product-img hyve-modal-product-img--placeholder">' +
                '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>' +
                '<polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>' +
                '<line x1="12" y1="22.08" x2="12" y2="12"></line>' +
                '</svg>' +
                '</div>';
            }

            var badgesHtml = '';
            if (line.sku) {
              badgesHtml += '<span class="hyve-item-badge">SKU: ' + escapeHtml(line.sku) + '</span>';
            }
            if (line.hsCode) {
              badgesHtml += '<span class="hyve-item-badge">HS: ' + escapeHtml(line.hsCode) + '</span>';
            }
            if (line.countryOfOrigin) {
              badgesHtml += '<span class="hyve-item-badge">Origin: ' + escapeHtml(line.countryOfOrigin) + '</span>';
            }

            var attrsHtml = '';
            if (Array.isArray(line.attributes) && line.attributes.length > 0) {
              attrsHtml = '<div class="hyve-item-attrs">';
              line.attributes.forEach(function(attr) {
                attrsHtml += '<span class="hyve-item-attr"><strong>' + escapeHtml(attr.key) + ':</strong> ' + escapeHtml(attr.value) + '</span>';
              });
              attrsHtml += '</div>';
            }

            var sampleTag = line.isSample
              ? '<span class="hyve-badge hyve-badge--awaiting" style="font-size:10.5px; padding:1px 6px;">Physical Sample</span>' +
                (q.isOpen ? ' <button type="button" class="hyve-btn--remove-sample-link" onclick="removePhysicalSample(\\'' + escapeHtml(q.id) + '\\')">Remove</button>' : '')
              : '';

            linesHtml += '<tr>' +
              '<td>' +
                '<div style="display:flex; gap:12px; align-items:flex-start;">' +
                  imgHtml +
                  '<div style="min-width:0; flex:1;">' +
                    '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">' +
                      '<span style="font-weight:650; font-size:13px; color:#0f172a;">' + escapeHtml(line.title) + '</span>' +
                      sampleTag +
                    '</div>' +
                    (line.variantTitle ? '<div style="font-size:11.5px; color:#64748b; margin-top:2px;">' + escapeHtml(line.variantTitle) + '</div>' : '') +
                    (badgesHtml ? '<div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:5px;">' + badgesHtml + '</div>' : '') +
                    attrsHtml +
                  '</div>' +
                '</div>' +
              '</td>' +
              '<td style="text-align:center; vertical-align:top; padding-top:14px;">' +
                '<span class="hyve-item-qty">' + escapeHtml(line.quantity) + '</span>' +
              '</td>' +
              '<td style="text-align:right; vertical-align:top; padding-top:14px;">' +
                '<div style="font-size:12.5px; font-weight:550; color:#0f172a;">' + escapeHtml(line.unitPrice) + '</div>' +
                (line.originalUnitPrice ? '<div style="font-size:11px; color:#94a3b8; text-decoration:line-through;">' + escapeHtml(line.originalUnitPrice) + '</div>' : '') +
              '</td>' +
              '<td style="text-align:right; vertical-align:top; padding-top:14px; font-weight:700; font-size:13px; color:#0f172a;">' +
                escapeHtml(line.totalPrice) +
              '</td>' +
              '</tr>';
          });

          linesHtml += '</tbody></table></div>';
        }

        var sampleSectionHtml = '';
        if (q.isOpen && !q.hasPhysicalSample) {
          sampleSectionHtml = '<div class="hyve-quote-sample-banner">' +
            '<div class="hyve-quote-sample-banner__left">' +
              '<div class="hyve-quote-sample-banner__icon">' +
                '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0f766e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>' +
                  '<polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>' +
                  '<line x1="12" y1="22.08" x2="12" y2="12"></line>' +
                '</svg>' +
              '</div>' +
              '<div>' +
                '<div class="hyve-quote-sample-banner__title">Physical Sample Before Production</div>' +
                '<div class="hyve-quote-sample-banner__desc">Inspect a physical sample (1 unit) to verify color, finish, and branding before full manufacturing.</div>' +
              '</div>' +
            '</div>' +
            '<button type="button" class="hyve-btn hyve-btn--resume" id="btnSample-' + escapeHtml(q.id) + '" onclick="addPhysicalSample(\\'' + escapeHtml(q.id) + '\\')">' +
              '+ Add Physical Sample' +
            '</button>' +
          '</div>';
        } else if (q.hasPhysicalSample) {
          if (q.isOpen) {
            sampleSectionHtml = '<div class="hyve-quote-sample-banner hyve-quote-sample-banner--included">' +
              '<div class="hyve-quote-sample-banner__left">' +
                '<div class="hyve-quote-sample-banner__icon" style="background:#dcfce7; color:#16a34a;">' +
                  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
                '</div>' +
                '<div>' +
                  '<div class="hyve-quote-sample-banner__title" style="color:#166534;">Physical Sample Included</div>' +
                  '<div class="hyve-quote-sample-banner__desc">A 1-unit physical pre-production sample is currently included in this quote.</div>' +
                '</div>' +
              '</div>' +
              '<button type="button" class="hyve-btn hyve-btn--remove-sample" id="btnRemoveSample-' + escapeHtml(q.id) + '" onclick="removePhysicalSample(\\'' + escapeHtml(q.id) + '\\')">' +
                'Remove Physical Sample' +
              '</button>' +
            '</div>';
          } else {
            sampleSectionHtml = '<div class="hyve-quote-sample-included">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
              '<span>Physical sample before production is included in this quote</span>' +
            '</div>';
          }
        }

        var orderLinkHtml = '';
        if (q.orderName) {
          orderLinkHtml = '<div class="hyve-modal-meta-row" style="font-size:12.5px; margin-top:4px;"><strong>Converted Order:</strong> <a href="' + escapeHtml(q.orderHref) + '" style="color:#0f766e; text-decoration:underline; font-weight:600;">' + escapeHtml(q.orderName) + '</a></div>';
        }

        var totalsHtml = '<div class="hyve-modal-totals">' +
          (q.subtotal ? '<div class="hyve-modal-total-line"><span>Subtotal</span><span>' + escapeHtml(q.subtotal) + '</span></div>' : '') +
          (q.shipping ? '<div class="hyve-modal-total-line"><span>Shipping</span><span>' + escapeHtml(q.shipping) + '</span></div>' : '') +
          '<div class="hyve-modal-total-line hyve-modal-total-line--grand"><span>Total</span><span>' + escapeHtml(q.price) + '</span></div>' +
          '</div>';

        if (bodyEl) {
          bodyEl.innerHTML = '<div class="hyve-modal-meta-box">' +
            '<div>' +
              '<div style="font-size:12.5px; color:#64748b;">' + escapeHtml(q.meta || '') + '</div>' +
              (q.validUntilLabel ? '<div style="font-size:12px; color:#0f766e; font-weight:500; margin-top:2px;">Valid until ' + escapeHtml(q.validUntilLabel) + '</div>' : '') +
            '</div>' +
            (orderLinkHtml || '') +
            '</div>' +
            '<div style="margin-top:16px;">' +
              '<div style="font-size:13.5px; font-weight:700; color:#0f172a; margin-bottom:8px;">Line Items (' + lines.length + ')</div>' +
              linesHtml +
            '</div>' +
            totalsHtml +
            sampleSectionHtml;
        }

        if (footerLeft) {
          footerLeft.innerHTML = q.pdfHref
            ? '<a href="' + escapeHtml(q.pdfHref) + '" class="hyve-btn hyve-btn--pdf">' +
                '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
                '<span>Download PDF</span>' +
              '</a>'
            : '';
        }

        if (footerRight) {
          var rightActions = '';
          if (q.invoiceUrl && q.isOpen) {
            rightActions += '<a href="' + escapeHtml(q.invoiceUrl) + '" class="hyve-btn hyve-btn--resume">' +
              '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>' +
              '<span>Confirm Order</span>' +
            '</a>';
          } else if (q.orderName) {
            rightActions += '<a href="' + escapeHtml(q.orderHref) + '" class="hyve-btn hyve-btn--secondary">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>' +
              '<span>View Order</span>' +
            '</a>';
          }
          footerRight.innerHTML = rightActions;
        }

        if (modal) modal.style.display = 'flex';
      };

      window.closeQuoteDetailsModal = function() {
        var modal = document.getElementById('quoteDetailsModal');
        if (modal) modal.style.display = 'none';
      };

      window.addPhysicalSample = function(quoteId) {
        var btn = document.getElementById('btnSample-' + quoteId);
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = 'Adding sample...';
        }

        var form = new FormData();
        form.append('intent', 'add_physical_sample');
        form.append('quoteId', quoteId);

        fetch('/apps/account/quotes', {
          method: 'POST',
          body: form,
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          }
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().then(function(data) { throw new Error(data.error || 'Failed to add sample.'); });
          }
          return res.json();
        })
        .then(function(data) {
          if (data.ok) {
            window.location.href = '/apps/account/quotes?notice=' + encodeURIComponent(data.message || 'Physical sample added to quote.');
          } else {
            alert(data.error || 'Failed to add physical sample.');
            if (btn) {
              btn.disabled = false;
              btn.innerHTML = '+ Add Physical Sample';
            }
          }
        })
        .catch(function() {
          var fallbackForm = document.createElement('form');
          fallbackForm.method = 'POST';
          fallbackForm.action = '/apps/account/quotes';
          var inputIntent = document.createElement('input');
          inputIntent.type = 'hidden';
          inputIntent.name = 'intent';
          inputIntent.value = 'add_physical_sample';
          fallbackForm.appendChild(inputIntent);
          var inputQuote = document.createElement('input');
          inputQuote.type = 'hidden';
          inputQuote.name = 'quoteId';
          inputQuote.value = quoteId;
          fallbackForm.appendChild(inputQuote);
          document.body.appendChild(fallbackForm);
          fallbackForm.submit();
        });
      };

      window.removePhysicalSample = function(quoteId) {
        var btn = document.getElementById('btnRemoveSample-' + quoteId);
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = 'Removing sample...';
        }

        var form = new FormData();
        form.append('intent', 'remove_physical_sample');
        form.append('quoteId', quoteId);

        fetch('/apps/account/quotes', {
          method: 'POST',
          body: form,
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          }
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().then(function(data) { throw new Error(data.error || 'Failed to remove sample.'); });
          }
          return res.json();
        })
        .then(function(data) {
          if (data.ok) {
            window.location.href = '/apps/account/quotes?notice=' + encodeURIComponent(data.message || 'Physical sample removed from quote.');
          } else {
            alert(data.error || 'Failed to remove physical sample.');
            if (btn) {
              btn.disabled = false;
              btn.innerHTML = 'Remove Physical Sample';
            }
          }
        })
        .catch(function() {
          var fallbackForm = document.createElement('form');
          fallbackForm.method = 'POST';
          fallbackForm.action = '/apps/account/quotes';
          var inputIntent = document.createElement('input');
          inputIntent.type = 'hidden';
          inputIntent.name = 'intent';
          inputIntent.value = 'remove_physical_sample';
          fallbackForm.appendChild(inputIntent);
          var inputQuote = document.createElement('input');
          inputQuote.type = 'hidden';
          inputQuote.name = 'quoteId';
          inputQuote.value = quoteId;
          fallbackForm.appendChild(inputQuote);
          document.body.appendChild(fallbackForm);
          fallbackForm.submit();
        });
      };

      try {
        var urlParams = new URLSearchParams(window.location.search);
        var viewQuote = urlParams.get('viewQuote');
        if (viewQuote) {
          openQuoteDetailsModal(viewQuote);
        }
      } catch (e) {}
    })();
  </script>`;
}

/* -------------------------------------------------------------------------- */
/* SVG Icons                                                                  */
/* -------------------------------------------------------------------------- */

function icoPlus() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
}

function icoSearch() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
}

function icoMail() {
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`;
}

function icoCheck() {
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
}

function icoClock() {
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
}

function icoCart() {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>`;
}

function icoEye() {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function icoRefresh() {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M8 16H3v5"/></svg>`;
}

function icoDownload() {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
}

function icoDocumentEmpty() {
  return `<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
}

function icoSearchEmpty() {
  return `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
}



/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const QUOTES_STYLES = `
<style>
  .hyve-quotes {
    margin: 0 auto;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  /* Alerts */
  .hyve-quotes__alert {
    padding: 12px 18px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 20px;
  }
  .hyve-quotes__alert--success {
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
    color: #065f46;
  }
  .hyve-quotes__alert--error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
  }

  /* Header */
  .hyve-quotes__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .hyve-quotes__title {
    font-size: 22px;
    font-weight: 800;
    color: #0f172a;
    margin: 0 0 4px 0;
    line-height: 1.2;
  }
  .hyve-quotes__subtitle {
    font-size: 13px;
    color: #64748b;
    margin: 0;
  }
  .hyve-quotes__cta-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--hyve-gradient);
    color: #0A1414;
    border: none;
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    transition: background 0.15s ease, transform 0.1s ease;
  }
  .hyve-quotes__cta-btn:hover {
    filter: brightness(0.96);
  }

  /* Main Card */
  .hyve-quotes__card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 16px;
    box-shadow: none;
  }

  /* Toolbar */
  .hyve-quotes__toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 4px;
    flex-wrap: wrap;
  }
  .hyve-quotes__search-box {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid #e2e8f0;
    border-radius: 999px;
    padding: 0 14px;
    height: 36px;
    background: rgba(15,23,42,0.03);
    flex: 0 1 240px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .hyve-quotes__search-box:focus-within {
    border-color: #38bdf8;
    box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
  }
  .hyve-quotes__search-box svg {
    color: #64748b;
    flex-shrink: 0;
  }
  .hyve-quotes__search-input {
    border: none;
    outline: none;
    background: transparent;
    font-size: 13px;
    color: #0f172a;
    width: 100%;
  }
  .hyve-quotes__search-input::placeholder {
    color: #94a3b8;
  }

  /* Tabs */
  .hyve-quotes__tabs {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hyve-quotes__tab {
    background: rgba(15,23,42,0.04);
    border: 0;
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 600;
    color: #64748B;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .hyve-quotes__tab:hover {
    background: #f1f5f9;
    color: #0f172a;
  }
  .hyve-quotes__tab.is-active {
    background: linear-gradient(135deg, rgba(163,234,110,0.15) 0%, rgba(110,222,225,0.15) 100%);
    color: #0F172A;
    font-weight: 700;
  }

  /* Quote Items List */
  .hyve-quotes__list {
    display: flex;
    flex-direction: column;
  }
  .hyve-quote-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    padding: 14px 4px;
    border-top: 1px solid rgba(15,23,42,0.06);
  }
  .hyve-quote-item:first-child {
    border-top: 0;
  }

  /* Left column */
  .hyve-quote-item__left {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .hyve-quote-item__header {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .hyve-quote-item__name {
    font-size: 14px;
    font-weight: 700;
    color: #0f172a;
  }
  .hyve-quote-item__summary {
    font-size: 12.5px;
    font-weight: 400;
    color: #334155;
    margin: 3px 0 0;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .hyve-quote-item__meta {
    font-size: 11.5px;
    color: #94a3b8;
  }

  /* Badges */
  .hyve-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    line-height: 1.5;
  }
  .hyve-badge--awaiting {
    background: #e0f2fe;
    color: #0284c7;
  }
  .hyve-badge--approved {
    background: #dcfce7;
    color: #16a34a;
  }
  .hyve-badge--rejected {
    background: #f1f5f9;
    color: #64748b;
  }

  /* Right column */
  .hyve-quote-item__right {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-shrink: 0;
  }
  .hyve-quote-item__price {
    font-size: 15px;
    font-weight: 800;
    color: #0f172a;
    text-align: right;
    min-width: 90px;
  }
  /* The requirements ask for an expired quote's original value struck through. */
  .hyve-quote-item__price--expired { text-decoration: line-through; color: #94a3b8; }
  .hyve-quote-item__actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Buttons */
  .hyve-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
    transition: all 0.15s ease;
    border: none;
  }
  .hyve-btn--resume {
    background: var(--hyve-gradient);
    color: #0A1414;
  }
  .hyve-btn--resume:hover {
    filter: brightness(0.96);
  }
  .hyve-btn--secondary,
  .hyve-btn--pdf {
    background: #ffffff;
    border: 1px solid #cbd5e1;
    color: #334155;
    font-weight: 500;
  }
  .hyve-btn--secondary:hover,
  .hyve-btn--pdf:hover {
    background: #f8fafc;
    border-color: #94a3b8;
    color: #0f172a;
  }

  /* Empty filter state */
  .hyve-quotes__empty {
    padding: 40px 20px;
    text-align: center;
  }
  .hyve-quotes__empty-icon {
    margin-bottom: 12px;
    opacity: 0.6;
  }
  .hyve-quotes__empty-title {
    font-size: 14.5px;
    font-weight: 700;
    color: #0f172a;
    margin: 0 0 6px 0;
  }
  .hyve-quotes__empty-subtitle {
    font-size: 12.5px;
    color: #94a3b8;
    margin: 0;
  }

  /* Initial Empty State (Real Data Empty) */
  .hyve-quotes__initial-empty {
    padding: 56px 20px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    max-width: 460px;
    margin: 0 auto;
  }
  .hyve-quotes__initial-empty-icon {
    margin-bottom: 16px;
    opacity: 0.6;
  }
  .hyve-quotes__initial-empty-title {
    font-size: 17px;
    font-weight: 800;
    color: #0f172a;
    margin: 0 0 8px 0;
  }
  .hyve-quotes__initial-empty-desc {
    font-size: 13px;
    color: #64748b;
    line-height: 1.55;
    margin: 0 0 22px 0;
  }

  /* Pagination */
  .hyve-quotes__pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 18px;
    margin-top: 10px;
    border-top: 1px solid #f1f5f9;
    gap: 16px;
    flex-wrap: wrap;
  }
  .hyve-quotes__pagination-info {
    font-size: 12px;
    color: #64748b;
    font-weight: 500;
  }
  .hyve-quotes__pagination-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .hyve-page-btn {
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    color: #334155;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .hyve-page-btn:hover:not(:disabled) {
    background: #f8fafc;
    border-color: #94a3b8;
    color: #0f172a;
  }
  .hyve-page-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .hyve-page-numbers {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .hyve-page-num {
    min-width: 32px;
    height: 32px;
    padding: 0 6px;
    border-radius: 6px;
    border: 1px solid #e2e8f0;
    background: #ffffff;
    color: #475569;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }
  .hyve-page-num:hover {
    background: #f8fafc;
    border-color: #cbd5e1;
  }
  .hyve-page-num.is-active {
    background: #dcfce7;
    border-color: #86efac;
    color: #166534;
  }

  /* Modal */
  .hyve-modal {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    box-sizing: border-box;
  }
  .hyve-modal__backdrop {
    display: block !important;
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(15, 23, 42, 0.6);
    backdrop-filter: blur(4px);
  }
  .hyve-modal__dialog {
    position: relative;
    background: #ffffff;
    border-radius: 16px;
    width: 100%;
    max-width: 520px;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
    z-index: 10;
    overflow: hidden;
  }
  .hyve-modal__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 24px;
    border-bottom: 1px solid #e2e8f0;
  }
  .hyve-modal__title {
    font-size: 17px;
    font-weight: 800;
    color: #0f172a;
    margin: 0;
  }
  .hyve-modal__close {
    background: none;
    border: none;
    font-size: 22px;
    color: #94a3b8;
    cursor: pointer;
    line-height: 1;
  }
  .hyve-modal__close:hover {
    color: #0f172a;
  }
  .hyve-modal__form {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .hyve-form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hyve-form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .hyve-form-label {
    font-size: 12.5px;
    font-weight: 600;
    color: #334155;
  }
  .hyve-form-input,
  .hyve-form-textarea {
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 9px 12px;
    font-size: 13px;
    color: #0f172a;
    outline: none;
    font-family: inherit;
    transition: border-color 0.15s ease;
  }
  .hyve-form-input:focus,
  .hyve-form-textarea:focus {
    border-color: #38bdf8;
    box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
  }
  .hyve-modal__footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 8px;
  }
  .hyve-modal__btn {
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    border: none;
  }
  .hyve-modal__btn--secondary {
    background: #f1f5f9;
    color: #475569;
  }
  .hyve-modal__btn--primary {
    background: #0f172a;
    color: #ffffff;
  }
  .hyve-modal__btn--primary:hover {
    background: #1e293b;
  }

  /* Responsive Breakpoints */
  @media (max-width: 768px) {
    .hyve-quotes__card {
      padding: 18px 16px;
    }
    .hyve-quote-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 14px;
    }
    .hyve-quote-item__right {
      width: 100%;
      justify-content: space-between;
    }
    .hyve-quote-item__price {
      text-align: left;
    }
    .hyve-quotes__toolbar {
      flex-direction: column;
      align-items: stretch;
    }
    .hyve-quotes__search-box {
      width: 100%;
      box-sizing: border-box;
    }
    .hyve-quotes__tabs {
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .hyve-form-row {
      grid-template-columns: 1fr;
    }
  }

  /* Quote Item Name & Summary Clickable */
  .hyve-quote-item__name-btn {
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
    font-size: 14.5px;
    font-weight: 700;
    color: #0f172a;
    cursor: pointer;
    text-align: left;
    transition: color 0.15s ease;
  }
  .hyve-quote-item__name-btn:hover {
    color: #0f766e;
    text-decoration: underline;
  }
  .hyve-quote-item__summary-btn {
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
    font-size: 12.5px;
    color: #334155;
    cursor: pointer;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 3px 0 0;
  }
  .hyve-quote-item__summary-btn:hover .hyve-quote-item__summary-text {
    color: #0f172a;
  }
  .hyve-quote-item__view-hint {
    font-size: 11px;
    font-weight: 600;
    color: #0f766e;
    background: rgba(15, 118, 110, 0.08);
    padding: 1px 7px;
    border-radius: 999px;
    transition: background 0.15s ease;
  }
  .hyve-quote-item__summary-btn:hover .hyve-quote-item__view-hint {
    background: rgba(15, 118, 110, 0.16);
  }

  /* Modal Dialog Wide */
  .hyve-modal__dialog--wide {
    max-width: 680px;
  }

  /* Modal Meta Box */
  .hyve-modal-meta-box {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
    padding-bottom: 14px;
    border-bottom: 1px solid #f1f5f9;
  }

  /* Modal Line Items Table */
  .hyve-modal-table-wrap {
    overflow-x: auto;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    background: #ffffff;
  }
  .hyve-modal-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .hyve-modal-table th {
    padding: 10px 14px;
    font-size: 11.5px;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: #f8fafc;
    border-bottom: 1px solid #e2e8f0;
  }
  .hyve-modal-table td {
    padding: 12px 14px;
    border-bottom: 1px solid #f1f5f9;
  }
  .hyve-modal-table tbody tr:last-child td {
    border-bottom: none;
  }
  .hyve-modal-product-img {
    width: 48px;
    height: 48px;
    border-radius: 7px;
    border: 1px solid #e2e8f0;
    object-fit: contain;
    background: #f8fafc;
    flex-shrink: 0;
  }
  .hyve-modal-product-img--placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hyve-item-badge {
    font-size: 11px;
    font-weight: 550;
    color: #475569;
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid #e2e8f0;
  }
  .hyve-item-attrs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin-top: 5px;
  }
  .hyve-item-attr {
    font-size: 11.5px;
    color: #64748b;
  }
  .hyve-item-qty {
    display: inline-block;
    padding: 2px 7px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    color: #1e293b;
  }

  /* Totals */
  .hyve-modal-totals {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 14px;
    padding: 12px 16px;
    background: #f8fafc;
    border-radius: 9px;
    border: 1px solid #e2e8f0;
  }
  .hyve-modal-total-line {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: #475569;
  }
  .hyve-modal-total-line--grand {
    font-size: 15px;
    font-weight: 750;
    color: #0f172a;
    padding-top: 8px;
    margin-top: 4px;
    border-top: 1px solid #e2e8f0;
  }

  /* Sample Banner */
  .hyve-quote-sample-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
    margin-top: 16px;
    background: linear-gradient(135deg, rgba(163,234,110,0.12) 0%, rgba(110,222,225,0.12) 100%);
    border: 1px solid rgba(110,222,225,0.4);
    border-radius: 10px;
    flex-wrap: wrap;
  }
  .hyve-quote-sample-banner__left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    flex: 1;
  }
  .hyve-quote-sample-banner__icon {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .hyve-quote-sample-banner__title {
    font-size: 13.5px;
    font-weight: 700;
    color: #0f172a;
  }
  .hyve-quote-sample-banner__desc {
    font-size: 12px;
    color: #475569;
    margin-top: 2px;
  }
  .hyve-quote-sample-included {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    padding: 10px 14px;
    border-radius: 8px;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    color: #166534;
    font-size: 12.5px;
    font-weight: 600;
  }
  .hyve-quote-sample-banner--included {
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
  }
  .hyve-btn--remove-sample {
    padding: 8px 16px;
    background: #ffffff;
    color: #dc2626;
    border: 1px solid #fca5a5;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 650;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }
  .hyve-btn--remove-sample:hover {
    background: #fef2f2;
    border-color: #ef4444;
    color: #b91c1c;
  }
  .hyve-btn--remove-sample:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .hyve-btn--remove-sample-link {
    background: none;
    border: none;
    padding: 0;
    margin-left: 6px;
    color: #dc2626;
    font-size: 11px;
    font-weight: 600;
    text-decoration: underline;
    cursor: pointer;
  }
  .hyve-btn--remove-sample-link:hover {
    color: #b91c1c;
  }
</style>`;


const STAFF_QUOTES_QUERY = `#graphql
  query StaffQuotes($after: String) {
    draftOrders(first: 100, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        updatedAt
        status
        invoiceSentAt
        invoiceUrl
        tags
        order { id name }
        totalPriceSet { presentmentMoney { amount currencyCode } }
        customer { id displayName defaultEmailAddress { emailAddress } }
        purchasingEntity { ... on PurchasingCompany { company { name } } }
        lineItems(first: 20) { nodes { id title name quantity } }
        hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
        ${DRAFT_ORIGIN_FIELDS}
      }
    }
  }`;

/**
 * Pages of drafts read for the staff lists. The store passed 100 drafts on
 * Oct 9, and reading only the latest 100 left older quotes out of the counts.
 */
const STAFF_QUOTE_PAGES = 10;

async function allStaffDrafts(admin) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < STAFF_QUOTE_PAGES; page += 1) {
    const body = await (await admin.graphql(STAFF_QUOTES_QUERY, { variables: { after } })).json();
    if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
    const block = body?.data?.draftOrders;
    nodes.push(...(block?.nodes || []));
    if (!block?.pageInfo?.hasNextPage) return nodes;
    after = block.pageInfo.endCursor;
  }
  console.warn(`[quotes] more than ${STAFF_QUOTE_PAGES * 100} drafts; the oldest aren't counted`);
  return nodes;
}

/** "#D85" -> 85, for listing quotes newest first by number. */
const quoteNumber = (name) => Number(String(name || "").replace(/\D/g, "")) || 0;

/**
 * An expired quote from the archive, shaped like a live one. Its draft was
 * deleted when it expired, so it has no page of its own to open.
 */
function expiredStaffQuote(quote) {
  return {
    id: quote.id,
    name: quote.quoteNumber,
    numericId: "",
    reference: quote.reference,
    status: QUOTE_STATUSES.EXPIRED,
    draftStatus: "",
    createdAt: quote.expiredAt,
    companyName: "",
    customer: quote.customerName ? { displayName: quote.customerName } : null,
    customerEmail: quote.email,
    totalPriceSet: quote.currencyCode
      ? { presentmentMoney: { amount: quote.amount, currencyCode: quote.currencyCode } }
      : null,
    lineItems: { nodes: quote.lines.map((line) => ({ title: line.title, quantity: line.quantity })) },
  };
}

/**
 * Every quote as Hyve Custom lists it, for the dashboard and the Quotes page
 * alike (HYV-165). They used to read different sets: the dashboard every draft,
 * the Quotes page only cart quotes (so staff quotes were missing) with a status
 * that never turned Accepted. Now both count the same drafts with the same
 * rules the buyer's portal uses. Orders waiting on a credit review are drafts
 * too, but they're orders, not quotes (HYV-99), so they're left out.
 *
 * Expired quotes come from the same archive the portal reads, since their
 * drafts are deleted when they expire. Newest quote number first.
 */
export async function loadStaffQuotes(admin) {
  const [drafts, expired] = await Promise.all([
    allStaffDrafts(admin),
    listAllExpiredQuotes(admin).catch((error) => {
      console.warn("[quotes] expired quotes failed:", error?.message || error);
      return [];
    }),
  ]);
  const live = drafts
    .filter((node) => !submittedForReview(node))
    .map((node) => ({
      ...node,
      numericId: String(node.id).replace("gid://shopify/DraftOrder/", ""),
      reference: quoteReference(node.name),
      status: quoteStatus(node),
      draftStatus: node.status,
      companyName: node.purchasingEntity?.company?.name || "",
      customerEmail: node.customer?.defaultEmailAddress?.emailAddress || "",
    }));
  // A live draft wins over an archive copy of the same number.
  const liveNumbers = new Set(live.map((quote) => quoteNumber(quote.name)));
  return [
    ...live,
    ...expired.filter((quote) => !liveNumbers.has(quoteNumber(quote.quoteNumber))).map(expiredStaffQuote),
  ].sort((a, b) => quoteNumber(b.name) - quoteNumber(a.name));
}
