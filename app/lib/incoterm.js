/** Hyve's FOB is at Ningbo. */
export const FOB_INCOTERM = "FOB Ningbo";

/**
 * The Incoterm an order or quote ships under, from its shipping line's name
 * (HYV-140). FOB means the buyer arranges the freight from Ningbo. Any other
 * shipping (UPS today) is Hyve delivering: duties paid (DDP) for a retail
 * buyer, and duties unpaid (DDU) for a distributor, who is the importer of
 * record and pays the duties on import (HYV-75, Oct 16). The UPS name comes
 * from the carrier app and can't be changed, so the invoice, portal and Hyve
 * Custom state the term next to it. Empty when nothing is chosen.
 */
export function incotermFromShipping(shippingTitle, { distributor = false } = {}) {
  const title = String(shippingTitle || "").trim();
  if (!title) return "";
  if (/^fob\b/i.test(title)) return FOB_INCOTERM;
  return distributor ? "DDU" : "DDP";
}
