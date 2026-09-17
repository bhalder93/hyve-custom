import { authenticate } from "../shopify.server";

/**
 * Quote endpoint — one route for all three cart actions.
 * Storefront:  POST /apps/account/quote  ->  <app>/proxy/quote  (this route)
 *
 * intent:
 *   "email"  -> create draft order + send invoice (payment link) to the customer
 *   "share"  -> create draft order + return invoiceUrl to the frontend
 *   "pdf"    -> return an HTML invoice (no draft order)
 *
 * Auth: the App Proxy signature (verified below) proves the request came from
 * Shopify. `logged_in_customer_id` tells us if the shopper is signed in; if not,
 * the frontend must supply an email.
 *
 * Chunk Q1: verifies the round-trip only (signature, cart payload, login state).
 * Draft-order creation / email / share / pdf land in Q2–Q4.
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

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
  const items = Array.isArray(payload.items) ? payload.items : [];

  const validIntent = ["email", "share", "pdf"].includes(intent);
  if (!validIntent) {
    return Response.json({ ok: false, error: "Invalid intent." }, { status: 400 });
  }

  // PDF: no draft order, no login required. The storefront sends a display-ready
  // `invoice` object; we render it to a real PDF and stream it back as a download.
  if (intent === "pdf") {
    const inv = payload.invoice;
    if (!inv || !Array.isArray(inv.merch) || !inv.merch.length) {
      return Response.json({ ok: false, error: "Nothing to quote." }, { status: 400 });
    }
    try {
      const { buildQuotePdf } = await import("../lib/quote-pdf.server.jsx");
      const pdf = await buildQuotePdf(inv);
      const safeRef = String(inv.ref || "quote").replace(/[^A-Za-z0-9._-]/g, "");
      return new Response(pdf, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${safeRef}.pdf"`,
          "Content-Length": String(pdf.length),
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      return Response.json({ ok: false, error: "Could not generate the PDF." }, { status: 500 });
    }
  }

  if (!items.length) {
    return Response.json({ ok: false, error: "Your cart is empty." }, { status: 400 });
  }

  // Email/share produce a payable link, so we need a recipient.
  const needEmail = !loggedInCustomerId && !email;
  if (needEmail) {
    return Response.json({ ok: true, needEmail: true });
  }

  if (!admin) {
    return Response.json({ ok: false, error: "Store session unavailable." }, { status: 500 });
  }

  // ----- email / share: create a draft order from the cart -----
  const currencyCode = (payload.currency || "USD").toUpperCase();
  const draftInput = {
    note: "Quote created from cart",
    tags: ["storefront-quote"],
    customAttributes: [{ key: "Source", value: "Cart quote" }],
    lineItems: buildLineItems(items, currencyCode),
  };
  if (loggedInCustomerId) {
    draftInput.purchasingEntity = { customerId: `gid://shopify/Customer/${loggedInCustomerId}` };
  } else {
    draftInput.email = email;
  }

  try {
    const created = await admin.graphql(
      `#graphql
      mutation QuoteDraftCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id invoiceUrl email }
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

    if (intent === "share") {
      return Response.json({ ok: true, intent: "share", invoiceUrl: payUrl });
    }

    // intent === "email" -> send OUR OWN email (Gmail SMTP) with the pay link +
    // the quote PDF attached, instead of Shopify's native invoice email (which
    // can't carry attachments). Skipping draftOrderInvoiceSend => a single email.

    // Recipient: explicit email (logged-out flow) or the email carried on the
    // draft (populated from the purchasingEntity customer — no read_customers needed).
    const recipient = email || draftOrder.email || null;
    if (!recipient) {
      return Response.json(
        { ok: false, error: "No email address to send the quote to.", invoiceUrl: payUrl },
        { status: 422 },
      );
    }

    // Render the PDF from the display-ready invoice the storefront sent.
    let pdfBuffer = null;
    const inv = payload.invoice;
    if (inv && Array.isArray(inv.merch) && inv.merch.length) {
      try {
        const { buildQuotePdf } = await import("../lib/quote-pdf.server.jsx");
        pdfBuffer = await buildQuotePdf(inv);
      } catch (pdfErr) {
        console.error("[quote-email] PDF render failed:", pdfErr);
        pdfBuffer = null; // fall back to a link-only email
      }
    } else {
      console.warn("[quote-email] no invoice payload → sending link-only email");
    }

    const shopName = (inv && inv.shopName) || "Hyve Promo";
    const ref = (inv && inv.ref) || "";
    const subject = `Your ${shopName} quote${ref ? " " + ref : ""}`;
    const safeRef = ref ? String(ref).replace(/[^A-Za-z0-9._-]/g, "") : "quote";

    try {
      console.log("[quote-email] sending", { to: recipient, hasPdf: !!pdfBuffer });
      const { sendQuoteEmail } = await import("../lib/mailer.server.js");
      const info = await sendQuoteEmail({
        to: recipient,
        subject,
        html: quoteEmailHtml({ shopName, ref, payUrl, hasPdf: !!pdfBuffer }),
        text:
          `Your ${shopName} quote${ref ? " " + ref : ""} is ready.\n\n` +
          `Review and pay securely: ${payUrl}\n\n` +
          (pdfBuffer ? "A PDF copy of your quote is attached.\n\n" : "") +
          `Thank you for choosing ${shopName}.`,
        pdfBuffer,
        filename: safeRef + ".pdf",
      });
      console.log("[quote-email] sent", {
        to: recipient,
        messageId: info?.messageId,
        accepted: info?.accepted,
        rejected: info?.rejected,
        response: info?.response,
      });
    } catch (err) {
      console.error("[quote-email] send failed:", err);
      return Response.json(
        {
          ok: false,
          // Surface the real reason (e.g. "Invalid login", "Email is not
          // configured…") so it shows in the modal while we're wiring this up.
          error: "Email send failed: " + (err?.message || "unknown error"),
          invoiceUrl: payUrl,
        },
        { status: 422 },
      );
    }

    return Response.json({ ok: true, intent: "email", sent: true });
  } catch (err) {
    return Response.json({ ok: false, error: "Something went wrong creating the quote." }, { status: 500 });
  }
};

/**
 * Map cart lines to draft-order line items as REAL STORE ITEMS.
 *
 * We link the actual variant (`variantId`) and set the price via `priceOverride`
 * — which "is used in place of the product variant's catalog price". This keeps
 * the "trust cart price" decision (priceOverride = the cart's final_price, which
 * already includes the Cart Transform imprint/decoration fee) while producing
 * catalog-linked line items instead of custom ones.
 *
 * Note: `originalUnitPriceWithCurrency` is IGNORED when a variantId is present —
 * passing it (as we did before) is what forced Shopify to create custom items.
 * Lines with no variant id fall back to a custom line.
 * Internal `_`-prefixed properties are omitted from customAttributes.
 */
