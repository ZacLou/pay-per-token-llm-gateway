/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Dashboard E2E: prove the dashboard actually receives real data from a
 * running gateway.
 *
 * This drives the dashboard's OWN API client (`apps/dashboard/src/lib/api.ts`)
 * against a live gateway — not a hand-rolled `curl`. That matters: the client
 * is where the gateway URL is resolved and where the auth strategy lives, so
 * using it is what makes this a test of the dashboard rather than a test of
 * the gateway.
 *
 * Run via `scripts/dashboard-e2e.sh`, which boots Postgres, Redis and the
 * gateway and then invokes this file. Evidence is written to
 * docs/evidence/dashboard-e2e.json.
 *
 * Assertions:
 *   1. seed a provider + route (the dashboard's `useProvider()` reads these)
 *   2. authenticate the way the dashboard does, and store the session token
 *      via `setSessionToken` (the cross-origin fallback path)
 *   3. every dashboard page's data source returns REAL data, not an error and
 *      not an empty stub: providers, routes, analytics summary, payments,
 *      audit log, notifications
 *   4. a 402 request moves the analytics numbers, proving the figures the
 *      homepage renders are computed from live gateway activity
 *   5. the Escrow page's balance read reaches the gateway's escrow route — the
 *      page used a *relative* URL, which resolved against the dashboard's own
 *      origin and 404'd without ever reaching the gateway
 *   6. the write paths behind the dashboard's forms work end to end: provider
 *      save, route create/edit/delete, the webhook tester and notification
 *      read state — including the guards that must refuse an internal target
 */
import {
  setSessionToken,
  fetchProviders,
  fetchRoutes,
  fetchAnalyticsSummary,
  fetchEscrowBalance,
  fetchPayments,
  fetchAuditLogs,
  fetchNotifications,
  fetchUnreadNotificationCount,
  requestChallenge,
  verifyChallenge,
  createProvider,
  updateProvider,
  createRoute,
  updateRoute,
  deleteRoute,
  sendWebhookTest,
  markNotificationRead,
  markAllNotificationsRead,
} from '../apps/dashboard/src/lib/api';
import { prisma } from '@x402/database';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ── Config ────────────────────────────────────

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3200';
const EVIDENCE_PATH = process.env.EVIDENCE_PATH || 'docs/evidence/dashboard-e2e.json';

/** The wallet the dashboard signs in as (NEXT_PUBLIC_DEV_WALLET in dev mode). */
const WALLET = process.env.DEV_WALLET || 'GBW3LGL7QM7UV4UGIJXDJKI7POUFVKWVVTTYWLTNNUO4TZC6BQ4LQVXO';
/** Payout wallet must differ from the auth wallet by default (ALLOW_PAYOUT_EQUALS_AUTH_WALLET=false). */
const PAYOUT_WALLET = 'GAWYAHREFVENEFJDRZNT2YYKEUJDNLDEF3ZNSJIH3LLGKPR7KBALEH6A';
/**
 * A well-formed Stellar account for the escrow read. Deliberately not the
 * authenticated wallet: `/escrow/:address/balance` is permissionless, which is
 * why the page can show a balance before sign-in.
 */
const ESCROW_ADDRESS = 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL';
/**
 * A routable IP literal as the upstream host, so the route SSRF guard's DNS
 * lookup resolves without a query — this suite must not need DNS.
 */
const PUBLIC_UPSTREAM = 'https://93.184.216.34/v1/chat/completions';
/** A loopback target that the guards must refuse (numeric host: no DNS needed). */
const PRIVATE_TARGET = 'https://127.0.0.1:9/hook';

const evidence: Record<string, any> = {
  runAt: new Date().toISOString(),
  gatewayUrl: GATEWAY_URL,
  wallet: WALLET,
  steps: {},
};

let failures = 0;

function step(name: string, data: Record<string, any>) {
  evidence.steps[name] = data;
  console.log(`  ✓ ${name}`);
}

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`    ✅ ${name}`);
  } else {
    failures++;
    console.error(`    ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Steps ─────────────────────────────────────

async function seed(): Promise<{ providerId: string; routeId: string }> {
  const provider = await prisma.provider.upsert({
    where: { id: 'dashboard-e2e-provider' },
    create: {
      id: 'dashboard-e2e-provider',
      name: 'Dashboard E2E Provider',
      walletAddress: WALLET,
      payoutWalletAddress: PAYOUT_WALLET,
      active: true,
    },
    update: { walletAddress: WALLET, payoutWalletAddress: PAYOUT_WALLET, active: true },
  });

  const path = '/v1/chat/completions';
  const model = 'dashboard-e2e-model';
  // `flatPrice` is a decimal string in stroops, not a BigInt.
  const route = await prisma.route.upsert({
    where: { providerId_path_model: { providerId: provider.id, path, model } },
    create: {
      providerId: provider.id,
      path,
      model,
      upstreamUrl: 'https://httpbin.org/post',
      pricingModel: 'flat',
      flatPrice: '1000000',
      acceptedAssets: ['USDC'],
      rateLimit: 1000,
      active: true,
    },
    update: { flatPrice: '1000000', active: true },
  });

  step('seed', { providerId: provider.id, routeId: route.id, model });
  return { providerId: provider.id, routeId: route.id };
}

async function authenticate(): Promise<string> {
  const { challengeId, challenge } = await requestChallenge(WALLET);
  const signature = Buffer.from(`dev-sig-${WALLET}-${Date.now()}`, 'utf-8').toString('base64');
  const result = await verifyChallenge(challengeId, WALLET, signature);

  check('gateway accepted the dashboard auth flow', result.verified === true);
  check(
    'gateway returned a session token',
    typeof result.token === 'string' && result.token.length > 0,
  );

  // Exactly what the dashboard does on a cross-origin deployment.
  setSessionToken(result.token as string);
  step('auth', {
    verified: result.verified,
    address: result.address,
    challengeLength: challenge.length,
  });
  return result.token as string;
}

async function assertDashboardReceivesData(providerId: string) {
  // ── Configuration, which exists before any traffic ──────────

  // Providers — the dashboard's `useProvider()` hook, which every page needs.
  const providers = await fetchProviders();
  const mine = providers.find((p) => p.id === providerId);
  check(
    'GET /providers returned the seeded provider',
    !!mine,
    `got ${providers.length} provider(s)`,
  );
  check('provider carries a real wallet address', mine?.walletAddress === WALLET);
  step('providers', { count: providers.length, first: mine?.name ?? null });

  // Routes — the Routes page.
  const routes = await fetchRoutes(providerId);
  check('GET /routes returned the seeded route', routes.length > 0);
  const route = routes[0];
  check('route has real pricing', route?.flatPrice === '1000000', `flatPrice=${route?.flatPrice}`);
  step('routes', { count: routes.length, path: route?.path ?? null, model: route?.model ?? null });

  // ── Generate real gateway activity ──────────────────────────
  //
  // Everything the Payments / Audit / Analytics pages render is derived from
  // this. Firing it before those reads is what turns "the endpoint returned a
  // paginated envelope" into "the page has rows to show".
  const baseline = await fetchAnalyticsSummary(providerId);
  const model = route?.model ?? 'dashboard-e2e-model';
  const unpaid = await fetch(`${GATEWAY_URL}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'dashboard e2e' }] }),
  });
  check('unpaid request returned HTTP 402', unpaid.status === 402, `got ${unpaid.status}`);

  // These writes are awaited by the proxy before it responds, but a small
  // margin keeps the check from being flaky against a loaded database.
  await new Promise((r) => setTimeout(r, 750));

  // ── Data that only exists because of the request ────────────

  // Payments — the Payments page. A quote creates a pending Payment row.
  const payments = await fetchPayments({ providerId, limit: 10 });
  check(
    'GET /payments returned rows, not an empty placeholder',
    payments.total >= 1,
    `total=${payments.total}`,
  );
  check('payment row carries a real status', typeof payments.data[0]?.status === 'string');
  step('payments', {
    total: payments.total,
    returned: payments.data.length,
    status: payments.data[0]?.status,
  });

  // Audit log — the Audit page. A quote writes a `quote_generated` entry.
  const audit = await fetchAuditLogs({ limit: 10 });
  check('GET /admin/audit returned rows', audit.total >= 1, `total=${audit.total}`);
  check('audit rows have a real action', typeof audit.data[0]?.action === 'string');
  step('auditLogs', {
    total: audit.total,
    returned: audit.data.length,
    action: audit.data[0]?.action,
  });

  // Notifications — the Notifications page. An unpaid 402 need not notify, so
  // only the envelope is asserted; asserting rows here would be dishonest.
  const notifications = await fetchNotifications({ providerId, limit: 10 });
  check(
    'GET /notifications returned a paginated envelope',
    typeof notifications.total === 'number',
  );
  const unread = await fetchUnreadNotificationCount();
  check('GET /notifications/unread-count returned a number', typeof unread.unread === 'number');
  step('notifications', { total: notifications.total, unread: unread.unread });

  // Analytics — the homepage metrics, the ones that rendered "..." forever.
  const after = await fetchAnalyticsSummary(providerId);
  check(
    'GET /analytics/summary returned numeric metrics (not placeholders)',
    typeof after.totalRequests === 'number' &&
      typeof after.paidRequests === 'number' &&
      typeof after.successRate === 'number' &&
      typeof after.averageResponseTime === 'number',
  );
  check(
    'the unpaid request moved the analytics counters',
    after.unpaidRequests > baseline.unpaidRequests,
    `before=${baseline.unpaidRequests} after=${after.unpaidRequests}`,
  );
  check(
    'totalRequests is the sum of paid + unpaid',
    after.totalRequests === after.paidRequests + after.unpaidRequests,
    `${after.totalRequests} != ${after.paidRequests} + ${after.unpaidRequests}`,
  );
  step('analytics', {
    before: { totalRequests: baseline.totalRequests, unpaidRequests: baseline.unpaidRequests },
    after: {
      totalRequests: after.totalRequests,
      paidRequests: after.paidRequests,
      unpaidRequests: after.unpaidRequests,
      totalRevenue: after.totalRevenue,
      successRate: after.successRate,
      averageResponseTime: after.averageResponseTime,
    },
  });
}

