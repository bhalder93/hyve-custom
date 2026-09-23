/**
 * Order detail modal (J2).
 *
 * "No designed screen exists for it, so it is built to this specification...
 *  It opens as a modal over the orders list, as the mockup shows, rather than
 *  as a separate page." Internal sales staff use the same view (A12).
 *
 * Layout follows the approved mockup: a timeline and the proofs panel on the
 * left, product and shipping detail on the right, actions in the footer.
 * The timeline shows the six J3 statuses only — no Delivered step (J10).
 *
 * One modal is rendered per order alongside the list and toggled client-side,
 * so opening one costs no round trip.
 */
import { esc } from "./account-shell.server";
import { ACCEPTED_EXTENSIONS, MAX_FILE_LABEL, isPreviewable } from "./artwork.server";
import { VISIBLE_STATUSES, statusByKey } from "./portal.server";

const WHATSAPP_NUMBER = "6569322855";

// F5 asks for the format and size limits to be stated before upload, so the
// panel reads them from the same list the upload itself enforces.
const ARTWORK_ACCEPT = ACCEPTED_EXTENSIONS.join(",");
const ARTWORK_ACCEPT_LABEL = ACCEPTED_EXTENSIONS.map((e) => e.replace(".", "").toUpperCase()).join(", ");
const ARTWORK_MAX_LABEL = MAX_FILE_LABEL;

export function orderModal(order, library = []) {
  const status = statusByKey(order.statusKey) || VISIBLE_STATUSES[0];
  const reachedIndex = VISIBLE_STATUSES.findIndex((s) => s.key === order.statusKey);

  return `
    <div class="hyve-modal" id="order-${esc(order.name)}" data-order-modal hidden>
      <div class="hyve-modal__backdrop" data-modal-close></div>

      <div class="hyve-modal__panel" role="dialog" aria-modal="true" aria-label="Order ${esc(order.name)}">
        <header class="hyve-modal__head">
          <h2 class="hyve-modal__title">Order ${esc(order.name)}</h2>
          <button type="button" class="hyve-modal__close" aria-label="Close" data-modal-close>${icoClose()}</button>
        </header>

        <div class="hyve-modal__body">
          ${headerFacts(order, status)}

          <div class="hyve-modal__cols">
            <div class="hyve-modal__col">
              ${timeline(order, reachedIndex)}
              ${artworkPanel(order, library)}
              ${proofsPanel(order)}
            </div>

            <div class="hyve-modal__col">
              ${productPanel(order)}
              ${shippingPanel(order)}
              ${order.note ? notePanel(order.note) : ""}
            </div>
          </div>
        </div>

        <footer class="hyve-modal__foot">
          <a class="hyve-ord__btn hyve-ord__btn--ghost" href="https://wa.me/${WHATSAPP_NUMBER}" target="_blank" rel="noopener">${icoHelp()}<span>WhatsApp Us</span></a>
          <a class="hyve-ord__btn hyve-ord__btn--ghost" href="https://hyve.promo/pages/contact" target="_blank" rel="noopener">${icoMail()}<span>Email Us</span></a>
          ${
            // Only an order on terms has an invoice.
            order.hasInvoice && order.id
              ? `<a class="hyve-ord__btn hyve-ord__btn--ghost" href="/apps/account/invoices/download?order=${encodeURIComponent(order.id)}">${icoDownload()}<span>Download Invoice</span></a>`
              : ""
          }
          ${
            order.quoteHref
              ? `<a class="hyve-ord__btn hyve-ord__btn--ghost" href="${esc(order.quoteHref)}">${icoFile()}<span>Download Quote</span></a>`
              : ""
          }
          ${order.trackHref ? `<a class="hyve-ord__btn hyve-ord__btn--ghost" href="${esc(order.trackHref)}">${icoTruck()}<span>Track Shipment</span></a>` : ""}
          ${
            order.id
              ? `<form method="post" action="/apps/account/orders/reorder" class="hyve-ord__reorder">
                   <input type="hidden" name="order" value="${esc(order.id)}">
                   <button type="submit" class="hyve-ord__btn hyve-ord__btn--primary">${icoRepeat()}<span>Reorder Now</span></button>
                 </form>`
              : ""
          }
        </footer>
      </div>
    </div>`;
}

