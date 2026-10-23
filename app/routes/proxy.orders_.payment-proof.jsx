import { authenticate } from "../shopify.server";
import { portalChrome } from "../lib/account-data.server";
import { loadOrderForAction } from "../lib/order-action.server";
import { uploadToShopifyFiles } from "../lib/shopify-files.server";
import { depositState, loadDepositOrder } from "../lib/deposit.server";
import { adminOrderUrl } from "../lib/admin-links.server";
import { getCustomerServiceRecipients } from "../utils/metaobjects/notification-recipients.server";
import { sendPaymentConfirmationAlert } from "../utils/email.server";

/**
 * A bank transfer confirmation for a 30% deposit order (HYV-150).
 * Storefront: POST /apps/account/orders/payment-proof
 *
 * The file goes to Shopify Files and onto the order's timeline, and Customer
 * Service (Notification Recipients) is emailed it. Nothing is marked paid
 * here: CS records the money when it arrives.
 */
const ACCEPTED = [".pdf", ".png", ".jpg", ".jpeg"];
const MAX_BYTES = 10 * 1024 * 1024;

const NOTE_ADD = `#graphql
  mutation PaymentProofNote($input: OrderInput!) {
    orderUpdate(input: $input) { order { id } userErrors { field message } }
  }`;

const ORDER_NOTE = `#graphql
  query PaymentProofOrder($id: ID!) { order(id: $id) { note } }`;

export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    if (!customerId) return backToOrders({ error: "Please sign in to send a payment confirmation." });

    const form = await request.formData();
    const orderGid = String(form.get("order") || "");
    if (!orderGid.startsWith("gid://shopify/Order/")) {
      return backToOrders({ error: "We couldn't work out which order that was." });
    }
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function" || !file.size) {
      return backToOrders({ error: "Choose the payment confirmation file to upload." });
    }
    const filename = String(file.name || "payment-confirmation");
    const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED.includes(extension)) return backToOrders({ error: "Upload a PDF, PNG or JPG file." });
    if (file.size > MAX_BYTES) return backToOrders({ error: "That file is larger than 10 MB." });

    const chrome = await portalChrome(admin, customerId);
    const found = await loadOrderForAction(admin, orderGid, {
      customerGid: `gid://shopify/Customer/${customerId}`,
      locationGids: chrome.terms?.locationIds || [],
    });
    if (!found.ok) return backToOrders({ error: found.error });
    const { order } = found;

    const depositOrder = await loadDepositOrder(admin, orderGid);
    const state = depositState(depositOrder);
    if (!state || (!state.depositPending && !state.balanceDue)) {
      return backToOrders({ error: `Nothing is due on ${order.name}.` });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const uploaded = await uploadToShopifyFiles(admin, file);
    if (!uploaded?.url) return backToOrders({ error: "We couldn't upload that file. Please try again." });

    // On the order too, so staff see it from Shopify admin.
    const buyer = chrome.customer?.name || chrome.customer?.email || "Customer";
    const existingNote = (await (await admin.graphql(ORDER_NOTE, { variables: { id: orderGid } })).json())?.data?.order?.note || "";
    const line = `Payment confirmation uploaded by ${buyer} on ${new Date().toISOString().slice(0, 10)}: ${uploaded.url}`;
    const noted = await (
      await admin.graphql(NOTE_ADD, {
        variables: { input: { id: orderGid, note: existingNote ? `${existingNote}\n${line}` : line } },
      })
    ).json();
    const noteError = noted?.data?.orderUpdate?.userErrors?.[0]?.message;
    if (noteError) console.warn("[payment-proof] order note not saved", order.name, noteError);

    const to = await getCustomerServiceRecipients(admin);
    if (to.length) {
      const due = state.depositPending ? state.deposit - state.received : state.outstanding;
      await sendPaymentConfirmationAlert({
        to: to.join(","),
        orderName: order.name,
        company: depositOrder?.purchasingEntity?.company?.name || "",
        buyer,
        amountDue: `${state.currency} ${due.toFixed(2)}${state.depositPending ? " (deposit)" : " (balance)"}`,
        fileUrl: uploaded.url,
        adminUrl: await adminOrderUrl(admin, orderGid).catch(() => ""),
        file: { filename, content: buffer, contentType: file.type || "application/octet-stream" },
      });
    } else {
      console.warn("[payment-proof] no Customer Service recipients for", order.name);
    }

    return backToOrders({
      notice: `Thanks — we've received your payment confirmation for ${order.name}. We'll confirm once the transfer arrives.`,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[portal] payment confirmation upload failed", error);
    return backToOrders({ error: "We couldn't send that file. Please try again later." });
  }
};

/** The form lives on the Orders page, so that's where the outcome is shown. */
function backToOrders({ notice, error }) {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice);
  if (error) params.set("error", error);

  return new Response(null, {
    status: 303,
    headers: { Location: `/apps/account/orders?${params.toString()}` },
  });
}
