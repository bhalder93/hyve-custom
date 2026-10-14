import { authenticate } from "../shopify.server";
import { locationPaymentTerms, purchasingCompanyFor, purchasingEntity } from "../lib/purchasing-company.server";
import { notifyQuoteRaised } from "../lib/quote-notification.server";
import { CART_QUOTE_NOTE, LEAD_TIME_ATTRIBUTE } from "../lib/quote-document.server";
import { loadCommercialSettings } from "../lib/commercial-settings.server";
import { createHash } from "node:crypto";

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

/**
 * What makes two quote requests the same quote: the buyer, their company, the
 * currency, the order notes and every line with its quantity, price and
 * options. Saved on the draft as a tag, so pressing Download, Share and Email
 * on an unchanged cart gives one quote rather than three (HYV-180).
 */
function quoteFingerprint(draftInput, buyer) {
  const basis = JSON.stringify({
    buyer,
    company: draftInput.purchasingEntity || null,
    currency: draftInput.presentmentCurrencyCode,
    note: draftInput.note,
    lines: draftInput.lineItems,
  });
  return `cart-quote:${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

/**
 * The quote this browser saved last, if it is still the same quote: open,
 * within its validity, not declined by Hyve, and carrying the same
 * fingerprint. The id comes from
 * the browser, so the fingerprint (which includes the buyer) is what proves
 * it; anything else gets a new quote.
 */
async function reusableQuote(admin, quoteId, fingerprint, quoteValidUntil) {
  if (!/^gid:\/\/shopify\/DraftOrder\/\d+$/.test(String(quoteId || ""))) return null;
  try {
    const response = await admin.graphql(
      `#graphql
      query ReusableQuote($id: ID!) {
        draftOrder(id: $id) {
          id name invoiceUrl email createdAt status tags
          hyveStatus: metafield(namespace: "$app", key: "hyve_status") { value }
        }
      }`,
      { variables: { id: quoteId } },
    );
    const draft = (await response.json())?.data?.draftOrder;
    if (!draft || draft.status !== "OPEN" || !(draft.tags || []).includes(fingerprint)) return null;
    if (String(draft.hyveStatus?.value || "").trim().toLowerCase() === "false") return null;
    if (quoteValidUntil(draft.createdAt).at < new Date()) return null;
    return draft;
  } catch (error) {
    console.warn("[quote] reuse check failed", error?.message || error);
    return null;
  }
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
 * time when every line being produced (the ones with artwork) is rushed,
 * otherwise the standard one, as the cart page shows it. An order ships in one
 * go, so a mixed order is ready at the standard time (HYV-82).
 */
async function quoteLeadTime(admin, items) {
  const { values } = await loadCommercialSettings(admin);
  const produced = items.filter((it) => String(it.properties?.Artwork ?? "").trim());
  const rushed = (it) =>
    Object.entries(it.properties || {}).some(([key, value]) => /rush/i.test(key) && /yes/i.test(String(value)));
  const rush = produced.length > 0 && produced.every(rushed);
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

  const { quoteValidUntil, loadQuoteDocument } = await import("../lib/quote-document.server");
  const fingerprint = quoteFingerprint(draftInput, loggedInCustomerId ? `c:${loggedInCustomerId}` : `e:${email.toLowerCase()}`);
  draftInput.tags.push(fingerprint);
  // The company's own terms, so a Net 30 buyer isn't asked to pay upfront.
  // After the fingerprint: the issue date changes on every request.
  const terms = await locationPaymentTerms(admin, company?.companyLocationId);
  if (terms) draftInput.paymentTerms = terms;

  try {
    // The same cart asked for again (another button, or the same one twice)
    // gets the quote it already has.
    const existing = await reusableQuote(admin, payload.quote_id, fingerprint, quoteValidUntil);
    const created = existing ? null : await admin.graphql(
      `#graphql
      mutation QuoteDraftCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name invoiceUrl email createdAt }
          userErrors { field message }
        }
      }`,
      { variables: { input: draftInput } },
    );
    const result = created ? (await created.json())?.data?.draftOrderCreate : null;
    if (!existing && (!result || result.userErrors?.length)) {
      const msg = result?.userErrors?.[0]?.message || "Could not create the quote.";
      return Response.json({ ok: false, error: msg }, { status: 422 });
    }
    const draftOrder = existing || result.draftOrder;
    const payUrl = draftOrder.invoiceUrl;

    const labels = quoteLabels(draftOrder, quoteValidUntil);

    // Who raised it. A distributor's quote belongs to their company, and
    // Shopify won't put a customer or email on a company draft, so
    // draftOrder.email is empty for them: the signed-in buyer's own email is
    // used instead. Without it the email send stopped at "No email address"
    // for every distributor (HYV-180), and the sales lead had no contact.
    const buyerEmail =
      email || draftOrder.email || (loggedInCustomerId ? await customerEmail(admin, loggedInCustomerId) : null);

    // Every quote is a sales lead, however it was raised, and sales hear of
    // it once: a reused quote was already announced.
    const source = { pdf: "Cart — downloaded", share: "Cart — shared link", email: "Cart — emailed" }[intent];
    if (!existing) await notifyQuoteRaised(admin, {
      ref: labels.ref,
      email: buyerEmail || "",
      items: items.map((line) => `${line.product_title || line.title}${line.quantity > 1 ? ` x${line.quantity}` : ""}`).join(" + "),
      total: `${currencyCode} ${(Number(cart.total_price || 0) / 100).toFixed(2)}`,
      source,
      adminUrl: adminDraftUrl(session?.shop, draftOrder.id),
    });

    if (intent === "share") {
      return Response.json({ ok: true, intent: "share", invoiceUrl: payUrl, ref: labels.ref, quoteId: draftOrder.id });
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
            "X-Hyve-Quote": draftOrder.id,
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
    const recipient = buyerEmail;
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
        html: await quoteEmailHtml({ shopName, ref, payUrl, hasPdf: !!pdfBuffer, validUntil: labels.validStr }),
        text:
          `Your ${shopName} quote${ref ? " " + ref : ""} is ready.\n\n` +
          (labels.validStr ? `Valid until ${labels.validStr}.\n\n` : "") +
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

    // The address it went to, for the confirmation in the cart.
    return Response.json({ ok: true, intent: "email", sent: true, to: recipient, quoteId: draftOrder.id });
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
    // Hidden marker: the price already has the cart's retail quantity break,
    // so the cart transform doesn't apply it again at the quote's checkout
    // (HYV-190). Hidden in checkout and dropped from the order like the
    // other `_hyve_` fields.
    customAttributes.push({ key: "_hyve_quote", value: "1" });
    line.customAttributes = customAttributes;

    line.variantId = `gid://shopify/ProductVariant/${it.variant_id}`;
    line.priceOverride = { amount: unit, currencyCode };
    return line;
  });
}

/** The signed-in buyer's email, or null. */
async function customerEmail(admin, customerId) {
  try {
    const response = await admin.graphql(
      `#graphql
      query QuoteCustomerEmail($id: ID!) {
        customer(id: $id) {
          defaultEmailAddress { emailAddress }
        }
      }`,
      { variables: { id: `gid://shopify/Customer/${String(customerId).replace(/\D/g, "")}` } },
    );
    const body = await response.json();
    return body?.data?.customer?.defaultEmailAddress?.emailAddress || null;
  } catch (error) {
    console.warn("[quote-email] customer email lookup failed", error?.message || error);
    return null;
  }
}

/** The buyer's quote email, on the same branded frame as the order emails (HYV-110). */
async function quoteEmailHtml({ shopName, ref, payUrl, hasPdf, validUntil }) {
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
      // The same date the quote PDF prints (HYV-166).
      ...(validUntil ? [["Valid until", escapeHtml(validUntil)]] : []),
      ["From", escapeHtml(shopName)],
    ],
  });
}

// Safety for direct GETs (still signature-verified).
export const loader = async ({ request }) => {
  await authenticate.public.appProxy(request);
  return Response.json({ ok: true, message: "POST to create a quote." });
};
