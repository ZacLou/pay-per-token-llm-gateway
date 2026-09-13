/**
 * The pitch scenes.
 *
 * Each builder receives `(ctx)` where ctx carries the live captured data and
 * returns `{ node, update(t) }`; `t` is scene-local seconds. Nothing renders
 * on a wall clock, so every frame is reproducible.
 */

import {
  el,
  style,
  enter,
  seg,
  lerp,
  clamp01,
  easeOut,
  easeOutBack,
  asset,
  highlight,
} from './ui.js';

const GLYPH = {
  lock: 'M12 3a4 4 0 00-4 4v2H6v10h12V9h-2V7a4 4 0 00-4-4zm-2 6V7a2 2 0 114 0v2h-4z',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6l1-8z',
  repeat: 'M4 10a6 6 0 0110-4l2-2v6H10l2-2a4 4 0 100 8H8l-2 2v-6h6',
  clock: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5h-2v6l4 2 1-1.7-3-1.8V7z',
  shield: 'M12 2l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-4z',
  key: 'M14 2a6 6 0 00-5.6 8.2L2 16.6V22h6v-3h3v-3h2l1.4-1.4A6 6 0 1014 2zm2 4a1.5 1.5 0 110 3 1.5 1.5 0 010-3z',
  coin: 'M12 2C6.5 2 2 4.2 2 7v10c0 2.8 4.5 5 10 5s10-2.2 10-5V7c0-2.8-4.5-5-10-5zm0 2c4.5 0 8 1.6 8 3s-3.5 3-8 3-8-1.6-8-3 3.5-3 8-3z',
};

function icon(path, size = 26, color = 'var(--accent)') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  style(svg, { flex: '0 0 auto' });
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', color);
  svg.append(p);
  return svg;
}

/** Entrance registry + custom per-frame hooks. */
function stage() {
  const anims = [];
  const ticks = [];
  return {
    add(node, at, dur = 0.55, opts = {}) {
      anims.push({ node, at, dur, opts });
      return node;
    },
    tick(fn) {
      ticks.push(fn);
    },
    update(t) {
      for (const a of anims) style(a.node, enter(t, a.at, a.dur, a.opts));
      for (const fn of ticks) fn(t);
    },
  };
}

function header(kicker, title, s, at = 0.1) {
  const k = el('div', { class: 'kicker', text: kicker });
  const h = el('div', { class: 'h2', text: title });
  s.add(k, at, 0.5, { y: 18 });
  s.add(h, at + 0.12, 0.55, { y: 22 });
  return el('div', { style: { display: 'grid', gap: '16px', marginBottom: '34px' } }, [k, h]);
}

// ── 1. Cold open ────────────────────────────────────────────────────────────

function sceneOpen({ data }) {
  const s = stage();
  const logo = el('img', {
    src: '/apps/dashboard/public/icon.svg',
    width: 168,
    height: 168,
    style: { display: 'block' },
  });
  const word = el('div', {
    class: 'h1',
    text: 'x402 LLM Gateway',
    style: { fontSize: '104px' },
  });
  const sub = el('div', {
    class: 'lead',
    html: 'Pay-per-request access to any LLM, settled in <b style="color:#e2e8f0">USDC on Stellar</b>.',
    style: { fontSize: '32px', maxWidth: '1080px', textAlign: 'center' },
  });

  const chips = ['No API keys', 'No subscriptions', 'Single-use payments'].map((text, i) =>
    el('div', { class: i === 2 ? 'pill green' : 'pill', text }),
  );
  const chipRow = el('div', { style: { display: 'flex', gap: '14px', marginTop: '35px' } }, chips);

  const badge = el('div', {
    class: 'pill blue',
    text: `LIVE TESTNET · ledger ${data.payment?.steps.payment.ledger ?? data.journey.steps.pay.ledger}`,
    style: { marginBottom: '30px', letterSpacing: '.06em' },
  });

  const node = el(
    'div',
    {
      style: {
        position: 'absolute',
        inset: '0',
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        'justify-content': 'center',
        gap: '26px',
      },
    },
    [badge, logo, word, sub, chipRow],
  );

  // Watermark of the status code this whole product is built on.
  const watermark = el('div', {
    text: '402',
    style: {
      position: 'absolute',
      right: '-40px',
      top: '-160px',
      fontSize: '760px',
      fontWeight: '900',
      letterSpacing: '-0.06em',
      color: 'rgba(148,163,184,.045)',
      'pointer-events': 'none',
      'user-select': 'none',
    },
  });
  node.prepend(watermark);

  s.add(badge, 0.35, 0.6, { y: 16 });
  s.add(logo, 0.9, 0.85, { scale: 0.7, y: 26 });
  s.add(word, 1.5, 0.7, { y: 30 });
  s.add(sub, 2.3, 0.7, { y: 24 });
  chips.forEach((c, i) => s.add(c, 3.5 + i * 0.35, 0.6, { y: 20 }));

  s.tick((t) => {
    const p = seg(t, 0.9, 1.6);
    logo.style.filter = `drop-shadow(0 0 ${28 * (0.4 + 0.6 * p)}px rgba(34,197,94,.45))`;
    style(logo, {
      transform: `scale(${lerp(0.7, 1, easeOut(p))}) rotate(${lerp(-8, 0, easeOut(p))}deg)`,
    });
    style(watermark, { opacity: String(0.85 * easeOut(seg(t, 0.4, 1.4))) });
  });

  return { node, update: s.update };
}

