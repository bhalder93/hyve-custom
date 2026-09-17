import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { distributorOnly } from "../lib/account-error.server";
import { portalChrome } from "../lib/account-data.server";
import {
  mapDraftOrdersToQuotes,
  quotesPage,
} from "../lib/account-quotes.server";

const ADMIN_TIMEOUT_MS = 4500;

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
        // Quotes are this customer's draft orders. `chrome` already knows who
        // they are, so nothing here has to look the customer up again.
        const numericCustId = customerId.replace(/\D/g, "");
        const email = chrome.customer?.email || "";
        const draftSearchQuery = email
          ? `customer_id:${numericCustId} OR email:${email}`
          : `customer_id:${numericCustId}`;

        const draftRes = await withTimeout(
          admin.graphql(
            `#graphql
            query GetCustomerDraftOrders($query: String!) {
              draftOrders(first: 50, query: $query, sortKey: UPDATED_AT, reverse: true) {
                nodes {
                  id
                  name
                  createdAt
                  status
                  invoiceUrl
                  hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
                  totalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  lineItems(first: 20) {
                    nodes {
                      title
                      quantity
                      originalUnitPriceSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                    }
                  }
                  order {
                    id
                    name
                  }
                  tags
                  customAttributes {
                    key
                    value
                  }
                }
              }
            }`,
            { variables: { query: draftSearchQuery } },
          ),
          ADMIN_TIMEOUT_MS,
        );

        const draftData = await draftRes.json();
        draftOrderNodes = draftData?.data?.draftOrders?.nodes || [];
      } catch (err) {
        console.warn("[account] quotes query warning:", err?.message || err);
      }
    }

    // Map REAL draft orders only — returns empty array if no draft orders found
    const quotes = mapDraftOrdersToQuotes(draftOrderNodes);

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
          const draftInput = {
            customerId: customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`,
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

          await admin.graphql(
            `#graphql
            mutation CreateQuoteDraftOrder($input: DraftOrderInput!) {
              draftOrderCreate(input: $input) {
                draftOrder {
                  id
                  name
                }
                userErrors {
                  field
                  message
                }
              }
            }`,
            { variables: { input: draftInput } },
          );
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
