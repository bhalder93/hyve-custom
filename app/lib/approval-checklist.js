import { validPhone } from "./phone.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What the distributor approval form still needs before Approve can go
 * through (HYV-143), in the words the form uses. Empty when complete.
 *
 * Company shipping address and address phone are optional. If a street
 * address is entered, the required address fields for that country must be
 * completed. Any phone entered must be a valid number for that country.
 * A sales rep with a valid email is always required. The WhatsApp number
 * is optional but must be a real number with its country code.
 *
 * @param {object|null} format the country's entry from address-formats.data
 * @param {object} values address fields, phone, salesRep, salesRepEmail, salesRepPhone
 */
export function approvalMissing(format, values) {
  const text = (key) => String(values?.[key] || "").trim();
  const missing = [];
  const hasAddress = Boolean(text("address1"));

  if (hasAddress) {
    if (!format) missing.push("Country/region");
    const labels = format?.labels || {};
    const rows = format?.rows || [["address1"], ["address2"], ["city", "province", "zip"]];
    for (const key of rows.flat()) {
      if (key === "address2") continue;
      if (key === "province") {
        if (!(format?.zones || []).some((zone) => zone.name === text("province"))) missing.push(labels.province || "Region");
        continue;
      }
      if (!text(key)) missing.push(labels[key] || key);
    }
  }

  if (text("phone") && !validPhone(text("phone"), format?.code)) {
    missing.push(`a valid ${format?.name || ""} phone number`.replace("  ", " "));
  }
  if (!text("salesRep")) missing.push("Sales representative name");
  if (!text("salesRepEmail")) missing.push("Sales representative email");
  else if (!EMAIL_PATTERN.test(text("salesRepEmail"))) missing.push("a valid sales representative email");
  // The rep's own number, which can be in any country, so it needs its +code.
  if (text("salesRepPhone") && !validPhone(text("salesRepPhone"))) {
    missing.push("a valid WhatsApp number (or leave it empty)");
  }
  return missing;
}