// ── 2. The problem ──────────────────────────────────────────────────────────

function sceneProblem() {
  const s = stage();

  const pains = [
    {
      glyph: GLYPH.key,
      title: 'Signups gate the API',
      body: 'A key, an account and a quota stand between a caller and the first token. An autonomous agent cannot open a billing account.',
    },
    {
      glyph: GLYPH.clock,
      title: 'Subscriptions for bursty work',
      body: 'Traffic spikes, but the invoice does not. Teams commit to a monthly tier and pay for capacity they never use.',
    },
    {
      glyph: GLYPH.repeat,
      title: 'Billing built twice',
      body: 'Metering, invoicing, retries and dunning get re-implemented by every team that proxies a model.',
    },
  ];

  const cards = pains.map((p) => {
    const card = el('div', { class: 'card', style: { display: 'grid', gap: '14px' } }, [
      el(
        'div',
        {
          style: {
            width: '54px',
            height: '54px',
            'border-radius': '14px',
            background: 'rgba(239,68,68,.12)',
            border: '1px solid rgba(239,68,68,.28)',
            display: 'grid',
            'place-items': 'center',
          },
        },
        [icon(p.glyph, 26, '#f87171')],
      ),
      el('div', { class: 'h3', text: p.title }),
      el('div', { class: 'body', text: p.body, style: { fontSize: '21px' } }),
    ]);
    return card;
  });

  const footer = el(
    'div',
    {
      class: 'card tint',
      style: {
        'margin-top': '30px',
        display: 'flex',
        'align-items': 'center',
        gap: '18px',
        padding: '22px 30px',
      },
    },
    [
      icon(GLYPH.bolt, 26, '#fbbf24'),
      el('div', {
        html: '<b style="color:#e2e8f0">The result:</b> friction for callers, unpredictable cost for builders — and a payment rail nobody can automate.',
        style: { fontSize: '22px', color: 'var(--muted)' },
      }),
    ],
  );

  const grid = el(
    'div',
    { style: { display: 'grid', 'grid-template-columns': 'repeat(3,1fr)', gap: '26px' } },
    cards,
  );
  const node = el('div', {}, [
    header('The problem', 'AI access is gated by billing infrastructure', s),
    grid,
    footer,
  ]);

  cards.forEach((c, i) => s.add(c, 0.9 + i * 0.28, 0.6, { y: 32 }));
  s.add(footer, 2.6, 0.6, { y: 24 });

  return { node, update: s.update };
}

// ── 3. HTTP 402 ─────────────────────────────────────────────────────────────

function sceneProtocol({ data }) {
  const s = stage();
  const quote = data.quote.body.quote;

  const codeText = `POST /api/v1/chat/completions   HTTP/1.1

HTTP/1.1 402 Payment Required
{
  "quote": {
    "route":         "/v1/chat/completions",
    "pricingModel":  "flat",
    "amount":        "${quote.amount}",
    "asset":         "${quote.asset}",
    "assetIssuer":   "${quote.assetIssuer.slice(0, 10)}…",
    "paymentAddress":"${quote.paymentAddress.slice(0, 10)}…",
    "network":       "${quote.network}",
    "expiresAt":     ${quote.expiresAt}
  },
  "instructions": "Pay, then retry with X-Payment-Hash"
}`;

  const code = el('div', { class: 'code', style: { fontSize: '19px' } });
  code.append(highlight(codeText, 'json'));

  const notes = [
    ['Machine-payable', 'The price travels inside the response. A program can read it and pay it.'],
    ['Permissionless', 'Access is a wallet, not an identity. No signup, no approval.'],
    ['Per request', 'You pay for the calls you make — nothing else.'],
  ].map(([title, body]) =>
    el('div', { style: { display: 'grid', gap: '7px' } }, [
      el('div', { style: { 'font-size': '22px', 'font-weight': '700' }, text: title }),
      el('div', { class: 'body', text: body, style: { 'font-size': '19px' } }),
    ]),
  );

  const node = el('div', {}, [
    header('The protocol', '402 Payment Required, finally used', s),
    el('div', { style: { display: 'grid', 'grid-template-columns': '1.32fr 1fr', gap: '34px' } }, [
      code,
      el('div', { style: { display: 'grid', gap: '26px', 'align-content': 'start' } }, notes),
    ]),
  ]);

  s.add(code.parentElement.children[0], 0.7, 0.6, { y: 26 });
  s.add(code.parentElement.children[1], 0.95, 0.6, { y: 26 });

  // Reveal the exchange line by line, as it would appear on the wire.
  const sourceLines = codeText.split('\n');
  let shown = -1;
  s.tick((t) => {
    const visible = Math.floor(easeOut(seg(t, 1.0, 4.4)) * sourceLines.length);
    if (visible === shown) return;
    shown = visible;
    const text = sourceLines.map((l, i) => (i <= visible ? l : '')).join('\n');
    code.textContent = '';
    code.append(highlight(text, 'json'));
  });

  notes.forEach((n, i) => s.add(n, 5.4 + i * 0.4, 0.55, { y: 22 }));

  return { node, update: s.update };
}

