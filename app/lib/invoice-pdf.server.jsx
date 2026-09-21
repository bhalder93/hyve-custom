/* eslint-disable react/prop-types -- @react-pdf/renderer primitives are not React
   DOM components and this module is server-only; the document shape is built by
   invoice-document.server.js. */
/**
 * Server-side invoice PDF renderer.
 *
 * `.server.jsx` so @react-pdf/renderer (a heavy server-only dep) is never
 * bundled into the storefront, the same arrangement as the quote PDF.
 *
 * The amounts are the order's settled amounts, so nothing is "calculated at
 * checkout" and nothing here is an estimate.
 *
 * It carries no tax line and does not call itself a tax invoice: Hyve is not
 * registered for GST or VAT in any market it sells into, and showing either is
 * an offence in Singapore and Malaysia.
 */
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";

const TONE = {
  PAID: { bg: "#dcfce7", fg: "#166534" },
  DUE: { bg: "#fef3c7", fg: "#92400e" },
  OVERDUE: { bg: "#fee2e2", fg: "#991b1b" },
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 42,
    paddingBottom: 42,
    paddingHorizontal: 44,
    fontSize: 10,
    color: "#0f172a",
    fontFamily: "Helvetica",
  },

  head: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  brand: { fontSize: 22, fontFamily: "Helvetica-Bold", color: "#0f172a" },
  brandSub: { fontSize: 9, color: "#94a3b8", marginTop: 4, fontFamily: "Helvetica-Bold" },
  brandLine: { fontSize: 8.5, color: "#94a3b8", marginTop: 3, lineHeight: 1.5 },
  meta: { alignItems: "flex-end" },
  badge: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  metaRow: { fontSize: 9, color: "#475569", marginTop: 6 },
  metaB: { color: "#0f172a", fontFamily: "Helvetica-Bold" },

  parties: { flexDirection: "row", marginBottom: 20 },
  party: { flex: 1, paddingRight: 18 },
  partyLabel: {
    fontSize: 7.5,
    letterSpacing: 1,
    color: "#94a3b8",
    fontFamily: "Helvetica-Bold",
    marginBottom: 5,
  },
  partyLine: { fontSize: 9.5, color: "#334155", lineHeight: 1.5 },
  partyStrong: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: "#0f172a", marginBottom: 2 },

  table: { borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 12, marginBottom: 18 },
  th: {
    flexDirection: "row",
    backgroundColor: "#f8fafc",
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  thText: { fontSize: 7.5, letterSpacing: 0.8, color: "#94a3b8", fontFamily: "Helvetica-Bold" },
  tr: {
    flexDirection: "row",
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#eef2f7",
  },
  trLast: { borderBottomWidth: 0 },
  colItem: { flex: 1, paddingRight: 12 },
  colQty: { width: 44, textAlign: "right" },
  colUnit: { width: 82, textAlign: "right" },
  colTotal: { width: 92, textAlign: "right" },
  itemTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", lineHeight: 1.35 },
  itemSub: { fontSize: 8.5, color: "#94a3b8", marginTop: 3 },
  cell: { fontSize: 10, color: "#334155" },
  cellB: { fontSize: 10, color: "#0f172a", fontFamily: "Helvetica-Bold" },

  summary: { marginLeft: "auto", width: 260 },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  sumLabel: { fontSize: 10, color: "#475569" },
  sumVal: { fontSize: 10, color: "#0f172a", fontFamily: "Helvetica-Bold" },
  total: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#cbd5e1",
  },
  totalLabel: { fontSize: 10.5, fontFamily: "Helvetica-Bold" },
  totalVal: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  due: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 2,
    borderTopColor: "#0f172a",
  },
  dueLabel: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  dueVal: { fontSize: 18, fontFamily: "Helvetica-Bold" },

  foot: {
    marginTop: 26,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#eef2f7",
    fontSize: 8.5,
    color: "#94a3b8",
    lineHeight: 1.6,
  },
});

