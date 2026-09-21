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
 * @returns {Array<{key:string, label:string, url:string}>}
 */
export function zonesFromAttributes(attributes) {
  const props = {};
  for (const attr of attributes || []) {
    if (attr?.key) props[attr.key] = String(attr.value ?? "");
  }

  if (props["Full Colour Wrap"]) {
    const key = `${ARTWORK_PREFIX} Full Colour Wrap`;
    return [{ key, label: "Full Colour Wrap", url: props[key] || "" }];
  }

  if (props["Imprint Locations"]) {
    const raw = props["Imprint Locations"];
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
      return { key, label: `${method} — ${location}`, url: props[key] || "" };
    });
  }

  return Object.keys(props)
    .filter((key) => key.startsWith(ARTWORK_PREFIX))
    .map((key) => ({
      key,
      label: key.slice(ARTWORK_PREFIX.length).trim() || "Artwork",
      url: props[key] || "",
    }));
}