// ── 4. How it works ─────────────────────────────────────────────────────────

function sceneFlow() {
  const s = stage();

  const nodes = [
    { label: 'Caller', hint: 'agent / app', glyph: GLYPH.bolt },
    { label: 'x402 Gateway', hint: 'NestJS proxy', glyph: GLYPH.shield },
    { label: 'Stellar', hint: 'Horizon + Soroban', glyph: GLYPH.coin },
    { label: 'Upstream LLM', hint: 'OpenAI-compatible', glyph: GLYPH.lock },
  ];

  const W = 300;
  const gap = 132;
  const diagramW = nodes.length * W + (nodes.length - 1) * gap;
  const diagram = el('div', {
    style: {
      position: 'relative',
      width: `${diagramW}px`,
      height: '150px',
      margin: '0 auto',
    },
  });

  const line = el('div', {
    style: {
      position: 'absolute',
      left: '150px',
      right: '150px',
      top: '49px',
      height: '2px',
      background: 'linear-gradient(90deg, rgba(34,197,94,.35), rgba(59,130,246,.35))',
    },
  });
  diagram.append(line);

  const packet = el('div', {
    style: {
      position: 'absolute',
      top: '43px',
      width: '14px',
      height: '14px',
      'border-radius': '50%',
      background: 'var(--accent)',
      'box-shadow': '0 0 22px 5px rgba(34,197,94,.6)',
    },
  });
  diagram.append(packet);

  nodes.forEach((n, i) => {
    const box = el(
      'div',
      {
        style: {
          position: 'absolute',
          left: `${i * (W + gap)}px`,
          top: '0',
          width: `${W}px`,
          display: 'grid',
          gap: '12px',
          'justify-items': 'center',
          'text-align': 'center',
        },
      },
      [
        el(
          'div',
          {
            style: {
              width: '74px',
              height: '74px',
              'border-radius': '20px',
              background: 'rgba(255,255,255,.045)',
              border: '1px solid var(--border)',
              display: 'grid',
              'place-items': 'center',
            },
          },
          [icon(n.glyph, 34)],
        ),
        el('div', { style: { 'font-size': '24px', 'font-weight': '700' }, text: n.label }),
        el('div', {
          style: { 'font-size': '18px', color: 'var(--dim)', 'font-family': 'var(--mono)' },
          text: n.hint,
        }),
      ],
    );
    diagram.append(box);
    s.add(box, 0.5 + i * 0.32, 0.6, { y: 26 });
  });

  const steps = [
    ['1', 'Request with no payment', '402 + quote (amount, asset, address, expiry)'],
    ['2', 'Pay USDC on Stellar', 'settled in ~5 seconds, hash returned to the client'],
    ['3', 'Verify on-chain', 'Horizon tx + Soroban replay guard'],
    ['4', 'Claim the hash atomically', 'Postgres + Redis + on-chain — single use'],
    ['5', 'Forward & meter', 'LLM response returned with a payment receipt'],
  ].map(([n, title, detail]) =>
    el(
      'div',
      {
        style: {
          display: 'grid',
          'grid-template-columns': '46px 300px 1fr',
          gap: '16px',
          'align-items': 'center',
          padding: '12px 20px',
          'border-radius': '12px',
          background: 'rgba(255,255,255,.028)',
          border: '1px solid var(--border)',
        },
      },
      [
        el('div', {
          text: n,
          style: {
            width: '32px',
            height: '32px',
            'border-radius': '10px',
            display: 'grid',
            'place-items': 'center',
            background: 'rgba(34,197,94,.14)',
            color: '#4ade80',
            'font-weight': '700',
            'font-size': '18px',
            'font-family': 'var(--mono)',
          },
        }),
        el('div', { style: { 'font-size': '21px', 'font-weight': '600' }, text: title }),
        el('div', {
          style: { 'font-size': '19px', color: 'var(--muted)', 'font-family': 'var(--mono)' },
          text: detail,
        }),
      ],
    ),
  );

  const node = el('div', {}, [
    header('How it works', 'One HTTP round trip, five steps', s),
    diagram,
    el('div', { style: { display: 'grid', gap: '11px', 'margin-top': '26px' } }, steps),
  ]);

  steps.forEach((st, i) => s.add(st, 2.2 + i * 0.5, 0.5, { y: 22, x: 18 }));

  s.tick((t) => {
    const cycle = 3.4;
    const p = ((t - 1.6) % cycle) / cycle;
    style(packet, {
      left: `${lerp(150, diagramW - 150, clamp01(p))}px`,
      opacity: t > 1.5 ? '1' : '0',
    });
  });

  return { node, update: s.update };
}

// ── 5. Live proof ───────────────────────────────────────────────────────────