function InvoiceDoc({ doc }) {
  const tone = TONE[doc.status] || TONE.DUE;
  const lines = Array.isArray(doc.lines) ? doc.lines : [];
  const shopAddress = Array.isArray(doc.shopAddress) ? doc.shopAddress : [];
  const billTo = Array.isArray(doc.billTo) ? doc.billTo : [];
  const settled = doc.status === "PAID";

  return (
    <Document title={`Invoice ${doc.reference || ""}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.head}>
          <View>
            <Text style={styles.brand}>{doc.shopName}</Text>
            <Text style={styles.brandSub}>Invoice</Text>
            {shopAddress.map((line, i) => (
              <Text key={i} style={styles.brandLine}>
                {line}
              </Text>
            ))}
            {doc.shopRegistrationNumber ? (
              <Text style={styles.brandLine}>Co. Reg. No. {doc.shopRegistrationNumber}</Text>
            ) : null}
            {doc.shopEmail ? <Text style={styles.brandLine}>{doc.shopEmail}</Text> : null}
          </View>
          <View style={styles.meta}>
            <Text style={[styles.badge, { backgroundColor: tone.bg, color: tone.fg }]}>
              {doc.status}
            </Text>
            <Text style={styles.metaRow}>
              Invoice <Text style={styles.metaB}>{doc.reference}</Text>
            </Text>
            {doc.poNumber ? (
              <Text style={styles.metaRow}>
                PO <Text style={styles.metaB}>{doc.poNumber}</Text>
              </Text>
            ) : null}
            <Text style={styles.metaRow}>
              Issued <Text style={styles.metaB}>{doc.issuedLabel}</Text>
            </Text>
            {settled ? (
              <Text style={styles.metaRow}>
                Paid <Text style={styles.metaB}>{doc.paidLabel}</Text>
              </Text>
            ) : (
              <Text style={styles.metaRow}>
                Due <Text style={styles.metaB}>{doc.dueLabel}</Text>
              </Text>
            )}
          </View>
        </View>

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>BILL TO</Text>
            {billTo.map((line, i) => (
              <Text key={i} style={i === 0 ? styles.partyStrong : styles.partyLine}>
                {line}
              </Text>
            ))}
            {doc.billToTaxNumber ? (
              <Text style={styles.partyLine}>Tax Reg. No. {doc.billToTaxNumber}</Text>
            ) : null}
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>PAYMENT TERMS</Text>
            <Text style={styles.partyStrong}>{doc.termsName || "Due on receipt"}</Text>
            <Text style={styles.partyLine}>Order {doc.orderName}</Text>
            {doc.incoterm ? (
              <Text style={styles.partyLine}>Incoterm {doc.incoterm}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.table}>
          <View style={styles.th}>
            <Text style={[styles.thText, styles.colItem]}>DESCRIPTION</Text>
            <Text style={[styles.thText, styles.colQty]}>QTY</Text>
            <Text style={[styles.thText, styles.colUnit]}>UNIT</Text>
            <Text style={[styles.thText, styles.colTotal]}>AMOUNT</Text>
          </View>
          {lines.map((li, i) => (
            <View key={i} style={i === lines.length - 1 ? [styles.tr, styles.trLast] : styles.tr}>
              <View style={styles.colItem}>
                <Text style={styles.itemTitle}>{li.title}</Text>
                {li.variantTitle || li.sku ? (
                  <Text style={styles.itemSub}>
                    {[li.variantTitle, li.sku ? `SKU ${li.sku}` : ""].filter(Boolean).join("  ·  ")}
                  </Text>
                ) : null}
                {(li.options || []).map((option, n) => (
                  <Text key={n} style={styles.itemSub}>
                    {option}
                  </Text>
                ))}
              </View>
              <Text style={[styles.cell, styles.colQty]}>{li.quantity}</Text>
              <Text style={[styles.cell, styles.colUnit]}>{li.unitLabel}</Text>
              <Text style={[styles.cellB, styles.colTotal]}>{li.totalLabel}</Text>
            </View>
          ))}
        </View>

        <View style={styles.summary}>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Subtotal</Text>
            <Text style={styles.sumVal}>{doc.subtotalLabel}</Text>
          </View>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>{doc.shippingName || "Shipping"}</Text>
            <Text style={styles.sumVal}>{doc.shippingLabel}</Text>
          </View>
          <View style={styles.total}>
            <Text style={styles.totalLabel}>Invoice total</Text>
            <Text style={styles.totalVal}>{doc.totalLabel}</Text>
          </View>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Amount paid</Text>
            <Text style={styles.sumVal}>{doc.paidAmountLabel}</Text>
          </View>
          <View style={styles.due}>
            <Text style={styles.dueLabel}>{settled ? "Balance" : "Amount due"}</Text>
            <Text style={[styles.dueVal, { color: settled ? "#16a34a" : tone.fg }]}>
              {doc.outstandingLabel}
            </Text>
          </View>
        </View>

        <Text style={styles.foot}>
          {settled
            ? `Paid in full on ${doc.paidLabel}. Thank you for your business.`
            : `Payment is due by ${doc.dueLabel} under ${doc.termsName || "the agreed terms"}. Please quote invoice ${doc.reference} with your remittance.`}
          {doc.shopEmail ? ` Questions about this invoice: ${doc.shopEmail}.` : ""}
        </Text>
      </Page>
    </Document>
  );
}

/**
 * @param {object} doc output of loadInvoiceDocument
 * @returns {Promise<Buffer>}
 */
export async function buildInvoicePdf(doc) {
  return await renderToBuffer(<InvoiceDoc doc={doc || {}} />);
}
