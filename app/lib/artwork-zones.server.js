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
 * @param {Array<{key?:string, value?:string}>} attributes a line's customAttributes
 * @param {Array<{key?:string, value?:string}>} [orderAttributes] the order's own
 *   attributes. Artwork supplied after the order exists is written there,
 *   because a line's properties are fixed once the order is placed — so a zone
 *   filled later is found here rather than on the line.
 * @returns {Array<{key:string, label:string, url:string}>}
 */
export function zonesFromAttributes(attributes, orderAttributes) {
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
  const urlFor = (key) => suppliedLater[key] || lineProps[key] || "";

  if (lineProps["Full Colour Wrap"]) {
    const key = `${ARTWORK_PREFIX} Full Colour Wrap`;
    return [{ key, label: "Full Colour Wrap", url: urlFor(key) }];
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

    return locations.map((location) => {
      const key = `${ARTWORK_PREFIX} ${method} - ${location}`;
      return { key, label: `${method} — ${location}`, url: urlFor(key) };
    });
  }

  return Object.keys(lineProps)
    .filter((key) => key.startsWith(ARTWORK_PREFIX))
    .map((key) => ({
      key,
      label: key.slice(ARTWORK_PREFIX.length).trim() || "Artwork",
      url: urlFor(key),
    }));
}
