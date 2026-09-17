/**
 * Quotes page for the B2B portal.
 * Quotes correspond to Shopify Draft Orders (`draftOrders`).
 *
 * Renders the Quotes management screen matching the user mockup:
 *   - Page header: "Quotes" + subtitle + "+ Request Quote" CTA button
 *   - Main card with live client-side search input & filter tabs (All, Awaiting Action, Approved, Rejected)
 *   - Quote cards with Quote #, status badge, items summary, validity / converted metadata, price, and actions
 *   - Actions: "Resume & Order" (Shopify invoice checkout), "View Order", "Requote", and "PDF"
 *   - Interactive "+ Request Quote" modal to submit custom wholesale quote requests
 */

import { esc } from "./account-shell.server";

/**
 * Quote statuses.
 *
 * Staff decide a quote by setting the `hyve_status` boolean metafield on its
 * draft order: true is approved, false is rejected, and an unset metafield
 * means it is still with the buyer. Nothing here is inferred from tags or
 * dates — the metafield is the only source.
 */
export const QUOTE_STATUSES = {
  AWAITING_ACTION: "awaiting-action",
  APPROVED: "approved",
  REJECTED: "rejected",
};

/**
 * Map Shopify Admin API DraftOrder nodes to Quote objects.
 * Uses ONLY real data from Shopify — no dummy/sample data fallback.
 */
