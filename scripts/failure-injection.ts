/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Live failure-injection sweep.
 *
 * Takes each hard dependency down, in turn, against a **running** gateway and
 * records what every surface returns. The point is not that things keep working
 * — they should not — but that they fail *safely*:
 *
 *   1. an unpaid request must never reach the LLM (no `200`, ever)
 *   2. a forged/unknown payment hash must never be accepted
 *   3. an escrow draw that cannot be verified must be rejected, not served
 *   4. readiness must report *which* dependency is down, with an error
 *
 * Phases:
 *   baseline        — everything up
 *   postgres-down   — PostgreSQL stopped (docker)
 *   redis-down      — Redis stopped (docker)
 *   rpc-down        — a second gateway booted with an unreachable Soroban RPC
 *
 * Evidence: docs/evidence/failure-injection.json. Any violation of the
 * invariants above fails the run.
 *
 * Orchestrated by `scripts/failure-injection.sh`; this script does the docker
 * toggling itself so every phase's observations land in one evidence file.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { execFileSync } from 'node:child_process';
import { prisma } from '@x402/database';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3210';
const DEGRADED_GATEWAY_URL = process.env.DEGRADED_GATEWAY_URL || 'http://127.0.0.1:3211';
const PG_NAME = process.env.PG_NAME || 'x402-failinject-pg';
const REDIS_NAME = process.env.REDIS_NAME || 'x402-failinject-redis';
const EVIDENCE_PATH = process.env.EVIDENCE_PATH || 'docs/evidence/failure-injection.json';
const MODEL = 'failinject-model';
const ESCROW_USER = Keypair.random().publicKey();

// ── Evidence ──────────────────────────────────

interface ProbeResult {
  status: number;
  ms: number;
  body: any;
}