function sceneLive({ data }) {
  const s = stage();
  // The live 402 capture carries the quote's issuer and destination; the
  // payment evidence carries the quote actually paid. Merge them so every
  // value on screen comes from a real response.
  const quote = {
    ...data.quote.body.quote,
    ...(data.payment?.steps.quote ?? data.journey.steps.quote.quote),
  };
  const pay = { ...data.journey.steps.pay, ...(data.payment?.steps.payment ?? {}) };
  const replay = (data.payment?.steps.replay.body.message ?? '').replace(
    'Payment verification failed: ',
    '',
  );
  const forged = (data.forged.body.message ?? '').replace('Payment verification failed: ', '');
  // The successful paid retry and its real receipt header (recorded by
  // video/live-payment.mjs). Absent on older captures — the scene then simply
  // omits the receipt line rather than inventing one.
  const paidRetry = data.payment?.steps.paidRetry ?? null;
  const receipt = paidRetry?.receipt ?? null;
  const trim = (v, head, tail) =>
    typeof v === 'string' && v.length > head + tail
      ? `${v.slice(0, head)}…${v.slice(-tail)}`
      : (v ?? '');
  const short = (h) => trim(h, 12, 8);

  // ── phase A: the live exchange, typed into a terminal
  const lines = [
    { text: '$ curl -s -X POST $GATEWAY/api/v1/chat/completions \\', cls: 'cmd' },
    { text: `      -d '{"model":"gpt-4-journey","messages":[…]}'`, cls: 'cmd' },
    { text: `→ HTTP 402  Payment Required`, cls: 'warn' },
    {
      text: `   quote.amount    ${quote.amount}  (${Number(quote.amount) / 1e7} USDC)`,
      cls: 'out',
    },
    { text: `   quote.asset     ${quote.asset} @ ${trim(quote.assetIssuer, 8, 4)}`, cls: 'out' },
    { text: `   quote.memo      ${quote.memo}`, cls: 'out' },
    { text: `   quote.expires   +300s window`, cls: 'out' },
    { text: '', cls: 'out' },
    { text: '$ # pay it on Stellar testnet', cls: 'cmd' },
    { text: `→ tx ${short(pay.txHash)}`, cls: 'ok' },
    {
      text: `   ledger ${Number(pay.ledger).toLocaleString('en-US')}   ·   0.1 USDC → provider wallet`,
      cls: 'ok',
    },
    { text: '', cls: 'out' },
    { text: `$ # retry with the payment hash`, cls: 'cmd' },
    {
      text: `→ HTTP ${paidRetry?.status ?? 200}  OK   ·   model response + payment receipt`,
      cls: 'ok',
    },
    ...(receipt
      ? [
          {
            text: `   receipt  ${short(receipt.quoteId)}   status ${receipt.status}`,
            cls: 'ok',
          },
        ]
      : []),
    { text: '', cls: 'out' },
    { text: `$ # replay the SAME transaction hash`, cls: 'cmd' },
    { text: `→ HTTP 402  "${replay}"`, cls: 'bad' },
    { text: '', cls: 'out' },
    { text: `$ # present a forged hash`, cls: 'cmd' },
    { text: `→ HTTP 402  "${forged}"`, cls: 'bad' },
  ];

  const termBody = el('div', {
    class: 'body',
    style: { padding: '20px 24px', 'font-size': '19px', 'line-height': '1.5' },
  });
  const term = el('div', { class: 'term' }, [
    el('div', { class: 'bar' }, [
      el('div', { class: 'dot', style: { background: '#ff5f57' } }),
      el('div', { class: 'dot', style: { background: '#febc2e' } }),
      el('div', { class: 'dot', style: { background: '#28c840' } }),
      el('div', {
        class: 'title',
        text: 'x402 live run — Stellar testnet',
      }),
    ]),
    termBody,
  ]);

  const termLineNodes = lines.map((l) => {
    const row = el('div', { text: l.text || ' ', style: { 'white-space': 'pre' } });
    if (l.cls === 'cmd') row.style.color = '#e2e8f0';
    if (l.cls === 'out') row.style.color = '#93a4b8';
    if (l.cls === 'warn') row.style.color = '#fcd34d';
    if (l.cls === 'ok') row.style.color = '#4ade80';
    if (l.cls === 'bad') row.style.color = '#fca5a5';
    termBody.append(row);
    return row;
  });

  // ── phase B: on-chain settlement panel
  const explorer = el('img', {
    src: asset('stellar-expert-tx.png'),
    style: { display: 'block', width: '100%' },
  });
  const explorerFrame = el('div', { class: 'shot' }, [
    el('div', { class: 'chrome' }, [
      el('div', {
        class: 'dot',
        style: { width: '12px', height: '12px', 'border-radius': '50%', background: '#ff5f57' },
      }),
      el('div', {
        class: 'dot',
        style: { width: '12px', height: '12px', 'border-radius': '50%', background: '#febc2e' },
      }),
      el('div', {
        class: 'dot',
        style: { width: '12px', height: '12px', 'border-radius': '50%', background: '#28c840' },
      }),
      el('div', {
        class: 'url',
        text: `stellar.expert/explorer/testnet/tx/${trim(pay.txHash, 16, 0)}`,
      }),
      el('div', {
        class: 'pill green',
        text: 'Successful',
        style: { 'margin-left': 'auto', 'font-size': '16px', padding: '5px 12px' },
      }),
    ]),
    el('div', { class: 'viewport', style: { height: '392px' } }, [explorer]),
  ]);

  const facts = [
    ['Transaction', short(pay.txHash)],
    ['Ledger', Number(pay.ledger).toLocaleString('en-US')],
    ['Settled', `${Number(quote.amount) / 1e7} USDC`],
    ['Provider wallet', trim(quote.paymentAddress, 8, 6)],
  ].map(([k, v]) =>
    el('div', { style: { display: 'grid', gap: '4px' } }, [
      el('div', {
        text: k,
        style: {
          'font-size': '16px',
          'text-transform': 'uppercase',
          'letter-spacing': '.1em',
          color: 'var(--dim)',
        },
      }),
      el('div', {
        text: v,
        style: { 'font-family': 'var(--mono)', 'font-size': '21px', color: '#e2e8f0' },
      }),
    ]),
  );

  const panelB = el('div', { style: { display: 'grid', gap: '26px' } }, [
    explorerFrame,
    el(
      'div',
      { style: { display: 'grid', 'grid-template-columns': 'repeat(2,1fr)', gap: '22px' } },
      facts,
    ),
  ]);

  const panelA = el('div', {}, [term]);

  // Fixed height: both panels are stacked in the same box and swapped, so the
  // header and nothing below ever shifts between phases.
  const wrap = el('div', { style: { position: 'relative', height: '632px' } });
  panelA.style.position = 'absolute';
  panelA.style.inset = '0';
  wrap.append(panelA, panelB);

  const node = el('div', {}, [
    header('Live on Stellar testnet', 'A real payment, verified end to end', s),
    wrap,
  ]);

  s.add(panelA, 0.6, 0.6, { y: 26 });

  // Phase switches: A (0-26s) → B (26-49s).
  const PHASE_B = 26;
  s.tick((t) => {
    const aOut = clamp01((t - PHASE_B) / 0.6);
    style(panelA, { opacity: String(1 - aOut), 'pointer-events': 'none' });
    const bIn = clamp01((t - PHASE_B) / 0.7);
    panelB.style.position = 'absolute';
    panelB.style.inset = '0';
    style(panelB, {
      opacity: String(bIn),
      transform: `translate3d(0, ${(1 - easeOut(bIn)) * 30}px, 0)`,
    });

    // Type the terminal out over the first ~22 seconds.
    const total = 21;
    lines.forEach((l, i) => {
      const at = 1.2 + (i / lines.length) * total;
      const p = clamp01((t - at) / 0.28);
      style(termLineNodes[i], { opacity: String(p) });
      if (p > 0 && p < 1) {
        termLineNodes[i].textContent = l.text.slice(0, Math.ceil(l.text.length * p)) + '▌';
      } else {
        termLineNodes[i].textContent = p >= 1 ? l.text || ' ' : '';
      }
    });

    // Ken Burns on the explorer screenshot.
    const kb = seg(t, PHASE_B + 0.6, 20);
    style(explorer, {
      transform: `scale(${lerp(1.06, 1.0, easeOut(kb))}) translate3d(0,${lerp(0, -6, easeOut(kb))}px,0)`,
    });
  });

  return { node, update: s.update };
}

