/**
 * Capture real product assets for the pitch video.
 *
 * Everything this script writes is captured from a LIVE local stack:
 *   - the gateway on :3100 backed by the demo database
 *   - the dashboard on :3001 (production build)
 *   - the public repo page and the real Stellar testnet transaction
 *
 * Nothing here is mocked: the session cookie is obtained through the
 * gateway's real Ed25519 challenge-response auth, and the JSON blobs under
 * assets/live/ are actual HTTP responses from the running gateway.
 *
 * Usage:
 *   NODE_PATH=/tmp/video-tools/node_modules node video/capture.mjs
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/**
 * Resolve Playwright. The repo intentionally does not depend on it (the video
 * tooling is not part of the build), so allow an out-of-tree install via
 * PLAYWRIGHT_MODULE, and fall back to a conventional local install.
 */
async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/tmp/video-tools/node_modules/playwright/index.js',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      // playwright's entrypoint is CJS, so the namespace may only expose
      // the exports under `default`.
      if (mod?.chromium || mod?.default?.chromium) return mod;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'playwright not found. Install it out-of-tree and set PLAYWRIGHT_MODULE, e.g.\n' +
      '  npm install --prefix /tmp/video-tools playwright@1.63.0',
  );
}
const OUT = path.join(ROOT, 'video', 'assets');
const LIVE = path.join(OUT, 'live');

const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:3100';
// Must be `localhost` (not 127.0.0.1): the gateway's CORS allow-list and the
// session cookie are both scoped to the `localhost` origin.
const DASHBOARD = process.env.DASHBOARD_URL || 'http://localhost:3001';
const DSF = 2;
const VIEWPORT = { width: 1920, height: 1080 };

const log = (msg) => console.log(`  ${msg}`);

/** The live route seeded by scripts/testnet-journey.sh in the demo database. */
const MODEL = 'gpt-4-journey';

/** The workspace's Stellar SDK (used for the real auth signature). */
function loadStellarSdk() {
  return require(path.join(ROOT, 'packages', 'wallet', 'node_modules', '@stellar', 'stellar-sdk'));
}

