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
/**
 * Clean and refine phone number input, stripping dashes, spaces, and extraneous punctuation
 * while preserving leading + or 00.
 */
export function refinePhone(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";

  const withPlus = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
  const hasPlus = withPlus.startsWith("+");
  const digits = withPlus.replace(/\D/g, "");

  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

export function phoneE164(phone, countryCode) {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  const code = countryCode ? String(countryCode).toUpperCase() : undefined;

  let parsed = parsePhoneNumberFromString(raw, code);
  if (parsed?.isValid()) return parsed.number;

  const refined = refinePhone(raw);
  if (refined && refined !== raw) {
    parsed = parsePhoneNumberFromString(refined, code);
    if (parsed?.isValid()) return parsed.number;
  }

  if (refined.startsWith("00")) {
    parsed = parsePhoneNumberFromString("+" + refined.slice(2));
    if (parsed?.isValid()) return parsed.number;
  }

  if (!refined.startsWith("+")) {
    parsed = parsePhoneNumberFromString("+" + refined);
    if (parsed?.isValid()) return parsed.number;
  }

  return "";
}

/** Whether Shopify will take this as the country's phone number. */
export function validPhone(phone, countryCode) {
  return Boolean(phoneE164(phone, countryCode));
}
