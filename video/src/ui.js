/**
 * Small DOM + motion toolkit for the pitch stage.
 *
 * Every visual is driven by an explicit time value rather than CSS animations,
 * so any frame can be rendered deterministically by seeking to its timestamp.
 */

// ── time / easing ───────────────────────────────────────────────────────────

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Progress of `t` through the window [from, from + dur], clamped to 0..1. */
export const seg = (t, from, dur) => clamp01((t - from) / dur);

export const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeOutQuint = (t) => 1 - Math.pow(1 - clamp01(t), 5);
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutBack = (t) => {
  const c = 1.9;
  const p = clamp01(t) - 1;
  return 1 + (c + 1) * p * p * p + c * p * p;
};

/** Reveal helper: returns `{ opacity, transform }` for an entrance at `at`. */
export function enter(t, at, dur = 0.55, { y = 26, x = 0, scale = 1 } = {}) {
  const p = seg(t, at, dur);
  const e = easeOut(p);
  return {
    opacity: e,
    transform: `translate3d(${(1 - e) * x}px, ${(1 - e) * y}px, 0) scale(${lerp(scale, 1, e)})`,
  };
}

/** Apply a style object to a node. */
export function style(node, props) {
  if (!props) return node;
  for (const [k, v] of Object.entries(props)) node.style[k] = v;
  return node;
}

// ── element helper ──────────────────────────────────────────────────────────

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'style') style(node, value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false) node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const asset = (name) => `/video/assets/${name}`;

// ── syntax highlighting ─────────────────────────────────────────────────────

const MONO = 'var(--mono)';

/* Rule patterns are alternated into one scanner, so each must avoid its own
 * capturing groups. */
const RULES = {
  typescript: [
    { cls: 'com', pattern: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    { cls: 'str', pattern: '`[^`]*`|\'[^\']*\'|"[^"]*"' },
    {
      cls: 'kw',
      pattern:
        '\\b(?:await|async|const|let|var|return|if|else|throw|new|import|from|export|default|class|function|for|of|in|type|as|interface|extends|implements|public|private|protected|readonly|static|try|catch|finally|null|undefined|true|false|this|void|number|string|boolean)\\b',
    },
    { cls: 'num', pattern: '\\b\\d[\\d_]*(?:\\.\\d+)?n?\\b' },
    { cls: 'fn', pattern: '\\b[a-z_$][A-Za-z0-9_$]*(?=\\s*\\()' },
    { cls: 'typ', pattern: '\\b[A-Z][A-Za-z0-9_]*\\b' },
  ],
  rust: [
    { cls: 'com', pattern: '\\/\\/[^\\n]*' },
    { cls: 'str', pattern: '"[^"]*"' },
    {
      cls: 'kw',
      pattern:
        '\\b(?:pub|fn|let|mut|const|impl|struct|enum|use|mod|return|if|else|match|for|while|loop|where|as|dyn|ref|self|Self|true|false|u32|u64|i128|u128|bool|String|Env|Address|Vec|Option|Result)\\b',
    },
    { cls: 'num', pattern: '\\b\\d[\\d_]*(?:\\.\\d+)?\\b' },
    { cls: 'attr', pattern: '#\\[[^\\]]*\\]' },
    { cls: 'fn', pattern: '\\b[a-z_][A-Za-z0-9_]*(?=\\s*\\()' },
  ],
  json: [
    { cls: 'key', pattern: '"[^"]*"(?=\\s*:)' },
    { cls: 'str', pattern: '"[^"]*"' },
    { cls: 'num', pattern: '\\b-?\\d+(?:\\.\\d+)?\\b' },
    { cls: 'kw', pattern: '\\b(?:true|false|null)\\b' },
  ],
  bash: [
    { cls: 'com', pattern: '#[^\\n]*' },
    { cls: 'str', pattern: '"[^"]*"|\'[^\']*\'' },
    { cls: 'kw', pattern: '\\b(?:curl|pnpm|docker|node|bash|npx|export|cd|npm|git)\\b' },
    { cls: 'num', pattern: '\\b\\d+\\b' },
  ],
  http: [
    { cls: 'typ', pattern: '\\b(?:POST|GET|PUT|DELETE|PATCH)\\b' },
    { cls: 'num', pattern: '\\b\\d{3}\\b' },
    { cls: 'com', pattern: '^\\s*[A-Za-z-]+(?=:)', flags: 'm' },
    { cls: 'str', pattern: '"[^"]*"' },
  ],
};

const tokenStyles = {
  com: 'color:#5b6b7f;font-style:italic',
  str: 'color:#7ee787',
  kw: 'color:#ff7b72',
  num: 'color:#79c0ff',
  fn: 'color:#d2a8ff',
  typ: 'color:#ffa657',
  attr: 'color:#79c0ff',
  key: 'color:#79c0ff',
};

/** Turn code into a document fragment with token spans. */
export function highlight(code, lang = 'typescript') {
  const rules = RULES[lang] || RULES.typescript;
  const combined = new RegExp(rules.map((r) => `(${r.pattern})`).join('|'), 'g');
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const match of code.matchAll(combined)) {
    if (match.index > cursor) frag.append(document.createTextNode(code.slice(cursor, match.index)));
    const groupIndex = match.slice(1).findIndex((g) => g !== undefined);
    const span = el('span', { text: match[0] });
    const ruleset = tokenStyles[rules[groupIndex]?.cls];
    if (ruleset) span.style.cssText = ruleset;
    frag.append(span);
    cursor = match.index + match[0].length;
  }
  if (cursor < code.length) frag.append(document.createTextNode(code.slice(cursor)));
  return frag;
}

