/* eslint-disable react/prop-types */
import { Link } from "react-router";
/**
 * Custom styling for the admin screens.
 *
 * Polaris gives the page frame, the actions and the buttons — the things that
 * should look native inside the Shopify admin. Everything inside a card is
 * ours, so the app reads as a product rather than a form dump.
 *
 * Every class is prefixed `hyv-` and every rule is scoped under `.hyv`, so
 * nothing here can reach Polaris' own markup. Anything that wraps content in a
 * link resets colour and underline explicitly, because an inherited link style
 * is what makes a card look broken.
 *
 * Internal links use React Router's <Link>, never a bare <a>. Inside the
 * embedded admin a bare anchor reloads the whole iframe instead of letting the
 * router run the next route's loader, so the page arrives with no data until
 * the merchant reloads it by hand.
 */

const CSS = `
.hyv, .hyv *, .hyv *::before, .hyv *::after { box-sizing: border-box; }
.hyv {
  --ink: #1a1a1a;
  --muted: #5c5f62;
  --faint: #8c9196;
  --line: #ebebeb;
  --line-soft: #f4f4f4;
  --surface: #ffffff;
  --sunken: #fafafa;
  --radius: 14px;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
.hyv a { color: inherit; text-decoration: none; }

/* ---------------- shell ---------------- */
.hyv-stack { display: flex; flex-direction: column; gap: 16px; }
.hyv-split {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(280px, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 940px) { .hyv-split { grid-template-columns: minmax(0, 1fr); } }

.hyv-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 1px 2px rgba(26,26,26,0.04);
}

/* ---------------- hero ---------------- */
.hyv-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding: 22px 24px;
}
.hyv-hero__title {
  font-size: 24px;
  font-weight: 680;
  letter-spacing: -0.025em;
  line-height: 1.15;
  margin: 0;
}
.hyv-hero__sub { margin: 6px 0 0; font-size: 13.5px; color: var(--muted); }

/* ---------------- metrics ---------------- */
.hyv-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}
.hyv-metric {
  display: block;
  width: 100%;
  text-align: left;
  font: inherit;
  color: inherit;
  text-decoration: none;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 18px 20px 20px;
  box-shadow: 0 1px 2px rgba(26,26,26,0.04);
  cursor: pointer;
  transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
}
.hyv-metric:hover {
  border-color: #dcdcdc;
  box-shadow: 0 2px 8px rgba(26,26,26,0.07);
  transform: translateY(-1px);
}
.hyv-metric.is-active { border-color: var(--accent, #1a1a1a); box-shadow: 0 0 0 1px var(--accent, #1a1a1a); }
.hyv-metric__head { display: flex; align-items: center; gap: 9px; margin-bottom: 18px; }
.hyv-metric__icon {
  width: 30px; height: 30px; border-radius: 9px; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent-soft, #f3f3f3);
  color: var(--accent, #5c5f62);
}
.hyv-metric__icon svg { width: 15px; height: 15px; display: block; }
.hyv-metric__label {
  display: block;
  font-size: 12.5px; font-weight: 550; color: var(--muted);
  letter-spacing: -0.005em; line-height: 1.3;
}
.hyv-metric__value {
  display: block;
  font-size: 32px; font-weight: 680; line-height: 1;
  letter-spacing: -0.03em;
}
.hyv-metric__foot {
  display: block;
  margin-top: 9px; font-size: 12.5px; color: var(--faint); line-height: 1.4;
}

/* ---------------- panels ---------------- */
.hyv-panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 1px 2px rgba(26,26,26,0.04);
  overflow: hidden;
}
.hyv-panel__head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 16px 20px 14px;
}
.hyv-panel__title { font-size: 14.5px; font-weight: 640; letter-spacing: -0.015em; }
.hyv-panel__link { font-size: 13px; font-weight: 550; color: var(--muted); }
.hyv-panel__link:hover { color: var(--ink); }
.hyv-panel__body { padding: 0 8px 8px; }
.hyv-panel__pad { padding: 4px 20px 18px; }

/* ---------------- rows ---------------- */
.hyv-row {
  display: grid;
  align-items: center;
  gap: 14px;
  padding: 12px;
  border-radius: 10px;
  color: inherit;
  text-decoration: none;
  transition: background .13s ease;
}
.hyv-row:hover { background: var(--sunken); }
.hyv-row__main { min-width: 0; }
.hyv-row__primary {
  display: block;
  font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hyv-row__sub {
  display: block;
  margin-top: 3px; font-size: 12.5px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hyv-row__value {
  font-size: 13.5px; font-weight: 620; text-align: right; white-space: nowrap;
}

/* ---------------- pills ---------------- */
.hyv-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 570; white-space: nowrap; line-height: 1.5;
}
.hyv-pill::before {
  content: ""; width: 5px; height: 5px; border-radius: 999px;
  background: currentColor; flex: 0 0 auto; opacity: .85;
}
.hyv-pill--success  { background: #eef7f1; color: #116b45; }
.hyv-pill--warning  { background: #fdf5e4; color: #8a6116; }
.hyv-pill--critical { background: #fdefee; color: #a5241c; }
.hyv-pill--info     { background: #eef3fd; color: #1f5199; }
.hyv-pill--neutral  { background: #f3f3f3; color: #5c5f62; }

/* ---------------- empty ---------------- */
.hyv-empty { padding: 40px 20px; text-align: center; }
.hyv-empty__title { font-size: 14px; font-weight: 620; margin-bottom: 5px; }
.hyv-empty__text { font-size: 13px; color: var(--muted); margin: 0; }

/* ---------------- table ---------------- */
.hyv-scroll { overflow-x: auto; }
.hyv-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.hyv-table th {
  text-align: left; white-space: nowrap;
  font-size: 11.5px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
  color: var(--faint);
  padding: 11px 20px; border-bottom: 1px solid var(--line);
}
.hyv-table td { padding: 14px 20px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.hyv-table tbody tr:last-child td { border-bottom: 0; }
.hyv-table tbody tr:hover { background: var(--sunken); }
.hyv-num { text-align: right; white-space: nowrap; }
.hyv-table__title { font-weight: 600; letter-spacing: -0.01em; }
.hyv-table__meta { font-size: 12px; color: var(--faint); margin-top: 3px; }

/* ---------------- key / value ---------------- */
.hyv-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0 24px; }
.hyv-kv__item { padding: 13px 0; border-bottom: 1px solid var(--line-soft); }
.hyv-kv__key { font-size: 12px; color: var(--faint); margin-bottom: 4px; }
.hyv-kv__val { font-size: 13.5px; font-weight: 520; overflow-wrap: anywhere; }

/* ---------------- totals ---------------- */
.hyv-total { display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; font-size: 13.5px; }
.hyv-total__key { color: var(--muted); }
.hyv-total__val { font-weight: 570; }
.hyv-total--grand {
  margin-top: 8px; padding-top: 15px; border-top: 1px solid var(--line); font-size: 16px;
}
.hyv-total--grand .hyv-total__key { color: var(--ink); font-weight: 620; }
.hyv-total--grand .hyv-total__val { font-weight: 700; letter-spacing: -0.02em; }

/* ---------------- misc ---------------- */
.hyv-avatar {
  width: 40px; height: 40px; border-radius: 999px; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: #f3f3f3; color: #1a1a1a; font-size: 13.5px; font-weight: 620;
}
.hyv-muted { color: var(--muted); font-size: 13.5px; }
.hyv-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
`;

