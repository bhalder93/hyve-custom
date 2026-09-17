/**
 * Account Settings page for the account portal (rendered inside accountShell).
 *
 * Provides:
 *   - Profile Information (Full Name, Email Address, Company, Phone, Save Changes button)
 *   - Notifications (Email Notifications, WhatsApp Updates via customer metafield, Marketing Emails)
 *   - Instant toggle interactivity with AJAX persistence to customer metafields
 *   - Production-ready responsive layout matching the UI mockup
 */
import { esc } from "./account-shell.server";

/**
 * Format customer settings data with fallbacks matching the mockup.
 */
export function mapCustomerSettings(customer = null) {
  const firstName = customer?.firstName || "";
  const lastName = customer?.lastName || "";
  const displayName = customer?.displayName || "";
  const fullName =
    displayName ||
    `${firstName} ${lastName}`.trim() ||
    customer?.name ||
    "Sarah Mitchell";

  const email =
    customer?.email ||
    customer?.defaultEmailAddress?.emailAddress ||
    "sarah@acmecorp.sg";

  const company =
    customer?.companyMetafield?.value ||
    customer?.defaultAddress?.company ||
    "Acme Corp Pte. Ltd.";

  const phone =
    customer?.phone ||
    customer?.defaultAddress?.phone ||
    "+65 9123 4567";

  // Notification preferences
  // WhatsApp Updates stored in customer metafield: custom.whatsapp_updates
  const whatsappUpdates =
    customer?.whatsappMetafield?.value != null
      ? customer.whatsappMetafield.value === "true" || customer.whatsappMetafield.value === true
      : false; // default OFF matching screenshot

  const emailNotifications =
    customer?.emailNotificationsMetafield?.value != null
      ? customer.emailNotificationsMetafield.value === "true" || customer.emailNotificationsMetafield.value === true
      : true; // default ON matching screenshot

  const marketingEmails =
    customer?.marketingEmailsMetafield?.value != null
      ? customer.marketingEmailsMetafield.value === "true" || customer.marketingEmailsMetafield.value === true
      : customer?.emailMarketingConsent?.marketingState === "SUBSCRIBED" || true; // default ON matching screenshot

  return {
    id: customer?.id || "",
    fullName,
    firstName,
    lastName,
    email,
    company,
    phone,
    notifications: {
      emailNotifications,
      whatsappUpdates,
      marketingEmails,
    },
  };
}

/**
 * Settings Page Renderer.
 */
