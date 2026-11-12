import '@shopify/ui-extensions/preact';
import { render } from 'preact';

// Print > Hyve invoice on the order page (HYV-219): the invoice PDF from
// Hyve Custom, the same one Download Invoice gives on a production order.
// The path is the app's own; Shopify sends it with the staff member's session.
export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const orderId = String(shopify.data.selected?.[0]?.id || '').split('/').pop();
  const src = orderId ? `/app/invoice-pdf/${orderId}?print=1` : undefined;
  return <s-admin-print-action src={src}></s-admin-print-action>;
}
