/**
 * Addresses page for the account portal (the `main` half of the account shell).
 *
 * Renders customer shipping and billing addresses in an aesthetic card grid
 * matching the portal design:
 *   - Highlighted default card with green border and "✓ DEFAULT" badge
 *   - Category badge with truck icon for "SHIPPING" or credit card icon for "BILLING"
 *   - Formatted recipient name, company/department, street lines, city, postal, country, phone and tax reg. no.
 *   - Action buttons: "Edit", "Set Default" (for non-defaults), and delete icon button
 *   - Dashed card for "+ Add New Address"
 *   - Interactive modals for Add, Edit, and Delete confirmation
 */
import { esc } from "./account-shell.server";

/**
 * Format and normalize Shopify Customer addresses for display.
 *
 * A customer with none saved gets an empty list and the page says so. It used
 * to invent three addresses from the mockup — a fictional person, company and
 * phone number — and show them as the customer's own, which risked a shipment
 * going to an address nobody had ever entered.
 */
export function mapAddresses(rawAddresses = [], defaultAddressId = null, customer = null) {
  return rawAddresses.map((addr, index) => {
    const isDefault =
      addr.id === defaultAddressId ||
      (!defaultAddressId && index === 0);

    // Determine if billing or shipping
    // In Shopify, addresses can be identified by company, note, or user preference
    const isBilling =
      addr.company?.toLowerCase().includes("finance") ||
      addr.company?.toLowerCase().includes("billing") ||
      addr.address2?.toLowerCase().includes("tax reg") ||
      addr.address2?.toLowerCase().includes("tax") ||
      addr.type === "billing";

    const addressType = isBilling ? "billing" : "shipping";

    const firstName = addr.firstName || "";
    const lastName = addr.lastName || "";
    const primaryName =
      addr.name ||
      `${firstName} ${lastName}`.trim() ||
      addr.company ||
      customer?.name ||
      "Address";

    // Build address lines
    const lines = [];
    if (addr.company && addr.company !== primaryName) {
      lines.push(addr.company);
    }
    if (addr.address1) {
      lines.push(addr.address1);
    }
    if (addr.address2) {
      lines.push(addr.address2);
    }

    const cityPostalCountry = [
      addr.city,
      addr.province,
      addr.zip,
      addr.country || addr.countryCodeV2,
    ]
      .filter(Boolean)
      .join(" ");

    if (cityPostalCountry) {
      lines.push(cityPostalCountry);
    }
    if (addr.phone) {
      lines.push(addr.phone);
    }

    return {
      id: addr.id,
      rawId: addr.id ? addr.id.split("/").pop() : String(index),
      isDefault,
      type: addressType,
      primaryName,
      firstName,
      lastName,
      company: addr.company || "",
      address1: addr.address1 || "",
      address2: addr.address2 || "",
      city: addr.city || "",
      province: addr.province || "",
      provinceCode: addr.provinceCode || "",
      zip: addr.zip || "",
      country: addr.country || "",
      countryCodeV2: addr.countryCodeV2 || "SG",
      phone: addr.phone || "",
      lines,
    };
  });
}

/**
 * Main renderer for the Addresses page.
 */
export function addressesPage({
  addresses = [],
  // eslint-disable-next-line no-unused-vars -- part of the page's signature; callers pass it
  customer = null,
  notice = null,
  error = null,
} = {}) {
  const cardsHtml = addresses.map(renderAddressCard).join("");

  const toastHtml = renderNotificationToast(notice, error);

  return `
    ${ADDRESSES_STYLES}
    <div class="hyve-addr">
      ${toastHtml}

      <header class="hyve-addr__header">
        <h1 class="hyve-addr__title">Addresses</h1>
        <p class="hyve-addr__sub">Manage your shipping and billing addresses</p>
      </header>

      ${
        addresses.length
          ? ""
          : `<p class="hyve-addr__empty">You have no saved addresses yet. Add one and it will be offered at checkout.</p>`
      }

      <div class="hyve-addr__grid">
        ${cardsHtml}
        ${renderAddCard()}
      </div>

      ${renderAddressModal()}
      ${renderDeleteModal()}
    </div>
    ${ADDRESSES_SCRIPT}`;
}

