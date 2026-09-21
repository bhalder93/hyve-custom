import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { errorState } from "../lib/account-error.server";
import { signedOutPage } from "../lib/account-signed-out.server";
import { loadAccount } from "../lib/account-data.server";
import { mapOrders, awaitingActionCount } from "../lib/account-orders.server";
import { artworkPage } from "../lib/account-artwork.server";
import { listArtwork, uploadArtwork, deleteArtwork, artworkOwnerGid } from "../lib/artwork.server";

/**
 * Saved Artwork.
 * Storefront: /apps/account/artwork  ->  <app>/proxy/artwork  (this route)
 *
 * The action handles upload and delete, then re-renders the page with a
 * message. Uploads are multipart, so this route never returns a redirect —
 * the App Proxy would lose it.
 */
export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);
  return renderPage({ liquid, admin, request });
};

export const action = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  if (!customerId) return liquid(signedOutPage("/apps/account/artwork"));

  let flash = null;
  try {
    const owner = await ownerFor(admin, customerId);
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");

    if (intent === "upload") {
      const result = await uploadArtwork(admin, owner, formData.get("artwork"));
      flash = result.ok
        ? { ok: true, message: `${result.filename} uploaded to your library.` }
        : { ok: false, message: result.error };
    } else if (intent === "delete") {
      const result = await deleteArtwork(admin, owner, String(formData.get("artworkId") || ""));
      flash = result.ok
        ? { ok: true, message: `${result.deleted} deleted.` }
        : { ok: false, message: result.error };
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] artwork action failed", error);
    flash = { ok: false, message: "Something went wrong. Please try again." };
  }

  return renderPage({ liquid, admin, request, flash });
};

async function renderPage({ liquid, admin, request, flash = null }) {
  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return liquid(signedOutPage("/apps/account/artwork"));

    const account = await loadAccount(admin, customerId);

    if (account.failed) {
      return liquid(accountShell({ active: "artwork", main: errorState(), customer: account.customer }));
    }

    // The library belongs to the company where there is one, so who owns it can
    // only be known after the account is read.
    const owner = artworkOwnerGid({ companyId: account.terms?.companyId, customerId });
    const library = await listArtwork(admin, owner, `gid://shopify/Customer/${customerId}`);

    const orders = mapOrders(account.orderNodes);

    return liquid(
      accountShell({
        active: "artwork",
        main: artworkPage({ files: library.files, flash }),
        customer: account.customer,
        isDistributor: account.isDistributor,
        counts: { orders: awaitingActionCount(orders) },
        terms: account.terms,
      }),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] artwork page failed", error);
    return liquid(accountShell({ active: "artwork", main: errorState() }));
  }
}

/** The company's library when the buyer has one, otherwise their own. */
async function ownerFor(admin, customerId) {
  const account = await loadAccount(admin, customerId);
  return artworkOwnerGid({ companyId: account.terms?.companyId, customerId });
}
