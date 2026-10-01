
import { esc } from "./account-shell.server";
import { State } from "country-state-city";

const DISTRIBUTOR_COUNTRIES = [
  { name: "Singapore", code: "SG" },
  { name: "Malaysia", code: "MY" },
  { name: "Hong Kong", code: "HK" },
  { name: "Philippines", code: "PH" },
  { name: "Thailand", code: "TH" },
  { name: "Indonesia", code: "ID" },
  { name: "Vietnam", code: "VN" },
  { name: "China", code: "CN" },
];


const DISTRIBUTOR_STATES = Object.fromEntries(
  DISTRIBUTOR_COUNTRIES.map((country) => {
    const states = State.getStatesOfCountry(country.code) || [];

    return [
      country.name,
      states.length
        ? states.map((state) => ({
            name: state.name,
            code: state.isoCode || country.code,
          }))
        : [
            {
              name: country.name,
              code: country.code,
            },
          ],
    ];
  }),
);


export function distributorPage({
  customer = null,
  application = null,
  notice = null,
  error = null,
  values = null,
  currencies = [],
  fieldErrors = {},
} = {}) {
  const isCreditRequired = Boolean(values?.requestCredit);

  const typed = (field, fallback = "") => esc(values?.[field] ?? fallback);

  const registeredAddress =
    values?.registeredAddress &&
    typeof values.registeredAddress === "object" &&
    !Array.isArray(values.registeredAddress)
      ? values.registeredAddress
      : {};

  const addressValue = (field) => esc(registeredAddress?.[field] ?? "");

  const addressSelected = (field, option) =>
    String(registeredAddress?.[field] ?? "") === String(option)
      ? " selected"
      : "";

  const fieldError = (field) => esc(fieldErrors?.[field] || "");
  const addressError = (field) =>
    esc(fieldErrors?.[`registeredAddress.${field}`] || "");

  const chosen = (field, option, fallback = false) =>
    (values?.[field] != null ? values[field] === option : fallback)
      ? " selected"
      : "";

  const currencyChoice = (code) =>
    values?.preferredCurrency != null
      ? chosen("preferredCurrency", code)
      : `{% if cart.currency.iso_code == '${String(code).replace(
          /[^A-Z]/g,
          "",
        )}' %} selected{% endif %}`;

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
        <h1 class="hyve-dist__title">
          Apply for Distributor Portal
        </h1>

        <p class="hyve-dist__sub">
          Join the Hyve distributor network for commercial
          payment terms and exclusive tier pricing.
        </p>
      </header>

      <!-- Main Form Card -->

      <form
        method="POST"
        action="/apps/account/distributor"
        enctype="multipart/form-data"
        class="hyve-dist__form-card"
        id="hyve-distributor-form"
      >

        <input
          type="hidden"
          name="intent"
          value="applyDistributor"
        >

        <div class="hyve-dist__card-header">

          <div class="hyve-dist__card-title-group">

            <span class="hyve-dist__card-icon">
              ${icoBuilding()}
            </span>

            <h2 class="hyve-dist__card-title">
              Company Information &amp; Operating Details
            </h2>

          </div>

        </div>

        <div class="hyve-dist__grid-2">

          <!-- Left Column -->

          <div class="hyve-dist__col">

            <div class="hyve-dist__field">

              <label
                class="hyve-dist__label"
                for="dist-company"
              >
                Company Legal Name
                <span class="hyve-dist__req">*</span>
              </label>

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

              <label
                class="hyve-dist__label"
                for="dist-website"
              >
                Company Website
                <span class="hyve-dist__req">*</span>
              </label>

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

              <label
                class="hyve-dist__label"
                for="dist-contact"
              >
                Primary Contact Person
              </label>

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

              <label
                class="hyve-dist__label"
                for="dist-phone"
              >
                Contact Phone Number
              </label>

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

          <!-- Right Column -->

          <div class="hyve-dist__col">

            <div class="hyve-dist__field">

              <label
                class="hyve-dist__label"
                for="dist-country"
              >
                Country / Market Based In
                <span class="hyve-dist__req">*</span>
              </label>

              <select
                id="dist-country"
                name="countryBased"
                class="hyve-dist__select"
                required
              >

                <option
                  value="Singapore"
                  ${chosen("countryBased", "Singapore", true)}
                >
                  Singapore
                </option>

                <option
                  value="Malaysia"
                  ${chosen("countryBased", "Malaysia", false)}
                >
                  Malaysia
                </option>

                <option
                  value="Hong Kong"
                  ${chosen("countryBased", "Hong Kong", false)}
                >
                  Hong Kong
                </option>

                <option
                  value="Philippines"
                  ${chosen("countryBased", "Philippines", false)}
                >
                  Philippines
                </option>

                <option
                  value="Thailand"
                  ${chosen("countryBased", "Thailand", false)}
                >
                  Thailand
                </option>

                <option
                  value="Indonesia"
                  ${chosen("countryBased", "Indonesia", false)}
                >
                  Indonesia
                </option>

                <option
                  value="Vietnam"
                  ${chosen("countryBased", "Vietnam", false)}
                >
                  Vietnam
                </option>

                <option
                  value="China"
                  ${chosen("countryBased", "China", false)}
                >
                  China
                </option>

                <option
                  value="Other"
                  ${chosen("countryBased", "Other", false)}
                >
                  Other
                </option>

              </select>

            </div>

            <div class="hyve-dist__field">

              <label
                class="hyve-dist__label"
                for="dist-business-type"
              >
                Business Type
                <span class="hyve-dist__req">*</span>
              </label>

              <select
                id="dist-business-type"
                name="businessType"
                class="hyve-dist__select"
                required
              >

                <option value="">
                  Select…
                </option>

                <option
                  value="Distributor"
                  ${chosen("businessType", "Distributor")}
                >
                  Distributor
                </option>

                <option
                  value="Wholesaler"
                  ${chosen("businessType", "Wholesaler")}
                >
                  Wholesaler
                </option>

                <option
                  value="Marketing agency"
                  ${chosen("businessType", "Marketing agency")}
                >
                  Marketing agency
                </option>

                <option
                  value="E-commerce retailer"
                  ${chosen("businessType", "E-commerce retailer")}
                >
                  E-commerce retailer
                </option>

                <option
                  value="Stockist"
                  ${chosen("businessType", "Stockist")}
                >
                  Stockist
                </option>

                <option
                  value="Drop-shipper"
                  ${chosen("businessType", "Drop-shipper")}
                >
                  Drop-shipper
                </option>

                <option
                  value="Other"
                  ${chosen("businessType", "Other")}
                >
                  Other
                </option>

              </select>

            </div>

            <div class="hyve-dist__field">

              <label
                class="hyve-dist__label"
                for="dist-relation"
              >
                Your Relation to the Business
                <span class="hyve-dist__req">*</span>
              </label>

              <select
                id="dist-relation"
                name="relationToBusiness"
                class="hyve-dist__select"
                required
              >

                <option value="">
                  Select…
                </option>

                <option
                  value="Owner"
                  ${chosen("relationToBusiness", "Owner")}
                >
                  Owner
                </option>

                <option
                  value="Management"
                  ${chosen("relationToBusiness", "Management")}
                >
                  Management
                </option>

                <option
                  value="Executive"
                  ${chosen("relationToBusiness", "Executive")}
                >
                  Executive
                </option>

                <option
                  value="Other"
                  ${chosen("relationToBusiness", "Other")}
                >
                  Other
                </option>

              </select>

            </div>

            <div class="hyve-dist__field">

              <label
                class="hyve-dist__label"
                for="dist-currency"
              >
                Preferred Currency
                <span class="hyve-dist__req">*</span>
              </label>

              <select
                id="dist-currency"
                name="preferredCurrency"
                class="hyve-dist__select"
                required
              >

                ${(currencies || [])
                  .map(
                    (code) =>
                      `<option value="${esc(code)}"${currencyChoice(                         code,                       )}>${esc(code)}</option>`,
                  )
                  .join("")}

              </select>

            </div>

          </div>

        </div>

        <!-- Markets -->

        <div
          class="
            hyve-dist__field
            hyve-dist__field--wide
          "
        >

          <label class="hyve-dist__label">

            Markets You Sell Into

            <span class="hyve-dist__req">
              *
            </span>

            <span class="hyve-dist__opt">
              (Select all that apply)
            </span>

          </label>

          <div
            class="
              hyve-dist__markets-grid
              hyve-dist__markets-grid--wide
            "
          >

            ${renderMarketOption(
              "Singapore",
              "SG",
              true,
              values?.markets ?? null,
            )}

            ${renderMarketOption(
              "Hong Kong",
              "HK",
              false,
              values?.markets ?? null,
            )}

            ${renderMarketOption(
              "Malaysia",
              "MY",
              false,
              values?.markets ?? null,
            )}

            ${renderMarketOption(
              "Philippines",
              "PH",
              false,
              values?.markets ?? null,
            )}

            ${renderMarketOption(
              "Thailand",
              "TH",
              false,
              values?.markets ?? null,
            )}

            ${renderMarketOption(
              "Indonesia",
              "ID",
              false,
              values?.markets ?? null,
            )}

            ${renderMarketOption(
              "Vietnam",
              "VN",
              false,
              values?.markets ?? null,
            )}

            ${renderMarketOption("China", "CN", false, values?.markets ?? null)}

            ${renderMarketOption("Other", "🌐", false, values?.markets ?? null)}

          </div>

        </div>

        <!-- Commercial Credit Terms -->

        <div class="hyve-dist__section-terms">

          <div class="hyve-dist__terms-header">

            <div class="hyve-dist__terms-text">

              <h3 class="hyve-dist__terms-title">
                Request Commercial / Credit Terms
                (Net 30/60)
              </h3>

              <p class="hyve-dist__terms-sub">
                Prepayment is standard. Enable this to
                request custom credit limits and billing
                accounts.
              </p>

            </div>

            <label class="hyve-dist__switch">

              <input
                type="checkbox"
                name="requestCredit"
                value="true"
                id="dist-credit-toggle"
                ${isCreditRequired ? "checked" : ""}
              >

              <span
                class="hyve-dist__switch-slider"
              ></span>

            </label>

          </div>

          <!-- Credit Fields -->

          <div
            class="
              hyve-dist__grid-2
              hyve-dist__credit-fields
            "
            id="dist-credit-fields"
            style="${isCreditRequired ? "" : "display: none;"}"
          >

            <!-- Left Subcolumn -->

            <div class="hyve-dist__col">

              <div class="hyve-dist__field">

                <label
                  class="hyve-dist__label"
                  for="dist-uen"
                >
                  Business Registration Number (UEN)
                  <span class="hyve-dist__req dist-credit-req" ${isCreditRequired ? "" : 'style="display:none;"'}>
                    *
                  </span>
                </label>

                <input
                  type="text"
                  id="dist-uen"
                  name="registrationNumber"
                  class="hyve-dist__input js-credit-field"
                  placeholder="e.g. 201912345G"
                  value="${typed("registrationNumber")}"
                  ${isCreditRequired ? "required" : ""}
                  ${fieldError("registrationNumber") ? 'aria-invalid="true"' : ""}
                  aria-describedby="dist-uen-error"
                >

                <div
                  class="hyve-dist__field-error"
                  id="dist-uen-error"
                  data-error-for="registrationNumber"
                  ${fieldError("registrationNumber") ? "" : "hidden"}
                >
                  ${fieldError("registrationNumber")}
                </div>

              </div>

              <div class="hyve-dist__field">

                <label
                  class="hyve-dist__label"
                  for="dist-tax"
                >
                  Tax Registration Number
                  <span class="hyve-dist__req dist-credit-req" ${isCreditRequired ? "" : 'style="display:none;"'}>
                    *
                  </span>
                </label>

                <input
                  type="text"
                  id="dist-tax"
                  name="taxRegistrationNumber"
                  class="hyve-dist__input js-credit-field"
                  placeholder="As shown on your tax certificate"
                  value="${typed("taxRegistrationNumber")}"
                  ${isCreditRequired ? "required" : ""}
                  ${fieldError("taxRegistrationNumber") ? 'aria-invalid="true"' : ""}
                  aria-describedby="dist-tax-error"
                >

                <div
                  class="hyve-dist__field-error"
                  id="dist-tax-error"
                  data-error-for="taxRegistrationNumber"
                  ${fieldError("taxRegistrationNumber") ? "" : "hidden"}
                >
                  ${fieldError("taxRegistrationNumber")}
                </div>

              </div>

              <div class="hyve-dist__field">

                <label
                  class="hyve-dist__label"
                  for="dist-volume"
                >
                  Expected Annual Order Volume
                  <span class="hyve-dist__req dist-credit-req" ${isCreditRequired ? "" : 'style="display:none;"'}>
                    *
                  </span>
                </label>

                <select
                  id="dist-volume"
                  name="expectedVolume"
                  class="hyve-dist__select js-credit-field"
                  ${isCreditRequired ? "required" : ""}
                  ${fieldError("expectedVolume") ? 'aria-invalid="true"' : ""}
                  aria-describedby="dist-volume-error"
                >
                  <option value="">
                    Select expected volume…
                  </option>

                  <option
                    value="Under SGD 10,000"
                    ${chosen("expectedVolume", "Under SGD 10,000", false)}
                  >
                    Under SGD 10,000
                  </option>

                  <option
                    value="SGD 10,000 - SGD 50,000"
                    ${chosen("expectedVolume", "SGD 10,000 - SGD 50,000", false)}
                  >
                    SGD 10,000 - SGD 50,000
                  </option>

                  <option
                    value="SGD 50,000 - SGD 200,000"
                    ${chosen(
                      "expectedVolume",
                      "SGD 50,000 - SGD 200,000",
                      false,
                    )}
                  >
                    SGD 50,000 - SGD 200,000
                  </option>

                  <option
                    value="SGD 200,000+"
                    ${chosen("expectedVolume", "SGD 200,000+", false)}
                  >
                    SGD 200,000+
                  </option>

                </select>

                <div
                  class="hyve-dist__field-error"
                  id="dist-volume-error"
                  data-error-for="expectedVolume"
                  ${fieldError("expectedVolume") ? "" : "hidden"}
                >
                  ${fieldError("expectedVolume")}
                </div>

              </div>

              <!-- Registered Business Address -->

              <div
                class="
                  hyve-dist__address-section
                "
              >

                <div
                  class="
                    hyve-dist__address-heading
                  "
                >

                  <div>

                    <label
                      class="hyve-dist__label"
                    >
                      Registered Business Address

                      <span
                        class="hyve-dist__req dist-credit-req"
                        ${isCreditRequired ? "" : 'style="display:none;"'}
                      >
                        *
                      </span>

                    </label>

                    <p
                      class="
                        hyve-dist__address-help
                      "
                    >
                      Enter the official registered
                      address of your business.
                    </p>

                  </div>

                </div>

                <div
                  class="
                    hyve-dist__address-grid
                  "
                >

                  <!-- Address Line 1 -->

                  <div
                    class="
                      hyve-dist__field
                      hyve-dist__field--address-full
                    "
                  >

                    <label
                      class="hyve-dist__label"
                      for="dist-address1"
                    >
                      Address Line 1

                      <span
                        class="hyve-dist__req dist-credit-req"
                        ${isCreditRequired ? "" : 'style="display:none;"'}
                      >
                        *
                      </span>

                    </label>

                    <input
                      type="text"
                      id="dist-address1"
                      name="registeredAddress.address1"
                      class="hyve-dist__input js-credit-field"
                      autocomplete="address-line1"
                      placeholder="Street address, building name, unit"
                      value="${addressValue("address1")}"
                      ${isCreditRequired ? "required" : ""}
                      ${addressError("address1") ? 'aria-invalid="true"' : ""}
                      aria-describedby="dist-address1-error"
                    >

                    <div
                      class="
                        hyve-dist__field-error
                      "
                      id="dist-address1-error"
                      data-error-for="registeredAddress.address1"
                      ${addressError("address1") ? "" : "hidden"}
                    >
                      ${addressError("address1")}
                    </div>

                  </div>

                  <!-- Address Line 2 -->

                  <div
                    class="
                      hyve-dist__field
                      hyve-dist__field--address-full
                    "
                  >

                    <label
                      class="hyve-dist__label"
                      for="dist-address2"
                    >
                      Address Line 2

                      <span
                        class="hyve-dist__opt"
                      >
                        (Optional)
                      </span>

                    </label>

                    <input
                      type="text"
                      id="dist-address2"
                      name="registeredAddress.address2"
                      class="hyve-dist__input"
                      autocomplete="address-line2"
                      placeholder="Suite, floor, unit, landmark"
                      value="${addressValue("address2")}"
                    >

                    <div
                      class="
                        hyve-dist__field-error
                      "
                      id="dist-address2-error"
                      data-error-for="registeredAddress.address2"
                      ${addressError("address2") ? "" : "hidden"}
                    >
                      ${addressError("address2")}
                    </div>

                  </div>

                  <!-- City -->

                  <div
                    class="hyve-dist__field"
                  >

                    <label
                      class="hyve-dist__label"
                      for="dist-address-city"
                    >
                      City

                      <span
                        class="hyve-dist__req dist-credit-req"
                        ${isCreditRequired ? "" : 'style="display:none;"'}
                      >
                        *
                      </span>

                    </label>

                    <input
                      type="text"
                      id="dist-address-city"
                      name="registeredAddress.city"
                      class="hyve-dist__input js-credit-field"
                      autocomplete="address-level2"
                      placeholder="City"
                      value="${addressValue("city")}"
                      ${isCreditRequired ? "required" : ""}
                      ${addressError("city") ? 'aria-invalid="true"' : ""}
                      aria-describedby="dist-address-city-error"
                    >

                    <div
                      class="
                        hyve-dist__field-error
                      "
                      id="dist-address-city-error"
                      data-error-for="registeredAddress.city"
                      ${addressError("city") ? "" : "hidden"}
                    >
                      ${addressError("city")}
                    </div>

                  </div>

                  <!-- Country -->

                  <div
                    class="hyve-dist__field"
                  >

                    <label
                      class="hyve-dist__label"
                      for="dist-address-country"
                    >
                      Country

                      <span
                        class="hyve-dist__req dist-credit-req"
                        ${isCreditRequired ? "" : 'style="display:none;"'}
                      >
                        *
                      </span>

                    </label>

                    <select
                      id="dist-address-country"
                      name="registeredAddress.country"
                      class="hyve-dist__select js-credit-field"
                      autocomplete="country-name"
                      ${isCreditRequired ? "required" : ""}
                      ${addressError("country") ? 'aria-invalid="true"' : ""}
                      aria-describedby="dist-address-country-error"
                    >

                      <option value="">
                        Select country…
                      </option>

                      ${DISTRIBUTOR_COUNTRIES.map(
                        (country) =>
                          `<option
                            value="${esc(country.name)}"
                            data-country-code="${esc(country.code)}"
                            ${addressSelected("country", country.name)}
                          >
                            ${esc(country.name)}
                          </option>`,
                      ).join("")}

                    </select>

                    <div
                      class="
                        hyve-dist__field-error
                      "
                      id="dist-address-country-error"
                      data-error-for="registeredAddress.country"
                      ${addressError("country") ? "" : "hidden"}
                    >
                      ${addressError("country")}
                    </div>

                  </div>

                  <!-- State / Province -->

                  <div
                    class="hyve-dist__field"
                  >

                    <label
                      class="hyve-dist__label"
                      for="dist-address-province"
                    >
                      State / Province

                      <span
                        class="hyve-dist__req dist-credit-req"
                        ${isCreditRequired ? "" : 'style="display:none;"'}
                      >
                        *
                      </span>

                    </label>

                    <select
                      id="dist-address-province"
                      name="registeredAddress.province"
                      class="hyve-dist__select js-credit-field"
                      autocomplete="address-level1"
                      ${isCreditRequired ? "required" : ""}
                      ${addressError("province") ? 'aria-invalid="true"' : ""}
                      data-current-state="${addressValue("province")}"
                      aria-describedby="dist-address-province-error"
                    >

                      <option value="">
                        Select state / province…
                      </option>

                    </select>

                    <div
                      class="
                        hyve-dist__field-error
                      "
                      id="dist-address-province-error"
                      data-error-for="registeredAddress.province"
                      ${addressError("province") ? "" : "hidden"}
                    >
                      ${addressError("province")}
                    </div>

                  </div>

                  <!-- Province / State Code -->
                  <input
                    type="hidden"
                    id="dist-address-province-code"
                    name="registeredAddress.provinceCode"
                    value="${addressValue("provinceCode")}"
                  >

                  <!-- ZIP -->

                  <div
                    class="hyve-dist__field"
                  >

                    <label
                      class="hyve-dist__label"
                      for="dist-address-zip"
                    >
                      ZIP / Postal Code

                      <span
                        class="hyve-dist__req dist-credit-req"
                        ${isCreditRequired ? "" : 'style="display:none;"'}
                      >
                        *
                      </span>

                    </label>

                    <input
                      type="text"
                      id="dist-address-zip"
                      name="registeredAddress.zip"
                      class="hyve-dist__input js-credit-field"
                      autocomplete="postal-code"
                      placeholder="ZIP / Postal code"
                      value="${addressValue("zip")}"
                      ${isCreditRequired ? "required" : ""}
                      ${addressError("zip") ? 'aria-invalid="true"' : ""}
                      aria-describedby="dist-address-zip-error"
                    >

                    <div
                      class="
                        hyve-dist__field-error
                      "
                      id="dist-address-zip-error"
                      data-error-for="registeredAddress.zip"
                      ${addressError("zip") ? "" : "hidden"}
                    >
                      ${addressError("zip")}
                    </div>

                  </div>

                  <!-- Phone -->

                  <div
                    class="hyve-dist__field"
                  >

                    <label
                      class="hyve-dist__label"
                      for="dist-address-phone"
                    >
                      Phone

                      <span
                        class="hyve-dist__req dist-credit-req"
                        ${isCreditRequired ? "" : 'style="display:none;"'}
                      >
                        *
                      </span>

                    </label>

                    <input
                      type="tel"
                      id="dist-address-phone"
                      name="registeredAddress.phone"
                      class="hyve-dist__input js-credit-field"
                      autocomplete="tel"
                      inputmode="tel"
                      placeholder="+65 9123 4567"
                      value="${addressValue("phone")}"
                      ${isCreditRequired ? "required" : ""}
                      ${addressError("phone") ? 'aria-invalid="true"' : ""}
                      aria-describedby="dist-address-phone-error"
                    >

                    <div
                      class="
                        hyve-dist__field-error
                      "
                      id="dist-address-phone-error"
                      data-error-for="registeredAddress.phone"
                      ${addressError("phone") ? "" : "hidden"}
                    >
                      ${addressError("phone")}
                    </div>

                  </div>

                </div>

              </div>

            </div>

            <!-- Right Subcolumn -->

            <div class="hyve-dist__col">

              <div class="hyve-dist__field">

                <label class="hyve-dist__label">

                  Upload Business Registration Profile

                  <span
                    class="hyve-dist__opt"
                  >
                    (ACRA / Bizfile or country equivalent)
                  </span>

                </label>

                <div
                  class="hyve-dist__dropzone"
                  id="dist-dropzone"
                >

                  <input
                    type="file"
                    name="registrationDoc"
                    id="dist-file-input"
                    class="hyve-dist__file-input"
                    accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                  >

                  <div
                    class="
                      hyve-dist__dropzone-content
                    "
                  >

                    <span
                      class="
                        hyve-dist__dropzone-icon
                      "
                    >
                      ${icoCloudUpload()}
                    </span>

                    <span
                      class="
                        hyve-dist__dropzone-text
                      "
                      id="dist-dropzone-label"
                    >
                      Drag &amp; Drop profile doc
                    </span>

                    <span
                      class="
                        hyve-dist__dropzone-sub
                      "
                    >
                      or click to browse. Max 10MB
                      (PDF, PNG, JPG)
                    </span>

                  </div>

                </div>

              </div>

            </div>

          </div>

        </div>

        <!-- Footer -->

        <div class="hyve-dist__actions">

          <a
            href="/apps/account/orders"
            class="
              hyve-dist__btn
              hyve-dist__btn--ghost
            "
          >
            Cancel
          </a>

          <button
            type="submit"
            class="
              hyve-dist__btn
              hyve-dist__btn--submit
            "
            id="dist-submit-btn"
          >

            ${icoSend()}

            <span>
              Submit Application
            </span>

          </button>

        </div>

      </form>

    </div>

    ${DISTRIBUTOR_SCRIPT}`;
}


function renderMarketOption(name, code, isDefault = false, picked = null) {
  const isEmoji = code.length > 2;
  const badgeContent = isEmoji ? code : `<span>${esc(code)}</span>`;
  const checked = picked ? picked.includes(name) : isDefault;

  return `
    <label
      class="
        hyve-dist__market-pill
        ${checked ? "is-checked" : ""}
      "
    >

      <input
        type="checkbox"
        name="markets"
        value="${esc(name)}"
        ${checked ? "checked" : ""}
      >

      <span
        class="hyve-dist__market-code"
      >
        ${badgeContent}
      </span>

      <span
        class="hyve-dist__market-name"
      >
        ${esc(name)}
      </span>

      <span
        class="hyve-dist__market-check"
      >
        ${icoCheck()}
      </span>

    </label>`;
}


function renderExistingApplicationView(app, customer) {
  const status = app.status || "Pending Review";
  const isApproved = status.toLowerCase() === "approved";
  const isRejected = status.toLowerCase() === "rejected";

  const contactName =
    app.contact_person ||
    customer?.name ||
    customer?.displayName ||
    (customer?.firstName
      ? `${customer.firstName} ${customer.lastName || ""}`.trim()
      : "") ||
    "";

  const companyName = app.company_name || customer?.company || "";
  const website = app.company_website || "";

  let websiteUrl = website;
  if (
    website &&
    !website.startsWith("http://") &&
    !website.startsWith("https://")
  ) {
    websiteUrl = "https://" + website;
  }

  const operatingRegion = app.country_based || app.markets_sold || "";

  const termsRequested =
    app.request_credit === "true" || app.request_credit === true
      ? "Net 30 terms requested"
      : "Prepayment only";

  let bannerTitle = "Application Pending Evaluation";
  let badgeText = "Under Review";

  let bannerIcon = `
    <svg
      class="hyve-dist__eval-banner-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#ea580c"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
      ></circle>

      <polyline
        points="12 6 12 12 16 14"
      ></polyline>
    </svg>`;

  let badgeIcon = `
    <svg
      class="hyve-dist__eval-badge-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
      ></circle>

      <polyline
        points="12 7 12 12 15 15"
      ></polyline>
    </svg>`;

  let step1Class = "hyve-dist__step--done";
  let line1Class = "hyve-dist__step-line--done";
  let step2Class = "hyve-dist__step--active";
  let line2Class = "";
  let step3Class = "hyve-dist__step--upcoming";

  let mainTitle = "We are evaluating your distributor profile!";
  let mainDescription = `Thanks for applying${
    contactName ? `, <strong>${esc(contactName)}</strong>` : ""
  }! Our Head of Customer Service, <strong>Bruce</strong>, manages application vetting. We have committed to a <strong>7 business days Review SLA</strong> and are checking your credentials.`;

  if (isApproved) {
    bannerTitle = "Application Approved & Activated";
    badgeText = "Activated";
    bannerIcon = `
      <svg
        class="hyve-dist__eval-banner-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#16a34a"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M22 11.08V12a10 10 0 1 1-5.93-9.14"
        ></path>

        <polyline
          points="22 4 12 14.01 9 11.01"
        ></polyline>
      </svg>`;

    badgeIcon = `
      <svg
        class="hyve-dist__eval-badge-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline
          points="20 6 9 17 4 12"
        ></polyline>
      </svg>`;

    step1Class = "hyve-dist__step--done";
    line1Class = "hyve-dist__step-line--done";
    step2Class = "hyve-dist__step--done";
    line2Class = "hyve-dist__step-line--done";
    step3Class = "hyve-dist__step--done";

    mainTitle = "Your distributor profile is officially active!";
    mainDescription = `Congratulations${
      contactName ? `, <strong>${esc(contactName)}</strong>` : ""
    }! You now have full access to wholesale pricing and distributor commercial terms.`;
  } else if (isRejected) {
    bannerTitle = "Application Decision: Declined";
    badgeText = "Declined";
    bannerIcon = `
      <svg
        class="hyve-dist__eval-banner-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#dc2626"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
        ></circle>

        <line
          x1="12"
          y1="8"
          x2="12"
          y2="12"
        ></line>

        <line
          x1="12"
          y1="16"
          x2="12.01"
          y2="16"
        ></line>
      </svg>`;

    step1Class = "hyve-dist__step--done";
    line1Class = "hyve-dist__step-line--danger";
    step2Class = "hyve-dist__step--danger";
    line2Class = "";
    step3Class = "hyve-dist__step--upcoming";

    mainTitle = "Distributor Application Status Update";
    mainDescription = `Thank you for applying${
      contactName ? `, <strong>${esc(contactName)}</strong>` : ""
    }. At this time, we are unable to approve your distributor application. If you have questions, please reach out to our team.`;
  }

  return `
    <div
      class="hyve-dist__eval-container"
    >

      <div
        class="
          hyve-dist__eval-banner
          ${
            isApproved
              ? "hyve-dist__eval-banner--approved"
              : isRejected
                ? "hyve-dist__eval-banner--rejected"
                : ""
          }
        "
      >

        <div
          class="
            hyve-dist__eval-banner-left
          "
        >

          ${bannerIcon}

          <span
            class="
              hyve-dist__eval-banner-title
            "
          >
            ${esc(bannerTitle)}
          </span>

        </div>

        <div
          class="
            hyve-dist__eval-badge
            ${
              isApproved
                ? "hyve-dist__eval-badge--approved"
                : isRejected
                  ? "hyve-dist__eval-badge--rejected"
                  : ""
            }
          "
        >

          ${badgeIcon}

          <span>
            ${esc(badgeText)}
          </span>

        </div>

      </div>

      <div
        class="hyve-dist__eval-body"
      >

        <div
          class="hyve-dist__stepper"
        >

          <div
            class="
              hyve-dist__step
              ${step1Class}
            "
          >

            <div
              class="
                hyve-dist__step-circle
              "
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline
                  points="20 6 9 17 4 12"
                ></polyline>
              </svg>
            </div>

            <span
              class="
                hyve-dist__step-label
              "
            >
              Submitted
            </span>

          </div>

          <div
            class="
              hyve-dist__step-line
              ${line1Class}
            "
          ></div>

          <div
            class="
              hyve-dist__step
              ${step2Class}
            "
          >

            <div
              class="
                hyve-dist__step-circle
              "
            >

              ${
                isApproved
                  ? `
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="3"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <polyline
                        points="20 6 9 17 4 12"
                      ></polyline>
                    </svg>
                  `
                  : `
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="10"
                      ></circle>

                      <polyline
                        points="12 6 12 12 16 14"
                      ></polyline>
                    </svg>
                  `
              }

            </div>

            <span
              class="
                hyve-dist__step-label
              "
            >
              Reviewing
            </span>

          </div>

          <div
            class="
              hyve-dist__step-line
              ${line2Class}
            "
          ></div>

          <div
            class="
              hyve-dist__step
              ${step3Class}
            "
          >

            <div
              class="
                hyve-dist__step-circle
              "
            >

              ${
                isApproved
                  ? `
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="3"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <polyline
                        points="20 6 9 17 4 12"
                      ></polyline>
                    </svg>
                  `
                  : `
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <circle
                        cx="12"
                        cy="8"
                        r="6"
                      ></circle>

                      <path
                        d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"
                      ></path>
                    </svg>
                  `
              }

            </div>

            <span
              class="
                hyve-dist__step-label
              "
            >
              Activated
            </span>

          </div>

        </div>

        <h2
          class="hyve-dist__eval-title"
        >
          ${esc(mainTitle)}
        </h2>

        <p
          class="hyve-dist__eval-desc"
        >
          ${mainDescription}
        </p>

        ${
          isRejected
            ? `
              <div
                class="
                  hyve-dist__rejection-banner
                "
              >

                <div
                  class="
                    hyve-dist__rejection-icon
                  "
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#dc2626"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                    ></circle>

                    <line
                      x1="12"
                      y1="8"
                      x2="12"
                      y2="12"
                    ></line>

                    <line
                      x1="12"
                      y1="16"
                      x2="12.01"
                      y2="16"
                    ></line>
                  </svg>
                </div>

                <div
                  class="
                    hyve-dist__rejection-content
                  "
                >

                  <span
                    class="
                      hyve-dist__rejection-title
                    "
                  >
                    Application Review Feedback
                  </span>

                  <p
                    class="
                      hyve-dist__rejection-text
                    "
                  >
                    ${esc(
                      app.rejection_message ||
                        "Thank you for applying. At this time, your distributor profile does not meet our minimum commercial requirements.",
                    )}
                  </p>

                </div>

              </div>
            `
            : ""
        }

        <div
          class="hyve-dist__eval-card"
        >

          <div
            class="hyve-dist__eval-grid"
          >

            <div
              class="hyve-dist__eval-item"
            >

              <span
                class="hyve-dist__eval-label"
              >
                COMPANY NAME
              </span>

              <span
                class="hyve-dist__eval-val"
              >
                ${esc(companyName || "—")}
              </span>

            </div>

            <div
              class="hyve-dist__eval-item"
            >

              <span
                class="hyve-dist__eval-label"
              >
                WEBSITE
              </span>

              <span
                class="hyve-dist__eval-val"
              >

                ${
                  website
                    ? `<a
                        href="${esc(websiteUrl)}"
                        target="_blank"
                        rel="noopener"
                        class="hyve-dist__eval-website"
                      >
                        ${esc(website)}
                      </a>`
                    : `
                      <span
                        style="color:#94a3b8;"
                      >
                        —
                      </span>
                    `
                }

              </span>

            </div>

            <div
              class="hyve-dist__eval-item"
            >

              <span
                class="hyve-dist__eval-label"
              >
                OPERATING REGION
              </span>

              <span
                class="hyve-dist__eval-val"
              >
                ${esc(operatingRegion || "—")}
              </span>

            </div>

            <div
              class="hyve-dist__eval-item"
            >

              <span
                class="hyve-dist__eval-label"
              >
                COMMERCIAL TERMS REQUESTED
              </span>

              <span
                class="hyve-dist__eval-val"
              >
                ${esc(termsRequested)}
              </span>

            </div>

            ${
              app.registration_document_url
                ? `
                  <div
                    class="
                      hyve-dist__eval-item
                    "
                    style="
                      grid-column:1 / -1;
                      padding-top:10px;
                      border-top:
                        1px dashed #e2e8f0;
                    "
                  >

                    <span
                      class="
                        hyve-dist__eval-label
                      "
                    >
                      BUSINESS REGISTRATION PROFILE
                    </span>

                    <span
                      class="
                        hyve-dist__eval-val
                      "
                    >

                      <a
                        href="${esc(app.registration_document_url)}"
                        target="_blank"
                        rel="noopener"
                        class="
                          hyve-dist__eval-website
                        "
                      >
                        📄
                        ${esc(
                          app.registration_document_name ||
                            "View Uploaded Document",
                        )}
                        ↗
                      </a>

                    </span>

                  </div>
                `
                : ""
            }

          </div>

        </div>

        <div
          class="hyve-dist__eval-foot"
        >

          <a
            href="/apps/account/orders"
            class="hyve-dist__eval-back"
          >
            &larr; Return to Orders
          </a>

        </div>

      </div>

    </div>`;
}


function renderNotificationToast(notice, error) {
  if (!notice && !error) {
    return "";
  }

  const isErr = Boolean(error);
  const msg = error || notice;
  const icon = isErr ? icoAlert() : icoCheckCircle();
  const tone = isErr ? "error" : "success";

  return `
    <div
      class="
        hyve-dist__toast
        hyve-dist__toast--${tone}
      "
      role="status"
    >

      <span
        class="hyve-dist__toast-icon"
      >
        ${icon}
      </span>

      <span
        class="hyve-dist__toast-msg"
      >
        ${esc(msg)}
      </span>

      <button
        type="button"
        class="
          hyve-dist__toast-close
        "
        onclick="this.parentElement.remove()"
        aria-label="Dismiss"
      >
        ${icoClose()}
      </button>

    </div>`;
}

function svg(inner) {
  return `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      ${inner}
    </svg>`;
}

function icoBuilding() {
  return svg(`
    <rect
      x="4"
      y="2"
      width="16"
      height="20"
      rx="2"
    />

    <path
      d="M9 22v-4h6v4"
    />

    <path
      d="
        M8 6h.01
        M16 6h.01
        M12 6h.01
        M12 10h.01
        M12 14h.01
        M16 10h.01
        M16 14h.01
        M8 10h.01
        M8 14h.01
      "
    />
  `);
}

function icoCheck() {
  return svg(`
    <polyline
      points="20 6 9 17 4 12"
    />
  `);
}

function icoCheckCircle() {
  return svg(`
    <path
      d="
        M22 11.08V12
        a10 10 0 1 1-5.93-9.14
      "
    />

    <polyline
      points="22 4 12 14.01 9 11.01"
    />
  `);
}

function icoClock() {
  return svg(`
    <circle
      cx="12"
      cy="12"
      r="10"
    />

    <polyline
      points="12 6 12 12 16 14"
    />
  `);
}

function icoAlert() {
  return svg(`
    <circle
      cx="12"
      cy="12"
      r="10"
    />

    <line
      x1="12"
      y1="8"
      x2="12"
      y2="12"
    />

    <line
      x1="12"
      y1="16"
      x2="12.01"
      y2="16"
    />
  `);
}

function icoCloudUpload() {
  return svg(`
    <path
      d="
        M17.5 19H9
        a7 7 0 1 1 6.71-9
        h1.79
        a4.5 4.5 0 1 1 0 9Z
      "
    />

    <polyline
      points="12 12 12 16 12 12"
    />

    <polyline
      points="9 14 12 11 15 14"
    />
  `);
}

function icoSend() {
  return svg(`
    <line
      x1="22"
      y1="2"
      x2="11"
      y2="13"
    />

    <polygon
      points="
        22 2
        15 22
        11 13
        2 9
        22 2
      "
    />
  `);
}

function icoClose() {
  return svg(`
    <line
      x1="18"
      y1="6"
      x2="6"
      y2="18"
    />

    <line
      x1="6"
      y1="6"
      x2="18"
      y2="18"
    />
  `);
}


const DISTRIBUTOR_STYLES = `
<style>

.hyve-dist {
  --dist-fg: #0f172a;
  --dist-sub: #64748b;
  --dist-muted: #94a3b8;
  --dist-line: #e2e8f0;
  --dist-brand-green: #a3ea6e;
  --dist-brand-teal: #6ee7b7;

  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    sans-serif;

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

/* Main Form Card */

.hyve-dist__form-card {
  background: #ffffff;
  border: 1px solid var(--dist-line);
  border-radius: 14px;
  padding: 24px;

  box-shadow:
    0 1px 3px
    rgba(0, 0, 0, 0.02);
}

/* Card Header */

.hyve-dist__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;

  gap: 12px;

  margin-bottom: 22px;

  padding-bottom: 12px;

  border-bottom:
    1px solid
    var(--dist-line);
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

  border:
    1px solid
    var(--dist-line);

  color: var(--dist-sub);

  font-size: 11.5px;
  font-weight: 700;

  padding: 3.5px 9px;

  border-radius: 999px;
}

/* Grids */

.hyve-dist__grid-2 {
  display: grid;

  grid-template-columns:
    1fr 1fr;

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

  border:
    1px solid
    var(--dist-line);

  border-radius: 8.5px;

  font-size: 13.5px;
  font-family: inherit;

  color: var(--dist-fg);

  background: #ffffff;

  box-sizing: border-box;

  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.hyve-dist__input:focus,
.hyve-dist__select:focus,
.hyve-dist__textarea:focus {
  outline: none;

  border-color: #0f172a;

  box-shadow:
    0 0 0 3px
    rgba(
      15,
      23,
      42,
      0.08
    );
}

/* Markets */

.hyve-dist__markets-grid {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap: 8px;
}

.hyve-dist__markets-grid--wide {
  grid-template-columns:
    repeat(3, 1fr);
}

.hyve-dist__field--wide {
  margin-top: 4px;
}

@media (
  max-width: 900px
) {
  .hyve-dist__markets-grid--wide {
    grid-template-columns:
      1fr 1fr;
  }
}

.hyve-dist__market-pill {
  display: flex;

  align-items: center;

  gap: 8px;

  padding: 8px 11px;

  border:
    1px solid
    var(--dist-line);

  border-radius: 8.5px;

  background: #ffffff;

  cursor: pointer;

  user-select: none;

  transition:
    all 0.15s ease;
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

  border:
    1px solid
    var(--dist-line);

  border-radius: 50%;

  display: inline-flex;

  align-items: center;

  justify-content: center;

  color: transparent;

  transition:
    all 0.15s ease;
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

.hyve-dist__market-pill.is-checked
.hyve-dist__market-code {
  background: #dcfce7;

  color: #15803d;
}

.hyve-dist__market-pill.is-checked
.hyve-dist__market-name {
  color: #0f172a;

  font-weight: 700;
}

.hyve-dist__market-pill.is-checked
.hyve-dist__market-check {
  background: #16a34a;

  border-color: #16a34a;

  color: #ffffff;
}

/* Commercial Credit Terms */

.hyve-dist__section-terms {
  margin-top: 28px;

  padding-top: 20px;

  border-top:
    1px solid
    var(--dist-line);
}

.hyve-dist__terms-header {
  display: flex;

  align-items: center;

  justify-content:
    space-between;

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

/* Toggle */

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

  background-color:
    #cbd5e1;

  border-radius: 999px;

  transition:
    background-color
    0.25s ease;
}

.hyve-dist__switch-slider::before {
  position: absolute;

  content: "";

  height: 20px;
  width: 20px;

  left: 3px;
  bottom: 3px;

  background-color:
    #ffffff;

  border-radius: 50%;

  box-shadow:
    0 2px 4px
    rgba(
      0,
      0,
      0,
      0.15
    );

  transition:
    transform
    0.25s
    cubic-bezier(
      0.175,
      0.885,
      0.32,
      1.275
    );
}

.hyve-dist__switch
input:checked
+
.hyve-dist__switch-slider {
  background:
    linear-gradient(
      135deg,
      #a3ea6e,
      #4ade80
    );
}

.hyve-dist__switch
input:checked
+
.hyve-dist__switch-slider::before {
  transform:
    translateX(20px);
}

/* Upload */

.hyve-dist__dropzone {
  position: relative;

  border:
    1.5px dashed
    #cbd5e1;

  border-radius: 12px;

  background: #f8fafc;

  padding: 34px 20px;

  text-align: center;

  cursor: pointer;

  transition:
    all 0.2s ease;

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

  border-top:
    1px solid
    var(--dist-line);
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

  transition:
    all 0.15s ease;
}

.hyve-dist__btn svg {
  width: 16px;

  height: 16px;
}

.hyve-dist__btn--ghost {
  background: #ffffff;

  border:
    1px solid
    var(--dist-line);

  color: #475569;
}

.hyve-dist__btn--ghost:hover {
  background: #f8fafc;

  border-color: #cbd5e1;

  color: var(--dist-fg);
}

.hyve-dist__btn--submit {
  background:
    linear-gradient(
      135deg,
      #a3ea6e 0%,
      #6ee7b7 100%
    );

  border:
    1px solid
    transparent;

  color: #0a1414;

  box-shadow:
    0 2px 6px
    rgba(
      110,
      231,
      183,
      0.25
    );
}

.hyve-dist__btn--submit:hover {
  filter:
    brightness(0.96);

  transform:
    translateY(-1px);

  box-shadow:
    0 4px 12px
    rgba(
      110,
      231,
      183,
      0.35
    );
}

/* Evaluation view */

.hyve-dist__eval-container {
  background: #ffffff;

  border:
    1px solid
    #fed7aa;

  border-radius: 16px;

  overflow: hidden;

  box-shadow:
    0 4px 20px -2px
    rgba(
      234,
      88,
      12,
      0.04
    );

  margin: 0 auto;

  max-width: 980px;

  animation:
    hyveFadeIn
    0.3s ease;
}

.hyve-dist__eval-banner {
  background: #fffdf5;

  border-bottom:
    1px solid
    #fef08a;

  padding: 14px 24px;

  display: flex;

  align-items: center;

  justify-content:
    space-between;

  gap: 16px;
}

.hyve-dist__eval-banner--approved {
  background: #f0fdf4;

  border-bottom-color:
    #bbf7d0;
}

.hyve-dist__eval-banner--rejected {
  background: #fef2f2;

  border-bottom-color:
    #fecaca;
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

  letter-spacing:
    -0.01em;
}

.hyve-dist__eval-banner--approved
.hyve-dist__eval-banner-title {
  color: #15803d;
}

.hyve-dist__eval-banner--rejected
.hyve-dist__eval-banner-title {
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

  border:
    1px solid
    #fde68a;

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
  padding:
    44px
    32px
    52px;

  text-align: center;

  background: #ffffff;
}

/* Stepper */

.hyve-dist__stepper {
  display: flex;

  align-items: flex-start;

  justify-content: center;

  max-width: 460px;

  margin:
    0 auto 36px;

  padding:
    0 12px;
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

  transition:
    all 0.2s ease;
}

.hyve-dist__step--done
.hyve-dist__step-circle {
  background: #10b981;

  color: #ffffff;
}

.hyve-dist__step--active
.hyve-dist__step-circle {
  background: #f59e0b;

  color: #ffffff;

  box-shadow:
    0 0 0 4px
    rgba(
      245,
      158,
      11,
      0.16
    );
}

.hyve-dist__step--upcoming
.hyve-dist__step-circle {
  background: #ffffff;

  border:
    2px solid
    #cbd5e1;

  color: #94a3b8;
}

.hyve-dist__step--danger
.hyve-dist__step-circle {
  background: #ef4444;

  color: #ffffff;
}

.hyve-dist__step-label {
  font-size: 12.5px;

  margin-top: 8px;

  white-space: nowrap;

  letter-spacing:
    -0.01em;
}

.hyve-dist__step--done
.hyve-dist__step-label {
  color: #0f172a;

  font-weight: 700;
}

.hyve-dist__step--active
.hyve-dist__step-label {
  color: #d97706;

  font-weight: 700;
}

.hyve-dist__step--upcoming
.hyve-dist__step-label {
  color: #94a3b8;

  font-weight: 600;
}

.hyve-dist__step--danger
.hyve-dist__step-label {
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

.hyve-dist__eval-title {
  font-size: 24px;

  font-weight: 800;

  color: #0f172a;

  margin: 0 0 12px;

  letter-spacing:
    -0.02em;

  text-align: center;
}

.hyve-dist__eval-desc {
  font-size: 14.5px;

  color: #475569;

  line-height: 1.6;

  max-width: 600px;

  margin:
    0 auto 36px;

  text-align: center;
}

.hyve-dist__eval-desc strong {
  color: #0f172a;

  font-weight: 700;
}

/* Rejection */

.hyve-dist__rejection-banner {
  max-width: 620px;

  margin:
    0 auto 30px;

  background: #fef2f2;

  border:
    1px solid
    #fecaca;

  border-radius: 12px;

  padding: 16px 20px;

  display: flex;

  align-items: flex-start;

  gap: 12px;

  text-align: left;

  box-shadow:
    0 1px 3px
    rgba(
      239,
      68,
      68,
      0.05
    );
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

/* Evaluation Card */

.hyve-dist__eval-card {
  max-width: 620px;

  margin: 0 auto;

  background: #ffffff;

  border:
    1px solid
    #e2e8f0;

  border-radius: 14px;

  padding: 22px 26px;

  box-shadow:
    0 1px 3px
    rgba(
      0,
      0,
      0,
      0.02
    );

  text-align: left;
}

.hyve-dist__eval-grid {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap:
    20px 32px;
}

.hyve-dist__eval-item {
  display: flex;

  flex-direction: column;

  gap: 4px;
}

.hyve-dist__eval-label {
  font-size: 11px;

  font-weight: 700;

  letter-spacing:
    0.06em;

  text-transform:
    uppercase;

  color: #94a3b8;
}

.hyve-dist__eval-val {
  font-size: 14.5px;

  font-weight: 700;

  color: #0f172a;

  word-break:
    break-word;
}

.hyve-dist__eval-website {
  color: #0284c7;

  font-weight: 700;

  text-decoration: none;

  word-break:
    break-all;
}

.hyve-dist__eval-website:hover {
  text-decoration:
    underline;

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

  transition:
    color 0.15s ease;
}

.hyve-dist__eval-back:hover {
  color: #0f172a;

  text-decoration:
    underline;
}

/* Address */

.hyve-dist__address-section {
  display: flex;

  flex-direction: column;

  gap: 12px;
}

.hyve-dist__address-heading {
  display: flex;

  align-items: flex-start;

  justify-content:
    space-between;

  gap: 12px;
}

.hyve-dist__address-help {
  margin:
    4px 0 0;

  font-size: 11.5px;

  line-height: 1.45;

  color: var(--dist-muted);
}

.hyve-dist__address-grid {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap: 12px;
}

.hyve-dist__field--address-full {
  grid-column:
    1 / -1;
}

.hyve-dist__field-error {
  margin-top: 1px;

  font-size: 11.5px;

  line-height: 1.4;

  color: #dc2626;
}

.hyve-dist__field-error[hidden] {
  display: none;
}

.hyve-dist__input[
  aria-invalid="true"
],
.hyve-dist__select[
  aria-invalid="true"
] {
  border-color:
    #dc2626;

  box-shadow:
    0 0 0 3px
    rgba(
      220,
      38,
      38,
      0.08
    );
}

/* Responsive */

@media (
  max-width: 960px
) {
  .hyve-dist__grid-2 {
    grid-template-columns:
      1fr;

    gap: 18px;
  }

  .hyve-dist__summary-grid {
    grid-template-columns:
      1fr;
  }
}

@media (
  max-width: 640px
) {
  .hyve-dist__address-grid {
    grid-template-columns:
      1fr;
  }

  .hyve-dist__field--address-full {
    grid-column: auto;
  }

  .hyve-dist__eval-body {
    padding:
      30px
      16px
      40px;
  }

  .hyve-dist__eval-banner {
    padding:
      12px 16px;
  }

  .hyve-dist__eval-banner-title {
    font-size: 13.5px;
  }

  .hyve-dist__eval-badge {
    font-size: 11.5px;

    padding:
      3.5px 10px;
  }

  .hyve-dist__eval-title {
    font-size: 20px;
  }

  .hyve-dist__eval-desc {
    font-size: 13.5px;

    margin-bottom: 28px;
  }

  .hyve-dist__eval-card {
    padding:
      18px 18px;
  }

  .hyve-dist__eval-grid {
    grid-template-columns:
      1fr;

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

  .hyve-dist__form-card {
    padding:
      18px 14px;
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
    flex-direction:
      column;

    align-items:
      flex-start;

    gap: 8px;
  }

  .hyve-dist__markets-grid,
  .hyve-dist__markets-grid--wide {
    grid-template-columns:
      1fr;
  }

  .hyve-dist__terms-header {
    flex-direction:
      column;

    align-items:
      flex-start;
  }

  .hyve-dist__dropzone {
    min-height: 160px;

    padding:
      24px 14px;
  }

  .hyve-dist__actions {
    flex-direction:
      column-reverse;

    gap: 8px;
  }

  .hyve-dist__btn {
    width: 100%;
  }

  .hyve-dist__summary-card {
    padding:
      18px 14px;
  }

  .hyve-dist__summary-foot {
    flex-direction:
      column;

    align-items:
      stretch;
  }
}

/* Toast */

.hyve-dist__toast {
  display: flex;

  align-items: center;

  gap: 10px;

  padding:
    12px 16px;

  border-radius: 10px;

  margin-bottom: 20px;

  font-size: 13px;

  font-weight: 600;

  animation:
    hyveFadeIn
    0.25s ease;
}

.hyve-dist__toast--success {
  background: #ecfdf3;

  color: #15803d;

  border:
    1px solid
    #bbf7d0;
}

.hyve-dist__toast--error {
  background: #fef2f2;

  color: #b91c1c;

  border:
    1px solid
    #fecaca;
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

@keyframes hyveFadeIn {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

</style>`;


const DISTRIBUTOR_SCRIPT = `
<script>
(() => {

  const form =
    document.getElementById(
      'hyve-distributor-form'
    );

  const submitBtn =
    document.getElementById(
      'dist-submit-btn'
    );

  const creditToggle =
    document.getElementById(
      'dist-credit-toggle'
    );

  const creditFields =
    document.getElementById(
      'dist-credit-fields'
    );

  const creditReqStars =
    document.querySelectorAll(
      '.dist-credit-req'
    );

  const conditionalInputs =
    document.querySelectorAll(
      '.js-credit-field'
    );

  const fileInput =
    document.getElementById(
      'dist-file-input'
    );

  const dropzoneLabel =
    document.getElementById(
      'dist-dropzone-label'
    );

  const marketPills =
    document.querySelectorAll(
      '.hyve-dist__market-pill'
    );

  /* -------------------------------------------------------
   * Registered Address
   * ------------------------------------------------------- */

  const addressCountry =
    document.getElementById(
      'dist-address-country'
    );

  const addressProvince =
    document.getElementById(
      'dist-address-province'
    );

  const addressProvinceCode =
    document.getElementById(
      'dist-address-province-code'
    );

  const distributorStates =
    ${JSON.stringify(DISTRIBUTOR_STATES)};

  /**
   * Populate State / Province dropdown using
   * the selected country.
   */
  function populateAddressStates(
    preserveCurrentValue = false
  ) {
    if (
      !addressCountry ||
      !addressProvince
    ) {
      return;
    }

    const country =
      addressCountry.value;

    const states =
      distributorStates[
        country
      ] || [];

    const currentState =
      preserveCurrentValue
        ? (
            addressProvince
              .dataset
              .currentState ||
            ''
          )
        : '';

    addressProvince.innerHTML =
      '';

    const placeholder =
      document.createElement(
        'option'
      );

    placeholder.value =
      '';

    placeholder.textContent =
      country
        ? 'Select state / province…'
        : 'Select country first…';

    addressProvince.appendChild(
      placeholder
    );

    if (!country) {
      addressProvince.disabled =
        true;

      if (
        addressProvinceCode
      ) {
        addressProvinceCode.value =
          '';
      }

      return;
    }

    addressProvince.disabled =
      false;

    states.forEach(
      (state) => {
        const option =
          document.createElement(
            'option'
          );

        option.value =
          state.name;

        option.textContent =
          state.name;

        option.dataset.stateCode =
          state.code ||
          '';

        if (
          currentState &&
          currentState ===
            state.name
        ) {
          option.selected =
            true;
        }

        addressProvince.appendChild(
          option
        );
      }
    );

    /**
     * Preserve previously saved/submitted
     * province even if the subdivision package
     * data changes.
     */
    if (
      currentState &&
      !states.some(
        (state) =>
          state.name ===
          currentState
      )
    ) {
      const option =
        document.createElement(
          'option'
        );

      option.value =
        currentState;

      option.textContent =
        currentState;

      option.selected =
        true;

      option.dataset.stateCode =
        addressProvinceCode
          ?.value ||
        '';

      addressProvince.appendChild(
        option
      );
    }

    const selectedOption =
      addressProvince
        .selectedOptions[0];

    if (
      addressProvinceCode
    ) {
      if (
        selectedOption?.value
      ) {
        addressProvinceCode.value =
          selectedOption
            .dataset
            .stateCode ||
          '';
      } else if (
        !preserveCurrentValue
      ) {
        addressProvinceCode.value =
          '';
      }
    }
  }

  if (
    addressCountry &&
    addressProvince
  ) {

    /**
     * Country changed
     */
    addressCountry.addEventListener(
      'change',
      () => {
        addressProvince.dataset.currentState =
          '';

        if (
          addressProvinceCode
        ) {
          addressProvinceCode.value =
            '';
        }

        populateAddressStates(
          false
        );
      }
    );

    /**
     * State / Province changed
     */
    addressProvince.addEventListener(
      'change',
      () => {
        const selectedOption =
          addressProvince
            .selectedOptions[0];

        if (
          addressProvinceCode
        ) {
          addressProvinceCode.value =
            selectedOption
              ?.dataset
              ?.stateCode ||
            '';
        }
      }
    );

    /**
     * Initial population.
     */
    populateAddressStates(
      true
    );
  }

  /* -------------------------------------------------------
   * Markets
   * ------------------------------------------------------- */

  marketPills.forEach(
    (pill) => {
      const checkbox =
        pill.querySelector(
          'input[type="checkbox"]'
        );

      if (!checkbox) {
        return;
      }

      checkbox.addEventListener(
        'change',
        () => {
          if (
            checkbox.checked
          ) {
            pill.classList.add(
              'is-checked'
            );
          } else {
            pill.classList.remove(
              'is-checked'
            );
          }
        }
      );
    }
  );

  /* -------------------------------------------------------
   * Credit Terms & Conditional Validation
   * ------------------------------------------------------- */

  function updateCreditFields() {
    if (
      !creditToggle ||
      !creditFields
    ) {
      return;
    }

    const isEnabled = creditToggle.checked;

    creditFields.style.display = isEnabled ? 'grid' : 'none';

    creditReqStars.forEach((star) => {
      star.style.display = isEnabled ? '' : 'none';
    });

    conditionalInputs.forEach((input) => {
      if (isEnabled) {
        input.setAttribute('required', '');
      } else {
        input.removeAttribute('required');
        input.removeAttribute('aria-invalid');
      }
    });

    if (!isEnabled) {
      const creditErrors = creditFields.querySelectorAll('.hyve-dist__field-error');
      creditErrors.forEach((err) => {
        err.hidden = true;
      });
    }
  }

  if (
    creditToggle &&
    creditFields
  ) {
    creditToggle.addEventListener(
      'change',
      updateCreditFields
    );

    updateCreditFields();
  }

  /* -------------------------------------------------------
   * File Upload
   * ------------------------------------------------------- */

  const dropzone =
    document.getElementById(
      'dist-dropzone'
    );

  if (
    fileInput &&
    dropzoneLabel
  ) {
    fileInput.addEventListener(
      'change',
      () => {
        if (
          fileInput.files &&
          fileInput.files[0]
        ) {
          dropzoneLabel.textContent =
            'Selected: ' +
            fileInput
              .files[0]
              .name;
        }
      }
    );
  }

  if (
    dropzone &&
    fileInput
  ) {

    [
      'dragenter',
      'dragover',
    ].forEach(
      (name) => {
        dropzone.addEventListener(
          name,
          (event) => {
            event.preventDefault();

            dropzone.style.borderColor =
              '#0f172a';

            dropzone.style.background =
              '#f1f5f9';
          }
        );
      }
    );

    [
      'dragleave',
      'drop',
    ].forEach(
      (name) => {
        dropzone.addEventListener(
          name,
          (event) => {
            event.preventDefault();

            dropzone.style.borderColor =
              '#cbd5e1';

            dropzone.style.background =
              '#f8fafc';
          }
        );
      }
    );

    dropzone.addEventListener(
      'drop',
      (event) => {
        if (
          event.dataTransfer &&
          event.dataTransfer.files &&
          event.dataTransfer.files.length
        ) {
          fileInput.files =
            event
              .dataTransfer
              .files;

          if (
            dropzoneLabel
          ) {
            dropzoneLabel.textContent =
              'Selected: ' +
              event
                .dataTransfer
                .files[0]
                .name;
          }
        }
      }
    );
  }

  /* -------------------------------------------------------
   * Form Submit
   * ------------------------------------------------------- */

  if (
    form &&
    submitBtn
  ) {
    form.addEventListener(
      'submit',
      () => {
        setTimeout(
          () => {
            submitBtn.disabled =
              true;

            const span =
              submitBtn.querySelector(
                'span'
              );

            if (
              span
            ) {
              span.textContent =
                'Submitting...';
            }
          },
          0
        );
      }
    );
  }

  const toast =
    document.querySelector(
      '.hyve-dist__toast'
    );

  if (
    toast
  ) {
    setTimeout(
      () => {
        toast.style.opacity =
          '0';

        toast.style.transition =
          'opacity 0.5s ease';

        setTimeout(
          () => {
            toast.remove();
          },
          500
        );
      },
      4500
    );
  }

})();
</script>`;