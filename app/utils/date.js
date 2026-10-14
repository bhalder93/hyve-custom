/** Shared Singapore calendar and display policy for admin, portal, emails and documents.
 * Display: "14 Oct 2026" or "14 Oct 2026, 14:30" (24-hour Singapore time).
 * Keep ISO values for APIs, storage and date inputs; format only at display boundaries.
 */
export const TIMEZONE = "Asia/Singapore";
const DAY_MS = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let input = typeof value === "string" ? value.trim() : value;
  if (typeof input === "string") {
    // Older stored application dates can use month-first English text.
    const legacy = input.match(/^([A-Za-z]{3}) (\d{1,2}),? (\d{4})$/);
    if (legacy) input = legacy[2] + " " + legacy[1] + " " + legacy[3];
    input = normalizeDateInput(input);
    if (/^\d{1,2} [A-Za-z]{3} \d{4}$/.test(input)) return null;
    const day = input.match(/^\d{4}-\d{2}-\d{2}(?=$|[T ])/);
    if (day && !isValidDay(day[0])) return null;
  }
  // An unzoned date/time represents Singapore wall time, never host-local time.
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) input += "T00:00:00+08:00";
  else if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(input)) input += "+08:00";
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** ISO calendar day in Singapore, for comparisons, inputs and filenames. */
export function singaporeDateKey(value = new Date(), fallback = "") {
  const date = parseDate(value);
  if (!date) return fallback;
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIMEZONE,
  }).formatToParts(date);
  const part = (type) => parts.find((p) => p.type === type).value;
  return part("year") + "-" + part("month") + "-" + part("day");
}

/** Stable English month abbreviations, including Sep (never locale-dependent Sept). */
export function formatDate(value, fallback = "—") {
  const date = parseDate(value);
  if (!date) return fallback;
  const key = singaporeDateKey(date);
  const [year, month, day] = key.split("-");
  return Number(day) + " " + MONTHS[Number(month) - 1] + " " + year;
}

export function formatDay(value, fallback = "—") {
  return formatDate(value, fallback);
}

export function formatTime(value, fallback = "—") {
  const date = parseDate(value);
  if (!date) return fallback;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TIMEZONE,
  }).format(date);
}

export function formatDateTime(value, fallback = "—") {
  const date = parseDate(value);
  return date ? formatDate(date) + ", " + formatTime(date) : fallback;
}

/** Calendar days from reference to value, using Singapore day boundaries. */
export function singaporeDayDiff(value, reference = new Date()) {
  const day = singaporeDateKey(value, "");
  if (!parseDate(value)) return null;
  const base = singaporeDateKey(reference);
  return day && base ? (Date.parse(day) - Date.parse(base)) / DAY_MS : null;
}

/** Calendar-day arithmetic is independent of the machine's timezone or DST. */
export function addCalendarDays(value, days) {
  const date = parseDate(value);
  return date ? new Date(date.getTime() + days * DAY_MS).toISOString() : null;
}

function isValidDay(key) {
  const date = new Date(key + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key;
}

/** Accept the display format and legacy ISO dates; preserve invalid input for validation. */
export function normalizeDateInput(value) {
  const input = String(value ?? "").trim();
  const match = input.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
  if (!match) return input;
  const month = MONTHS.findIndex((m) => m.toLowerCase() === match[2].toLowerCase()) + 1;
  const key = match[3] + "-" + String(month).padStart(2, "0") + "-" + match[1].padStart(2, "0");
  return month && isValidDay(key) ? key : input;
}