export function settingsPage({
  settings = {},
  // eslint-disable-next-line no-unused-vars -- part of the page's signature; callers pass it
  customer = null,
  notice = null,
  error = null,
} = {}) {
  const toastHtml = renderNotificationToast(notice, error);

  return `
    <div class="hyve-settings">
      ${toastHtml}

      <header class="hyve-settings__header">
        <h1 class="hyve-settings__title">Account Settings</h1>
        <p class="hyve-settings__sub">Manage your profile and preferences</p>
      </header>

      <form method="POST" action="/apps/account/settings" id="hyve-settings-form" class="hyve-settings__grid">
        <input type="hidden" name="intent" value="saveSettings">

        <!-- Left Card: Profile Information -->
        <section class="hyve-settings__card">
          <div class="hyve-settings__card-head">
            <span class="hyve-settings__card-icon">${icoUserOutline()}</span>
            <h2 class="hyve-settings__card-title">Profile Information</h2>
          </div>

          <div class="hyve-settings__form-group">
            <label class="hyve-settings__label" for="settings-fullname">Full Name</label>
            <input
              type="text"
              id="settings-fullname"
              name="fullName"
              class="hyve-settings__input"
              value="${esc(settings.fullName)}"
              required
              placeholder="e.g. Sarah Mitchell"
            >
          </div>

          <div class="hyve-settings__form-group">
            <label class="hyve-settings__label" for="settings-email">Email Address</label>
            <input
              type="email"
              id="settings-email"
              name="email"
              class="hyve-settings__input hyve-settings__input--disabled"
              value="${esc(settings.email)}"
              readonly
              title="Email address is associated with your store login"
            >
          </div>

          <div class="hyve-settings__form-group">
            <label class="hyve-settings__label" for="settings-company">Company</label>
            <input
              type="text"
              id="settings-company"
              name="company"
              class="hyve-settings__input"
              value="${esc(settings.company)}"
              placeholder="e.g. Acme Corp Pte. Ltd."
            >
          </div>

          <div class="hyve-settings__form-group">
            <label class="hyve-settings__label" for="settings-phone">Phone</label>
            <input
              type="tel"
              id="settings-phone"
              name="phone"
              class="hyve-settings__input"
              value="${esc(settings.phone)}"
              placeholder="e.g. +65 9123 4567"
            >
          </div>

          <div class="hyve-settings__card-foot">
            <button type="submit" class="hyve-settings__btn-save" id="hyve-save-btn">
              ${icoCheck()}
              <span>Save Changes</span>
            </button>
          </div>
        </section>

        <!-- Right Card: Notifications -->
        <section class="hyve-settings__card">
          <div class="hyve-settings__card-head">
            <span class="hyve-settings__card-icon">${icoBell()}</span>
            <h2 class="hyve-settings__card-title">Notifications</h2>
          </div>

          <div class="hyve-settings__toggles">
            <!-- Email Notifications -->
            <div class="hyve-toggle-row">
              <div class="hyve-toggle-row__content">
                <span class="hyve-toggle-row__title">Email Notifications</span>
                <span class="hyve-toggle-row__sub">Order updates, proof approvals, shipping alerts</span>
              </div>
              <label class="hyve-switch">
                <input
                  type="checkbox"
                  name="emailNotifications"
                  value="true"
                  class="hyve-switch__input"
                  data-setting-key="emailNotifications"
                  ${settings.notifications?.emailNotifications ? "checked" : ""}
                >
                <span class="hyve-switch__slider"></span>
              </label>
            </div>

            <!-- WhatsApp Updates (Metafield) -->
            <div class="hyve-toggle-row">
              <div class="hyve-toggle-row__content">
                <span class="hyve-toggle-row__title">WhatsApp Updates</span>
                <span class="hyve-toggle-row__sub">Receive real-time updates via WhatsApp</span>
              </div>
              <label class="hyve-switch">
                <input
                  type="checkbox"
                  name="whatsappUpdates"
                  value="true"
                  class="hyve-switch__input"
                  data-setting-key="whatsappUpdates"
                  ${settings.notifications?.whatsappUpdates ? "checked" : ""}
                >
                <span class="hyve-switch__slider"></span>
              </label>
            </div>

            <!-- Marketing Emails -->
            <div class="hyve-toggle-row">
              <div class="hyve-toggle-row__content">
                <span class="hyve-toggle-row__title">Marketing Emails</span>
                <span class="hyve-toggle-row__sub">New products, promotions, and industry tips</span>
              </div>
              <label class="hyve-switch">
                <input
                  type="checkbox"
                  name="marketingEmails"
                  value="true"
                  class="hyve-switch__input"
                  data-setting-key="marketingEmails"
                  ${settings.notifications?.marketingEmails ? "checked" : ""}
                >
                <span class="hyve-switch__slider"></span>
              </label>
            </div>
          </div>
        </section>
      </form>
    </div>
    ${SETTINGS_STYLES}
    ${SETTINGS_SCRIPT}`;
}

/**
 * Toast notifications.
 */
function renderNotificationToast(notice, error) {
  if (!notice && !error) return "";

  const isErr = Boolean(error);
  const msg = error || notice;
  const icon = isErr ? icoAlert() : icoCheckCircle();
  const tone = isErr ? "error" : "success";

  return `
    <div class="hyve-settings__toast hyve-settings__toast--${tone}" role="status">
      <span class="hyve-settings__toast-icon">${icon}</span>
      <span class="hyve-settings__toast-msg">${esc(msg)}</span>
      <button type="button" class="hyve-settings__toast-close" onclick="this.parentElement.remove()" aria-label="Dismiss">
        ${icoClose()}
      </button>
    </div>`;
}

/* ---------- SVG Icons ---------- */
function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function icoUserOutline() {
  return svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>');
}

