/* eslint-disable react/prop-types -- @react-pdf/renderer primitives are not React DOM
   components and this module is server-only; the document shape is built by
   quote-document.server.js. */
/**
 * Server-side quotation PDF renderer (HYV-116).
 *
 * The layout follows NetSuite's quotation (EST-SG-000007), so the two systems
 * print the same document: green table header, addresses side by side, the
 * totals, payment terms, bank details and footer. The fields follow the one
 * Hyve issues by hand (Q46153): the full specification under each product,
 * Customer PO, Payment Terms and an Expiration Date.
 *
 * `.server.jsx` so @react-pdf/renderer (a heavy server-only dep) is never
 * bundled into the storefront. Every quote PDF comes through here: the cart's
 * download and email, the account's Quotes page, Retrieve a Quote, and the
 * Hyve Custom app.
 */
import { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { LEGAL_NAME, BUSINESS_REGISTRATION_NUMBER, LEGAL_ADDRESS, TERMS_URL } from "./legal-entity.server";
import { HYVE_LOGO } from "./hyve-logo.server";

/**
 * Under the totals on every quote. Duties are worked out at checkout, once the
 * destination is known, so the quote says they are still to come (HYV-93). The
 * cart page carries the same sentence (duty_note_text in main-cart-items). No
 * tax row: Hyve isn't GST registered (James, Sep 8; Stephen, Sep 30).
 */
const DUTY_NOTE = "Import duties and taxes are added at checkout — once paid, there are no customs fees on delivery.";

/** NetSuite's table and total green. */
const GREEN = "#67ad5b";
const RULE = "#cfcfcf";

function money(cents, currency) {
  try {
    // Always the code, "SGD 26.12" not "$26.12": the store sells in several
    // currencies and a bare "$" says which of them only for some (HYV-98).
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency || "USD",
      currencyDisplay: "code",
    }).format((Number(cents) || 0) / 100);
  } catch (_) {
    return `${currency || ""} ${((Number(cents) || 0) / 100).toFixed(2)}`.trim();
  }
}

