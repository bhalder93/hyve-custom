import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app/quotes">Quotes</s-link>
        <s-link href="/app/production-orders">Production Orders</s-link>
        <s-link href="/app/distributors">Distributor Applications</s-link>
        <s-link href="/app/notification-recipients">Notification Recipients</s-link>
        <s-link href="/app/business-holidays">Holidays</s-link>
        <s-link href="/app/commercial-settings">Commercial Settings</s-link>
        <s-link href="/app/sla-engine">Manual SLA</s-link>
        {/* <s-link href="/app/sla-rules"> SLA Rules</s-link> */}
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
