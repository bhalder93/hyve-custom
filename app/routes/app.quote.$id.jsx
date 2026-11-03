import { formatDateTime } from "../utils/date.js";
/* eslint-disable react/prop-types */
import { useState, useMemo, useEffect, useCallback } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { quoteStatus as quoteStatusFor } from "../lib/account-quotes.server";
import { quoteValidUntil } from "../lib/quote-document.server";
import { STAFF_QUOTE_LABELS, STAFF_QUOTE_TONES, quoteReference, formatCountryOfOrigin } from "../lib/quote-labels";
import { AdminTheme, Pill } from "../lib/admin-theme";
import { ShopifyFileUpload } from "../components/ShopifyFileUpload";
import { formatQuoteMoney as formatMoney, unitPriceFor } from "../lib/quote-pricing";

/* ==========================================================================
   Constants & Helpers
   ========================================================================== */

const STATUS_KEYS = {
  AWAITING_ACTION: "awaiting_action",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  EXPIRED: "expired",
};

/** What each line that isn't a product is called on the page. */
const KIND_LABELS = {
  "blank-sample": "Blank sample",
  setup: "Setup charge",
  rush: "Rush production",
  gift: "Gift packaging",
  sample: "Physical sample",
  duty: "Import duties",
};

/** The artwork choices, as the product page offers them. */
const ARTWORK_CHOICES = [
  { value: "now", label: "Upload Your Files", help: "Upload artwork to Shopify Files for each decoration position." },
  { value: "later", label: "Send Later", help: "The buyer sends the artwork after ordering (Artwork Pending)." },
  { value: "design", label: "Design for Me", help: "Hyve's design team creates or adapts the artwork." },
];

function cleanDraftOrderId(id) {
  if (!id) return "";
  return String(id).replace("gid://shopify/DraftOrder/", "");
}

function getShopifyAdminDraftOrderUrl(id, shop) {
  const numericId = cleanDraftOrderId(id);
  if (!numericId) return "";
  const shopHandle = String(shop || "").replace(".myshopify.com", "");
  if (shopHandle) {
    return `https://admin.shopify.com/store/${shopHandle}/draft_orders/${numericId}`;
  }
  return `https://${shop}/admin/draft_orders/${numericId}`;
}

function cleanOrderId(id) {
  if (!id) return "";
  return String(id).replace("gid://shopify/Order/", "");
}

function getShopifyAdminOrderUrl(id, shop) {
  const numericId = cleanOrderId(id);
  if (!numericId) return "";
  const shopHandle = String(shop || "").replace(".myshopify.com", "");
  if (shopHandle) {
    return `https://admin.shopify.com/store/${shopHandle}/orders/${numericId}`;
  }
  return `https://${shop}/admin/orders/${numericId}`;
}

function parseQuoteStatus(metafield) {
  if (!metafield || metafield.value === null || metafield.value === undefined || metafield.value === "") {
    return {
      key: STATUS_KEYS.AWAITING_ACTION,
      label: "Awaiting Action",
      tone: "warning",
      rawBool: null,
    };
  }

  const val = String(metafield.value).trim().toLowerCase();
  if (val === "true" || val === "accepted") {
    return {
      key: STATUS_KEYS.ACCEPTED,
      label: "Accepted",
      tone: "success",
      rawBool: true,
    };
  }

  if (val === "false" || val === "rejected" || val === "declined") {
    return {
      key: STATUS_KEYS.REJECTED,
      label: "Rejected",
      tone: "critical",
      rawBool: false,
    };
  }

  if (val === "expired") {
    return {
      key: STATUS_KEYS.EXPIRED,
      label: "Quote Expired",
      tone: "critical",
      rawBool: null,
    };
  }

  return {
    key: STATUS_KEYS.AWAITING_ACTION,
    label: "Awaiting Action",
    tone: "warning",
    rawBool: null,
  };
}

function getInitials(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "CU";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The artwork positions a decoration needs, keyed as the product page keys them. */
function artworkZones(decoration) {
  if (decoration.type === "fcw") return [{ key: "Artwork: Full Colour Wrap", label: "Full Colour Wrap" }];
  if (decoration.type === "imprint") {
    return decoration.locations.map((loc) => ({ key: `Artwork: ${decoration.method} - ${loc}`, label: `${decoration.method} — ${loc}` }));
  }
  return [];
}

function describeDecoration(decoration) {
  if (decoration?.type === "imprint") return `${decoration.method}: ${decoration.locations.join(", ")}`;
  if (decoration?.type === "fcw") return "Full Colour Wrap";
  return "No branding";
}

/* ==========================================================================
   Loader
   ========================================================================== */

const QUOTE_QUERY = `#graphql
  query GetDraftOrderDetails($id: ID!) {
    draftOrder(id: $id) {
      id
      name
      createdAt
      updatedAt
      status
      invoiceUrl
      invoiceSentAt
      order { id name }
      tags
      totalPriceSet { presentmentMoney { amount currencyCode } }
      subtotalPriceSet { presentmentMoney { amount currencyCode } }
      totalShippingPriceSet { presentmentMoney { amount currencyCode } }
      customer { id displayName email phone }
      purchasingEntity {
        ... on PurchasingCompany {
          company { name }
          contact { customer { displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } } }
        }
      }
      shippingAddress { address1 address2 city province zip country name phone }
      billingAddress { address1 address2 city province zip country name phone }
      lineItems(first: 100) {
        nodes {
          id
          title
          name
          quantity
          sku
          variantTitle
          image { url altText }
          product { id featuredImage { url altText } }
          customAttributes { key value }
          variant {
            id
            title
            selectedOptions { name value }
            inventoryItem { harmonizedSystemCode countryCodeOfOrigin }
          }
          originalUnitPriceSet { presentmentMoney { amount currencyCode } }
          discountedUnitPriceSet { presentmentMoney { amount currencyCode } }
        }
      }
      customAttributes { key value }
      metafield(namespace: "$app", key: "hyve_status") { id value type }
    }
  }`;

/** The quote as the page shows it, or null when there's no such draft order. */
async function fetchQuote(admin, draftOrderGid) {
  const json = await (await admin.graphql(QUOTE_QUERY, { variables: { id: draftOrderGid } })).json();
  const draftOrder = json?.data?.draftOrder;
  if (!draftOrder) return null;

  const listStatus = quoteStatusFor({ ...draftOrder, hyveStatus: draftOrder.metafield });
  const isExpired =
    listStatus === "expired" ||
    draftOrder.status === "EXPIRED" ||
    (draftOrder.tags || []).some((t) => /^(quote[-_]?)?expired$/i.test(String(t).trim())) ||
    Boolean(
      draftOrder.status !== "COMPLETED" &&
      !draftOrder.order?.id &&
      draftOrder.createdAt &&
      quoteValidUntil(draftOrder.createdAt).at < new Date()
    );

  return {
    ...draftOrder,
    numericId: cleanDraftOrderId(draftOrder.id),
    quoteStatus: parseQuoteStatus(draftOrder.metafield),
    // Where the quote stands with the buyer, by the same rules and names as
    // the Quotes list and the dashboard (HYV-165). The pill beside it is
    // Hyve's own Approve/Reject decision.
    listStatus: isExpired ? "expired" : listStatus,
    isExpired,
  };
}

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";
  const paramId = params?.id;
  if (!paramId) {
    throw new Response("Draft Order ID is required.", { status: 400 });
  }

  const draftOrderGid = paramId.startsWith("gid://shopify/DraftOrder/")
    ? paramId
    : `gid://shopify/DraftOrder/${paramId}`;

  try {
    const quote = await fetchQuote(admin, draftOrderGid);
    if (!quote) {
      throw new Response("Draft Order Not Found", { status: 404 });
    }
    const { loadQuoteEditor } = await import("../lib/quote-editor.server");
    return { quote, editor: await loadQuoteEditor(admin, draftOrderGid), shop };
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[app.quote.$id.loader] Error fetching draft order:", err);
    throw new Response("Error loading draft order details: " + err.message, { status: 500 });
  }
};