/** J2 header: status, PO number, payment terms and the production target. */
function headerFacts(order, status) {
  const facts = [
    ["Status", status.label],
    ["PO Number", order.poNumber],
    ["Payment Terms", order.paymentTerms],
    // The date the proof-approved email gave the buyer. The list row shows it too.
    ["Production Target", order.productionTarget],
  ].filter(([, v]) => v);

  return `
    <div class="hyve-modal__facts">
      ${facts
        .map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`)
        .join("")}
    </div>`;
}

/** The J3 chain. Branch states (On Hold, Awaiting Artwork) show as a callout. */
function timeline(order, reachedIndex) {
  const isBranch = reachedIndex === -1;

  const steps = VISIBLE_STATUSES.map((s, i) => {
    const state = isBranch ? (i === 0 ? "done" : "todo") : i < reachedIndex ? "done" : i === reachedIndex ? "current" : "todo";
    return `
      <li class="hyve-tl__step is-${state}">
        <span class="hyve-tl__dot">${state === "todo" ? "" : icoTick()}</span>
        <div>
          <span class="hyve-tl__label">${esc(s.label)}</span>
          ${state === "current" && order.statusChangedAt ? `<span class="hyve-tl__time">${esc(order.statusChangedAt)}</span>` : ""}
        </div>
      </li>`;
  }).join("");

  const branch = isBranch
    ? `<p class="hyve-tl__branch">${icoAlert()}<span>${esc(statusByKey(order.statusKey)?.label || "")}${order.onHoldReason ? ` — ${esc(order.onHoldReason)}` : ""}</span></p>`
    : "";

  return `
    <section class="hyve-modal__panel-box">
      <h3 class="hyve-modal__panel-title">${icoTimeline()} Order Timeline</h3>
      ${branch}
      <ol class="hyve-tl">${steps}</ol>
    </section>`;
}

function productPanel(order) {
  const lines = (order.lines || [])
    .map(
      (li) => `
      <div class="hyve-modal__line">
        <div>
          <span class="hyve-modal__line-title">${esc(li.title)}</span>
          <span class="hyve-modal__line-meta">
            ${li.variantTitle ? `<span class="hyve-modal__chip">${esc(li.variantTitle)}</span>` : ""}
            <span class="hyve-modal__chip">Qty: ${esc(li.quantity)}</span>
            ${li.sku ? `<span class="hyve-modal__chip">${esc(li.sku)}</span>` : ""}
            ${(li.options || []).map((option) => `<span class="hyve-modal__chip">${esc(option)}</span>`).join("")}
          </span>
        </div>
        <div class="hyve-modal__line-money">
          ${li.unitPrice ? `<span class="hyve-modal__line-unit">${esc(li.unitPrice)} ea</span>` : ""}
          ${li.lineTotal ? `<strong>${esc(li.lineTotal)}</strong>` : ""}
        </div>
      </div>`,
    )
    .join("");

  return `
    <section class="hyve-modal__panel-box">
      <h3 class="hyve-modal__panel-title">${icoBox()} Product Details</h3>
      ${lines || `<p class="hyve-modal__muted">No line items available.</p>`}
      <div class="hyve-modal__total"><span>Total Price</span><strong>${esc(order.total)}</strong></div>
    </section>`;
}

function shippingPanel(order) {
  const a = order.shippingAddress;
  const address = a
    ? [a.address1, a.address2, [a.city, a.provinceCode].filter(Boolean).join(" "), a.zip, a.countryCodeV2]
        .filter(Boolean)
        .join(", ")
    : "";

  const rows = [
    ["Ship to", a?.name],
    ["Company", a?.company],
    ["Address", address],
    ["Method", order.shippingMethod || order.carrier],
  ].filter(([, v]) => v);

  if (!rows.length && !order.trackingNumber) return "";

  return `
    <section class="hyve-modal__panel-box">
      <h3 class="hyve-modal__panel-title">${icoPin()} Shipping Information</h3>
      ${rows.map(([l, v]) => `<div class="hyve-modal__row"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join("")}
      ${
        order.trackingNumber
          ? `<div class="hyve-modal__row"><span>Tracking</span>${
              order.trackHref
                ? `<a href="${esc(order.trackHref)}" class="hyve-modal__link">${esc(order.trackingNumber)}</a>`
                : `<strong>${esc(order.trackingNumber)}</strong>`
            }</div>`
          : ""
      }
    </section>`;
}

/**
 * J2/F11: the artwork on the order, one slot per decoration position, laid out
 * like the picker on the product page — a drop zone per position, with the
 * buyer's saved artwork one click away.
 *
 * A send-later order is completed here: fill the empty positions and the hold
 * is released.
 */
function artworkPanel(order, library = []) {
  const lines = (order.lines || []).filter((li) => (li.zones || []).length);
  if (!lines.length) return "";

  const editable = order.statusKey === "awaiting-artwork" && order.id;

  const blocks = lines
    .map((li) => {
      const filled = li.zones.filter((zone) => zone.url);
      const empty = li.zones.filter((zone) => !zone.url);

      return `
        <div class="hyve-art__line">
          <span class="hyve-art__line-title">${esc(li.title)}</span>
          ${
            filled.length
              ? `<div class="hyve-tile-grid">${filled
                  .map((zone) => zoneSlot(zone, editable, order.name))
                  .join("")}</div>`
              : ""
          }
          ${empty.map((zone) => zoneSlot(zone, editable, order.name)).join("")}
        </div>`;
    })
    .join("");

  if (!editable) {
    return `
    <section class="hyve-modal__panel-box">
      <h3 class="hyve-modal__panel-title">${icoImage()} Artwork</h3>
      ${blocks}
    </section>`;
  }

  return `
    <section class="hyve-modal__panel-box">
      <h3 class="hyve-modal__panel-title">${icoImage()} Artwork</h3>
      <form method="post" action="/apps/account/orders/artwork" enctype="multipart/form-data" data-art-form>
        <input type="hidden" name="order" value="${esc(order.id)}">
        ${blocks}
        <div class="hyve-modal__proof-buttons">
          <button type="submit" class="hyve-ord__btn hyve-ord__btn--primary">
            ${icoUpload()}<span>Send Artwork</span>
          </button>
        </div>
        <p class="hyve-art__limits">${esc(ARTWORK_ACCEPT_LABEL)}, up to ${esc(ARTWORK_MAX_LABEL)} per file.</p>
      </form>
      ${savedArtworkPicker(library, order.name)}
    </section>`;
}

/** One decoration position: what is on it, or a way to supply it. */
function zoneSlot(zone, editable, orderName) {
  const field = `zone:${zone.key}`;
  const id = `${orderName}-${zone.key}`.replace(/[^A-Za-z0-9-]/g, "-");

  if (zone.url) {
    const filename = filenameOf(zone.url);
    return fileTile({
      href: zone.url,
      label: zone.label,
      sub: filename,
      previewUrl: isPreviewable(filename) ? zone.url : "",
    });
  }

  if (!editable) {
    return `
      <div class="hyve-art__zone">
        <span class="hyve-art__zone-label">${esc(zone.label)}</span>
        <p class="hyve-modal__muted">Not supplied yet.</p>
      </div>`;
  }

  return `
    <div class="hyve-art__zone" data-art-zone data-zone-id="${esc(id)}">
      <span class="hyve-art__zone-label">${esc(zone.label)}</span>

      <label class="hyve-art__drop" for="${esc(id)}-file" data-art-drop>
        ${icoUpload()}
        <span class="hyve-art__drop-text">Drop logo or <strong>browse</strong></span>
      </label>

      <button type="button" class="hyve-art__saved-btn" data-art-pick="${esc(id)}">
        ${icoImage()}<span>Use saved artwork</span>
      </button>

      <p class="hyve-art__chosen" data-art-chosen hidden></p>

      <input type="file" id="${esc(id)}-file" name="${esc(field)}:file" class="hyve-art__hidden-input"
        accept="${esc(ARTWORK_ACCEPT)}" data-art-file>
      <input type="hidden" name="${esc(field)}:saved" value="" data-art-saved>
    </div>`;
}

/**
 * One picker shared by every position on the order. Opening it remembers which
 * position asked, so the chosen file lands in the right slot.
 */
function savedArtworkPicker(library, orderName) {
  const id = `art-picker-${String(orderName).replace(/[^A-Za-z0-9-]/g, "-")}`;

  const files = library.length
    ? library
        .map(
          (file) => `
        <button type="button" class="hyve-art__saved-item" data-art-choose
          data-url="${esc(file.url)}" data-name="${esc(file.filename)}">
          ${
            file.previewUrl
              ? `<img src="${esc(file.previewUrl)}" alt="" class="hyve-art__saved-thumb">`
              : `<span class="hyve-art__saved-thumb hyve-art__saved-thumb--file">${icoFile()}</span>`
          }
          <span class="hyve-art__saved-name">${esc(file.filename)}</span>
        </button>`,
        )
        .join("")
    : `<p class="hyve-modal__muted">You have no saved artwork yet. Upload a file and it will be saved here for next time.</p>`;

  return `
    <div class="hyve-art__picker" id="${esc(id)}" data-art-picker hidden>
      <div class="hyve-art__picker-backdrop" data-art-picker-close></div>
      <div class="hyve-art__picker-panel" role="dialog" aria-modal="true" aria-label="Saved artwork">
        <header class="hyve-art__picker-head">
          <h4 class="hyve-art__picker-title">Saved artwork</h4>
          <button type="button" class="hyve-modal__close" aria-label="Close" data-art-picker-close>${icoClose()}</button>
        </header>
        <div class="hyve-art__saved-grid">${files}</div>
      </div>
    </div>`;
}

/**
 * One file as a thumbnail card: the image itself where a browser can render it,
 * a plain icon where it cannot, with the label and filename over the bottom.
 * Shared by the artwork and proof panels so both read the same.
 */
function fileTile({ href, label, sub, previewUrl }) {
  const art = previewUrl
    ? `<img class="hyve-tile__img" src="${esc(previewUrl)}" alt="" loading="lazy">`
    : `<span class="hyve-tile__img hyve-tile__img--file">${icoFile()}</span>`;

  return `
    <a class="hyve-tile" href="${esc(href)}" target="_blank" rel="noopener">
      ${art}
      <span class="hyve-tile__caption">
        <span class="hyve-tile__label">${esc(label)}</span>
        ${sub ? `<span class="hyve-tile__sub">${esc(sub)}</span>` : ""}
      </span>
    </a>`;
}

function filenameOf(url) {
  const path = String(url || "").split("?")[0];
  try {
    return decodeURIComponent(path.split("/").pop() || "Artwork");
  } catch {
    return path.split("/").pop() || "Artwork";
  }
}

function proofsPanel(order) {
  const items = [
    order.proofUrl ? ["Artwork Proof", order.proofUrl, "Proof"] : null,
    order.productionPhotoUrl ? ["Production Photo", order.productionPhotoUrl, "Free photo"] : null,
  ].filter(Boolean);

  return `
    <section class="hyve-modal__panel-box">
      <h3 class="hyve-modal__panel-title">${icoImage()} Proofs &amp; Photos</h3>
      ${
        items.length
          ? `<div class="hyve-tile-grid">
              ${items
                .map(([label, href, sub]) =>
                  fileTile({
                    href,
                    label,
                    sub,
                    previewUrl: isPreviewable(filenameOf(href)) ? href : "",
                  }),
                )
                .join("")}
            </div>`
          : `<p class="hyve-modal__muted">No proof or production photo on this order yet.</p>`
      }
      ${
        // ART-03: the decision must be possible here as well as from the proof
        // email. Most buyers use the email; internal sales staff use this.
        order.statusKey === "proof-sent" && order.id
          ? `<form method="post" action="/apps/account/orders/proof" class="hyve-modal__proof-actions">
               <input type="hidden" name="order" value="${esc(order.id)}">
               <label class="hyve-modal__proof-label" for="proof-msg-${esc(order.name)}">
                 What needs changing? (only needed if you're requesting changes)
               </label>
               <textarea
                 id="proof-msg-${esc(order.name)}"
                 name="message"
                 class="hyve-modal__proof-input"
                 rows="2"
                 placeholder="Move the logo lower, use the darker green…"></textarea>
               <div class="hyve-modal__proof-buttons">
                 <button type="submit" name="decision" value="approve" class="hyve-ord__btn hyve-ord__btn--primary">
                   ${icoTick()}<span>Approve Proof</span>
                 </button>
                 <button type="submit" name="decision" value="changes" class="hyve-ord__btn hyve-ord__btn--ghost">
                   ${icoNote()}<span>Request Changes</span>
                 </button>
               </div>
             </form>`
          : ""
      }
    </section>`;
}

function notePanel(note) {
  return `
    <section class="hyve-modal__panel-box">
      <h3 class="hyve-modal__panel-title">${icoNote()} Order Notes</h3>
      <p class="hyve-modal__muted">${esc(note)}</p>
    </section>`;
}

/* ---------- icons ---------- */
function svg(inner, fill = "none") {
  return `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
function icoClose() { return svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'); }
function icoTick() { return svg('<polyline points="20 6 9 17 4 12"/>'); }
function icoTimeline() { return svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.5"/><circle cx="4" cy="12" r="1.5"/><circle cx="4" cy="18" r="1.5"/>'); }
function icoBox() { return svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/>'); }
function icoPin() { return svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>'); }
function icoImage() { return svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'); }
function icoFile() { return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'); }
function icoNote() { return svg('<path d="M4 4h16v12l-4 4H4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/>'); }
function icoAlert() { return svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/>'); }
function icoHelp() { return svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'); }
function icoUpload() { return svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'); }
function icoMail() { return svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'); }
function icoDownload() { return svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'); }
function icoTruck() { return svg('<path d="M10 17V6a1 1 0 0 0-1-1H2v11h2"/><path d="M14 17h-4"/><path d="M20 17h2v-4l-3-4h-5v8h2"/><circle cx="7" cy="17.5" r="2.5"/><circle cx="17" cy="17.5" r="2.5"/>'); }
function icoRepeat() { return svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'); }

export const MODAL_STYLES = `
  .hyve-modal { position: fixed; inset: 0; z-index: 500; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .hyve-modal[hidden] { display: none; }
  .hyve-modal__backdrop { display: block !important; position: absolute; inset: 0; background: rgba(15, 23, 42, 0.4); backdrop-filter: blur(4px); }
  .hyve-modal__panel { position: relative; background: var(--hyve-white); border-radius: var(--hyve-radius-lg); width: 100%; max-width: 680px; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(15,23,42,0.10), 0 8px 10px -6px rgba(15,23,42,0.04); }

  .hyve-modal__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--hyve-border); }
  .hyve-modal__title { font-family: var(--hyve-display); font-size: 18px; font-weight: 800; margin: 0; }
  .hyve-modal__close { border: 0; background: transparent; color: var(--hyve-muted); cursor: pointer; padding: 4px; line-height: 0; border-radius: 6px; }
  .hyve-modal__close svg { width: 20px; height: 20px; }
  .hyve-modal__close:hover { background: #F1F5F9; color: var(--hyve-900); }

  .hyve-modal__body { padding: 18px 22px; overflow-y: auto; }
  .hyve-modal__facts { display: flex; flex-wrap: wrap; gap: 8px 26px; padding-bottom: 14px; margin-bottom: 14px; border-bottom: 1px solid var(--hyve-border); }
  .hyve-modal__facts div { display: flex; flex-direction: column; }
  .hyve-modal__facts span { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--hyve-muted); }
  .hyve-modal__facts strong { font-size: 12.5px; font-weight: 700; color: var(--hyve-900); }

  .hyve-modal__cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
  .hyve-modal__col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .hyve-modal__panel-box { border: 1px solid var(--hyve-border); border-radius: var(--hyve-radius); padding: 14px; }
  .hyve-modal__panel-title { display: flex; align-items: center; gap: 7px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--hyve-muted); margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px solid var(--hyve-border); }
  .hyve-modal__panel-title svg { width: 15px; height: 15px; }

  .hyve-tl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .hyve-tl__step { display: flex; gap: 10px; padding-bottom: 14px; position: relative; }
  .hyve-tl__step:not(:last-child)::before { content: ''; position: absolute; left: 10px; top: 22px; bottom: 0; width: 1.5px; background: var(--hyve-border-strong); }
  .hyve-tl__dot { width: 21px; height: 21px; border-radius: 9999px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; background: #F1F5F9; color: transparent; border: 1.5px solid var(--hyve-border-strong); z-index: 1; }
  .hyve-tl__dot svg { width: 12px; height: 12px; }
  .hyve-tl__step.is-done .hyve-tl__dot { background: #DCFCE7; border-color: #86EFAC; color: #15803D; }
  .hyve-tl__step.is-current .hyve-tl__dot { background: var(--hyve-gradient); border-color: transparent; color: #0A1414; }
  .hyve-tl__label { display: block; font-size: 12.5px; font-weight: 600; color: var(--hyve-900); }
  .hyve-tl__step.is-todo .hyve-tl__label { color: var(--hyve-muted); font-weight: 500; }
  .hyve-tl__time { display: block; font-size: 11px; color: var(--hyve-muted); }
  .hyve-tl__branch { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: #B45309; background: #FEF3C7; border-radius: 8px; padding: 8px 10px; margin: 0 0 12px; }
  .hyve-tl__branch svg { width: 15px; height: 15px; flex-shrink: 0; }

  .hyve-modal__line { display: flex; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--hyve-border); }
  .hyve-modal__line:last-of-type { border-bottom: 0; }
  .hyve-modal__line-title { display: block; font-size: 12.5px; font-weight: 700; color: var(--hyve-900); }
  .hyve-modal__line-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .hyve-modal__chip { background: #F1F5F9; color: var(--hyve-700); border-radius: 6px; padding: 1px 7px; font-size: 10.5px; font-weight: 600; }
  .hyve-modal__line-money { text-align: right; white-space: nowrap; }
  .hyve-modal__line-unit { display: block; font-size: 10.5px; color: var(--hyve-muted); }
  .hyve-modal__line-money strong { font-size: 12.5px; font-weight: 700; }
  .hyve-modal__total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--hyve-border); font-size: 12px; color: var(--hyve-500); }
  .hyve-modal__total strong { font-family: var(--hyve-display); font-size: 16px; font-weight: 800; color: var(--hyve-900); }

  .hyve-modal__row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: 12px; }
  .hyve-modal__row span { color: var(--hyve-muted); flex-shrink: 0; }
  .hyve-modal__row strong { font-weight: 700; text-align: right; }
  .hyve-modal__link { color: var(--hyve-teal-dark); font-weight: 700; text-decoration: none; }
  .hyve-modal__muted { font-size: 12px; color: var(--hyve-muted); margin: 0; word-break: break-all; }
  .hyve-modal__note { display: flex; gap: 7px; align-items: flex-start; font-size: 11.5px; color: #B45309; background: #FEF3C7; border-radius: 8px; padding: 8px 10px; margin: 12px 0 0; }

  .hyve-modal__proof-actions { margin: 12px 0 0; border-top: 1px solid var(--hyve-border); padding-top: 12px; }
  .hyve-modal__proof-label { display: block; font-size: 11.5px; color: var(--hyve-muted); margin-bottom: 5px; }
  .hyve-modal__proof-input { width: 100%; border: 1px solid var(--hyve-border-strong); border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 12.5px; color: var(--hyve-900); resize: vertical; }
  .hyve-modal__proof-input:focus { outline: 2px solid rgba(110,222,225,0.45); outline-offset: 1px; }
  .hyve-modal__proof-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }

  .hyve-art__line { margin-top: 14px; }
  .hyve-art__line-title { display: block; font-size: 12px; font-weight: 700; color: var(--hyve-900); margin-bottom: 8px; }
  .hyve-art__zone { margin-top: 12px; }
  .hyve-art__zone-label { display: block; font-size: 12px; font-weight: 700; color: var(--hyve-900); margin-bottom: 6px; }

  /* Matches the drop zone on the product page. */
  .hyve-art__drop {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 1.5px dashed #CBD5E1; border-radius: 10px; padding: 18px 12px;
    font-size: 13px; color: var(--hyve-500); cursor: pointer; text-align: center;
  }
  .hyve-art__drop strong { color: #0F766E; }
  .hyve-art__drop svg { width: 18px; height: 18px; }
  .hyve-art__drop:hover, .hyve-art__zone.is-dragging .hyve-art__drop { border-color: #0F766E; background: rgba(110,222,225,0.08); }
  .hyve-art__hidden-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

  .hyve-art__saved-btn {
    display: inline-flex; align-items: center; gap: 6px; margin-top: 8px;
    border: 1px solid var(--hyve-border-strong); background: #fff; border-radius: 8px;
    padding: 7px 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--hyve-700); cursor: pointer;
  }
  .hyve-art__saved-btn svg { width: 14px; height: 14px; }
  .hyve-art__saved-btn:hover { border-color: var(--hyve-900); color: var(--hyve-900); }

  .hyve-art__chosen { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #15803D; margin: 8px 0 0; }
  .hyve-art__chosen[hidden] { display: none; }

  .hyve-art__picker { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .hyve-art__picker[hidden] { display: none; }
  .hyve-art__picker-backdrop { display: block !important; position: absolute; inset: 0; background: rgba(15,23,42,0.5); }
  .hyve-art__picker-panel { position: relative; background: #fff; border-radius: 14px; width: min(520px, 100%); max-height: 80vh; overflow: auto; padding: 18px 20px 20px; }
  .hyve-art__picker-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .hyve-art__picker-title { font-size: 15px; font-weight: 700; margin: 0; }
  .hyve-art__saved-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
  .hyve-art__saved-item {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    border: 1px solid var(--hyve-border); border-radius: 10px; padding: 10px; background: #fff;
    font: inherit; font-size: 11.5px; cursor: pointer; text-align: center;
  }
  .hyve-art__saved-item:hover { border-color: #0F766E; }
  .hyve-art__saved-thumb { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 8px; background: #F8FAFC; }
  .hyve-art__saved-thumb--file { display: flex; align-items: center; justify-content: center; }
  .hyve-art__saved-thumb--file svg { width: 24px; height: 24px; color: var(--hyve-muted); }
  .hyve-art__saved-name { word-break: break-word; font-weight: 600; color: var(--hyve-700); }

  .hyve-art__limits { font-size: 11px; color: var(--hyve-muted); margin: 8px 0 0; }
  .hyve-modal__note svg { width: 15px; height: 15px; flex-shrink: 0; margin-top: 1px; }

  .hyve-tile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 8px; }
  .hyve-tile {
    position: relative; display: block; aspect-ratio: 4 / 3; overflow: hidden;
    border: 1px solid var(--hyve-border); border-radius: 10px; text-decoration: none; background: #F8FAFC;
  }
  .hyve-tile:hover { border-color: var(--hyve-teal-dark); }
  .hyve-tile__img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .hyve-tile__img--file { display: flex; align-items: center; justify-content: center; }
  .hyve-tile__img--file svg { width: 28px; height: 28px; color: var(--hyve-muted); margin: 0; }
  .hyve-tile__caption {
    position: absolute; left: 0; right: 0; bottom: 0; padding: 20px 10px 8px;
    display: flex; flex-direction: column; gap: 1px;
    background: linear-gradient(to top, rgba(15,23,42,0.82), rgba(15,23,42,0));
  }
  .hyve-tile__label { font-size: 11.5px; font-weight: 700; color: #fff; }
  .hyve-tile__sub {     
    font-size: 10px;
    color: rgba(255, 255, 255, 0.82);
    word-break: break-all;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden; 
  }

  .hyve-modal__proofs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .hyve-modal__proof { display: flex; flex-direction: column; gap: 3px; padding: 14px 12px; border: 1px solid var(--hyve-border); border-radius: 10px; text-decoration: none; color: var(--hyve-900); background: #F8FAFC; }
  .hyve-modal__proof:hover { border-color: var(--hyve-teal-dark); }
  .hyve-modal__proof svg { width: 20px; height: 20px; color: var(--hyve-teal-dark); margin-bottom: 4px; }
  .hyve-modal__proof-label { font-size: 12px; font-weight: 700; }
  .hyve-modal__proof-sub { font-size: 10.5px; color: var(--hyve-muted); }

  .hyve-modal__foot { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; padding: 14px 22px; border-top: 1px solid var(--hyve-border); background: #F8FAFC; }

  @media (max-width: 720px) {
    .hyve-modal__cols { grid-template-columns: 1fr; }
    .hyve-modal__foot { justify-content: stretch; }
  }`;


export const MODAL_SCRIPT = `
<script>
/* Order detail modal: open, close on backdrop / X / Escape, lock body scroll. */
(function () {
  var open = null;

  function close() {
    if (!open) return;
    open.hidden = true;
    document.body.style.overflow = '';
    open = null;
  }

  function openById(id) {
    var modal = id && document.getElementById(id);
    if (!modal) return false;
    close();
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    open = modal;
    return true;
  }

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest && event.target.closest('[data-modal-open]');
    if (trigger) {
      openById(trigger.getAttribute('data-modal-open'));
      return;
    }
    if (event.target.closest && event.target.closest('[data-modal-close]')) close();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close();
  });

  /* ---------- artwork: drop zones and the saved-artwork picker ---------- */

  var pickingFor = null;

  function nameFromUrl(url) {
    var path = String(url || '').split('?')[0];
    try { return decodeURIComponent(path.split('/').pop() || 'Artwork'); }
    catch (e) { return path.split('/').pop() || 'Artwork'; }
  }

  // A position holds either an upload or a saved file, never both — choosing
  // one clears the other so the order cannot receive two files for one spot.
  function showChoice(zone, label, fromSaved) {
    var chosen = zone.querySelector('[data-art-chosen]');
    var file = zone.querySelector('[data-art-file]');
    var saved = zone.querySelector('[data-art-saved]');
    if (fromSaved && file) file.value = '';
    if (!fromSaved && saved) saved.value = '';
    if (chosen) {
      chosen.textContent = label ? '\u2713 ' + label : '';
      chosen.hidden = !label;
    }
  }

  document.addEventListener('change', function (event) {
    var file = event.target.closest && event.target.closest('[data-art-file]');
    if (!file) return;
    var zone = file.closest('[data-art-zone]');
    if (zone) showChoice(zone, file.files && file.files[0] ? file.files[0].name : '', false);
  });

  document.addEventListener('click', function (event) {
    var pick = event.target.closest && event.target.closest('[data-art-pick]');
    if (pick) {
      pickingFor = pick.closest('[data-art-zone]');
      var picker = pick.closest('.hyve-modal__panel').querySelector('[data-art-picker]');
      if (picker) picker.hidden = false;
      return;
    }

    if (event.target.closest && event.target.closest('[data-art-picker-close]')) {
      var openPicker = event.target.closest('[data-art-picker]');
      if (openPicker) openPicker.hidden = true;
      pickingFor = null;
      return;
    }

    var choose = event.target.closest && event.target.closest('[data-art-choose]');
    if (choose && pickingFor) {
      var saved = pickingFor.querySelector('[data-art-saved]');
      if (saved) saved.value = choose.getAttribute('data-url') || '';
      showChoice(pickingFor, choose.getAttribute('data-name') || nameFromUrl(choose.getAttribute('data-url')), true);
      var box = choose.closest('[data-art-picker]');
      if (box) box.hidden = true;
      pickingFor = null;
    }
  });

  // Dropping a file onto a position is the same as choosing it, so the buyer
  // can drag a logo straight in as they do on the product page.
  ['dragenter', 'dragover'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var zone = event.target.closest && event.target.closest('[data-art-zone]');
      if (!zone) return;
      event.preventDefault();
      zone.classList.add('is-dragging');
    });
  });

  document.addEventListener('dragleave', function (event) {
    var zone = event.target.closest && event.target.closest('[data-art-zone]');
    if (zone) zone.classList.remove('is-dragging');
  });

  document.addEventListener('drop', function (event) {
    var zone = event.target.closest && event.target.closest('[data-art-zone]');
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove('is-dragging');
    var dropped = event.dataTransfer && event.dataTransfer.files;
    if (!dropped || !dropped.length) return;
    var input = zone.querySelector('[data-art-file]');
    if (!input) return;
    input.files = dropped;
    showChoice(zone, dropped[0].name, false);
  });

  // Arriving from another page with ?order=#1234 opens that order straight
  // away — the invoices list links here, and an order has no page of its own.
  var wanted = new URLSearchParams(window.location.search).get('order');
  if (wanted && openById('order-' + wanted)) {
    open.scrollIntoView({ block: 'nearest' });
  }
})();
</script>`;