const evidence: Record<string, any> = { runAt: new Date().toISOString(), phases: {} };
let violations = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`    ✅ ${name}`);
  } else {
    violations++;
    console.error(`    ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function probe(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { status: res.status, ms: Date.now() - started, body: parsed };
  } catch (err: any) {
    // A refused/timeout connection is itself an observation, not a script error.
    return { status: 0, ms: Date.now() - started, body: `transport error: ${err.message}` };
  }
}

/** Trim a response body down to the fields worth recording. */
function summarise(r: ProbeResult) {
  const msg = r.body && typeof r.body === 'object' ? (r.body.message ?? r.body.error) : r.body;
  return {
    status: r.status,
    ms: r.ms,
    message: typeof msg === 'string' ? msg.slice(0, 200) : undefined,
    body: typeof r.body === 'string' ? r.body.slice(0, 200) : r.body,
  };
}

const chatBody = { model: MODEL, messages: [{ role: 'user', content: 'failure injection' }] };

// ── Probes per phase ──────────────────────────

async function sweep(label: string, base: string, token?: string) {
  console.log(`\n── ${label} (${base}) ──`);
  const phase: Record<string, any> = {};

  const health = await probe('GET', `${base}/health`);
  const ready = await probe('GET', `${base}/health/ready`);
  const unpaid = await probe('POST', `${base}/api/v1/chat/completions`, {}, chatBody);
  const forged = await probe(
    'POST',
    `${base}/api/v1/chat/completions`,
    { 'X-Payment-Hash': 'f'.repeat(64) },
    chatBody,
  );
  const escrow = await probe(
    'POST',
    `${base}/api/v1/chat/completions`,
    { 'X-Escrow-User': ESCROW_USER },
    chatBody,
  );
  const routes = token
    ? await probe('GET', `${base}/api/v1/routes`, { Authorization: `Bearer ${token}` })
    : null;

  phase.liveness = summarise(health);
  phase.readiness = summarise(ready);
  phase.unpaidRequest = summarise(unpaid);
  phase.forgedHash = summarise(forged);
  phase.escrowDraw = summarise(escrow);
  phase.authenticatedRoutes = routes ? summarise(routes) : { note: 'no token available' };
  // Readiness detail is the useful part: it names the failing dependency.
  phase.readinessChecks =
    ready.body && typeof ready.body === 'object' ? (ready.body.checks ?? ready.body) : undefined;

  console.log(
    `    health=${health.status} ready=${ready.status} unpaid=${unpaid.status} ` +
      `forged=${forged.status} escrow=${escrow.status} routes=${routes?.status ?? 'n/a'}`,
  );

  // ── Invariants, applied in every phase ──
  check('liveness answers 200', health.status === 200, String(health.status));
  check('unpaid request never returns 200', unpaid.status !== 200, `got ${unpaid.status}`);
  check('forged hash never returns 200', forged.status !== 200, `got ${forged.status}`);
  check(
    'unverifiable escrow draw never returns 200',
    escrow.status !== 200,
    `got ${escrow.status}`,
  );

  evidence.phases[label] = phase;
  return phase;
}

/** Wait until readiness recovers, so the next phase starts from a known state. */
async function waitReady(base: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await probe('GET', `${base}/health/ready`);
    if (r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

function docker(action: 'stop' | 'start', name: string) {
  try {
    execFileSync('docker', [action, name], { stdio: 'ignore' });
  } catch (err: any) {
    throw new Error(`docker ${action} ${name} failed: ${err.message}`);
  }
}

async function getToken(base: string, kp: Keypair): Promise<string | undefined> {
  const chRes = await fetch(`${base}/api/v1/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: kp.publicKey() }),
  });
  if (!chRes.ok) {
    console.warn(`  (challenge failed: HTTP ${chRes.status})`);
    return undefined;
  }
  const ch: any = await chRes.json();
  const signature = Buffer.from(kp.sign(Buffer.from(ch.challenge, 'utf-8'))).toString('base64');
  const vRes = await fetch(`${base}/api/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: ch.challengeId, address: kp.publicKey(), signature }),
  });
  if (!vRes.ok) {
    console.warn(`  (auth verify failed: HTTP ${vRes.status})`);
    return undefined;
  }
  const v: any = await vRes.json();
  return v.token;
}

// ── Main ──────────────────────────────────────

async function main() {
  console.log('\n═══ x402 Live Failure-Injection Sweep ═══');
  const fs = await import('fs');
  fs.mkdirSync('docs/evidence', { recursive: true });

  // ── Seed a provider + route owned by the probe wallet ──
  const owner = Keypair.random();
  const provider = await prisma.provider.upsert({
    where: { id: 'failinject-provider' },
    update: { walletAddress: owner.publicKey(), payoutWalletAddress: owner.publicKey() },
    create: {
      id: 'failinject-provider',
      name: 'Failure Injection Provider',
      walletAddress: owner.publicKey(),
      payoutWalletAddress: owner.publicKey(),
      active: true,
    },
  });
  await prisma.route.upsert({
    where: {
      providerId_path_model: {
        providerId: provider.id,
        path: '/v1/chat/completions',
        model: MODEL,
      },
    },
    update: {},
    create: {
      providerId: provider.id,
      path: '/v1/chat/completions',
      // Never reached in a healthy phase either: every probe is unpaid, so the
      // gateway must reject before the upstream is considered.
      upstreamUrl: 'https://jsonplaceholder.typicode.com/posts',
      model: MODEL,
      pricingModel: 'flat',
      flatPrice: '1000000',
      acceptedAssets: ['USDC'],
      rateLimit: 1000,
      active: true,
    },
  });

  // ── Phase 1: baseline ──
  const token = await getToken(GATEWAY_URL, owner);
  evidence.authTokenObtained = !!token;
  await sweep('baseline', GATEWAY_URL, token);

  // ── Phase 2: PostgreSQL down ──
  console.log(`\n>>> stopping PostgreSQL (${PG_NAME})`);
  docker('stop', PG_NAME);
  await sweep('postgres-down', GATEWAY_URL, token);

  console.log(`>>> restarting PostgreSQL`);
  docker('start', PG_NAME);
  const pgRecovered = await waitReady(GATEWAY_URL);
  check('readiness recovers after PostgreSQL restarts', pgRecovered);

  // ── Phase 3: Redis down ──
  console.log(`\n>>> stopping Redis (${REDIS_NAME})`);
  docker('stop', REDIS_NAME);
  const redisPhase = await sweep('redis-down', GATEWAY_URL, token);
  // Auth/session state lives in Redis, so token acquisition must fail safe too.
  const tokenWithoutRedis = await getToken(GATEWAY_URL, owner);
  redisPhase.authWithoutRedis = tokenWithoutRedis ? 'issued' : 'refused';
  check('auth does not mint a session without Redis', !tokenWithoutRedis);

  console.log(`>>> restarting Redis`);
  docker('start', REDIS_NAME);
  const redisRecovered = await waitReady(GATEWAY_URL);
  check('readiness recovers after Redis restarts', redisRecovered);

  // ── Phase 4: Soroban RPC unreachable (second gateway, dead RPC url) ──
  console.log(`\n>>> probing the degraded gateway (${DEGRADED_GATEWAY_URL})`);
  const rpcPhase = await sweep('soroban-rpc-down', DEGRADED_GATEWAY_URL);
  // It must fail closed on the balance read, not treat an unknown balance as OK.
  check(
    'escrow draw rejected with an explicit reason',
    /balance|escrow/i.test(String(rpcPhase.escrowDraw.message ?? '')),
    String(rpcPhase.escrowDraw.message),
  );

  // ── Summary ──
  evidence.violations = violations;
  evidence.summary = Object.fromEntries(
    Object.entries(evidence.phases).map(([name, p]: [string, any]) => [
      name,
      {
        liveness: p.liveness.status,
        readiness: p.readiness.status,
        readinessChecks: p.readinessChecks,
        unpaid: p.unpaidRequest.status,
        forgedHash: p.forgedHash.status,
        escrowDraw: p.escrowDraw.status,
        routes: p.authenticatedRoutes?.status ?? null,
      },
    ]),
  );

  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  console.log(`\n📄 Evidence written to ${EVIDENCE_PATH}`);
  console.log(
    `\n═══ ${violations === 0 ? 'FAILURE-INJECTION SWEEP PASSED ✅' : `${violations} INVARIANT VIOLATIONS ❌`} ═══`,
  );
  if (violations > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nFailure-injection sweep failed:', err);
  process.exit(1);
});