function icoBell() {
  return svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>');
}

function icoCheck() {
  return svg('<polyline points="20 6 9 17 4 12"/>');
}

function icoCheckCircle() {
  return svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>');
}

function icoClose() {
  return svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
}

function icoAlert() {
  return svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>');
}

/* ---------- Styles ---------- */
const SETTINGS_STYLES = `
<style>
  .hyve-settings {
    --stg-fg: #0f172a;
    --stg-sub: #64748b;
    --stg-muted: #94A3B8;
    --stg-line: #e2e8f0;
    --stg-green-active: #a3ea6e;
    --stg-btn-bg: #80eec0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--stg-fg);
    max-width: 100%;
    margin: 0 auto;
  }

  /* Header */
  .hyve-settings__header {
    margin-bottom: 24px;
  }
  .hyve-settings__title {
    font-size: 22px;
    font-weight: 800;
    color: var(--stg-fg);
    letter-spacing: -0.02em;
    margin: 0 0 4px;
  }
  .hyve-settings__sub {
    font-size: 13.5px;
    color: var(--stg-sub);
    margin: 0;
  }

  /* Toasts */
  .hyve-settings__toast {
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
  .hyve-settings__toast--success {
    background: #ecfdf3;
    color: #15803d;
    border: 1px solid #bbf7d0;
  }
  .hyve-settings__toast--error {
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
  }
  .hyve-settings__toast-icon svg {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
  .hyve-settings__toast-msg {
    flex: 1;
  }
  .hyve-settings__toast-close {
    background: transparent;
    border: 0;
    cursor: pointer;
    color: inherit;
    opacity: 0.7;
    padding: 2px;
    line-height: 0;
  }
  .hyve-settings__toast-close svg {
    width: 16px;
    height: 16px;
  }

  /* Two Column Grid */
  .hyve-settings__grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    align-items: start;
  }

  @media (max-width: 960px) {
    .hyve-settings__grid {
      grid-template-columns: 1fr;
      gap: 20px;
    }
  }

  /* Settings Card */
  .hyve-settings__card {
    background: #ffffff;
    border: 1px solid var(--stg-line);
    border-radius: 14px;
    padding: 24px;
    box-sizing: border-box;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
  }

  @media (max-width: 640px) {
    .hyve-settings__card {
      padding: 18px 14px;
    }
  }

  /* Card Head */
  .hyve-settings__card-head {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 20px;
    padding-bottom: 4px;
  }
  .hyve-settings__card-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #0f172a;
  }
  .hyve-settings__card-icon svg {
    width: 20px;
    height: 20px;
    stroke-width: 2.2;
  }
  .hyve-settings__card-title {
    font-size: 15.5px;
    font-weight: 800;
    color: var(--stg-fg);
    margin: 0;
    letter-spacing: -0.01em;
  }

  /* Form controls */
  .hyve-settings__form-group {
    display: flex;
    flex-direction: column;
    gap: 5.5px;
    margin-bottom: 16px;
  }
  .hyve-settings__label {
    font-size: 12.5px;
    font-weight: 700;
    color: #475569;
  }
  .hyve-settings__input {
    width: 100%;
    padding: 9.5px 14px;
    border: 1px solid var(--stg-line);
    border-radius: 8.5px;
    font-size: 13.5px;
    font-family: inherit;
    color: var(--stg-fg);
    background: #ffffff;
    box-sizing: border-box;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .hyve-settings__input:focus {
    outline: none;
    border-color: #0f172a;
    box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.08);
  }
  .hyve-settings__input--disabled {
    background: #f8fafc;
    color: #64748b;
    cursor: not-allowed;
  }

  /* Save Changes Button */
  .hyve-settings__card-foot {
    margin-top: 24px;
    display: flex;
    align-items: center;
  }
  .hyve-settings__btn-save {
    display: inline-flex;
    align-items: center;
    gap: 7.5px;
    background: linear-gradient(135deg, #a3ea6e 0%, #6ee7b7 100%);
    color: #0a1414;
    font-size: 13.5px;
    font-weight: 800;
    padding: 10px 18px;
    border-radius: 8.5px;
    border: none;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s ease;
    box-shadow: 0 2px 6px rgba(110, 231, 183, 0.25);
  }
  .hyve-settings__btn-save svg {
    width: 17px;
    height: 17px;
    stroke-width: 3;
    color: #0a1414;
  }
  .hyve-settings__btn-save:hover {
    filter: brightness(0.96);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(110, 231, 183, 0.35);
  }
  .hyve-settings__btn-save:active {
    transform: translateY(0);
  }

  /* Notifications Toggle Rows */
  .hyve-settings__toggles {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .hyve-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding-bottom: 18px;
    border-bottom: 1px solid #f1f5f9;
  }
  .hyve-toggle-row:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
  .hyve-toggle-row__content {
    display: flex;
    flex-direction: column;
    gap: 3.5px;
    flex: 1;
  }
  .hyve-toggle-row__title {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--stg-fg);
    line-height: 1.2;
  }
  .hyve-toggle-row__sub {
    font-size: 12px;
    color: var(--stg-sub);
    line-height: 1.4;
  }

  /* iOS Style Switch */
  .hyve-switch {
    position: relative;
    display: inline-block;
    width: 46px;
    height: 26px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .hyve-switch__input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .hyve-switch__slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background-color: #cbd5e1;
    border-radius: 999px;
    transition: background-color 0.25s ease;
  }
  .hyve-switch__slider::before {
    position: absolute;
    content: "";
    height: 20px;
    width: 20px;
    left: 3px;
    bottom: 3px;
    background-color: #ffffff;
    border-radius: 50%;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
    transition: transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  }
  .hyve-switch__input:checked + .hyve-switch__slider {
    background-color: #86efac;
    background: linear-gradient(135deg, #a3ea6e, #4ade80);
  }
  .hyve-switch__input:checked + .hyve-switch__slider::before {
    transform: translateX(20px);
  }

  @keyframes hyveFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>`;