// ── 6. Product tour ─────────────────────────────────────────────────────────

function sceneProduct() {
  const s = stage();

  const shots = [
    ['dashboard.png', 'Revenue, paid vs unpaid traffic, and latency', '/'],
    ['routes.png', 'Routes: upstream, model and pricing per endpoint', '/routes'],
    ['payments-table.png', 'Every payment, with its on-chain transaction hash', '/payments'],
    ['audit.png', 'Immutable audit trail of gateway operations', '/audit'],
    ['notifications.png', 'Persisted notification feed with read state', '/notifications'],
    ['webhooks.png', 'Signed webhook delivery, revalidated at send time', '/webhooks'],
    ['escrow.png', 'Prepaid credit balances held in escrow', '/escrow'],
    ['settings.png', 'Provider wallet, payout address and secrets', '/settings'],
  ];

  const PER = 5.4;
  const frames = shots.map(([file, caption, route]) => {
    const img = el('img', { src: asset(file), style: { display: 'block', width: '100%' } });
    const frame = el('div', { class: 'shot', style: { opacity: '0' } }, [
      el('div', { class: 'chrome' }, [
        el('div', {
          class: 'dot',
          style: { width: '12px', height: '12px', 'border-radius': '50%', background: '#ff5f57' },
        }),
        el('div', {
          class: 'dot',
          style: { width: '12px', height: '12px', 'border-radius': '50%', background: '#febc2e' },
        }),
        el('div', {
          class: 'dot',
          style: { width: '12px', height: '12px', 'border-radius': '50%', background: '#28c840' },
        }),
        el('div', { class: 'url', text: `x402-dashboard${route === '/' ? '' : route}` }),
        el('div', {
          class: 'pill green',
          text: 'wallet session',
          style: { 'margin-left': 'auto', 'font-size': '15px', padding: '5px 12px' },
        }),
      ]),
      el('div', { class: 'viewport', style: { height: '470px' } }, [img]),
    ]);
    return { frame, img, caption };
  });

  // A per-shot label lives inside the scene: the bottom caption track belongs
  // to the narration and must not be written by a scene.
  const label = el('div', {
    style: {
      'margin-top': '18px',
      'font-size': '24px',
      'font-weight': '600',
      color: '#e2e8f0',
      'text-align': 'center',
    },
  });

  const dots = el(
    'div',
    { style: { display: 'flex', gap: '9px', 'justify-content': 'center', 'margin-top': '16px' } },
    shots.map(() =>
      el('div', {
        style: {
          width: '26px',
          height: '5px',
          'border-radius': '3px',
          background: 'rgba(148,163,184,.25)',
        },
      }),
    ),
  );

  const node = el('div', {}, [
    header('The product', 'A provider dashboard, not just a proxy', s),
    // Fixed height — the frames are stacked absolutely and crossfade in place.
    el(
      'div',
      { style: { position: 'relative', height: '520px' } },
      frames.map((f) => f.frame),
    ),
    label,
    dots,
  ]);

  s.add(node.children[1], 0.6, 0.6, { y: 26 });

  let activeShot = -1;
  s.tick((t) => {
    const current = Math.max(0, Math.min(frames.length - 1, Math.floor((t - 1.1) / PER)));
    if (current !== activeShot) {
      activeShot = current;
      label.textContent = frames[current].caption;
    }
    label.style.opacity = String(easeOut(seg(t, 1.0, 0.5)));

    frames.forEach((f, i) => {
      const start = 1.1 + i * PER;
      const local = t - start;
      const visible = local > -0.6 && local < PER + 0.4;
      const inP = easeOut(seg(local, 0, 0.55));
      const outP = easeOut(seg(local, PER - 0.4, 0.6));
      const alpha = visible ? Math.min(inP, 1 - outP) : 0;
      f.frame.style.position = 'absolute';
      f.frame.style.inset = '0';
      style(f.frame, {
        opacity: String(alpha < 0 ? 0 : alpha),
        transform: `translate3d(${lerp(26, 0, inP)}px, 0, 0)`,
      });
      // Slow drift keeps stills from feeling static.
      style(f.img, {
        transform: `scale(${lerp(1.015, 1.075, clamp01(local / PER))}) translate3d(${lerp(-6, 6, clamp01(local / PER))}px, 0, 0)`,
      });
      if (dots.children[i]) {
        dots.children[i].style.background =
          local > 0 && local < PER ? 'var(--accent)' : 'rgba(148,163,184,.25)';
      }
    });
  });

  return { node, update: s.update };
}

