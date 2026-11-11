/**
 * Decoration zones on an order line.
 *
 * A line records where it is being decorated in its own properties, written at
 * add-to-cart by the product page. The portal has to read them the same way the
 * cart does, so a send-later order can be completed later against exactly the
 * positions the buyer chose:
 *
 *   Full Colour Wrap          -> one zone, the whole product
 *   Imprint Locations         -> "Laser: Front, Back", one zone per location
 *   Artwork: <anything>       -> a zone in its own right
 *
 * The zone key is the property the artwork URL lives under, so filling a zone
 * later means writing that same key. Mirrors zonesFromProperties() in the
 * theme's hyve-cart-artwork.js — if one changes, both must.
 */

const ARTWORK_PREFIX = "Artwork:";

/**
 * Format line title cleanly: "MagSnap Key Cable — Black" or "Satin Pen".
 * Ignores "Default Title" for single-variant products.
 */
export function lineTitleOf(line) {
  if (!line) return "";
  if (typeof line === "string") return line.trim();
  const title = String(line.title || "").trim();
  const variant =
    line.variantTitle && line.variantTitle !== "Default Title"
      ? String(line.variantTitle).trim()
      : "";
  return [title, variant].filter(Boolean).join(" — ");
}

/**
 * The order attribute a file sent after the order is saved under:
 *   "MagSnap Key Cable — Black, Digital — BARREL"
 *
 * This displays in the Shopify admin order details under "Additional details".
 * If line details are unavailable, falls back to legacy key format:
 *   "Artwork: Digital - Front (line 16450215248088)"
 *
 * @param {string} zoneKey "Artwork: Digital - Front"
 * @param {string} lineId the line item's GID
 * @param {object|string} [line] the line item object or name
 * @param {string} [zoneLabel] formatted zone label (e.g. "Digital — BARREL")
 */
export function lateArtworkKey(zoneKey, lineId, line, zoneLabel) {
  const lineTitle = lineTitleOf(line);
  const label = zoneLabel || (zoneKey || "").replace(/^Artwork:\s*/i, "").trim().replace(/\s+-\s+/g, " — ");
  if (lineTitle && label) {
    return `${lineTitle}, ${label}`;
  }
  const id = String(lineId || "").split("/").pop();
  return id ? `${zoneKey} (line ${id})` : zoneKey;
}

/**
 * Legacy key helper for backwards compatibility with existing orders in Shopify.
 */
export function legacyLateArtworkKey(zoneKey, lineId) {
  const id = String(lineId || "").split("/").pop();
  return id ? `${zoneKey} (line ${id})` : zoneKey;
}

/**
 * Whether every decoration position on a line has its artwork, including
 * files sent after the order was placed. Those are saved on the order, since a
 * line's own properties can't change once the order exists, so the line's
 * "Artwork: Artwork Pending" stays as it was and has to be read alongside them.
 */
export function artworkSupplied(attributes, orderAttributes, lineId, line) {
  const zones = zonesFromAttributes(attributes, orderAttributes, lineId, line);
  return zones.length > 0 && zones.every((zone) => zone.url);
}

/**
 * @param {Array<{key?:string, value?:string}>} attributes a line's customAttributes
 * @param {Array<{key?:string, value?:string}>} [orderAttributes] the order's own
 *   attributes. Artwork supplied after the order exists is written there,
 *   because a line's properties are fixed once the order is placed — so a zone
 *   filled later is found here rather than on the line.
 * @param {string} [lineId] the line item's GID, which the order keys its files by
 * @param {object|string} [line] the line item object or title
 * @returns {Array<{key:string, label:string, url:string, lateKey:string, legacyKey:string, suppliedLater:boolean}>}
 */
export function zonesFromAttributes(attributes, orderAttributes, lineId, line) {
  // The line's own properties decide which zones exist. They are written at
  // add-to-cart and fixed once the order is placed, so they are the only
  // honest answer to "what is being decorated here".
  const lineProps = {};
  for (const attr of attributes || []) {
    if (attr?.key) lineProps[attr.key] = String(attr.value ?? "");
  }

  // Artwork supplied after the order exists is written to the order, because a
  // line's properties can no longer be changed. It fills a zone this line
  // already has; it never creates one. Letting it create zones put the whole
  // order's artwork on every line, including an undecorated one.
  const suppliedLater = {};
  for (const attr of orderAttributes || []) {
    if (attr?.key && attr.value) suppliedLater[attr.key] = String(attr.value);
  }

  const laterUrl = (key, label) => {
    const preferred = lateArtworkKey(key, lineId, line, label);
    const legacy = legacyLateArtworkKey(key, lineId);
    return (
      suppliedLater[preferred] ||
      suppliedLater[`${preferred}:`] ||
      suppliedLater[legacy] ||
      suppliedLater[`${legacy}:`] ||
      suppliedLater[key] ||
      ""
    );
  };

  const zone = (key, label) => {
    const lateKey = lateArtworkKey(key, lineId, line, label);
    const legacyKey = legacyLateArtworkKey(key, lineId);
    const later = laterUrl(key, label);
    return {
      key,
      label,
      url: later || lineProps[key] || "",
      lateKey,
      legacyKey,
      suppliedLater: Boolean(later),
    };
  };

  if (lineProps["Full Colour Wrap"]) {
    return [zone(`${ARTWORK_PREFIX} Full Colour Wrap`, "Full Colour Wrap")];
  }

  if (lineProps["Imprint Locations"]) {
    const raw = lineProps["Imprint Locations"];
    const split = raw.indexOf(":");
    const method = (split > -1 ? raw.slice(0, split) : raw).trim();
    const locations =
      split > -1
        ? raw
            .slice(split + 1)
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : [];

    return locations.map((location) => zone(`${ARTWORK_PREFIX} ${method} - ${location}`, `${method} — ${location}`));
  }

  return Object.keys(lineProps)
    .filter((key) => key.startsWith(ARTWORK_PREFIX))
    .map((key) => {
      const rawLabel = key.slice(ARTWORK_PREFIX.length).trim() || "Artwork";
      const label = rawLabel.replace(/\s+-\s+/g, " — ");
      return zone(key, label);
    });
}