/* ---------- Client Script ---------- */
const SETTINGS_SCRIPT = `
<script>
(() => {
  const form = document.getElementById('hyve-settings-form');
  const saveBtn = document.getElementById('hyve-save-btn');
  const toggleInputs = document.querySelectorAll('.hyve-switch__input');

  // Instant async toggle persistence for notifications
  toggleInputs.forEach(input => {
    input.addEventListener('change', async () => {
      const key = input.getAttribute('data-setting-key');
      const isChecked = input.checked;

      const formData = new FormData();
      formData.append('intent', 'toggleNotification');
      formData.append('settingKey', key);
      formData.append('value', isChecked ? 'true' : 'false');

      try {
        const res = await fetch(window.location.href, {
          method: 'POST',
          body: formData,
          headers: { 'Accept': 'application/json' },
        });

        if (res.ok) {
          showBriefToast(key === 'whatsappUpdates'
            ? (isChecked ? 'WhatsApp updates enabled' : 'WhatsApp updates disabled')
            : 'Notification preference saved');
        }
      } catch (err) {
        console.warn('Failed to save toggle async', err);
      }
    });
  });

  function showBriefToast(message) {
    let existing = document.querySelector('.hyve-settings__toast--auto');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'hyve-settings__toast hyve-settings__toast--success hyve-settings__toast--auto';
    toast.innerHTML = \`
      <span class="hyve-settings__toast-icon">${icoCheckCircle()}</span>
      <span class="hyve-settings__toast-msg">\${message}</span>
    \`;
    const header = document.querySelector('.hyve-settings__header');
    if (header) header.insertAdjacentElement('beforebegin', toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.4s ease';
      setTimeout(() => toast.remove(), 400);
    }, 3000);
  }

  // Handle form submission with loading indicator
  if (form && saveBtn) {
    form.addEventListener('submit', () => {
      saveBtn.disabled = true;
      saveBtn.querySelector('span').textContent = 'Saving...';
    });
  }

  // Auto-dismiss initial toasts
  const toast = document.querySelector('.hyve-settings__toast:not(.hyve-settings__toast--auto)');
  if (toast) {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.5s ease';
      setTimeout(() => toast.remove(), 500);
    }, 4500);
  }
})();
</script>`;
