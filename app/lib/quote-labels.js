/**
 * Quote names and statuses as Hyve Custom shows them, on the dashboard and the
 * Quotes page alike (HYV-165). Safe for the browser: no server code here.
 */

/** "#D85" as the buyer sees it: "Q-85". */
export function quoteReference(name) {
  const raw = String(name || "");
  if (raw.startsWith("#D")) return `Q-${raw.slice(2)}`;
  if (raw.startsWith("#")) return `Q-${raw.slice(1)}`;
  return raw || "Quote";
}

export const STAFF_QUOTE_LABELS = {
  created: "Created",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};
export const STAFF_QUOTE_TONES = {
  created: "info",
  sent: "info",
  accepted: "success",
  declined: "critical",
  expired: "neutral",
};
