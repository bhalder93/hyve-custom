/**
 * Distributor Application portal page.
 * Rendered inside accountShell at storefront /apps/account/distributor.
 *
 * Provides:
 *   1. Application Form matching the exact UI design:
 *      - Top promo banner (up to 20,000 SGD credit limit for PO financing)
 *      - Company Information & Operating Details (Legal Name, Website, Contact Person, Phone)
 *      - Country / Market Based In & Markets You Sell Into (selectable pills)
 *      - Commercial Credit Terms toggle (Net 30/60, Registration number, Annual volume, Registered address)
 *      - Document upload dropzone
 *      - Cancel & Submit Application buttons
 *   2. Professional "Application Received & Under Review" status view if customer has already applied.
 *   3. Responsive CSS for all viewports.
 */
import { esc } from "./account-shell.server";

/**
 * Main Distributor Page Renderer.
 * If `application` is provided, renders the "Application Received / Under Review" view.
 * Otherwise, renders the application form.
 */
/**
 * @param {object} [opts.values] what the applicant typed, echoed back when a
 *   submission fails. Losing a filled-in form to a server error is the fastest
 *   way to lose the applicant, which is the whole point of this page.
 */
export function distributorPage({
  customer = null,
  application = null,
  notice = null,
  error = null,
  values = null,
  currencies = [],
} = {}) {
  const typed = (field, fallback = "") => esc(values?.[field] ?? fallback);
  /** `selected` for the option the applicant chose, else for the default. */
  const chosen = (field, option, fallback = false) =>
    (values?.[field] != null ? values[field] === option : fallback) ? " selected" : "";
  const toastHtml = renderNotificationToast(notice, error);

  if (application) {
    return `
      ${DISTRIBUTOR_STYLES}
      <div class="hyve-dist">
        ${toastHtml}
        ${renderExistingApplicationView(application, customer)}
      </div>
      ${DISTRIBUTOR_SCRIPT}`;
  }

  return `
    ${DISTRIBUTOR_STYLES}
    <div class="hyve-dist">
      ${toastHtml}

      <header class="hyve-dist__header">
        <h1 class="hyve-dist__title">Apply for Distributor Portal</h1>
        <p class="hyve-dist__sub">Join the Hyve distributor network for commercial payment terms and exclusive tier pricing/tiers.</p>
      </header>

      <!-- Top Promo Banner -->
      <div class="hyve-dist__promo-banner">
        <span class="hyve-dist__promo-icon">${icoShieldCheck()}</span>
        <div class="hyve-dist__promo-text">
          <strong>Apply as distributor to get up to 20,000 SGD credit limit for PO Financing</strong>
          <span>(Subject to Credit Analysis)</span>
        </div>
      </div>

      <!-- Main Form Card -->
      <form method="POST" action="/apps/account/distributor" enctype="multipart/form-data" class="hyve-dist__form-card" id="hyve-distributor-form">
        <input type="hidden" name="intent" value="applyDistributor">

        <div class="hyve-dist__card-header">
          <div class="hyve-dist__card-title-group">
            <span class="hyve-dist__card-icon">${icoBuilding()}</span>
            <h2 class="hyve-dist__card-title">Company Information &amp; Operating Details</h2>
          </div>
        </div>

        <div class="hyve-dist__grid-2">
          <!-- Left Column: Company & Contact -->
          <div class="hyve-dist__col">
            <div class="hyve-dist__field">
              <label class="hyve-dist__label" for="dist-company">Company Legal Name <span class="hyve-dist__req">*</span></label>
              <input
                type="text"
                id="dist-company"
                name="companyName"
                class="hyve-dist__input"
                required
                placeholder="e.g. Acme Corporation SG Pte Ltd"
                value="${typed("companyName", customer?.company || "")}"
              >
            </div>

            <div class="hyve-dist__field">
              <label class="hyve-dist__label" for="dist-website">Company Website <span class="hyve-dist__req">*</span></label>
              <input
                type="url"
                id="dist-website"
                name="companyWebsite"
                class="hyve-dist__input"
                required
                placeholder="e.g. https://acmecorp.sg"
                value="${typed("companyWebsite")}"
              >
            </div>

            <div class="hyve-dist__field">
              <label class="hyve-dist__label" for="dist-contact">Primary Contact Person</label>
              <input
                type="text"
                id="dist-contact"
                name="contactPerson"
                class="hyve-dist__input"
                placeholder="e.g. Sarah Mitchell"
                value="${typed("contactPerson", customer?.name || "")}"
              >
            </div>

            <div class="hyve-dist__field">
              <label class="hyve-dist__label" for="dist-phone">Contact Phone Number</label>
              <input
                type="tel"
                id="dist-phone"
                name="contactPhone"
                class="hyve-dist__input"
                placeholder="e.g. +65 9123 4567"
                value="${typed("contactPhone", customer?.phone || "")}"
              >
            </div>
          </div>

          <!-- Right Column: Markets -->
          <div class="hyve-dist__col">
            <div class="hyve-dist__field">
              <label class="hyve-dist__label" for="dist-country">Country / Market Based In <span class="hyve-dist__req">*</span></label>
              <select id="dist-country" name="countryBased" class="hyve-dist__select" required>
                <option value="Singapore"${chosen("countryBased", "Singapore", true)}>Singapore</option>
                <option value="Malaysia"${chosen("countryBased", "Malaysia", false)}>Malaysia</option>
                <option value="Hong Kong"${chosen("countryBased", "Hong Kong", false)}>Hong Kong</option>
                <option value="Philippines"${chosen("countryBased", "Philippines", false)}>Philippines</option>
                <option value="Thailand"${chosen("countryBased", "Thailand", false)}>Thailand</option>
                <option value="Indonesia"${chosen("countryBased", "Indonesia", false)}>Indonesia</option>
                <option value="Vietnam"${chosen("countryBased", "Vietnam", false)}>Vietnam</option>
                <option value="Australia"${chosen("countryBased", "Australia", false)}>Australia</option>
                <option value="United States"${chosen("countryBased", "United States", false)}>United States</option>
                <option value="Other"${chosen("countryBased", "Other", false)}>Other</option>
              </select>
            </div>

            <div class="hyve-dist__field">
              <label class="hyve-dist__label" for="dist-business-type">Business Type <span class="hyve-dist__req">*</span></label>
              <select id="dist-business-type" name="businessType" class="hyve-dist__select" required>
                <option value="">Select…</option>
                  <option value="Distributor"${chosen("businessType", "Distributor")}>Distributor</option>
                  <option value="Wholesaler"${chosen("businessType", "Wholesaler")}>Wholesaler</option>
                  <option value="Marketing agency"${chosen("businessType", "Marketing agency")}>Marketing agency</option>
                  <option value="E-commerce retailer"${chosen("businessType", "E-commerce retailer")}>E-commerce retailer</option>
                  <option value="Stockist"${chosen("businessType", "Stockist")}>Stockist</option>
                  <option value="Drop-shipper"${chosen("businessType", "Drop-shipper")}>Drop-shipper</option>
                  <option value="Other"${chosen("businessType", "Other")}>Other</option>
              </select>
            </div>

            <div class="hyve-dist__field">
              <label class="hyve-dist__label" for="dist-relation">Your Relation to the Business <span class="hyve-dist__req">*</span></label>
              <select id="dist-relation" name="relationToBusiness" class="hyve-dist__select" required>
                <option value="">Select…</option>
                  <option value="Owner"${chosen("relationToBusiness", "Owner")}>Owner</option>
                  <option value="Management"${chosen("relationToBusiness", "Management")}>Management</option>
                  <option value="Executive"${chosen("relationToBusiness", "Executive")}>Executive</option>
                  <option value="Other"${chosen("relationToBusiness", "Other")}>Other</option>
              </select>
            </div>

            <div class="hyve-dist__field">
              <label class="hyve-dist__label" for="dist-currency">Preferred Currency <span class="hyve-dist__req">*</span></label>
              <select id="dist-currency" name="preferredCurrency" class="hyve-dist__select" required>
                ${(currencies || [])
                  .map((code) => `<option value="${esc(code)}"${chosen("preferredCurrency", code)}>${esc(code)}</option>`)
                  .join("")}
              </select>
            </div>

          </div>
        </div>

        <!-- Markets spans the card: eight pills read better on one row pair
             than squeezed into half the width, and it evens up the columns. -->
        <div class="hyve-dist__field hyve-dist__field--wide">
          <label class="hyve-dist__label">Markets You Sell Into <span class="hyve-dist__req">*</span> <span class="hyve-dist__opt">(Select all that apply)</span></label>
          <div class="hyve-dist__markets-grid hyve-dist__markets-grid--wide">
            ${renderMarketOption("Singapore", "SG", true, values?.markets ?? null)}
            ${renderMarketOption("Hong Kong", "HK", false, values?.markets ?? null)}
            ${renderMarketOption("Malaysia", "MY", false, values?.markets ?? null)}
            ${renderMarketOption("Philippines", "PH", false, values?.markets ?? null)}
            ${renderMarketOption("Thailand", "TH", false, values?.markets ?? null)}
            ${renderMarketOption("Indonesia", "ID", false, values?.markets ?? null)}
            ${renderMarketOption("Vietnam", "VN", false, values?.markets ?? null)}
            ${renderMarketOption("Other", "🌐", false, values?.markets ?? null)}
          </div>
        </div>

        <!-- Commercial Credit Terms Section -->
        <div class="hyve-dist__section-terms">
          <div class="hyve-dist__terms-header">
            <div class="hyve-dist__terms-text">
              <h3 class="hyve-dist__terms-title">Request Commercial / Credit Terms (Net 30/60)</h3>
              <p class="hyve-dist__terms-sub">Prepayment is standard. Enable this to request custom credit limits and billing accounts.</p>
            </div>
            <label class="hyve-dist__switch">
              <input type="checkbox" name="requestCredit" value="true" id="dist-credit-toggle"${values?.requestCredit ? " checked" : ""}>
              <span class="hyve-dist__switch-slider"></span>
            </label>
          </div>

          <!-- Credit Terms Subfields (Hidden by default) -->
          <div class="hyve-dist__grid-2 hyve-dist__credit-fields" id="dist-credit-fields" style="display: none;">
            <!-- Left Subcolumn -->
            <div class="hyve-dist__col">
              <div class="hyve-dist__field">
                <label class="hyve-dist__label" for="dist-uen">Business Registration Number (UEN) <span class="hyve-dist__req">*</span></label>
                <input
                  type="text"
                  id="dist-uen"
                  name="registrationNumber"
                  class="hyve-dist__input"
                  placeholder="e.g. 201912345G"
                  value="${typed("registrationNumber")}"
                >
              </div>

              <div class="hyve-dist__field">
                <label class="hyve-dist__label" for="dist-tax">Tax Registration Number <span class="hyve-dist__req">*</span></label>
                <input
                  type="text"
                  id="dist-tax"
                  name="taxRegistrationNumber"
                  class="hyve-dist__input"
                  placeholder="As shown on your tax certificate"
                  value="${typed("taxRegistrationNumber")}"
                >
              </div>

              <div class="hyve-dist__field">
                <label class="hyve-dist__label" for="dist-volume">Expected Annual Order Volume <span class="hyve-dist__req">*</span></label>
                <select id="dist-volume" name="expectedVolume" class="hyve-dist__select">
                  <option value="Under SGD 10,000"${chosen("expectedVolume", "Under SGD 10,000", false)}>Under SGD 10,000</option>
                  <option value="SGD 10,000 - SGD 50,000"${chosen("expectedVolume", "SGD 10,000 - SGD 50,000", true)}>SGD 10,000 - SGD 50,000</option>
                  <option value="SGD 50,000 - SGD 200,000"${chosen("expectedVolume", "SGD 50,000 - SGD 200,000", false)}>SGD 50,000 - SGD 200,000</option>
                  <option value="SGD 200,000+"${chosen("expectedVolume", "SGD 200,000+", false)}>SGD 200,000+</option>
                </select>
              </div>

              <div class="hyve-dist__field">
                <label class="hyve-dist__label" for="dist-address">Registered Business Address <span class="hyve-dist__req">*</span></label>
                <textarea
                  id="dist-address"
                  name="registeredAddress"
                  class="hyve-dist__textarea"
                  rows="3"
                  placeholder="Enter company's registered business address"
                >${typed("registeredAddress")}</textarea>
              </div>
            </div>

            <!-- Right Subcolumn: File Upload -->
            <div class="hyve-dist__col">
              <div class="hyve-dist__field">
                <label class="hyve-dist__label">Upload Business Registration Profile <span class="hyve-dist__opt">(ACRA / Bizfile or country equivalent)</span></label>
                <div class="hyve-dist__dropzone" id="dist-dropzone">
                  <input type="file" name="registrationDoc" id="dist-file-input" class="hyve-dist__file-input" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx">
                  <div class="hyve-dist__dropzone-content">
                    <span class="hyve-dist__dropzone-icon">${icoCloudUpload()}</span>
                    <span class="hyve-dist__dropzone-text" id="dist-dropzone-label">Drag &amp; Drop profile doc</span>
                    <span class="hyve-dist__dropzone-sub">or click to browse. Max 10MB (PDF, PNG, JPG)</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Form Footer Actions -->
        <div class="hyve-dist__actions">
          <a href="/apps/account/orders" class="hyve-dist__btn hyve-dist__btn--ghost">Cancel</a>
          <button type="submit" class="hyve-dist__btn hyve-dist__btn--submit" id="dist-submit-btn">
            ${icoSend()}
            <span>Submit Application</span>
          </button>
        </div>
      </form>
    </div>
    ${DISTRIBUTOR_SCRIPT}`;
}

