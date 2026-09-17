import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

/**
 * The app's root, outside the embedded admin.
 *
 * Shopify opens the app with `?shop=`, which sends the staff member straight to
 * the dashboard. Anything else is someone reaching the server directly, so this
 * says what the app is and offers the sign-in that starts OAuth — rather than
 * the template's "[your app]" placeholder, which is what a merchant saw when
 * the redirect didn't fire.
 */
export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Hyve distributor portal</h1>
        <p className={styles.text}>
          Review distributor applications, decide quotes, and manage the B2B account area for
          Hyve.Promo. Open it from your Shopify admin under Apps.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Applications</strong>. Approve a distributor and the Shopify B2B company,
            contact, payment terms and pricing tier are created for them.
          </li>
          <li>
            <strong>Quotes</strong>. Accept or decline a quote and the buyer sees the decision in
            their portal straight away.
          </li>
          <li>
            <strong>Account area</strong>. Orders, invoices, saved artwork and team, served into
            the storefront at /apps/account.
          </li>
        </ul>
      </div>
    </div>
  );
}