/**
 * Render an individual address card.
 */
function renderAddressCard(addr) {
  const isShipping = addr.type === "shipping";
  const typeBadge = isShipping
    ? `<div class="hyve-addr__type">${icoTruck()}<span>SHIPPING</span></div>`
    : `<div class="hyve-addr__type">${icoCard()}<span>BILLING</span></div>`;

  const defaultBadge = addr.isDefault
    ? `<span class="hyve-addr__badge-default">${icoCheck()} DEFAULT</span>`
    : "";

  const linesHtml = addr.lines
    .map((line) => `<div class="hyve-addr__line">${esc(line)}</div>`)
    .join("");

  const setDefaultBtn = !addr.isDefault
    ? `<button type="button" class="hyve-addr__btn hyve-addr__btn--default" data-set-default="${esc(addr.id)}">Set Default</button>`
    : "";

  const encodedData = esc(JSON.stringify(addr));

  return `
    <article class="hyve-addr-card${addr.isDefault ? " hyve-addr-card--default" : ""}" data-address-id="${esc(addr.id)}" data-json="${encodedData}">
      <div class="hyve-addr-card__head">
        ${typeBadge}
        ${defaultBadge}
      </div>

      <div class="hyve-addr-card__body">
        <h3 class="hyve-addr-card__name">${esc(addr.primaryName)}</h3>
        <div class="hyve-addr-card__details">
          ${linesHtml}
        </div>
      </div>

      <div class="hyve-addr-card__foot">
        <button type="button" class="hyve-addr__btn hyve-addr__btn--edit" data-edit-addr="${esc(addr.id)}">
          ${icoEdit()}
          <span>Edit</span>
        </button>
        ${setDefaultBtn}
        <button type="button" class="hyve-addr__btn-icon hyve-addr__btn-icon--delete" data-delete-addr="${esc(addr.id)}" aria-label="Delete address" title="Delete address">
          ${icoTrash()}
        </button>
      </div>
    </article>`;
}

/**
 * Render the dashed "Add New Address" card.
 */
function renderAddCard() {
  return `
    <button type="button" class="hyve-addr-card hyve-addr-card--add" data-open-add-modal>
      <div class="hyve-addr-card__add-inner">
        <span class="hyve-addr-card__add-icon">${icoPlus()}</span>
        <span class="hyve-addr-card__add-text">Add New Address</span>
      </div>
    </button>`;
}

/**
 * Render notifications toast (e.g. on redirect after create, update, delete).
 */
function renderNotificationToast(notice, error) {
  if (!notice && !error) return "";

  const isErr = Boolean(error);
  const msg = error || notice;
  const icon = isErr ? icoAlert() : icoCheckCircle();
  const tone = isErr ? "error" : "success";

  return `
    <div class="hyve-addr__toast hyve-addr__toast--${tone}" role="status">
      <span class="hyve-addr__toast-icon">${icon}</span>
      <span class="hyve-addr__toast-msg">${esc(msg)}</span>
      <button type="button" class="hyve-addr__toast-close" onclick="this.parentElement.remove()" aria-label="Dismiss">
        ${icoClose()}
      </button>
    </div>`;
}

/**
 * Modal dialog for Creating and Editing addresses.
 */