// ── 7. Architecture & code ──────────────────────────────────────────────────

function sceneArchitecture({ data }) {
  const s = stage();

  const tree = `x402-llm-gateway/
├── apps/
│   ├── gateway/          NestJS reverse proxy
│   └── dashboard/        Next.js provider console
├── contracts/            Soroban (Rust)
│   ├── payment-verifier/ on-chain replay guard
│   ├── credit-escrow/    prepaid balances
│   └── multisig/         M-of-N provider payouts
├── packages/             15 shared workspace libs
│   ├── x402-core/        quote + verify + replay
│   ├── sdk/              client 402 → pay → retry
│   ├── wallet/           tx building + Horizon
│   └── database/         Prisma schema + migrations
└── infrastructure/       Docker, Kubernetes`;

  const rust = `pub fn record_payment(env: Env, tx_hash: String, ...) {
    extend_ttl(&env);
    let config = env.storage().instance().get(&CONFIG_KEY).unwrap();
    config.admin.require_auth();

    // Deduplication — O(1) lookup on a per-hash persistent entry
    let used_key = (USED_TX_KEY, tx_hash.clone());
    if env.storage().persistent().has(&used_key) {
        panic!("Payment already recorded (replay protection)");
    }
}`;

  const ts = `// The quote window is a security boundary — both ends of it.
const txTime = Date.parse(txData.created_at) / 1000;
if (quote.issuedAt && txTime < quote.issuedAt) {
  return { verified: false, failureReason:
    'Payment was made before the quote was issued' };
}
if (txTime > quote.expiresAt) {
  return { verified: false, failureReason:
    'Payment was made after quote expired' };
}`;

  const treeBlock = el('div', {
    class: 'code',
    style: { 'font-size': '17.5px', 'line-height': '1.46' },
  });
  treeBlock.append(highlight(tree, 'bash'));

  const codeColumn = (pillText, pillClass, code, lang) =>
    el('div', { style: { display: 'grid', gap: '12px', 'align-content': 'start' } }, [
      el('div', { class: `pill ${pillClass}`, text: pillText, style: { 'justify-self': 'start' } }),
      el('div', { class: 'code', style: { 'font-size': '16.5px', 'line-height': '1.55' } }, [
        (() => {
          const block = el('div');
          block.append(highlight(code, lang));
          return block;
        })(),
      ]),
    ]);

  const panelA = el('div', {}, [treeBlock]);
  const panelB = el(
    'div',
    { style: { display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '20px' } },
    [
      codeColumn('contracts/payment-verifier/src/lib.rs', 'amber', rust, 'rust'),
      codeColumn('packages/x402-core/src/index.ts', 'blue', ts, 'typescript'),
    ],
  );

  const wrap = el('div', { style: { position: 'relative', height: '470px' } }, [panelA, panelB]);
  panelA.style.position = 'absolute';
  panelA.style.inset = '0';
  panelB.style.position = 'absolute';
  panelB.style.inset = '0';

  const layers = el(
    'div',
    {
      style: {
        display: 'grid',
        'grid-template-columns': 'repeat(3,1fr)',
        gap: '12px',
        'margin-top': '20px',
      },
    },
    [
      ['Redis', 'SET NX claim, 1h TTL'],
      ['Postgres', 'unique index on txHash'],
      ['Soroban', 'permanent USED_TX entry'],
    ].map(([k, v]) =>
      el(
        'div',
        {
          class: 'pill',
          style: { display: 'grid', gap: '3px', 'justify-items': 'start', 'border-radius': '12px' },
        },
        [
          el('span', { text: k, style: { color: '#e2e8f0', 'font-weight': '700' } }),
          el('span', { text: v, style: { 'font-size': '17px', 'font-family': 'var(--mono)' } }),
        ],
      ),
    ),
  );

  const node = el('div', {}, [
    header('Under the hood', 'Replay protection, three layers deep', s),
    wrap,
    layers,
  ]);

  s.add(layers, 0.9, 0.6, { y: 22 });

  // Sequential swap (out, then in) — an overlapping crossfade of two dense
  // code panels reads as ghosting.
  const SWITCH = 20;
  s.tick((t) => {
    const outP = clamp01((t - (SWITCH - 0.4)) / 0.35);
    const inP = clamp01((t - (SWITCH + 0.2)) / 0.45);
    style(panelA, { opacity: String(1 - outP) });
    style(panelB, {
      opacity: String(inP),
      transform: `translate3d(0, ${(1 - easeOut(inP)) * 16}px, 0)`,
    });
  });

  return { node, update: s.update };
}

