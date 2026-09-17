/* eslint-disable react/prop-types -- small presentational helpers, shapes are obvious at each call site */
/**
 * Shared look for the app's admin pages.
 *
 * The embedded admin doesn't have to be Polaris, and these screens sit next to
 * the distributor portal in people's heads, so they use the same language:
 * Plus Jakarta Sans headings, Inter body, the lime-to-teal gradient for the one
 * primary action on a page, 12px cards on a #EEF2F7 ground.
 *
 * Everything is scoped under `.hy` so nothing leaks into Shopify's own chrome.
 */

export function HyveStyles() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap"
      />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </>
  );
}

export function Page({ title, subtitle, actions, children }) {
  return (
    <div className="hy">
      <HyveStyles />
      <div className="hy__head">
        <div>
          <h1 className="hy__title">{title}</h1>
          {subtitle ? <p className="hy__sub">{subtitle}</p> : null}
        </div>
        {actions ? <div className="hy__head-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, description, children, footer }) {
  return (
    <section className="hy__card">
      {title ? (
        <header className="hy__card-head">
          <h2 className="hy__card-title">{title}</h2>
          {description ? <p className="hy__card-desc">{description}</p> : null}
        </header>
      ) : null}
      <div className="hy__card-body">{children}</div>
      {footer ? <footer className="hy__card-foot">{footer}</footer> : null}
    </section>
  );
}

export function StatRow({ children }) {
  return <div className="hy__stats">{children}</div>;
}

export function Stat({ label, value, badge, tone = "neutral" }) {
  return (
    <div className="hy__stat">
      <span className="hy__stat-label">{label}</span>
      <span className="hy__stat-value">{value}</span>
      {badge ? <Badge tone={tone}>{badge}</Badge> : null}
    </div>
  );
}

export function Badge({ tone = "neutral", children }) {
  return <span className={`hy__badge hy__badge--${tone}`}>{children}</span>;
}

export function Button({ variant = "secondary", type = "button", children, ...rest }) {
  return (
    <button type={type} className={`hy__btn hy__btn--${variant}`} {...rest}>
      {children}
    </button>
  );
}

export function Field({ label, hint, required, children }) {
  return (
    <label className="hy__field">
      <span className="hy__field-label">
        {label}
        {required ? <span className="hy__field-required">Required</span> : null}
      </span>
      {children}
      {hint ? <span className="hy__field-hint">{hint}</span> : null}
    </label>
  );
}

export function Input(props) {
  return <input className="hy__input" {...props} />;
}

export function Select({ children, ...rest }) {
  return (
    <select className="hy__input hy__select" {...rest}>
      {children}
    </select>
  );
}

export function Textarea(props) {
  return <textarea className="hy__input hy__textarea" {...props} />;
}

/** label / value pairs, the way the portal's detail panels read. */
export function Facts({ children }) {
  return <div className="hy__facts">{children}</div>;
}

export function Fact({ label, children }) {
  return (
    <div className="hy__fact">
      <span className="hy__fact-label">{label}</span>
      <span className="hy__fact-value">{children ?? "—"}</span>
    </div>
  );
}

export function Notice({ tone = "warn", title, children }) {
  return (
    <div className={`hy__notice hy__notice--${tone}`}>
      {title ? <strong>{title}</strong> : null}
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="hy__empty">{children}</div>;
}

const CSS = `
.hy {
  --hy-bg: #EEF2F7;
  --hy-white: #FFFFFF;
  --hy-900: #0F172A;
  --hy-700: #334155;
  --hy-500: #64748B;
  --hy-muted: #94A3B8;
  --hy-line: rgba(15, 23, 42, 0.06);
  --hy-line-strong: rgba(15, 23, 42, 0.10);
  --hy-gradient: linear-gradient(135deg, #A3EA6E 0%, #6EDEE1 100%);
  --hy-radius: 12px;
  --hy-display: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --hy-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--hy-bg);
  font-family: var(--hy-body);
  color: var(--hy-900);
  font-size: 14px;
  line-height: 1.5;
  padding: 20px;
  min-height: 100%;
}
.hy *, .hy *::before, .hy *::after { box-sizing: border-box; }

.hy__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.hy__title { font-family: var(--hy-display); font-size: 22px; font-weight: 800; margin: 0; }
.hy__sub { color: var(--hy-muted); font-size: 13px; margin: 2px 0 0; }
.hy__head-actions { display: flex; gap: 8px; }

.hy__card { background: var(--hy-white); border: 1px solid var(--hy-line); border-radius: var(--hy-radius); margin-bottom: 14px; overflow: hidden; }
.hy__card-head { padding: 16px 18px 0; }
.hy__card-title { font-family: var(--hy-display); font-size: 15px; font-weight: 800; margin: 0; }
.hy__card-desc { color: var(--hy-muted); font-size: 12.5px; margin: 3px 0 0; }
.hy__card-body { padding: 16px 18px; }
.hy__card-foot { padding: 14px 18px; border-top: 1px solid var(--hy-line); background: #F8FAFC; display: flex; gap: 8px; flex-wrap: wrap; }

.hy__stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 14px; }
.hy__stat { background: var(--hy-white); border: 1px solid var(--hy-line); border-radius: var(--hy-radius); padding: 16px 18px; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.hy__stat-label { font-size: 11.5px; color: var(--hy-muted); }
.hy__stat-value { font-family: var(--hy-display); font-size: 24px; font-weight: 800; line-height: 1.1; }

.hy__badge { display: inline-flex; align-items: center; border-radius: 9999px; padding: 2px 9px; font-size: 10.5px; font-weight: 700; }
.hy__badge--neutral { background: #F1F5F9; color: #475569; }
.hy__badge--warn { background: #FEF3C7; color: #B45309; }
.hy__badge--ok { background: #DCFCE7; color: #15803D; }
.hy__badge--error { background: #FEE2E2; color: #B91C1C; }
.hy__badge--info { background: #DBEAFE; color: #1D4ED8; }

.hy__btn { display: inline-flex; align-items: center; gap: 6px; border-radius: 8px; padding: 9px 16px; font-family: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; border: 1px solid transparent; text-decoration: none; }
.hy__btn--primary { background: var(--hy-gradient); color: #0A1414; }
.hy__btn--primary:hover { filter: brightness(0.96); }
.hy__btn--secondary { background: #fff; border-color: var(--hy-line-strong); color: var(--hy-700); }
.hy__btn--secondary:hover { border-color: var(--hy-muted); }
.hy__btn--danger { background: #fff; border-color: #FCA5A5; color: #B91C1C; }
.hy__btn--danger:hover { background: #FEF2F2; }
.hy__btn[disabled] { opacity: 0.55; cursor: not-allowed; }

.hy__field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.hy__field-label { font-size: 12px; font-weight: 600; color: var(--hy-700); display: flex; align-items: center; gap: 8px; }
.hy__gate { margin: 8px 0 0; font-size: 12px; color: #B45309; }
.hy__field-required { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #B45309; background: #FEF3C7; border-radius: 9999px; padding: 2px 7px; }
.hy__field-hint { font-size: 11.5px; color: var(--hy-muted); }
.hy__input { width: 100%; border: 1px solid var(--hy-line-strong); border-radius: 8px; padding: 9px 12px; font-family: inherit; font-size: 13px; color: var(--hy-900); background: #fff; }
.hy__input:focus { outline: 2px solid rgba(110, 222, 225, 0.5); outline-offset: 1px; border-color: #6EDEE1; }
.hy__textarea { min-height: 90px; resize: vertical; }
.hy__select { appearance: auto; }

.hy__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px 24px; }
.hy__fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.hy__fact-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--hy-muted); }
.hy__fact-value { font-size: 13px; font-weight: 600; color: var(--hy-900); overflow-wrap: anywhere; }
.hy__fact-value a { color: #0F766E; }

.hy__notice { border-radius: var(--hy-radius); padding: 12px 14px; margin-bottom: 14px; font-size: 12.5px; }
.hy__notice strong { display: block; font-family: var(--hy-display); font-size: 13.5px; font-weight: 800; margin-bottom: 2px; }
.hy__notice p { margin: 0; }
.hy__notice--warn { background: #FEF3C7; color: #78350F; }
.hy__notice--ok { background: #DCFCE7; color: #14532D; }
.hy__notice--error { background: #FEE2E2; color: #7F1D1D; }
.hy__notice--info { background: #E0F2FE; color: #0C4A6E; }

.hy__empty { border: 1px dashed #CBD5E1; border-radius: var(--hy-radius); padding: 36px 20px; text-align: center; color: var(--hy-muted); font-size: 13px; }

.hy__table-wrap { overflow-x: auto; }
.hy__table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 760px; }
.hy__table th { text-align: left; font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--hy-muted); padding: 0 14px 10px 0; border-bottom: 1px solid var(--hy-line); }
.hy__table td { padding: 12px 14px 12px 0; border-bottom: 1px solid var(--hy-line); vertical-align: middle; }
.hy__table tr:last-child td { border-bottom: 0; }
.hy__table td:last-child, .hy__table th:last-child { padding-right: 0; text-align: right; }
.hy__strong { font-weight: 700; }
.hy__dim { color: var(--hy-muted); font-size: 12px; }

.hy__steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.hy__steps li { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; padding-left: 20px; position: relative; }
.hy__steps li::before { position: absolute; left: 0; top: 0; font-weight: 700; }
.hy__steps li.is-ok::before { content: '✓'; color: #15803D; }
.hy__steps li.is-bad::before { content: '!'; color: #B91C1C; }
.hy__step-name { font-weight: 700; text-transform: capitalize; min-width: 120px; }
.hy__step-detail { color: var(--hy-500); }

.hy__filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
.hy__search { flex: 0 1 280px; }
.hy__pill { border: 0; background: rgba(15,23,42,0.04); color: var(--hy-500); border-radius: 9999px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
.hy__pill:hover { background: rgba(15,23,42,0.08); }
.hy__pill.is-active { background: linear-gradient(135deg, rgba(163,234,110,0.18) 0%, rgba(110,222,225,0.18) 100%); color: var(--hy-900); font-weight: 700; }
`;
