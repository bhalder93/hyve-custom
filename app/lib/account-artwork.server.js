/**
 * Saved Artwork page (F4, F13).
 *
 * Each file shows its name, upload date and how many orders it has been used
 * in. Formats a browser can render get a thumbnail; vector formats such as AI
 * and EPS get a generic file icon instead, because a browser cannot preview
 * them. A file can be deleted only where no order is using it.
 *
 * Layout and type match the approved mockup's Saved Artwork screen.
 */
import { esc } from "./account-shell.server";
import { MAX_FILE_LABEL, ACCEPTED_EXTENSIONS, isPreviewable } from "./artwork.server";
import { formatDate } from "./portal.server";

/**
 * @param {object} opts
 * @param {Array<object>} opts.files
 * @param {?{ok:boolean, message:string}} [opts.flash]
 */
export function artworkPage({ files = [], flash = null } = {}) {
  const tiles = files.map(fileTile).join("");

  return `
    ${ARTWORK_STYLES}
    <div class="hyve-art" data-artwork>
      <div class="hyve-art__head">
        <div>
          <h1 class="hyve-art__title">Saved Artwork</h1>
          <p class="hyve-art__sub">Your uploaded logos and artwork files</p>
        </div>
        <button type="button" class="hyve-art__upload-btn" data-upload-trigger>
          ${icoUpload()}<span>Upload Artwork</span>
        </button>
      </div>

      ${flash ? `<p class="hyve-art__flash${flash.ok ? "" : " is-error"}">${esc(flash.message)}</p>` : ""}

      <form class="hyve-art__form" method="post" enctype="multipart/form-data">
        <input type="file" name="artwork" accept="${ACCEPTED_EXTENSIONS.join(",")}" hidden data-upload-input>
        <input type="hidden" name="intent" value="upload">
      </form>

      <div class="hyve-art__grid">
        ${tiles}
        <button type="button" class="hyve-art__new" data-upload-trigger>
          ${icoPlus()}
          <span>Upload New</span>
        </button>
      </div>

      <p class="hyve-art__limit">
        Accepted: ${esc(ACCEPTED_EXTENSIONS.join(", "))}. Maximum file size ${esc(MAX_FILE_LABEL)}.
        Vector files are required for laser decoration; high-resolution raster files are accepted for digital and transfer.
      </p>
    </div>
    ${ARTWORK_SCRIPT}`;
}

function fileTile(file) {
  const date = formatDate(file.uploadedAt);
  // We now hold which orders used the file, not just how many, so the count
  // carries the order numbers as a tooltip.
  const orderNames = (file.orders || []).map((o) => o.name).filter(Boolean).join(", ");
  const used =
    file.orderCount > 0
      ? `<span class="hyve-art__used"${orderNames ? ` title="${esc(orderNames)}"` : ""}>Used in ${esc(file.orderCount)} order${file.orderCount === 1 ? "" : "s"}</span>`
      : "";

  // A browser cannot preview AI or EPS, so those get a generic file icon (F13).
  const thumb =
    file.previewUrl && isPreviewable(file.filename)
      ? `<img src="${esc(file.previewUrl)}" alt="${esc(file.filename)}" loading="lazy">`
      : `${icoFile()}<span class="hyve-art__ext">${esc(file.extension.replace(".", "").toUpperCase())}</span>`;

  // Deletable only where no order is using it (F13).
  const deleteAction =
    file.orderCount === 0
      ? `<form method="post" class="hyve-art__del">
           <input type="hidden" name="intent" value="delete">
           <input type="hidden" name="artworkId" value="${esc(file.id)}">
           <button type="submit" aria-label="Delete ${esc(file.filename)}">${icoTrash()}</button>
         </form>`
      : "";

  return `
    <div class="hyve-art__item">
      <a class="hyve-art__thumb" href="${esc(file.downloadUrl || "#")}" target="_blank" rel="noopener">${thumb}</a>
      ${deleteAction}
      <span class="hyve-art__name" title="${esc(file.filename)}">${esc(file.filename)}</span>
      <span class="hyve-art__meta">
        <span>${esc(date)}</span>
        ${used}
      </span>
    </div>`;
}

