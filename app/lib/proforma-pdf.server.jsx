/* eslint-disable react/prop-types -- @react-pdf/renderer primitives are not React
   DOM components and this module is server-only; the document shape is built by
   proforma-document.server.js. */
/**
 * Proforma invoice PDF (HYV-118), in the quotation's layout like the invoice:
 * the same header, address blocks, product table, totals and bank details.
 *
 * Customs reads it, so the PO number, incoterm, terms of sale and the
 * consignee's legal name and tax ID are on the face of the first page. There
 * is no validity line (that belongs to a quotation) and no tax line: Hyve is
 * not registered for GST or VAT, as on the invoice.
 */
import { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { LEGAL_NAME, BUSINESS_REGISTRATION_NUMBER, LEGAL_ADDRESS, TERMS_URL } from "./legal-entity.server";
import { HYVE_LOGO } from "./hyve-logo.server";
import { AddressBlock, COL, HeadCell, Pair, money, styles } from "./quote-pdf.server.jsx";

const own = StyleSheet.create({
  declared: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 3 },
  declaredLabel: { width: 160, textAlign: "right", paddingRight: 10, fontFamily: "Helvetica-Bold" },
  declaredValue: { width: COL.total + 8, textAlign: "right", paddingRight: 5, fontFamily: "Helvetica-Bold" },
});

function ProformaDoc({ doc, withImages }) {
  const currency = doc.currency || "USD";
  const rows = Array.isArray(doc.rows) ? doc.rows : [];

  const metaLeft = [
    ["Proforma Invoice No.", doc.reference],
    ["Proforma Invoice Date", doc.issuedLabel],
    ["Currency", currency],
    ["Customer PO Number", doc.poNumber],
    ["Quotation Ref.", doc.quoteReference],
    ["Order Ref.", doc.orderName],
  ].filter(([, value]) => value);
  const metaRight = [
    ["Incoterm", doc.incoterm],
    ["Terms of Sale", doc.termsOfSale],
    ["Sales Manager", doc.salesManager],
    ["Payment Terms", doc.termsName || "100% upfront"],
  ].filter(([, value]) => value);

  return (
    <Document title={`Proforma Invoice ${doc.reference || ""}`.trim()} author={LEGAL_NAME}>
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

        <Text style={styles.title}>Proforma Invoice</Text>

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
          <AddressBlock heading="Shipping Address (Consignee)" block={doc.shipping} empty="—" />
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
          <View style={own.declared}>
            <Text style={own.declaredLabel}>Declared Value for Customs</Text>
            <Text style={own.declaredValue}>{money(doc.total, currency)}</Text>
          </View>
        </View>

        <View style={styles.blocks} wrap={false}>
          {doc.logistics?.length ? (
            <View style={styles.block}>
              <Text style={styles.heading}>Logistics</Text>
              {doc.logistics.map(([label, value]) => (
                <Pair key={label} label={label} value={value} labelStyle={styles.metaLabel} />
              ))}
            </View>
          ) : null}
          <View style={styles.block}>
            <Text style={styles.heading}>Payment</Text>
            <Pair label="Payment Terms" value={doc.termsName || "100% upfront"} labelStyle={styles.metaLabel} />
            {doc.dueLabel ? <Pair label="Due Date" value={doc.dueLabel} labelStyle={styles.metaLabel} /> : null}
            <Pair label="Amount Paid" value={money(doc.amountPaid, currency)} labelStyle={styles.metaLabel} />
            <Pair label="Amount Due" value={money(doc.outstanding, currency)} labelStyle={styles.metaLabel} />
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
          {doc.shopEmail ? <Text style={styles.closingLine}>Questions about this document: {doc.shopEmail}</Text> : null}
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

/** @param {object} doc output of loadProformaDocument, with its number issued */
export async function buildProformaPdf(doc) {
  try {
    return await renderToBuffer(<ProformaDoc doc={doc} withImages={true} />);
  } catch (err) {
    // A slow product image can fail the render; the document still goes out.
    console.error("[proforma-pdf] image render failed, retrying text-only:", err?.message || err);
    return await renderToBuffer(<ProformaDoc doc={doc} withImages={false} />);
  }
}