/* ==========================================================================
   Action
   ========================================================================== */

function parseJson(raw, fallback) {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return fallback;
  }
}

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();
  const draftOrderId = String(formData.get("draftOrderId") || "").trim();

  if (!/^gid:\/\/shopify\/DraftOrder\/\d+$/.test(draftOrderId)) {
    return { success: false, error: "Missing draft order ID." };
  }

  const existingQuote = await fetchQuote(admin, draftOrderId);
  if (!existingQuote) {
    return { success: false, error: "Draft order not found." };
  }
  if (existingQuote.isExpired) {
    return { success: false, error: "This quote has expired and cannot be modified." };
  }

  // Our own quotation email, with the PDF attached (HYV-166).
  if (intent === "email_quotation") {
    const { emailStaffQuote } = await import("../lib/staff-quote-email.server");
    const result = await emailStaffQuote(admin, draftOrderId);
    return result.ok
      ? { success: true, emailed: true, message: `Quotation emailed to ${result.to}.` }
      : { success: false, error: result.error };
  }

  // Every edit saves the whole quote repriced, the way the cart and checkout
  // price it (quote-editor.server.js).
  const edits = {
    save_lines: () => {
      const payload = parseJson(formData.get("payload"), {});
      return {
        change: {
          quantities: payload.quantities || {},
          gifts: payload.gifts || {},
          ...(typeof payload.rush === "boolean" ? { rush: payload.rush } : {}),
          ...(typeof payload.sample === "boolean" ? { sample: payload.sample } : {}),
        },
        message: "Quote updated.",
      };
    },
    save_decoration: () => ({ change: { decoration: parseJson(formData.get("payload"), null) }, message: "Decoration updated." }),
    delete_line: () => ({ change: { removeLineId: String(formData.get("lineItemId") || "") }, message: "Line removed from the quote." }),
  };
  if (edits[intent]) {
    const { change, message } = edits[intent]();
    if (intent === "save_decoration" && !change.decoration?.lineId) return { success: false, error: "Missing line item." };
    const { rebuildQuote, loadQuoteEditor } = await import("../lib/quote-editor.server");
    const result = await rebuildQuote(admin, draftOrderId, change);
    if (!result.ok) return { success: false, error: result.error };
    return {
      success: true,
      edited: true,
      message,
      quote: await fetchQuote(admin, draftOrderId),
      editor: await loadQuoteEditor(admin, draftOrderId),
    };
  }

  if (intent === "update_status") {
    const targetStatus = String(formData.get("targetStatus") || "").trim();

    try {
      if (targetStatus === "accepted" || targetStatus === "rejected") {
        const boolValue = targetStatus === "accepted" ? "true" : "false";

        // A buyer's request can't be checked out until Hyve approves it
        // (quote-hold): approving releases it, declining keeps it held. Done
        // first, so a quote never reads approved while checkout still refuses.
        const { setQuoteHold } = await import("../lib/quote-hold.server");
        const holdError = await setQuoteHold(admin, draftOrderId, targetStatus !== "accepted");
        if (holdError) return { success: false, error: holdError };

        const setRes = await admin.graphql(
          `#graphql
          mutation SetDraftOrderHyveStatus($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
                namespace
                key
                value
                type
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              metafields: [
                {
                  ownerId: draftOrderId,
                  namespace: "$app",
                  key: "hyve_status",
                  type: "boolean",
                  value: boolValue,
                },
              ],
            },
          },
        );

        const setJson = await setRes.json();
        const errors = setJson?.data?.metafieldsSet?.userErrors;
        if (errors && errors.length > 0) {
          return { success: false, error: errors.map((e) => e.message).join(", ") };
        }

        const updatedMetafield = setJson?.data?.metafieldsSet?.metafields?.[0];
        return {
          success: true,
          draftOrderId,
          targetStatus,
          metafield: updatedMetafield,
          message: `Quote ${targetStatus === "accepted" ? "approved" : "declined"}.`,
        };
      }

      if (targetStatus === "awaiting_action") {
        // Awaiting means the metafield is absent, and a boolean has no third
        // value, so resetting is a delete. `metafieldsDelete` identifies the
        // metafield by owner, namespace and key rather than by its ID.
        //
        // The namespace is read back off the record instead of being passed as
        // "$app": that alias resolves to the app's reserved namespace, and the
        // resolved form is what the delete has to match.
        const lookup = await admin.graphql(
          `#graphql
          query GetDraftOrderHyveStatus($id: ID!) {
            draftOrder(id: $id) {
              id
              metafield(namespace: "$app", key: "hyve_status") {
                id
                namespace
                key
              }
            }
          }`,
          { variables: { id: draftOrderId } },
        );
        const lookupJson = await lookup.json();
        const existing = lookupJson?.data?.draftOrder?.metafield;

        // Back to undecided: a buyer's request is held again until Hyve decides.
        const { setQuoteHold } = await import("../lib/quote-hold.server");
        const holdError = await setQuoteHold(admin, draftOrderId, true);
        if (holdError) return { success: false, error: holdError };

        // Nothing stored means it is already awaiting action.
        if (existing?.namespace) {
          const delRes = await admin.graphql(
            `#graphql
            mutation ClearDraftOrderHyveStatus($metafields: [MetafieldIdentifierInput!]!) {
              metafieldsDelete(metafields: $metafields) {
                deletedMetafields { key namespace ownerId }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                metafields: [
                  {
                    ownerId: draftOrderId,
                    namespace: existing.namespace,
                    key: existing.key || "hyve_status",
                  },
                ],
              },
            },
          );

          const delJson = await delRes.json();
          if (delJson?.errors?.length) {
            return { success: false, error: delJson.errors[0]?.message || "Reset failed." };
          }

          const errors = delJson?.data?.metafieldsDelete?.userErrors;
          if (errors && errors.length > 0) {
            return { success: false, error: errors.map((e) => e.message).join(", ") };
          }
        }

        return {
          success: true,
          draftOrderId,
          targetStatus: "awaiting_action",
          metafield: null,
          message: "Hyve's decision cleared.",
        };
      }

      return { success: false, error: `Invalid status '${targetStatus}'.` };
    } catch (err) {
      console.error("[app.quote.$id.action] Error updating status:", err);
      return { success: false, error: err?.message || "Failed to update quote status." };
    }
  }

  return { success: false, error: "Unsupported intent." };
};

