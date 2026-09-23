/**
 * Proof decisions taken in the portal (ART-03).
 *
 * Most buyers approve from the proof email, but the decision must also be
 * possible on the order itself — the order record is what the QA sweep tests
 * and what internal sales staff use.
 *
 * A decision is a production move like any other, so it lands in the same
 * status, history and emails as a move made on the Production Orders screen.
 */
import { changeProductionStatus, productionStatusOf } from "./order-status.server";
import { loadOrderForAction } from "./order-action.server";

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
 * @param {string} orderGid the order carrying the proof
 * @param {"approve"|"changes"} decision
 * @param {{customerGid:string, locationGids?:string[], who:string, message?:string}} by
 * @returns {Promise<{ok:boolean, error?:string, orderName?:string}>}
 */
export async function recordProofDecision(admin, orderGid, decision, by = {}) {
  const chosen = DECISIONS[decision];
  if (!chosen) return { ok: false, error: "That isn't a decision we can record." };

  const message = String(by.message || "").trim().slice(0, 900);
  if (decision === "changes" && !message) {
    return { ok: false, error: "Tell us what needs changing so we can prepare the next proof." };
  }

  const found = await loadOrderForAction(admin, orderGid, by);
  if (!found.ok) return found;
  const { order } = found;

  if (productionStatusOf(order) !== "proof-sent") {
    return { ok: false, error: `There's no proof waiting for a decision on ${order.name}.` };
  }

  const version = order.proofVersion?.value;
  const moved = await changeProductionStatus(admin, order, {
    to: chosen.to,
    changedBy: by.who,
    note: [`${chosen.verb}${version ? ` (version ${version})` : ""} in the portal.`, message ? `"${message}"` : ""]
      .filter(Boolean)
      .join("\n"),
    onHoldReason: decision === "changes" ? `Changes requested to proof${version ? ` v${version}` : ""}` : "",
  });
  if (!moved.ok) return moved;

  return { ok: true, orderName: order.name };
}
