import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/PrintInvoice.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.print-action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