function renderAddressModal() {
  return `
    <dialog class="hyve-modal" id="hyve-address-modal" aria-labelledby="hyve-modal-title">
      <div class="hyve-modal__backdrop" data-modal-close></div>
      <div class="hyve-modal__dialog">
        <div class="hyve-modal__head">
          <div>
            <h2 class="hyve-modal__title" id="hyve-modal-title">Add New Address</h2>
            <p class="hyve-modal__sub">Enter the address details below</p>
          </div>
          <button type="button" class="hyve-modal__close" data-modal-close aria-label="Close dialog">
            ${icoClose()}
          </button>
        </div>

        <form method="POST" action="/apps/account/addresses" class="hyve-modal__form" id="hyve-address-form">
          <input type="hidden" name="intent" id="addr-intent" value="create">
          <input type="hidden" name="addressId" id="addr-id" value="">

          <div class="hyve-form-group">
            <label class="hyve-label">Address Type</label>
            <div class="hyve-segmented">
              <label class="hyve-segmented__opt">
                <input type="radio" name="addressType" value="shipping" id="type-shipping" checked>
                <span>${icoTruck()} Shipping</span>
              </label>
              <label class="hyve-segmented__opt">
                <input type="radio" name="addressType" value="billing" id="type-billing">
                <span>${icoCard()} Billing</span>
              </label>
            </div>
          </div>

          <div class="hyve-form-row hyve-form-row--2">
            <div class="hyve-form-group">
              <label class="hyve-label" for="addr-first-name">First Name</label>
              <input type="text" class="hyve-input" id="addr-first-name" name="firstName" required placeholder="e.g. Sarah">
            </div>
            <div class="hyve-form-group">
              <label class="hyve-label" for="addr-last-name">Last Name</label>
              <input type="text" class="hyve-input" id="addr-last-name" name="lastName" required placeholder="e.g. Mitchell">
            </div>
          </div>

          <div class="hyve-form-row hyve-form-row--2">
            <div class="hyve-form-group">
              <label class="hyve-label" for="addr-company">Company</label>
              <input type="text" class="hyve-input" id="addr-company" name="company" placeholder="e.g. Acme Corp Pte. Ltd.">
            </div>
            <div class="hyve-form-group">
              <label class="hyve-label" for="addr-nickname">Department / Label <span class="hyve-label__opt">(Optional)</span></label>
              <input type="text" class="hyve-input" id="addr-nickname" name="label" placeholder="e.g. KL Office, Finance Dept">
            </div>
          </div>

          <div class="hyve-form-group">
            <label class="hyve-label" for="addr-address1">Street Address</label>
            <input type="text" class="hyve-input" id="addr-address1" name="address1" required placeholder="e.g. 1 Raffles Place, #20-01">
          </div>

          <div class="hyve-form-group">
            <label class="hyve-label" for="addr-address2">Apartment, Suite, Building <span class="hyve-label__opt">(Optional)</span></label>
            <input type="text" class="hyve-input" id="addr-address2" name="address2" placeholder="e.g. One Raffles Place Tower 2">
          </div>

          <div class="hyve-form-row hyve-form-row--3">
            <div class="hyve-form-group">
              <label class="hyve-label" for="addr-city">City</label>
              <input type="text" class="hyve-input" id="addr-city" name="city" required placeholder="e.g. Singapore">
            </div>
            <div class="hyve-form-group">
              <label class="hyve-label" for="addr-country">Country / Region</label>
              <select class="hyve-select" id="addr-country" name="countryCode" required>
                <option value="SG">Singapore</option>
                <option value="MY">Malaysia</option>
                <option value="US">United States</option>
                <option value="GB">United Kingdom</option>
                <option value="AU">Australia</option>
                <option value="CA">Canada</option>
                <option value="DE">Germany</option>
                <option value="FR">France</option>
                <option value="HK">Hong Kong</option>
                <option value="JP">Japan</option>
                <option value="NZ">New Zealand</option>
                <option value="PH">Philippines</option>
                <option value="TH">Thailand</option>
                <option value="VN">Vietnam</option>
                <option value="ID">Indonesia</option>
              </select>
            </div>
            <div class="hyve-form-group">
              <label class="hyve-label" for="addr-zip">Postal / ZIP Code</label>
              <input type="text" class="hyve-input" id="addr-zip" name="zip" required placeholder="e.g. 048616">
            </div>
          </div>

          <div class="hyve-form-row hyve-form-row--2">
            <div class="hyve-form-group">
              <label class="hyve-label" for="addr-province">State / Province / Region <span class="hyve-label__opt">(Optional)</span></label>
              <input type="text" class="hyve-input" id="addr-province" name="province" placeholder="e.g. Federal Territory">
            </div>
            <div class="hyve-form-group">
              <label class="hyve-label" for="addr-phone">Phone Number</label>
              <input type="tel" class="hyve-input" id="addr-phone" name="phone" placeholder="e.g. +65 9123 4567">
            </div>
          </div>

          <div class="hyve-form-group">
            <label class="hyve-checkbox">
              <input type="checkbox" name="setAsDefault" id="addr-set-default" value="true">
              <span class="hyve-checkbox__check"></span>
              <span class="hyve-checkbox__label">Set as default address</span>
            </label>
          </div>

          <div class="hyve-modal__actions">
            <button type="button" class="hyve-addr__btn hyve-addr__btn--ghost" data-modal-close>Cancel</button>
            <button type="submit" class="hyve-addr__btn hyve-addr__btn--primary" id="hyve-submit-btn">
              <span>Save Address</span>
            </button>
          </div>
        </form>
      </div>
    </dialog>`;
}