// ── shared stylesheet ───────────────────────────────────────────────────────

const css = `
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 26px 30px;
  }
  .card.tint { background: linear-gradient(150deg, rgba(34,197,94,.10), rgba(59,130,246,.06)); }
  .kicker {
    display: inline-flex; align-items: center; gap: 12px;
    font-size: 19px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase;
    color: var(--accent);
  }
  .kicker::before {
    content: ''; width: 34px; height: 3px; border-radius: 2px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }
  .h1 { font-size: 92px; font-weight: 800; letter-spacing: -.03em; line-height: 1.02; }
  .h2 { font-size: 60px; font-weight: 780; letter-spacing: -.025em; line-height: 1.08; }
  .h3 { font-size: 33px; font-weight: 700; letter-spacing: -.015em; }
  .lead { font-size: 27px; line-height: 1.5; color: var(--muted); font-weight: 450; }
  .body { font-size: 23px; line-height: 1.52; color: var(--muted); }
  .mono { font-family: var(--mono); }
  .pill {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 8px 16px; border-radius: 999px; font-size: 19px; font-weight: 600;
    border: 1px solid var(--border); background: var(--panel-strong); color: var(--muted);
  }
  .pill.green { color: #4ade80; border-color: rgba(34,197,94,.4); background: rgba(34,197,94,.12); }
  .pill.blue { color: #93c5fd; border-color: rgba(59,130,246,.4); background: rgba(59,130,246,.12); }
  .pill.amber { color: #fcd34d; border-color: rgba(245,158,11,.4); background: rgba(245,158,11,.12); }
  .pill.red { color: #fca5a5; border-color: rgba(239,68,68,.4); background: rgba(239,68,68,.12); }

  .stat .value { font-size: 58px; font-weight: 800; letter-spacing: -.03em; }
  .stat .label { font-size: 20px; color: var(--muted); font-weight: 500; }
  .stat .foot { font-size: 18px; color: var(--dim); margin-top: 10px; }

  .code {
    font-family: var(--mono); font-size: 21px; line-height: 1.62;
    background: rgba(2,6,12,.72); border: 1px solid var(--border);
    border-radius: 16px; padding: 22px 26px; white-space: pre; overflow: hidden;
  }
  .code .ln { color: #3f4c5e; user-select: none; }
  .code .hl {
    display: block; margin: 0 -26px; padding: 0 26px;
    background: rgba(34,197,94,.10); border-left: 3px solid var(--accent);
  }

  .term {
    background: rgba(2,6,12,.86); border: 1px solid var(--border);
    border-radius: 16px; overflow: hidden; font-family: var(--mono);
  }
  .term .bar {
    display: flex; align-items: center; gap: 10px; padding: 14px 20px;
    background: rgba(255,255,255,.045); border-bottom: 1px solid var(--border);
  }
  .term .dot { width: 13px; height: 13px; border-radius: 50%; }
  .term .title { margin-left: 8px; font-size: 19px; color: var(--muted); font-family: var(--sans); }
  .term .body { padding: 22px 26px; font-size: 21px; line-height: 1.58; color: #cbd5e1; white-space: pre-wrap; }

  .shot { border-radius: 16px; overflow: hidden; border: 1px solid var(--border); background: #0a0f16; }
  .shot .chrome {
    display: flex; align-items: center; gap: 10px; padding: 12px 18px;
    background: rgba(255,255,255,.05); border-bottom: 1px solid var(--border);
  }
  .shot .url {
    margin-left: 10px; font-family: var(--mono); font-size: 17px; color: var(--dim);
    background: rgba(0,0,0,.35); padding: 5px 14px; border-radius: 999px;
    white-space: nowrap; overflow: hidden;
  }
  .shot .viewport { position: relative; overflow: hidden; }
  .shot img { display: block; transform-origin: top left; }

  .callout {
    position: absolute; display: flex; align-items: center; gap: 12px;
    background: rgba(6,12,20,.92); border: 1px solid rgba(34,197,94,.5);
    border-radius: 12px; padding: 12px 18px; font-size: 20px; font-weight: 600;
    color: #e2e8f0; box-shadow: 0 18px 50px rgba(0,0,0,.55); white-space: nowrap;
  }
  .callout .bullet { width: 11px; height: 11px; border-radius: 50%; background: var(--accent); }

  .table { width: 100%; border-collapse: collapse; font-size: 22px; }
  .table th {
    text-align: left; font-size: 17px; text-transform: uppercase; letter-spacing: .1em;
    color: var(--dim); font-weight: 600; padding: 0 18px 14px 0;
  }
  .table td { padding: 15px 18px 15px 0; border-top: 1px solid var(--border); color: var(--muted); }
  .table td:first-child { color: var(--ink); font-weight: 600; }

  .bar { height: 8px; border-radius: 999px; background: rgba(148,163,184,.16); overflow: hidden; }
  .bar > i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }

  .divider { height: 1px; background: linear-gradient(90deg, transparent, var(--border), transparent); }

  #captions {
    position: absolute; left: 0; right: 0; bottom: 0; height: 190px;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(to top, rgba(3,6,10,.96) 30%, rgba(3,6,10,.72) 62%, transparent);
    pointer-events: none;
  }
  .caption {
    max-width: 1520px; text-align: center; font-size: 33px; line-height: 1.38;
    font-weight: 500; color: #eef2f7; text-shadow: 0 2px 18px rgba(0,0,0,.8);
  }
  .caption b { color: var(--accent); font-weight: 700; }
  .caption code { font-family: var(--mono); font-size: 29px; color: #7ee787; }
`;

const sheet = el('style', { text: css });
document.head.append(sheet);

export { MONO };