/* ---------- icons ---------- */
function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
function icoUpload() { return svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'); }
function icoPlus() { return svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'); }
function icoFile() { return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'); }
function icoTrash() { return svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'); }

const ARTWORK_STYLES = `
<style>
  .hyve-art__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .hyve-art__title { font-family: var(--hyve-display); font-size: 22px; font-weight: 800; margin: 0; }
  .hyve-art__sub { color: var(--hyve-muted); font-size: 13px; font-weight: 400; margin: 2px 0 0; }
  .hyve-art__upload-btn { display: inline-flex; align-items: center; gap: 5px; border: 0; cursor: pointer; font-family: inherit; background: var(--hyve-gradient); color: var(--hyve-900); font-size: 11.5px; font-weight: 700; padding: 8px 14px; border-radius: 6px; }
  .hyve-art__upload-btn:hover { filter: brightness(0.96); }
  .hyve-art__upload-btn svg { width: 14px; height: 14px; }

  .hyve-art__flash { font-size: 12.5px; font-weight: 600; color: #15803D; background: #DCFCE7; border-radius: 8px; padding: 10px 12px; margin: 0 0 14px; }
  .hyve-art__flash.is-error { color: #B91C1C; background: #FEE2E2; }
  .hyve-art__form { display: none; }

  .hyve-art__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; }
  .hyve-art__item { position: relative; background: var(--hyve-white); border: 1px solid var(--hyve-border); border-radius: var(--hyve-radius); padding: 10px; }
  .hyve-art__thumb { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; aspect-ratio: 1; background: rgba(15, 23, 42, 0.04); border-radius: 8px; color: var(--hyve-900); text-decoration: none; overflow: hidden; }
  .hyve-art__thumb img { width: 100%; height: 100%; object-fit: contain; }
  .hyve-art__thumb svg { width: 24px; height: 24px; }
  .hyve-art__ext { font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; color: var(--hyve-muted); }
  .hyve-art__name { display: block; font-size: 12px; font-weight: 600; color: var(--hyve-900); margin-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hyve-art__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11px; font-weight: 400; color: var(--hyve-muted); margin-top: 2px; }
  .hyve-art__used { background: rgba(110, 222, 225, 0.12); color: #0E7490; border-radius: 9999px; padding: 2px 6px; font-size: 9px; font-weight: 700; }

  .hyve-art__del { position: absolute; top: 16px; right: 16px; opacity: 0; transition: opacity 0.15s ease; }
  .hyve-art__item:hover .hyve-art__del, .hyve-art__del:focus-within { opacity: 1; }
  .hyve-art__del button { border: 0; background: rgba(255, 255, 255, 0.92); color: var(--hyve-error); border-radius: 6px; padding: 5px; cursor: pointer; line-height: 0; box-shadow: 0 1px 3px rgba(15,23,42,0.12); }
  .hyve-art__del svg { width: 14px; height: 14px; }

  .hyve-art__new { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 180px; background: transparent; border: 1px dashed var(--hyve-border-strong); border-radius: var(--hyve-radius); color: var(--hyve-muted); font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color 0.15s ease, color 0.15s ease; }
  .hyve-art__new:hover { border-color: var(--hyve-teal-dark); color: var(--hyve-teal-dark); }
  .hyve-art__new svg { width: 22px; height: 22px; }

  .hyve-art__limit { font-size: 11px; color: var(--hyve-muted); line-height: 1.6; margin: 16px 0 0; }
</style>`;

const ARTWORK_SCRIPT = `
<script>
(function () {
  var root = document.querySelector('[data-artwork]');
  if (!root) return;
  var input = root.querySelector('[data-upload-input]');
  var form = root.querySelector('.hyve-art__form');
  if (!input || !form) return;

  root.querySelectorAll('[data-upload-trigger]').forEach(function (btn) {
    btn.addEventListener('click', function () { input.click(); });
  });

  // Submit as soon as a file is chosen — no second click to confirm.
  input.addEventListener('change', function () {
    if (input.files && input.files.length) form.submit();
  });
})();
</script>`;
