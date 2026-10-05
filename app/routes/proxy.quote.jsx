import { authenticate } from "../shopify.server";
import { purchasingCompanyFor, purchasingEntity } from "../lib/purchasing-company.server";
import { notifyQuoteRaised } from "../lib/quote-notification.server";
import { CART_QUOTE_NOTE, LEAD_TIME_ATTRIBUTE } from "../lib/quote-document.server";
import { loadCommercialSettings } from "../lib/commercial-settings.server";

/**
 * Quote endpoint — one route for all three cart actions.
 * Storefront:  POST /apps/account/quote  ->  <app>/proxy/quote  (this route)
 *
 * intent:
 *   "email"  -> save the quote, then email the buyer its PDF and payment link
 *   "share"  -> save the quote and return its payment link
 *   "pdf"    -> save the quote and return its PDF
 *
 * Auth: the App Proxy signature proves the request came through Shopify.
 * `logged_in_customer_id` tells us if the shopper is signed in; if not, the
 * frontend must supply an email.
 *
 * Nothing the browser sends is priced (HYV-98). It sends only its cart token,
 * and the quote is built from the store's own copy of that cart: its lines,
 * the prices Shopify charges for them (catalog price and decoration fee), and
 * its currency. Trusting the browser let a request with no prices save Q-38
 * at SGD 0.00 with a checkout link to match.
 */
/** A link straight to the quote in the Shopify admin, for whoever picks it up. */
function adminDraftUrl(shop, draftGid) {
  if (!shop || !draftGid) return "";
  return `https://admin.shopify.com/store/${String(shop).replace(/\.myshopify\.com$/, "")}/draft_orders/${draftGid.split("/").pop()}`;
}

/**
 * The reference and validity a quote should carry: the draft order's own
 * number, which the Quotes list and the Retrieve a Quote page look it up by,
 * and the draft's own valid-until day, the one the PDF and the expiry
 * reminder use.
 */
