/* eslint-disable react/prop-types -- @react-pdf/renderer primitives are not React
   DOM components and this module is server-only; the document shape is built by
   invoice-document.server.js. */
/**
 * Server-side invoice PDF renderer.
 *
 * The quotation's layout (HYV-155): the Hyve logo and entity header, the
 * details in two columns, invoicing and shipping addresses side by side, the
 * green product table, the totals, payment terms and bank details. It uses the
 * quotation's own styles and pieces, so the two print as one family.
 *
 * `.server.jsx` so @react-pdf/renderer (a heavy server-only dep) is never
 * bundled into the storefront, the same arrangement as the quote PDF.
 *
 * The amounts are the order's settled amounts, so nothing is "calculated at
 * checkout" and nothing here is an estimate. It carries no tax line and does
 * not call itself a tax invoice: Hyve is not registered for GST or VAT in any
 * market it sells into, and showing either is an offence in Singapore and
 * Malaysia.
 */
import { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { LEGAL_NAME, BUSINESS_REGISTRATION_NUMBER, LEGAL_ADDRESS, TERMS_URL } from "./legal-entity.server";
import { HYVE_LOGO } from "./hyve-logo.server";
import { AddressBlock, COL, HeadCell, Pair, money, styles } from "./quote-pdf.server.jsx";

const TONE = {
  PAID: { bg: "#dcfce7", fg: "#166534" },
  DUE: { bg: "#fef3c7", fg: "#92400e" },
  OVERDUE: { bg: "#fee2e2", fg: "#991b1b" },
};

const own = StyleSheet.create({
  titleRow: { flexDirection: "row", alignItems: "center", marginTop: 18, marginBottom: 14 },
  badge: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 999,
    marginLeft: 12,
  },
  due: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingVertical: 7,
    marginTop: 4,
    borderTopWidth: 2,
    borderTopColor: "#111827",
  },
  dueLabel: { width: 130, textAlign: "right", paddingRight: 10, fontFamily: "Helvetica-Bold", fontSize: 11 },
  dueValue: { width: COL.total + 8, textAlign: "right", paddingRight: 5, fontFamily: "Helvetica-Bold", fontSize: 11 },
});

