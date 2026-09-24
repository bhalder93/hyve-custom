/**
 * Proof decisions (ART-03): Approve proof and Request changes.
 *
 * Most buyers decide from the proof email, so the email carries both actions
 * as links that work without signing in. The decision can also be taken on
 * the order itself in the portal — the order record is what the QA sweep tests
 * and what internal sales staff use.
 *
 * A decision is a production move like any other, so it lands in the same
 * status, history and emails as a move made on the Production Orders screen.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { changeProductionStatus, gql, productionStatusOf, SOURCES } from "./order-status.server";
import { loadOrder, loadOrderForAction } from "./order-action.server";

/**
 * Requesting changes puts the order On Hold. The production chain has no
 * revising state, and On Hold is the step from which staff send the next proof
 * version — it also stops the approval reminders, which would otherwise keep
 * asking the buyer to approve a proof they have just rejected.
 */
const DECISIONS = {
  approve: { to: "proof-approved", verb: "Approved the proof" },
  changes: { to: "on-hold", verb: "Requested changes to the proof" },
};

/**
 * Revisions included in the price. Changes asked of proof v1 are the first
 * revision, of v2 the second; from v3 on each one is chargeable. The flag goes
 * in the staff history note only — the buyer sees the on-hold reason, not it.
 */
const INCLUDED_REVISIONS = 2;

/** The storefront page the proof email links to (proxy.proof-decision.jsx). */
const LINK_PATH = "/apps/account/proof-decision";

/**
 * Records a decision the signed-in buyer took on the order in the portal.
 *
 * @param {string} orderGid the order carrying the proof
 * @param {"approve"|"changes"} decision
 * @param {{customerGid:string, locationGids?:string[], who:string, message?:string}} by
 * @returns {Promise<{ok:boolean, error?:string, orderName?:string}>}
 */
export async function recordProofDecision(admin, orderGid, decision, by = {}) {
  const message = cleanMessage(by.message);
  const invalid = checkDecision(decision, message);
  if (invalid) return { ok: false, error: invalid };

  const found = await loadOrderForAction(admin, orderGid, by);
  if (!found.ok) return found;

  return decide(admin, found.order, decision, {
    who: by.who,
    message,
    where: "in the portal",
    source: SOURCES.portal,
  });
}

/**
 * Records a decision taken from a link in the proof email. The link's
 * signature stands in for the sign-in: it names the order and the proof
 * version, so it works for that proof only, and stops working once the
 * decision is made or a newer proof is sent.
 *
 * @param {{orderGid:string, version:string}} link from readProofLink
 * @returns {Promise<{ok:boolean, error?:string, orderName?:string}>}
 */
export async function recordEmailProofDecision(admin, link, decision, rawMessage) {
  const message = cleanMessage(rawMessage);
  const invalid = checkDecision(decision, message);
  if (invalid) return { ok: false, error: invalid };

  const found = await loadProofFromLink(admin, link);
  if (!found.ok) return found;

  // Whoever the buyer forwarded the email to can use the link, so the record
  // says where it came from rather than naming a person.
  const recipient = found.order.customer?.defaultEmailAddress?.emailAddress || found.order.email;
  return decide(admin, found.order, decision, {
    who: recipient ? `Proof email link (sent to ${recipient})` : "Proof email link",
    message,
    where: "from the proof email",
    source: SOURCES.proofEmail,
  });
}

/**
 * The order behind a proof link, provided its proof is still the one the link
 * was sent for and still waiting for a decision.
 *
 * @returns {Promise<{ok:true, order:object}|{ok:false, error:string}>}
 */
export async function loadProofFromLink(admin, link) {
  const order = await loadOrder(admin, link.orderGid);
  if (!order) return { ok: false, error: "We couldn't find that order." };

  if (productionStatusOf(order) !== "proof-sent") {
    return { ok: false, error: `There's no proof waiting for a decision on ${order.name}. It may already have been approved or sent back for changes.` };
  }
  if (String(order.proofVersion?.value || "") !== link.version) {
    return { ok: false, error: `This link is for an earlier proof of ${order.name}. Please use the links in the latest proof email.` };
  }
  return { ok: true, order };
}

/**
 * Approve and Request changes links for the proof email, on the store's own
 * domain so they open the storefront page without a sign-in.
 */
export async function proofDecisionLinks(admin, orderGid, version) {
  const { shop } = await gql(admin, `#graphql
    query ProofLinkDomain {
      shop { primaryDomain { url } }
    }`);

  const orderId = String(orderGid).split("/").pop();
  const link = (decision) => {
    const url = new URL(LINK_PATH, shop.primaryDomain.url);
    url.searchParams.set("order", orderId);
    url.searchParams.set("v", String(version));
    url.searchParams.set("sig", linkSignature(orderId, String(version)));
    url.searchParams.set("decision", decision);
    return url.toString();
  };

  return { approveUrl: link("approve"), changesUrl: link("changes") };
}

/**
 * The order and proof version a link names, or null when its signature
 * doesn't match — an edited or made-up link.
 *
 * @param {URLSearchParams} params
 * @returns {{orderGid:string, version:string}|null}
 */
export function readProofLink(params) {
  const orderId = String(params.get("order") || "");
  const version = String(params.get("v") || "");
  const given = Buffer.from(String(params.get("sig") || ""));
  if (!/^\d+$/.test(orderId) || !/^\d+$/.test(version)) return null;

  const expected = Buffer.from(linkSignature(orderId, version));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  return { orderGid: `gid://shopify/Order/${orderId}`, version };
}

function linkSignature(orderId, version) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("SHOPIFY_API_SECRET is not set, so proof links can't be signed.");
  return createHmac("sha256", secret).update(`proof-decision|${orderId}|${version}`).digest("base64url");
}

function cleanMessage(message) {
  return String(message || "").trim().slice(0, 900);
}

function checkDecision(decision, message) {
  if (!DECISIONS[decision]) return "That isn't a decision we can record.";
  if (decision === "changes" && !message) return "Tell us what needs changing so we can prepare the next proof.";
  return null;
}

async function decide(admin, order, decision, { who, message, where, source }) {
  if (productionStatusOf(order) !== "proof-sent") {
    return { ok: false, error: `There's no proof waiting for a decision on ${order.name}.` };
  }

  const chosen = DECISIONS[decision];
  const version = order.proofVersion?.value;
  const chargeable = decision === "changes" && Number(version) > INCLUDED_REVISIONS;

  const moved = await changeProductionStatus(admin, order, {
    to: chosen.to,
    changedBy: who,
    source,
    note: [
      `${chosen.verb}${version ? ` (version ${version})` : ""} ${where}.`,
      message ? `"${message}"` : "",
      chargeable
        ? `Revision ${version}: beyond the ${INCLUDED_REVISIONS} included revisions, so chargeable.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    onHoldReason: decision === "changes" ? `Changes requested to proof${version ? ` v${version}` : ""}` : "",
  });
  if (!moved.ok) return moved;

  return { ok: true, orderName: order.name };
}