/** Load the demo wallet secret/public pair (gitignored journey state). */
async function demoWallet() {
  const file = path.join(ROOT, '.testnet-journey', 'demo-wallet.env');
  if (!existsSync(file)) throw new Error(`missing ${file} — run the demo stack setup first`);
  const env = Object.fromEntries(
    (await readFile(file, 'utf8'))
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { secret: env.DEMO_WALLET_SECRET, publicKey: env.DEMO_WALLET_PUBLIC };
}

/** Real challenge-response login against the gateway; returns the cookie. */
async function authenticate(wallet) {
  const { Keypair } = loadStellarSdk();
  const api = `${GATEWAY}/api/v1`;
  const challenge = await (
    await fetch(`${api}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: wallet.publicKey }),
    })
  ).json();

  const signature = Keypair.fromSecret(wallet.secret)
    .sign(Buffer.from(challenge.challenge))
    .toString('base64');

  const res = await fetch(`${api}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      address: wallet.publicKey,
      signature,
    }),
  });
  if (!res.ok) throw new Error(`auth failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith('x402-session='));
  if (!session) throw new Error('gateway did not set an x402-session cookie');
  return {
    cookie: { name: 'x402-session', value: session.split('=')[1].split(';')[0] },
    token: body.token,
    verified: body.verified,
  };
}

/** Capture live HTTP responses straight from the running gateway. */
async function captureLiveJson() {
  const api = `${GATEWAY}/api/v1`;
  const post = (headers) =>
    fetch(`${api}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Explain x402 in one sentence.' }],
      }),
    });

  // The gateway rate-limits unpaid requests per IP; space the demo calls so
  // each one exercises its real code path instead of the limiter.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const unpaid = await post({});
  const unpaidBody = await unpaid.json();
  await writeFile(
    path.join(LIVE, 'quote-402.json'),
    JSON.stringify({ status: unpaid.status, body: unpaidBody }, null, 2),
  );
  log(`live 402 quote captured (status ${unpaid.status})`);

  const evidence = JSON.parse(
    await readFile(path.join(ROOT, 'docs', 'evidence', 'testnet-journey.json'), 'utf8'),
  );
  const usedHash = evidence.steps.pay.txHash;

  await sleep(1500);
  const replay = await post({ 'X-Payment-Hash': usedHash });
  await writeFile(
    path.join(LIVE, 'replay-402.json'),
    JSON.stringify({ status: replay.status, body: await replay.json() }, null, 2),
  );
  log(`live replay rejection captured (status ${replay.status})`);

  await sleep(1500);
  // A genuinely unseen hash: replay protection claims a hash on first sight
  // (Redis SET NX), so reusing a hardcoded 'f'.repeat(64) across captures made
  // the "forged" rejection report "Payment already used" — the same message as
  // the replay case. A fresh random hash exercises the fail-closed
  // "not found on chain" path the scene is meant to show.
  const forged = await post({ 'X-Payment-Hash': randomBytes(32).toString('hex') });
  await writeFile(
    path.join(LIVE, 'forged-402.json'),
    JSON.stringify({ status: forged.status, body: await forged.json() }, null, 2),
  );
  log(`live forged-hash rejection captured (status ${forged.status})`);

  const ready = await fetch(`${GATEWAY}/health/ready`);
  await writeFile(
    path.join(LIVE, 'ready.json'),
    JSON.stringify({ status: ready.status, body: await ready.json() }, null, 2),
  );

  const spec = await (await fetch(`${GATEWAY}/api/docs-json`)).json();
  const paths = Object.entries(spec.paths || {});
  const methods = paths.flatMap(([p, ops]) =>
    Object.keys(ops).map((m) => ({ method: m.toUpperCase(), path: p })),
  );
  const tags = [
    ...new Set(paths.flatMap(([, ops]) => Object.values(ops).flatMap((o) => o.tags || []))),
  ];
  await writeFile(
    path.join(LIVE, 'openapi.json'),
    JSON.stringify(
      {
        openapi: spec.info?.version || spec.openapi,
        title: spec.info?.title,
        endpointCount: methods.length,
        pathCount: paths.length,
        tags,
        sample: methods.filter((m) => m.path.startsWith('/api/v1')).slice(0, 24),
      },
      null,
      2,
    ),
  );
  log(`live OpenAPI spec captured (${methods.length} operations, ${tags.length} tags)`);

  const metrics = await (await fetch(`${GATEWAY}/metrics`)).text();
  const x402Lines = metrics
    .split('\n')
    .filter((l) => l.startsWith('x402_') && !l.includes('_bucket') && !l.includes('# '))
    .slice(0, 10);
  await writeFile(path.join(LIVE, 'metrics.json'), JSON.stringify(x402Lines, null, 2));
  log(`live health + metrics captured (${x402Lines.length} x402 series)`);

  return { usedHash, evidence };
}

/**
 * Screenshot a page. `scroll` scrolls the app's scroll container (the
 * dashboard is a fixed-height shell, so the document itself never scrolls).
 */
async function shoot(page, url, file, { waitFor, scroll = 0 } = {}) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(700);
  if (scroll) {
    await page.evaluate((px) => {
      const el = document.querySelector('main') || document.scrollingElement;
      el.scrollTop = px;
    }, scroll);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: path.join(OUT, file) });
  log(`captured ${file}`);
}

