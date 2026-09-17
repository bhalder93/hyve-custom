/* eslint-disable react/prop-types -- @react-pdf/renderer primitives are not React DOM
   components and this module is server-only; the invoice shape is documented below. */
/**
 * Server-side quote PDF renderer.
 *
 * `.server.jsx` so @react-pdf/renderer (a heavy server-only dep) is never
 * bundled into the storefront/client. The storefront POSTs a display-ready
 * `invoice` object (already grouped into merch/fees with chips + cents totals)
 * to /apps/account/quote with intent:"pdf"; this returns a Buffer we stream
 * back as a downloadable application/pdf — mirroring the on-screen invoice.
 */
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";

function money(cents, currency) {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency || "USD",
    }).format((Number(cents) || 0) / 100);
  } catch (_) {
    return "$" + ((Number(cents) || 0) / 100).toFixed(2);
  }
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 42,
    paddingBottom: 42,
    paddingHorizontal: 44,
    fontSize: 10,
    color: "#0f172a",
    fontFamily: "Helvetica",
  },
  head: { flexDirection: "row", justifyContent: "space-between", marginBottom: 26 },
  brand: { fontSize: 22, fontFamily: "Helvetica-Bold", color: "#0f172a" },
  brandSub: { fontSize: 9, color: "#94a3b8", marginTop: 4, fontFamily: "Helvetica-Bold" },
  meta: { alignItems: "flex-end" },
  badge: {
    backgroundColor: "#a3ea6e",
    color: "#0a1414",
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  metaRow: { fontSize: 9, color: "#475569", marginTop: 6 },
  metaB: { color: "#0f172a", fontFamily: "Helvetica-Bold" },
  itemsBox: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    marginBottom: 18,
  },
  item: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#eef2f7",
  },
  itemLast: { borderBottomWidth: 0 },
  thumb: {
    width: 42,
    height: 42,
    borderRadius: 6,
    marginRight: 12,
    objectFit: "cover",
    borderWidth: 1,
    borderColor: "#eef2f7",
  },
  itemMain: { flex: 1, paddingRight: 12 },
  itemTitle: { fontSize: 11, fontFamily: "Helvetica-Bold", lineHeight: 1.35 },
  chips: { flexDirection: "row", flexWrap: "wrap", marginTop: 6 },
  chip: {
    fontSize: 8,
    color: "#334155",
    backgroundColor: "#f1f5f9",
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginRight: 5,
    marginBottom: 4,
  },
  qty: { fontSize: 8.5, color: "#94a3b8", marginTop: 6 },
  amt: { alignItems: "flex-end" },
  amtTotal: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  amtUnit: { fontSize: 8.5, color: "#94a3b8", marginTop: 2 },
  summary: { marginLeft: "auto", width: 260 },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  sumLabel: { fontSize: 10, color: "#475569" },
  sumVal: { fontSize: 10, color: "#0f172a", fontFamily: "Helvetica-Bold" },
  sumNote: { fontSize: 10, color: "#94a3b8", fontFamily: "Helvetica-Oblique" },
  grand: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 2,
    borderTopColor: "#0f172a",
  },
  grandLabel: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  grandVal: { fontSize: 18, fontFamily: "Helvetica-Bold", color: "#16a34a" },
  foot: {
    marginTop: 24,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#eef2f7",
    fontSize: 8.5,
    color: "#94a3b8",
    lineHeight: 1.6,
  },
});

function QuoteDoc({ inv, withImages }) {
  const currency = inv.currency || "USD";
  const merch = Array.isArray(inv.merch) ? inv.merch : [];
  const fees = Array.isArray(inv.fees) ? inv.fees : [];
  const shopName = inv.shopName || "Quote";

  return (
    <Document title={"Quote " + (inv.ref || "")}>
      <Page size="A4" style={styles.page}>
        <View style={styles.head}>
          <View>
            <Text style={styles.brand}>{shopName}</Text>
            <Text style={styles.brandSub}>Branded merchandise quote</Text>
          </View>
          <View style={styles.meta}>
            <Text style={styles.badge}>QUOTE / ESTIMATE</Text>
            <Text style={styles.metaRow}>
              Ref <Text style={styles.metaB}>{inv.ref}</Text>
            </Text>
            <Text style={styles.metaRow}>
              Date <Text style={styles.metaB}>{inv.dateStr}</Text>
            </Text>
            <Text style={styles.metaRow}>
              Valid until <Text style={styles.metaB}>{inv.validStr}</Text>
            </Text>
          </View>
        </View>

        <View style={styles.itemsBox}>
          {merch.map((it, i) => (
            <View
              key={i}
              style={i === merch.length - 1 ? [styles.item, styles.itemLast] : styles.item}
            >
              {withImages && it.image ? <Image style={styles.thumb} src={it.image} /> : null}
              <View style={styles.itemMain}>
                <Text style={styles.itemTitle}>{it.title}</Text>
                {Array.isArray(it.chips) && it.chips.length ? (
                  <View style={styles.chips}>
                    {it.chips.map((c, j) => (
                      <Text key={j} style={styles.chip}>
                        {c}
                      </Text>
                    ))}
                  </View>
                ) : null}
                <Text style={styles.qty}>Qty {it.qty}</Text>
              </View>
              <View style={styles.amt}>
                <Text style={styles.amtTotal}>{money(it.linePrice, currency)}</Text>
                <Text style={styles.amtUnit}>{money(it.unitPrice, currency)} / unit</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.summary}>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Subtotal</Text>
            <Text style={styles.sumVal}>{money(inv.subtotal, currency)}</Text>
          </View>
          {fees.map((f, i) => (
            <View key={i} style={styles.sumRow}>
              <Text style={styles.sumLabel}>{f.label}</Text>
              <Text style={styles.sumVal}>{money(f.amount, currency)}</Text>
            </View>
          ))}
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Shipping</Text>
            <Text style={styles.sumNote}>Calculated at checkout</Text>
          </View>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Taxes</Text>
            <Text style={styles.sumNote}>Calculated at checkout</Text>
          </View>
          <View style={styles.grand}>
            <Text style={styles.grandLabel}>Grand total</Text>
            <Text style={styles.grandVal}>{money(inv.grandTotal, currency)}</Text>
          </View>
        </View>

        <Text style={styles.foot}>
          This is an estimate, not a tax invoice. Shipping and taxes are calculated at
          checkout. Prices valid until the date shown above. Thank you for choosing {shopName}.
        </Text>
      </Page>
    </Document>
  );
}

/**
 * @param {object} inv display-ready invoice payload from the storefront
 * @returns {Promise<Buffer>}
 */
export async function buildQuotePdf(inv) {
  const data = inv || {};
  try {
    return await renderToBuffer(<QuoteDoc inv={data} withImages={true} />);
  } catch (err) {
    // A slow / unreachable line-item image can fail the whole render — fall back
    // to a text-only PDF so the quote (and the email it's attached to) still goes out.
    console.error("[quote-pdf] image render failed, retrying text-only:", err?.message || err);
    return await renderToBuffer(<QuoteDoc inv={data} withImages={false} />);
  }
}
