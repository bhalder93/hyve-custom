import { authenticate } from "../shopify.server";
import { listExpiredQuotes } from "../lib/expired-quotes.server";
import { accountShell } from "../lib/account-shell.server";
import { distributorOnly } from "../lib/account-error.server";
import { portalChrome } from "../lib/account-data.server";
import {
  mapDraftOrdersToQuotes,
  expiredQuoteToRow,
  quotesPage,
} from "../lib/account-quotes.server";
import { purchasingCompanyFor, purchasingEntity } from "../lib/purchasing-company.server";
import { notifyQuoteRaised } from "../lib/quote-notification.server";

const ADMIN_TIMEOUT_MS = 4500;

/** Everything a quote row needs, shared by the two ways of reaching them. */
const QUOTE_FIELDS = `#graphql
  fragment QuoteRow on DraftOrder {
    id
    name
    createdAt
    status
    invoiceUrl
    invoiceSentAt
    hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
    totalPriceSet { shopMoney { amount currencyCode } }
    lineItems(first: 20) {
      nodes {
        title
        quantity
        originalUnitPriceSet { shopMoney { amount currencyCode } }
      }
    }
    order { id name }
    tags
    customAttributes { key value }
  }`;

/** The company's quotes — what everyone on the account sees. */
const COMPANY_QUOTES_QUERY = `#graphql
  query GetCompanyDraftOrders($id: ID!) {
    company(id: $id) {
      draftOrders(first: 50, sortKey: UPDATED_AT, reverse: true) {
        nodes { ...QuoteRow }
      }
    }
  }
  ${QUOTE_FIELDS}`;

/** One person's own quotes, for a shopper with no company. */
const CUSTOMER_QUOTES_QUERY = `#graphql
  query GetCustomerDraftOrders($query: String!) {
    draftOrders(first: 50, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes { ...QuoteRow }
    }
  }
  ${QUOTE_FIELDS}`;

export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");

    // A2: distributor pages are visible only to approved distributor accounts.
    // The nav hides the link, but the URL still resolves, so gate the page too.
    const chrome = await portalChrome(admin, customerId);
    if (!chrome.isDistributor) {
      return liquid(
        accountShell({ active: "quotes", main: distributorOnly("Quotes"), ...chrome }),
      );
    }
    const notice = url.searchParams.get("notice");
    const errorParam = url.searchParams.get("error");
    let draftOrderNodes = [];

    if (customerId) {
      try {
        // Everyone on a company works from the same quotes, so these are read
        // from the company. Someone with no company sees their own.
        const numericCustId = customerId.replace(/\D/g, "");
        const email = chrome.customer?.email || "";
        const draftSearchQuery = email
          ? `customer_id:${numericCustId} OR email:${email}`
          : `customer_id:${numericCustId}`;

        const company = await purchasingCompanyFor(admin, customerId);

        const draftRes = await withTimeout(
          company
            ? admin.graphql(COMPANY_QUOTES_QUERY, { variables: { id: company.companyId } })
            : admin.graphql(CUSTOMER_QUOTES_QUERY, { variables: { query: draftSearchQuery } }),
          ADMIN_TIMEOUT_MS,
        );

        const draftData = await draftRes.json();
        draftOrderNodes =
          draftData?.data?.company?.draftOrders?.nodes || draftData?.data?.draftOrders?.nodes || [];
      } catch (err) {
        console.warn("[account] quotes query warning:", err?.message || err);
      }
    }

    // Map REAL draft orders only — returns empty array if no draft orders found
    // A quote past its validity has been deleted, so it comes from the archive
    // rather than from Shopify's draft orders.
    const expired = await listExpiredQuotes(
      admin,
      `gid://shopify/Customer/${customerId}`,
      chrome?.customer?.email || "",
    );

    const quotes = [
      ...mapDraftOrdersToQuotes(draftOrderNodes),
      ...expired.map(expiredQuoteToRow),
    ];

    const mainHtml = quotesPage({
      quotes,
      notice,
      error: errorParam,
    });

    // `chrome` already carries the customer, the terms panel and both nav
    // counts, so it goes in last and nothing here has to duplicate it.
    return liquid(
      accountShell({
        active: "quotes",
        main: mainHtml,
        ...chrome,
      }),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[account] quotes loader failed:", error);
    return liquid(
      accountShell({ active: "quotes", main: quotesPage({ quotes: [] }), isDistributor: true }),
    );
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "").trim();
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");

    if (intent === "request_quote") {
      const items = String(formData.get("items") || "").trim();
      const quantity = Math.max(1, parseInt(formData.get("quantity") || "1", 10));
      const targetDate = String(formData.get("targetDate") || "").trim();
      const notes = String(formData.get("notes") || "").trim();

      if (!items) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/apps/account/quotes?error=Please+specify+requested+items" },
        });
      }

      // Create a draft order in Shopify
      if (admin && customerId) {
        try {
          const customerGid = customerId.startsWith("gid://")
            ? customerId
            : `gid://shopify/Customer/${customerId}`;
          // Stamped with the company so the rest of the team sees this quote,
          // and so it is priced against the company's catalog.
          const company = await purchasingCompanyFor(admin, customerId);

          const draftInput = {
            // Shopify refuses both `customerId` and `purchasingEntity` on one
            // draft: "Cannot send both customer and purchasing_entity". The
            // purchasing entity carries the buyer either way.
            purchasingEntity: purchasingEntity(company, customerGid),
            note: `Wholesale Quote Request from Distributor Portal:\nItems: ${items}\nTarget Date: ${targetDate || "Flexible"}\nNotes: ${notes || "None"}`,
            // `storefront-quote` is what the admin Quotes screen filters on;
            // without it a portal request never reaches the staff queue.
            tags: ["storefront-quote", "quote", "b2b_quote", "awaiting_review"],
            lineItems: [
              {
                title: items,
                quantity,
                originalUnitPrice: "0.00",
                customAttributes: [
                  { key: "Quote Status", value: "Pending Underwriting Review" },
                  ...(targetDate ? [{ key: "Target Date", value: targetDate }] : []),
                ],
              },
            ],
          };

          const created = await admin.graphql(
            `#graphql
            mutation CreateQuoteDraftOrder($input: DraftOrderInput!) {
              draftOrderCreate(input: $input) {
                draftOrder {
                  id
                  name
                  email
                }
                userErrors {
                  field
                  message
                }
              }
            }`,
            { variables: { input: draftInput } },
          );

          const draft = (await created.json())?.data?.draftOrderCreate?.draftOrder;
          if (draft?.name) {
            await notifyQuoteRaised(admin, {
              ref: draft.name.replace(/^#D/, "Q-").replace(/^#(?!D)/, "Q-"),
              email: draft.email || "",
              items,
              source: "Portal — Request Quote",
            });
          }
        } catch (draftErr) {
          console.warn("[account] draftOrderCreate warning:", draftErr?.message || draftErr);
        }
      }

      return new Response(null, {
        status: 302,
        headers: {
          Location: "/apps/account/quotes?notice=Quote+request+submitted+successfully!+Your+representative+will+prepare+pricing.",
        },
      });
    }

    return new Response(null, { status: 302, headers: { Location: "/apps/account/quotes" } });
  } catch (err) {
    console.error("[account] quotes action error:", err);
    return new Response(null, {
      status: 302,
      headers: { Location: "/apps/account/quotes?error=Unable+to+submit+quote+request" },
    });
  }
};

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Admin API timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