/**
 * The Escrow page reads a balance through the dashboard's own API client. This
 * check exists because that call was made with a *relative* URL
 * (`/api/v1/escrow/...`), which resolves against the dashboard's own origin —
 * an origin that serves no API routes — so it 404'd without ever reaching the
 * gateway and the page could only ever show an error.
 *
 * The gateway's escrow route reads the contract over Soroban RPC, which this
 * suite deliberately points at a closed port (see the `env -i` block in
 * scripts/dashboard-e2e.sh), so the route answers deterministically instead of
 * waiting on a real RPC. Either outcome is fine:
 *
 *   - `200` with a `balance` string, when the contract is readable
 *   - `502`/`503` with the route's own `{ status, error }` envelope, when the
 *     contract cannot be read or is not configured
 *
 * What must never happen is a `404` (the request resolved against the wrong
 * origin) or a client-side timeout (it never arrived).
 */
async function assertEscrowReachesGateway() {
  let status = 200;
  let body: Record<string, any> = {};

  try {
    body = (await fetchEscrowBalance(ESCROW_ADDRESS)) as unknown as Record<string, any>;
  } catch (err) {
    const message = (err as Error).message;
    const gatewayError = /^Gateway error (\d+): ([\s\S]*)$/.exec(message);

    if (!gatewayError) {
      // A timeout or a transport failure: the request never reached the
      // gateway, which is the failure mode the relative URL produced too.
      check('escrow balance request reached the gateway', false, message);
      step('escrow', { reached: false, error: message });
      return;
    }

    status = Number(gatewayError[1]);
    try {
      body = JSON.parse(gatewayError[2]);
    } catch {
      body = {};
    }
  }

  const fromEscrowRoute =
    (status === 200 && typeof body.balance === 'string') ||
    ((status === 502 || status === 503) && /escrow/i.test(String(body.error ?? '')));

  check(
    'escrow balance request was answered by the gateway',
    status !== 404,
    `HTTP ${status}${body.error ? ` — ${body.error}` : ''}`,
  );
  check(`escrow route handled the request (HTTP ${status})`, fromEscrowRoute, JSON.stringify(body));
  step('escrow', {
    status,
    balance: body.balance ?? null,
    asset: body.asset ?? null,
    contractId: body.contractId ?? null,
    error: body.error ?? null,
    // Without this note the committed evidence reads as if the contract read
    // were broken: a 502 here means "the escrow route answered", nothing more.
    note: 'Soroban RPC points at a closed port in this harness by design',
  });
}