/**
 * Render Market checkbox option pill matching the screenshot.
 */
/**
 * @param {string[]|null} [picked] the markets the applicant chose, when a failed
 *   submission is being shown again. Null means this is a fresh form.
 */
function renderMarketOption(name, code, isDefault = false, picked = null) {
  const isEmoji = code.length > 2;
  const badgeContent = isEmoji ? code : `<span>${esc(code)}</span>`;
  const checked = picked ? picked.includes(name) : isDefault;

  return `
    <label class="hyve-dist__market-pill${checked ? " is-checked" : ""}">
      <input type="checkbox" name="markets" value="${esc(name)}" ${checked ? "checked" : ""}>
      <span class="hyve-dist__market-code">${badgeContent}</span>
      <span class="hyve-dist__market-name">${esc(name)}</span>
      <span class="hyve-dist__market-check">${icoCheck()}</span>
    </label>`;
}

/**
 * Render the professional "Application Received & Under Review" state matching the exact UI design.
 */
function renderExistingApplicationView(app, customer) {
  const status = app.status || "Pending Review";
  const isApproved = status.toLowerCase() === "approved";
  const isRejected = status.toLowerCase() === "rejected";

  const contactName =
    app.contact_person ||
    customer?.name ||
    customer?.displayName ||
    (customer?.firstName ? `${customer.firstName} ${customer.lastName || ""}`.trim() : "") ||
    "Sarah Mitchell";

  const companyName = app.company_name || customer?.company || "Shopify Test";
  const website = app.company_website || "";
  let websiteUrl = website;
  if (website && !website.startsWith("http://") && !website.startsWith("https://")) {
    websiteUrl = "https://" + website;
  }

  const operatingRegion = app.country_based || app.markets_sold || "Singapore";
  const termsRequested =
    (app.request_credit === "true" || app.request_credit === true)
      ? "Net 30 terms requested"
      : "Prepayment only";

  // Banner states
  let bannerTitle = "Application Pending Evaluation";
  let badgeText = "Under Review";
  let bannerIcon = `
    <svg class="hyve-dist__eval-banner-icon" viewBox="0 0 24 24" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>`;
  let badgeIcon = `
    <svg class="hyve-dist__eval-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"></circle>
      <polyline points="12 7 12 12 15 15"></polyline>
    </svg>`;

  // Stepper state classes
  let step1Class = "hyve-dist__step--done";
  let line1Class = "hyve-dist__step-line--done";
  let step2Class = "hyve-dist__step--active";
  let line2Class = "";
  let step3Class = "hyve-dist__step--upcoming";

  let mainTitle = "We are evaluating your distributor profile!";
  let mainDescription = `Thanks for applying, <strong>${esc(contactName)}</strong>! Our Head of Customer Service, <strong>Bruce</strong>, manages application vetting. We have committed to a <strong>7 business days Review SLA</strong> and are checking your credentials.`;

  if (isApproved) {
    bannerTitle = "Application Approved & Activated";
    badgeText = "Activated";
    bannerIcon = `
      <svg class="hyve-dist__eval-banner-icon" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>`;
    badgeIcon = `
      <svg class="hyve-dist__eval-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>`;
    step1Class = "hyve-dist__step--done";
    line1Class = "hyve-dist__step-line--done";
    step2Class = "hyve-dist__step--done";
    line2Class = "hyve-dist__step-line--done";
    step3Class = "hyve-dist__step--done";
    mainTitle = "Your distributor profile is officially active!";
    mainDescription = `Congratulations, <strong>${esc(contactName)}</strong>! You now have full access to wholesale pricing and distributor commercial terms.`;
  } else if (isRejected) {
    bannerTitle = "Application Decision: Declined";
    badgeText = "Declined";
    bannerIcon = `
      <svg class="hyve-dist__eval-banner-icon" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>`;
    step1Class = "hyve-dist__step--done";
    line1Class = "hyve-dist__step-line--danger";
    step2Class = "hyve-dist__step--danger";
    line2Class = "";
    step3Class = "hyve-dist__step--upcoming";
    mainTitle = "Distributor Application Status Update";
    mainDescription = `Thank you for applying, <strong>${esc(contactName)}</strong>. At this time, we are unable to approve your distributor application. If you have questions, please reach out to our team.`;
  }

  return `
    <div class="hyve-dist__eval-container">
      <!-- Top Banner -->
      <div class="hyve-dist__eval-banner${isApproved ? " hyve-dist__eval-banner--approved" : isRejected ? " hyve-dist__eval-banner--rejected" : ""}">
        <div class="hyve-dist__eval-banner-left">
          ${bannerIcon}
          <span class="hyve-dist__eval-banner-title">${esc(bannerTitle)}</span>
        </div>
        <div class="hyve-dist__eval-badge${isApproved ? " hyve-dist__eval-badge--approved" : isRejected ? " hyve-dist__eval-badge--rejected" : ""}">
          ${badgeIcon}
          <span>${esc(badgeText)}</span>
        </div>
      </div>

      <!-- Card Body -->
      <div class="hyve-dist__eval-body">
        <!-- Progress Stepper -->
        <div class="hyve-dist__stepper">
          <!-- Step 1: Submitted -->
          <div class="hyve-dist__step ${step1Class}">
            <div class="hyve-dist__step-circle">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <span class="hyve-dist__step-label">Submitted</span>
          </div>

          <div class="hyve-dist__step-line ${line1Class}"></div>

          <!-- Step 2: Reviewing -->
          <div class="hyve-dist__step ${step2Class}">
            <div class="hyve-dist__step-circle">
              ${isApproved ? `
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              ` : `
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              `}
            </div>
            <span class="hyve-dist__step-label">Reviewing</span>
          </div>

          <div class="hyve-dist__step-line ${line2Class}"></div>

          <!-- Step 3: Activated -->
          <div class="hyve-dist__step ${step3Class}">
            <div class="hyve-dist__step-circle">
              ${isApproved ? `
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              ` : `
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="8" r="6"></circle>
                  <path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"></path>
                </svg>
              `}
            </div>
            <span class="hyve-dist__step-label">Activated</span>
          </div>
        </div>

        <!-- Headline & Subtitle -->
        <h2 class="hyve-dist__eval-title">${esc(mainTitle)}</h2>
        <p class="hyve-dist__eval-desc">${mainDescription}</p>

        <!-- Rejection Feedback Box if Declined -->
        ${isRejected ? `
          <div class="hyve-dist__rejection-banner">
            <div class="hyve-dist__rejection-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <div class="hyve-dist__rejection-content">
              <span class="hyve-dist__rejection-title">Application Review Feedback</span>
              <p class="hyve-dist__rejection-text">${esc(app.rejection_message || "Thank you for applying. At this time, your distributor profile does not meet our minimum commercial requirements.")}</p>
            </div>
          </div>
        ` : ""}

        <!-- Nested Details Card -->
        <div class="hyve-dist__eval-card">
          <div class="hyve-dist__eval-grid">
            <div class="hyve-dist__eval-item">
              <span class="hyve-dist__eval-label">COMPANY NAME</span>
              <span class="hyve-dist__eval-val">${esc(companyName)}</span>
            </div>

            <div class="hyve-dist__eval-item">
              <span class="hyve-dist__eval-label">WEBSITE</span>
              <span class="hyve-dist__eval-val">
                ${website ? `<a href="${esc(websiteUrl)}" target="_blank" rel="noopener" class="hyve-dist__eval-website">${esc(website)}</a>` : '<span style="color:#94a3b8;">—</span>'}
              </span>
            </div>

            <div class="hyve-dist__eval-item">
              <span class="hyve-dist__eval-label">OPERATING REGION</span>
              <span class="hyve-dist__eval-val">${esc(operatingRegion)}</span>
            </div>

            <div class="hyve-dist__eval-item">
              <span class="hyve-dist__eval-label">COMMERCIAL TERMS REQUESTED</span>
              <span class="hyve-dist__eval-val">${esc(termsRequested)}</span>
            </div>

            ${app.registration_document_url ? `
              <div class="hyve-dist__eval-item" style="grid-column: 1 / -1; padding-top: 10px; border-top: 1px dashed #e2e8f0;">
                <span class="hyve-dist__eval-label">BUSINESS REGISTRATION PROFILE</span>
                <span class="hyve-dist__eval-val">
                  <a href="${esc(app.registration_document_url)}" target="_blank" rel="noopener" class="hyve-dist__eval-website">
                    📄 ${esc(app.registration_document_name || "View Uploaded Document")} ↗
                  </a>
                </span>
              </div>
            ` : ""}
          </div>
        </div>

        <div class="hyve-dist__eval-foot">
          <a href="/apps/account/orders" class="hyve-dist__eval-back">&larr; Return to Orders</a>
        </div>
      </div>
    </div>`;
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
    <div class="hyve-dist__toast hyve-dist__toast--${tone}" role="status">
      <span class="hyve-dist__toast-icon">${icon}</span>
      <span class="hyve-dist__toast-msg">${esc(msg)}</span>
      <button type="button" class="hyve-dist__toast-close" onclick="this.parentElement.remove()" aria-label="Dismiss">
        ${icoClose()}
      </button>
    </div>`;
}

/* ---------- SVG Icons ---------- */
function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function icoBuilding() {
  return svg('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>');
}

function icoShieldCheck() {
  return svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>');
}

function icoCheck() {
  return svg('<polyline points="20 6 9 17 4 12"/>');
}

function icoCheckCircle() {
  return svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>');
}

// eslint-disable-next-line no-unused-vars -- part of the page's signature; callers pass it
function icoClock() {
  return svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>');
}

function icoAlert() {
  return svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>');
}

function icoCloudUpload() {
  return svg('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="12 12 12 16 12 12"/><polyline points="9 14 12 11 15 14"/>');
}

function icoSend() {
  return svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>');
}

function icoClose() {
  return svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
}

/* ---------- Styles ---------- */
const DISTRIBUTOR_STYLES = `
<style>
  .hyve-dist {
    --dist-fg: #0f172a;
    --dist-sub: #64748b;
    --dist-muted: #94A3B8;
    --dist-line: #e2e8f0;
    --dist-brand-green: #a3ea6e;
    --dist-brand-teal: #6ee7b7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--dist-fg);
    max-width: 100%;
    margin: 0 auto;
  }

  /* Header */
  .hyve-dist__header {
    margin-bottom: 18px;
  }
  .hyve-dist__title {
    font-size: 22px;
    font-weight: 800;
    color: var(--dist-fg);
    letter-spacing: -0.02em;
    margin: 0 0 4px;
  }
  .hyve-dist__sub {
    font-size: 13.5px;
    color: var(--dist-sub);
    margin: 0;
  }

  /* Top Promo Banner */
  .hyve-dist__promo-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    background: linear-gradient(135deg, rgba(163, 234, 110, 0.16) 0%, rgba(110, 222, 225, 0.14) 100%);
    border: 1px solid #bbf7d0;
    border-radius: 12px;
    padding: 12px 18px;
    margin-bottom: 22px;
  }
  .hyve-dist__promo-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #dcfce7;
    color: #15803d;
    flex-shrink: 0;
  }
  .hyve-dist__promo-icon svg {
    width: 18px;
    height: 18px;
  }
  .hyve-dist__promo-text {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 13px;
    color: #14532d;
  }
  .hyve-dist__promo-text strong {
    font-weight: 700;
    color: #0f172a;
  }
  .hyve-dist__promo-text span {
    font-size: 11.5px;
    color: #64748b;
  }

  /* Main Form Card */
  .hyve-dist__form-card {
    background: #ffffff;
    border: 1px solid var(--dist-line);
    border-radius: 14px;
    padding: 24px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
  }

  /* Card Header */
  .hyve-dist__card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 22px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--dist-line);
  }
  .hyve-dist__card-title-group {
    display: flex;
    align-items: center;
    gap: 8.5px;
  }
  .hyve-dist__card-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #0f172a;
  }
  .hyve-dist__card-icon svg {
    width: 20px;
    height: 20px;
  }
  .hyve-dist__card-title {
    font-size: 15.5px;
    font-weight: 800;
    margin: 0;
    color: var(--dist-fg);
  }
  .hyve-dist__step-badge {
    background: #f8fafc;
    border: 1px solid var(--dist-line);
    color: var(--dist-sub);
    font-size: 11.5px;
    font-weight: 700;
    padding: 3.5px 9px;
    border-radius: 999px;
  }

  /* Grids */
  .hyve-dist__grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }
  .hyve-dist__col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* Fields */
  .hyve-dist__field {
    display: flex;
    flex-direction: column;
    gap: 5.5px;
  }
  .hyve-dist__label {
    font-size: 12.5px;
    font-weight: 700;
    color: #334155;
  }
  .hyve-dist__req {
    color: #ef4444;
  }
  .hyve-dist__opt {
    font-size: 11px;
    font-weight: 400;
    color: var(--dist-muted);
  }
  .hyve-dist__input,
  .hyve-dist__select,
  .hyve-dist__textarea {
    width: 100%;
    padding: 9px 13px;
    border: 1px solid var(--dist-line);
    border-radius: 8.5px;
    font-size: 13.5px;
    font-family: inherit;
    color: var(--dist-fg);
    background: #ffffff;
    box-sizing: border-box;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .hyve-dist__input:focus,
  .hyve-dist__select:focus,
  .hyve-dist__textarea:focus {
    outline: none;
    border-color: #0f172a;
    box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.08);
  }

  /* Markets Grid Selection Pills */
  .hyve-dist__markets-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  /* Spanning the card, so the eight pills sit four across instead of stacking. */
  .hyve-dist__markets-grid--wide {
    grid-template-columns: repeat(4, 1fr);
  }
  .hyve-dist__field--wide {
    margin-top: 4px;
  }
  @media (max-width: 900px) {
    .hyve-dist__markets-grid--wide {
      grid-template-columns: 1fr 1fr;
    }
  }
  .hyve-dist__market-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 11px;
    border: 1px solid var(--dist-line);
    border-radius: 8.5px;
    background: #ffffff;
    cursor: pointer;
    user-select: none;
    transition: all 0.15s ease;
  }
  .hyve-dist__market-pill input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .hyve-dist__market-code {
    font-size: 11.5px;
    font-weight: 800;
    color: var(--dist-sub);
    background: #f1f5f9;
    padding: 2px 5px;
    border-radius: 4px;
    min-width: 22px;
    text-align: center;
  }
  .hyve-dist__market-name {
    flex: 1;
    font-size: 12.5px;
    font-weight: 600;
    color: #334155;
  }
  .hyve-dist__market-check {
    width: 18px;
    height: 18px;
    border: 1px solid var(--dist-line);
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: transparent;
    transition: all 0.15s ease;
  }
  .hyve-dist__market-check svg {
    width: 12px;
    height: 12px;
    stroke-width: 3;
  }
  .hyve-dist__market-pill.is-checked {
    border-color: #86efac;
    background: #f7fee7;
  }
  .hyve-dist__market-pill.is-checked .hyve-dist__market-code {
    background: #dcfce7;
    color: #15803d;
  }
  .hyve-dist__market-pill.is-checked .hyve-dist__market-name {
    color: #0f172a;
    font-weight: 700;
  }
  .hyve-dist__market-pill.is-checked .hyve-dist__market-check {
    background: #16a34a;
    border-color: #16a34a;
    color: #ffffff;
  }

  /* Commercial Credit Terms Section */
  .hyve-dist__section-terms {
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid var(--dist-line);
  }
  .hyve-dist__terms-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 20px;
  }
  .hyve-dist__terms-title {
    font-size: 14.5px;
    font-weight: 800;
    margin: 0 0 3px;
    color: var(--dist-fg);
  }
  .hyve-dist__terms-sub {
    font-size: 12.5px;
    color: var(--dist-sub);
    margin: 0;
  }

  /* Toggle Switch */
  .hyve-dist__switch {
    position: relative;
    display: inline-block;
    width: 46px;
    height: 26px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .hyve-dist__switch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .hyve-dist__switch-slider {
    position: absolute;
    inset: 0;
    background-color: #cbd5e1;
    border-radius: 999px;
    transition: background-color 0.25s ease;
  }
  .hyve-dist__switch-slider::before {
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
  .hyve-dist__switch input:checked + .hyve-dist__switch-slider {
    background: linear-gradient(135deg, #a3ea6e, #4ade80);
  }
  .hyve-dist__switch input:checked + .hyve-dist__switch-slider::before {
    transform: translateX(20px);
  }

  /* Upload Dropzone */
  .hyve-dist__dropzone {
    position: relative;
    border: 1.5px dashed #cbd5e1;
    border-radius: 12px;
    background: #f8fafc;
    padding: 34px 20px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s ease;
    min-height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hyve-dist__dropzone:hover {
    border-color: #94a3b8;
    background: #f1f5f9;
  }
  .hyve-dist__file-input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    width: 100%;
    height: 100%;
  }
  .hyve-dist__dropzone-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
  }
  .hyve-dist__dropzone-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
  }
  .hyve-dist__dropzone-icon svg {
    width: 32px;
    height: 32px;
    stroke-width: 1.8;
  }
  .hyve-dist__dropzone-text {
    font-size: 13.5px;
    font-weight: 700;
    color: #334155;
  }
  .hyve-dist__dropzone-sub {
    font-size: 11.5px;
    color: var(--dist-muted);
  }

  /* Actions */
  .hyve-dist__actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 28px;
    padding-top: 18px;
    border-top: 1px solid var(--dist-line);
  }
  .hyve-dist__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7.5px;
    padding: 9.5px 20px;
    border-radius: 8.5px;
    font-size: 13.5px;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s ease;
  }
  .hyve-dist__btn svg {
    width: 16px;
    height: 16px;
  }
  .hyve-dist__btn--ghost {
    background: #ffffff;
    border: 1px solid var(--dist-line);
    color: #475569;
  }
  .hyve-dist__btn--ghost:hover {
    background: #f8fafc;
    border-color: #cbd5e1;
    color: var(--dist-fg);
  }
  .hyve-dist__btn--submit {
    background: linear-gradient(135deg, #a3ea6e 0%, #6ee7b7 100%);
    border: 1px solid transparent;
    color: #0a1414;
    box-shadow: 0 2px 6px rgba(110, 231, 183, 0.25);
  }
  .hyve-dist__btn--submit:hover {
    filter: brightness(0.96);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(110, 231, 183, 0.35);
  }

  /* Evaluation State View (matching exact design) */
  .hyve-dist__eval-container {
    background: #ffffff;
    border: 1px solid #fed7aa;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 4px 20px -2px rgba(234, 88, 12, 0.04);
    margin: 0 auto;
    max-width: 980px;
    animation: hyveFadeIn 0.3s ease;
  }

  .hyve-dist__eval-banner {
    background: #fffdf5;
    border-bottom: 1px solid #fef08a;
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .hyve-dist__eval-banner--approved {
    background: #f0fdf4;
    border-bottom-color: #bbf7d0;
  }
  .hyve-dist__eval-banner--rejected {
    background: #fef2f2;
    border-bottom-color: #fecaca;
  }

  .hyve-dist__eval-banner-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .hyve-dist__eval-banner-icon {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }
  .hyve-dist__eval-banner-title {
    font-size: 15px;
    font-weight: 700;
    color: #c2410c;
    letter-spacing: -0.01em;
  }
  .hyve-dist__eval-banner--approved .hyve-dist__eval-banner-title {
    color: #15803d;
  }
  .hyve-dist__eval-banner--rejected .hyve-dist__eval-banner-title {
    color: #b91c1c;
  }

  .hyve-dist__eval-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #fef3c7;
    color: #b45309;
    font-size: 12.5px;
    font-weight: 700;
    padding: 4.5px 13px;
    border-radius: 999px;
    border: 1px solid #fde68a;
    white-space: nowrap;
  }
  .hyve-dist__eval-badge svg {
    width: 13px;
    height: 13px;
  }
  .hyve-dist__eval-badge--approved {
    background: #dcfce7;
    color: #15803d;
    border-color: #bbf7d0;
  }
  .hyve-dist__eval-badge--rejected {
    background: #fee2e2;
    color: #b91c1c;
    border-color: #fecaca;
  }

  .hyve-dist__eval-body {
    padding: 44px 32px 52px;
    text-align: center;
    background: #ffffff;
  }

  /* Stepper Progress Bar */
  .hyve-dist__stepper {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    max-width: 460px;
    margin: 0 auto 36px;
    padding: 0 12px;
  }
  .hyve-dist__step {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    width: 84px;
    flex-shrink: 0;
  }
  .hyve-dist__step-circle {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }
  .hyve-dist__step--done .hyve-dist__step-circle {
    background: #10b981;
    color: #ffffff;
  }
  .hyve-dist__step--active .hyve-dist__step-circle {
    background: #f59e0b;
    color: #ffffff;
    box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.16);
  }
  .hyve-dist__step--upcoming .hyve-dist__step-circle {
    background: #ffffff;
    border: 2px solid #cbd5e1;
    color: #94a3b8;
  }
  .hyve-dist__step--danger .hyve-dist__step-circle {
    background: #ef4444;
    color: #ffffff;
  }

  .hyve-dist__step-label {
    font-size: 12.5px;
    margin-top: 8px;
    white-space: nowrap;
    letter-spacing: -0.01em;
  }
  .hyve-dist__step--done .hyve-dist__step-label {
    color: #0f172a;
    font-weight: 700;
  }
  .hyve-dist__step--active .hyve-dist__step-label {
    color: #d97706;
    font-weight: 700;
  }
  .hyve-dist__step--upcoming .hyve-dist__step-label {
    color: #94a3b8;
    font-weight: 600;
  }
  .hyve-dist__step--danger .hyve-dist__step-label {
    color: #ef4444;
    font-weight: 700;
  }

  .hyve-dist__step-line {
    flex: 1;
    height: 3px;
    background: #e2e8f0;
    margin-top: 17px;
    border-radius: 2px;
  }
  .hyve-dist__step-line--done {
    background: #f59e0b;
  }
  .hyve-dist__step-line--danger {
    background: #ef4444;
  }

  /* Headline & Subtitle */
  .hyve-dist__eval-title {
    font-size: 24px;
    font-weight: 800;
    color: #0f172a;
    margin: 0 0 12px;
    letter-spacing: -0.02em;
    text-align: center;
  }
  .hyve-dist__eval-desc {
    font-size: 14.5px;
    color: #475569;
    line-height: 1.6;
    max-width: 600px;
    margin: 0 auto 36px;
    text-align: center;
  }
  .hyve-dist__eval-desc strong {
    color: #0f172a;
    font-weight: 700;
  }

  /* Rejection Feedback Box */
  .hyve-dist__rejection-banner {
    max-width: 620px;
    margin: 0 auto 30px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 12px;
    padding: 16px 20px;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    text-align: left;
    box-shadow: 0 1px 3px rgba(239, 68, 68, 0.05);
  }
  .hyve-dist__rejection-icon {
    flex-shrink: 0;
    margin-top: 2px;
  }
  .hyve-dist__rejection-title {
    display: block;
    font-size: 13.5px;
    font-weight: 800;
    color: #991b1b;
    margin-bottom: 4px;
  }
  .hyve-dist__rejection-text {
    font-size: 13px;
    color: #7f1d1d;
    line-height: 1.5;
    margin: 0;
  }

  /* Nested Evaluation Details Card */
  .hyve-dist__eval-card {
    max-width: 620px;
    margin: 0 auto;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 14px;
    padding: 22px 26px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
    text-align: left;
  }
  .hyve-dist__eval-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px 32px;
  }
  .hyve-dist__eval-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .hyve-dist__eval-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #94a3b8;
  }
  .hyve-dist__eval-val {
    font-size: 14.5px;
    font-weight: 700;
    color: #0f172a;
    word-break: break-word;
  }
  .hyve-dist__eval-website {
    color: #0284c7;
    font-weight: 700;
    text-decoration: none;
    word-break: break-all;
  }
  .hyve-dist__eval-website:hover {
    text-decoration: underline;
    color: #0369a1;
  }
  .hyve-dist__eval-foot {
    margin-top: 32px;
    text-align: center;
  }
  .hyve-dist__eval-back {
    display: inline-block;
    color: #64748b;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    transition: color 0.15s ease;
  }
  .hyve-dist__eval-back:hover {
    color: #0f172a;
    text-decoration: underline;
  }

  /* Responsive styling */
  @media (max-width: 640px) {
    .hyve-dist__eval-body {
      padding: 30px 16px 40px;
    }
    .hyve-dist__eval-banner {
      padding: 12px 16px;
    }
    .hyve-dist__eval-banner-title {
      font-size: 13.5px;
    }
    .hyve-dist__eval-badge {
      font-size: 11.5px;
      padding: 3.5px 10px;
    }
    .hyve-dist__eval-title {
      font-size: 20px;
    }
    .hyve-dist__eval-desc {
      font-size: 13.5px;
      margin-bottom: 28px;
    }
    .hyve-dist__eval-card {
      padding: 18px 18px;
    }
    .hyve-dist__eval-grid {
      grid-template-columns: 1fr;
      gap: 16px;
    }
    .hyve-dist__stepper {
      max-width: 100%;
      padding: 0;
    }
    .hyve-dist__step {
      width: 70px;
    }
    .hyve-dist__step-circle {
      width: 32px;
      height: 32px;
    }
    .hyve-dist__step-line {
      margin-top: 15px;
    }
    .hyve-dist__step-label {
      font-size: 11.5px;
    }
  }

  /* Toasts */
  .hyve-dist__toast {
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
  .hyve-dist__toast--success {
    background: #ecfdf3;
    color: #15803d;
    border: 1px solid #bbf7d0;
  }
  .hyve-dist__toast--error {
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
  }
  .hyve-dist__toast-icon svg {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
  .hyve-dist__toast-msg {
    flex: 1;
  }
  .hyve-dist__toast-close {
    background: transparent;
    border: 0;
    cursor: pointer;
    color: inherit;
    opacity: 0.7;
    padding: 2px;
  }

  /* Responsive Breakpoints */
  @media (max-width: 960px) {
    .hyve-dist__grid-2 {
      grid-template-columns: 1fr;
      gap: 18px;
    }
    .hyve-dist__summary-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 640px) {
    .hyve-dist__form-card {
      padding: 18px 14px;
    }
    .hyve-dist__header {
      margin-bottom: 14px;
    }
    .hyve-dist__title {
      font-size: 19px;
    }
    .hyve-dist__sub {
      font-size: 12.5px;
    }
    .hyve-dist__card-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
    .hyve-dist__markets-grid,
    .hyve-dist__markets-grid--wide {
      grid-template-columns: 1fr;
    }
    .hyve-dist__terms-header {
      flex-direction: column;
      align-items: flex-start;
    }
    .hyve-dist__dropzone {
      min-height: 160px;
      padding: 24px 14px;
    }
    .hyve-dist__actions {
      flex-direction: column-reverse;
      gap: 8px;
    }
    .hyve-dist__btn {
      width: 100%;
    }
    .hyve-dist__summary-card {
      padding: 18px 14px;
    }
    .hyve-dist__summary-foot {
      flex-direction: column;
      align-items: stretch;
    }
  }

  @keyframes hyveFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>`;

/* ---------- Client Script ---------- */
const DISTRIBUTOR_SCRIPT = `
<script>
(() => {
  const form = document.getElementById('hyve-distributor-form');
  const submitBtn = document.getElementById('dist-submit-btn');
  const creditToggle = document.getElementById('dist-credit-toggle');
  const creditFields = document.getElementById('dist-credit-fields');
  const fileInput = document.getElementById('dist-file-input');
  const dropzoneLabel = document.getElementById('dist-dropzone-label');
  const marketPills = document.querySelectorAll('.hyve-dist__market-pill');

  // Toggle market pills visual checked state
  marketPills.forEach(pill => {
    const checkbox = pill.querySelector('input[type="checkbox"]');
    if (checkbox) {
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          pill.classList.add('is-checked');
        } else {
          pill.classList.remove('is-checked');
        }
      });
    }
  });

  // Toggle credit fields visibility
  if (creditToggle && creditFields) {
    creditToggle.addEventListener('change', () => {
      if (creditToggle.checked) {
        creditFields.style.display = 'grid';
      } else {
        creditFields.style.display = 'none';
      }
    });
  }

  // File upload display filename & drag-drop handling
  const dropzone = document.getElementById('dist-dropzone');
  if (fileInput && dropzoneLabel) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        dropzoneLabel.textContent = 'Selected: ' + fileInput.files[0].name;
      }
    });
  }

  if (dropzone && fileInput) {
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '#0f172a';
        dropzone.style.background = '#f1f5f9';
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '#cbd5e1';
        dropzone.style.background = '#f8fafc';
      });
    });
    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        if (dropzoneLabel) {
          dropzoneLabel.textContent = 'Selected: ' + e.dataTransfer.files[0].name;
        }
      }
    });
  }

  // Form submission loading state
  if (form && submitBtn) {
    form.addEventListener('submit', () => {
      setTimeout(() => {
        submitBtn.disabled = true;
        const span = submitBtn.querySelector('span');
        if (span) span.textContent = 'Submitting...';
      }, 0);
    });
  }

  // Auto-dismiss toast
  const toast = document.querySelector('.hyve-dist__toast');
  if (toast) {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.5s ease';
      setTimeout(() => toast.remove(), 500);
    }, 4500);
  }
})();
</script>`;