// ── 8. Why Stellar / differentiation ────────────────────────────────────────

function sceneWhy() {
  const s = stage();

  const rows = [
    ['Onboarding', 'Account + card', 'Account + contract', 'A wallet address'],
    ['Cost model', 'Tiered seats', 'Flat monthly', 'Per request'],
    ['Automatable', 'Barely', 'No', 'Yes — machine to machine'],
    ['Settlement', 'Invoiced monthly', 'Invoiced monthly', 'On-chain, ~5 seconds'],
  ];
  const cols = ['', 'API keys', 'Subscriptions', 'x402 Gateway'];

  const table = el('table', { class: 'table' }, [
    el('thead', {}, [
      el(
        'tr',
        {},
        cols.map((c, i) =>
          el('th', {
            text: c,
            style: i === 3 ? { color: 'var(--accent)', 'text-align': 'right' } : undefined,
          }),
        ),
      ),
    ]),
    el(
      'tbody',
      {},
      rows.map((r) =>
        el(
          'tr',
          {},
          r.map((cell, i) =>
            el('td', {
              text: cell,
              style:
                i === 3
                  ? { 'text-align': 'right', color: '#4ade80', 'font-weight': '600' }
                  : i === 0
                    ? { color: '#e2e8f0', 'font-weight': '600' }
                    : undefined,
            }),
          ),
        ),
      ),
    ),
  ]);

  const features = [
    ['~$0.00001', 'per transaction'],
    ['~5s', 'to finality'],
    ['USDC', 'native stablecoin'],
    ['O(1)', 'contract gas'],
  ].map(([value, label]) =>
    el(
      'div',
      {
        class: 'card',
        style: { display: 'grid', gap: '4px', padding: '20px 24px', 'text-align': 'center' },
      },
      [
        el('div', {
          text: value,
          style: { 'font-size': '34px', 'font-weight': '800', color: '#4ade80' },
        }),
        el('div', { text: label, style: { 'font-size': '18px', color: 'var(--muted)' } }),
      ],
    ),
  );

  const node = el('div', {}, [
    header('Differentiation', 'Why Stellar makes this possible', s),
    table,
    el(
      'div',
      {
        style: {
          display: 'grid',
          'grid-template-columns': 'repeat(4,1fr)',
          gap: '16px',
          'margin-top': '34px',
        },
      },
      features,
    ),
  ]);

  s.add(table, 0.8, 0.6, { y: 26 });
  features.forEach((f, i) => s.add(f, 8.6 + i * 0.35, 0.55, { y: 24, scale: 0.94 }));

  return { node, update: s.update };
}

// ── 9. Engineering quality ──────────────────────────────────────────────────