/**
 * Run a dashboard call and return the gateway's own error envelope when it
 * rejects. `request()` in lib/api.ts surfaces a non-2xx response as
 * `Gateway error <status>: <raw body>`, which is what lets a caller assert
 * *where* the answer came from — the gateway's JSON envelope, or something
 * else entirely (another origin, a transport failure).
 */
async function gatewayErrorEnvelope(
  fn: () => Promise<unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  try {
    await fn();
    return { status: 200, body: {} };
  } catch (err) {
    const message = (err as Error).message;
    const match = /^Gateway error (\d+): ([\s\S]*)$/.exec(message);
    if (!match) return { status: 0, body: { transport: message } };
    try {
      return { status: Number(match[1]), body: JSON.parse(match[2]) };
    } catch {
      return { status: Number(match[1]), body: { raw: match[2] } };
    }
  }
}

/**
 * The write paths behind the dashboard's forms: Settings (provider save),
 * Routes (create → edit → delete), the webhook tester and notification read
 * state. Everything above is read-only; these are the calls that change state,
 * and the UI's only feedback for most of them is whether the mutation settles.
 *
 * Three constraints shape what can be asserted deterministically:
 *
 *  - The upstream/webhook guards resolve the hostname and refuse private
 *    addresses. Every URL here is therefore either an IP literal (resolves with
 *    no DNS, so this suite stays offline) or a loopback target that must be
 *    *refused*. A webhook that actually delivers needs a real external
 *    receiver; asserting the gateway's refusal is the honest check, and it is
 *    the same delivery gap the README records.
 *  - `POST /routes` requires a uuid `providerId` and the seeded provider's id is
 *    a human-readable slug, so this step creates its own provider through the
 *    API — which also covers the Settings page's create path.
 *  - Deletes return `204 No Content`, the response shape the dashboard client
 *    is most likely to mishandle.
 */
