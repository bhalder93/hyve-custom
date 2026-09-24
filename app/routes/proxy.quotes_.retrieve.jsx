import { authenticate } from "../shopify.server";
import { retrieveQuotePage, retrievedQuotePage, expiredQuotePage } from "../lib/quote-retrieve.server";
import { findExpiredQuote } from "../lib/expired-quotes.server";
import { QUOTE_OWNER_FIELDS, quoteEmails } from "../lib/quote-document.server";
import { formatMoney, formatDate } from "../lib/portal.server";

/**
 * Retrieve a Quote.
 * Storefront: /apps/account/quotes/retrieve
 *
 * The person approving a quote is usually at the distributor's client and has
 * no account, so this page is reachable signed out. Quote number plus the email
 * the quote was sent to is what proves it is theirs.
 */

/**
 * Finding a quote by its number.
 *
 * Shopify's draft order search ignores `name:` and `email:` — both return every
 * draft regardless of what is asked for, so filtering has to happen here. Only
 * the identifying fields are read while looking, and the quote itself is
 * fetched once by id after it is found.
 */
const FIND_QUERY = `#graphql
  query FindQuote($after: String) {
    draftOrders(first: 250, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        email
        ${QUOTE_OWNER_FIELDS}
      }
    }
  }`;

const QUOTE_QUERY = `#graphql
  query RetrievedQuote($id: ID!) {
    draftOrder(id: $id) {
      id
      name
      email
      status
      createdAt
      invoiceUrl
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 50) {
        nodes {
          title
          quantity
          discountedTotalSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }`;

/** Stop rather than walk a store's entire quote history on a wrong guess. */
const MAX_PAGES = 8;

/**
 * Quotes are shown as "Q-15", but Shopify names the draft behind them "#D15" on
 * most stores and "#15" on others, and people retype the reference in every
 * shape. So the comparison is on the digits alone rather than on a prefix we
 * would have to guess — the quotes list already accepts both spellings, and
 * this has to agree with it or a real quote reads as "not found".
 */
function quoteDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export const loader = async ({ request }) => {
  const { liquid } = await authenticate.public.appProxy(request);
  return liquid(retrieveQuotePage());
};

export const action = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  const form = await request.formData();
  const reference = String(form.get("reference") || "").trim();
  const email = String(form.get("email") || "").trim();
  const wantsPdf = String(form.get("intent") || "") === "pdf";

  // One message for "no such quote" and "wrong email" alike, so the form can't
  // be used to discover which quote numbers exist.
  const notFound = () =>
    liquid(
      retrieveQuotePage({
        reference,
        email,
        error: "We couldn't find a quote with that number and email address. Please check both and try again.",
      }),
    );

  try {
    const wantedNumber = quoteDigits(reference);
    if (!wantedNumber || !email) return notFound();

    const wanted = email.toLowerCase();
    let match = null;
    let after = null;

    for (let page = 0; page < MAX_PAGES && !match; page += 1) {
      const response = await admin.graphql(FIND_QUERY, { variables: { after } });
      const body = await response.json();
      if (body?.errors) {
        console.warn("[quote-retrieve] lookup failed", JSON.stringify(body.errors));
        return notFound();
      }

      const page_ = body?.data?.draftOrders;
      // A quote raised from a company account carries the company, not an
      // email of its own, so the person it was raised for counts too.
      match = (page_?.nodes || []).find(
        (draft) => quoteDigits(draft.name) === wantedNumber && quoteEmails(draft).includes(wanted),
      );
      if (match || !page_?.pageInfo?.hasNextPage) break;
      after = page_.pageInfo.endCursor;
    }

    if (!match) {
      // A quote past its validity was deleted, so say so plainly rather than
      // implying the number was wrong.
      const lapsed = await findExpiredQuote(admin, wantedNumber, email);
      if (lapsed) return liquid(expiredQuotePage(lapsed));
      return notFound();
    }

    if (wantsPdf) {
      // The same renderer the portal uses, proving ownership with the email
      // rather than a sign-in.
      const { loadQuoteDocument } = await import("../lib/quote-document.server");
      const doc = await loadQuoteDocument(admin, match.id, { email });
      if (!doc) return notFound();

      const { buildQuotePdf } = await import("../lib/quote-pdf.server.jsx");
      const pdf = await buildQuotePdf(doc);
      const filename = `${String(doc.ref).replace(/[^A-Za-z0-9._-]/g, "")}.pdf`;

      return new Response(pdf, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(pdf.length),
          "Cache-Control": "no-store",
        },
      });
    }

    // Found it — now read the quote itself, by id.
    const full = await admin.graphql(QUOTE_QUERY, { variables: { id: match.id } });
    const fullBody = await full.json();
    const node = fullBody?.data?.draftOrder;
    if (!node) return notFound();

    const money = node.totalPriceSet?.shopMoney || {};

    return liquid(
      retrievedQuotePage({
        reference: node.name.replace(/^#D/, "Q-"),
        email,
        createdAt: formatDate(node.createdAt),
        status: node.status === "COMPLETED" ? "Already ordered" : "",
        total: formatMoney(money.amount, money.currencyCode),
        // A completed quote is already an order, so there is nothing to pay.
        invoiceUrl: node.status === "COMPLETED" ? "" : node.invoiceUrl || "",
        lines: (node.lineItems?.nodes || []).map((line) => ({
          title: line.title,
          quantity: line.quantity,
          total: formatMoney(
            line.discountedTotalSet?.shopMoney?.amount,
            line.discountedTotalSet?.shopMoney?.currencyCode,
          ),
        })),
      }),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[quote-retrieve] failed", error);
    return notFound();
  }
};
