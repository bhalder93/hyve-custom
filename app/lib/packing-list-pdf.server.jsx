/* eslint-disable react/prop-types -- @react-pdf/renderer primitives are not React
   DOM components and this module is server-only. */
/**
 * Packing list PDF, sent with the Ready For Collection email (HYV-160).
 *
 * What the forwarder collects: the products and quantities, without prices,
 * and the cartons, gross weight and CBM staff enter at Ready For Collection.
 * Built from the invoice's own document (loadInvoiceDocument), so the items
 * match the commercial invoice sent alongside it, and printed in the same
 * layout family as the invoice and quotation.
 */
import { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { LEGAL_NAME, BUSINESS_REGISTRATION_NUMBER, LEGAL_ADDRESS } from "./legal-entity.server";
import { HYVE_LOGO } from "./hyve-logo.server";
import { AddressBlock, COL, HeadCell, Pair, styles } from "./quote-pdf.server.jsx";

const own = StyleSheet.create({
  summary: { marginTop: 14, borderTopWidth: 2, borderTopColor: "#111827", paddingTop: 8 },
  summaryRow: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 3 },
  summaryLabel: { width: 150, textAlign: "right", paddingRight: 10, fontFamily: "Helvetica-Bold" },
  summaryValue: { width: 110, textAlign: "right", paddingRight: 5 },
});

/** "2026-10-19" as "19 Oct 2026", as the other documents print dates. */
export function readyDateLabel(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value || "");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

/** A figure with its unit, unless staff typed the unit in already. */
function withUnit(value, unit, pattern) {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  return pattern.test(text) ? text : `${text} ${unit}`;
}

function PackingListDoc({ doc, collection }) {
  const items = (Array.isArray(doc.rows) ? doc.rows : []).filter((row) => row.kind === "item");
  const totalUnits = items.reduce((sum, row) => sum + (Number(row.qty) || 0), 0);

  const metaLeft = [
    ["Order No.", doc.reference],
    ["Ready Date", readyDateLabel(collection.readyDate)],
    ["Customer PO", doc.poNumber || "—"],
  ].filter(([, value]) => value);
  const metaRight = [
    ["Incoterm", doc.incoterm],
    ["Shipping Method", doc.shippingName],
  ].filter(([, value]) => value);

  return (
    <Document title={`Packing List ${doc.reference || ""}`.trim()} author={LEGAL_NAME}>
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

        <Text style={styles.title}>Packing List</Text>

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
          {/* The consignee is who the goods go to: the ship-to party. */}
          <AddressBlock heading="Bill To" block={doc.invoicing} empty="—" />
          <AddressBlock heading="Consignee (Ship To)" block={doc.shipping} contact={doc.shippingContact} empty="—" />
        </View>

        <Text style={styles.heading}>Contents</Text>
        <View style={styles.table}>
          <View style={styles.headRow} fixed>
            <HeadCell width={COL.no}>No.</HeadCell>
            <HeadCell width={COL.code}>Product Code</HeadCell>
            <HeadCell flex={1}>Description</HeadCell>
            <HeadCell width={COL.qty} align="center" last>
              Quantity
            </HeadCell>
          </View>
          {items.map((row, i) => (
            <View key={i} style={styles.row} wrap={false}>
              <View style={[styles.cell, { width: COL.no }]}>
                <Text style={styles.center}>{i + 1}</Text>
              </View>
              <View style={[styles.cell, { width: COL.code }]}>
                <Text>{row.code}</Text>
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
              <View style={[styles.cell, styles.cellLast, { width: COL.qty }]}>
                <Text style={styles.center}>{row.qty}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={own.summary} wrap={false}>
          <View style={own.summaryRow}>
            <Text style={own.summaryLabel}>Total Units</Text>
            <Text style={own.summaryValue}>{totalUnits}</Text>
          </View>
          <View style={own.summaryRow}>
            <Text style={own.summaryLabel}>Number of Cartons</Text>
            <Text style={own.summaryValue}>{String(collection.numberOfCartons ?? "").trim() || "—"}</Text>
          </View>
          <View style={own.summaryRow}>
            <Text style={own.summaryLabel}>Gross Weight</Text>
            <Text style={own.summaryValue}>{withUnit(collection.grossWeight, "kg", /kg/i)}</Text>
          </View>
          <View style={own.summaryRow}>
            <Text style={own.summaryLabel}>Total CBM</Text>
            <Text style={own.summaryValue}>{withUnit(collection.cbm, "m³", /m³|cbm/i)}</Text>
          </View>
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
 * @param {{readyDate?:string, numberOfCartons?:string|number, grossWeight?:string|number, cbm?:string|number}} collection
 * @returns {Promise<Buffer>}
 */
export async function buildPackingListPdf(doc, collection = {}) {
  return renderToBuffer(<PackingListDoc doc={doc || {}} collection={collection || {}} />);
}
