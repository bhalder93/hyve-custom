import {
  escapeHtml,
  formatDate,
} from "../email-utils.server";

export function customerEmailLayout({
  title,
  preheader = "",
  order,
  body,
}) {
  const orderName =
    escapeHtml(
      order?.name || "",
    );

  const orderDate =
    formatDate(
      order?.createdAt,
    );

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  />
  <title>${escapeHtml(title)}</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#f6f6f6;
    font-family:Arial,Helvetica,sans-serif;
    color:#111;
  "
>
  <div
    style="
      display:none;
      max-height:0;
      overflow:hidden;
    "
  >
    ${escapeHtml(preheader)}
  </div>

  <table
    width="100%"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="background:#f6f6f6"
  >
    <tr>
      <td align="center">

        <table
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="
            max-width:640px;
            background:#fff;
            margin:24px auto;
          "
        >

          <tr>
            <td
              style="
                padding:28px 32px;
                border-bottom:1px solid #eee;
              "
            >
              <div
                style="
                  font-size:26px;
                  font-weight:700;
                "
              >
                HYVE
              </div>
            </td>
          </tr>

          <tr>
            <td
              style="
                padding:32px;
              "
            >

              <h1
                style="
                  margin:0 0 18px;
                  font-size:24px;
                  line-height:1.3;
                "
              >
                ${escapeHtml(title)}
              </h1>

              ${
                orderName
                  ? `
                    <p
                      style="
                        margin:0 0 6px;
                        color:#555;
                      "
                    >
                      Order:
                      <strong>${orderName}</strong>
                    </p>
                  `
                  : ""
              }

              ${
                orderDate
                  ? `
                    <p
                      style="
                        margin:0 0 24px;
                        color:#555;
                      "
                    >
                      Order date:
                      ${orderDate}
                    </p>
                  `
                  : ""
              }

              ${body}

            </td>
          </tr>

          <tr>
            <td
              style="
                padding:24px 32px;
                border-top:1px solid #eee;
                font-size:13px;
                color:#666;
              "
            >
              Need help?
              ${
                process.env.HYVE_SUPPORT_EMAIL
                  ? `
                    Contact
                    <a
                      href="mailto:${escapeHtml(
                        process.env
                          .HYVE_SUPPORT_EMAIL,
                      )}"
                    >
                      ${escapeHtml(
                        process.env
                          .HYVE_SUPPORT_EMAIL,
                      )}
                    </a>
                  `
                  : "Contact Hyve customer service."
              }
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>
  `;
}