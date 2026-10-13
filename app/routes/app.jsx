import { Outlet, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

import { getStaffMember } from "../lib/staff-member.server";

export const loader = async ({ request }) => {
  const { sessionToken } = await authenticate.admin(request);
  const user = await getStaffMember(request, sessionToken);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", isOwner: !!user?.account_owner };
};

export default function App() {
  const { apiKey, isOwner } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app/quotes">Quotes</s-link>
        <s-link href="/app/credit-review">Credit Review</s-link>
        <s-link href="/app/production-orders">Production Orders</s-link>
        <s-link href="/app/order-statuses">Order Statuses</s-link>
        <s-link href="/app/distributors">Distributor Applications</s-link>
        <s-link href="/app/notification-recipients">Notification Recipients</s-link>
        <s-link href="/app/business-holidays">Holidays</s-link>
        <s-link href="/app/commercial-settings">Commercial Settings</s-link>
        <s-link href="/app/tier-prices">Tier Prices</s-link>
        <s-link href="/app/sla-engine">Manual SLA</s-link>
        <s-link href="/app/pickup-config">Pickup Configuration</s-link>
        <s-link href="/app/bank-details">Bank Details</s-link>
        <s-link href="/app/pending-payments">Pending Payments</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError(); return boundary.error(error);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