function InvoiceDoc({ doc, withImages }) {
  const currency = doc.currency || "USD";
  const rows = Array.isArray(doc.rows) ? doc.rows : [];
  const tone = TONE[doc.status] || TONE.DUE;
  const settled = doc.status === "PAID";

  const metaLeft = [
    ["Invoice No.", doc.reference],
    ["Invoice Date", doc.issuedLabel],
    ["Currency", currency],
    settled ? ["Paid On", doc.paidLabel] : ["Due Date", doc.dueLabel],
    ["Est. Ship Date", doc.shipDateLabel],
  ].filter(([, value]) => value);
  const metaRight = [
    ["Account Manager", doc.accountManager],
    ["Incoterm", doc.incoterm],
    ["Shipping Method", doc.shippingName],
    // Always stated, as on the quotation, a dash when there is none.
    ["Customer PO", doc.poNumber || "—"],
    ["Payment Terms", doc.termsName || "100% upfront"],
    ["Tax Reg. No.", doc.billToTaxNumber],
  ].filter(([, value]) => value);

  return (
    <Document title={`Invoice ${doc.reference || ""}`.trim()} author={LEGAL_NAME}>
      <Page size="A4" style={styles.page}>
        <View style={styles.head}>
          <Image style={styles.logo} src={HYVE_LOGO} />
          <View style={styles.entity}>
            <Text style={styles.entityName}>{LEGAL_NAME}</Text>
            {LEGAL_ADDRESS.map((line) => (
              <Text key={line} style={styles.entityLine}>
                {line}
              </Text>
            ))}
            <Text style={styles.entityLine}>Co. Reg. No. {BUSINESS_REGISTRATION_NUMBER}</Text>
            {doc.shopEmail ? <Text style={styles.entityLine}>{doc.shopEmail}</Text> : null}
          </View>
        </View>

        <View style={own.titleRow}>
          <Text style={[styles.title, { marginTop: 0, marginBottom: 0 }]}>Invoice</Text>
          <Text style={[own.badge, { backgroundColor: tone.bg, color: tone.fg }]}>{doc.status}</Text>
        </View>

        <View style={styles.metaGrid}>
          <View style={styles.metaCol}>
            {metaLeft.map(([label, value]) => (
              <Pair key={label} label={label} value={value} labelStyle={styles.metaLabel} />
            ))}
          </View>
          <View style={styles.metaCol}>
            {metaRight.map(([label, value]) => (
              <Pair key={label} label={label} value={value} labelStyle={styles.metaLabel} />
            ))}
          </View>
        </View>

        <View style={styles.addresses}>
          <AddressBlock heading="Invoicing Address" block={doc.invoicing} empty="—" />
          <AddressBlock heading="Shipping Address" block={doc.shipping} contact={doc.shippingContact} empty="—" />
        </View>

        <Text style={styles.heading}>Product Details</Text>
        <View style={styles.table}>
          <View style={styles.headRow} fixed>
            <HeadCell width={COL.no}>No.</HeadCell>
            <HeadCell width={COL.code}>Product Code</HeadCell>
            <HeadCell width={COL.image}>Image</HeadCell>
            <HeadCell flex={1}>Description</HeadCell>
            <HeadCell width={COL.qty} align="center">Quantity</HeadCell>
            <HeadCell width={COL.unit} align="right">Unit Price</HeadCell>
            <HeadCell width={COL.total} align="right" last>
              Total Amount
            </HeadCell>
          </View>
          {rows.map((row, i) => (
            <View key={i} style={styles.row} wrap={false}>
              <View style={[styles.cell, { width: COL.no }]}>
                <Text style={styles.center}>{i + 1}</Text>
              </View>
              <View style={[styles.cell, { width: COL.code }]}>
                <Text>{row.code}</Text>
              </View>
              <View style={[styles.cell, { width: COL.image, alignItems: "center" }]}>
                {withImages && row.kind === "item" && row.image ? <Image style={styles.thumb} src={row.image} /> : null}
              </View>
              <View style={[styles.cell, { flex: 1 }]}>
                <Text style={styles.itemTitle}>{row.title}</Text>
                {row.decoration ? <Text style={styles.itemDeco}>({row.decoration})</Text> : null}
                {(row.details || []).map((line, j) => (
                  <Text key={j} style={styles.itemDetail}>
                    {line}
                  </Text>
                ))}
              </View>
              <View style={[styles.cell, { width: COL.qty }]}>
                <Text style={styles.center}>{row.qty}</Text>
              </View>
              <View style={[styles.cell, { width: COL.unit }]}>
                <Text style={styles.num}>{money(row.unit, currency)}</Text>
              </View>
              <View style={[styles.cell, styles.cellLast, { width: COL.total }]}>
                <Text style={styles.num}>{money(row.total, currency)}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.totals} wrap={false}>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Subtotal</Text>
            <Text style={styles.sumValue}>{money(doc.subtotal, currency)}</Text>
          </View>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Shipping</Text>
            <Text style={styles.sumValue}>{money(doc.shippingTotal, currency)}</Text>
          </View>
          <View style={styles.grand}>
            <Text style={styles.grandLabel}>Total</Text>
            <Text style={styles.grandValue}>{money(doc.total, currency)}</Text>
          </View>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Amount Paid</Text>
            <Text style={styles.sumValue}>{money(doc.amountPaid, currency)}</Text>
          </View>
          <View style={own.due}>
            <Text style={own.dueLabel}>{settled ? "Balance" : "Amount Due"}</Text>
            <Text style={[own.dueValue, { color: settled ? "#16a34a" : tone.fg }]}>{money(doc.outstanding, currency)}</Text>
          </View>
        </View>

        <View style={styles.blocks} wrap={false}>
          <View style={styles.block}>
            <Text style={styles.heading}>Payment Terms</Text>
            <Text>
              {settled
                ? `Paid in full on ${doc.paidLabel}. Thank you for your business.`
                : `${doc.termsName || "100% upfront"}. Payment is due by ${doc.dueLabel}. Please quote invoice ${doc.reference} with your remittance.`}
            </Text>
          </View>
        </View>

        {doc.bank ? (
          <View style={styles.bank} wrap={false}>
            <Text style={styles.heading}>{doc.bank.heading}</Text>
            {doc.bank.rows.map(([label, value]) => (
              <Pair key={label} label={`${label}:`} value={value} labelStyle={styles.bankLabel} />
            ))}
          </View>
        ) : null}

        <View style={styles.closing} wrap={false}>
          <Text style={styles.closingLine}>
            <Text style={styles.closingStrong}>General terms and conditions: </Text>
            {TERMS_URL}
          </Text>
          {doc.shopEmail ? (
            <Text style={styles.closingLine}>Questions about this invoice: {doc.shopEmail}</Text>
          ) : null}
        </View>

        <Text
          style={styles.pageNumber}
          fixed
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

/**
 * @param {object} doc output of loadInvoiceDocument
 * @returns {Promise<Buffer>}
 */
export async function buildInvoicePdf(doc) {
  const data = doc || {};
  try {
    return await renderToBuffer(<InvoiceDoc doc={data} withImages={true} />);
  } catch (err) {
    // A slow or unreachable product image can fail the render; the invoice
    // still goes out, text only, as the quotation does.
    console.error("[invoice-pdf] image render failed, retrying text-only:", err?.message || err);
    return await renderToBuffer(<InvoiceDoc doc={data} withImages={false} />);
  }
}
