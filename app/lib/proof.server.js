/**
 * Proof decisions taken in the portal (ART-03).
 *
 * Most buyers approve from the proof email, but the decision must also be
 * possible on the order itself — the order record is what the QA sweep tests
 * and what internal sales staff use.
 *
 * Every decision leaves two marks on the order: the status tag moves, and a
 * note records who decided, what they decided and when. The note is the audit
 * trail; the tag is what the portal and the status filters read.
 */
import { gql, setOrderStatusTag, appendOrderNote } from "./order-status.server";
import { loadOrderForAction } from "./order-action.server";

/**
 * Requesting changes sends the proof back to be redone. There is no "revising"
 * state in the six-status chain, so the order returns to Artwork Received —
 * Hyve holds the artwork and owes a new proof — and moves to Proof Sent again
 * when customer service issues it.
 */
const DECISIONS = {
  approve: { tag: "proof-approved", verb: "approved the proof" },
  changes: { tag: "artwork-received", verb: "requested changes to the proof" },
};

/**
 * @param {string} orderGid the order carrying the proof
 * @param {"approve"|"changes"} decision
 * @param {{customerGid:string, locationGids?:string[], who:string, message?:string}} by
 * @returns {Promise<{ok:boolean, error?:string, orderName?:string}>}
 */
export async function recordProofDecision(admin, orderGid, decision, by = {}) {
  const chosen = DECISIONS[decision];
  if (!chosen) return { ok: false, error: "That isn't a decision we can record." };

  const found = await loadOrderForAction(admin, orderGid, by);
  if (!found.ok) return found;
  const { order } = found;

  await setOrderStatusTag(admin, order.id, order.tags, chosen.tag);

  const detail = by.message ? `\n"${String(by.message).trim().slice(0, 900)}"` : "";
  await appendOrderNote(admin, order.id, order.note, `${by.who || "The buyer"} ${chosen.verb}.${detail}`);

  return { ok: true, orderName: order.name };
}

export { gql };