/**
 * Delete confirmation dialog.
 */
function renderDeleteModal() {
  return `
    <dialog class="hyve-modal hyve-modal--confirm" id="hyve-delete-modal" aria-labelledby="hyve-delete-title">
      <div class="hyve-modal__backdrop" data-delete-modal-close></div>
      <div class="hyve-modal__dialog hyve-modal__dialog--sm">
        <div class="hyve-modal__confirm-icon">
          ${icoTrash()}
        </div>
        <h2 class="hyve-modal__title" id="hyve-delete-title">Delete Address</h2>
        <p class="hyve-modal__sub">Are you sure you want to delete this address? This action cannot be undone.</p>

        <form method="POST" action="/apps/account/addresses" id="hyve-delete-form">
          <input type="hidden" name="intent" value="delete">
          <input type="hidden" name="addressId" id="delete-addr-id" value="">

          <div class="hyve-modal__actions hyve-modal__actions--center">
            <button type="button" class="hyve-addr__btn hyve-addr__btn--ghost" data-delete-modal-close>Cancel</button>
            <button type="submit" class="hyve-addr__btn hyve-addr__btn--danger" id="hyve-delete-submit-btn">
              <span>Delete Address</span>
            </button>
          </div>
        </form>
      </div>
    </dialog>`;
}