const COL = { no: 24, code: 80, image: 48, qty: 46, unit: 74, total: 82 };

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 36,
    fontSize: 9,
    color: "#1f2937",
    fontFamily: "Helvetica",
    // No lineHeight here: set on the page, it stops @react-pdf drawing the
    // page numbers, which are positioned on their own.
  },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  logo: { width: 120, height: 60, objectFit: "contain" },
  entity: { alignItems: "flex-end", maxWidth: 230 },
  entityName: { fontFamily: "Helvetica-Bold", fontSize: 10, color: "#111827" },
  entityLine: { fontSize: 8.5, color: "#4b5563", textAlign: "right" },

  title: { fontFamily: "Helvetica-Bold", fontSize: 24, color: "#333333", marginTop: 18, marginBottom: 14 },

  metaGrid: { flexDirection: "row", marginBottom: 16 },
  metaCol: { flex: 1 },
  metaRow: { flexDirection: "row", marginBottom: 3 },
  metaLabel: { width: 96, fontFamily: "Helvetica-Bold", color: "#111827" },
  metaValue: { flex: 1 },

  addresses: { flexDirection: "row", marginBottom: 16 },
  addressCol: { flex: 1, paddingRight: 16 },
  heading: { fontFamily: "Helvetica-Bold", fontSize: 10, color: "#111827", marginBottom: 4 },
  addressLine: { fontSize: 9, lineHeight: 1.3 },
  contactHeading: { fontFamily: "Helvetica-Bold", marginTop: 6 },

  table: { marginBottom: 2 },
  headRow: { flexDirection: "row", backgroundColor: GREEN },
  headCell: { color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 8.5, paddingVertical: 6, paddingHorizontal: 5 },
  row: {
    flexDirection: "row",
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: RULE,
  },
  cell: { paddingVertical: 6, paddingHorizontal: 5, borderRightWidth: 1, borderColor: RULE, justifyContent: "center" },
  cellLast: { borderRightWidth: 0 },
  thumb: { width: 36, height: 36, objectFit: "contain" },
  itemTitle: { fontFamily: "Helvetica-Bold" },
  itemDeco: { fontSize: 8.5 },
  itemDetail: { fontSize: 7.5, color: "#374151", lineHeight: 1.3 },
  num: { textAlign: "right" },
  center: { textAlign: "center" },

  totals: { marginBottom: 6 },
  sumRow: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 2 },
  sumLabel: { width: 130, textAlign: "right", fontFamily: "Helvetica-Bold", paddingRight: 10 },
  sumValue: { width: COL.total + 8, textAlign: "right", paddingRight: 5 },
  sumNote: { width: 130, textAlign: "right", paddingRight: 5, color: "#6b7280", fontFamily: "Helvetica-Oblique" },
  grand: {
    flexDirection: "row",
    justifyContent: "flex-end",
    backgroundColor: GREEN,
    paddingVertical: 7,
    marginTop: 4,
  },
  grandLabel: { width: 130, textAlign: "right", paddingRight: 10, color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 11 },
  grandValue: { width: COL.total + 8, textAlign: "right", paddingRight: 5, color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 11 },
  dutyNote: { fontSize: 8, fontFamily: "Helvetica-Oblique", color: "#0f766e", marginTop: 6 },

  blocks: { flexDirection: "row", marginTop: 16 },
  block: { flex: 1, paddingRight: 16 },
  pairRow: { flexDirection: "row", marginBottom: 3 },
  pairLabel: { width: 96, fontFamily: "Helvetica-Bold", color: "#111827" },
  pairValue: { flex: 1 },

  remarks: { marginTop: 12 },
  bank: { marginTop: 14 },
  bankLabel: { width: 130, fontFamily: "Helvetica-Bold", color: "#111827" },

  closing: { marginTop: 18, alignItems: "center" },
  closingLine: { fontSize: 8, color: "#4b5563", textAlign: "center" },
  closingStrong: { fontFamily: "Helvetica-Bold" },
  pageNumber: { position: "absolute", bottom: 20, left: 36, right: 36, fontSize: 7.5, color: "#9ca3af", textAlign: "right" },
});

function Pair({ label, value, labelStyle = styles.pairLabel }) {
  return (
    <View style={styles.pairRow}>
      <Text style={labelStyle}>{label}</Text>
      <Text style={styles.pairValue}>{value}</Text>
    </View>
  );
}

