import {
  escapeHtml,
} from "../email-utils.server";

function attributesToMap(
  customAttributes = [],
) {
  return customAttributes.reduce(
    (result, item) => {
      result[item.key] =
        item.value;

      return result;
    },
    {},
  );
}

export function orderItemsHtml(
  order,
) {
  const items =
    order?.lineItems?.nodes ??
    [];

  if (!items.length) {
    return "";
  }

  const rows = items.map(
    (item) => {
      const attributes =
        attributesToMap(
          item.customAttributes,
        );

      let imprintMethod =
        "";

      if (
        attributes["_imprint"]
      ) {
        try {
          const parsed =
            JSON.parse(
              attributes[
                "_imprint"
              ],
            );

          imprintMethod =
            parsed?.method ??
            "";
        } catch {
          // Ignore malformed private cart property.
        }
      }

      imprintMethod =
        imprintMethod ||
        attributes[
          "Imprint Locations"
        ] ||
        "Blank";

      return `
        <tr>
          <td
            style="
              padding:10px;
              border-bottom:1px solid #eee;
            "
          >
            ${escapeHtml(
              item.title,
            )}
          </td>

          <td
            style="
              padding:10px;
              border-bottom:1px solid #eee;
            "
          >
            ${escapeHtml(
              imprintMethod,
            )}
          </td>

          <td
            align="right"
            style="
              padding:10px;
              border-bottom:1px solid #eee;
            "
          >
            ${Number(
              item.quantity || 0,
            )}
          </td>
        </tr>
      `;
    },
  );

  return `
    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      style="
        margin:24px 0;
        border:1px solid #eee;
        border-collapse:collapse;
      "
    >
      <thead>
        <tr>
          <th
            align="left"
            style="padding:10px"
          >
            Product
          </th>

          <th
            align="left"
            style="padding:10px"
          >
            Decoration
          </th>

          <th
            align="right"
            style="padding:10px"
          >
            Qty
          </th>
        </tr>
      </thead>

      <tbody>
        ${rows.join("")}
      </tbody>
    </table>
  `;
}