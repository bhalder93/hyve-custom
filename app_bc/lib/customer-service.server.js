/**
 * How to reach Hyve customer service (HYV-97).
 *
 * WhatsApp is the primary channel for this distributor base, email the
 * fallback. Both, and the one set of advertised hours, are set once in the
 * theme (Theme settings > Hyve: Customer service), which the storefront footer,
 * cart and contact pages read too.
 *
 * Portal pages are rendered by the theme (application/liquid), so these are
 * Liquid that Shopify fills in from those settings. They only work inside a
 * portal page, not in an email or a JSON response.
 */

/** The wa.me link that opens a chat with the customer service number. */
export const WHATSAPP_URL = `{% render 'hyve-whatsapp-url' %}`;

export const WHATSAPP_DISPLAY = "{{ settings.hyve_whatsapp | escape }}";

export const SUPPORT_EMAIL = "{{ settings.hyve_support_email | escape }}";

export const SERVICE_HOURS = "{{ settings.hyve_service_hours | escape }}";
