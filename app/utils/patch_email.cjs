const fs = require('fs');
const file = 'd:/Hit Projects/Hyve/hyve-custom/app/utils/email.server.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  'export async function sendReadyForCollectionEmail({\r\n  customerEmail,\r\n  customerName,\r\n  orderName,\r\n  orderDate,\r\n  lineItems = [],\r\n  orderUrl,\r\n}) {',
  'export async function sendReadyForCollectionEmail({\r\n  customerEmail,\r\n  customerName,\r\n  orderName,\r\n  orderDate,\r\n  lineItems = [],\r\n  orderUrl,\r\n  collectionDetails = {},\r\n  pickupConfig = {},\r\n}) {'
);
// Also try with \n
content = content.replace(
  'export async function sendReadyForCollectionEmail({\n  customerEmail,\n  customerName,\n  orderName,\n  orderDate,\n  lineItems = [],\n  orderUrl,\n}) {',
  'export async function sendReadyForCollectionEmail({\n  customerEmail,\n  customerName,\n  orderName,\n  orderDate,\n  lineItems = [],\n  orderUrl,\n  collectionDetails = {},\n  pickupConfig = {},\n}) {'
);

const oldBody = `<p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        As freight for this order is customer-arranged, please coordinate collection with your nominated carrier.
      </p>

      <p style="margin:0; line-height:1.7; font-size:15px;">
        If your carrier needs collection details or assistance, please contact our customer service team.
      </p>`;

const oldBodyCRLF = oldBody.replace(/\n/g, '\r\n');

const newBody = `<p style="margin:0 0 14px; line-height:1.7; font-size:15px;">
        As freight for this order is customer-arranged, please coordinate collection with your nominated carrier.
      </p>

      <div style="margin: 20px 0; padding: 16px; background-color: #f6f6f7; border-radius: 8px;">
        <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 16px; color: \${BRAND.primaryText};">Collection Details</h3>
        <table style="width: 100%; font-size: 14px; color: \${BRAND.primaryText}; border-collapse: collapse;">
          <tr>
            <td style="padding: 4px 0; width: 40%; font-weight: 600;">Ready Date</td>
            <td style="padding: 4px 0;">\${collectionDetails.readyDate || "—"}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; font-weight: 600;">Number of Cartons</td>
            <td style="padding: 4px 0;">\${collectionDetails.numberOfCartons || "—"}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; font-weight: 600;">Gross Weight</td>
            <td style="padding: 4px 0;">\${collectionDetails.grossWeight || "—"}Kg</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; font-weight: 600;">CBM</td>
            <td style="padding: 4px 0;">\${collectionDetails.cbm || "—"}</td>
          </tr>
        </table>
      </div>

      <div style="margin: 20px 0; padding: 16px; background-color: #f6f6f7; border-radius: 8px;">
        <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 16px; color: \${BRAND.primaryText};">Pickup Location</h3>
        <div style="font-size: 14px; color: \${BRAND.primaryText}; line-height: 1.5;">
          \${pickupConfig.pickup_address ? \`<p style="margin: 0 0 8px;"><strong>Address:</strong><br/>\${pickupConfig.pickup_address.replace(/\\n/g, '<br/>')}</p>\` : ''}
          \${pickupConfig.contact_name ? \`<p style="margin: 0 0 8px;"><strong>Contact:</strong> \${pickupConfig.contact_name} \${pickupConfig.contact_phone ? \`(\${pickupConfig.contact_phone})\` : ''}</p>\` : ''}
          <p style="margin: 0 0 4px;"><strong>Opening Hours:</strong></p>
          <ul style="margin: 0; padding-left: 20px; color: \${BRAND.secondaryText};">
            \${['monday_hours', 'tuesday_hours', 'wednesday_hours', 'thursday_hours', 'friday_hours', 'saturday_hours', 'sunday_hours'].map(day => {
              const val = pickupConfig[day];
              if (val) {
                const dayName = day.split('_')[0].charAt(0).toUpperCase() + day.split('_')[0].slice(1);
                return \`<li>\${dayName}: \${val}</li>\`;
              }
              return '';
            }).join('')}
          </ul>
        </div>
      </div>

      <p style="margin:0; line-height:1.7; font-size:15px;">
        If your carrier needs collection details or assistance, please contact our customer service team.
      </p>`;

content = content.replace(oldBody, newBody).replace(oldBodyCRLF, newBody);
fs.writeFileSync(file, content);
console.log('done');