function quoteLabels(draftOrder, quoteValidUntil) {
  const name = String(draftOrder?.name || "");
  return {
    ...(name ? { ref: name.replace(/^#D/, "Q-").replace(/^#(?!D)/, "Q-") } : {}),
    validStr: quoteValidUntil(draftOrder.createdAt).label,
  };
}

/** A cart token as the storefront issues it: "hWN…" optionally with "?key=…". */
const CART_TOKEN = /^[A-Za-z0-9_-]{8,}(\?key=[A-Za-z0-9]+)?$/;

/**
 * The buyer's cart as the store holds it, read from the storefront by its
 * token: the same `/cart.js` the cart page reads, with every price already as
 * Shopify charges it. Null when the token is missing or the store can't be
 * read, and then no quote is made rather than one priced from the browser.
 */
async function readStoreCart(admin, token) {
  if (!CART_TOKEN.test(String(token || ""))) return null;
  try {
    const shop = await (
      await admin.graphql(`#graphql
        query QuoteStorefront { shop { primaryDomain { url } } }`)
    ).json();
    const origin = shop?.data?.shop?.primaryDomain?.url;
    if (!origin) return null;
    const response = await fetch(new URL("/cart.js", origin), {
      headers: { Accept: "application/json", Cookie: `cart=${encodeURIComponent(token)}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.warn("[quote] store cart unavailable", response.status);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn("[quote] store cart unavailable", error?.message || error);
    return null;
  }
}

/**
 * The lead time a quote states, from Commercial Settings (HYV-133): the rush
 * time when the cart has Rush Production, otherwise the standard one, as the
 * cart page shows it.
 */
async function quoteLeadTime(admin, items) {
  const { values } = await loadCommercialSettings(admin);
  const rush = items.some(
    (it) =>
      String(it.properties?._hyve_rush || "") === "true" ||
      Object.entries(it.properties || {}).some(
        ([key, value]) => /rush/i.test(key) && /yes/i.test(String(value)),
      ),
  );
  const days = rush ? values.production_days_rush : values.production_days_standard;
  return days ? `${days} business days` : "";
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") || null;

  let payload = {};
  try {
    payload = await request.json();
  } catch (_) {
    payload = {};
  }

  const intent = payload.intent || null; // 'email' | 'share' | 'pdf'
  const email = (payload.email || "").trim() || null;

  if (!["email", "share", "pdf"].includes(intent)) {
    return Response.json({ ok: false, error: "Invalid intent." }, { status: 400 });
  }

  // Every quote is a tracked sales lead, so all three actions save one — the
  // PDF included. Retrieval is proved with the email it was sent to, so we
  // need one either way.
  if (!loggedInCustomerId && !email) {
    return Response.json({ ok: true, needEmail: true });
  }

  if (!admin) {
    return Response.json({ ok: false, error: "Store session unavailable." }, { status: 500 });
  }

  const cart = await readStoreCart(admin, payload.cart_token);
  if (!cart) {
    return Response.json(
      { ok: false, error: "We couldn't read your cart. Please refresh the page and try again." },
      { status: 422 },
    );
  }
  const items = Array.isArray(cart.items) ? cart.items : [];
  if (!items.length) {
    return Response.json({ ok: false, error: "Your cart is empty." }, { status: 400 });
  }

  // ----- save the draft order this quote is -----
  const currencyCode = String(cart.currency || "USD").toUpperCase();
  const leadTime = await quoteLeadTime(admin, items);
  // The buyer's Order Notes from the cart follow the marker, and print as the
  // quotation's Other Remarks (HYV-116).
  const cartNote = String(cart.note || "").trim();
  const draftInput = {
    // Saved in the cart's currency, which its prices are in (HYV-98).
    presentmentCurrencyCode: currencyCode,
    note: cartNote ? `${CART_QUOTE_NOTE}\n\n${cartNote}` : CART_QUOTE_NOTE,
    tags: ["storefront-quote"],
    customAttributes: [
      { key: "Source", value: "Cart quote" },
      // The lead time the cart showed, so the quote read back from the account
      // or Retrieve a Quote states the same one (HYV-98).
      ...(leadTime ? [{ key: LEAD_TIME_ATTRIBUTE, value: leadTime }] : []),
    ],
    lineItems: buildLineItems(items, currencyCode),
  };
  let company = null;
  if (loggedInCustomerId) {
    const customerGid = `gid://shopify/Customer/${loggedInCustomerId}`;
    // A quote raised by someone buying for a company belongs to that company,
    // so their colleagues see it and it is priced against their catalog.
    company = await purchasingCompanyFor(admin, loggedInCustomerId);
    draftInput.purchasingEntity = purchasingEntity(company, customerGid);
  } else {
    draftInput.email = email;
  }

  try {
    const created = await admin.graphql(
      `#graphql
      mutation QuoteDraftCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name invoiceUrl email createdAt }
          userErrors { field message }
        }
      }`,
      { variables: { input: draftInput } },
    );
    const createdJson = await created.json();
    const result = createdJson?.data?.draftOrderCreate;
    if (!result || result.userErrors?.length) {
      const msg = result?.userErrors?.[0]?.message || "Could not create the quote.";
      return Response.json({ ok: false, error: msg }, { status: 422 });
    }
    const draftOrder = result.draftOrder;
    const payUrl = draftOrder.invoiceUrl;

    const { quoteValidUntil, loadQuoteDocument } = await import("../lib/quote-document.server");
    const labels = quoteLabels(draftOrder, quoteValidUntil);

    // Every quote is a sales lead, however it was raised.
    const source = { pdf: "Cart — downloaded", share: "Cart — shared link", email: "Cart — emailed" }[intent];
    await notifyQuoteRaised(admin, {
      ref: labels.ref,
      email: email || draftOrder.email || "",
      items: items.map((line) => `${line.product_title || line.title}${line.quantity > 1 ? ` x${line.quantity}` : ""}`).join(" + "),
      total: `${currencyCode} ${(Number(cart.total_price || 0) / 100).toFixed(2)}`,
      source,
      adminUrl: adminDraftUrl(session?.shop, draftOrder.id),
    });

    if (intent === "share") {
      return Response.json({ ok: true, intent: "share", invoiceUrl: payUrl, ref: labels.ref });
    }

    // The PDF is built from the saved quote, the same document the account and
    // Retrieve a Quote give, so what it prints is what Shopify holds.
    const doc = await loadQuoteDocument(
      admin,
      draftOrder.id,
      loggedInCustomerId
        ? { customerGid: `gid://shopify/Customer/${loggedInCustomerId}`, companyGid: company?.companyId || null }
        : { email },
    );

    if (intent === "pdf") {
      if (!doc) return Response.json({ ok: false, error: "Could not generate the PDF." }, { status: 500 });
      try {
        const { buildQuotePdf } = await import("../lib/quote-pdf.server.jsx");
        const pdf = await buildQuotePdf(doc);
        const safeRef = String(doc.ref || "quote").replace(/[^A-Za-z0-9._-]/g, "");
        return new Response(pdf, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${safeRef}.pdf"`,
            "Content-Length": String(pdf.length),
            "Cache-Control": "no-store",
          },
        });
      } catch (pdfErr) {
        console.error("[quote-pdf] render failed", pdfErr?.message || pdfErr);
        return Response.json({ ok: false, error: "Could not generate the PDF." }, { status: 500 });
      }
    }

    // intent === "email" -> send OUR OWN email (SMTP) with the pay link and the
    // quote PDF attached, instead of Shopify's native invoice email (which
    // can't carry attachments).
    const recipient = email || draftOrder.email || null;
    if (!recipient) {
      return Response.json(
        { ok: false, error: "No email address to send the quote to.", invoiceUrl: payUrl },
        { status: 422 },
      );
    }

    let pdfBuffer = null;
    if (doc) {
      try {
        const { buildQuotePdf } = await import("../lib/quote-pdf.server.jsx");
        pdfBuffer = await buildQuotePdf(doc);
      } catch (pdfErr) {
        console.error("[quote-email] PDF render failed:", pdfErr);
        pdfBuffer = null; // a link-only email
      }
    }

    const shopName = doc?.shopName || "Hyve Promo";
    const ref = labels.ref || "";
    const subject = `Your ${shopName} quote${ref ? " " + ref : ""}`;
    const safeRef = ref ? String(ref).replace(/[^A-Za-z0-9._-]/g, "") : "quote";

    try {
      const { sendQuoteEmail } = await import("../lib/mailer.server.js");
      const info = await sendQuoteEmail({
        to: recipient,
        subject,
        html: await quoteEmailHtml({ shopName, ref, payUrl, hasPdf: !!pdfBuffer }),
        text:
          `Your ${shopName} quote${ref ? " " + ref : ""} is ready.\n\n` +
          `Confirm your order: ${payUrl}\n\n` +
          (pdfBuffer ? "A PDF copy of your quote is attached.\n\n" : "") +
          `Thank you for choosing ${shopName}.`,
        pdfBuffer,
        filename: safeRef + ".pdf",
      });
      console.log("[quote-email] sent", { messageId: info?.messageId, accepted: info?.accepted?.length });
    } catch (err) {
      console.error("[quote-email] send failed:", err);
      return Response.json(
        { ok: false, error: "Email send failed: " + (err?.message || "unknown error"), invoiceUrl: payUrl },
        { status: 422 },
      );
    }

    return Response.json({ ok: true, intent: "email", sent: true });
  } catch (err) {
    console.error("[quote] failed", err);
    return Response.json({ ok: false, error: "Something went wrong creating the quote." }, { status: 500 });
  }
};

/**
 * The store cart's lines as draft order lines: each one the real variant, at
 * the unit price Shopify charges for it in that cart (`final_price`, catalog
 * price plus the cart transform's decoration fee), set with `priceOverride`,
 * which "is used in place of the product variant's catalog price". Hidden
 * (`_`-prefixed) properties are left off, except the flags in KEPT_FLAGS.
 */
/**
 * The cart's hidden flags a quote has to keep. Checkout lets a blank sample
 * (`_sample`) and the charge lines (`_hyve_*`) through the 25-unit minimum by
 * these, so a quote that dropped them couldn't be checked out ("Minimum order
 * quantity is 25 units per item.", HYV-98). The rest stay behind: `_imprint`
 * and `_hyve_gift_for` tell the cart transform to reprice a line, and a quote's
 * prices are already final.
 */
const KEPT_FLAGS = ["_sample", "_hyve_setup", "_hyve_rush", "_hyve_gift", "_hyve_sample"];

function buildLineItems(items, currencyCode) {
  return items.map((it) => {
    const unit = (Number(it.final_price || 0) / 100).toFixed(2);
    const props = it.properties && typeof it.properties === "object" ? it.properties : {};
    const customAttributes = Object.keys(props)
      .filter((k) => k && (!k.startsWith("_") || KEPT_FLAGS.includes(k)) && props[k] != null && props[k] !== "")
      .slice(0, 20)
      .map((k) => ({ key: String(k).slice(0, 100), value: String(props[k]).slice(0, 900) }));

    const line = {
      quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
    };
    if (customAttributes.length) line.customAttributes = customAttributes;

    line.variantId = `gid://shopify/ProductVariant/${it.variant_id}`;
    line.priceOverride = { amount: unit, currencyCode };
    return line;
  });
}

// Branded HTML body for the quote email (pay link + note about the attachment).
/** The buyer's quote email, on the same branded frame as the order emails (HYV-110). */
async function quoteEmailHtml({ shopName, ref, payUrl, hasPdf }) {
  const { brandedEmail, escapeHtml } = await import("../utils/email.server");
  const paragraph = 'style="margin:0 0 14px; line-height:1.7; font-size:15px;"';
  return brandedEmail({
    title: "Your quote is ready",
    body: `
      <p ${paragraph}>
        Check the details${hasPdf ? " in the attached PDF" : ""}, then confirm your order with the button below.
      </p>
      <div style="margin:22px 0;">
        <a href="${escapeHtml(payUrl)}" style="display:inline-block; padding:14px 22px; background:#0f172a; color:#ffffff; text-decoration:none; border-radius:10px; font-size:14px; font-weight:700;">
          Confirm Order
        </a>
      </div>
      <p style="margin:0; font-size:12px; line-height:1.6; color:#6B7280;">
        If the button doesn't work, copy this link:<br>
        <a href="${escapeHtml(payUrl)}" style="color:#0f766e;">${escapeHtml(payUrl)}</a>
      </p>`,
    details: [
      ...(ref ? [["Quote", escapeHtml(ref)]] : []),
      ["From", escapeHtml(shopName)],
    ],
  });
}

// Safety for direct GETs (still signature-verified).
export const loader = async ({ request }) => {
  await authenticate.public.appProxy(request);
  return Response.json({ ok: true, message: "POST to create a quote." });
};