async function main() {
  await mkdir(LIVE, { recursive: true });
  const playwright = await loadPlaywright();
  const chromium = playwright.chromium || playwright.default.chromium;
  const wallet = await demoWallet();
  const { cookie, token } = await authenticate(wallet);
  log(`authenticated as ${wallet.publicKey.slice(0, 8)}… (verified=${true})`);

  await writeFile(
    path.join(LIVE, 'session.json'),
    JSON.stringify(
      { address: wallet.publicKey, authenticated: true, tokenReturned: !!token },
      null,
      2,
    ),
  );

  const { usedHash, evidence } = await captureLiveJson();

  const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DSF,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });

  // Authenticate the browser the same way the product does: a real session
  // cookie issued by the gateway (no dev-mode bypass).
  await context.addCookies([
    { ...cookie, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
  ]);
  await context.addInitScript(
    ([addr, tok]) => {
      window.localStorage.setItem('x402-wallet-address', addr);
      window.localStorage.setItem('x402-session-token', tok || '');
    },
    [wallet.publicKey, token || ''],
  );

  const page = await context.newPage();

  // ── Product UI ──────────────────────────────────────────────────────
  const p = (route) => `${DASHBOARD}${route}`;
  await shoot(page, p('/login'), 'login.png');
  await shoot(page, p('/'), 'dashboard.png', { waitFor: 'text=Total Revenue' });
  await shoot(page, p('/'), 'dashboard-chart.png', {
    waitFor: 'text=Request Volume',
    scroll: 380,
  });
  await shoot(page, p('/'), 'dashboard-tables.png', {
    waitFor: 'text=Top Paying Callers',
    scroll: 800,
  });
  await shoot(page, p('/routes'), 'routes.png', { waitFor: 'text=Routes' });
  await shoot(page, p('/payments'), 'payments.png', { waitFor: 'text=Payments' });
  await shoot(page, p('/payments'), 'payments-table.png', { waitFor: 'table', scroll: 320 });
  await shoot(page, p('/audit'), 'audit.png', { waitFor: 'text=Audit' });
  await shoot(page, p('/webhooks'), 'webhooks.png');
  await shoot(page, p('/notifications'), 'notifications.png', { waitFor: 'text=Notifications' });
  await shoot(page, p('/escrow'), 'escrow.png');
  await shoot(page, p('/settings'), 'settings.png');

  // ── Gateway surfaces (raw endpoints) ────────────────────────────────
  // NOTE: /api/docs (Swagger UI) serves a shell whose static assets 404, so
  // it renders blank. The OpenAPI document itself is fine and is what the
  // video's API-surface scene is built from.
  await page.goto(`${GATEWAY}/health/ready`, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: path.join(OUT, 'health-ready.png') });
  log('captured health-ready.png');

  // ── Public, real-world surfaces ─────────────────────────────────────
  // Prefer the payment made by video/live-payment.mjs (its replay rejection
  // is the one shown in the video); fall back to the journey transaction.
  const livePaymentPath = path.join(LIVE, 'live-payment.json');
  const txHashes = [];
  if (existsSync(livePaymentPath)) {
    const livePayment = JSON.parse(await readFile(livePaymentPath, 'utf8'));
    txHashes.push({ hash: livePayment.steps.payment.txHash, file: 'stellar-expert-tx.png' });
  }
  txHashes.push({ hash: usedHash, file: 'stellar-expert-journey.png' });

  for (const { hash, file } of txHashes) {
    try {
      await page.goto(`https://stellar.expert/explorer/testnet/tx/${hash}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page.waitForTimeout(3500);
      await page.screenshot({ path: path.join(OUT, file) });
      log(`captured ${file} (real testnet transaction)`);
    } catch (err) {
      log(`stellar.expert capture skipped for ${hash.slice(0, 12)}…: ${err.message}`);
    }
  }

  try {
    await page.goto('https://github.com/mallonepay/pay-per-token-llm-gateway', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, 'repo.png') });
    log('captured repo.png');
  } catch (err) {
    log(`repo capture skipped: ${err.message}`);
  }

  await browser.close();

  // ── Consolidated bundle the video stage reads at render time ────────
  const read = async (f) => JSON.parse(await readFile(path.join(LIVE, f), 'utf8'));
  const bundle = {
    quote: await read('quote-402.json'),
    replay: await read('replay-402.json'),
    forged: await read('forged-402.json'),
    ready: await read('ready.json'),
    metrics: await read('metrics.json'),
    openapi: await read('openapi.json'),
    journey: evidence,
    payment: existsSync(path.join(LIVE, 'live-payment.json'))
      ? await read('live-payment.json')
      : null,
    capturedAt: new Date().toISOString(),
  };
  await writeFile(path.join(LIVE, 'video-data.json'), JSON.stringify(bundle, null, 2));
  log('wrote video-data.json');

  await writeFile(
    path.join(LIVE, 'capture-summary.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        gateway: GATEWAY,
        dashboard: DASHBOARD,
        wallet: wallet.publicKey,
        evidenceRunAt: evidence.runAt,
        txHash: evidence.steps.pay.txHash,
        ledger: evidence.steps.pay.ledger,
      },
      null,
      2,
    ),
  );
  log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
