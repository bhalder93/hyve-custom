/**
 * Expired quotes.
 *
 * A quote is a Shopify draft order, and a draft order has no expiry: its
 * payment link keeps working for ever. So a quote is expired by deleting it,
 * which genuinely stops the link — but deleting it would also erase the record,
 * leaving the distributor with a quote that silently vanished and no way to ask
 * for a new one.
 *
 * A scheduled Shopify Flow therefore copies each quote into an `expired_quote`
 * record just before deleting it, and this reads those back so the Quotes page
 * can still show it as expired with a Requote, and the Retrieve page can say
 * "this expired on the 6th" rather than "no such quote".
 *
 * The shape Flow writes, which this expects:
 *   quote_number  "#D21"
 *   quote_date    the date the quote was raised, ISO 8601
 *   customer      {"id": "gid://shopify/Customer/123", "email": "...", "name": "..."}
 *   line_items    [{"title": "...", "quantity": 25, "total": "30.25"}]
 *   total         money, Shopify's {"amount": "30.25", "currency_code": "USD"}
 */
import { formatMoney, formatDate } from "./portal.server";

const TYPE = "expired_quote";

const LIST_QUERY = `#graphql
  query ExpiredQuotes($after: String) {
    metaobjects(type: "${TYPE}", first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        fields { key value }
      }
    }
  }`;

/** Stop rather than walk an unbounded archive. */
const MAX_PAGES = 4;

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** One record, in the shape the pages render. */
function toQuote(node) {
  const fields = Object.fromEntries((node.fields || []).map((f) => [f.key, f.value]));
  const customer = parseJson(fields.customer, {});
  const money = parseJson(fields.total, {});
  const lines = parseJson(fields.line_items, []);

  const reference = String(fields.quote_number || "").replace(/^#D/, "Q-");

  return {
    id: node.id,
    reference,
    quoteNumber: String(fields.quote_number || ""),
    customerId: customer.id || "",
    email: String(customer.email || "").toLowerCase(),
    customerName: customer.name || "",
    expiredAt: fields.quote_date || "",
    date: formatDate(fields.quote_date),
    total: formatMoney(money.amount, money.currency_code),
    lines: Array.isArray(lines) ? lines : [],
    items: (Array.isArray(lines) ? lines : [])
      .map((line) => `${line.title}${line.quantity > 1 ? ` x${line.quantity}` : ""}`)
      .join(" + "),
  };
}

async function readAll(admin) {
  const found = [];
  let after = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await admin.graphql(LIST_QUERY, { variables: { after } });
    const body = await response.json();
    if (body?.errors) {
      console.warn("[expired-quotes] read failed", JSON.stringify(body.errors));
      break;
    }

    const block = body?.data?.metaobjects;
    for (const node of block?.nodes || []) found.push(toQuote(node));

    if (!block?.pageInfo?.hasNextPage) break;
    after = block.pageInfo.endCursor;
  }

  return found;
}

/**
 * The expired quotes belonging to one buyer, newest first.
 * @param {string} customerGid
 * @param {string} [email] matched as well, for a quote sent to someone who has
 *   no customer record of their own
 */
export async function listExpiredQuotes(admin, customerGid, email = "") {
  if (!admin || (!customerGid && !email)) return [];

  const wanted = String(email || "").toLowerCase();
  const all = await readAll(admin);

  return all
    .filter((quote) => (customerGid && quote.customerId === customerGid) || (wanted && quote.email === wanted))
    .sort((a, b) => String(b.expiredAt).localeCompare(String(a.expiredAt)));
}

/**
 * One expired quote by its number and the email it was sent to — the same proof
 * the Retrieve page asks for on a live quote.
 *
 * Matched on the digits, because the archive records whatever Shopify called
 * the draft ("#D21" on most stores, "#21" on others) while the caller has only
 * what the buyer typed.
 * @param {string} quoteNumber the digits of the quote number
 */
export async function findExpiredQuote(admin, quoteNumber, email) {
  const wantedNumber = String(quoteNumber || "").replace(/\D/g, "");
  if (!admin || !wantedNumber || !email) return null;

  const wanted = String(email).toLowerCase();
  const all = await readAll(admin);

  return (
    all.find(
      (quote) =>
        String(quote.quoteNumber || "").replace(/\D/g, "") === wantedNumber &&
        quote.email === wanted,
    ) || null
  );
}
