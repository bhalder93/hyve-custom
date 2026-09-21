export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "en-SG",
    {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Singapore",
    },
  ).format(date);
}

export function parseEmailList(value) {
  if (!value) return [];

  return String(value)
    .split(",")
    .map(
      (email) =>
        email.trim(),
    )
    .filter(Boolean);
}

export function metafieldValue(
  metafield,
) {
  return metafield?.value ?? null;
}

export function buildOrderStatusUrl(
  order,
) {
  const base =
    process.env
      .HYVE_ORDER_STATUS_BASE_URL;

  if (!base) return null;

  return `${base}?order=${encodeURIComponent(
    order.name,
  )}`;
}