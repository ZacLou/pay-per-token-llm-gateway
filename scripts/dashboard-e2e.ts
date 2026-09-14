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
 */
import {
  setSessionToken,
  fetchProviders,
  fetchRoutes,
  fetchAnalyticsSummary,
  fetchPayments,
  fetchAuditLogs,
  fetchNotifications,
  fetchUnreadNotificationCount,
  requestChallenge,
  verifyChallenge,
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

async function main() {
  console.log(`\nDashboard → gateway data check against ${GATEWAY_URL}\n`);
  const { providerId } = await seed();
  await authenticate();
  await assertDashboardReceivesData(providerId);

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