export function mapDraftOrdersToQuotes(draftOrderNodes = []) {
  if (!Array.isArray(draftOrderNodes) || draftOrderNodes.length === 0) {
    return [];
  }

  return draftOrderNodes.map((node, index) => {
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

    const money = node.totalPriceSet?.shopMoney || {};
    const currency = money.currencyCode || "SGD";
    const amount = Number(money.amount) || 0;
    const formattedPrice = `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

    let status = QUOTE_STATUSES.AWAITING_ACTION;
    let metaText = "";
    const createdDate = formatDate(node.createdAt);

    // Check custom attributes for sales rep and validity
    const customAttrs = node.customAttributes || [];
    const repAttr = customAttrs.find((a) => a.key === "Sales Rep" || a.key === "Sent By" || a.key === "Representative");
    const validAttr = customAttrs.find((a) => a.key === "Valid Until" || a.key === "Target Date");
    const repName = repAttr?.value || "Sales Team";
    const validUntil = validAttr?.value ? `Valid until ${validAttr.value}` : calculateValidityDate(node.createdAt);

    const decision = node.hyveStatus?.jsonValue;

    if (decision === true) {
      status = QUOTE_STATUSES.APPROVED;
      metaText = node.order?.name
        ? `${createdDate} · Converted to ${node.order.name}`
        : `${createdDate} · Approved · ${validUntil}`;
    } else if (decision === false) {
      status = QUOTE_STATUSES.REJECTED;
      metaText = `${createdDate} · Rejected`;
    } else {
      status = QUOTE_STATUSES.AWAITING_ACTION;
      metaText = `${createdDate} · Sent by ${repName} · ${validUntil}`;
    }

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
      isRejectedPrice: status === QUOTE_STATUSES.REJECTED,
      createdAt: node.createdAt,
    };
  });
}

function calculateValidityDate(createdAt) {
  if (!createdAt) return "Valid for 14 days";
  try {
    const d = new Date(createdAt);
    d.setDate(d.getDate() + 14);
    return `Valid until ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d)}`;
  } catch (e) {
    return "Valid for 14 days";
  }
}

/**
 * Render the complete Quotes page HTML.
 */
export function quotesPage({ quotes = [], notice = null, error = null }) {
  const hasQuotes = quotes && quotes.length > 0;
  const quoteRowsHtml = hasQuotes ? quotes.map((q) => renderQuoteRow(q)).join("") : "";

  return `
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
          <button type="button" class="hyve-quotes__tab" data-filter="awaiting-action">Awaiting Action</button>
          <button type="button" class="hyve-quotes__tab" data-filter="approved">Approved</button>
          <button type="button" class="hyve-quotes__tab" data-filter="rejected">Rejected</button>
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
                type="date"
                name="targetDate"
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
  </div>

  ${renderClientScript(hasQuotes)}
  ${QUOTES_STYLES}
  `;
}

function renderQuoteRow(q) {
  let badgeHtml = "";
  let actionButtonsHtml = "";

  if (q.status === QUOTE_STATUSES.AWAITING_ACTION) {
    badgeHtml = `
      <span class="hyve-badge hyve-badge--awaiting">
        ${icoMail()}
        <span>Awaiting Action</span>
      </span>`;

    const resumeHref = q.invoiceUrl && q.invoiceUrl !== "#" ? q.invoiceUrl : "javascript:void(0);";
    const resumeOnclick = !q.invoiceUrl || q.invoiceUrl === "#" ? "onclick=\"alert('Opening checkout invoice for " + esc(q.name) + "...');\"" : "";

    actionButtonsHtml = `
      <a href="${resumeHref}" ${resumeOnclick} class="hyve-btn hyve-btn--resume">
        ${icoCart()}
        <span>Resume &amp; Order</span>
      </a>
      <a class="hyve-btn hyve-btn--pdf" href="${esc(q.pdfHref)}">
        ${icoDownload()}
        <span>PDF</span>
      </a>`;
  } else if (q.status === QUOTE_STATUSES.APPROVED) {
    badgeHtml = `
      <span class="hyve-badge hyve-badge--approved">
        ${icoCheck()}
        <span>Approved</span>
      </span>`;

    // An approved quote that already became an order is viewable; one that
    // hasn't been ordered yet still needs its checkout link.
    const primary = q.orderName
      ? `<a href="${esc(q.orderHref)}" class="hyve-btn hyve-btn--secondary">${icoEye()}<span>View Order</span></a>`
      : `<a href="${esc(q.invoiceUrl || "#")}" class="hyve-btn hyve-btn--resume">${icoCart()}<span>Resume &amp; Order</span></a>`;

    actionButtonsHtml = `
      ${primary}
      <a class="hyve-btn hyve-btn--pdf" href="${esc(q.pdfHref)}">
        ${icoDownload()}
        <span>PDF</span>
      </a>`;
  } else {
    // Rejected: staff turned it down, so the only way forward is a fresh quote.
    badgeHtml = `
      <span class="hyve-badge hyve-badge--rejected">
        ${icoClock()}
        <span>Rejected</span>
      </span>`;

    actionButtonsHtml = `
      <button type="button" class="hyve-btn hyve-btn--secondary" onclick="requoteItem('${esc(q.name)}', '${esc(q.items)}')">
        ${icoRefresh()}
        <span>Requote</span>
      </button>
      <a class="hyve-btn hyve-btn--pdf" href="${esc(q.pdfHref)}">
        ${icoDownload()}
        <span>PDF</span>
      </a>`;
  }

  const priceClass =
    q.status === QUOTE_STATUSES.REJECTED
      ? "hyve-quote-item__price hyve-quote-item__price--rejected"
      : "hyve-quote-item__price";

  return `
    <div
      class="hyve-quote-item"
      data-status="${esc(q.status)}"
      data-search="${esc(`${q.name} ${q.items} ${q.meta} ${q.price}`).toLowerCase()}"
    >
      <div class="hyve-quote-item__left">
        <div class="hyve-quote-item__header">
          <span class="hyve-quote-item__name">${esc(q.name)}</span>
          ${badgeHtml}
        </div>
        <div class="hyve-quote-item__summary">${esc(q.items)}</div>
        <div class="hyve-quote-item__meta">${esc(q.meta)}</div>
      </div>

      <div class="hyve-quote-item__right">
        <div class="${priceClass}">${esc(q.price)}</div>
        <div class="hyve-quote-item__actions">
          ${actionButtonsHtml}
        </div>
      </div>
    </div>`;
}

/* -------------------------------------------------------------------------- */
/* Client Script                                                              */
/* -------------------------------------------------------------------------- */

// eslint-disable-next-line no-unused-vars -- part of the page's signature; callers pass it
function renderClientScript(hasQuotes) {
  return `
  <script>
    (function() {
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

        // Show/hide matching rows based on current page
        var startIdx = (currentPage - 1) * PAGE_SIZE;
        var endIdx = startIdx + PAGE_SIZE;

        currentMatchingRows.forEach(function(row, idx) {
          if (idx >= startIdx && idx < endIdx) {
            row.style.display = 'flex';
          } else {
            row.style.display = 'none';
          }
        });

        // Filter empty state
        if (emptyEl) {
          emptyEl.style.display = totalItems === 0 ? 'block' : 'none';
        }

        // Pagination controls
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

      // Initialize
      filterAndPaginate();

      // Modal helpers
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

function formatDate(dateVal) {
  if (!dateVal) return "Recent";
  try {
    const d = new Date(dateVal);
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(d);
  } catch (e) {
    return String(dateVal);
  }
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
  .hyve-quote-item__price--rejected {
    color: #94a3b8;
    text-decoration: line-through;
  }
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
</style>`;