/* ---------- SVG icons ---------- */
function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function icoTruck() {
  return svg(
    '<rect x="1" y="3" width="15" height="13" rx="2"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  );
}

function icoCard() {
  return svg(
    '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
  );
}

function icoCheck() {
  return svg('<polyline points="20 6 9 17 4 12"/>');
}

function icoCheckCircle() {
  return svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>');
}

function icoEdit() {
  return svg(
    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  );
}

function icoTrash() {
  return svg(
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  );
}

function icoPlus() {
  return svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>');
}

function icoClose() {
  return svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
}

function icoAlert() {
  return svg(
    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  );
}

/* ---------- Styles ---------- */
const ADDRESSES_STYLES = `
<style>
  .hyve-addr {
    --addr-fg: #0f172a;
    --addr-sub: #64748b;
    --addr-muted: #94A3B8;
    --addr-line: #e2e8f0;
    --addr-brand-green: #16a34a;
    --addr-default-border: #a3ea6e;
    --addr-default-bg: #f7fee7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--addr-fg);
    max-width: 100%;
    margin: 0 auto;
  }

  /* Header */
  .hyve-addr__header {
    margin-bottom: 24px;
  }
  .hyve-addr__title {
    font-size: 22px;
    font-weight: 800;
    color: var(--addr-fg);
    letter-spacing: -0.02em;
    margin: 0 0 4px;
  }
  .hyve-addr__sub {
    font-size: 13.5px;
    color: var(--addr-sub);
    margin: 0;
  }

  /* Notifications Toast */
  .hyve-addr__toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 10px;
    margin-bottom: 20px;
    font-size: 13px;
    font-weight: 600;
    animation: hyveFadeIn 0.25s ease;
  }
  .hyve-addr__toast--success {
    background: #ecfdf3;
    color: #15803d;
    border: 1px solid #bbf7d0;
  }
  .hyve-addr__toast--error {
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
  }
  .hyve-addr__toast-icon svg {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
  .hyve-addr__toast-msg {
    flex: 1;
  }
  .hyve-addr__toast-close {
    background: transparent;
    border: 0;
    cursor: pointer;
    color: inherit;
    opacity: 0.7;
    padding: 2px;
    line-height: 0;
  }
  .hyve-addr__toast-close:hover {
    opacity: 1;
  }
  .hyve-addr__toast-close svg {
    width: 16px;
    height: 16px;
  }

  /* Grid Layout: Responsive fluid auto-fill matching 4 cards on desktop */
  .hyve-addr__empty { font-size: 13px; color: var(--hyve-muted); margin: 0 0 16px; }

  .hyve-addr__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 18px;
    align-items: stretch;
  }

  @media (min-width: 1400px) {
    .hyve-addr__grid {
      grid-template-columns: repeat(4, 1fr);
    }
  }

  @media (max-width: 900px) {
    .hyve-addr__grid {
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 14px;
    }
  }

  @media (max-width: 640px) {
    .hyve-acct__main {
      padding: 16px 12px 40px !important;
    }
    .hyve-addr__header {
      margin-bottom: 18px;
    }
    .hyve-addr__title {
      font-size: 20px;
    }
    .hyve-addr__sub {
      font-size: 12.5px;
    }
    .hyve-addr__grid {
      grid-template-columns: 1fr;
      gap: 14px;
    }
  }

  /* Address Card Base */
  .hyve-addr-card {
    background: #ffffff;
    border: 1px solid var(--addr-line);
    border-radius: 14px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: 270px;
    box-sizing: border-box;
    position: relative;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
    transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
  }
  .hyve-addr-card:hover {
    box-shadow: 0 6px 16px rgba(15, 23, 42, 0.05);
  }

  @media (max-width: 640px) {
    .hyve-addr-card {
      padding: 16px;
      min-height: auto;
    }
    .hyve-addr-card--add {
      min-height: 140px;
      padding: 24px 16px;
    }
  }

  /* Default Card with signature green border */
  .hyve-addr-card--default {
    border: 1.5px solid #a3ea6e;
    box-shadow: 0 2px 8px rgba(163, 234, 110, 0.15);
  }

  /* Card Head: Type + Default badge */
  .hyve-addr-card__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 14px;
    min-height: 24px;
  }

  .hyve-addr__type {
    display: inline-flex;
    align-items: center;
    gap: 5.5px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--addr-sub);
  }
  .hyve-addr__type svg {
    width: 16.5px;
    height: 16.5px;
    color: #64748b;
    stroke-width: 2.2;
  }

  /* Green DEFAULT pill badge */
  .hyve-addr__badge-default {
    display: inline-flex;
    align-items: center;
    gap: 3.5px;
    background: #dcfce7;
    color: #15803d;
    font-size: 10.5px;
    font-weight: 800;
    letter-spacing: 0.05em;
    padding: 2.5px 7.5px;
    border-radius: 999px;
  }
  .hyve-addr__badge-default svg {
    width: 12px;
    height: 12px;
    stroke-width: 3;
  }

  /* Card Body */
  .hyve-addr-card__body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .hyve-addr-card__name {
    font-size: 14.5px;
    font-weight: 800;
    color: var(--addr-fg);
    margin: 0 0 3px;
    line-height: 1.3;
  }
  .hyve-addr-card__details {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hyve-addr__line {
    font-size: 12.5px;
    color: var(--addr-sub);
    line-height: 1.5;
    word-break: break-word;
  }

  /* Card Foot / Actions */
  .hyve-addr-card__foot {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 20px;
    padding-top: 12px;
  }

  /* Buttons */
  .hyve-addr__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6.5px 13px;
    border-radius: 7.5px;
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    text-decoration: none;
    transition: all 0.15s ease;
    border: 1px solid var(--addr-line);
    background: #ffffff;
    color: #334155;
    white-space: nowrap;
  }
  .hyve-addr__btn svg {
    width: 14px;
    height: 14px;
    color: #64748b;
  }
  .hyve-addr__btn:hover {
    background: #f8fafc;
    border-color: #cbd5e1;
    color: var(--addr-fg);
  }

  .hyve-addr__btn--edit {
    padding: 6px 12px;
  }

  .hyve-addr__btn--default {
    padding: 6px 11px;
    font-size: 12px;
  }

  .hyve-addr__btn--primary {
    background: #0f172a;
    color: #ffffff;
    border-color: #0f172a;
  }
  .hyve-addr__btn--primary:hover {
    background: #1e293b;
    border-color: #1e293b;
    color: #ffffff;
  }

  .hyve-addr__btn--ghost {
    background: #ffffff;
    color: #475569;
    border: 1px solid var(--addr-line);
  }

  .hyve-addr__btn--danger {
    background: #dc2626;
    color: #ffffff;
    border-color: #dc2626;
  }
  .hyve-addr__btn--danger:hover {
    background: #b91c1c;
    border-color: #b91c1c;
    color: #ffffff;
  }

  .hyve-addr__btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 7.5px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--addr-muted);
    cursor: pointer;
    margin-left: auto;
    transition: all 0.15s ease;
  }
  .hyve-addr__btn-icon svg {
    width: 16px;
    height: 16px;
  }
  .hyve-addr__btn-icon:hover {
    color: #ef4444;
    background: #fef2f2;
  }

  /* Add New Address Dashed Card */
  .hyve-addr-card--add {
    background: rgba(241, 245, 249, 0.5);
    border: 1.5px dashed #cbd5e1;
    cursor: pointer;
    align-items: center;
    justify-content: center;
    text-align: center;
    transition: all 0.2s ease;
  }
  .hyve-addr-card--add:hover {
    border-color: #94a3b8;
    background: #f1f5f9;
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(15, 23, 42, 0.05);
  }
  .hyve-addr-card__add-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .hyve-addr-card__add-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
  }
  .hyve-addr-card__add-icon svg {
    width: 26px;
    height: 26px;
    stroke-width: 2.4;
  }
  .hyve-addr-card__add-text {
    font-size: 13.5px;
    font-weight: 700;
    color: #64748b;
    transition: color 0.15s ease;
  }
  .hyve-addr-card--add:hover .hyve-addr-card__add-text,
  .hyve-addr-card--add:hover .hyve-addr-card__add-icon {
    color: #0f172a;
  }

  /* Dialog / Modals */
  .hyve-modal {
    border: 0;
    padding: 0;
    background: transparent;
    max-width: 100vw;
    max-height: 100vh;
    width: 100vw;
    height: 100vh;
    position: fixed;
    top: 0;
    left: 0;
    z-index: 9999;
    display: none;
    align-items: center;
    justify-content: center;
  }
  .hyve-modal[open] {
    display: flex;
  }
  .hyve-modal__backdrop {
    display: block !important;
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    backdrop-filter: blur(4px);
    animation: hyveFadeIn 0.2s ease;
  }
  .hyve-modal__dialog {
    position: relative;
    z-index: 10;
    background: #ffffff;
    border-radius: 16px;
    width: 90%;
    max-width: 560px;
    max-height: 90vh;
    overflow-y: auto;
    padding: 24px;
    box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.2);
    animation: hyveScaleUp 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    box-sizing: border-box;
  }
  .hyve-modal__dialog--sm {
    max-width: 400px;
    text-align: center;
  }
  .hyve-modal__confirm-icon {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: #fee2e2;
    color: #dc2626;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 14px;
  }
  .hyve-modal__confirm-icon svg {
    width: 24px;
    height: 24px;
  }

  .hyve-modal__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 20px;
  }
  .hyve-modal__title {
    font-size: 18px;
    font-weight: 800;
    color: var(--addr-fg);
    margin: 0 0 4px;
  }
  .hyve-modal__sub {
    font-size: 12.5px;
    color: var(--addr-sub);
    margin: 0;
  }
  .hyve-modal__close {
    background: transparent;
    border: 0;
    color: var(--addr-muted);
    cursor: pointer;
    padding: 4px;
    line-height: 0;
    border-radius: 6px;
  }
  .hyve-modal__close:hover {
    background: #f1f5f9;
    color: var(--addr-fg);
  }
  .hyve-modal__close svg {
    width: 20px;
    height: 20px;
  }

  /* Form controls */
  .hyve-modal__form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .hyve-form-row {
    display: grid;
    gap: 12px;
  }
  .hyve-form-row--2 {
    grid-template-columns: 1fr 1fr;
  }
  .hyve-form-row--3 {
    grid-template-columns: 1.2fr 1fr 1fr;
  }
  @media (max-width: 580px) {
    .hyve-form-row--2,
    .hyve-form-row--3 {
      grid-template-columns: 1fr;
    }
  }

  .hyve-form-group {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .hyve-label {
    font-size: 12px;
    font-weight: 700;
    color: #334155;
  }
  .hyve-label__opt {
    font-weight: 400;
    color: var(--addr-muted);
  }
  .hyve-input,
  .hyve-select {
    width: 100%;
    padding: 8.5px 12px;
    border: 1px solid var(--addr-line);
    border-radius: 8.5px;
    font-size: 13px;
    font-family: inherit;
    color: var(--addr-fg);
    background: #ffffff;
    box-sizing: border-box;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .hyve-input:focus,
  .hyve-select:focus {
    outline: none;
    border-color: #0f172a;
    box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.08);
  }

  /* Segmented control for Type */
  .hyve-segmented {
    display: flex;
    background: #f1f5f9;
    padding: 3.5px;
    border-radius: 8.5px;
    gap: 4px;
  }
  .hyve-segmented__opt {
    flex: 1;
    position: relative;
    cursor: pointer;
  }
  .hyve-segmented__opt input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .hyve-segmented__opt span {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px;
    border-radius: 6.5px;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--addr-sub);
    transition: all 0.15s ease;
  }
  .hyve-segmented__opt span svg {
    width: 16px;
    height: 16px;
  }
  .hyve-segmented__opt input:checked + span {
    background: #ffffff;
    color: var(--addr-fg);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }

  /* Checkbox */
  .hyve-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
    margin-top: 4px;
  }
  .hyve-checkbox input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .hyve-checkbox__check {
    width: 18px;
    height: 18px;
    border: 1px solid var(--addr-line);
    border-radius: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #ffffff;
    transition: all 0.15s ease;
  }
  .hyve-checkbox input:checked + .hyve-checkbox__check {
    background: #16a34a;
    border-color: #16a34a;
  }
  .hyve-checkbox input:checked + .hyve-checkbox__check::after {
    content: "✓";
    color: #ffffff;
    font-size: 12px;
    font-weight: 800;
  }
  .hyve-checkbox__label {
    font-size: 12.5px;
    font-weight: 600;
    color: #334155;
  }

  /* Modal Actions */
  .hyve-modal__actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--addr-line);
  }
  .hyve-modal__actions--center {
    justify-content: center;
    border-top: 0;
    margin-top: 14px;
  }

  @media (max-width: 640px) {
    .hyve-modal__dialog {
      width: 95%;
      padding: 18px 14px;
      border-radius: 14px;
      max-height: 90vh;
    }
    .hyve-modal__head {
      margin-bottom: 14px;
    }
    .hyve-modal__title {
      font-size: 16px;
    }
    .hyve-modal__actions {
      flex-direction: column-reverse;
      gap: 8px;
    }
    .hyve-modal__actions .hyve-addr__btn {
      width: 100%;
      padding: 8.5px;
      font-size: 13px;
    }
    .hyve-modal__actions--center {
      flex-direction: column-reverse;
    }
    .hyve-modal__actions--center .hyve-addr__btn {
      width: 100%;
    }
  }

  @keyframes hyveFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes hyveScaleUp {
    from { opacity: 0; transform: scale(0.96); }
    to { opacity: 1; transform: scale(1); }
  }
</style>`;

/* ---------- Client Script ---------- */
const ADDRESSES_SCRIPT = `
<script>
(() => {
  const modal = document.getElementById('hyve-address-modal');
  const deleteModal = document.getElementById('hyve-delete-modal');
  const form = document.getElementById('hyve-address-form');
  const deleteForm = document.getElementById('hyve-delete-form');
  const modalTitle = document.getElementById('hyve-modal-title');
  const submitBtn = document.getElementById('hyve-submit-btn');

  // Input refs
  const intentInput = document.getElementById('addr-intent');
  const idInput = document.getElementById('addr-id');
  const deleteIdInput = document.getElementById('delete-addr-id');
  const typeShipping = document.getElementById('type-shipping');
  const typeBilling = document.getElementById('type-billing');
  const firstNameInput = document.getElementById('addr-first-name');
  const lastNameInput = document.getElementById('addr-last-name');
  const companyInput = document.getElementById('addr-company');
  const nicknameInput = document.getElementById('addr-nickname');
  const address1Input = document.getElementById('addr-address1');
  const address2Input = document.getElementById('addr-address2');
  const cityInput = document.getElementById('addr-city');
  const countrySelect = document.getElementById('addr-country');
  const zipInput = document.getElementById('addr-zip');
  const provinceInput = document.getElementById('addr-province');
  const phoneInput = document.getElementById('addr-phone');
  const setDefaultCheck = document.getElementById('addr-set-default');

  function openAddModal() {
    form.reset();
    intentInput.value = 'create';
    idInput.value = '';
    modalTitle.textContent = 'Add New Address';
    submitBtn.querySelector('span').textContent = 'Save Address';
    typeShipping.checked = true;
    setDefaultCheck.checked = false;
    modal.showModal();
  }

  function openEditModal(addr) {
    form.reset();
    intentInput.value = 'update';
    idInput.value = addr.id || '';
    modalTitle.textContent = 'Edit Address';
    submitBtn.querySelector('span').textContent = 'Update Address';

    if (addr.type === 'billing') {
      typeBilling.checked = true;
    } else {
      typeShipping.checked = true;
    }

    firstNameInput.value = addr.firstName || '';
    lastNameInput.value = addr.lastName || '';
    companyInput.value = addr.company || '';
    address1Input.value = addr.address1 || '';
    address2Input.value = addr.address2 || '';
    cityInput.value = addr.city || '';
    zipInput.value = addr.zip || '';
    provinceInput.value = addr.province || '';
    phoneInput.value = addr.phone || '';
    setDefaultCheck.checked = Boolean(addr.isDefault);

    if (addr.countryCodeV2) {
      countrySelect.value = addr.countryCodeV2;
    }

    modal.showModal();
  }

  function openDeleteModal(addrId) {
    deleteIdInput.value = addrId;
    deleteModal.showModal();
  }

  function closeAllModals() {
    if (modal.open) modal.close();
    if (deleteModal.open) deleteModal.close();
  }

  // Bind add button
  document.querySelectorAll('[data-open-add-modal]').forEach(el => {
    el.addEventListener('click', openAddModal);
  });

  // Bind edit buttons
  document.querySelectorAll('[data-edit-addr]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.hyve-addr-card');
      if (!card) return;
      try {
        const addr = JSON.parse(card.getAttribute('data-json') || '{}');
        openEditModal(addr);
      } catch (err) {
        console.error('Failed to parse address data', err);
      }
    });
  });

  // Bind delete buttons
  document.querySelectorAll('[data-delete-addr]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const addrId = btn.getAttribute('data-delete-addr');
      openDeleteModal(addrId);
    });
  });

  // Bind Set Default buttons
  document.querySelectorAll('[data-set-default]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const addrId = btn.getAttribute('data-set-default');
      // Live Shopify customer: submit POST request
      const formData = new FormData();
      formData.append('intent', 'setDefault');
      formData.append('addressId', addrId);

      btn.disabled = true;
      btn.textContent = 'Updating...';

      try {
        const res = await fetch(window.location.href, {
          method: 'POST',
          body: formData,
        });
        if (res.ok) {
          window.location.href = window.location.pathname + '?notice=Default+address+updated+successfully';
        } else {
          window.location.reload();
        }
      } catch (err) {
        console.error('Failed to set default address', err);
        window.location.reload();
      }
    });
  });

  // Close triggers
  document.querySelectorAll('[data-modal-close]').forEach(el => {
    el.addEventListener('click', () => modal.close());
  });
  document.querySelectorAll('[data-delete-modal-close]').forEach(el => {
    el.addEventListener('click', () => deleteModal.close());
  });

  // Close on backdrop click
  window.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
    if (e.target === deleteModal) deleteModal.close();
  });

  // Auto-dismiss toast
  const toast = document.querySelector('.hyve-addr__toast');
  if (toast) {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.5s ease';
      setTimeout(() => toast.remove(), 500);
    }, 4500);
  }
})();
</script>`;