/** Drop once per page, inside the `.hyv` wrapper. */
export function AdminTheme() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;
}

/** Status pill. `tone` is success | warning | critical | info | neutral. */
export function Pill({ tone = "neutral", children }) {
  return <span className={`hyv-pill hyv-pill--${tone}`}>{children}</span>;
}

/**
 * A metric tile. `href` makes it a link, `onClick` makes it a filter button.
 * Everything inside is a block element so nothing runs together on one line.
 */
export function Metric({ label, value, foot, icon, accent, soft, active, onClick, href }) {
  const style = { "--accent": accent, "--accent-soft": soft };
  const className = `hyv-metric${active ? " is-active" : ""}`;

  const inner = (
    <>
      <div className="hyv-metric__head">
        <span className="hyv-metric__icon">{icon}</span>
        <span className="hyv-metric__label">{label}</span>
      </div>
      <div className="hyv-metric__value">{value}</div>
      {foot ? <div className="hyv-metric__foot">{foot}</div> : null}
    </>
  );

  if (href) {
    return (
      <Link className={className} style={style} to={href}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" className={className} style={style} onClick={onClick}>
      {inner}
    </button>
  );
}

/** One line in a panel: a title, a caption under it, then trailing content. */
export function Row({ href, columns, primary, sub, children }) {
  const inner = (
    <>
      <div className="hyv-row__main">
        <span className="hyv-row__primary">{primary}</span>
        {sub ? <span className="hyv-row__sub">{sub}</span> : null}
      </div>
      {children}
    </>
  );

  const style = { gridTemplateColumns: columns || "minmax(0,1fr) auto" };

  // A row is either a link or plain content — never a clickable div, which is
  // unreachable by keyboard.
  if (href) {
    return (
      <Link className="hyv-row" style={style} to={href}>
        {inner}
      </Link>
    );
  }

  return (
    <div className="hyv-row" style={style}>
      {inner}
    </div>
  );
}

/* ---------------- icons ---------------- */

function icon(path) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export const IconInbox = () =>
  icon(
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>,
  );

export const IconCheck = () =>
  icon(
    <>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </>,
  );

export const IconQuote = () =>
  icon(
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="15" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </>,
  );

export const IconClock = () =>
  icon(
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </>,
  );