async function assertDashboardWritesReachGateway() {
  // ── Provider save (Settings) ────────────────────────────────
  const created = await createProvider({ name: 'E2E Write Provider' });
  check(
    'POST /providers created a provider owned by the signed-in wallet',
    created.walletAddress === WALLET,
    `walletAddress=${created.walletAddress}`,
  );

  const saved = await updateProvider(created.id, { name: 'E2E Write Provider (saved)' });
  check('PUT /providers/:id returned the saved name', saved.name === 'E2E Write Provider (saved)');
  check(
    'the dashboard reads the saved name back',
    (await fetchProviders()).find((p) => p.id === created.id)?.name ===
      'E2E Write Provider (saved)',
  );
  step('providerSave', { id: created.id, name: saved.name });

  // A provider's webhook URL goes through the same SSRF guard as the webhook
  // tester below. Refusing must also mean not persisting.
  const providerGuard = await gatewayErrorEnvelope(() =>
    updateProvider(created.id, { webhookUrl: PRIVATE_TARGET }),
  );
  check(
    'PUT /providers/:id refuses a webhook URL pointing at internal infrastructure',
    providerGuard.status === 400 && /public IP/i.test(String(providerGuard.body.message ?? '')),
    JSON.stringify(providerGuard),
  );
  check(
    'the refused webhook URL was not persisted',
    !(await fetchProviders()).find((p) => p.id === created.id)?.webhookUrl,
  );
  step('providerWebhookGuard', {
    status: providerGuard.status,
    error: providerGuard.body.message ?? null,
  });

  // ── Route CRUD (Routes) ─────────────────────────────────────
  const route = await createRoute({
    providerId: created.id,
    path: '/v1/chat/completions',
    upstreamUrl: PUBLIC_UPSTREAM,
    model: 'e2e-write-model',
    pricingModel: 'flat',
    flatPrice: '250000',
    acceptedAssets: ['USDC'],
  });
  check('POST /routes returned a route id', typeof route.id === 'string' && route.id.length > 0);
  check(
    'GET /routes lists the created route at the submitted price',
    (await fetchRoutes(created.id)).some((r) => r.id === route.id && r.flatPrice === '250000'),
  );

  const edited = await updateRoute(route.id, { flatPrice: '500000' });
  check('PUT /routes/:id returned the new price', edited.flatPrice === '500000');
  check(
    'the dashboard reads the edited price back',
    (await fetchRoutes(created.id)).find((r) => r.id === route.id)?.flatPrice === '500000',
  );

  await deleteRoute(route.id);
  check(
    'DELETE /routes/:id removed the route from the list',
    !(await fetchRoutes(created.id)).some((r) => r.id === route.id),
  );
  step('routeCrud', {
    id: route.id,
    createdPrice: '250000',
    editedPrice: edited.flatPrice,
    deleted: true,
  });

  // ── Webhook tester (Webhooks) ───────────────────────────────
  const webhookGuard = await gatewayErrorEnvelope(() => sendWebhookTest(PRIVATE_TARGET));
  check(
    'POST /webhooks/test was answered by the gateway',
    webhookGuard.status !== 0 && webhookGuard.status !== 404,
    `HTTP ${webhookGuard.status}`,
  );
  check(
    'POST /webhooks/test refuses an internal target',
    webhookGuard.status === 400 &&
      /public IP/i.test(String(webhookGuard.body.message ?? webhookGuard.body.raw ?? '')),
    JSON.stringify(webhookGuard),
  );
  step('webhookTest', {
    status: webhookGuard.status,
    error: webhookGuard.body.message ?? null,
    note: 'a real delivery needs a public receiver; the guard refuses loopback by design, so this asserts the refusal',
  });

  // ── Notification read state (Notifications) ─────────────────
  // Written straight to Postgres: an unpaid 402 need not notify, and this
  // step is about the dashboard's read-state calls, not about notification
  // generation. The row is scoped to the provider created above, which the
  // signed-in wallet owns, so the gateway's ownership checks apply.
  const notification = await prisma.notification.create({
    data: {
      providerId: created.id,
      event: 'payment_received',
      channel: 'in_app',
      payload: { source: 'dashboard-e2e' },
    },
  });

  const unreadBefore = (await fetchUnreadNotificationCount()).unread;
  const marked = await markNotificationRead(notification.id);
  const unreadAfter = (await fetchUnreadNotificationCount()).unread;
  check('POST /notifications/:id/read marked the row read', marked.read === true);
  check(
    'the unread badge decreased by one',
    unreadAfter === unreadBefore - 1,
    `${unreadBefore} -> ${unreadAfter}`,
  );
  check(
    'the notification is gone from the unread filter',
    !(await fetchNotifications({ providerId: created.id, unreadOnly: true })).data.some(
      (n) => n.id === notification.id,
    ),
  );

  // A second row, so `read-all` has something to update.
  await prisma.notification.create({
    data: {
      providerId: created.id,
      event: 'payment_received',
      channel: 'in_app',
      payload: { source: 'dashboard-e2e' },
    },
  });
  const { updated } = await markAllNotificationsRead(created.id);
  check('POST /notifications/read-all reported an update', updated >= 1, `updated=${updated}`);
  check(
    'no unread notifications remain for the provider',
    (await fetchNotifications({ providerId: created.id, unreadOnly: true })).data.length === 0,
  );
  step('notificationReadState', {
    id: notification.id,
    unreadBefore,
    unreadAfter,
    markedAll: updated,
  });
}

async function main() {
  console.log(`\nDashboard → gateway data check against ${GATEWAY_URL}\n`);
  const { providerId } = await seed();
  await authenticate();
  await assertDashboardReceivesData(providerId);
  await assertEscrowReachesGateway();
  await assertDashboardWritesReachGateway();

  evidence.passed = failures === 0;
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(`\n📄 Evidence written to ${EVIDENCE_PATH}`);
  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) failed\n`);
    process.exit(1);
  }
  console.log('\n✅ Dashboard receives real data from the gateway\n');
}

main()
  .catch((err) => {
    console.error('\n❌ Dashboard E2E failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
