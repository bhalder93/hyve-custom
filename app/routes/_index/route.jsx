import { redirect } from "react-router";

/**
 * The app's root.
 *
 * Clicking the app's name in the Shopify admin opens this, not /app, and
 * Shopify doesn't always pass `?shop=` when it does — so the template's
 * conditional redirect left the merchant looking at a marketing page.
 *
 * There is nothing to land on: this is a single-merchant embedded app, and
 * installing goes through /auth/login. So the root is only ever a doorway to
 * the dashboard. Any params Shopify does send are carried through, and /app
 * authenticates, which sends anyone without a session to log in.
 */
export const loader = async ({ request }) => {
  const { search } = new URL(request.url);
  throw redirect(`/app${search}`);
};
