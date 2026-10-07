import { ADDRESS_FORMATS } from "./address-formats.data";
import { phoneE164 } from "./phone";

/**
 * Shopify's address rules for the distributor application (HYV-143): which
 * fields each country has, what they're called and the region list, from
 * Shopify's own address data (address-formats.data.js). The form, the server
 * check and the address sent to Shopify at approval all read them, so an
 * address the form accepts is one Shopify takes.
 *
 * Every field a country shows is required except Apartment, suite, etc.
 */

const byCode = new Map(Object.entries(ADDRESS_FORMATS).map(([name, format]) => [format.code, { name, ...format }]));

/** The format for a country given by the form's name ("Hong Kong") or its code ("HK"). */
export function addressFormatFor(country) {
  const value = String(country || "").trim();
  if (ADDRESS_FORMATS[value]) return { name: value, ...ADDRESS_FORMATS[value] };
  return byCode.get(value.toUpperCase()) || null;
}

/**
 * Field errors for a registered address, keyed as the form shows them
 * ("registeredAddress.city"). Empty when the address is complete.
 */
export function addressErrors(address) {
  const errors = {};
  const format = addressFormatFor(address?.country);
  if (!format) {
    errors["registeredAddress.country"] = "Choose the country of your registered address.";
    return errors;
  }
  for (const key of format.rows.flat()) {
    if (key === "address2") continue;
    if (!String(address?.[key] || "").trim()) {
      errors[`registeredAddress.${key}`] = `${format.labels[key]} is required.`;
    }
  }
  if (format.zones.length && address?.province) {
    const zone = format.zones.find((z) => z.name === address.province || z.code === address.provinceCode);
    if (!zone) errors["registeredAddress.province"] = `Choose a ${format.labels.province.toLowerCase()} from the list.`;
  }
  return errors;
}

/**
 * The address with only the fields its country has, and the region's
 * Shopify code filled in from its name.
 */
export function cleanAddress(address) {
  const format = addressFormatFor(address?.country);
  const keys = new Set(format ? format.rows.flat() : ["address1", "address2", "city", "province", "zip"]);
  const pick = (key) => (keys.has(key) ? String(address?.[key] || "").trim() : "");
  const zone = format?.zones.find((z) => z.name === address?.province || z.code === address?.provinceCode);
  return {
    address1: pick("address1"),
    address2: pick("address2"),
    barangay: pick("barangay"),
    city: pick("city"),
    country: format?.name || String(address?.country || "").trim(),
    countryCode: format?.code || "",
    province: zone ? zone.name : pick("province"),
    provinceCode: zone ? zone.code : "",
    zip: pick("zip"),
    phone: String(address?.phone || "").trim(),
  };
}

/**
 * Shopify's company address input. A company address has no separate
 * Barangay field, so it's added to the apartment line.
 */
export function shopifyAddressInput(address) {
  const clean = cleanAddress(address);
  const address2 = [clean.address2, clean.barangay].filter(Boolean).join(", ");
  return {
    address1: clean.address1,
    ...(address2 ? { address2 } : {}),
    ...(clean.city ? { city: clean.city } : {}),
    ...(clean.provinceCode ? { zoneCode: clean.provinceCode } : {}),
    ...(clean.zip ? { zip: clean.zip } : {}),
    countryCode: clean.countryCode,
  };
}

/**
 * A phone number in the international form Shopify asks for on addresses
 * (+85245346363). Applicants type local numbers ("4534 6363", "0917 123 4567"),
 * so the country's dialling code is added, dropping a leading trunk 0. A number
 * already starting with + or 00 is kept as it is.
 */
export function internationalPhone(phone, country) {
  // Checked as Shopify checks it: "" when it isn't a real number for the
  // country, so callers leave it out rather than have Shopify refuse the
  // whole address.
  const code = addressFormatFor(country)?.code || String(country || "").toUpperCase();
  return phoneE164(String(phone || "").trim().replace(/^00/, "+"), code);
}
