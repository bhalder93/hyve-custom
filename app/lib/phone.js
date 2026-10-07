import { parsePhoneNumberFromString } from "libphonenumber-js/min";

/**
 * Phone numbers checked the way Shopify checks them (HYV-143). Shopify refuses
 * an address phone that isn't a real number for its country ("Phone is
 * invalid"), and a loose "digits and spaces" test let through numbers like
 * 756465365564, which became +852 756465365564: too long for Hong Kong.
 * Safe for the browser and the server.
 */

/**
 * The number in international form (+85223456789), or "" when it isn't a
 * valid number. A local number ("2345 6789") is read as the country's;
 * without a country it must start with +.
 *
 * @param {string} phone
 * @param {string} [countryCode] ISO code such as "HK"
 */
export function phoneE164(phone, countryCode) {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  const parsed = parsePhoneNumberFromString(raw, countryCode ? String(countryCode).toUpperCase() : undefined);
  return parsed?.isValid() ? parsed.number : "";
}

/** Whether Shopify will take this as the country's phone number. */
export function validPhone(phone, countryCode) {
  return Boolean(phoneE164(phone, countryCode));
}