function buildLineItems(items, currencyCode) {
  return items.map((it) => {
    const unit = (Number(it.final_price || 0) / 100).toFixed(2);
    const props = it.properties && typeof it.properties === "object" ? it.properties : {};
    const customAttributes = Object.keys(props)
      .filter((k) => k && !k.startsWith("_") && props[k] != null && props[k] !== "")
      .slice(0, 20)
      .map((k) => ({ key: String(k).slice(0, 100), value: String(props[k]).slice(0, 900) }));

    const line = {
      quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
    };
    if (customAttributes.length) line.customAttributes = customAttributes;

    const variantId = it.variant_id ? `gid://shopify/ProductVariant/${it.variant_id}` : null;
    if (variantId) {
      // Store item: link the catalog variant, override the unit price to the
      // cart's final price (base + Cart Transform decoration fee).
      line.variantId = variantId;
      line.priceOverride = { amount: unit, currencyCode };
    } else {
      // No variant id → fall back to a custom line.
      line.title = String(it.title || it.product_title || "Item").slice(0, 250);
      line.originalUnitPriceWithCurrency = { amount: unit, currencyCode };
      if (it.sku) line.sku = String(it.sku).slice(0, 100);
    }
    return line;
  });
}

// Branded HTML body for the quote email (pay link + note about the attachment).
function quoteEmailHtml({ shopName, ref, payUrl, hasPdf }) {
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return (
    '<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px">' +
    '<h1 style="font-size:20px;margin:0 0 8px">' + esc(shopName) + " — your quote is ready</h1>" +
    '<p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 20px">' +
    (ref ? "Reference <strong>" + esc(ref) + "</strong>. " : "") +
    "Review the details and pay securely using the button below" +
    (hasPdf ? ", or open the attached PDF" : "") + ".</p>" +
    '<p style="margin:0 0 24px"><a href="' + esc(payUrl) +
    '" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:10px">Review &amp; pay</a></p>' +
    '<p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0">If the button doesn\'t work, copy this link:<br>' +
    '<a href="' + esc(payUrl) + '" style="color:#0ea5b7">' + esc(payUrl) + "</a></p>" +
    '<p style="font-size:12px;color:#94a3b8;margin:24px 0 0">Thank you for choosing ' + esc(shopName) + ".</p>" +
    "</div></body></html>"
  );
}

// Safety for direct GETs (still signature-verified).
export const loader = async ({ request }) => {
  await authenticate.public.appProxy(request);
  return Response.json({ ok: true, message: "POST to create a quote." });
};