function sceneQuality({ data }) {
  const s = stage();

  const pipeline = [
    'lint',
    'unit tests',
    'e2e suite',
    'contract tests',
    'wasm size gate',
    'build',
    'gitleaks',
    'trivy',
    'osv-scanner',
    'zap baseline',
  ];
  const chips = pipeline.map((p) =>
    el('div', { class: 'pill', text: p, style: { 'font-size': '20px' } }),
  );
  const chipRow = el(
    'div',
    { style: { display: 'flex', 'flex-wrap': 'wrap', gap: '12px' } },
    chips,
  );

  const facts = [
    [`${data.openapi.endpointCount}`, 'documented API operations'],
    [`${data.openapi.tags.length}`, 'route groups'],
    ['3', 'Soroban contracts'],
    ['15', 'shared packages'],
    ['0', 'critical advisories'],
  ].map(([value, label]) =>
    el('div', { class: 'card', style: { display: 'grid', gap: '6px', padding: '22px 24px' } }, [
      el('div', {
        text: value,
        style: { 'font-size': '46px', 'font-weight': '800', 'letter-spacing': '-.03em' },
      }),
      el('div', { text: label, style: { 'font-size': '18px', color: 'var(--muted)' } }),
    ]),
  );

  const honesty = el(
    'div',
    {
      class: 'card',
      style: {
        display: 'flex',
        gap: '16px',
        'align-items': 'center',
        'margin-top': '26px',
        'border-color': 'rgba(245,158,11,.35)',
      },
    },
    [
      icon(GLYPH.shield, 26, '#fbbf24'),
      el('div', {
        html: 'Contracts are self-tested and live on Stellar testnet. <b style="color:#fcd34d">An independent audit is the go/no-go gate for mainnet.</b>',
        style: { 'font-size': '21px', color: 'var(--muted)' },
      }),
    ],
  );

  const node = el('div', {}, [
    header('Engineering', 'Built like infrastructure, shipped in the open', s),
    chipRow,
    el(
      'div',
      {
        style: {
          display: 'grid',
          'grid-template-columns': 'repeat(5,1fr)',
          gap: '16px',
          'margin-top': '30px',
        },
      },
      facts,
    ),
    honesty,
  ]);

  chips.forEach((c, i) => s.add(c, 0.5 + i * 0.12, 0.45, { y: 18, scale: 0.92 }));
  facts.forEach((f, i) => s.add(f, 2.0 + i * 0.24, 0.55, { y: 26 }));
  s.add(honesty, 4.2, 0.6, { y: 24 });

  return { node, update: s.update };
}

// ── 10. Close ───────────────────────────────────────────────────────────────

function sceneClose() {
  const s = stage();

  const logo = el('img', { src: '/apps/dashboard/public/icon.svg', width: 120, height: 120 });
  const title = el('div', { class: 'h1', text: 'Pay per request.', style: { fontSize: '82px' } });
  const title2 = el('div', {
    class: 'h1',
    text: 'Settle on Stellar.',
    style: {
      fontSize: '82px',
      background: 'linear-gradient(90deg,#4ade80,#60a5fa)',
      '-webkit-background-clip': 'text',
      color: 'transparent',
    },
  });

  const quickstart = `git clone https://github.com/mallonepay/pay-per-token-llm-gateway
pnpm install && pnpm nx run database:generate
pnpm dev:gateway        # → http://localhost:3000`;

  const code = el('div', {
    class: 'code',
    style: { 'font-size': '20px', 'text-align': 'left', 'max-width': '1000px' },
  });
  code.append(highlight(quickstart, 'bash'));

  const repo = el('div', {
    class: 'pill blue',
    text: 'github.com/mallonepay/pay-per-token-llm-gateway',
    style: { 'font-size': '21px' },
  });
  const license = el('div', { class: 'pill green', text: 'MIT licensed' });

  const node = el(
    'div',
    {
      style: {
        position: 'absolute',
        inset: '0',
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        'justify-content': 'center',
        gap: '22px',
      },
    },
    [
      logo,
      title,
      title2,
      code,
      el('div', { style: { display: 'flex', gap: '14px', 'margin-top': '8px' } }, [repo, license]),
    ],
  );

  s.add(logo, 0.3, 0.7, { scale: 0.8 });
  s.add(title, 0.9, 0.6, { y: 24 });
  s.add(title2, 1.35, 0.6, { y: 24 });
  s.add(code, 2.3, 0.6, { y: 22 });
  s.add(repo.parentElement, 3.5, 0.6, { y: 18 });

  return { node, update: s.update };
}

// ── registry ────────────────────────────────────────────────────────────────

export function buildScene(id, ctx) {
  switch (id) {
    case 'open':
      return sceneOpen(ctx);
    case 'problem':
      return sceneProblem(ctx);
    case 'protocol':
      return sceneProtocol(ctx);
    case 'flow':
      return sceneFlow(ctx);
    case 'live':
      return sceneLive(ctx);
    case 'product':
      return sceneProduct(ctx);
    case 'architecture':
      return sceneArchitecture(ctx);
    case 'why':
      return sceneWhy(ctx);
    case 'quality':
      return sceneQuality(ctx);
    case 'close':
      return sceneClose(ctx);
    default:
      throw new Error(`unknown scene: ${id}`);
  }
}