function AddressBlock({ heading, block, contact, empty }) {
  return (
    <View style={styles.addressCol}>
      <Text style={styles.heading}>{heading}</Text>
      {block ? (
        <>
          {/* A separate contact is named once, under Contact Person, as on Q46153. */}
          {block.name && !contact ? <Text style={styles.addressLine}>{block.name}</Text> : null}
          {block.lines.map((line, i) => (
            <Text key={i} style={styles.addressLine}>
              {line}
            </Text>
          ))}
          {block.phone && !contact ? <Text style={styles.addressLine}>T: {block.phone}</Text> : null}
        </>
      ) : (
        <Text style={styles.addressLine}>{empty}</Text>
      )}
      {contact ? (
        <>
          <Text style={styles.contactHeading}>Contact Person</Text>
          <Text style={styles.addressLine}>{contact.name}</Text>
          {contact.phone ? <Text style={styles.addressLine}>T: {contact.phone}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

function HeadCell({ width, flex, children, last, align }) {
  return (
    <View style={[{ width, flex }, last ? null : { borderRightWidth: 1, borderColor: "#ffffff" }]}>
      <Text style={[styles.headCell, align ? { textAlign: align } : null]}>{children}</Text>
    </View>
  );
}

function QuoteDoc({ doc, withImages }) {
  const currency = doc.currency || "USD";
  const rows = Array.isArray(doc.rows) ? doc.rows : [];

  const metaLeft = [
    ["Quotation No.", doc.ref],
    ["Quotation Date", doc.dateStr],
    ["Currency", currency],
    ["Expiration Date", doc.validStr],
    ["Lead Time", doc.leadTime],
  ].filter(([, value]) => value);
  const metaRight = [
    ["Account Manager", doc.accountManager],
    ["Incoterm", doc.incoterm],
    // Always stated, as on Hyve's own quotation, so a buyer sees where theirs goes.
    ["Customer PO", doc.customerPo || "—"],
    ["Payment Terms", doc.paymentTerms],
  ].filter(([, value]) => value);

  return (
    <Document title={`Quotation ${doc.ref || ""}`.trim()} author={LEGAL_NAME}>
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
          </View>
        </View>

        <Text style={styles.title}>Quotation</Text>

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
          <AddressBlock
            heading="Shipping Address"
            block={doc.shipping}
            contact={doc.shippingContact}
            empty="Chosen at checkout"
          />
        </View>

        <Text style={styles.heading}>Product Details</Text>
        <View style={styles.table}>
          {/* Repeats at the top of every page the table runs onto (HYV-116). */}
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
            // A row never splits across a page.
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

        {/* The totals never split across a page. */}
        <View style={styles.totals} wrap={false}>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Subtotal</Text>
            <Text style={styles.sumValue}>{money(doc.subtotal, currency)}</Text>
          </View>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Shipping</Text>
            {doc.shippingTotal == null ? (
              <Text style={styles.sumNote}>{doc.shippingNote || "Calculated at checkout"}</Text>
            ) : (
              <Text style={styles.sumValue}>{money(doc.shippingTotal, currency)}</Text>
            )}
          </View>
          <View style={styles.grand}>
            <Text style={styles.grandLabel}>Total</Text>
            <Text style={styles.grandValue}>{money(doc.grandTotal, currency)}</Text>
          </View>
          {/* Only where Hyve delivers duty paid. On FOB (and EXW) the buyer
              clears customs, so the line doesn't apply (HYV-116, Michael Oct 4). */}
          {/^DDP\b/i.test(String(doc.incoterm || "")) ? <Text style={styles.dutyNote}>{DUTY_NOTE}</Text> : null}
        </View>

        {/* Payment terms apart from the logistics, which NetSuite filed under
            Payment Terms (HYV-116). Shipping details are on quotes sales
            prepare; a cart quote has no shipping chosen yet. */}
        <View style={styles.blocks} wrap={false}>
          <View style={styles.block}>
            <Text style={styles.heading}>Payment Terms</Text>
            <Text>{doc.paymentTerms}</Text>
          </View>
          {doc.shippingMethod ? (
            <View style={styles.block}>
              <Text style={styles.heading}>Shipping Details</Text>
              <Pair label="Shipping Method" value={doc.shippingMethod} />
              {doc.incoterm ? <Pair label="Incoterm" value={doc.incoterm} /> : null}
            </View>
          ) : null}
        </View>

        {doc.remarks ? (
          <View style={styles.remarks} wrap={false}>
            <Text style={styles.heading}>Other Remarks</Text>
            <Text>{doc.remarks}</Text>
          </View>
        ) : null}

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
          {/* The same date as the Expiration Date above, not a fixed period. */}
          <Text style={styles.closingLine}>This quotation is valid until {doc.validStr}.</Text>
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
 * @param {object} doc from loadQuoteDocument
 * @returns {Promise<Buffer>}
 */
export async function buildQuotePdf(doc) {
  const data = doc || {};
  try {
    return await renderToBuffer(<QuoteDoc doc={data} withImages={true} />);
  } catch (err) {
    // A slow / unreachable line-item image can fail the whole render — fall back
    // to a text-only PDF so the quote (and the email it's attached to) still goes out.
    console.error("[quote-pdf] image render failed, retrying text-only:", err?.message || err);
    return await renderToBuffer(<QuoteDoc doc={data} withImages={false} />);
  }
}