/* ==========================================================================
   Main Component
   ========================================================================== */

export default function QuoteDetailPage() {
  const { quote: initialQuote, editor: initialEditor, shop } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [quote, setQuote] = useState(initialQuote);
  const [editor, setEditor] = useState(initialEditor);
  useEffect(() => {
    setQuote(initialQuote);
    setEditor(initialEditor);
  }, [initialQuote, initialEditor]);

  // Changes waiting for Save: quantities, gift packaging, rush and the sample.
  const [quantities, setQuantities] = useState({});
  const [gifts, setGifts] = useState({});
  const [rush, setRush] = useState(Boolean(initialEditor?.rush));
  const [sample, setSample] = useState(Boolean(initialEditor?.sample));
  const resetPending = useCallback((next) => {
    setQuantities({});
    setGifts({});
    setRush(Boolean(next?.rush));
    setSample(Boolean(next?.sample));
  }, []);
  useEffect(() => resetPending(initialEditor), [initialEditor, resetPending]);

  // Confirmation Modal state to replace window.confirm
  const [confirmModal, setConfirmModal] = useState({
    title: "",
    message: "",
    confirmLabel: "Delete",
    confirmTone: "critical",
    onConfirm: null,
  });

  const openConfirmModal = useCallback(({ title, message, confirmLabel = "Delete", confirmTone = "critical", onConfirm }) => {
    setConfirmModal({ title, message, confirmLabel, confirmTone, onConfirm });
    document.getElementById("confirm-action-modal")?.showOverlay?.();
  }, []);

  const closeConfirmModal = useCallback(() => {
    document.getElementById("confirm-action-modal")?.hideOverlay?.();
    setConfirmModal((prev) => ({ ...prev, onConfirm: null }));
  }, []);

  const lines = useMemo(() => quote.lineItems?.nodes || [], [quote.lineItems?.nodes]);
  const lineInfo = (line) => editor?.lines?.[line.id] || { kind: "product" };

  const quantityChanges = useMemo(() => {
    const changed = {};
    for (const [lineId, raw] of Object.entries(quantities)) {
      const line = lines.find((l) => l.id === lineId);
      const qty = parseInt(raw, 10);
      if (line && qty > 0 && qty !== line.quantity) changed[lineId] = qty;
    }
    return changed;
  }, [quantities, lines]);
  const giftChanges = useMemo(() => {
    const changed = {};
    for (const [lineId, on] of Object.entries(gifts)) {
      if (Boolean(editor?.lines?.[lineId]?.gift) !== on) changed[lineId] = on;
    }
    return changed;
  }, [gifts, editor]);
  const badQuantity = Object.values(quantities).some((raw) => !(parseInt(raw, 10) > 0) || String(parseInt(raw, 10)) !== String(raw).trim());
  const hasPendingChanges =
    Object.keys(quantityChanges).length > 0 ||
    Object.keys(giftChanges).length > 0 ||
    rush !== Boolean(editor?.rush) ||
    sample !== Boolean(editor?.sample);

  const isSubmitting = fetcher.state !== "idle";
  const submittingIntent = isSubmitting ? fetcher.formData?.get("intent") : null;

  const handleSaveAllChanges = useCallback(() => {
    fetcher.submit(
      {
        intent: "save_lines",
        draftOrderId: quote.id,
        payload: JSON.stringify({ quantities: quantityChanges, gifts: giftChanges, rush, sample }),
      },
      { method: "post" },
    );
  }, [fetcher, quote.id, quantityChanges, giftChanges, rush, sample]);

  const handleDeleteLine = useCallback(
    (line) => {
      const title = line.title || line.name || "this item";
      openConfirmModal({
        title: "Remove Line Item",
        message: `Remove "${title}" from this quote? Its setup, rush and gift charges are worked out again.`,
        confirmLabel: "Remove",
        confirmTone: "critical",
        onConfirm: () => {
          fetcher.submit({ intent: "delete_line", draftOrderId: quote.id, lineItemId: line.id }, { method: "post" });
        },
      });
    },
    [quote.id, fetcher, openConfirmModal],
  );

  // The decoration modal.
  const [activeLine, setActiveLine] = useState(null);
  const [decoType, setDecoType] = useState("none");
  const [decoMethod, setDecoMethod] = useState("");
  const [decoLocations, setDecoLocations] = useState([]);
  const [artworkMode, setArtworkMode] = useState("now");
  const [artworkUrls, setArtworkUrls] = useState({});
  const [designBrief, setDesignBrief] = useState("");
  const [configError, setConfigError] = useState("");
  const activeInfo = activeLine ? lineInfo(activeLine) : null;
  const activeOptions = activeInfo?.options || { methods: [], locations: [], maxLocations: 1, wrapFee: 0, wrapLabel: "" };
  const draftDecoration = useMemo(
    () =>
      decoType === "imprint"
        ? { type: "imprint", method: decoMethod, locations: decoLocations }
        : { type: decoType },
    [decoType, decoMethod, decoLocations],
  );

  const openConfigModal = useCallback(
    (line) => {
      const info = editor?.lines?.[line.id];
      if (!info?.decoration) return;
      setActiveLine(line);
      setConfigError("");
      setDecoType(info.decoration.type);
      setDecoMethod(info.decoration.method || (info.options.methods.length === 1 ? info.options.methods[0] : ""));
      setDecoLocations(info.decoration.locations || []);
      setArtworkMode(info.artwork.mode || "now");
      setArtworkUrls(info.artwork.urls || {});
      setDesignBrief(info.artwork.brief || "");
      document.getElementById("edit-config-modal")?.showOverlay?.();
    },
    [editor],
  );

  const closeConfigModal = useCallback(() => {
    document.getElementById("edit-config-modal")?.hideOverlay?.();
    setActiveLine(null);
    setConfigError("");
  }, []);

  const handleSaveConfig = useCallback(() => {
    if (!activeLine) return;
    if (decoType === "imprint") {
      if (!decoMethod) return setConfigError("Choose a decoration method.");
      if (!decoLocations.length) return setConfigError("Choose at least one imprint location.");
    }
    if (decoType !== "none" && artworkMode === "now") {
      const missing = artworkZones(draftDecoration).filter((zone) => !artworkUrls[zone.key]);
      if (missing.length) return setConfigError(`Upload the artwork for ${missing.map((zone) => zone.label).join(", ")}.`);
    }
    setConfigError("");
    fetcher.submit(
      {
        intent: "save_decoration",
        draftOrderId: quote.id,
        payload: JSON.stringify({
          lineId: activeLine.id,
          decoration: draftDecoration,
          artwork: { mode: artworkMode, urls: artworkUrls, brief: designBrief },
        }),
      },
      { method: "post" },
    );
  }, [activeLine, decoType, decoMethod, decoLocations, artworkMode, artworkUrls, designBrief, draftDecoration, fetcher, quote.id]);

  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.emailed) {
      shopify?.toast?.show?.(fetcher.data.message);
      return;
    }

    if (fetcher.data.edited) {
      shopify?.toast?.show?.(fetcher.data.message || "Quote updated.");
      if (fetcher.data.quote) setQuote(fetcher.data.quote);
      if (fetcher.data.editor) {
        setEditor(fetcher.data.editor);
        resetPending(fetcher.data.editor);
      }
      document.getElementById("edit-config-modal")?.hideOverlay?.();
      setActiveLine(null);
      return;
    }

    if (fetcher.data.success) {
      const { targetStatus, metafield, message } = fetcher.data;
      shopify?.toast?.show?.(message || "Status updated successfully.");

      const updatedMetafield =
        targetStatus === "awaiting_action"
          ? null
          : metafield || { value: targetStatus === "accepted" ? "true" : "false" };

      setQuote((prev) => ({
        ...prev,
        metafield: updatedMetafield,
        quoteStatus: parseQuoteStatus(updatedMetafield),
      }));
    } else if (fetcher.data.error) {
      shopify?.toast?.show?.(`Error: ${fetcher.data.error}`, { isError: true });
      if (activeLine) setConfigError(fetcher.data.error);
    }
    // Only a new response is handled; activeLine is read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, shopify, resetPending]);

  const handleUpdateStatus = useCallback(
    (targetStatus) => {
      fetcher.submit(
        {
          intent: "update_status",
          draftOrderId: quote.id,
          targetStatus,
        },
        { method: "post" },
      );
    },
    [fetcher, quote.id],
  );

  // The quotation PDF (HYV-116), fetched with the session App Bridge adds and
  // handed to the browser as a download.
  const [downloading, setDownloading] = useState(false);
  const downloadQuotation = useCallback(async () => {
    setDownloading(true);
    try {
      const response = await fetch(`/app/quote-pdf/${cleanDraftOrderId(quote.id)}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `Quotation-${String(quote.name || "").replace(/^#D/, "Q-")}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      shopify?.toast?.show?.("The quotation couldn't be generated. Please try again.", { isError: true });
      console.error("[quote] quotation download failed", error);
    } finally {
      setDownloading(false);
    }
  }, [quote.id, quote.name, shopify]);

  const shopifyAdminUrl = useMemo(
    () => getShopifyAdminDraftOrderUrl(quote.id, shop),
    [quote.id, shop],
  );

  const isOrderCreated = Boolean(quote.order?.id);
  const isOpen = !isOrderCreated && quote.status !== "COMPLETED";

  const isExpired =
    Boolean(quote.isExpired) ||
    quote.listStatus === "expired" ||
    quote.quoteStatus?.key === STATUS_KEYS.EXPIRED ||
    quote.status === "EXPIRED" ||
    (quote.tags || []).some((t) => /^(quote[-_]?)?expired$/i.test(String(t).trim())) ||
    Boolean(
      !isOrderCreated &&
      quote.status !== "COMPLETED" &&
      quote.createdAt &&
      new Date(quote.createdAt).getTime() + 14 * 24 * 60 * 60 * 1000 < Date.now()
    );

  // Editing reprices the whole quote, so it waits until the prices can be read.
  const canEdit = isOpen && !isExpired && !editor?.error;

  const isAccepted =
    quote.quoteStatus?.key === STATUS_KEYS.ACCEPTED ||
    quote.listStatus === "accepted" ||
    isOrderCreated;
  const isRejected =
    quote.quoteStatus?.key === STATUS_KEYS.REJECTED ||
    quote.listStatus === "declined";
  const decided = isAccepted || isRejected;

  const currency = quote.totalPriceSet?.presentmentMoney?.currencyCode || "USD";
  // A distributor's quote belongs to their company and has no customer on it,
  // so the company and its contact are named instead of "Guest".
  const contact = quote.purchasingEntity?.contact?.customer || null;
  const companyName = quote.purchasingEntity?.company?.name || "";
  const buyerEmail = quote.customer?.email || contact?.defaultEmailAddress?.emailAddress || "";
  const buyerPhone = quote.customer?.phone || contact?.defaultPhoneNumber?.phoneNumber || "";
  const customerName =
    companyName || quote.customer?.displayName || contact?.displayName || buyerEmail || "Guest";

  const address = quote.shippingAddress || quote.billingAddress;
  const addressLines = address
    ? [
      address.name,
      address.address1,
      address.address2,
      [address.city, address.province, address.zip].filter(Boolean).join(" "),
      address.country,
    ].filter(Boolean)
    : [];

  // The modal's live estimate, at the quantity being typed if there is one.
  const activeQuantity = activeLine ? parseInt(quantities[activeLine.id] ?? activeLine.quantity, 10) || activeLine.quantity : 1;
  const activeEstimate =
    activeInfo?.pricing && editor ? unitPriceFor(activeInfo.pricing, draftDecoration, activeQuantity, editor.rate) : null;
  const maxLocations = activeOptions.maxLocations;

  return (
    <s-page heading={`Quote ${quoteReference(quote.name)}`} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/quotes">
        All quotes
      </s-link>

      <s-button slot="primary-action" href={shopifyAdminUrl} target="_blank" variant="primary">
        Open in Shopify
      </s-button>
      {quote.order?.id ? (
        <s-button slot="secondary-actions" href={getShopifyAdminOrderUrl(quote.order.id, shop)} target="_blank">
          View Order {quote.order.name}
        </s-button>
      ) : null}
      {/* Our quotation email with the PDF attached, instead of Shopify's
          "Send invoice", which can't carry the PDF (HYV-166). Not offered
          once the quote has become an order or been declined. */}
      {!decided && !isExpired && quote.listStatus !== "accepted" && quote.listStatus !== "declined" ? (
        <s-button
          slot="secondary-actions"
          onClick={() => fetcher.submit({ intent: "email_quotation", draftOrderId: quote.id }, { method: "post" })}
          disabled={fetcher.state !== "idle" || undefined}
        >
          {fetcher.state !== "idle" && fetcher.formData?.get("intent") === "email_quotation"
            ? "Sending…"
            : "Email quotation"}
        </s-button>
      ) : null}
      <s-button slot="secondary-actions" onClick={downloadQuotation} disabled={downloading || undefined}>
        {downloading ? "Preparing PDF…" : "Download quotation"}
      </s-button>
      {!isExpired && quote.invoiceUrl ? (
        <s-button slot="secondary-actions" href={quote.invoiceUrl} target="_blank">
          Checkout link
        </s-button>
      ) : null}
      <s-button slot="secondary-actions" href="/app/quotes" variant="tertiary">
        All quotes
      </s-button>

      <s-section padding="base">
        <div className="hyv">
          <AdminTheme />

          <div className="hyv-stack">
            {/* Header: who, when, how much, and where it stands */}
            <div className="hyv-panel" style={{ padding: "18px 20px" }}>
              <div className="hyv-hero">
                <div style={{ display: "flex", gap: "12px", alignItems: "center", minWidth: 0 }}>
                  <span className="hyv-avatar">{getInitials(customerName)}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "17px", fontWeight: 700, letterSpacing: "-0.01em" }}>
                        {customerName}
                      </span>
                      {isExpired ? (
                        <Pill tone="critical">Quote Expired</Pill>
                      ) : (
                        <Pill tone={STAFF_QUOTE_TONES[quote.listStatus] || "info"}>
                          {STAFF_QUOTE_LABELS[quote.listStatus] || quote.listStatus}
                        </Pill>
                      )}
                      {/* Staff approval is Hyve agreeing the quote, not the buyer
                          accepting it, so it's "Approved", not "Accepted". A
                          declined quote already reads Declined in the pill before. */}
                      {!isExpired && quote.quoteStatus.key === STATUS_KEYS.ACCEPTED ? (
                        <Pill tone="success">Approved by Hyve</Pill>
                      ) : null}
                      {quote.order?.id ? (
                        <Pill tone="success">Order Created: {quote.order.name}</Pill>
                      ) : (
                        <Pill tone="neutral">No Order Created</Pill>
                      )}
                    </div>
                    <p className="hyv-muted" style={{ margin: "3px 0 0" }}>
                      {buyerEmail || "No email on file"} · raised{" "}
                      {formatDateTime(quote.createdAt)}
                    </p>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="hyv-muted" style={{ fontSize: "12px" }}>
                    Total
                  </div>
                  <div className="hyv-hero__value">
                    {formatMoney(quote.totalPriceSet?.presentmentMoney?.amount, currency)}
                  </div>
                </div>
              </div>
            </div>

            {quote.order?.id ? (
              <s-banner tone="success" heading={`Order ${quote.order.name} created`}>
                <s-paragraph>
                  An order has been created from this quote:{" "}
                  <a
                    href={getShopifyAdminOrderUrl(quote.order.id, shop)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontWeight: 600, textDecoration: "underline", color: "inherit" }}
                  >
                    Open Order {quote.order.name} in Shopify
                  </a>
                </s-paragraph>
              </s-banner>
            ) : null}

            {isExpired ? (
              <s-banner tone="critical" heading="This quote has expired">
                <s-paragraph>
                  This quote has passed its 14-day validity period and can no longer be edited, approved, or declined.
                </s-paragraph>
              </s-banner>
            ) : null}

            {/* Only a buyer's request waits on Hyve: it reads Created until
                staff approve it. A quote sales made, or one from the cart, is
                already with the buyer whatever the decision says. */}
            {!decided && !isExpired && quote.listStatus === "created" && (quote.tags || []).includes("awaiting_review") ? (
              <s-banner tone="warning" heading="Waiting on your decision">
                <s-paragraph>
                  The buyer asked for this quote. They see it as Created until you approve or decline it.
                </s-paragraph>
              </s-banner>
            ) : null}

            {isOpen && editor?.error ? (
              <s-banner tone="critical" heading="This quote can't be edited right now">
                <s-paragraph>{editor.error}</s-paragraph>
              </s-banner>
            ) : null}

            <div className="hyv-split">
              {/* Items */}
              <div className="hyv-panel">
                <div
                  className="hyv-panel__head"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "12px",
                    padding: "16px 20px",
                    borderBottom: "1px solid var(--line, #e2e8f0)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span className="hyv-panel__title" style={{ fontSize: "15px", fontWeight: 650 }}>
                      Line Items
                    </span>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "2px 8px",
                        borderRadius: "999px",
                        fontSize: "12px",
                        fontWeight: 600,
                        background: "#f1f5f9",
                        color: "#475569",
                      }}
                    >
                      {lines.length}
                    </span>
                  </div>
                  {canEdit ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
                      {editor.rushAvailable ? (
                        <s-checkbox
                          label="Rush production (whole order)"
                          checked={rush || undefined}
                          disabled={isSubmitting || undefined}
                          onChange={(event) => setRush(event.currentTarget.checked)}
                        />
                      ) : null}
                      {editor.sampleAvailable ? (
                        <s-checkbox
                          label="Physical sample before production"
                          checked={sample || undefined}
                          disabled={isSubmitting || undefined}
                          onChange={(event) => setSample(event.currentTarget.checked)}
                        />
                      ) : null}
                      <s-button
                        variant={hasPendingChanges ? "primary" : "secondary"}
                        size="slim"
                        onClick={handleSaveAllChanges}
                        disabled={(isSubmitting || !hasPendingChanges || badQuantity) || undefined}
                        loading={submittingIntent === "save_lines" || undefined}
                      >
                        {hasPendingChanges ? "Save changes" : "Saved"}
                      </s-button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      {editor?.rush ? <Pill tone="warning">Rush Production</Pill> : null}
                      {editor?.sample ? (
                        <Pill tone="info">Physical Sample Included</Pill>
                      ) : (
                        <Pill tone="neutral">No Physical Sample</Pill>
                      )}
                    </div>
                  )}
                </div>
                {lines.length === 0 ? (
                  <div className="hyv-empty">
                    <div className="hyv-empty__title">No line items</div>
                    <p className="hyv-empty__text">This draft order has nothing on it.</p>
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="hyv-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={{ minWidth: "280px", padding: "12px 20px" }}>Product</th>
                          <th className="hyv-num" style={{ width: "80px", padding: "12px 16px" }}>Qty</th>
                          <th className="hyv-num" style={{ width: "130px", padding: "12px 16px" }}>Unit Price</th>
                          <th className="hyv-num" style={{ width: "130px", padding: "12px 20px" }}>Total</th>
                          {canEdit ? (
                            <th style={{ width: "75px", padding: "12px 16px", textAlign: "center" }}>Actions</th>
                          ) : null}
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((line) => {
                          const info = lineInfo(line);
                          const isProduct = info.kind === "product";
                          const quantityEditable = canEdit && (isProduct || info.kind === "custom");
                          const removable = canEdit && ["product", "custom", "blank-sample"].includes(info.kind);
                          const imageUrl = line.image?.url || line.product?.featuredImage?.url || "";
                          const imageAlt =
                            line.image?.altText ||
                            line.product?.featuredImage?.altText ||
                            line.title ||
                            line.name ||
                            "Product";

                          const variantTitle =
                            line.variantTitle && line.variantTitle !== "Default Title"
                              ? line.variantTitle
                              : (line.variant?.selectedOptions || [])
                                  .filter((opt) => opt.name !== "Title" || opt.value !== "Default Title")
                                  .map((opt) => `${opt.name}: ${opt.value}`)
                                  .join(", ");

                          const discountedAmount = Number(line.discountedUnitPriceSet?.presentmentMoney?.amount ?? 0);
                          const originalAmount = Number(line.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
                          const unit = discountedAmount || originalAmount || 0;
                          const hasDiscount =
                            originalAmount > 0 && discountedAmount > 0 && discountedAmount < originalAmount;

                          // The price at the quantity being typed, before it's saved.
                          const typedQty = parseInt(quantities[line.id], 10);
                          const estimate =
                            isProduct && info.pricing && typedQty > 0 && typedQty !== line.quantity
                              ? unitPriceFor(info.pricing, info.decoration, typedQty, editor.rate)
                              : null;

                          const hsCode =
                            line.variant?.inventoryItem?.harmonizedSystemCode ||
                            (line.customAttributes || []).find((a) =>
                              /^(hs[\s_-]?code|harmonized\s*(system|tariff)?\s*code|tariff\s*code)$/i.test(a.key),
                            )?.value ||
                            "";
                          const rawOrigin =
                            line.variant?.inventoryItem?.countryCodeOfOrigin ||
                            (line.customAttributes || []).find((a) =>
                              /^(country\s*of\s*origin|coo|origin|made\s*in)$/i.test(a.key),
                            )?.value ||
                            "";
                          const countryOfOrigin = formatCountryOfOrigin(rawOrigin);

                          const visibleAttributes = (line.customAttributes || []).filter(
                            (a) =>
                              a.key &&
                              !a.key.startsWith("_") &&
                              !/^(hs[\s_-]?code|harmonized\s*(system|tariff)?\s*code|tariff\s*code)$/i.test(a.key) &&
                              !/^(country\s*of\s*origin|coo|origin|made\s*in)$/i.test(a.key),
                          );

                          return (
                            <tr
                              key={line.id}
                              style={{
                                transition: "background-color 0.15s ease",
                                borderBottom: "1px solid var(--line-soft, #f1f5f9)",
                              }}
                            >
                              <td style={{ padding: "14px 20px", verticalAlign: "top" }}>
                                <div style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
                                  <div
                                    style={{
                                      width: "52px",
                                      height: "52px",
                                      borderRadius: "8px",
                                      border: "1px solid #e2e8f0",
                                      background: "#f8fafc",
                                      overflow: "hidden",
                                      flexShrink: 0,
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                    }}
                                  >
                                    {imageUrl ? (
                                      <img
                                        src={imageUrl}
                                        alt={imageAlt}
                                        loading="lazy"
                                        style={{
                                          width: "100%",
                                          height: "100%",
                                          objectFit: "contain",
                                          display: "block",
                                        }}
                                      />
                                    ) : (
                                      <svg
                                        width="24"
                                        height="24"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="#94a3b8"
                                        strokeWidth="1.75"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                      >
                                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                                        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                                        <line x1="12" y1="22.08" x2="12" y2="12" />
                                      </svg>
                                    )}
                                  </div>

                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                      <span
                                        style={{
                                          fontWeight: 650,
                                          fontSize: "13.5px",
                                          color: "#0f172a",
                                          lineHeight: 1.35,
                                          wordBreak: "break-word",
                                        }}
                                      >
                                        {line.title || line.name || "Custom Item"}
                                      </span>
                                      {KIND_LABELS[info.kind] ? <Pill tone="info">{KIND_LABELS[info.kind]}</Pill> : null}
                                    </div>

                                    {variantTitle ? (
                                      <div
                                        style={{
                                          fontSize: "12px",
                                          color: "#64748b",
                                          fontWeight: 500,
                                          marginTop: "2px",
                                          lineHeight: 1.3,
                                        }}
                                      >
                                        {variantTitle}
                                      </div>
                                    ) : null}

                                    {(line.sku || hsCode || countryOfOrigin) ? (
                                      <div
                                        style={{
                                          display: "flex",
                                          flexWrap: "wrap",
                                          gap: "5px",
                                          marginTop: "6px",
                                        }}
                                      >
                                        {[
                                          line.sku ? `SKU: ${line.sku}` : "",
                                          hsCode ? `HS: ${hsCode}` : "",
                                          countryOfOrigin ? `Origin: ${countryOfOrigin}` : "",
                                        ]
                                          .filter(Boolean)
                                          .map((text) => (
                                            <span
                                              key={text}
                                              style={{
                                                fontSize: "11px",
                                                fontWeight: 550,
                                                color: "#475569",
                                                background: "#f1f5f9",
                                                padding: "2px 7px",
                                                borderRadius: "5px",
                                                border: "1px solid #e2e8f0",
                                                letterSpacing: "0.01em",
                                              }}
                                            >
                                              {text}
                                            </span>
                                          ))}
                                      </div>
                                    ) : null}

                                    {visibleAttributes.length > 0 ? (
                                      <div
                                        style={{
                                          display: "flex",
                                          flexWrap: "wrap",
                                          gap: "4px 10px",
                                          marginTop: "6px",
                                        }}
                                      >
                                        {visibleAttributes.map((attr, idx) => (
                                          <span
                                            key={idx}
                                            style={{
                                              fontSize: "11.5px",
                                              color: "#64748b",
                                              lineHeight: 1.3,
                                            }}
                                          >
                                            <strong style={{ color: "#334155", fontWeight: 600 }}>{attr.key}:</strong>{" "}
                                            {attr.value}
                                          </span>
                                        ))}
                                      </div>
                                    ) : null}

                                    {isProduct && canEdit && info.decoration ? (
                                      <div style={{ marginTop: "10px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                                        <s-button
                                          size="slim"
                                          commandFor="edit-config-modal"
                                          command="--show"
                                          onClick={() => openConfigModal(line)}
                                        >
                                          Edit decoration
                                        </s-button>
                                        {info.giftAvailable ? (
                                          <s-checkbox
                                            label={`Gift packaging${info.giftLabel ? ` (+${info.giftLabel}/unit)` : ""}`}
                                            checked={(gifts[line.id] ?? info.gift) || undefined}
                                            disabled={isSubmitting || undefined}
                                            onChange={(event) => {
                                              const checked = event.currentTarget.checked;
                                              setGifts((prev) => ({ ...prev, [line.id]: checked }));
                                            }}
                                          />
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </td>

                              <td className="hyv-num" style={{ padding: "14px 16px", verticalAlign: "top" }}>
                                {quantityEditable ? (
                                  <input
                                    type="number"
                                    min="1"
                                    step="1"
                                    value={quantities[line.id] ?? line.quantity}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setQuantities((prev) => ({ ...prev, [line.id]: val }));
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.preventDefault();
                                        if (hasPendingChanges && !badQuantity) handleSaveAllChanges();
                                      }
                                    }}
                                    disabled={isSubmitting}
                                    aria-label={`Quantity for ${line.title || "item"}`}
                                    style={{
                                      width: "64px",
                                      padding: "3px 6px",
                                      textAlign: "center",
                                      border: "1px solid #cbd5e1",
                                      borderRadius: "5px",
                                      fontSize: "13px",
                                      fontWeight: 600,
                                      color: "#0f172a",
                                      background: "#ffffff",
                                      outline: "none",
                                    }}
                                  />
                                ) : (
                                  <span
                                    style={{
                                      display: "inline-block",
                                      minWidth: "28px",
                                      padding: "2px 7px",
                                      background: "#f8fafc",
                                      border: "1px solid #e2e8f0",
                                      borderRadius: "5px",
                                      fontSize: "12.5px",
                                      fontWeight: 600,
                                      color: "#1e293b",
                                      textAlign: "center",
                                    }}
                                  >
                                    {line.quantity}
                                  </span>
                                )}
                              </td>

                              <td className="hyv-num" style={{ padding: "14px 16px", verticalAlign: "top" }}>
                                <div style={{ fontSize: "13px", fontWeight: 650, color: "#1e293b" }}>
                                  {formatMoney(unit, currency)}
                                </div>
                                {hasDiscount ? (
                                  <div
                                    style={{
                                      fontSize: "11px",
                                      color: "#94a3b8",
                                      textDecoration: "line-through",
                                      marginTop: "2px",
                                    }}
                                  >
                                    {formatMoney(originalAmount, currency)}
                                  </div>
                                ) : null}
                                {isProduct && info.pricing && !info.priced ? (
                                  <div style={{ fontSize: "10.5px", color: "#b45309", marginTop: "4px", lineHeight: "1.3" }}>
                                    Price set by hand. Catalog: {formatMoney(info.ruleUnit, currency)}
                                  </div>
                                ) : null}
                                {isProduct && info.priced && info.fee > 0 ? (
                                  <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "4px", lineHeight: "1.3" }}>
                                    <div>Product: {formatMoney(info.base, currency)}</div>
                                    <div style={{ color: "#0284c7" }}>
                                      + {info.decoration.type === "fcw" ? "Wrap" : "Imprint"}: {formatMoney(info.fee, currency)}
                                    </div>
                                  </div>
                                ) : null}
                                {estimate ? (
                                  <div style={{ fontSize: "10.5px", color: "#b45309", marginTop: "4px", lineHeight: "1.3" }}>
                                    At {typedQty}: {formatMoney(estimate.unit, currency)}
                                  </div>
                                ) : null}
                              </td>

                              <td
                                className="hyv-num"
                                style={{
                                  padding: "14px 20px",
                                  verticalAlign: "top",
                                  fontWeight: 650,
                                  fontSize: "13.5px",
                                  color: "#0f172a",
                                }}
                              >
                                {formatMoney(unit * line.quantity, currency)}
                              </td>

                              {canEdit ? (
                                <td style={{ padding: "14px 16px", verticalAlign: "top", textAlign: "center" }}>
                                  {removable ? (
                                    <s-button
                                      size="slim"
                                      tone="critical"
                                      variant="secondary"
                                      disabled={isSubmitting || undefined}
                                      onClick={() => handleDeleteLine(line)}
                                      title="Delete line item"
                                    >
                                      Delete
                                    </s-button>
                                  ) : null}
                                </td>
                              ) : null}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {canEdit ? (
                      <p className="hyv-muted" style={{ margin: 0, padding: "10px 20px 14px", fontSize: "12px" }}>
                        Setup, rush, gift packaging, the physical sample and import duties follow the products: saving
                        works them out again the way the cart and checkout do.
                      </p>
                    ) : null}
                  </div>
                )}
              </div>

              {/* Summary */}
              <div className="hyv-panel" style={{ padding: "16px 18px" }}>
                <div className="hyv-panel__title" style={{ marginBottom: "8px" }}>
                  Summary
                </div>
                <div className="hyv-total">
                  <span className="hyv-total__key">Subtotal</span>
                  <span className="hyv-total__val">
                    {formatMoney(quote.subtotalPriceSet?.presentmentMoney?.amount, currency)}
                  </span>
                </div>
                <div className="hyv-total">
                  <span className="hyv-total__key">Shipping</span>
                  <span className="hyv-total__val">
                    {formatMoney(quote.totalShippingPriceSet?.presentmentMoney?.amount, currency)}
                  </span>
                </div>
                <div className="hyv-total hyv-total--grand">
                  <span className="hyv-total__key">Total</span>
                  <span className="hyv-total__val">
                    {formatMoney(quote.totalPriceSet?.presentmentMoney?.amount, currency)}
                  </span>
                </div>
              </div>
            </div>

            {/* Contact and delivery */}
            <div className="hyv-panel" style={{ padding: "4px 18px 14px" }}>
              <div className="hyv-kv">
                <div className="hyv-kv__item">
                  <div className="hyv-kv__key">Contact email</div>
                  <div className="hyv-kv__val">{buyerEmail || "—"}</div>
                </div>
                <div className="hyv-kv__item">
                  <div className="hyv-kv__key">Contact phone</div>
                  <div className="hyv-kv__val">{buyerPhone || "—"}</div>
                </div>
                <div className="hyv-kv__item">
                  <div className="hyv-kv__key">Last updated</div>
                  <div className="hyv-kv__val">{formatDateTime(quote.updatedAt)}</div>
                </div>
                <div className="hyv-kv__item">
                  <div className="hyv-kv__key">Order created</div>
                  <div className="hyv-kv__val">
                    {quote.order?.id ? (
                      <span style={{ color: "#059669", fontWeight: 600 }}>
                        Yes ·{" "}
                        <a
                          href={getShopifyAdminOrderUrl(quote.order.id, shop)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ textDecoration: "underline", color: "inherit" }}
                        >
                          {quote.order.name}
                        </a>
                      </span>
                    ) : (
                      <span style={{ color: "#6b7280" }}>
                        No · Draft order is {quote.status === "OPEN" ? "Open" : (quote.status || "Open")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="hyv-kv__item">
                  <div className="hyv-kv__key">Shipping address</div>
                  <div className="hyv-kv__val">
                    {addressLines.length ? addressLines.join(", ") : "None on file"}
                  </div>
                </div>
              </div>
            </div>

            {/* Decision */}
            {!decided && !isExpired ? (
              <div className="hyv-panel" style={{ padding: "16px 18px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "14px",
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div className="hyv-panel__title">Decision</div>
                    <p className="hyv-muted" style={{ margin: "3px 0 0" }}>
                      Approving or declining updates the buyer&apos;s portal straight away.
                    </p>
                  </div>
                  <s-stack direction="inline" gap="small-200">
                    <s-button
                      variant="primary"
                      disabled={isSubmitting || undefined}
                      loading={(isSubmitting && fetcher.formData?.get("targetStatus") === "accepted") || undefined}
                      onClick={() => handleUpdateStatus("accepted")}
                    >
                      Approve quote
                    </s-button>
                    <s-button
                      tone="critical"
                      disabled={isSubmitting || undefined}
                      loading={(isSubmitting && fetcher.formData?.get("targetStatus") === "rejected") || undefined}
                      onClick={() => handleUpdateStatus("rejected")}
                    >
                      Decline
                    </s-button>
                  </s-stack>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </s-section>

      {/* Edit decoration */}
      <s-modal
        id="edit-config-modal"
        heading={activeLine ? `Decoration — ${activeLine.title || activeLine.name || "Line Item"}` : "Decoration"}
        size="large"
      >
        {!activeLine ? (
          <s-box padding="large-100">
            <s-text>Select a line item to decorate…</s-text>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            {/* 1. One decoration: none, an imprint, or Full Colour Wrap */}
            <s-section heading="1. Decoration">
              <s-choice-list
                name="decorationType"
                label="Decoration"
                labelAccessibilityVisibility="exclusive"
                values={[decoType === "imprint" ? `method:${decoMethod}` : decoType]}
                onInput={(e) => {
                  const val = e?.currentTarget?.values?.[0] || "none";
                  setConfigError("");
                  if (val.startsWith("method:")) {
                    const method = val.slice("method:".length);
                    if (method !== decoMethod) setDecoLocations([]);
                    setDecoType("imprint");
                    setDecoMethod(method);
                  } else {
                    setDecoType(val);
                  }
                }}
              >
                <s-choice value="none">No branding</s-choice>
                {activeOptions.methods.map((method) => (
                  <s-choice key={method} value={`method:${method}`}>
                    {method}
                  </s-choice>
                ))}
                {activeOptions.wrapFee > 0 ? (
                  <s-choice value="fcw">Full Colour Wrap (+{activeOptions.wrapLabel}/unit)</s-choice>
                ) : null}
              </s-choice-list>
            </s-section>

            {/* 2. Imprint locations */}
            {decoType === "imprint" ? (
              <s-section heading={`2. Imprint locations (${decoLocations.length} of at most ${maxLocations})`}>
                {activeOptions.locations.length > 0 ? (
                  <s-stack direction="block" gap="small-200">
                    {activeOptions.locations.map((loc) => {
                      const isChecked = decoLocations.includes(loc);
                      return (
                        <s-checkbox
                          key={loc}
                          label={loc}
                          checked={isChecked || undefined}
                          onChange={() => {
                            setConfigError("");
                            if (isChecked) {
                              setDecoLocations(decoLocations.filter((l) => l !== loc));
                            } else if (maxLocations === 1) {
                              setDecoLocations([loc]);
                            } else if (decoLocations.length < maxLocations) {
                              setDecoLocations([...decoLocations, loc]);
                            } else {
                              setConfigError(`This product takes at most ${maxLocations} imprint locations.`);
                            }
                          }}
                        />
                      );
                    })}
                  </s-stack>
                ) : (
                  <s-text-field
                    label="Imprint locations (comma separated)"
                    value={decoLocations.join(", ")}
                    onInput={(e) => {
                      const list = e.currentTarget.value.split(",").map((s) => s.trim()).filter(Boolean);
                      setDecoLocations(list.slice(0, maxLocations));
                    }}
                    placeholder="e.g. FRONT, BACK"
                  />
                )}
              </s-section>
            ) : null}

            {/* 3. Price */}
            {activeEstimate ? (
              <s-box padding="base" background="subdued" borderRadius="base" border="base">
                <div style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: "12.5px" }}>
                  <strong style={{ fontSize: "13px", color: "#0f172a", marginBottom: "2px" }}>
                    Price at {activeQuantity} units
                  </strong>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#475569" }}>Product</span>
                    <span style={{ fontWeight: 550 }}>{formatMoney(activeEstimate.base, currency)}</span>
                  </div>
                  {activeEstimate.fee > 0 ? (
                    <div style={{ display: "flex", justifyContent: "space-between", color: "#0284c7" }}>
                      <span>{describeDecoration(draftDecoration)}</span>
                      <span style={{ fontWeight: 550 }}>+{formatMoney(activeEstimate.fee, currency)}/unit</span>
                    </div>
                  ) : null}
                  <div
                    style={{
                      borderTop: "1px solid #cbd5e1",
                      marginTop: "4px",
                      paddingTop: "6px",
                      display: "flex",
                      justifyContent: "space-between",
                      fontWeight: 700,
                      fontSize: "13.5px",
                      color: "#0f172a",
                    }}
                  >
                    <span>Unit price</span>
                    <span>{formatMoney(activeEstimate.unit, currency)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: "13.5px", color: "#0f172a" }}>
                    <span>Line total</span>
                    <span>{formatMoney(activeEstimate.unit * activeQuantity, currency)}</span>
                  </div>
                </div>
              </s-box>
            ) : null}

            {/* 4. Artwork */}
            {decoType !== "none" && (decoType !== "imprint" || decoLocations.length > 0) ? (
              <s-section heading="Artwork">
                <s-stack direction="block" gap="base">
                  <s-choice-list
                    name="artworkOption"
                    label="Artwork Option"
                    labelAccessibilityVisibility="exclusive"
                    values={[artworkMode]}
                    onInput={(e) => setArtworkMode(e?.currentTarget?.values?.[0] || "now")}
                  >
                    {ARTWORK_CHOICES.map((choice) => (
                      <s-choice key={choice.value} value={choice.value} helpText={choice.help}>
                        {choice.label}
                      </s-choice>
                    ))}
                  </s-choice-list>

                  {artworkMode === "now"
                    ? artworkZones(draftDecoration).map((zone) => (
                        <s-box key={zone.key} padding="base" border="base" borderRadius="base" background="subdued">
                          <s-stack direction="block" gap="small-200">
                            <s-stack direction="inline" gap="small" alignItems="center">
                              <s-text type="strong">{zone.label}</s-text>
                              {artworkUrls[zone.key] ? (
                                <s-badge tone="success">File saved</s-badge>
                              ) : (
                                <s-badge tone="attention">File required</s-badge>
                              )}
                              {artworkUrls[zone.key] ? (
                                <s-link href={artworkUrls[zone.key]} target="_blank">
                                  View file
                                </s-link>
                              ) : null}
                            </s-stack>
                            <ShopifyFileUpload
                              label={`Upload ${zone.label} artwork (PDF, SVG, PNG, JPEG)`}
                              prefix={`quote-${cleanDraftOrderId(quote.id)}`}
                              onUploaded={(url) => {
                                setArtworkUrls((prev) => ({ ...prev, [zone.key]: url }));
                                setConfigError("");
                              }}
                            />
                          </s-stack>
                        </s-box>
                      ))
                    : null}

                  {artworkMode === "design" ? (
                    <s-text-area
                      label="Design brief (optional)"
                      rows={3}
                      value={designBrief}
                      onInput={(e) => setDesignBrief(e.currentTarget.value)}
                    />
                  ) : null}
                </s-stack>
              </s-section>
            ) : null}

            {/* Last, so it's in view next to Save decoration (HYV-172 QA). */}
            {configError ? (
              <s-banner tone="critical" heading="Please review the decoration">
                <s-paragraph>{configError}</s-paragraph>
              </s-banner>
            ) : null}
          </s-stack>
        )}

        <s-button
          slot="secondary-actions"
          commandFor="edit-config-modal"
          command="--hide"
          onClick={closeConfigModal}
          disabled={submittingIntent === "save_decoration" || undefined}
        >
          Cancel
        </s-button>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleSaveConfig}
          loading={submittingIntent === "save_decoration" || undefined}
          disabled={isSubmitting || undefined}
        >
          Save decoration
        </s-button>
      </s-modal>

      {/* Confirmation Modal */}
      <s-modal
        id="confirm-action-modal"
        heading={confirmModal.title || "Confirm Action"}
        size="small"
      >
        <s-box padding="base">
          <s-paragraph>{confirmModal.message}</s-paragraph>
        </s-box>

        <s-button
          slot="secondary-actions"
          commandFor="confirm-action-modal"
          command="--hide"
          onClick={closeConfirmModal}
          disabled={isSubmitting || undefined}
        >
          Cancel
        </s-button>

        <s-button
          slot="primary-action"
          tone={confirmModal.confirmTone || "critical"}
          variant="primary"
          onClick={() => {
            const action = confirmModal.onConfirm;
            closeConfirmModal();
            action?.();
          }}
          disabled={isSubmitting || undefined}
        >
          {confirmModal.confirmLabel || "Confirm"}
        </s-button>
      </s-modal>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("[quote detail] render failed:", error);

  return (
    <s-page heading="Quote">
      <s-section>
        <s-banner tone="critical" heading="We couldn't load this quote">
          <s-paragraph>{error?.message || "Please reload the page."}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
